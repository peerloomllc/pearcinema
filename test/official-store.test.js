'use strict'

// THE OFFICIAL UMBREL STORE SUBMISSION, HELD AGAINST THE COMMUNITY LISTING.
//
// `umbrel/` is what the PeerLoom community store serves; `umbrel/official/` is what a
// pull request to getumbrel/umbrel-apps contains. They are deliberately different - a
// community id is prefixed, an official one is bare; a community listing carries its own
// icon, an official one omits it because Umbrel hosts the assets - and the store's own
// linter turns several of those differences into errors if they are wrong.
//
// Everything ELSE has to be the same app, and nothing enforces that on its own. A second
// copy of a listing is exactly how PearTune's community entry became an old snapshot
// pointing at image 0.1.0 and an empty music path, which anybody publishing it before
// 2026-07-31 would have shipped.
//
// So this file pins the two halves of that: what MUST differ, and what must NOT.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const COMMUNITY = path.join(ROOT, 'umbrel')
const OFFICIAL = path.join(COMMUNITY, 'official')

const read = (p) => fs.readFileSync(p, 'utf8')
const community = read(path.join(COMMUNITY, 'umbrel-app.yml'))
const official = read(path.join(OFFICIAL, 'umbrel-app.yml'))
const communityCompose = read(path.join(COMMUNITY, 'docker-compose.yml'))
const officialCompose = read(path.join(OFFICIAL, 'docker-compose.yml'))

// A top-level scalar field, as the manifest writes it. Deliberately a line match rather
// than a YAML parse: these files are read by a linter that cares about the literal text,
// and a parser would happily normalise away a difference that matters to it.
function field (src, name) {
  const m = new RegExp(`^${name}: (.*)$`, 'm').exec(src)
  return m ? m[1].trim() : null
}

test('THE SUBMISSION IS THE THREE FILES A PR CONTAINS, and no images', () => {
  for (const f of ['umbrel-app.yml', 'docker-compose.yml', 'data/.gitkeep']) {
    assert.ok(fs.existsSync(path.join(OFFICIAL, f)), `umbrel/official/${f} is missing`)
  }
  // "Do not commit screenshots, gallery assets, or icon assets for official App Store
  // submissions; the Umbrel team will create and host final App Store assets."
  const stray = fs.readdirSync(OFFICIAL).filter((f) => /\.(png|jpe?g|webp|svg|gif)$/i.test(f))
  assert.deepEqual(stray, [], 'Umbrel hosts the gallery and icon; committing them here is asked against')
})

test('WHAT THE STORE\'S LINTER TURNS INTO AN ERROR IS RIGHT', () => {
  // The directory is `pearcinema/` in the store, and the id must equal it - where the
  // community store prefixes every id with its own name.
  assert.equal(field(official, 'id'), 'pearcinema')
  assert.equal(field(community, 'id'), 'peerloom-pearcinema')

  // A HARD ERROR if set on a new app, and the single field that left PearTune's
  // submission red for 27 days with no reviewer comment: there is no previous version
  // for release notes to describe.
  assert.equal(field(official, 'releaseNotes'), '""')

  // Warnings rather than errors, but both are asked for on a new submission - Umbrel
  // creates the gallery, and an official manifest omits the icon entirely.
  assert.equal(field(official, 'gallery'), '[]')
  assert.equal(field(official, 'icon'), null, 'an official manifest omits icon; Umbrel hosts it')

  // One of exactly ten the linter accepts, and the right one for a film library.
  assert.equal(field(official, 'category'), 'media')

  // The only two permission values it accepts. PearCinema wants both: the library lives
  // under Downloads, and /dev/dri is what makes conversion cost 11x less than the CPU.
  assert.match(official, /^permissions:\n(?:  - (?:STORAGE_DOWNLOADS|GPU)\n)+/m)

  // Required and non-empty. `submission` must be a valid URL - the PR's own, by
  // convention, which cannot exist until the PR does.
  assert.ok(field(official, 'submitter'), 'submitter is required and non-empty')
  assert.match(field(official, 'submission') || '', /^https:\/\/\S+$/)
})

test('EVERYTHING THAT IS NOT MEANT TO DIFFER, DOES NOT', () => {
  // The same app, described the same way. A second copy of a listing is how PearTune's
  // community entry silently became an old snapshot.
  for (const f of ['version', 'port', 'tagline', 'developer', 'repo', 'support', 'path', 'dependencies']) {
    assert.equal(field(official, f), field(community, f), `${f} drifted between the two listings`)
  }

  // THE IMAGE ABOVE ALL, because a submission pinned to a digest nobody ships is a
  // review that fails on a pull rather than on a field.
  const image = (src) => (/^\s*image: (\S+)$/m.exec(src) || [])[1]
  assert.equal(image(officialCompose), image(communityCompose), 'the two listings must ship the same image')
  assert.match(image(officialCompose) || '', /@sha256:[0-9a-f]{64}$/, 'the image must be pinned by digest')

  // And the same reason for no app_proxy, which is the thing a reviewer will ask about.
  for (const [name, src] of [['community', communityCompose], ['official', officialCompose]]) {
    assert.match(src, /network_mode: host/, `${name} compose must use host networking`)
    assert.ok(!/app_proxy:/.test(src), `${name} compose must not add app_proxy - the linter errors when it fronts a host-networked service`)
  }
})

test('the justifications a reviewer will ask for are written where the warnings are', () => {
  // Three warnings, all of the "justify this in the PR" kind. The linter cannot check
  // that an explanation exists, so this does: each one is answered in the compose file
  // itself, which is where the PR body's justification is copied from.
  assert.match(officialCompose, /holepunching does not\s*#?\s*survive it/,
    'host networking needs its measured justification beside it')
  assert.match(officialCompose, /11x/,
    'the /dev/dri device mapping needs its justification beside it')
  assert.match(officialCompose, /no-new-privileges/,
    'the security option is the restrictive kind, and should stay that way')
})
