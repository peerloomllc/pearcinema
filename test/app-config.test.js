// WHAT THE PHONE ASKS THE OPERATING SYSTEM FOR, and why each one is pinned here.
//
// `android/` and `ios/` are both GENERATED and neither is committed, so app.json is the
// only place these survive - a regenerate silently drops anything not written down, and
// the failure is invisible until a store review or a prompt that says nothing.
//
// Found sweeping PearTune's release-era work (2026-08-25). PearTune declares a local
// network purpose string and PearCinema did not, while PearCinema's own DONE says of the
// first iPhone build "it asks for permission to find your library on the network" - so
// the prompt was being raised with no reason attached to it.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')).expo

test('iOS SAYS WHY IT WANTS THE LOCAL NETWORK, because it does ask', () => {
  // PearCinema's whole point is reaching a library directly, and on the same network that
  // means the Local Network prompt. Apple requires a purpose string for a permission the
  // app triggers; without one the prompt is bare and review guideline 5.1.1 is in play.
  const s = app.ios.infoPlist.NSLocalNetworkUsageDescription
  assert.ok(s, 'NSLocalNetworkUsageDescription is declared')
  assert.ok(s.length > 30, 'and it is a sentence rather than a placeholder')
  assert.match(s, /PearCinema/, 'it names the app, the way Apple wants it to read')
})

test('iOS says why it wants the camera', () => {
  // The only other prompt the app raises. Pinned beside its neighbour so a regenerate
  // that loses one loses the test too.
  const s = app.ios.infoPlist.NSCameraUsageDescription
  assert.ok(s && s.length > 20, 'NSCameraUsageDescription is a real sentence')
  assert.match(s, /pairing|QR|code/i, 'and it says what the camera is actually for')
})

test('THE PERMISSIONS A STORE WILL SHOW ARE THE ONES WE MEANT', () => {
  // PearTune shipped an AAB asking for 14 permissions against an app.json that asked for
  // 5 (peartune DONE 2026-07-31) - packages add their own, and Play lists what the BUILT
  // manifest says rather than what we wrote. The three worst offenders are blocked here.
  //
  // This pins the intent. It cannot prove the merged manifest, which needs a build - the
  // one on this machine was read by hand on 2026-08-25 and showed exactly these plus
  // ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE and VIBRATE from packages, with
  // SYSTEM_ALERT_WINDOW present ONLY in the debug variant, where React Native's own
  // debug manifest adds it for the dev overlay.
  const asked = app.android.permissions
  assert.deepEqual([...asked].sort(), ['CAMERA', 'INTERNET', 'POST_NOTIFICATIONS', 'WAKE_LOCK'].sort())

  const blocked = app.android.blockedPermissions
  for (const p of ['RECORD_AUDIO', 'SYSTEM_ALERT_WINDOW', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE']) {
    assert.ok(blocked.includes('android.permission.' + p), `${p} is blocked`)
  }

  // RECORD_AUDIO is the one that matters most and is easiest to lose: a video package
  // declares it because the package can record, and Play then shows "Microphone" against
  // an app that has never recorded anything.
  assert.ok(!asked.includes('RECORD_AUDIO'), 'and never asked for anywhere')
})

test('the app is the same app on both stores', () => {
  // A mismatch here is not caught until an upload is rejected or, worse, accepted into
  // the wrong listing.
  assert.equal(app.ios.bundleIdentifier, 'com.pearcinema')
  assert.equal(app.android.package, 'com.pearcinema')
  assert.ok(app.version, 'and it declares a version, which the phone UI is built from')
})

/* ------------------------------------------------ what a store listing needs -- */

test('THE PLAY FEATURE GRAPHIC IS 1024x500 AND HAS NO ALPHA', () => {
  // Play requires a feature graphic for a listing, refuses anything but 1024x500, and
  // refuses RGBA - PearTune lost a cycle to alpha on BOTH stores in one day, because a
  // screenshot pipeline writes it and nothing says so (peartune DONE 2026-07-31).
  //
  // The file is built by scripts/build-feature-graphic.mjs and committed, so this reads
  // the committed artefact rather than trusting the generator to have been run.
  const { execFileSync } = require('child_process')
  const file = path.join(__dirname, '..', 'metadata', 'android', 'feature-graphic.png')
  assert.ok(fs.existsSync(file), 'metadata/android/feature-graphic.png exists')

  const out = execFileSync('magick', ['identify', '-format', '%w %h %[channels]', file]).toString()
  const [w, h, channels] = out.split(' ')
  assert.equal(w, '1024', 'Play refuses any other width')
  assert.equal(h, '500', 'Play refuses any other height')
  assert.ok(!/a$/.test(channels) && channels !== 'rgba', `alpha survived: ${channels}`)
})

test('EVERY STORE FIELD IS WITHIN THE STORE\'S LIMIT', () => {
  // A field over the limit is not caught until an upload is refused, which on the App
  // Store means a round trip through review scheduling. The limits themselves are the
  // stores': iOS name and subtitle 30, keywords 100, promotional text 170, description
  // 4000; Play title 30, short description 80, full description 4000.
  //
  // The short description was 83 characters when first written, which is exactly the kind
  // of thing that reads fine and fails at the console.
  const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'metadata', ...p), 'utf8'))
  const limits = {
    name: 30, subtitle: 30, description: 4000, keywords: 100, promotionalText: 170,
    title: 30, shortDescription: 80, fullDescription: 4000
  }
  const files = [
    read('ios', 'app-info', 'en-US.json'),
    read('ios', 'version', 'default', 'en-US.json'),
    read('android', 'listing', 'en-US.json')
  ]
  for (const f of files) {
    for (const [k, v] of Object.entries(f)) {
      if (!limits[k]) continue
      assert.ok(v.length <= limits[k], `${k} is ${v.length}, limit is ${limits[k]}`)
      assert.ok(v.length > 0, `${k} is empty`)
    }
  }
})

test('THE LISTINGS DO NOT OFFER A DEMO THAT DOES NOT EXIST', () => {
  // PearTune drafted its store description from a proposal that put "Try it without a
  // server" on the intro card. It had moved, and sending a reviewer to a button that is
  // not there is how a 2.1 rejection happens (peartune DONE 2026-07-31).
  //
  // PearCinema has NO demo library at all - App.jsx says so where the onboarding diverges
  // from the donor's - so the listings must say a server is needed and must not imply
  // anything is bundled to watch.
  const ios = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'metadata', 'ios', 'version', 'default', 'en-US.json'), 'utf8'))
  const play = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'metadata', 'android', 'listing', 'en-US.json'), 'utf8'))

  for (const [what, text] of [['iOS', ios.description], ['Play', play.fullDescription]]) {
    assert.match(text, /needs that machine running the free PearCinema host/,
      `${what} says a server is required`)
    assert.match(text, /comes with nothing to watch/, `${what} says nothing is bundled`)
    assert.ok(!/demo library|built-in demo|try it without a server/i.test(text),
      `${what} must not offer a demo PearCinema does not have`)
  }

  // And the sentence a reviewer of a VIDEO app is looking for, said outright rather than
  // implied by the rest.
  for (const [what, text] of [['iOS', ios.description], ['Play', play.fullDescription]]) {
    assert.match(text, /hosts nothing, indexes nothing/, `${what} says it provides no content`)
  }
})

test('the listings point at pages that exist', () => {
  // Both stores require a privacy policy URL and Apple requires a support URL. These were
  // 404s until 2026-08-25, when the pages were written.
  const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'metadata', 'ios', 'app-info', 'en-US.json'), 'utf8'))
  const ver = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'metadata', 'ios', 'version', 'default', 'en-US.json'), 'utf8'))
  assert.equal(info.privacyPolicyUrl, 'https://peerloomllc.com/pearcinema/privacy')
  assert.equal(ver.supportUrl, 'https://peerloomllc.com/pearcinema/support')
  assert.equal(ver.marketingUrl, 'https://peerloomllc.com/pearcinema/')
})
