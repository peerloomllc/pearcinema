// TELEVISIONS THIS LIBRARY HAS MET, remembered between sightings.
//
// Discovery alone is not enough, and the reason is a television being switched off.
// Measured on Tim's own living room stick, 2026-08-19, with the television off: it
// answers no network search and nothing on its control port. It is not asleep on
// the network, it is GONE from it - a Streaming Stick Plus draws its power from the
// television.
//
// Before this file, a device that missed one search was deleted from the roster. So
// the television that worked yesterday did not read as switched off, it VANISHED
// from the phone's picker with no explanation. A Home Assistant television does the
// opposite: it stays listed and reads "unavailable". Same page, two behaviours, and
// the found one was the worse of the two.
//
// Remembering fixes that, and two other things fall out of the same store:
//
//   - HIDING. A person with three Rokus could not stop two of them being offered,
//     because there was nowhere to write the choice. Now there is, and the eye
//     icon means the same thing on every row.
//   - A STABLE IDENTITY. A found Roku used to be called `roku:192.168.50.13` - its
//     address. On DHCP that address moves, and a remembered row would then point at
//     whatever took it (on this very network, a Philips Hue bridge answers the same
//     search a Roku does). A television is remembered by its SERIAL NUMBER, which is
//     what the device itself reports, and the address is a field that gets refreshed.
//
// WHAT IS NOT IN HERE: whether a television is reachable this minute. That is not a
// remembered fact, it is a live one, and it belongs to whichever backend just looked.

const fs = require('fs')
const path = require('path')

const VERSION = 1
const FILE = 'televisions.json'

// A roster is a household's televisions, not a census. The cap exists so that a
// misbehaving network cannot grow the file without bound; it is far above any real
// house and dropping the least recently seen is the right thing to lose.
const MAX_REMEMBERED = 64

// How long a television nobody has seen stays on the list. Long enough to cover a
// holiday and a television that spends a fortnight switched off; short enough that a
// device sold or given away eventually stops being offered. An entry is only ever
// dropped while writing, so a television that comes back within the window simply
// carries on.
const FORGET_AFTER_MS = 90 * 24 * 60 * 60 * 1000

const pathOf = (dataDir) => path.join(dataDir, FILE)

// Only the fields we understand, and each one clamped to something a JSON file
// cannot use to surprise a renderer. This file is written by us and read by us, but
// the values inside it came off a network answer.
// A short list of short lower-case words, or nothing at all.
function cleanAccepts (a) {
  if (!a || typeof a !== 'object') return null
  const list = (v) => (Array.isArray(v)
    ? [...new Set(v.map((x) => String(x || '').toLowerCase().trim()).filter(Boolean).slice(0, 24))].map((x) => x.slice(0, 32))
    : [])
  const containers = list(a.containers)
  const videoCodecs = list(a.videoCodecs)
  const audioCodecs = list(a.audioCodecs)
  // Two to eight, or nothing said. A speaker count off a network answer is the one
  // field here that is a number, so it is clamped as one rather than as a word.
  const ch = Math.floor(Number(a.maxAudioChannels) || 0)
  const maxAudioChannels = ch >= 2 ? Math.min(ch, 8) : 0
  const playlist = !!a.playlist
  if (!containers.length && !videoCodecs.length && !audioCodecs.length && !maxAudioChannels && !playlist) return null
  return { containers, videoCodecs, audioCodecs, maxAudioChannels, playlist }
}

function clean (row) {
  const str = (v, max) => {
    const s = String(v == null ? '' : v).trim()
    return s ? s.slice(0, max) : null
  }
  const id = str(row?.id, 128)
  if (!id) return null
  return {
    id,
    via: str(row?.via, 32) || 'roku',
    name: str(row?.name, 120) || id,
    model: str(row?.model, 120),
    serial: str(row?.serial, 120),
    udn: str(row?.udn, 120),
    // The last address it answered on. Refreshed on every sighting, and never the
    // thing it is remembered BY.
    host: str(row?.host, 64),
    // Whatever the backend needs to reach it again - a Roku's media channel id.
    channel: str(row?.channel, 32),
    // And a DLNA renderer's control URL, which is the same idea and a different shape:
    // an address plus a path, so it moves with the lease and is refreshed on sighting.
    // Kept apart from `channel` rather than sharing it - a channel id is four digits and
    // clamped to thirty-two characters, which would have quietly cut a URL in half.
    control: str(row?.control, 256),
    // WHAT THE TELEVISION ITSELF SAID IT ACCEPTS (host/dlna.js sinkProfile). Remembered
    // because a set that is switched off cannot be asked, and a household should not
    // lose the answer it gave yesterday - the alternative is casting to it with the
    // conservative profile, which converts films it would have played untouched.
    // Clamped like everything else here: these lists came off a network answer.
    accepts: cleanAccepts(row?.accepts),
    hidden: !!row?.hidden,
    firstSeen: Number(row?.firstSeen) || Date.now(),
    lastSeen: Number(row?.lastSeen) || Date.now()
  }
}

class Televisions {
  constructor ({ dataDir, log = () => {} } = {}) {
    this.dataDir = dataDir
    this.log = log
    this.rows = this._read()
  }

  _read () {
    // Absent file = nothing met yet, which is every host before its first scan.
    // Never throw on a malformed one: a broken roster must not stop a library from
    // serving films, and the worst case is rediscovering what is on the wire.
    try {
      const raw = JSON.parse(fs.readFileSync(pathOf(this.dataDir), 'utf8'))
      const list = Array.isArray(raw?.devices) ? raw.devices : []
      // FORGETTING HAPPENS ON READ as well as on write, and it has to. A television
      // that is gone never causes a write about itself, so a roster pruned only when
      // saving would keep a sold television for as long as nothing else changed.
      const cutoff = Date.now() - FORGET_AFTER_MS
      const out = new Map()
      for (const row of list) {
        const c = clean(row)
        if (c && c.lastSeen >= cutoff) out.set(c.id, c)
      }
      return out
    } catch {
      return new Map()
    }
  }

  _write () {
    const cutoff = Date.now() - FORGET_AFTER_MS
    let devices = [...this.rows.values()]
      .filter(r => r.lastSeen >= cutoff)
      .sort((a, b) => b.lastSeen - a.lastSeen)
    if (devices.length > MAX_REMEMBERED) devices = devices.slice(0, MAX_REMEMBERED)
    this.rows = new Map(devices.map(r => [r.id, r]))

    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(pathOf(this.dataDir), JSON.stringify({ version: VERSION, devices }, null, 2), { mode: 0o600 })
    } catch (e) {
      // A roster that cannot be saved is a roster that is rediscovered next time,
      // which is a slower host and not a broken one.
      this.log('televisions:save-failed', { err: e.message })
    }
  }

  all () {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get (id) {
    return this.rows.get(String(id)) || null
  }

  // A television answered. Everything about it is refreshed EXCEPT the operator's
  // own choice to hide it - a device that comes back must not come back offered.
  remember (device) {
    const next = clean({ ...device, lastSeen: Date.now() })
    if (!next) return null
    const prev = this.rows.get(next.id)
    if (prev) {
      next.firstSeen = prev.firstSeen
      next.hidden = prev.hidden
    }
    const changed = !prev || JSON.stringify({ ...prev, lastSeen: 0 }) !== JSON.stringify({ ...next, lastSeen: 0 })
    this.rows.set(next.id, next)
    // Written on a real change, and otherwise only every so often: a sighting every
    // thirty seconds must not be a disk write every thirty seconds.
    if (changed || Date.now() - (prev.lastSeen || 0) > 3600_000) this._write()
    if (changed) this.log('televisions:remembered', { id: next.id, name: next.name, host: next.host })
    return next
  }

  isHidden (id) {
    return !!this.rows.get(String(id))?.hidden
  }

  setHidden (id, hidden) {
    const row = this.rows.get(String(id))
    if (!row) throw new Error('This library has never met that television.')
    row.hidden = !!hidden
    this._write()
    this.log('televisions:hidden', { id: row.id, hidden: row.hidden })
    return row
  }

  // Deliberate forgetting, for a television sold, given away or replaced. Distinct
  // from hiding: hidden means "not offered", forgotten means "never met".
  forget (id) {
    const had = this.rows.delete(String(id))
    if (had) this._write()
    return had
  }
}

module.exports = { Televisions, clean, VERSION, FILE, MAX_REMEMBERED, FORGET_AFTER_MS }
