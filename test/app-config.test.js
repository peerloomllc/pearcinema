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

test('EACH LISTING OFFERS EXACTLY THE DEMO ITS OWN BUILD HAS', () => {
  // PearTune drafted its store description from a proposal that put "Try it without a
  // server" on the intro card. It had moved, and sending a reviewer to a button that is
  // not there is how a 2.1 rejection happens (peartune DONE 2026-07-31).
  //
  // PearCinema's two builds now differ, which is the new way to get this wrong: the
  // Apple build carries four public-domain films and the Play build carries none,
  // because 164 MB of film exceeds Play's 200 MB base-module cap (proposal
  // 2026-08-26-app-review-demo). So a listing that copies the other one is a listing
  // that lies about its own build, in one direction or the other.
  const ios = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'metadata', 'ios', 'version', 'default', 'en-US.json'), 'utf8'))
  const play = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'metadata', 'android', 'listing', 'en-US.json'), 'utf8'))

  for (const [what, text] of [['iOS', ios.description], ['Play', play.fullDescription]]) {
    assert.match(text, /needs that machine running the free PearCinema host/,
      `${what} says a server is required`)
    // THE SENTENCE THAT SURVIVES THE DEMO. A handful of public-domain shorts does not
    // weaken it and must never be written as though it does.
    assert.match(text, /hosts nothing, indexes nothing/, `${what} says it provides no content`)
  }

  // Apple: the demo exists, so the listing says what it is and says it is all there is.
  assert.match(ios.description, /four short public-domain films and nothing else/,
    'the iOS listing says what the app comes with')
  assert.ok(!/comes with nothing to watch/.test(ios.description),
    'the iOS build DOES come with something to watch, and the listing must not deny it')

  // Play: no films in that build, so the old promise stands unchanged.
  assert.match(play.fullDescription, /comes with nothing to watch/, 'Play says nothing is bundled')
  assert.ok(!/demo library|public-domain|try it without a server/i.test(play.fullDescription),
    'the Play listing must not offer a demo the Android build does not carry')
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

test('THE PLAY SCREENSHOTS ARE WITHIN PLAY\'S RULES', () => {
  // Play caps a screenshot's long side at 2x its short side and refuses RGBA. PearTune
  // failed BOTH on the same day, on both stores (peartune DONE 2026-07-31): 1080x2424 is
  // 2.24, and `screencap` always writes alpha.
  //
  // These are captured at 1080x2160, which is exactly 2.000 - a real 18:9 phone shape -
  // so no padding is needed at all, and the alpha is stripped on capture.
  const { execFileSync } = require('child_process')
  const dir = path.join(__dirname, '..', 'metadata', 'store', 'android')
  const shots = fs.readdirSync(dir).filter(f => f.endsWith('.png'))

  assert.ok(shots.length >= 2, 'Play wants at least two phone screenshots')
  for (const s of shots) {
    const out = execFileSync('magick', ['identify', '-format', '%w %h %[channels]', path.join(dir, s)]).toString()
    const [w, h, channels] = out.split(' ')
    const long = Math.max(+w, +h)
    const short = Math.min(+w, +h)
    assert.ok(long / short <= 2, `${s} is ${w}x${h}, ratio ${(long / short).toFixed(3)} - Play caps it at 2`)
    assert.ok(short >= 320 && long <= 3840, `${s} is outside Play's 320..3840`)
    assert.ok(!/a$/.test(channels), `${s} still has alpha (${channels}) and Play refuses it`)
  }
})

test('THE APP STORE FRAMES FIT A SLOT APP STORE CONNECT ACTUALLY HAS', () => {
  // App Store Connect uploads iPhone screenshots into fixed slots: 6.9" is 1320x2868 and
  // 6.7" is 1290x2796. Anything else has nowhere to go - PearTune found that out on
  // 2026-07-31 with six good screenshots already captured on a 6.1" simulator, and this
  // repo nearly repeated it: the standing PearCinema-Test simulator is an iPhone 16.
  // PearCinema-Shots is the Pro Max, and its UDID is in scripts/app.conf.
  //
  // ASC refuses RGBA too, and `simctl io screenshot` always writes it, so the alpha is
  // stripped after capture.
  const { execFileSync } = require('child_process')
  const dir = path.join(__dirname, '..', 'metadata', 'store', 'ios')
  const shots = fs.readdirSync(dir).filter(f => f.endsWith('.png'))
  const slots = ['1320x2868', '1290x2796']

  assert.ok(shots.length >= 2, 'the App Store wants at least two iPhone screenshots')
  for (const s of shots) {
    const out = execFileSync('magick', ['identify', '-format', '%w %h %[channels]', path.join(dir, s)]).toString()
    const [w, h, channels] = out.split(' ')
    assert.ok(slots.includes(`${w}x${h}`), `${s} is ${w}x${h}, which is not ${slots.join(' or ')}`)
    assert.ok(!/a$/.test(channels), `${s} still has alpha (${channels}) and the App Store refuses it`)
  }
})

test('THE HOST IMAGE VERSION IS DECIDED IN ONE PLACE, not two that disagree', () => {
  // The pre-flight prompt said "next host image: $APP_VERSION" while the step that
  // actually builds patch-bumped the highest tag on ghcr. So a release run named 0.1.0,
  // published months earlier, and would have pushed 0.1.5 - a prompt confirming a
  // different version from the one about to go out (found 2026-08-25 on the first
  // release-script run, settled 2026-08-26).
  //
  // THE TWO VERSION LINES STAY SEPARATE, which is the opposite of PearTune's call and
  // deliberate: the app is at 0.1.0 and the published image is past it, so tagging the
  // image with the app version pushes a LOWER number than the Umbrels are running and
  // umbrelOS offers the downgrade as an update.
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'release.sh'), 'utf8')

  assert.match(script, /_host_next_version\(\)\s*\{/, 'the one helper exists')
  assert.match(script, /_host_next="\$\(_host_next_version\)"/, 'the pre-flight prompt asks it')
  assert.match(script, /HOST_IMAGE_BUILT="\$\(_host_next_version\)"/, 'and so does the step that pushes')

  // The old rule, in the words it was written in. Either call site reverting to the app
  // version is the regression this pins.
  assert.ok(!/HOST_IMAGE_VERSION:-\$APP_VERSION/.test(script),
    'no call site falls back to the app version for the host image tag')
})

test('THE EXPORT COMPLIANCE ANSWER IS IN THE BUILD, not asked at every upload', () => {
  // Apple asks whether the app uses non-exempt encryption for EVERY build uploaded, and
  // a build sits unsubmittable until somebody notices the question. The answer belongs in
  // Info.plist, where the upload reads it and never asks.
  //
  // FALSE, matching the three PearTune builds already through App Review on the same
  // crypto stack (checked against App Store Connect, 2026-08-27). Same company, same
  // Noise channel, same blind relay - two sibling apps giving Apple different answers
  // about the same encryption would be the thing worth explaining.
  //
  // Pinned here rather than trusted because it lives only in app.json: ios/ is generated,
  // so a regenerate that dropped it would restore the per-upload prompt silently, which
  // is exactly how the local network purpose string went missing.
  const ios = app.ios.infoPlist
  assert.equal('ITSAppUsesNonExemptEncryption' in ios, true,
    'app.json must answer export compliance, or every upload stops to ask')
  assert.equal(ios.ITSAppUsesNonExemptEncryption, false)
})
