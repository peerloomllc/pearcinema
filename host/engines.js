// WHICH VIDEO ENGINE THIS MACHINE HAS, and the four places a vendor differs.
//
// Everything about converting was written against the one box it was measured on: an
// Intel N100, and therefore VAAPI - `h264_vaapi`, `/dev/dri/renderD128`, `scale_vaapi`.
// That is Intel AND AMD, which between them are most media servers, and it is not
// NVIDIA at all. Measured on Tim's own desktop 2026-08-20, an RTX 4070 Ti:
//
//   ffmpeg -vaapi_device /dev/dri/renderD128 ...
//   [VAAPI] Failed to initialise VAAPI connection: -1 (unknown libva error).
//
// So on any NVIDIA machine the startup probe failed, converting was switched off, and
// PearCinema served direct-play only - on a card that encodes H.264 in its sleep. The
// same ffmpeg offers `h264_nvenc`, `hevc_nvenc` and `cuda` decode, and the deployed
// image already carries them; nothing but this file's knowledge was missing.
//
// WHAT AN ENGINE HAS TO ANSWER is only four things. Everything else about a conversion
// - the seek, the bitrate ladder, one video and one audio stream, no chapters, the
// fragmented-MP4 pipe - is identical and stays where it is:
//
//   1. `inputArgs`  - what goes BEFORE `-i`, which is where a decoder is chosen.
//   2. `fromHwDecode` - the filter that takes hardware-decoded frames to what the
//      encoder wants.
//   3. `toEngine`   - the filter that takes SOFTWARE frames there instead, which is the
//      burn-in and tone lane and the software-decode lane.
//   4. `encoder`    - the encoder's name, and any per-card flag it takes.
//
// AND THE PROBE DECIDES, never a device name or a driver version. The presence of a
// card proves nothing (that lesson is already written into probeTranscode: a device node
// with no driver behind it initialises and then fails), so an engine is chosen by
// running the real encoder and demanding bytes back.

const { spawn } = require('child_process')
const { FMP4_FLAGS } = require('./remux')

// The nv12 conversion is on every path for the same reason: this library's HEVC is
// Main 10 and H.264 encode is 8 bit, so something has to convert. On VAAPI it happens
// on the engine as part of the scale stage; on NVENC the decoded frames are already
// back in system memory, so it is a CPU format conversion and the encode is still on
// the card.
const VAAPI = {
  id: 'vaapi',
  // What to CALL it to somebody who is not going to type `lspci`. One engine, two
  // vendors: the same driver interface serves Intel's built-in graphics and AMD's.
  label: 'Intel or AMD graphics',
  encoder: 'h264_vaapi',
  encoderArgs: () => [],
  // A render node under /dev/dri IS the card. Not a storage question - it holds
  // nothing, and the conversion writes to a pipe (Tim asked, 2026-08-19).
  deviceKind: 'render node',
  inputArgs: ({ device, software }) => (software
    ? ['-vaapi_device', device]
    : ['-hwaccel', 'vaapi', '-hwaccel_device', device, '-hwaccel_output_format', 'vaapi']),
  fromHwDecode: 'scale_vaapi=format=nv12',
  toEngine: 'format=nv12,hwupload',
  probeArgs: (device) => [
    '-vaapi_device', device,
    '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=30',
    '-vf', 'format=nv12,hwupload',
    '-c:v', 'h264_vaapi', '-b:v', '1M'
  ]
}

// NVENC, THE COMPATIBLE HALF OF IT. `-hwaccel cuda` without `-hwaccel_output_format
// cuda` decodes on the card and hands the frames back to system memory, so every filter
// after it is an ordinary CPU filter and the encode is still on the card. This is the
// fallback now rather than the only NVIDIA lane - see NVENC_CUDA below, which keeps the
// frames on the card and is tried first.
const NVENC = {
  id: 'nvenc',
  label: 'NVIDIA graphics',
  encoder: 'h264_nvenc',
  // Which card, when there are several. NVENC counts its own cards rather than
  // publishing render nodes, so a device here is an index and not a path.
  deviceKind: 'card number',
  encoderArgs: (device) => (/^\d+$/.test(String(device || '')) ? ['-gpu', String(device)] : []),
  inputArgs: ({ device, software }) => {
    if (software) return []
    const args = ['-hwaccel', 'cuda']
    if (/^\d+$/.test(String(device || ''))) args.push('-hwaccel_device', String(device))
    return args
  },
  // Hardware-decoded frames come back in system memory, so both lanes are the same
  // conversion. Kept as two fields rather than one because the OTHER engine's are not.
  fromHwDecode: 'format=nv12',
  toEngine: 'format=nv12',
  probeArgs: () => [
    '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=30',
    '-vf', 'format=nv12',
    '-c:v', 'h264_nvenc', '-b:v', '1M'
  ]
}

// NVENC WITH THE FRAMES NEVER LEAVING THE CARD, and the reason to prefer it is not the
// clock. `-hwaccel_output_format cuda` keeps decoded frames in card memory and
// `scale_cuda` does the 10-bit-to-8-bit conversion there, so the CPU touches no pixels
// at all; the lane above copies every frame down to system memory, converts it with a
// CPU filter and lets the encoder copy it back up.
//
// MEASURED ON THE RTX 4070 Ti (driver 610.57.04, the vendored ffmpeg the desktop app
// ships), 60 seconds of output per run, against the lane above:
//
//                        wall            CPU seconds burnt
//   1080p HEVC Main 10   3.21s -> 3.10s  8.13 -> 0.74   (11x less)
//   4K HEVC Main 10     18.15s -> 11.02s 55.96 -> 1.25  (45x less)
//
// So at 1080p the clock barely moves and the CPU cost collapses, which is the number
// that decides how many streams a host can serve at once - the conversion no longer
// competes with the scan, the HTTP path or the other conversions. At 4K the clock moves
// too, and moves more consistently: three runs of the lane above took 13.09s, 14.43s and
// 17.06s while this one took 11.04s, 11.06s and 11.06s.
//
// THE PROBE IS WHY THIS IS SAFE TO PREFER, and it is the rule this file already sets for
// itself. `scale_cuda` is a build option, not a card feature: the vendored build carries
// it and Fedora's own ffmpeg 8.1 does not. The probe below uploads a frame and runs
// `scale_cuda` on it, so on a build without the filter it exits non-zero with no bytes
// ("No such filter: 'scale_cuda'", checked 2026-08-24) and `pickEngine` falls through to
// the compatible lane. Nothing is read off a spec sheet.
//
// THE FIRST RUN COSTS FIVE SECONDS. `scale_cuda`'s kernel is compiled by the driver on
// first use and cached (~/.nv, or CUDA_CACHE_PATH): 5.38s cold, 0.46s warm, measured by
// pointing the cache at an empty directory. The probe runs at startup and pays it there,
// so the first viewer to press play gets a warm cache. In a container the cache is inside
// the container filesystem, so a recreated container pays it again - at startup, where it
// is a slow probe rather than a stalled film.
//
// A CODEC THE CARD CANNOT DECODE STILL WORKS. `-hwaccel_output_format cuda` looks like it
// would hard-fail where the compatible lane silently decodes in software, so it was
// tested rather than assumed: MPEG-4 Part 2 through this lane produced byte-identical
// output to the lane above (ffmpeg falls back to software decode and inserts the upload
// itself), and HEVC 4:4:4 decoded on the card on this generation.
const NVENC_CUDA = {
  id: 'nvenc-cuda',
  label: 'NVIDIA graphics',
  encoder: 'h264_nvenc',
  deviceKind: 'card number',
  encoderArgs: (device) => (/^\d+$/.test(String(device || '')) ? ['-gpu', String(device)] : []),
  inputArgs: ({ device, software }) => {
    // SOFTWARE FRAMES TAKE THE OTHER LANE'S ANSWER, deliberately. Burning in a subtitle
    // and tone mapping are CPU filters, so the frames are already in system memory and
    // there is nothing to save by uploading them by hand - the encoder uploads them
    // itself, which is exactly what the lane above does.
    if (software) return []
    const args = ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']
    if (/^\d+$/.test(String(device || ''))) args.push('-hwaccel_device', String(device))
    return args
  },
  fromHwDecode: 'scale_cuda=format=nv12',
  toEngine: 'format=nv12',
  // The upload is HERE and nowhere else: it exists to put a software test frame on the
  // card so `scale_cuda` can be asked to prove it exists.
  probeArgs: () => [
    '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=30',
    '-vf', 'format=nv12,hwupload_cuda,scale_cuda=format=nv12',
    '-c:v', 'h264_nvenc', '-b:v', '1M'
  ]
}

// VIDEOTOOLBOX, which is macOS, and which was missing for the same reason NVIDIA was:
// this file knew one vendor's engine and the Mac has never had a render node in its life.
// The cost was not "no hardware conversion on a Mac" - it was worse. `chooseEngine` put
// `/dev/dri/renderD128` at the head of the list on EVERY platform, so the mac-mini ran
// `ffmpeg -vaapi_device /dev/dri/renderD128` against a build with no such option and put
// its answer on the dashboard: "Error splitting the argument list: Option not found"
// (Tim, 2026-08-21). A Mac that encodes H.264 in hardware reported a parse error.
//
// MEASURED ON THE MAC MINI (M-series, the bundled darwin-arm64 ffmpeg) before being
// written here, which is the rule this file already sets for itself:
//   - the probe encodes and returns 73,042 bytes of MP4, exit 0.
//   - a real film (Arrival.mkv, HEVC) with `-hwaccel videotoolbox` converts 3 seconds in
//     0.72s wall, about 4x realtime, at 1920x1080 with its audio.
//
// `-hwaccel videotoolbox` WITHOUT an output format hands the decoded frames back in
// system memory, exactly like the NVENC lane above, so both filter lanes are the same
// CPU format conversion and the encode is still on the chip.
const VIDEOTOOLBOX = {
  id: 'videotoolbox',
  label: 'Apple graphics',
  encoder: 'h264_videotoolbox',
  encoderArgs: () => [],
  // Nothing to point it at: the encoder finds the machine's own media engine, and a Mac
  // has exactly one.
  deviceKind: null,
  inputArgs: ({ software }) => (software ? [] : ['-hwaccel', 'videotoolbox']),
  fromHwDecode: 'format=nv12',
  toEngine: 'format=nv12',
  probeArgs: () => [
    '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=30',
    '-vf', 'format=nv12',
    '-c:v', 'h264_videotoolbox', '-b:v', '1M'
  ]
}

// WINDOWS, AND THE HONEST LABEL ON BOTH OF THESE: NEITHER HAS EVER RUN ON HARDWARE.
//
// Every other engine in this file was measured before it was written, which is the rule
// engines.js set itself after the AV1 mistake. These two are the exception, taken on Tim's
// call (2026-08-21) after the measurement was attempted and could not be made:
//
//   - the Windows VM has a virtio display and no graphics chip at all, so nothing
//     hardware can be proven on it. Its bundled ffmpeg DOES carry the encoders -
//     h264_qsv, h264_amf and h264_nvenc are all compiled in, checked on the box.
//   - the Umbrel is an Intel N100 and its ffmpeg has h264_qsv, but the container has no
//     Intel runtime behind it: "Error initializing an internal MFX session: unsupported".
//
// WHY SHIPPING THEM UNPROVEN IS STILL SAFE, and why this is not the AV1 mistake repeating.
// AV1 was a DECODER claimed in the capability set, so a film that matched it was accepted
// and then stalled mid-play - a promise made to a viewer. An engine here is chosen only by
// tryEngine, which runs the real pipeline and demands MP4 bytes back. A wrong argument
// shape fails the probe on the machine that has the hardware, which is exactly where that
// machine already stands today: no engine, direct play only. It cannot be made worse, and
// on a machine where the shape is right it starts working.
//
// So: when one of these first runs on a real Windows PC, it is a MEASUREMENT, not a
// confirmation. Write down what it did.
const QSV = {
  id: 'qsv',
  label: 'Intel Quick Sync',
  encoder: 'h264_qsv',
  encoderArgs: () => [],
  // Windows binds Quick Sync through D3D11 by itself. There is no path to hand it, unlike
  // VAAPI's render node - which is the whole reason this is a separate engine from VAAPI
  // rather than the same one with a different device.
  deviceKind: null,
  inputArgs: ({ software }) => (software ? [] : ['-hwaccel', 'qsv']),
  // No `-hwaccel_output_format`, so decoded frames come back in system memory and the
  // encoder uploads them itself. Same shape as the NVENC lane, same reason.
  fromHwDecode: 'format=nv12',
  toEngine: 'format=nv12',
  probeArgs: () => [
    '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=30',
    '-vf', 'format=nv12',
    '-c:v', 'h264_qsv', '-b:v', '1M'
  ]
}

const AMF = {
  id: 'amf',
  label: 'AMD graphics',
  encoder: 'h264_amf',
  encoderArgs: () => [],
  deviceKind: null,
  // d3d11va is the decode side on Windows for AMD; without an output format the frames
  // land in system memory for the encoder, as above.
  inputArgs: ({ software }) => (software ? [] : ['-hwaccel', 'd3d11va']),
  fromHwDecode: 'format=nv12',
  toEngine: 'format=nv12',
  probeArgs: () => [
    '-f', 'lavfi', '-i', 'testsrc2=duration=0.5:size=640x360:rate=30',
    '-vf', 'format=nv12',
    '-c:v', 'h264_amf', '-b:v', '1M'
  ]
}

// VAAPI FIRST, and the reason is not that it is better. It is what every existing
// install already proved and runs on, so an Intel or AMD box that upgrades to this code
// builds byte-identical argv to the one it built yesterday. NVENC is reached by a
// machine where VAAPI genuinely failed, which is the machine this was written for.
//
// A box with BOTH - a desktop with Intel built-in graphics and an NVIDIA card in it -
// therefore converts on the built-in one. That is a defensible default and not a
// measured answer; the honest version is to measure each and keep the faster, which is
// the same button #138 already built and is filed in TODO with the two-card picker.
const ENGINES = [VAAPI, NVENC_CUDA, NVENC, VIDEOTOOLBOX, QSV, AMF]

const engineFor = (id) => ENGINES.find((e) => e.id === String(id || '').toLowerCase()) || null

// Run one engine's real pipeline and demand MP4 bytes back. No library file is read:
// the input is ffmpeg's own test source, so nothing of anybody's is touched before a
// single grant exists.
function tryEngine ({ ffmpeg = 'ffmpeg', engine, device = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...engine.probeArgs(device),
      ...engine.encoderArgs(device),
      '-an', '-movflags', FMP4_FLAGS, '-f', 'mp4', 'pipe:1'
    ]

    let proc
    try {
      proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ available: false, reason: `ffmpeg would not start: ${e.message}` })
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

    // A probe that hangs is a fail, not a wait. A broken driver stack can stall rather
    // than error, and the host must come up either way.
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      settle({ available: false, reason: 'the hardware probe timed out' })
    }, timeoutMs)
    if (timer.unref) timer.unref()

    proc.stdout.on('data', (c) => { bytes += c.length })
    proc.stderr.on('data', (c) => { if (stderr.length < 4096) stderr += c.toString() })
    proc.on('error', (e) => settle({ available: false, reason: `ffmpeg would not start: ${e.message}` }))
    proc.on('close', (code) => {
      if (code === 0 && bytes > 0) return settle({ available: true, reason: null })
      settle({
        available: false,
        reason: (stderr.trim().split('\n').pop() || `probe exited ${code} with ${bytes} bytes`).slice(0, 300)
      })
    })
  })
}

// EVERY CANDIDATE, IN ORDER, UNTIL ONE ACTUALLY WORKS - and what each one said when it
// did not, because "no video engine" on a machine with a perfectly good card is a
// question the operator deserves an answer to rather than a shrug.
//
// `only` pins one engine (PEARCINEMA_ENGINE), which is both the way to override the
// VAAPI-first default on a two-vendor box and the rollback if a vendor path misbehaves.
async function pickEngine ({ ffmpeg = 'ffmpeg', candidates = [], only = null, timeoutMs = 15000 } = {}) {
  const wanted = only ? engineFor(only) : null
  if (only && !wanted) {
    return { available: false, engine: null, device: null, reason: `no video engine called "${only}"`, tried: [] }
  }

  const list = candidates.filter((c) => c.engine && (!wanted || c.engine.id === wanted.id))
  const tried = []
  for (const { engine, device } of list) {
    const out = await tryEngine({ ffmpeg, engine, device, timeoutMs })
    tried.push({ engine: engine.id, device, available: out.available, reason: out.reason })
    if (out.available) {
      return { available: true, engine: engine.id, label: engine.label, device, reason: null, tried }
    }
  }

  // Nothing worked, so the reason is the FIRST candidate's - the one the machine was
  // most likely meant to use - rather than the last thing tried.
  const first = tried[0]
  return {
    available: false,
    engine: null,
    device: list[0]?.device || null,
    reason: first ? first.reason : 'no video engine was found to try',
    tried
  }
}

module.exports = { ENGINES, VAAPI, NVENC_CUDA, NVENC, VIDEOTOOLBOX, QSV, AMF, engineFor, tryEngine, pickEngine }
