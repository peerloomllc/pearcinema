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

// A target's id says which backend owns it. `roku:<host>` is minted by the discovery
// backend; everything else is Home Assistant's own `media_player.*` vocabulary, which it
// has always been.
function isDiscovered (entityId) {
  return String(entityId || '').startsWith('roku:')
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

  // Only the configured backend has a notion of hiding: it is the operator's pruning of a
  // house full of media players, done in the dashboard. A discovered television is
  // whatever answered, and there is nothing to prune it with yet.
  isHidden (entityId) {
    return isDiscovered(entityId) ? false : !!this.configured?.isHidden?.(entityId)
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
    const confHosts = new Set(
      conf.map((t) => (/([0-9]{1,3}(?:\.[0-9]{1,3}){3})/.exec(String(t.entityId) + ' ' + String(t.name)) || [])[1]).filter(Boolean)
    )
    const fresh = disc.filter((t) => !confHosts.has(String(t.entityId).slice(5)))

    return [...conf, ...fresh]
  }

  getState (entityId) { return this._for(entityId).getState(entityId) }
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

module.exports = { CastTargets, isDiscovered }
