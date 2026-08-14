// The capability mapper: the policy that turns a raw MediaCodecList probe into
// the declaration the host decides from. The fixtures are shaped like the
// native module's real output, and the cross-checks at the bottom run the
// declarations through host/remux.js's OWN decide() - the two sides share one
// vocabulary, and a drift between them is exactly the class of bug the suite
// keeps paying for (a fake season carrying seasonNumber where the model says
// number passed every test while the real library skipped every season).

const test = require('node:test')
const assert = require('node:assert')

const caps = require('../src/capabilities')
const { decide } = require('../host/remux')

// Android MediaCodecInfo.CodecProfileLevel: HEVCProfileMain = 1, Main10 = 2,
// Main10HDR10 = 0x1000, Main10HDR10Plus = 0x2000.

const d = (mime, over = {}) => ({
  name: over.name || 'omx.device.decoder',
  mime,
  hardware: true,
  profiles: [],
  maxWidth: 4096,
  maxHeight: 2304,
  ...over
})

// A phone whose chip really does the lot: hardware H.264, hardware 10-bit
// HEVC, hardware VP9 and AV1, Dolby audio decoders - plus the software
// decoders every Android ships, which must not count.
const capablePhone = [
  d('video/avc', { profiles: [1, 2, 8] }),
  d('video/hevc', { profiles: [1, 2, 0x1000] }),
  d('video/x-vnd.on2.vp9'),
  d('video/av01'),
  d('video/hevc', { name: 'c2.android.hevc.decoder', hardware: false, profiles: [1, 2] }),
  d('video/avc', { name: 'c2.android.avc.decoder', hardware: false }),
  d('audio/mp4a-latm'),
  d('audio/mpeg'),
  d('audio/opus'),
  d('audio/flac'),
  d('audio/vorbis'),
  d('audio/ac3'),
  d('audio/eac3')
]

// A TCL-shaped phone: claims HEVC in hardware but only 8-bit Main - the
// measured class of chip whose claim and whose playback are different facts.
const eightBitPhone = [
  d('video/avc', { profiles: [1, 2, 8] }),
  d('video/hevc', { profiles: [1] }),
  d('audio/mp4a-latm'),
  d('audio/mpeg')
]

test('a capable phone declares what its hardware really claims', () => {
  const out = caps.fromProbe(capablePhone)
  assert.deepStrictEqual(out.videoCodecs, ['av1', 'h264', 'hevc', 'vp9'])
  assert.ok(out.audioCodecs.includes('ac3'))
  assert.ok(out.audioCodecs.includes('eac3'))
  assert.deepStrictEqual(out.containers, caps.CONTAINERS)
})

test('HEVC without Main 10 is not HEVC, because the library is 10-bit', () => {
  const out = caps.fromProbe(eightBitPhone)
  assert.ok(!out.videoCodecs.includes('hevc'))
  assert.ok(out.videoCodecs.includes('h264'))
})

test('a software decoder claim is not a capability, whatever it claims', () => {
  const out = caps.fromProbe([
    d('video/avc'),
    d('video/hevc', { name: 'c2.android.hevc.decoder', hardware: false, profiles: [1, 2, 0x1000] }),
    d('audio/mp4a-latm')
  ])
  assert.ok(!out.videoCodecs.includes('hevc'))
})

test('a video decoder capped below 1080p does not count', () => {
  const out = caps.fromProbe([
    d('video/avc'),
    d('video/hevc', { profiles: [2], maxWidth: 1280, maxHeight: 720 }),
    d('audio/mp4a-latm')
  ])
  assert.ok(!out.videoCodecs.includes('hevc'))
})

test('audio needs only a decoder - software AC-3 still counts', () => {
  const out = caps.fromProbe([
    d('video/avc'),
    d('audio/mp4a-latm'),
    d('audio/ac3', { name: 'c2.android.ac3.decoder', hardware: false, maxWidth: null, maxHeight: null })
  ])
  assert.ok(out.audioCodecs.includes('ac3'))
})

test('a missing or broken probe maps to null, and the static floor stands', () => {
  assert.strictEqual(caps.fromProbe(null), null)
  assert.strictEqual(caps.fromProbe([]), null)
  // No hardware H.264 is a broken probe, not a phone that plays nothing.
  assert.strictEqual(caps.fromProbe([d('video/hevc', { profiles: [2] }), d('audio/mp4a-latm')]), null)
  // No AAC the same.
  assert.strictEqual(caps.fromProbe([d('video/avc'), d('audio/mpeg')]), null)
  assert.ok(caps.STATIC.videoCodecs.includes('h264'))
  assert.ok(!caps.STATIC.videoCodecs.includes('hevc'))
})

test('without() removes the codec the decoder just refused, aliases included', () => {
  const declared = caps.fromProbe(capablePhone)
  assert.ok(!caps.without(declared, 'hevc').videoCodecs.includes('hevc'))
  // Jellyfin spellings of the same codec.
  assert.ok(!caps.without(declared, 'h265').videoCodecs.includes('hevc'))
  assert.ok(!caps.without(declared, 'hev1').videoCodecs.includes('hevc'))
  // Never mutates the input.
  assert.ok(declared.videoCodecs.includes('hevc'))
})

// --- the cross-checks: these declarations through the host's own decide() ----

// Blade, verbatim off the real library: the HEVC film the TCL's chip refused.
const blade = { container: 'mov', videoCodec: 'hevc', audioCodec: 'aac' }

test('the host direct-plays HEVC to a phone that proved Main 10 hardware', () => {
  const v = decide(blade, caps.fromProbe(capablePhone), { transcode: true })
  assert.strictEqual(v.mode, 'direct')
})

test('the host still transcodes HEVC for the 8-bit phone', () => {
  const v = decide(blade, caps.fromProbe(eightBitPhone), { transcode: true })
  assert.strictEqual(v.mode, 'transcode')
})

test('the retry declaration turns a lying chip into a transcode verdict', () => {
  const declared = caps.fromProbe(capablePhone)
  assert.strictEqual(decide(blade, declared, { transcode: true }).mode, 'direct')
  const v = decide(blade, caps.without(declared, 'hevc'), { transcode: true })
  assert.strictEqual(v.mode, 'transcode')
})

test('a declared AC-3 decoder moves Dolby files to direct play', () => {
  const film = { container: 'matroska', videoCodec: 'h264', audioCodec: 'ac3' }
  assert.strictEqual(decide(film, caps.fromProbe(capablePhone)).mode, 'direct')
  // The static floor does not declare it, so the host remuxes with the sound
  // rebuilt - the pre-probe behaviour, unchanged.
  assert.strictEqual(decide(film, caps.STATIC).mode, 'remux')
})
