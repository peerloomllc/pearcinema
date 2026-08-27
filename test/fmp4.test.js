// FRAGMENTED MP4 SEGMENTS, which exist because an iPhone played half this library
// with no picture at all.
//
// Measured on the iPhone SE and reproduced on the Simulator, 2026-08-27: HEVC in
// an MPEG-TS segment gives Apple's player sound, a running clock, readyState 4, no
// error, and `videoWidth x videoHeight` of 0 x 0. The same picture bytes in a
// fragmented MP4 draw. 3,336 of the 5,972 items in the real library are Matroska
// holding HEVC, so this was over half of it.
//
// These tests pin the three separate things that each had to be right, because any
// one of them alone still produces a black rectangle:
//
//   1. the container and the `hvc1` tag on the argv,
//   2. the playlist agreeing with the segments about their shape,
//   3. the bytes being reshaped from a whole little MP4 into an HLS segment.

const test = require('node:test')
const assert = require('node:assert/strict')

const fmp4 = require('../host/fmp4')
const hls = require('../host/hls')

// A fragmented MP4, hand-built, so these tests need no ffmpeg and no film. Box
// sizes are real and the fields the code reads are in their real places; the
// sample payloads are filler, because nothing here looks at them.
function box (type, payload) {
  const out = Buffer.alloc(8 + payload.length)
  out.writeUInt32BE(8 + payload.length, 0)
  out.write(type, 4, 'latin1')
  payload.copy(out, 8)
  return out
}

function fullBox (type, version, payload) {
  const body = Buffer.alloc(4 + payload.length)
  body[0] = version
  payload.copy(body, 4)
  return box(type, body)
}

// `tkhd` version 0: creation, modification, then the track id.
function tkhd (id) {
  const p = Buffer.alloc(80)
  p.writeUInt32BE(id, 8)
  return fullBox('tkhd', 0, p)
}

// `mdhd` version 0: creation, modification, then the timescale.
function mdhd (timescale) {
  const p = Buffer.alloc(20)
  p.writeUInt32BE(timescale, 8)
  return fullBox('mdhd', 0, p)
}

function trak (id, timescale) {
  return box('trak', Buffer.concat([tkhd(id), box('mdia', mdhd(timescale))]))
}

function initSegment (tracks) {
  return Buffer.concat([
    box('ftyp', Buffer.from('iso5avc1mp41', 'latin1')),
    box('moov', Buffer.concat(tracks.map(([id, ts]) => trak(id, ts))))
  ])
}

// `tfhd` carries the track id in its first field after the version and flags.
function traf (trackId, baseMediaDecodeTime, version = 1) {
  const hd = Buffer.alloc(4)
  hd.writeUInt32BE(trackId, 0)
  const dt = version === 1 ? Buffer.alloc(8) : Buffer.alloc(4)
  if (version === 1) dt.writeBigUInt64BE(BigInt(baseMediaDecodeTime), 0)
  else dt.writeUInt32BE(baseMediaDecodeTime, 0)
  return box('traf', Buffer.concat([fullBox('tfhd', 0, hd), fullBox('tfdt', version, dt)]))
}

function fragment (trafs, mdatBytes = 64) {
  return Buffer.concat([
    box('moof', Buffer.concat(trafs)),
    box('mdat', Buffer.alloc(mdatBytes, 7))
  ])
}

// Read every `tfdt` back out, in order, whatever version each one is.
function tfdts (buf) {
  const out = []
  let at = 0
  while ((at = buf.indexOf('tfdt', at, 'latin1')) >= 0) {
    const version = buf[at + 4]
    out.push(version === 1 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8))
    at += 4
  }
  return out
}

test('HEVC LEAVES IN A FRAGMENTED MP4 AND CARRIES hvc1, because Apple draws nothing otherwise', () => {
  const plan = { starts: [0, 10], seeks: [0, 10.3], ends: [9.999, 20], runtime: 20, engine: 'copy' }
  const base = { input: '/library/Seinfeld S07E03.mkv', plan, audio: 'copy', audioCodec: 'aac' }

  const hevc = hls.copySegmentArgs({ ...base, seq: 1, videoCodec: 'hevc' })
  const h264 = hls.copySegmentArgs({ ...base, seq: 1, videoCodec: 'h264' })

  // The container, which is the bug: HEVC in MPEG-TS plays as sound over a black
  // rectangle on every Apple device, with no error to catch.
  assert.equal(hls.segmentContainerFor('hevc'), 'fmp4')
  assert.equal(hls.segmentContainerFor('h264'), 'mpegts')
  assert.equal(hevc[hevc.indexOf('-f') + 1], 'mp4')
  assert.equal(h264[h264.indexOf('-f') + 1], 'mpegts')
  assert.equal(hevc[hevc.indexOf('-movflags') + 1], fmp4.SEGMENT_MOVFLAGS)

  // AND THE SAMPLE ENTRY, which is the same failure by a second route: ffmpeg's
  // MP4 muxer writes `hev1` unless told, and AVFoundation will not decode it.
  // Fixing the container without this one is still a black screen.
  assert.deepEqual(hevc.slice(hevc.indexOf('-tag:v'), hevc.indexOf('-tag:v') + 2), ['-tag:v', 'hvc1'])
  assert.equal(h264.includes('-tag:v'), false)

  // Everything the TS path measured stays exactly as it was - the seek aimed
  // inside the group, the absolute `-to`, and the timestamp flags.
  for (const args of [hevc, h264]) {
    assert.equal(args[args.indexOf('-ss') + 1], '10.300000')
    assert.equal(args[args.indexOf('-to') + 1], '20.000000')
    assert.ok(args.includes('-copyts') && args.includes('-noaccurate_seek'))
    assert.equal(args[args.indexOf('-avoid_negative_ts') + 1], 'disabled')
    assert.equal(args[args.indexOf('-c:v') + 1], 'copy')
  }

  // The picture is copied either way. A container fix that re-encoded would be a
  // cure worse than the disease.
  assert.equal(hevc.includes('-c:a'), true)
  assert.equal(hevc[hevc.indexOf('-c:a') + 1], 'copy')
})

test('a soundtrack MPEG-TS could carry but a fragmented MP4 cannot is rebuilt', () => {
  const plan = { starts: [0, 10], seeks: [0, 10.3], ends: [9.999, 20], runtime: 20, engine: 'copy' }
  const argsFor = (audioCodec, videoCodec) => hls.copySegmentArgs({
    input: '/library/x.mkv', plan, seq: 1, audio: 'copy', audioCodec, videoCodec
  })

  // MP3 rides an MPEG-TS segment and is NOT one of the codecs Apple's fMP4 rules
  // name, so the fragmented path rebuilds it. A re-encode is the cheapest
  // conversion there is; a silent film is the most expensive mistake.
  assert.equal(argsFor('mp3', 'h264')[argsFor('mp3', 'h264').indexOf('-c:a') + 1], 'copy')
  assert.equal(argsFor('mp3', 'hevc')[argsFor('mp3', 'hevc').indexOf('-c:a') + 1], 'aac')

  // Dolby survives both, which is the 2026-08-13 measurement and ~620 files.
  for (const codec of ['ac3', 'eac3', 'aac']) {
    const a = argsFor(codec, 'hevc')
    assert.equal(a[a.indexOf('-c:a') + 1], 'copy', codec + ' should be copied into fMP4')
  }
})

test('THE PLAYLIST AGREES WITH ITS SEGMENTS, in the extension, the map and the version', () => {
  const plan = { starts: [0, 10, 20], seeks: [0, 10.3, 20.3], ends: [9.999, 19.999, 30], runtime: 30, engine: 'copy' }
  const ts = hls.playlistFor({ runtime: 30 }, { plan })
  const mp4 = hls.playlistFor({ runtime: 30 }, { plan, container: 'fmp4' })

  // The TS playlist is untouched, byte for byte, by everything this change did.
  assert.match(ts, /#EXT-X-VERSION:3/)
  assert.equal(ts.includes('EXT-X-MAP'), false)
  assert.match(ts, /^0\.ts$/m)

  // A fragmented playlist names its header, and EXT-X-MAP is a version 6 tag - a
  // version 3 playlist carrying one is a stream a player may refuse outright.
  assert.match(mp4, /#EXT-X-VERSION:7/)
  assert.match(mp4, /#EXT-X-MAP:URI="init\.mp4"/)
  assert.match(mp4, /^0\.m4s$/m)
  assert.match(mp4, /^2\.m4s$/m)
  assert.equal(mp4.includes('.ts'), false)

  // The map comes before any segment, or a player has read a segment line before
  // it knows how to decode one.
  assert.ok(mp4.indexOf('#EXT-X-MAP') < mp4.indexOf('0.m4s'))

  // The durations are the plan's own either way - a Roku takes the film's length
  // from their sum, and so does a scrubber.
  assert.equal((mp4.match(/#EXTINF/g) || []).length, 3)
  assert.match(mp4, /#EXTINF:10\.000,/)
})

test('THE INIT RUN IS SEGMENT ZERO, STOPPED AT ONCE - same tracks, none of the film', () => {
  const plan = { starts: [0, 10], seeks: [0, 10.3], ends: [9.999, 20], runtime: 20, engine: 'copy' }
  const shared = { input: '/library/x.mkv', plan, audio: 'copy', audioCodec: 'aac', videoCodec: 'hevc' }
  const init = hls.initArgs(shared)
  const seg0 = hls.copySegmentArgs({ ...shared, seq: 0 })

  // `delay_moov` holds the header back until the first fragment is cut, so asking
  // segment zero for it would mux a whole segment to keep its first kilobyte.
  assert.equal(init[init.indexOf('-to') + 1], hls.INIT_SECONDS.toFixed(6))
  assert.equal(seg0[seg0.indexOf('-to') + 1], '9.999000')

  // EVERYTHING ELSE IS IDENTICAL, which is what makes the header describe the
  // tracks the segments carry rather than some other pair.
  const strip = (a) => { const c = [...a]; c.splice(c.indexOf('-to'), 2); return c }
  assert.deepEqual(strip(init), strip(seg0))

  // Segment zero is never seeked - there is no keyframe before zero to land on.
  assert.equal(init.includes('-ss'), false)

  // A film shorter than the init window asks for the film rather than for more
  // than exists.
  const stub = hls.initArgs({ ...shared, plan: { ...plan, ends: [0.2, 20] } })
  assert.equal(stub[stub.indexOf('-to') + 1], '0.200000')
})

test('the header is read for its timescales and then dropped', () => {
  const init = initSegment([[1, 16000], [2, 48000]])
  const scales = fmp4.timescalesFrom(init)

  assert.equal(scales.get(1), 16000)
  assert.equal(scales.get(2), 48000)
  assert.equal(scales.size, 2)

  // The boundary between header and media, which is what both modes turn on.
  const whole = Buffer.concat([init, fragment([traf(1, 0), traf(2, 0)])])
  assert.equal(fmp4.firstMoofOffset(whole), init.length)
  // No fragment yet is not an error, it is "not enough bytes" - the caller knows
  // whether the stream has ended.
  assert.equal(fmp4.firstMoofOffset(init), -1)
})

test('A SEGMENT IS MOVED ONTO THE FILM\'S CLOCK, and every fragment in it moves together', async () => {
  const init = initSegment([[1, 16000], [2, 48000]])
  // A copy plan's segments are uneven and span the keyframes it skipped, so one
  // segment holds SEVERAL fragments - measured 4 s to 14 s against a 4 s target.
  // Their own `tfdt` values already say where they sit inside the segment.
  const whole = Buffer.concat([
    init,
    fragment([traf(1, 0), traf(2, 0)]),
    fragment([traf(1, 16000), traf(2, 48000)])
  ])

  const out = await shape(whole, { startSeconds: 10, mode: 'media' })

  // The header is gone and the segment begins where an HLS segment begins.
  assert.equal(out.toString('latin1', 4, 8), 'moof')
  assert.equal(out.includes(Buffer.from('ftyp', 'latin1')), false)
  assert.equal(out.includes(Buffer.from('moov', 'latin1')), false)

  // SHIFTED, NOT SET. Setting them all to the segment's start would stack the
  // second fragment on top of the first, which freezes the picture partway
  // through every segment.
  assert.deepEqual(tfdts(out), [
    10 * 16000, 10 * 48000,
    11 * 16000, 11 * 48000
  ])

  // The first segment of a film is already where it belongs and is not touched.
  const first = await shape(whole, { startSeconds: 0, mode: 'media' })
  assert.deepEqual(tfdts(first), [0, 0, 16000, 48000])
})

test('the same run yields the init segment, and stops the moment the film starts', async () => {
  const init = initSegment([[1, 16000], [2, 48000]])
  const whole = Buffer.concat([init, fragment([traf(1, 0), traf(2, 0)], 4096)])

  const header = await shape(whole, { mode: 'header' })

  assert.equal(header.length, init.length)
  assert.deepEqual(header, init)
  // Nothing of the film comes with it - the header is what `#EXT-X-MAP` names,
  // and a segment's worth of picture behind it would be fetched for every film.
  assert.equal(header.includes(Buffer.from('moof', 'latin1')), false)
  assert.equal(header.includes(Buffer.from('mdat', 'latin1')), false)
})

test('THE BYTES ARE NEVER COLLECTED, whatever size the chunks arrive in', async () => {
  const init = initSegment([[1, 90000]])
  // A megabyte of picture, which is what a real segment is almost entirely made
  // of and what must never be buffered to be rewritten.
  const whole = Buffer.concat([init, fragment([traf(1, 0)], 1024 * 1024)])

  // Chunk sizes chosen to split a box header down the middle, which is the case a
  // buffer-and-parse loop gets wrong.
  for (const size of [1, 3, 7, 9, 17, 4096, whole.length]) {
    const out = await shape(whole, { startSeconds: 4, mode: 'media', chunk: size })
    assert.equal(out.length, whole.length - init.length, 'chunked by ' + size)
    assert.deepEqual(tfdts(out), [4 * 90000], 'chunked by ' + size)
  }
})

test('a truncated segment ends rather than handing the player a broken box', async () => {
  const init = initSegment([[1, 90000]])
  const whole = Buffer.concat([init, fragment([traf(1, 0)], 4096)])
  // ffmpeg killed mid-`mdat`, which is what a revoke does to a running segment.
  const cut = whole.slice(0, whole.length - 1000)

  const out = await shape(cut, { startSeconds: 4, mode: 'media' })

  // What arrived is passed on; what never arrived is not invented. The host's own
  // truncation guard is what turns the non-zero exit into an error the phone sees.
  assert.ok(out.length < whole.length - init.length)
  assert.equal(out.toString('latin1', 4, 8), 'moof')
  assert.deepEqual(tfdts(out), [4 * 90000])
})

test('the codec decides, so no television and no re-encode is dragged onto this path', () => {
  // Every cast target in host/cast.js declares `videoCodecs: ['h264']` and every
  // engine in host/engines.js encodes H.264, so a copied HEVC segment can only
  // ever be a phone's. The rule is about the codec rather than the client, and
  // this is what keeps it from quietly changing a television's stream.
  assert.equal(fmp4.needsFmp4('hevc'), true)
  assert.equal(fmp4.needsFmp4('h264'), false)
  assert.equal(fmp4.needsFmp4('mpeg4'), false)
  assert.equal(fmp4.needsFmp4(null), false)
  assert.equal(fmp4.needsFmp4(undefined), false)
  assert.equal(fmp4.needsFmp4('HEVC'), true)
})

// Feed a buffer through the shaper the way a pipe would, in chunks.
//
// COPIED FIRST, and the copy is the point of this comment. `tfdt` is rewritten IN
// PLACE, which is right for chunks arriving off a socket and never looked at
// again, and which means a test feeding the same buffer twice would be shaping
// something it had already shaped. Caught by this file: the second call came back
// shifted twice.
function shape (buf, { startSeconds = 0, mode = 'media', chunk = 8192 } = {}) {
  const copy = Buffer.from(buf)
  return new Promise((resolve, reject) => {
    const shaper = new fmp4.SegmentShaper({ startSeconds, mode })
    const parts = []
    shaper.on('data', (c) => parts.push(c))
    shaper.on('error', reject)
    shaper.on('end', () => resolve(Buffer.concat(parts)))
    for (let at = 0; at < copy.length; at += chunk) shaper.write(copy.slice(at, at + chunk))
    shaper.end()
  })
}
