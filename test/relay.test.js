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

// --- the meter and the nudge ------------------------------------------------

const JUL = new Date(2026, 6, 15)
const AUG = new Date(2026, 7, 2)

test('a connection is relayed until its stream points somewhere else', () => {
  // hyperdht points the SAME udx stream at the relay, then repoints it at the peer if a
  // punch lands late. The address is therefore the only honest answer to "are we still
  // relayed", and getting this backwards is what made the first meter read 867 MB for a
  // minute of video.
  assert.equal(relay.relayStillOn('1.2.3.4:5000', '1.2.3.4:5000'), true)
  assert.equal(relay.relayStillOn('1.2.3.4:5000', '9.9.9.9:41000'), false, 'a moved stream is a direct one')
  assert.equal(relay.relayStillOn('1.2.3.4:5000', '1.2.3.4:5001'), false, 'the port counts too')
})

test('nothing to compare yet is treated as still relayed', () => {
  // Erring towards relayed keeps the ceiling on and the marker up while the answer is
  // unknown. The other way round would quietly lift a cap somebody else is paying for.
  assert.equal(relay.relayStillOn(null, '1.2.3.4:5000'), true)
  assert.equal(relay.relayStillOn('1.2.3.4:5000', null), true)
})

test('a total written by an older counter does not survive', () => {
  // Version 1 kept counting after a connection went direct. A figure wrong by an order of
  // magnitude is worse than no figure, so it is discarded rather than migrated.
  const stale = { month: relay.monthKey(JUL), bytes: 867e6, byLibrary: { a: 867e6 } }
  const fresh = relay.addUsage(stale, { bytes: 1e6, libraryId: 'a', now: JUL })
  assert.equal(fresh.bytes, 1e6, 'the old total must not be carried forward')
  assert.equal(fresh.v, relay.USAGE_VERSION)
  assert.equal(relay.usageWarning(stale, { now: JUL }), null, 'and it can never trigger the nudge')
})

test('bytes accumulate within a month, per library and in total', () => {
  let u = relay.addUsage(null, { bytes: 1e9, libraryId: 'lib-a', now: JUL })
  u = relay.addUsage(u, { bytes: 5e8, libraryId: 'lib-b', now: JUL })
  u = relay.addUsage(u, { bytes: 5e8, libraryId: 'lib-a', now: JUL })
  assert.equal(u.bytes, 2e9)
  assert.deepEqual(u.byLibrary, { 'lib-a': 1.5e9, 'lib-b': 5e8 })
  assert.equal(u.month, '2026-07')
})

test('a new month starts from nothing rather than carrying the old one', () => {
  const july = relay.addUsage(null, { bytes: 40e9, libraryId: 'lib-a', now: JUL })
  const august = relay.addUsage(july, { bytes: 1e9, libraryId: 'lib-a', now: AUG })
  assert.equal(august.month, '2026-08')
  assert.equal(august.bytes, 1e9, 'July must not follow the person into August')
  assert.deepEqual(august.byLibrary, { 'lib-a': 1e9 })
})

test('a negative sample is dropped, not subtracted', () => {
  // The counter it comes from lives on a UDX stream, so a reconnect starts a fresh one
  // at zero. Subtracting that would silently erase a month of real usage.
  const u = relay.addUsage({ v: relay.USAGE_VERSION, month: relay.monthKey(JUL), bytes: 3e9, byLibrary: {} }, { bytes: -2e9, now: JUL })
  assert.equal(u.bytes, 3e9)
})

test('no nudge below the threshold, and none at all for a stale month', () => {
  assert.equal(relay.usageWarning({ v: relay.USAGE_VERSION, month: relay.monthKey(JUL), bytes: 1e9 }, { now: JUL }), null)
  assert.equal(relay.usageWarning({ v: relay.USAGE_VERSION, month: '2025-01', bytes: 999e9 }, { now: JUL }), null, 'last year is not this month')
  assert.equal(relay.usageWarning(null, { now: JUL }), null)
})

test('the nudge arrives past the threshold, and reads as a suggestion', () => {
  const w = relay.usageWarning({ v: relay.USAGE_VERSION, month: relay.monthKey(JUL), bytes: relay.RELAY_WARN_BYTES + 1e9 }, { now: JUL })
  assert.ok(w, 'a heavy month has to say something')
  assert.equal(w.gb, 21)
  assert.match(w.message, /wifi/, 'it suggests what to do instead')
  assert.doesNotMatch(w.message, /stop|blocked|cut off|limit/i, 'and it never threatens to stop anything')
})

test('the threshold is a share of the tier, not a number pulled out of the air', () => {
  // 20 GB is about 18 hours of relayed video and about 4% of the 500 GB tier: heavy for
  // one household, and nothing a normal month of watching would reach.
  assert.equal(relay.RELAY_WARN_BYTES, 20e9)
  const hours = relay.RELAY_WARN_BYTES / ((relay.RELAY_MAX_KBPS * 3600) / 8 / 1e6 * 1e9)
  assert.ok(hours > 15 && hours < 20, `${hours} hours of relayed video before a word is said`)
  assert.ok(relay.RELAY_WARN_BYTES < 500e9 * 0.05, 'and well under a tenth of the shared tier')
})

test('the month key follows the phone rather than UTC', () => {
  // People read "this month" off their own calendar. A UTC month would roll over at a
  // strange hour of the evening for anyone west of London.
  assert.equal(relay.monthKey(new Date(2026, 0, 31, 23, 30)), '2026-01')
  assert.equal(relay.monthKey(new Date(2026, 11, 1, 0, 5)), '2026-12')
})

test('the hour costs what the proposal says it costs', () => {
  // The whole argument for the number, restated as arithmetic so it cannot drift from the
  // table in the proposal: kbps -> GB/hour -> hours on a 500 GB tier.
  const gbPerHour = (relay.RELAY_MAX_KBPS * 3600) / 8 / 1e6
  assert.ok(Math.abs(gbPerHour - 1.125) < 0.001, `${gbPerHour} GB/hour`)
  assert.ok(Math.abs(500 / gbPerHour - 444) < 1, 'about 444 hours a month across all users')
})
