// TRANSCODE: re-encoding the picture on the host's video engine, and the rules for
// when that is allowed to start.
//
// Approved as a T3 in proposals/2026-08-13-hardware-transcode.md. Read it before
// changing anything here. The two facts that shaped it, both measured on the real
// N100 (DECISIONS 2026-08-13):
//
//   1. THE ENGINE IS NEARLY FREE AND THE CPU IS NOT. Eight concurrent 1080p HEVC
//      streams kept realtime on the video engine at about a third of one CPU core.
//      A SOFTWARE encode of the same file held 1.02x realtime for ONE stream on the
//      whole 4-core chip. That is why rule 3 below is a hard rule with no fallback:
//      a software encode never starts, on any box, under any load.
//   2. THE LIBRARY'S HEVC IS 10-BIT. Every x265 episode sampled is Main 10, so the
//      10-bit-to-8-bit conversion is the common case and it happens on the engine
//      as part of the scale stage, not on the CPU.
//
// The transport is the remux pipe unchanged: fragmented MP4 straight down the
// socket, nothing written to disk, a seek is a restart at a new time. Everything
// remux.js says about delay_moov, chapters and argv-never-a-shell-string applies
// here verbatim, because it is the same pipe with an encoder in it.

const fs = require('fs')
const { spawn } = require('child_process')
const { Remuxer, codec, AUDIO_FALLBACK, FMP4_FLAGS } = require('./remux')
const { VAAPI, engineFor, tryEngine, pickEngine } = require('./engines')

// WHICH VENDOR'S ENGINE, defaulting to the one every install already runs on. The four
// places a vendor differs live in engines.js; everything in this file is the same
// conversion whichever card is doing it.
const ENGINE_DEFAULT = VAAPI

const DEVICE_DEFAULT = '/dev/dri/renderD128'

// WHICH GRAPHICS CARDS THIS MACHINE HAS, as render nodes under /dev/dri. Not a
// storage question: a render node is the card itself, it holds nothing, and the
// conversion path writes to a pipe rather than to disk anywhere (Tim asked whether
// /dev/dri/renderD128 might run out of space, 2026-08-19 - it cannot, and the fact
// that the raw path invites the question is why the dashboard only names one when
// there is more than one to choose between).
//
// Empty on a machine with no /dev/dri at all, which is every Mac and every host
// without a usable card - and there the probe has already failed for its own reasons.
function renderNodes (dir = '/dev/dri') {
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^renderD\d+$/.test(name))
      .sort()
      .map((name) => `${dir}/${name}`)
  } catch {
    return []
  }
}

// Codecs the engine DECODES in hardware. Anything else is decoded in software and
// uploaded to the engine for encoding - and that is fine, deliberately: the AVI
// shelf's MPEG-4 Part 2 is SD content whose software DECODE is cheap. The measured
// hazard is the encode, and the encode is on the engine either way.
//
// AV1 IS DELIBERATELY ABSENT, and it was in this set once (measured 2026-08-16).
// The N100's engine decodes AV1 on paper, but the image's VA driver cannot hand
// the decoded frames onward - every segment ffmpeg died with "Failed to inject
// frame into filter network: Function not implemented", the phone received
// nothing and the player starved with no duration and no error. It presented as
// a PLAYER stall and cost a whole false trail through playlist arithmetic.
// dav1d in software is fast, works everywhere, and the encode stays on the
// engine. Re-adding av1 requires proving the whole segment pipeline on the
// deployed image, not reading a spec sheet.
const HW_DECODE = new Set(['h264', 'hevc', 'vp9'])

// One rendition, the source's own resolution, bitrate by that resolution. Named by
// WIDTH for the same reason items.resolutionLabel is: a scope-ratio film is 1920
// wide and 800 tall, and bucketing by height files most of cinema a tier low.
// The width ladder, held under a client's stated kbps budget. ffmpeg rates
// are strings ('6M', '1500k'); parse, min, re-emit as kbps.
function capBitrate (rate, maxKbps) {
  if (!maxKbps) return rate
  const m = /^(\d+(?:\.\d+)?)([Mk])$/.exec(String(rate))
  const kbps = m ? Number(m[1]) * (m[2] === 'M' ? 1000 : 1) : 3000
  return Math.min(kbps, maxKbps) + 'k'
}

function bitrateFor (width) {
  const w = Number(width) || 0
  if (w >= 1600) return '6M'
  if (w >= 1000) return '3M'
  return '1500k'
}

// The ffmpeg argv for one transcode, starting at `at` seconds. The measured
// invocation from the proposal, plus everything the remux argv already learned the
// hard way (one video and one audio stream, no chapters, no subtitles, delay_moov).
function transcodeArgs ({ input, at = 0, audio = 'copy', headers = null, media = {}, device = DEVICE_DEFAULT, maxKbps = 0, burn = null, duration = 0, engine = null }) {
  const v = codec(media?.videoCodec)
  const hw = HW_DECODE.has(v)
  const eng = (typeof engine === 'string' ? engineFor(engine) : engine) || ENGINE_DEFAULT

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']

  if (headers) args.push('-headers', Object.entries(headers).map(([k, val]) => `${k}: ${val}\r\n`).join(''))

  // Hardware decode keeps the frames on the engine end to end; software decode
  // (MPEG-4 Part 2) produces CPU frames that `hwupload` hands to the engine. Both
  // are input options and must sit before `-i`. BURN-IN always decodes in
  // software - same graph and same reasoning as hls.js segmentArgs, where the
  // measurements and the overlay_vaapi ban live.
  args.push(...eng.inputArgs({ device, software: !!burn || !hw }))

  // Input seek, same as remux: jump in the file rather than decoding to the seek
  // point. An encoder's output starts clean at the seek regardless, because it
  // encodes from the frames it is handed.
  if (at > 0) args.push('-ss', String(at))

  args.push('-i', input)
  if (burn) {
    const vw = Number(media?.width) || 0
    const vh = Number(media?.height) || 0
    const cw = Math.max(Number(burn.canvasWidth) || 1920, vw)
    const ch = Math.max(Number(burn.canvasHeight) || 1080, vh)
    const pad = vw && vh && (cw > vw || ch > vh)
      ? `pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2[p];[p]`
      : ''
    args.push('-filter_complex', `[0:v:0]${pad}[0:s:${Number(burn.index)}]overlay[ov];[ov]${eng.toEngine}[out]`)
    args.push('-map', '[out]', '-map', '0:a:0?')
  } else {
    args.push('-map', '0:v:0', '-map', '0:a:0?')
  }
  args.push('-map_chapters', '-1')

  // `format=nv12` is the 10-bit answer: the library's HEVC is Main 10 and H.264
  // encode is 8-bit, so the engine converts as part of the scale. The software-decode
  // path converts on the CPU and uploads, which for SD content is a rounding error.
  if (!burn) args.push('-vf', hw ? eng.fromHwDecode : eng.toEngine)
  args.push('-c:v', eng.encoder, ...eng.encoderArgs(device), '-b:v', capBitrate(bitrateFor(media?.width), maxKbps))

  if (audio === 'copy') args.push('-c:a', 'copy')
  else args.push('-c:a', AUDIO_FALLBACK.codec, '-b:a', AUDIO_FALLBACK.bitrate, '-ac', '2')

  args.push('-sn', '-dn')
  // A BOUNDED RUN, for the measurement below and nothing else: convert this many
  // seconds of the film and stop. An output option, so it counts encoded time rather
  // than wall time.
  if (duration > 0) args.push('-t', String(duration))
  args.push('-movflags', FMP4_FLAGS, '-f', 'mp4', 'pipe:1')
  return args
}

// DID THE HARDWARE PROVE ITSELF? Run once at startup, and only a pass unlocks the
// mode - rule 2 of the proposal.
//
// The presence of /dev/dri is NOT the test: a device node with no driver behind it
// initialises and then fails, which is exactly what this must catch. So the probe is
// the real pipeline on synthetic input - generate frames, upload, encode, and demand
// actual MP4 bytes back. No library file is read: the input is ffmpeg's own test
// source, so nothing of anybody's is touched before a single grant exists.
function probeTranscode ({ ffmpeg = 'ffmpeg', device = DEVICE_DEFAULT, timeoutMs = 15000, engine = ENGINE_DEFAULT } = {}) {
  const eng = (typeof engine === 'string' ? engineFor(engine) : engine) || ENGINE_DEFAULT
  return tryEngine({ ffmpeg, engine: eng, device, timeoutMs })
    .then((out) => ({ ...out, device, engine: out.available ? eng.id : null }))
}

// AND WHICH ENGINE THIS MACHINE HAS, which is the same question one layer out. Each
// candidate is probed in turn and the first that returns real bytes wins; a machine
// with no working card gets the FIRST candidate's complaint, because "no video engine"
// on a box with a perfectly good card is a question that deserves an answer.
// CANDIDATES BELONG TO A PLATFORM, and until 2026-08-21 they did not. `/dev/dri/renderD128`
// went to the head of this list on every machine, so the mac-mini spent its startup asking
// a Mac ffmpeg for `-vaapi_device` and published the parse error as its answer: "Error
// splitting the argument list: Option not found". A Mac with a hardware H.264 encoder read
// as a broken one, and a Windows box would have read the same way.
//
// So each engine is offered only where it can exist. VAAPI needs a render node and is not
// asked for without one - which also kills the DEVICE_DEFAULT-that-is-not-there case, since
// a configured device only leads the list if it is actually on the machine.
function engineCandidates ({ device = DEVICE_DEFAULT, platform = process.platform, nodes = null } = {}) {
  const found = nodes || renderNodes()
  // The configured render node first, then the rest of them: a two-card box whose first
  // node is a dead stub still has a second card to find.
  const vaapiNodes = [...(found.includes(device) ? [device] : []), ...found.filter((n) => n !== device)]
  const out = vaapiNodes.map((d) => ({ engine: VAAPI, device: d }))

  // The Mac's own engine, and the only one it has.
  if (platform === 'darwin') out.push({ engine: engineFor('videotoolbox'), device: null })

  // NVENC counts its own cards, so there is no path to hand it - the encoder finds the
  // machine's first, and `-gpu` picks another only once somebody has asked for one by
  // number. Not offered on macOS: no Mac in years has had an NVIDIA card, and asking
  // costs a spawn and prints "Encoder not found" where an operator can see it.
  if (platform !== 'darwin') out.push({ engine: engineFor('nvenc'), device: null })

  return out
}

async function chooseEngine ({ ffmpeg = 'ffmpeg', device = DEVICE_DEFAULT, only = null, timeoutMs = 15000, platform = process.platform } = {}) {
  const out = await pickEngine({ ffmpeg, only, timeoutMs, candidates: engineCandidates({ device, platform }) })
  return { ...out, label: out.engine ? engineFor(out.engine).label : null }
}

// --- how much engine is there --------------------------------------------------
//
// "this hardware managed about 10 in testing" was on the dashboard of every install,
// and the 10 was a constant from the N100 this was built against - a number about OUR
// machine presented as a number about theirs (Tim, 2026-08-19). The claim was removed;
// this is the number it was standing in for, measured on the machine it is about.
//
// WHY IT IS A REAL CONVERSION AND NOT A GUESS FROM THE DEVICE NAME. A table of chips
// mapped to concurrency would be the same sin at one remove - a number about hardware
// somebody else measured. This runs the actual pipeline, on a real film out of this
// library, at increasing concurrency, and reports where the box stops keeping up.
//
// REALTIME IS THE BAR. A conversion that runs slower than the film plays cannot be
// watched: the viewer catches up with the encoder and stalls. So a level passes when
// EVERY stream in it converts `seconds` of film in less than `seconds` of wall clock,
// with a tenth of margin - and the answer is the last level that passed.
//
// THE LADDER DOUBLES AND STOPS AT THE FIRST FAILURE, which is what keeps this inside
// the minute of engine time it costs: the passing rounds are fast by definition (a box
// at 8x realtime does fifteen seconds of film in two), and only the failing one is
// slow. That one is bounded by a timeout, because a box that has fallen over does not
// get to hold the operator for as long as it likes.

const MEASURE_SECONDS = 15
const MEASURE_LEVELS = [1, 2, 4, 8, 12, 16]
// A stream must beat realtime by this much to count. Exactly 1.0 is a knife edge, and
// a box measured at its own knife edge stalls the first time anything else runs.
const MEASURE_MARGIN = 1.1

function runOne (ffmpeg, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    let proc
    try {
      proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, ms: 0, reason: e.message })
    }
    let bytes = 0
    let stderr = ''
    let settled = false
    const settle = (out) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...out, ms: Date.now() - started })
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      settle({ ok: false, bytes, reason: 'it did not finish in time' })
    }, timeoutMs)
    if (timer.unref) timer.unref()

    // The bytes are thrown away - what is being measured is how fast they arrive.
    proc.stdout.on('data', (c) => { bytes += c.length })
    proc.stderr.on('data', (c) => { if (stderr.length < 2048) stderr += c.toString() })
    proc.on('error', (e) => settle({ ok: false, bytes, reason: e.message }))
    proc.on('close', (code) => settle({
      ok: code === 0 && bytes > 0,
      bytes,
      reason: code === 0 ? null : (stderr.trim().split('\n').pop() || `it exited ${code}`).slice(0, 200)
    }))
  })
}

// THE HARDEST REAL FILM in a list, which is what the measurement should be about: the
// number is a promise about the operator's own library rather than about a test
// pattern, and a promise is only worth making about its worst case. Hardest is the
// engine's worst case - HEVC first, then the biggest picture.
function hardestFilm (items = []) {
  const usable = items.filter((i) => i?.media?.videoCodec && (Number(i.media.width) || 0) > 0)
  if (!usable.length) return null
  const score = (i) => {
    const v = codec(i.media.videoCodec)
    return (v === 'hevc' ? 1e9 : 0) + (Number(i.media.width) || 0) * 1000 + (Number(i.media.height) || 0)
  }
  return usable.reduce((best, i) => (score(i) > score(best) ? i : best), usable[0])
}

async function measureEngine ({
  ffmpeg = 'ffmpeg',
  device = DEVICE_DEFAULT,
  input,
  headers = null,
  media = {},
  at = 0,
  seconds = MEASURE_SECONDS,
  levels = MEASURE_LEVELS,
  engine = ENGINE_DEFAULT,
  onLevel = () => {}
} = {}) {
  const ladder = []
  let cap = 0

  for (const [i, concurrency] of levels.entries()) {
    // The STEP as well as the level, so a progress bar can be a real proportion of a
    // ladder that is known up front rather than a bar that moves to look busy.
    onLevel({ concurrency, step: i + 1, steps: levels.length })
    const args = transcodeArgs({ input, at, audio: 'aac', headers, media, device, duration: seconds, engine })
    // Every stream in the level gets the SAME work, started together. Not staggered:
    // what is being measured is what happens when a household presses play at once.
    const runs = await Promise.all(
      Array.from({ length: concurrency }, () => runOne(ffmpeg, args, seconds * 2500))
    )

    const worst = Math.max(...runs.map((r) => r.ms))
    const failed = runs.find((r) => !r.ok)
    // The slowest stream is the answer: a level where one of eight stalls is a level
    // where somebody's film stalls.
    const speed = worst > 0 ? (seconds * 1000) / worst : 0
    const ok = !failed && speed >= MEASURE_MARGIN
    ladder.push({
      concurrency,
      speed: Math.round(speed * 100) / 100,
      ok,
      reason: failed ? failed.reason : null
    })
    if (!ok) break
    cap = concurrency
  }

  return { cap, ladder, device, seconds, at: Date.now() }
}

// The engine wrapper. Everything about session ownership - the cap, the BUSY
// refusal, kill-with-the-response, killAll on shutdown - is the Remuxer's and is
// inherited rather than re-implemented, because a second copy of process lifecycle
// is a second place for an orphaned ffmpeg to come from.
//
// The cap is ITS OWN POOL, separate from remux's, because they exhaust different
// resources: remux is disk I/O, this is the engine. Default 4 against a measured
// ceiling of ~10, leaving headroom for whatever else shares /dev/dri.
class Transcoder extends Remuxer {
  constructor ({ device = DEVICE_DEFAULT, maxConcurrent = 4, engine = ENGINE_DEFAULT, ...opts } = {}) {
    super({ maxConcurrent, ...opts })
    this.device = device
    // Set by the startup probe when it finds a vendor, so every argv built afterwards
    // is built for the card that actually answered.
    this.engine = (typeof engine === 'string' ? engineFor(engine) : engine) || ENGINE_DEFAULT
    this.what = 'converting'
  }

  _args (opts) {
    return transcodeArgs({ ...opts, device: this.device, engine: this.engine })
  }
}

module.exports = {
  capBitrate,
  Transcoder, transcodeArgs, probeTranscode, chooseEngine, engineCandidates, engineFor, bitrateFor, measureEngine, hardestFilm,
  HW_DECODE, DEVICE_DEFAULT, ENGINE_DEFAULT, renderNodes, MEASURE_LEVELS, MEASURE_SECONDS
}
