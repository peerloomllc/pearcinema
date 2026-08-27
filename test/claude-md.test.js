// THE FIRST FILE EVERY SESSION READS, guarded against the two ways it has actually
// been wrong.
//
// On 2026-08-22 CLAUDE.md still opened with "STATUS: DESIGN STAGE. NO APP CODE YET"
// and told a reader that two proposals gated the repo and to say so rather than start
// building - against a tree with a shipping phone app, four running hosts and 870
// tests. It also still said "No relay, by design" three days after the relay shipped
// with a key baked in. A stale instruction file is worse than no instruction file: it
// is read as authority.
//
// These are drift guards, not prose review. Each one pairs a sentence in the document
// with the code that would make it a lie, so the pair cannot separate silently.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')

test('CLAUDE.md does not claim the repo has no app code, when it has', () => {
  // The app is right there. Both halves of it.
  assert.ok(fs.existsSync(path.join(root, 'src', 'bare.js')), 'the worklet')
  assert.ok(fs.existsSync(path.join(root, 'host', 'server.js')), 'the host')

  assert.doesNotMatch(claude, /NO APP CODE YET/i)
  assert.doesNotMatch(claude, /DESIGN STAGE/i)
})

test('CLAUDE.md does not say "no relay" while a relay key ships', () => {
  const relay = fs.readFileSync(path.join(root, 'src', 'relay.js'), 'utf8')
  const key = relay.match(/RELAY_PUBLIC_KEY_Z\s*=\s*'([^']*)'/)
  assert.ok(key, 'src/relay.js no longer declares RELAY_PUBLIC_KEY_Z - this guard needs rewriting')

  // If the key is ever emptied the old sentence becomes true again, and this guard
  // has to let it back in rather than pinning yesterday's answer.
  if (key[1].length > 0) {
    assert.doesNotMatch(claude, /^## No relay, by design/m)
    assert.match(claude, /relay/i, 'a shipped relay has to be described somewhere in here')
  }
})

test('NOTHING A USER READS SAYS THERE IS NO RELAY, while a relay key ships', () => {
  // The same drift, one surface further out, and worse there: CLAUDE.md misleads a
  // session, but these tell a PERSON where their films go.
  //
  // Both of these were wrong on 2026-08-26, eight days after the relay shipped - the
  // About screen said "PearCinema ships with no relay at all" while the Settings screen
  // three taps away offered a switch for one, and the README said the same in a
  // paragraph of arithmetic. Found by looking, not by any test, which is why this
  // exists.
  const relay = fs.readFileSync(path.join(root, 'src', 'relay.js'), 'utf8')
  const key = relay.match(/RELAY_PUBLIC_KEY_Z\s*=\s*'([^']*)'/)
  if (!key || !key[1].length) return // no key shipped: the old sentence is true again

  const surfaces = [
    ['README.md', fs.readFileSync(path.join(root, 'README.md'), 'utf8')],
    ['the app\'s About screen', fs.readFileSync(path.join(root, 'src', 'ui', 'App.jsx'), 'utf8')],
    ['the iOS listing', fs.readFileSync(path.join(root, 'metadata', 'ios', 'version', 'default', 'en-US.json'), 'utf8')],
    ['the Play listing', fs.readFileSync(path.join(root, 'metadata', 'android', 'listing', 'en-US.json'), 'utf8')]
  ]
  // Matched loosely on purpose: "no relay of its own", "ships with no relay at all" and
  // "without a relay" are all the same promise, and the next way to write it should trip
  // this too. A comment explaining the OLD decision is caught as well, which is correct -
  // there is no reason to still be asserting it anywhere.
  for (const [what, text] of surfaces) {
    const claim = text.match(/[^.\n]{0,120}\bno relay\b[^.\n]{0,120}/i)
    assert.equal(claim, null, `${what} still says there is no relay: "${claim && claim[0].trim()}"`)
  }
})

test('the paths CLAUDE.md sends a reader to are really there', () => {
  // A tour of a tree that has moved on is the same failure in a smaller way.
  for (const rel of ['host/methods.js', 'src/merge.js', 'src/ui/App.jsx', 'desktop', 'umbrel', 'plugins', 'host/redeploy-umbrel.sh', 'scripts/ios-sim-build.sh']) {
    assert.ok(claude.includes(rel.split('/').pop()) || claude.includes(rel), `CLAUDE.md should mention ${rel}`)
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is named in CLAUDE.md but is not in the tree`)
  }
})
