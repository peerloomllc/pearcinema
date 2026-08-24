// The Umbrel listing vs umbreld, which is stricter than docker is.
//
// Nothing here is about whether the compose is valid YAML or whether docker would run
// it. It is about the two ways a listing that runs perfectly well by hand still breaks
// when umbrelOS is the one installing it, both of them learned on a real box:
//
//   1. umbreld PATCHES an app's compose on install AND on update, and its patcher calls
//      .replace() on every volume entry - so a long-form (object) volume crashes both
//      with "volume?.replace is not a function". PearTune's store listing 1.0.4 wedged
//      mid-update at 1% that way, container already removed, app stuck in "updating"
//      for good (peartune DONE 2026-08-17). PearCinema carried the same long-form mount
//      until 2026-08-24 and has never been installed from the store, so it would have
//      been the FIRST install that hit it.
//   2. `defaultPassword: $APP_PASSWORD` is not a token umbrelOS substitutes. The compose
//      DOES get the real value so the app works, and the UI prints the literal string
//      "$APP_PASSWORD" so nobody can log in (found on a real PearTune store install,
//      2026-07-31). `deterministicPassword: true` is the only supported way.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, '..', 'umbrel')
const compose = () => fs.readFileSync(path.join(DIR, 'docker-compose.yml'), 'utf8')
const listing = () => fs.readFileSync(path.join(DIR, 'umbrel-app.yml'), 'utf8')

test('EVERY VOLUME IS SHORT-SYNTAX, because umbreld\'s patcher crashes on the long form', () => {
  const text = compose()
  for (const key of ['type: bind', 'source:', 'target:', 'propagation:']) {
    assert.ok(!text.includes(key), `long-form volume key "${key}" found - umbreld's patcher crashes on object volumes`)
  }
})

test('THE EXTERNAL DRIVE IS MOUNTED rslave, or a drive plugged in later is invisible', () => {
  // The mount happens in the host's namespace and never propagates without it, and the
  // failure looks exactly like an empty library. An external drive is the NORMAL case
  // for video rather than an unusual one, which is why this is pinned rather than trusted.
  assert.match(compose(), /- \$\{UMBREL_ROOT\}\/external:\/external:rslave$/m)
})

test('the library mounts are writable, because saving metadata beside a film needs it', () => {
  // Read-only was right until sidecar writing shipped (Tim's call, 2026-08-15). Only the
  // dashboard's explicit save action writes, and it only ever creates new files.
  const text = compose()
  assert.ok(!/\/external:ro\b|:\/external:ro,/.test(text), 'the external drive must not be read-only')
  assert.match(text, /- \$\{UMBREL_ROOT\}\/home\/Downloads:\/library$/m, 'and neither is the internal one')
})

test('THE PASSWORD COMES FROM deterministicPassword, not from a token nobody substitutes', () => {
  const text = listing()
  assert.match(text, /^deterministicPassword: true$/m)
  // Anchored at column 0 on purpose: the file EXPLAINS the mistake in a comment, and a
  // test that cannot tell a warning from the thing it warns about is worse than none.
  assert.ok(!/^defaultPassword:/m.test(text), 'that prints the literal string in the UI')
  // And the compose is where the real value arrives.
  assert.match(compose(), /PEARCINEMA_PASSWORD: \$\{APP_PASSWORD\}/)
})

test('NO app_proxy, because a bridged proxy cannot front a host-networked service', () => {
  // Measured on a real Umbrel, twice: under Docker's default bridge the firewall admits
  // the phone and the connection dies before the pair channel opens. Bridge NAT is a
  // second layer of NAT and holepunching does not survive it.
  const text = compose()
  assert.ok(!text.includes('app_proxy:'), 'app_proxy would break pairing')
  assert.match(text, /network_mode: host/)
})

test('the store directory name has to equal the listing id, or umbrelOS ignores the entry', () => {
  const id = /^id:\s*(\S+)$/m.exec(listing())
  assert.ok(id, 'the listing has an id')
  assert.equal(id[1], 'peerloom-pearcinema')
})

test('THE PORT IS THE SUITE\'S, not the next number along', () => {
  // 8731 PearCircle seeder, 8741 PearTune dashboard, 8742 PearTune CAST, 8751 this,
  // 8752 reserved for PearCinema's cast. It was 8742 until 2026-08-13 on the reasoning
  // that "PearTune has 8741" - PearTune binds BOTH, and the collision was invisible
  // until the image ran on a real Umbrel next to a real PearTune: EADDRINUSE after a
  // full library scan.
  assert.match(listing(), /^port: 8751$/m)
  assert.match(compose(), /PEARCINEMA_HTTP_PORT: "8751"/)
})

test('A RELEASE IS PINNED BY DIGEST, and until it is, the sync script refuses', () => {
  // The digest IS the rollback plan: reverting a bad release is re-pinning the previous
  // one. This test does not demand the pin - the working tree is allowed to carry an
  // unreleased tag - it demands that the thing which publishes the listing checks.
  const sync = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sync-umbrel-store.sh'), 'utf8')
  assert.match(sync, /@sha256:/, 'the sync script tests for a digest')
  assert.match(sync, /not pinned by digest/, 'and says so rather than syncing it')
})
