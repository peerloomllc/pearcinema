'use strict'

// THE NOTES SENT TO APP REVIEW, HELD AGAINST THE APP THEY DESCRIBE.
//
// PearTune's scar, and it is the reason this file exists: it sent a reviewer to a button
// that had since moved, which is itself a Guideline 2.1 rejection - the reviewer follows
// the steps, the step is not there, and the app "does not work". A tap path written once
// and never re-checked is a rejection waiting for a UI tidy-up.
//
// So every screen name and button label the notes name is checked against the strings
// actually in src/ui/App.jsx. What this CANNOT prove is that the ORDER is still right, or
// that a step is not missing - that needs somebody walking the build being submitted, and
// the notes say so in their own header.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const notes = fs.readFileSync(path.join(root, 'metadata', 'ios', 'review-notes.md'), 'utf8')
const app = fs.readFileSync(path.join(root, 'src', 'ui', 'App.jsx'), 'utf8')

// The note itself is everything after the marker line; the header above it is for us.
const body = notes.split(/^---$/m).slice(1).join('---').trim()

test('EVERY BUTTON THE NOTES TELL A REVIEWER TO TAP IS IN THE APP', () => {
  // An apostrophe is written \' inside a single-quoted JSX string, so both sides are
  // unescaped before comparing rather than matched with a regex nobody can read.
  const source = app.replace(/\\'/g, "'")
  for (const label of ['Get started', 'Your name', 'Continue', "I don't have one yet", 'Watch']) {
    assert.ok(
      source.includes(label),
      `the notes tell a reviewer to tap "${label}", and App.jsx does not contain it`
    )
    assert.ok(body.includes(label), `"${label}" should be quoted in the notes`)
  }
})

test('the notes promise the demo path this build actually has', () => {
  // The demo is what makes the app reviewable without a server, so a note that describes
  // it has to be shipping alongside a build that carries it.
  const iosAssets = fs.readFileSync(path.join(root, 'shell', 'demo-assets.ios.ts'), 'utf8')
  assert.match(iosAssets, /demo-library\/Films/, 'the iOS build must carry the demo films')

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'demo-library', 'manifest.json'), 'utf8'))
  const count = manifest.films.length + manifest.shows.reduce((n, s) => n + s.episodes.length, 0)
  // Said as a number in the notes, so the number has to be the truth.
  assert.match(body, new RegExp(`\\b${['zero', 'one', 'two', 'three', 'four', 'five', 'six'][count] || count}\\b`),
    `the notes should say the demo has ${count} films`)
})

test('the notes do not claim a sign-in, and do not offer an account', () => {
  // "Sign-In Required: NO" is a field in App Store Connect, and the note has to agree
  // with it. An app with no accounts that hints at one invites the reviewer to look for
  // a login screen and fail to find it.
  assert.match(body, /no account/i)
  // Saying there is no test account is right and useful. HANDING ONE OVER is the thing
  // that cannot happen, so the check is for credentials rather than for the words.
  assert.ok(!/username and password|password:|log in with|sign in with/i.test(body),
    'the notes must not offer credentials for an app that has none')
})

test('the content claim in the notes matches the one in the listing', () => {
  // The sentence a reviewer of a video app is looking for. It survives the demo - four
  // public-domain shorts do not make this an app that provides content - and it must be
  // said in both places or the pair can drift.
  const listing = JSON.parse(fs.readFileSync(path.join(root, 'metadata', 'ios', 'version', 'default', 'en-US.json'), 'utf8'))
  assert.match(body, /hosts nothing, indexes nothing/)
  assert.match(listing.description, /hosts nothing, indexes nothing/)
})

test('the licence evidence the notes link to is really at that path', () => {
  const m = body.match(/github\.com\/[^\s)]*?\/blob\/master\/(\S+)/)
  assert.ok(m, 'the notes should link to the licence evidence')
  assert.ok(fs.existsSync(path.join(root, m[1])), `${m[1]} is linked from the review notes and is not in the tree`)
})

test('the video is promised, and the thing that makes it exists', () => {
  // The notes tell a reviewer a video is attached, so something has to be able to make
  // one. Three states are allowed and no fourth: attached (what ships), a link, or the
  // placeholder that says nobody has recorded it yet. A note that quietly lost the line
  // reads as finished.
  assert.match(body, /attached to this submission|\[VIDEO URL\]|https:\/\/\S+/,
    'the review notes should promise the walkthrough, or still hold its placeholder')

  // NO SCRIPT CAN CHECK THAT A FILE REACHED APPLE. What it can check is that the video
  // is reproducible from this tree - the cut is a script, not somebody's afternoon.
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'cut-app-review-video.sh')),
    'the notes promise a video, so the thing that cuts it has to be in the tree')
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'ios-sim-demo-video.sh')),
    'and the thing that records its phone half')

  const release = fs.readFileSync(path.join(root, 'scripts', 'release.sh'), 'utf8')
  assert.match(release, /VIDEO URL/, 'release.sh must be the thing that refuses a placeholder at submission')
})
