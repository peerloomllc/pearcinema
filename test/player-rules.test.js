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

test('an MKV the browser refuses is marked REMUXABLE, which is what makes it playable', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chrome)

  // The 83% case. The browser will not open the box, but it can decode everything
  // inside it - so the host repackages and the film plays. `remuxable` is the flag
  // the player turns on to do that, and it is the difference between a refusal and
  // a film.
  const v = verdictFor(film({ container: 'matroska', videoCodec: 'h264', audioCodec: 'aac' }), caps)
  assert.equal(v.status, 'refuse')
  assert.equal(v.remuxable, true)
  assert.match(v.reason, /MKV/)
  assert.match(v.reason, /repackages/)
  assert.match(v.reason, /without re-encoding/)
  // The comparison that makes this evidence rather than an apology.
  assert.match(v.reason, /iPhone/)
})

test('a refusal repackaging CANNOT fix says so, and says which half is the problem', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chrome)

  // Rung three: the 218 AVI files. Repackaging cannot change the picture.
  const avi = verdictFor(film({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'mp3' }), caps)
  assert.equal(avi.status, 'refuse')
  assert.equal(avi.remuxable, false)
  assert.match(avi.reason, /re-encoding/)

  // HEVC this browser cannot decode, in a container it cannot open either.
  const hevc = verdictFor(film({ container: 'matroska', videoCodec: 'hevc', audioCodec: 'aac' }), caps)
  assert.equal(hevc.remuxable, false)
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

test('a DTS or TrueHD track is a SOUND problem, not a refusal - and it gets fixed', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chrome)

  // The distinction is real rather than theoretical: iOS was measured doing exactly
  // this on 2026-08-13 - reporting DTS as unsupported, then playing the picture and
  // dropping the audio. A player that folded this into a refusal would hide a film
  // that plays; one that merely reported it would leave the viewer with silence.
  for (const audio of ['dts', 'truehd']) {
    const v = verdictFor(film({ container: 'mp4', videoCodec: 'h264', audioCodec: audio }), caps)
    assert.equal(v.status, 'nosound', audio + ' should still show a picture')
    assert.equal(v.remuxable, true, 'and the soundtrack is rebuilt rather than lost')
    assert.match(v.reason, /cannot decode/)
    assert.match(v.reason, /picture is untouched/)
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

  // `repackaged` counts what the HOST will fix, across statuses - the MKV refusal it
  // can rewrap and the DTS soundtrack it can rebuild. It is deliberately not folded
  // into `play`, because the two are different claims: one plays untouched and the
  // other plays because the host worked.
  assert.deepEqual(tally(list, caps), { total: 5, play: 1, nosound: 1, refuse: 2, unknown: 1, repackaged: 2 })
})

test('AVI is refused too - 218 files of the real library are exactly this', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const v = verdictFor(film({ container: 'avi', videoCodec: 'mpeg4', audioCodec: 'mp3' }), probeCapabilities(chrome))
  assert.equal(v.status, 'refuse')
  assert.equal(v.remuxable, false, 'and repackaging is not the answer for these')
  assert.match(v.reason, /AVI/)
})

test('the two MP4 tables agree with the host s, because they cannot be one module', async () => {
  // playback.js is bundled into a browser and host/remux.js runs in Node, so they
  // are two copies by necessity. This is the thing that stops them drifting: a
  // browser that thinks a file is remuxable while the host disagrees shows somebody
  // a spinner and then an error.
  const { MP4_VIDEO, MP4_AUDIO } = await playback()
  const host = require('../host/remux')
  assert.deepEqual([...MP4_VIDEO].sort(), [...host.MP4_VIDEO].sort())
  assert.deepEqual([...MP4_AUDIO].sort(), [...host.MP4_AUDIO].sort())
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

/* --------------------------------------------- what browsers actually answer -- */

// Measured 2026-08-13 against Brave/Chromium 149, which is what Tim runs. The
// surprise is the first line: Chromium DOES open Matroska, which the repo's docs had
// been denying. The code was already right because it asks canPlayType rather than
// modelling it, and this test pins that the asking still happens.
const chromium = (type) => {
  if (/x-matroska/.test(type)) return /codecs/.test(type) ? 'probably' : 'maybe'
  if (/hvc1|ac-3|ec-3|x-msvideo|mp2t|x-ms-/.test(type)) return ''
  if (/avc1|mp4a|audio\/mpeg|vp8|vp9|av01|opus|vorbis|flac|video\/mp4|video\/webm/.test(type)) return 'probably'
  return ''
}

test('AN MKV OF H.264 AND AAC PLAYS UNTOUCHED IN CHROMIUM - do not repackage it', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const v = verdictFor(film({ container: 'matroska', videoCodec: 'h264', audioCodec: 'aac' }), probeCapabilities(chromium))

  // Tim's own copy of 2001. Repackaging it would spend a child process producing
  // bytes identical in every way that matters to the ones already on disk.
  assert.equal(v.status, 'play')
})

test('but Chromium still refuses HEVC, which is 64% of the television library', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chromium)
  const v = verdictFor(film({ container: 'matroska', videoCodec: 'hevc', audioCodec: 'aac' }), caps)

  assert.equal(v.status, 'refuse')
  // And repackaging cannot help, because it cannot change the picture. This is the
  // bucket that remains genuinely unplayable until there is a video encoder.
  assert.equal(v.remuxable, false)
})

test('A SOUNDTRACK THE BROWSER CANNOT DECODE IS REBUILT, not reported as silence', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chromium)

  // An AC-3 film in Chromium: the picture is fine and the sound is not. Reporting
  // "picture only" and stopping there left the cheapest win on the table - rebuilding
  // a soundtrack is rung two, which the 2026-08-13 measurement showed is a rounding
  // error of the library.
  const v = verdictFor(film({ container: 'matroska', videoCodec: 'h264', audioCodec: 'ac3' }), caps)
  assert.equal(v.status, 'nosound')
  assert.equal(v.remuxable, true, 'the player repackages this rather than playing it silent')
  assert.match(v.reason, /picture is untouched/)

  // DTS and TrueHD are the same story.
  for (const a of ['dts', 'truehd']) {
    assert.equal(verdictFor(film({ container: 'mp4', videoCodec: 'h264', audioCodec: a }), caps).remuxable, true)
  }
})

test('the capability query tells the host what this browser opens, MKV included', async () => {
  const { probeCapabilities, capabilityQuery } = await playback()
  const q = new URLSearchParams(capabilityQuery(probeCapabilities(chromium)))

  // A host that was not told about Matroska would repackage files this browser can
  // already open.
  assert.match(q.get('containers'), /matroska/)
  assert.match(q.get('video'), /h264/)
  assert.doesNotMatch(q.get('video'), /hevc/)
  assert.doesNotMatch(q.get('audio'), /ac3/)
})

test('RUNTIMES ARE SECONDS, and reading them as minutes made 300 a 116-HOUR film', async () => {
  const { fmtRuntime } = await import(APP + 'api.js')

  // 300, straight off Tim's drive: ffprobe reports 6993 seconds. It showed as
  // "116h 33m" because the formatter treated the number as minutes. Seconds is the
  // host's deliberate convention (nfo.js normalises Kodi's minutes on the way in, so
  // that nothing downstream has to remember which unit it is holding).
  assert.equal(fmtRuntime(6993), '1h 57m')
  assert.equal(fmtRuntime(1303), '22m')
  assert.equal(fmtRuntime(9180), '2h 33m')
  assert.equal(fmtRuntime(0), '')
  assert.equal(fmtRuntime(null), '')
})

test('a badge is a promise about what will HAPPEN, so a repackaged file wears none', async () => {
  const { probeCapabilities, verdictFor } = await playback()
  const caps = probeCapabilities(chromium)

  // The Batman: TrueHD, which no browser decodes. It wore a "no sound" badge and then
  // played with sound, because the host rebuilds the soundtrack. The badge was
  // describing what the browser could do alone rather than what the app does.
  const batman = verdictFor(film({ container: 'matroska', videoCodec: 'h264', audioCodec: 'truehd' }), caps)
  assert.equal(batman.status, 'nosound')
  assert.equal(batman.remuxable, true, 'so no badge - it plays, with sound')

  // Only a file nothing can fix keeps a flag.
  const hevc = verdictFor(film({ container: 'matroska', videoCodec: 'hevc', audioCodec: 'aac' }), caps)
  assert.equal(hevc.remuxable, false)
})

test('an .mp4 holding HEVC says WHY the familiar extension did not help', async () => {
  const { probeCapabilities, verdictFor } = await playback()

  // Blade on the real drive: `mov/hevc/aac`. It looks like it ought to play, and does
  // not, and the reason is invisible unless it is said - the extension names the box.
  const v = verdictFor(film({ container: 'mov', videoCodec: 'hevc', audioCodec: 'aac' }), probeCapabilities(chromium))
  assert.equal(v.status, 'refuse')
  assert.equal(v.remuxable, false)
  assert.match(v.reason, /HEVC/)
  assert.match(v.reason, /the name describes the box, not what is inside it/)
})
