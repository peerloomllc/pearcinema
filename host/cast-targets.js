// Two ways to find a television, behind the one interface the cast path already speaks.
//
// `host/speakers.js` (Home Assistant) and `host/roku.js` (found on the network) answer the
// same six things - enabled, list, getState, play, stop, isHidden - so this routes rather
// than translates. Nothing downstream learns there is more than one: host/cast.js still
// mints the URL, serves the film, polls the position and stops the device on revoke.
//
// WHY A ROUTER AND NOT A MERGE INSIDE SPEAKERS. Home Assistant is configuration - a URL, a
// token, an operator who set it up. Discovery is the opposite: it is whatever is on the
// wire this minute. Keeping them apart means an HA outage cannot take the found
// televisions with it, and a network with no multicast cannot break a configured one.

// EVERY METHOD A CALLER USES HAS TO BE HERE. Missing one does not fail loudly at startup;
// it fails as `casts.speakers.pause is not a function` the moment somebody presses pause
// on a real cast, which is exactly how it was found - on Tim's television, minutes after
// this shipped. The list is: enabled, isHidden, list, getState, play, pause, resume, stop,
// seek. `test/roku.test.js` pins it against the Home Assistant backend's own surface, so
// adding a method there and forgetting it here is a failing test rather than a broken
// remote control.

// A target's id says which backend owns it. `roku:<host>` is minted by the discovery
// backend; everything else is Home Assistant's own `media_player.*` vocabulary, which it
// has always been.
function isDiscovered (entityId) {
  return String(entityId || '').startsWith('roku:')
}

// Names as a person typed them, compared as a machine should: case and punctuation carry
// no meaning here, and "Roku Streaming Stick Plus" must match "roku streaming stick plus".
function normalName (name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

class CastTargets {
  constructor ({ configured, discovered, log = () => {} }) {
    this.configured = configured // Speakers (Home Assistant)
    this.discovered = discovered // RokuSpeakers
    this.log = log
  }

  // Casting is available if EITHER can reach something. Kept as "can we look" rather than
  // "did we find" on purpose: the phone's own gate is the length of the target list, and
  // answering false here would stop the search that produces it.
  get enabled () {
    return !!(this.configured?.enabled || this.discovered?.enabled)
  }

  // Hiding is the operator's pruning of a house full of media players, and since
  // 2026-08-19 it means the same thing on BOTH kinds of row. It could not before: a
  // found television was whatever answered this minute, so there was nowhere to write
  // the choice down. host/televisions.js is that somewhere, and a person with three
  // Rokus can now stop two of them being offered.
  isHidden (entityId) {
    return isDiscovered(entityId)
      ? !!this.discovered?.isHidden?.(entityId)
      : !!this.configured?.isHidden?.(entityId)
  }

  // One switch, either backend. The dashboard sends an entity and a boolean and does
  // not have to know which store the answer lands in.
  setHidden (entityId, hidden) {
    const backend = isDiscovered(entityId) ? this.discovered : this.configured
    if (!backend?.setHidden) throw new Error('that television cannot be hidden')
    return backend.setHidden(entityId, hidden)
  }

  _for (entityId) {
    const backend = isDiscovered(entityId) ? this.discovered : this.configured
    if (!backend) throw new Error('no way to reach that television')
    return backend
  }

  // Both rosters, and NEITHER failure is allowed to lose the other. An HA that is down or
  // a network that drops multicast each cost their own half and nothing more - a person
  // with one working television should see it.
  async list () {
    const [conf, disc] = await Promise.all([
      this.configured?.enabled ? this.configured.list().catch((e) => { this.log('cast:ha-list-failed', { err: e.message }); return [] }) : [],
      this.discovered?.enabled ? this.discovered.list().catch((e) => { this.log('cast:discovery-failed', { err: e.message }); return [] }) : []
    ])

    // A television configured in Home Assistant AND found on the wire is ONE television.
    // The configured entry wins, because it is the one the operator can hide, rename and
    // reach through an integration that knows more about it than a multicast answer does.
    //
    // MATCHED BY NAME AS WELL AS ADDRESS, and the name is the one that actually fires.
    // Measured against Tim's own Home Assistant, 2026-08-18: his Roku is
    // `media_player.living_room_roku_streaming_stick_plus`, named "Roku Streaming Stick
    // Plus" - no IP anywhere in either, so an address-only test left the same television
    // in the picker twice. Both are kept because HA installs vary: some integrations do
    // name a device by address, and that case cost nothing to keep covering.
    const ips = new Set()
    const names = new Set()
    for (const t of conf) {
      const ip = (/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(String(t.entityId) + ' ' + String(t.name)) || [])[1]
      if (ip) ips.add(ip)
      const n = normalName(t.name)
      if (n) names.add(n)
    }
    // THE ADDRESS COMES OFF THE ROW NOW, not off the id. A found television used to be
    // called `roku:<address>` and this line read the address back out of its own name;
    // televisions are remembered by serial number since 2026-08-19, so the address is a
    // field that travels beside it and moves when the lease does.
    const fresh = disc.filter((t) => !(t.host && ips.has(t.host)) && !names.has(normalName(t.name)))

    return [...conf, ...fresh]
  }

  getState (entityId) { return this._for(entityId).getState(entityId) }
  pause (entityId) { return this._for(entityId).pause(entityId) }
  resume (entityId) { return this._for(entityId).resume(entityId) }
  // Only ever reached behind canSeek(supportedFeatures), which a discovered Roku answers
  // 0 to - it cannot seek over ECP any more than it can through Home Assistant, and the
  // cast path already restarts the film at the offset instead.
  seek (entityId, seconds) {
    const backend = this._for(entityId)
    if (typeof backend.seek !== 'function') throw new Error('that television cannot seek')
    return backend.seek(entityId, seconds)
  }
  play (entityId, url, opts) { return this._for(entityId).play(entityId, url, opts) }
  stop (entityId) { return this._for(entityId).stop(entityId) }
}

module.exports = { CastTargets, isDiscovered, normalName }
