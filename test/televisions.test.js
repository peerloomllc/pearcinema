// The roster of televisions this library has met.
//
// It exists because of one measurement: with the living room television switched off,
// Tim's Roku stick answers no network search and nothing on its control port. It is
// not asleep on the network, it is off it, because the stick is powered by the
// television. Before this store, a device that missed one search was deleted - so a
// working television VANISHED from the phone's picker with nothing said.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { Televisions, clean, FILE, MAX_REMEMBERED, FORGET_AFTER_MS } = require('../host/televisions')

function dir (t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcinema-tv-'))
  t.after(() => fs.rmSync(d, { recursive: true, force: true }))
  return d
}

const ROKU = {
  id: 'roku:X0012345',
  via: 'roku',
  name: 'Living Room',
  model: 'Roku Express',
  serial: 'X0012345',
  udn: 'urn:uuid:abc',
  host: '10.0.0.7',
  channel: '782875'
}

test('a television survives the process that met it', async (t) => {
  const d = dir(t)
  new Televisions({ dataDir: d }).remember(ROKU)

  const again = new Televisions({ dataDir: d })
  const row = again.get(ROKU.id)
  assert.equal(row.name, 'Living Room')
  assert.equal(row.host, '10.0.0.7')
  assert.equal(row.channel, '782875')
  assert.ok(row.firstSeen > 0 && row.lastSeen > 0)

  // Written where the rest of the host's own state lives, and not readable by anyone
  // else on the box.
  const mode = fs.statSync(path.join(d, FILE)).mode & 0o777
  assert.equal(mode, 0o600)
})

test('THE ADDRESS IS A FIELD, NOT THE NAME', async (t) => {
  // A television used to be called `roku:192.168.50.13`. On DHCP that address is a
  // lease, and on Tim's own network a Philips Hue bridge answers the same search a
  // Roku does - so a roster keyed by address can end up pointing at one.
  const tv = new Televisions({ dataDir: dir(t) })
  tv.remember(ROKU)
  tv.remember({ ...ROKU, host: '10.0.0.55', name: 'Living Room' })

  assert.equal(tv.all().length, 1, 'one television that moved, not two televisions')
  assert.equal(tv.get(ROKU.id).host, '10.0.0.55')
})

test('HIDING SURVIVES REDISCOVERY, or it would be a switch that undoes itself', async (t) => {
  const d = dir(t)
  const tv = new Televisions({ dataDir: d })
  tv.remember(ROKU)

  assert.equal(tv.isHidden(ROKU.id), false)
  tv.setHidden(ROKU.id, true)
  assert.equal(tv.isHidden(ROKU.id), true)

  // The television comes back on. Everything about it refreshes EXCEPT the operator's
  // own choice - a rediscovered television must not arrive offered again.
  tv.remember({ ...ROKU, name: 'Living Room TV', host: '10.0.0.9' })
  assert.equal(tv.isHidden(ROKU.id), true)
  assert.equal(tv.get(ROKU.id).name, 'Living Room TV', 'but the rest of it did refresh')

  assert.equal(new Televisions({ dataDir: d }).isHidden(ROKU.id), true, 'and it outlived the process')

  // Hiding something never met is a mistake worth naming, not a row invented on the spot.
  assert.throws(() => tv.setHidden('roku:nobody', true), /never met/)
})

test('the first sighting is kept, so "known since" does not reset every scan', async (t) => {
  const tv = new Televisions({ dataDir: dir(t) })
  const first = tv.remember(ROKU)
  await new Promise(r => setTimeout(r, 5))
  const later = tv.remember(ROKU)
  assert.equal(later.firstSeen, first.firstSeen)
  assert.ok(later.lastSeen >= first.lastSeen)
})

test('a broken or absent file is an empty roster, never a dead host', async (t) => {
  const d = dir(t)
  // Absent: every host before its first scan.
  assert.deepEqual(new Televisions({ dataDir: d }).all(), [])

  // Broken: a roster that cannot be read must not stop a library serving films. The
  // worst case is rediscovering what is on the wire, which costs two and a half seconds.
  fs.writeFileSync(path.join(d, FILE), 'not json at all')
  assert.deepEqual(new Televisions({ dataDir: d }).all(), [])

  // Shaped wrongly, which is the same answer.
  fs.writeFileSync(path.join(d, FILE), JSON.stringify({ devices: 'plenty' }))
  assert.deepEqual(new Televisions({ dataDir: d }).all(), [])

  // A row with no id cannot be addressed, so it is not a row.
  fs.writeFileSync(path.join(d, FILE), JSON.stringify({ devices: [{ name: 'nameless' }, ROKU] }))
  assert.deepEqual(new Televisions({ dataDir: d }).all().map(r => r.id), [ROKU.id])
})

test('values off the network are clamped before they are written', () => {
  // Every field in here came off an XML answer from a device that is not ours.
  const long = 'x'.repeat(5000)
  const row = clean({ id: long, name: long, host: long, via: long, channel: long })
  assert.equal(row.id.length, 128)
  assert.equal(row.name.length, 120)
  assert.equal(row.host.length, 64)
  assert.equal(clean({ id: '   ' }), null, 'a blank id is not an id')
  assert.equal(clean(null), null)

  // The speaker count is the one number in here, and it came off the same answer.
  const ch = (v) => clean({ id: 'tv', accepts: { audioCodecs: ['ac3'], maxAudioChannels: v } }).accepts.maxAudioChannels
  assert.equal(ch(6), 6)
  assert.equal(ch(64), 8, 'nobody has sixty-four speakers')
  assert.equal(ch(1.5), 0)
  assert.equal(ch('lots'), 0)
  assert.equal(ch(-2), 0)
})

test('the roster forgets what nobody has seen for a season, and stays bounded', async (t) => {
  const d = dir(t)
  const old = Date.now() - FORGET_AFTER_MS - 1000
  const rows = [
    { ...ROKU, id: 'roku:gone', name: 'Sold Last Year', lastSeen: old, firstSeen: old },
    { ...ROKU, name: 'Living Room', lastSeen: Date.now(), firstSeen: Date.now() }
  ]
  fs.writeFileSync(path.join(d, FILE), JSON.stringify({ devices: rows }))

  // Dropped on READ, not only when something else happens to cause a write. A
  // television that is gone never causes a write about itself, so a roster pruned only
  // on save would keep a sold television for as long as nothing else changed.
  const tv = new Televisions({ dataDir: d })
  assert.deepEqual(tv.all().map(r => r.name), ['Living Room'])

  // And a misbehaving network cannot grow the file without bound.
  const many = new Televisions({ dataDir: dir(t) })
  for (let i = 0; i < MAX_REMEMBERED + 20; i++) {
    many.remember({ ...ROKU, id: `roku:serial-${i}`, name: `TV ${i}` })
  }
  assert.equal(many.all().length, MAX_REMEMBERED)
})

test('forgetting is not hiding, and both exist for a reason', async (t) => {
  // Hidden means "not offered". Forgotten means "never met", which is what a television
  // sold or given away should become.
  const tv = new Televisions({ dataDir: dir(t) })
  tv.remember(ROKU)
  tv.setHidden(ROKU.id, true)
  assert.equal(tv.all().length, 1, 'a hidden television is still remembered')

  assert.equal(tv.forget(ROKU.id), true)
  assert.equal(tv.get(ROKU.id), null)
  assert.equal(tv.forget(ROKU.id), false, 'and forgetting twice is not an error')
})
