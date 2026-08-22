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

test('the paths CLAUDE.md sends a reader to are really there', () => {
  // A tour of a tree that has moved on is the same failure in a smaller way.
  for (const rel of ['host/methods.js', 'src/merge.js', 'src/ui/App.jsx', 'desktop', 'umbrel', 'plugins', 'host/redeploy-umbrel.sh', 'scripts/ios-sim-build.sh']) {
    assert.ok(claude.includes(rel.split('/').pop()) || claude.includes(rel), `CLAUDE.md should mention ${rel}`)
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is named in CLAUDE.md but is not in the tree`)
  }
})
