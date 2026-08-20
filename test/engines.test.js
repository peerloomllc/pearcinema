// WHOSE GRAPHICS CARD IS DOING THE CONVERTING.
//
// Everything about converting was written against an Intel N100, and therefore against
// VAAPI. That is Intel and AMD, which between them are most media servers, and it is
// not NVIDIA at all: measured on Tim's own desktop 2026-08-20, an RTX 4070 Ti answers
// `-vaapi_device /dev/dri/renderD128` with "Failed to initialise VAAPI connection", so
// the startup probe failed, converting was switched off, and PearCinema served
// direct-play only on a card that encodes H.264 in its sleep.

const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')

const engines = require('../host/engines')
const transcode = require('../host/transcode')
const hls = require('../host/hls')

async function fakeFfmpeg (script) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-engine-'))
  const bin = path.join(dir, 'ffmpeg')
  await fsp.writeFile(bin, '#!/bin/sh\n' + script)
  await fsp.chmod(bin, 0o755)
  return bin
}

const at = (args, flag) => args[args.indexOf(flag) + 1]

/* ------------------------------------------------------------ the argv -- */

test('AN NVIDIA MACHINE GETS NVIDIA ARGV, and an Intel or AMD one is untouched', () => {
  const media = { videoCodec: 'hevc', width: 1920 }

  // The VAAPI argv is the one every install already runs, byte for byte. This is the
  // regression that matters most: adding a vendor must not move the proven one.
  const vaapi = transcode.transcodeArgs({ input: '/x.mkv', media })
  assert.equal(at(vaapi, '-hwaccel'), 'vaapi')
  assert.equal(at(vaapi, '-hwaccel_output_format'), 'vaapi')
  assert.equal(at(vaapi, '-vf'), 'scale_vaapi=format=nv12')
  assert.equal(at(vaapi, '-c:v'), 'h264_vaapi')

  const nvenc = transcode.transcodeArgs({ input: '/x.mkv', media, engine: 'nvenc' })
  assert.equal(at(nvenc, '-hwaccel'), 'cuda')
  assert.equal(at(nvenc, '-c:v'), 'h264_nvenc')
  // NO `-hwaccel_output_format cuda`, deliberately: the frames come back to system
  // memory so every filter after the decoder is an ordinary one, which is the half of
  // NVENC that works on both ffmpeg builds in this house. See engines.js.
  assert.equal(nvenc.includes('-hwaccel_output_format'), false)
  assert.equal(at(nvenc, '-vf'), 'format=nv12')
  assert.equal(nvenc.includes('hwupload'), false, 'nothing is uploaded: it never left')
  assert.equal(nvenc.includes('-vaapi_device'), false)

  // And everything that is NOT about the vendor is the same conversion either way.
  for (const flag of ['-map_chapters', '-b:v', '-movflags', '-f']) {
    assert.equal(at(vaapi, flag), at(nvenc, flag), `${flag} is not a vendor question`)
  }
})

test('a film the card cannot decode is still ENCODED on the card, on either vendor', () => {
  // MPEG-4 Part 2 off the AVI shelf: software decode, hardware encode. On VAAPI that
  // means uploading the frames; on NVENC they are already where they need to be.
  const media = { videoCodec: 'mpeg4', width: 640 }
  const vaapi = transcode.transcodeArgs({ input: '/x.avi', media })
  assert.equal(at(vaapi, '-vf'), 'format=nv12,hwupload')
  assert.equal(at(vaapi, '-vaapi_device'), '/dev/dri/renderD128')

  const nvenc = transcode.transcodeArgs({ input: '/x.avi', media, engine: 'nvenc' })
  assert.equal(at(nvenc, '-vf'), 'format=nv12')
  assert.equal(nvenc.includes('-hwaccel'), false, 'nothing to accelerate on the way in')
  assert.equal(at(nvenc, '-c:v'), 'h264_nvenc')
})

test('the segment path follows the same vendor, including burn-in and tone', () => {
  const base = { input: '/x.mkv', seq: 0, media: { videoCodec: 'hevc', width: 1920 }, device: '/dev/dri/renderD128', hwDecode: true, bitrate: '6M' }

  const nvenc = hls.segmentArgs({ ...base, engine: 'nvenc' })
  assert.equal(at(nvenc, '-c:v'), 'h264_nvenc')
  assert.equal(at(nvenc, '-vf'), 'format=nv12')

  // A tone takes the software-decode lane on every vendor - it is a CPU filter - so the
  // only vendor question left is what the encoder is handed at the end of it.
  const toned = hls.segmentArgs({ ...base, engine: 'nvenc', tone: 'bw' })
  assert.equal(at(toned, '-vf'), 'hue=s=0,format=nv12')
  assert.equal(toned.includes('-hwaccel'), false)

  const burned = hls.segmentArgs({ ...base, engine: 'nvenc', burn: { index: 2 } })
  assert.match(at(burned, '-filter_complex'), /\[0:s:2\]overlay\[ov\];\[ov\]format=nv12\[out\]$/)
  assert.equal(at(burned, '-c:v'), 'h264_nvenc')

  // And VAAPI's graphs are exactly what they were.
  assert.match(at(hls.segmentArgs({ ...base, burn: { index: 2 } }), '-filter_complex'), /format=nv12,hwupload\[out\]$/)
})

test('a card is named by number on NVENC and by path on VAAPI', () => {
  // A render node IS the card and lives at a path; NVENC counts its own and takes an
  // index. The same field carries both, so it must not be handed to the wrong one.
  const nv = transcode.transcodeArgs({ input: '/x.mkv', media: { videoCodec: 'h264' }, engine: 'nvenc', device: '1' })
  assert.equal(at(nv, '-hwaccel_device'), '1')
  assert.equal(at(nv, '-gpu'), '1')

  // The default path is not a card number, so it is not passed as one.
  const nvDefault = transcode.transcodeArgs({ input: '/x.mkv', media: { videoCodec: 'h264' }, engine: 'nvenc' })
  assert.equal(nvDefault.includes('-gpu'), false)
  assert.equal(nvDefault.includes('-hwaccel_device'), false)
})

/* ----------------------------------------------------------- the choice -- */

test('THE ENGINE IS CHOSEN BY RUNNING IT, and NVIDIA is reached when VAAPI genuinely fails', async () => {
  // The exact failure off Tim's desktop: the card is there, the driver interface is
  // not, and every install before this read that as "no video engine".
  const bin = await fakeFfmpeg(`
    case "$*" in
      *h264_vaapi*) echo "Failed to initialise VAAPI connection: -1 (unknown libva error)." >&2; exit 1 ;;
      *h264_nvenc*) printf "mp4bytes"; exit 0 ;;
    esac
    exit 1
  `)
  const out = await transcode.chooseEngine({ ffmpeg: bin })
  assert.equal(out.available, true)
  assert.equal(out.engine, 'nvenc')
  assert.equal(out.label, 'NVIDIA graphics')
  // What was tried and what each said, because an operator whose card was skipped
  // deserves to see why rather than a shrug.
  assert.match(out.tried.find((t) => t.engine === 'vaapi').reason, /libva/)
})

test('an Intel or AMD box never reaches the second candidate', async () => {
  const bin = await fakeFfmpeg('printf "mp4bytes"; exit 0')
  const out = await transcode.chooseEngine({ ffmpeg: bin })
  assert.equal(out.engine, 'vaapi')
  assert.equal(out.label, 'Intel or AMD graphics')
  assert.equal(out.tried.length, 1, 'the proven path is tried first and stops there')
})

test('a machine with no working card is told what the FIRST candidate said', async () => {
  // Not the last thing tried, which on a machine with no NVIDIA card at all is an
  // unhelpful complaint about a vendor the operator does not own.
  const bin = await fakeFfmpeg('echo "No VA display found for device /dev/dri/renderD128" >&2; exit 1')
  const out = await engines.pickEngine({
    ffmpeg: bin,
    candidates: [
      { engine: engines.VAAPI, device: '/dev/dri/renderD128' },
      { engine: engines.NVENC, device: null }
    ]
  })
  assert.equal(out.available, false)
  assert.equal(out.engine, null)
  assert.match(out.reason, /No VA display/)
  assert.equal(out.tried.length, 2, 'both were asked before giving up')
})

test('PEARCINEMA_ENGINE pins one vendor, and a nonsense one is a reason rather than a crash', async () => {
  const bin = await fakeFfmpeg('printf "mp4bytes"; exit 0')
  const pinned = await transcode.chooseEngine({ ffmpeg: bin, only: 'nvenc' })
  assert.equal(pinned.engine, 'nvenc')
  assert.equal(pinned.tried.every((t) => t.engine === 'nvenc'), true, 'VAAPI is not even asked')

  const nonsense = await transcode.chooseEngine({ ffmpeg: bin, only: 'quicksilver' })
  assert.equal(nonsense.available, false)
  assert.match(nonsense.reason, /no video engine called/)
})

test('a probe that hangs on one vendor does not cost the machine the other', async () => {
  const bin = await fakeFfmpeg(`
    case "$*" in
      *h264_vaapi*) sleep 60 ;;
      *h264_nvenc*) printf "mp4bytes"; exit 0 ;;
    esac
  `)
  const out = await transcode.chooseEngine({ ffmpeg: bin, timeoutMs: 300 })
  assert.equal(out.available, true)
  assert.equal(out.engine, 'nvenc')
})
