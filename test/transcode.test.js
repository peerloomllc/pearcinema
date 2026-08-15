// Hardware transcode: the third rung, and the rules for when it may start.
//
// Three groups, mirroring remux.test.js. `decide` with the transcode gate is where
// the money is - it is what keeps the ladder order and what keeps a host without
// proven hardware refusing exactly as it always did. The argv is pinned as an
// array for the same filename-with-quotes reason. And the PROBE is tested against
// fake ffmpeg binaries rather than this machine's real one, because whether the
// laptop running the tests has a working video engine must not change what the
// tests assert.
//
// What is deliberately NOT here: a real VAAPI encode. That needs the hardware, and
// the verify gate for it is the real Umbrel - see the proposal's Verify section.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const remux = require('../host/remux')
const transcode = require('../host/transcode')

const media = (container, videoCodec, audioCodec, width) => ({ container, videoCodec, audioCodec, width })

// The same clients remux.test.js judges against.
const CHROME = { containers: ['mp4', 'webm'], videoCodecs: ['h264', 'vp9'], audioCodecs: ['aac', 'mp3', 'opus'] }
const ANDROID = { containers: ['mp4', 'matroska', 'avi'], videoCodecs: ['h264', 'hevc', 'mpeg4', 'av1'], audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus'] }

const HW = { transcode: true }

/* ------------------------------------------------------------- the decision -- */

test('PROVEN HARDWARE TURNS THE TWO PICTURE REFUSALS INTO TRANSCODE, and only those', async () => {
  // The 76% case: HEVC television in a browser that cannot decode it.
  const hevc = remux.decide(media('matroska', 'hevc', 'aac'), CHROME, HW)
  assert.equal(hevc.mode, 'transcode')
  assert.equal(hevc.audio, 'copy', 'the sound was never the problem')
  assert.match(hevc.reason, /converted to H\.264/)
  assert.match(hevc.reason, /video hardware/)

  // The AVI shelf in a browser: the client cannot decode MPEG-4 Part 2 at all.
  const avi = remux.decide(media('avi', 'mpeg4', 'mp3'), CHROME, HW)
  assert.equal(avi.mode, 'transcode')
  assert.match(avi.reason, /cannot decode MPEG4/)

  // The OTHER picture refusal: a client that decodes the codec, in a container it
  // cannot open, where MP4 cannot carry the codec either - so remux is impossible
  // even though the client could have decoded it.
  const decodesMpeg4 = { containers: ['mp4'], videoCodecs: ['h264', 'mpeg4'], audioCodecs: ['aac', 'mp3'] }
  const carry = remux.decide(media('avi', 'mpeg4', 'mp3'), decodesMpeg4, HW)
  assert.equal(carry.mode, 'transcode')
  assert.match(carry.reason, /cannot be carried in an MP4/)
})

test('THE LADDER ORDER HOLDS: direct and remux still win everything they won before', async () => {
  // Rule 1 of the proposal. A transcode-capable host must not spend the engine on
  // a file the cheaper answers cover.
  assert.equal(remux.decide(media('mp4', 'h264', 'aac'), CHROME, HW).mode, 'direct')
  assert.equal(remux.decide(media('matroska', 'hevc', 'aac'), ANDROID, HW).mode, 'direct')
  const rewrap = remux.decide(media('matroska', 'h264', 'aac'), CHROME, HW)
  assert.equal(rewrap.mode, 'remux')
  const rebuild = remux.decide(media('matroska', 'h264', 'dts'), CHROME, HW)
  assert.equal(rebuild.mode, 'remux')
  assert.equal(rebuild.audio, 'aac')
})

test('WITHOUT THE FLAG NOTHING CHANGES - the refusals of a host with no hardware', async () => {
  // Rule 3: no probe pass, no transcode, no software fallback. Absent opts and an
  // explicit false are the same claim.
  for (const opts of [undefined, {}, { transcode: false }]) {
    assert.equal(remux.decide(media('matroska', 'hevc', 'aac'), CHROME, opts).mode, 'refuse')
    assert.equal(remux.decide(media('avi', 'mpeg4', 'mp3'), CHROME, opts).mode, 'refuse')
  }
})

test('a client that cannot take H.264 gets the refusal, not a stream it will show as black', async () => {
  const odd = { containers: ['webm'], videoCodecs: ['vp9'], audioCodecs: ['opus'] }
  assert.equal(remux.decide(media('matroska', 'hevc', 'aac'), odd, HW).mode, 'refuse')
})

test('the transcode audio follows the remux rules: copied when the client takes it, rebuilt when not', async () => {
  assert.equal(remux.decide(media('matroska', 'hevc', 'aac'), CHROME, HW).audio, 'copy')
  // AC-3 in a browser that cannot decode it, DTS which an MP4 cannot carry.
  assert.equal(remux.decide(media('matroska', 'hevc', 'ac3'), CHROME, HW).audio, 'aac')
  assert.equal(remux.decide(media('matroska', 'hevc', 'dts'), CHROME, HW).audio, 'aac')
})

/* --------------------------------------------------------------- the argv -- */

test('the ffmpeg command is an ARRAY, and a filename cannot become an argument', async () => {
  const nasty = '/library/TV/MST3K; rm -rf $HOME/"quoted" & K05.avi'
  const args = transcode.transcodeArgs({ input: nasty, media: media('avi', 'mpeg4', 'mp3') })
  assert.equal(args.filter(a => a === nasty).length, 1, 'the path is exactly one element')
})

test('HEVC decodes ON THE ENGINE and the frames never leave it', async () => {
  const args = transcode.transcodeArgs({ input: '/x.mkv', media: media('matroska', 'hevc', 'aac', 1920) })
  // Hardware decode, format conversion on the engine (the 10-bit answer), hardware
  // encode. The measured invocation from the proposal, pinned.
  assert.equal(args.includes('-hwaccel'), true)
  assert.equal(args[args.indexOf('-hwaccel') + 1], 'vaapi')
  assert.equal(args[args.indexOf('-vf') + 1], 'scale_vaapi=format=nv12')
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi')
})

test('MPEG-4 Part 2 decodes in SOFTWARE and uploads - the encode is on the engine either way', async () => {
  const args = transcode.transcodeArgs({ input: '/x.avi', media: media('avi', 'mpeg4', 'mp3', 640) })
  // No -hwaccel: the engine cannot decode this codec, and software decode of SD
  // content is cheap. The hazard rule 3 exists for is the ENCODE, and that is still
  // h264_vaapi.
  assert.equal(args.includes('-hwaccel'), false)
  assert.equal(args.includes('-vaapi_device'), true)
  assert.equal(args[args.indexOf('-vf') + 1], 'format=nv12,hwupload')
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi')
})

test('bitrate follows the WIDTH, which is how a scope-ratio film stays a 1080p one', async () => {
  assert.equal(transcode.bitrateFor(1920), '6M')
  assert.equal(transcode.bitrateFor(1918), '6M', 'the real 2001 is 1918 wide')
  assert.equal(transcode.bitrateFor(1280), '3M')
  assert.equal(transcode.bitrateFor(640), '1500k')
  assert.equal(transcode.bitrateFor(undefined), '1500k', 'unknown width gets the floor, not a guess')
})

test('the transcode argv keeps every lesson the remux argv paid for', async () => {
  const args = transcode.transcodeArgs({ input: '/x.mkv', at: 3600, media: media('matroska', 'hevc', 'ac3', 1920), audio: 'aac' })
  // One video and one audio stream, no chapters, no subtitles, delay_moov, and the
  // seek before the input.
  assert.equal(args[args.indexOf('-map_chapters') + 1], '-1')
  assert.equal(args.includes('-sn'), true)
  assert.match(args[args.indexOf('-movflags') + 1], /delay_moov/)
  assert.equal(args.indexOf('-ss') < args.indexOf('-i'), true)
  assert.equal(args[args.indexOf('-ss') + 1], '3600')
  // The rebuilt soundtrack.
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac')
})

/* --------------------------------------------------------------- the probe -- */

// Fake ffmpeg binaries, so what these tests assert does not depend on whether the
// machine running them has a video engine. The REAL pipeline's verify gate is the
// Umbrel - see the proposal.
async function fakeFfmpeg (script) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-probe-'))
  const bin = path.join(dir, 'ffmpeg')
  await fsp.writeFile(bin, '#!/bin/sh\n' + script)
  await fsp.chmod(bin, 0o755)
  return bin
}

test('a probe that produces bytes and exits 0 unlocks the mode', async () => {
  const bin = await fakeFfmpeg('printf "mp4bytes"; exit 0')
  const out = await transcode.probeTranscode({ ffmpeg: bin })
  assert.equal(out.available, true)
  assert.equal(out.reason, null)
})

test('an exit 0 with NO bytes is a fail - a driver that initialises and produces nothing', async () => {
  const bin = await fakeFfmpeg('exit 0')
  const out = await transcode.probeTranscode({ ffmpeg: bin })
  assert.equal(out.available, false)
})

test('a failing probe carries ffmpeg\'s own last words as the reason', async () => {
  const bin = await fakeFfmpeg('echo "No VA display found for device /dev/dri/renderD128" >&2; exit 1')
  const out = await transcode.probeTranscode({ ffmpeg: bin })
  assert.equal(out.available, false)
  assert.match(out.reason, /No VA display/)
})

test('a probe that HANGS is a fail, not a wait - the host must come up either way', async () => {
  const bin = await fakeFfmpeg('sleep 60')
  const out = await transcode.probeTranscode({ ffmpeg: bin, timeoutMs: 300 })
  assert.equal(out.available, false)
  assert.match(out.reason, /timed out/)
})

test('a missing ffmpeg is a fail with a reason, not a crash', async () => {
  const out = await transcode.probeTranscode({ ffmpeg: '/no/such/binary' })
  assert.equal(out.available, false)
  assert.match(out.reason, /would not start/)
})

/* ---------------------------------------------------------------- the cap -- */

test('THE CAP REFUSES WITH BUSY, and says the host is converting rather than repackaging', async () => {
  // A fake that runs long enough to hold its slot.
  const bin = await fakeFfmpeg('sleep 5')
  const t = new transcode.Transcoder({ ffmpeg: bin, maxConcurrent: 2 })

  t.start({ input: '/a.mkv', media: media('matroska', 'hevc', 'aac') })
  t.start({ input: '/b.mkv', media: media('matroska', 'hevc', 'aac') })
  assert.equal(t.running, 2)

  assert.throws(
    () => t.start({ input: '/c.mkv', media: media('matroska', 'hevc', 'aac') }),
    (e) => e.code === 'BUSY' && /converting 2 films/.test(e.message)
  )

  t.killAll()
  assert.equal(t.running, 0)
})

test('the remux cap still says repackaging - two pools, two verbs, one lifecycle', async () => {
  const bin = await fakeFfmpeg('sleep 5')
  const r = new remux.Remuxer({ ffmpeg: bin, maxConcurrent: 1 })
  r.start({ input: '/a.mkv' })
  assert.throws(() => r.start({ input: '/b.mkv' }), (e) => e.code === 'BUSY' && /repackaging 1 films/.test(e.message))
  r.killAll()
})

test('the transcoder is its own pool: a busy remuxer does not block a transcode', async () => {
  const bin = await fakeFfmpeg('sleep 5')
  const r = new remux.Remuxer({ ffmpeg: bin, maxConcurrent: 1 })
  const t = new transcode.Transcoder({ ffmpeg: bin, maxConcurrent: 1 })
  r.start({ input: '/a.mkv' })
  // The engine still has a slot even though the disk pool is full.
  const s = t.start({ input: '/b.mkv', media: media('matroska', 'hevc', 'aac') })
  assert.ok(s)
  r.killAll(); t.killAll()
})

// --- the export path: one converted film, downloaded for keeps ---------------

test('transcodeArgs caps the ladder at the declared budget', () => {
  const args = transcode.transcodeArgs({ input: '/film.mkv', media: media('matroska', 'hevc', 'dts', 1920), maxKbps: 2500 })
  const i = args.indexOf('-b:v')
  assert.strictEqual(args[i + 1], '2500k')
})

test('transcodeArgs without a budget keeps the width ladder', () => {
  const args = transcode.transcodeArgs({ input: '/film.mkv', media: media('matroska', 'hevc', 'dts', 1920) })
  const i = args.indexOf('-b:v')
  assert.strictEqual(args[i + 1], '6M')
})

test('exportFor: direct verdict answers direct, transcode verdict streams and the guard kills a crashed encode', async () => {
  const { PearCinemaHost } = require('../host/server')
  const bin = await fakeFfmpeg('echo -n MP4BYTES; exit 1')
  const transcoder = new transcode.Transcoder({ ffmpeg: bin, maxConcurrent: 2 })
  const fake = {
    adapter: {
      get: async ({ id }) => ({
        id,
        runtime: 3600,
        media: id === 'fits'
          ? { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1280, size: 900 * 1024 * 1024 }
          : { container: 'matroska', videoCodec: 'hevc', audioCodec: 'dts', width: 1920, size: 8 * 1024 * 1024 * 1024 }
      }),
      ffmpegInput: async ({ itemId }) => ({ input: '/library/' + itemId + '.mkv' })
    },
    transcode: { available: true },
    transcoder,
    log: () => {},
    _fileKbps: PearCinemaHost.prototype._fileKbps
  }
  const exportFor = PearCinemaHost.prototype.exportFor.bind(fake)

  // A file already inside the budget is not converted - the host says so.
  const direct = await exportFor({ itemId: 'fits', capabilities: { containers: ['mp4', 'matroska'], videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'], video: 'hardware', maxKbps: 2500 } })
  assert.strictEqual(direct.direct, true)

  // A fat HEVC film converts - and the fake ffmpeg exits 1 after its bytes, so
  // the guard must turn the clean-looking stdout end into a stream ERROR. This
  // is what keeps half a film from being stored as a finished download.
  const out = await exportFor({ itemId: 'fat', capabilities: { containers: ['mp4', 'matroska'], videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'], video: 'hardware', maxKbps: 2500 } })
  assert.ok(out.stream)
  const err = await new Promise((resolve) => {
    out.stream.on('data', () => {})
    out.stream.on('error', (e) => resolve(e))
    out.stream.on('end', () => resolve(null))
  })
  assert.ok(err, 'a non-zero ffmpeg exit must error the export stream, not end it')
  assert.match(err.message, /died before the end/)
  transcoder.killAll()
})
