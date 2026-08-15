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

const { spawn } = require('child_process')
const { Remuxer, codec, AUDIO_FALLBACK, FMP4_FLAGS } = require('./remux')

const DEVICE_DEFAULT = '/dev/dri/renderD128'

// Codecs the engine DECODES in hardware. Anything else is decoded in software and
// uploaded to the engine for encoding - and that is fine, deliberately: the AVI
// shelf's MPEG-4 Part 2 is SD content whose software DECODE is cheap. The measured
// hazard is the encode, and the encode is on the engine either way.
const HW_DECODE = new Set(['h264', 'hevc', 'vp9', 'av1'])

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
function transcodeArgs ({ input, at = 0, audio = 'copy', headers = null, media = {}, device = DEVICE_DEFAULT }) {
  const v = codec(media?.videoCodec)
  const hw = HW_DECODE.has(v)

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']

  if (headers) args.push('-headers', Object.entries(headers).map(([k, val]) => `${k}: ${val}\r\n`).join(''))

  // Hardware decode keeps the frames on the engine end to end; software decode
  // (MPEG-4 Part 2) produces CPU frames that `hwupload` hands to the engine. Both
  // are input options and must sit before `-i`.
  if (hw) args.push('-hwaccel', 'vaapi', '-hwaccel_device', device, '-hwaccel_output_format', 'vaapi')
  else args.push('-vaapi_device', device)

  // Input seek, same as remux: jump in the file rather than decoding to the seek
  // point. An encoder's output starts clean at the seek regardless, because it
  // encodes from the frames it is handed.
  if (at > 0) args.push('-ss', String(at))

  args.push('-i', input)
  args.push('-map', '0:v:0', '-map', '0:a:0?')
  args.push('-map_chapters', '-1')

  // `format=nv12` is the 10-bit answer: the library's HEVC is Main 10 and H.264
  // encode is 8-bit, so the engine converts as part of the scale. The software-decode
  // path converts on the CPU and uploads, which for SD content is a rounding error.
  args.push('-vf', hw ? 'scale_vaapi=format=nv12' : 'format=nv12,hwupload')
  args.push('-c:v', 'h264_vaapi', '-b:v', bitrateFor(media?.width))

  if (audio === 'copy') args.push('-c:a', 'copy')
  else args.push('-c:a', AUDIO_FALLBACK.codec, '-b:a', AUDIO_FALLBACK.bitrate, '-ac', '2')

  args.push('-sn', '-dn')
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
function probeTranscode ({ ffmpeg = 'ffmpeg', device = DEVICE_DEFAULT, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-vaapi_device', device,
      '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=30',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-b:v', '1M',
      '-an', '-movflags', FMP4_FLAGS, '-f', 'mp4', 'pipe:1'
    ]

    let proc
    try {
      proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ available: false, device, reason: `ffmpeg would not start: ${e.message}` })
    }

    let bytes = 0
    let stderr = ''
    let settled = false
    const settle = (out) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(out)
    }

    // A probe that hangs is a fail, not a wait. A broken driver stack can stall
    // rather than error, and the host must come up either way.
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      settle({ available: false, device, reason: 'the hardware probe timed out' })
    }, timeoutMs)
    // The probe must never hold the process open. A host shutting down half a
    // second after boot should not wait fifteen seconds for a timer nobody needs.
    if (timer.unref) timer.unref()

    proc.stdout.on('data', (c) => { bytes += c.length })
    proc.stderr.on('data', (c) => { if (stderr.length < 4096) stderr += c.toString() })
    proc.on('error', (e) => settle({ available: false, device, reason: `ffmpeg would not start: ${e.message}` }))
    proc.on('close', (code) => {
      if (code === 0 && bytes > 0) return settle({ available: true, device, reason: null })
      settle({
        available: false,
        device,
        reason: (stderr.trim().split('\n').pop() || `probe exited ${code} with ${bytes} bytes`).slice(0, 300)
      })
    })
  })
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
  constructor ({ device = DEVICE_DEFAULT, maxConcurrent = 4, ...opts } = {}) {
    super({ maxConcurrent, ...opts })
    this.device = device
    this.what = 'converting'
  }

  _args (opts) {
    return transcodeArgs({ ...opts, device: this.device })
  }
}

module.exports = {
  capBitrate,
  Transcoder, transcodeArgs, probeTranscode, bitrateFor,
  HW_DECODE, DEVICE_DEFAULT
}
