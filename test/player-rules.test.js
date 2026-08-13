// The rules the player judges a file by, and the rule the first-run wizard opens on.
//
// These live in host/ui/app/ and would normally only ever run in a browser, which
// is exactly why they are tested here. `verdictFor` decides which of somebody's
// films the player refuses and what sentence it shows them - on a real library that
// is most of the collection, so getting it wrong is not cosmetic. Pinning it in Node
// means the decision can be checked against several browsers' answers without
// opening any of them.
//
// The browser is injected (canPlayType is a function we pass in), so each test below
// is "what would Chrome do", "what would Edge do", rather than "what does whatever
// is installed on this machine do".

const test = require('node:test')
const assert = require('node:assert/strict')

const APP = '../host/ui/app/'

// Chrome and Safari: MP4 and WebM, no Matroska at all. This is the case that
// governs 83% of the measured real library.
// The refusals are listed FIRST because the probe strings overlap: HEVC is asked
// about as `video/mp4; codecs="hvc1..."`, so a rule matching video/mp4 would answer
// yes to it before the codec was ever considered.
const chrome = (type) => {
  if (/matroska|x-msvideo|mp2t|x-ms-|hvc1|ac-3|ec-3|mp4v/.test(type)) return ''
  if (/avc1|mp4a|audio\/mpeg|vp8|vp9|av01|opus|vorbis|flac|video\/mp4|video\/webm/.test(type)) return 'probably'
  return ''
}

// Edge, which does open Matroska and does decode HEVC and Dolby.
const edge = (type) => {
  if (/x-msvideo|mp2t|x-ms-/.test(type)) return ''
  return 'maybe'
}

async function playback () { return import(APP + 'playback.js') }

const film = (media) => ({ type: 'movie', id: 'x', title: 'A film', media })

test('an MKV is refused, and the reason names remux rather than blaming the file', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chrome)

  const v = verdictFor(film({ container: 'matroska', videoCodec: 'h264', audioCodec: 'aac' }), caps)
  assert.equal(v.status, 'refuse')
  assert.match(v.reason, /MKV/)
  assert.match(v.reason, /Nothing is wrong with the film/)
  assert.match(v.reason, /remux/)
  // The comparison that makes this evidence rather than an apology.
  assert.match(v.reason, /iPhone/)
})

test('the same MKV plays in a browser that opens Matroska', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const v = verdictFor(film({ container: 'matroska', videoCodec: 'h264', audioCodec: 'aac' }), probeCapabilities(edge))
  assert.equal(v.status, 'play')
})

test('an ordinary MP4 plays - and ffprobe calls that container `mov`', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chrome)
  assert.equal(verdictFor(film({ container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' }), caps).status, 'play')
  // host/probe.js keeps the first word of ffprobe's `mov,mp4,m4a,3gp,3g2,mj2`, so a
  // plain .mp4 arrives as `mov`. Treating that as QuickTime-and-therefore-suspect
  // would refuse most of the files that actually work.
  assert.equal(verdictFor(film({ container: 'mov', videoCodec: 'h264', audioCodec: 'aac' }), caps).status, 'play')
})

test('a DTS or TrueHD track is picture-without-sound, NOT a refusal', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chrome)

  for (const audio of ['dts', 'truehd']) {
    const v = verdictFor(film({ container: 'mp4', videoCodec: 'h264', audioCodec: audio }), caps)
    assert.equal(v.status, 'nosound', audio + ' should still show a picture')
    assert.match(v.reason, /no sound/)
    assert.match(v.reason, /On a phone this track is usually fine/)
  }
})

test('HEVC is refused where the browser cannot decode it and allowed where it can', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const inMp4 = film({ container: 'mp4', videoCodec: 'hevc', audioCodec: 'aac' })
  assert.equal(verdictFor(inMp4, probeCapabilities(chrome)).status, 'refuse')
  assert.equal(verdictFor(inMp4, probeCapabilities(edge)).status, 'play')
})

test('codec names from the two sources mean the same thing', async () => {
  const { normalizeCodec } = await playback()
  assert.equal(normalizeCodec('H265'), 'hevc')
  assert.equal(normalizeCodec('hvc1'), 'hevc')
  assert.equal(normalizeCodec('AVC'), 'h264')
  assert.equal(normalizeCodec('EC-3'), 'eac3')
  assert.equal(normalizeCodec(null), '')
})

test('a file the source said nothing about is unknown, not refused', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const v = verdictFor(film({}), probeCapabilities(chrome))
  assert.equal(v.status, 'unknown')
  assert.match(v.reason, /It may play/)
})

test('the tally counts what it knows and never inflates the playable number', async () => {
  const { probeCapabilities, tally } = await playback()
  const caps = probeCapabilities(chrome)

  const list = [
    film({ container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' }),
    film({ container: 'matroska', videoCodec: 'h264', audioCodec: 'aac' }),
    film({ container: 'matroska', videoCodec: 'hevc', audioCodec: 'ac3' }),
    film({ container: 'mp4', videoCodec: 'h264', audioCodec: 'dts' }),
    film({}),
    { type: 'series', id: 's', title: 'A show' } // no media at all - not a leaf
  ]

  assert.deepEqual(tally(list, caps), { total: 5, play: 1, nosound: 1, refuse: 2, unknown: 1 })
})

test('AVI is refused too - 218 files of the real library are exactly this', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const v = verdictFor(film({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'mp3' }), probeCapabilities(chrome))
  assert.equal(v.status, 'refuse')
  assert.match(v.reason, /AVI/)
})

/* ------------------------------------------------------------- the wizard -- */

test('a host nobody has configured or paired is fresh', async () => {
  const { needsSetup } = await import(APP + 'setup.js')

  assert.equal(needsSetup({ stats: {}, devices: [], source: { from: 'none' } }), true)

  // An Umbrel install ships PEARCINEMA_FOLDERS, so it HAS a source it never chose.
  // Treating that as configured would skip the wizard on every fresh install, which
  // is the one place it is most needed.
  assert.equal(needsSetup({ stats: {}, devices: [], source: { from: 'env' } }), true)

  assert.equal(needsSetup({ stats: {}, devices: [], source: { from: 'dashboard' } }), false)
  assert.equal(needsSetup({ stats: {}, devices: [{ deviceKey: 'a' }], source: { from: 'none' } }), false)

  // No state yet is not "fresh" - it is "we have not asked". Opening a wizard over a
  // page that has not loaded would flash on every reload.
  assert.equal(needsSetup(null), false)
})

test('the password step is offered only when we are the ones who own the password', async () => {
  const { setupSteps } = await import(APP + 'setup.js')

  const has = (src) => setupSteps({ auth: { passwordSource: src } }).includes('password')

  assert.equal(has('generated'), true)
  assert.equal(has('file'), true)
  // Umbrel sets it via ${APP_PASSWORD}: changing it here would be silently undone
  // by the next container restart.
  assert.equal(has('explicit'), false)
  // Loopback, no gate, nothing to change.
  assert.equal(has('none'), false)
})
