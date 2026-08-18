// The relay policy and the ceiling it forces (proposal 2026-08-18-relay-for-video,
// approved). Pure functions, pinned here because every one of them is a decision Tim made
// on stated arithmetic rather than an implementation detail:
//
//   - a relay is offered only once a punch has failed, never on the way in
//   - the toggle beats everything, so opting out is really opting out
//   - a user's own relay key beats ours
//   - relayed bytes are capped at 2500 kbps whatever the viewer prefers
//   - the cap never RAISES a stricter ceiling the viewer set for themselves

const test = require('node:test')
const assert = require('node:assert/strict')
const b4a = require('b4a')
const z32 = require('z32')

const relay = require('../src/relay')

const OWN_KEY_Z = z32.encode(b4a.alloc(32, 9))

test('no relay on a dial that has not earned one', () => {
  assert.equal(relay.relayThroughFor({ force: false, randomized: false }), null)
})

test('a punch that aborted gets the relay', () => {
  assert.ok(b4a.equals(relay.relayThroughFor({ force: true }), relay.RELAY_PUBLIC_KEY))
})

test('a double-randomized NAT gets it without waiting for a failure', () => {
  // There is nothing to wait for: the DHT already knows a punch cannot work from here.
  assert.ok(b4a.equals(relay.relayThroughFor({ randomized: true }), relay.RELAY_PUBLIC_KEY))
})

test('the toggle wins over every reason to relay', () => {
  // Off means pure peer-to-peer, including the case where that means not connecting at
  // all. A privacy switch that a bad network can override is not a privacy switch.
  assert.equal(relay.relayThroughFor({ force: true, randomized: true, useRelay: false }), null)
  assert.equal(relay.relayThroughFor({ force: true, useRelay: false, ownKeyZ: OWN_KEY_Z }), null)
})

test('your own relay is used instead of ours', () => {
  const key = relay.relayThroughFor({ force: true, ownKeyZ: OWN_KEY_Z })
  assert.ok(b4a.equals(key, z32.decode(OWN_KEY_Z)))
  assert.ok(!b4a.equals(key, relay.RELAY_PUBLIC_KEY), 'someone running their own relay did not do it to keep using ours')
})

test('a mistyped relay key falls back rather than throwing inside a dial', () => {
  for (const bad of ['', '   ', 'not-a-key', z32.encode(b4a.alloc(16, 3)), null, 42]) {
    assert.equal(relay.parseRelayKey(bad), null, `${bad} is not a 32-byte key`)
  }
  // And the policy still connects the person through ours rather than failing shut.
  assert.ok(b4a.equals(relay.relayThroughFor({ force: true, ownKeyZ: 'not-a-key' }), relay.RELAY_PUBLIC_KEY))
})

test('the baked key is a real 32-byte key', () => {
  assert.ok(relay.RELAY_PUBLIC_KEY, 'a build with no relay key cannot reach a hard-NAT library at all')
  assert.equal(relay.RELAY_PUBLIC_KEY.length, 32)
  assert.ok(b4a.equals(z32.decode(relay.RELAY_PUBLIC_KEY_Z), relay.RELAY_PUBLIC_KEY))
})

// --- the ceiling ------------------------------------------------------------

test('2500 kbps, the number the arithmetic was done against', () => {
  // 1.125 GB an hour: about 444 hours a month on the relay's 500 GB tier, about a penny
  // an hour past it. Changing this number changes the bill, so it is pinned.
  assert.equal(relay.RELAY_MAX_KBPS, 2500)
})

test('a direct connection is untouched, object and all', () => {
  const caps = { container: ['mp4'], maxKbps: 0 }
  assert.equal(relay.capsWithRelayCeiling(caps, false), caps, 'the direct path must not even be rebuilt')
})

test('relayed play is capped whether or not the viewer asked for it', () => {
  const capped = relay.capsWithRelayCeiling({ container: ['mp4'] }, true)
  assert.equal(capped.maxKbps, 2500)
  assert.deepEqual(capped.container, ['mp4'], 'and nothing else about the declaration changes')
})

test('a stricter choice by the viewer survives the relay', () => {
  // Data Saver at a lower number is the person asking for less than the relay demands.
  // Taking the min is what stops the relay from RAISING a ceiling someone set themselves.
  assert.equal(relay.capsWithRelayCeiling({ maxKbps: 1200 }, true).maxKbps, 1200)
})

test('a looser choice by the viewer does not survive it', () => {
  assert.equal(relay.capsWithRelayCeiling({ maxKbps: 8000 }, true).maxKbps, 2500)
})

// --- consent ----------------------------------------------------------------

test('a direct connection is never asked about', () => {
  // The prompt is about a relay, so a library reached directly must never produce one -
  // including for someone who once said no to relaying that same library.
  for (const consent of ['ask', 'allow', 'deny', undefined]) {
    assert.equal(relay.relayVideoDecision({ relayed: false, consent }), 'play')
  }
})

test('a relayed film asks once when nothing has been said', () => {
  assert.equal(relay.relayVideoDecision({ relayed: true, consent: 'ask' }), 'ask')
  assert.equal(relay.relayVideoDecision({ relayed: true, consent: undefined }), 'ask', 'never answered means ask')
})

test('an answer is remembered in both directions', () => {
  assert.equal(relay.relayVideoDecision({ relayed: true, consent: 'allow' }), 'play')
  assert.equal(relay.relayVideoDecision({ relayed: true, consent: 'deny' }), 'refuse')
})

test('a no is sticky rather than a question asked again every time', () => {
  // The difference between 'refuse' and 'ask' IS the feature: a standing no that keeps
  // reappearing is not a decision the person made, it is a dialog they cannot escape.
  assert.notEqual(relay.relayVideoDecision({ relayed: true, consent: 'deny' }), 'ask')
  assert.match(relay.RELAY_PLAY_REFUSAL, /Settings/, 'and it has to say where to change it')
})

test('the refusals read as whole sentences a person could have written', () => {
  for (const msg of [relay.RELAY_PLAY_REFUSAL, relay.RELAY_DOWNLOAD_REFUSAL]) {
    assert.match(msg, /^[A-Z].*\.$/)
    assert.doesNotMatch(msg, /HOLEPUNCH|kbps|NAT|DHT|relayThrough/)
  }
})

// --- downloads --------------------------------------------------------------

test('a download over the relay is refused, not quietly degraded', () => {
  // The copy on the phone is what gets watched on a television months later. Capping it
  // would mean a moment spent off wifi follows the film around forever at a quality
  // nobody chose, and that is worse than being told to wait.
  const { action, message } = relay.relayDownloadDecision({ relayed: true })
  assert.equal(action, 'refuse')
  assert.match(message, /wifi/, 'the refusal has to say what to do about it')
})

test('a download on a direct connection is untouched', () => {
  assert.equal(relay.relayDownloadDecision({ relayed: false }).action, 'download')
  assert.equal(relay.relayDownloadDecision({ relayed: false }).message, null)
})

test('the refusal reads as a whole sentence, not a code', () => {
  // The worklet throws this string and the phone shows it verbatim, so it is user-facing
  // copy: a capital letter, a full stop, and no jargon about punches or relays failing.
  assert.match(relay.RELAY_DOWNLOAD_REFUSAL, /^[A-Z].*\.$/)
  assert.doesNotMatch(relay.RELAY_DOWNLOAD_REFUSAL, /HOLEPUNCH|kbps|NAT|DHT/)
})

test('the hour costs what the proposal says it costs', () => {
  // The whole argument for the number, restated as arithmetic so it cannot drift from the
  // table in the proposal: kbps -> GB/hour -> hours on a 500 GB tier.
  const gbPerHour = (relay.RELAY_MAX_KBPS * 3600) / 8 / 1e6
  assert.ok(Math.abs(gbPerHour - 1.125) < 0.001, `${gbPerHour} GB/hour`)
  assert.ok(Math.abs(500 / gbPerHour - 444) < 1, 'about 444 hours a month across all users')
})
