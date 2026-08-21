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

// A TCL-shaped phone: hardware HEVC advertising only 8-bit Main. Measured
// 2026-08-16: this exact chip plays real 10-bit x265 flawlessly - the profile
// list under-reports, so it must not gate the declaration. The chip whose
// decoder genuinely cannot do 10-bit is the retry net's job, proven the same
// day.
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

test('HARDWARE HEVC counts even when its profile list says Main only - the measured reversal', () => {
  // The old rule refused this phone's hevc for lacking the Main 10 flag, and
  // taxed 76% of the television with a transcode the chip never needed. The
  // flag under-reports; the retry net catches the chip that truly cannot.
  const out = caps.fromProbe(eightBitPhone)
  assert.ok(out.videoCodecs.includes('hevc'))
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

test('the 8-bit-flagged phone now DIRECT-plays HEVC, and the retry is its net', () => {
  // The other half of the measured reversal: this phone used to pay a
  // transcode for every HEVC file. Now it direct-plays, and if its decoder
  // truly cannot, the player-error retry re-describes it and THAT verdict is
  // the transcode - the exact sequence hardware-proven 2026-08-16.
  const declared = caps.fromProbe(eightBitPhone)
  assert.strictEqual(decide(blade, declared, { transcode: true }).mode, 'direct')
  assert.strictEqual(decide(blade, caps.without(declared, 'hevc'), { transcode: true }).mode, 'transcode')
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

// --- the other phone -----------------------------------------------------------

test('AN iPHONE DECLARES AN iPHONE, not this file\'s Android floor', () => {
  // MEASURED THE HARD WAY (Tim, 2026-08-20, first play on the iPhone SE): a black screen
  // with AVFoundation's crossed-out play glyph. The probe is Android-only, so iOS fell
  // through to the "conservative" static declaration - which claims Matroska, and
  // Matroska is 83% of this library and something AVPlayer will not open at all. The
  // host was told the film would play as it is, so it sent it as it is.
  const ios = caps.staticFor('ios')
  assert.deepEqual(ios.containers, ['mp4'], 'no Matroska, no WebM')
  assert.ok(ios.videoCodecs.includes('hevc'), 'Apple hardware has decoded HEVC since the A9')
  assert.ok(!ios.videoCodecs.includes('vp9') && !ios.videoCodecs.includes('av1'), 'AVPlayer plays neither')
  // Sound stays timid on purpose: a re-encode is cheap and silence is the worst
  // failure available - the lesson the televisions taught twice.
  assert.ok(!ios.audioCodecs.includes('ac3') && !ios.audioCodecs.includes('dts'))

  // Anything else is the Android floor, including an unknown platform: that is the one
  // that was measured.
  assert.deepEqual(caps.staticFor('android'), caps.STATIC)
  assert.deepEqual(caps.staticFor(undefined), caps.STATIC)
  assert.deepEqual(caps.staticFor('windows-phone'), caps.STATIC)
})

test('the film that was a black screen on the iPhone now takes the long way round', () => {
  const ios = caps.staticFor('ios')
  // The ordinary shape of this library: h264 in Matroska with 5.1 AAC.
  const mkv = { container: 'matroska', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 6 }
  assert.strictEqual(decide(mkv, ios).mode, 'remux', 'repackaged rather than handed over raw')
  // And on Android the same film still direct-plays, which is the whole reason the
  // declaration is per-platform rather than narrowed for everybody.
  assert.strictEqual(decide(mkv, caps.STATIC).mode, 'direct')

  // An HEVC film in an MP4 is the one an iPhone opens untouched.
  assert.strictEqual(decide({ container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac' }, ios).mode, 'direct')
  // A Dolby soundtrack in that same MP4 is rebuilt rather than risked.
  assert.strictEqual(decide({ container: 'mp4', videoCodec: 'hevc', audioCodec: 'ac3' }, ios).mode, 'remux')
})

test('a repackaged film reaches an iPhone as a playlist, and an Android as itself', () => {
  // The second half of the same bug. Even with the right declaration, a remux verdict
  // collapsed to direct play on every phone - which on iOS means handing AVPlayer the
  // Matroska it just said it could not open, or a generated body with no byte ranges,
  // which it refuses just as flatly.
  assert.strictEqual(caps.wantsPlaylist('remux', 'ios'), true)
  assert.strictEqual(caps.wantsPlaylist('remux', 'android'), false)
  // A transcode is generated on any platform: no length, no offsets, segments or nothing.
  assert.strictEqual(caps.wantsPlaylist('transcode', 'ios'), true)
  assert.strictEqual(caps.wantsPlaylist('transcode', 'android'), true)
  // And a film that needs nothing done to it is never wrapped in a playlist.
  assert.strictEqual(caps.wantsPlaylist('direct', 'ios'), false)
  assert.strictEqual(caps.wantsPlaylist('direct', 'android'), false)
  assert.strictEqual(caps.wantsPlaylist(undefined, 'ios'), false)
})
