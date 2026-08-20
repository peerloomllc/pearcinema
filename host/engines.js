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

// NVENC, AND DELIBERATELY THE COMPATIBLE HALF OF IT. `-hwaccel cuda` without
// `-hwaccel_output_format cuda` decodes on the card and hands the frames back to system
// memory, so every filter after it is an ordinary CPU filter and the encode is still on
// the card. The all-on-the-GPU version (`scale_cuda`, `overlay_cuda`) is faster and is
// NOT written here on purpose: Fedora's ffmpeg 8.1 has neither filter while the deployed
// image has both, so it is a path that would exist on some installs and not others, and
// it cannot be proven end to end on any hardware in this house - the NVIDIA card is on a
// desktop and the image runs on a box with an Intel one. That is the AV1 mistake exactly
// (DECISIONS 2026-08-16: an engine feature read off a spec sheet, dead in the deployed
// driver, presenting as a player stall). It waits for a machine that can prove it.
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

// VAAPI FIRST, and the reason is not that it is better. It is what every existing
// install already proved and runs on, so an Intel or AMD box that upgrades to this code
// builds byte-identical argv to the one it built yesterday. NVENC is reached by a
// machine where VAAPI genuinely failed, which is the machine this was written for.
//
// A box with BOTH - a desktop with Intel built-in graphics and an NVIDIA card in it -
// therefore converts on the built-in one. That is a defensible default and not a
// measured answer; the honest version is to measure each and keep the faster, which is
// the same button #138 already built and is filed in TODO with the two-card picker.
const ENGINES = [VAAPI, NVENC]

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

module.exports = { ENGINES, VAAPI, NVENC, engineFor, tryEngine, pickEngine }
