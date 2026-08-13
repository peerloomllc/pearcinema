// The PearCinema host.
//
// Runs on the machine that holds the films. Almost everything here is inherited:
// @peerloom/host owns the HyperDHT server, the firewall, pairing, the grant store,
// revoke and the media channel. What is left is what makes this PearCinema rather
// than PearTune - the topics, the source adapter and the method table.
//
// That short list is the point. A fork of the donor's host would have been ~2500
// lines of security-critical code copied into a second place to drift, which is
// the mistake the suite has already diagnosed three times.

const path = require('path')
const fs = require('fs')

const { createProtocol, LibraryHost } = require('@peerloom/host')

const { buildAdapter } = require('./adapters')
const { createMethods, MUTATING } = require('./methods')

// PearCinema's own topics, so the two apps never collide on the DHT and a PearTune
// phone cannot half-connect to a PearCinema host.
//
// NO RELAY KEY, deliberately. PearTune's relay carried 163 MB in six days against
// a 500 GB/month tier; video at 8 Mbps is 3.6 GB per HOUR, so one person watching
// two hours a day is 216 GB/month by themselves. `relayThroughFor` returns null the
// moment the key is null, so this is a config value rather than an architectural
// change - and the honest cost is that a user behind symmetric NAT at both ends has
// no off-LAN path at all. The answer offered is bring-your-own-relay, a settings
// field for a key on their own VPS.
const PROTOCOL = createProtocol({
  app: 'pearcinema',
  displayName: 'PearCinema',
  relayKey: null
})

class PearCinemaHost {
  constructor ({ dataDir, libraryName = 'My Library', dht = null, bootstrap = null, dhtPort = null, log = () => {} } = {}) {
    this.dataDir = path.resolve(dataDir)
    this.log = log

    // A persisted operator rename wins over the env/CLI default, so a name set in
    // the dashboard survives a restart even though the env var is still set.
    this.libraryName = this._readSettings().name || libraryName

    // `sourceFrom` is WHO chose this source: 'dashboard' (saved to disk by an
    // operator), 'env' (the container was started with one) or 'none'. The first-run
    // wizard turns on it, so it must not be conflated with "is there a source" - an
    // Umbrel install ships PEARCINEMA_FOLDERS and still deserves to be walked
    // through pairing.
    this.sourceFrom = 'none'
    this.source = this._readSource()
    this.sourceError = null

    this.host = new LibraryHost({
      protocol: PROTOCOL,
      dataDir: this.dataDir,
      libraryName: this.libraryName,
      dht,
      bootstrap,
      dhtPort,
      log,
      media: () => ({
        methods: createMethods({
          // Getters, not values. A connection outlives a source change and a
          // library rename, and both must reach an already-connected phone.
          getAdapter: () => this.adapter,
          getLibraryName: () => this.libraryName,
          getSourceError: () => this.sourceError,
          grants: this.host.grants
        }),
        mutating: MUTATING,
        // media.stream stays in the package - gating a byte stream on a live grant
        // is the one method where a mistake hands out the library rather than an
        // error message. This only says WHICH bytes.
        //
        // offset and length ride through untouched, which is why seeking inside a
        // two-hour film works with no protocol change and why v1 can be
        // direct-play only.
        openStream: async (params, ctx) => {
          if (!params.itemId) throw ctx.badParams('itemId required')
          return this.openStream(params)
        }
      })
    })

    // AFTER the host, because an adapter needs the libraryId - and the libraryId is
    // derived from the host identity, which does not exist until LibraryHost has
    // opened the seed. Ids are source-scoped AND library-scoped by design, so an
    // adapter built with the wrong one would mint ids nothing else in the system
    // agrees with.
    this.adapter = buildAdapter(this.source, {
      libraryId: this.host.libraryId,
      ids: PROTOCOL.ids,
      dataDir: this.dataDir,
      log
    })
  }

  // THE ONE BYTE PATH, and it has exactly one caller shape.
  //
  // Both clients come through here: the phone over `media.stream` on the P2P
  // channel, and the browser over `GET /api/stream` on the dashboard. Two
  // implementations of "hand me bytes from offset N" is two places for a range
  // arithmetic bug and two places for an id-to-path guard to be forgotten, and the
  // second one is how `media.stream` becomes arbitrary file read. So the web player
  // is a second TRANSPORT, never a second implementation.
  //
  // offset and length ride through untouched, which is why seeking inside a
  // two-hour film needed no protocol change and why direct-play v1 is viable.
  async openStream ({ itemId, offset = 0, length } = {}) {
    return this.adapter.stream({
      itemId: String(itemId),
      offset: Number(offset) || 0,
      length: length ? Number(length) : undefined
    })
  }

  // Change where the films come from, live, without a restart.
  //
  // The adapter is swapped ATOMICALLY and only after the new one has scanned: if the
  // Jellyfin credentials are wrong, this throws and the old source is still serving.
  // A library that goes dark because someone mistyped a password is not an
  // acceptable way to find out you mistyped a password.
  async setSource (cfg) {
    const next = buildAdapter(cfg, {
      libraryId: this.host.libraryId,
      ids: PROTOCOL.ids,
      dataDir: this.dataDir,
      log: this.log
    })
    const leaves = await next.scan() // throws on a bad URL, bad credentials, no folder

    this.adapter = next
    this.source = cfg
    this.sourceFrom = 'dashboard'
    this.sourceError = null
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(path.join(this.dataDir, 'source.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 })

    const stats = await next.stats().catch(() => ({}))
    this.log('host:source-changed', { source: cfg.kind, leaves })
    return { kind: cfg.kind, leaves, ...stats }
  }

  // Does this config actually work? The dashboard's Test button, so an operator
  // finds out before saving rather than after.
  async testSource (cfg) {
    const probe = buildAdapter(cfg, {
      libraryId: this.host.libraryId,
      ids: PROTOCOL.ids,
      dataDir: this.dataDir,
      log: () => {}
    })
    const leaves = await probe.scan()
    return { ok: true, kind: cfg.kind, leaves, ...(await probe.stats().catch(() => ({}))) }
  }

  get protocol () { return PROTOCOL }
  get publicKey () { return this.host.publicKey }
  get libraryId () { return this.host.libraryId }
  get grants () { return this.host.grants }
  get pairing () { return this.host.pairing }
  // The open window itself, not just whether one is open - the dashboard draws its
  // link, its kind and its remaining time.
  get pairSession () { return this.host.pairSession }

  // --- settings -------------------------------------------------------------

  _settingsFile () { return path.join(this.dataDir, 'library.json') }

  _readSettings () {
    try {
      return JSON.parse(fs.readFileSync(this._settingsFile(), 'utf8')) || {}
    } catch {
      return {}
    }
  }

  _writeSettings (patch) {
    const next = { ...this._readSettings(), ...patch }
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.writeFileSync(this._settingsFile(), JSON.stringify(next, null, 2))
    return next
  }

  // A SAVED source wins over the environment, always. The operator's choice in the
  // dashboard has to survive a restart even though the container still sets the env
  // var it was installed with - the same precedence the library name uses.
  //
  // The env var exists for the install where nobody has opened a dashboard yet. On
  // Umbrel that is every fresh install, and without it a brand-new app shows an
  // empty library and looks broken while the files sit right there in the mount.
  //
  // Colon-separated, like PATH, because a real collection is `Movies` on one disk
  // and `TV Shows` on another. Paths with spaces are fine; only `:` separates.
  _sourceFromEnv () {
    const raw = process.env.PEARCINEMA_FOLDERS
    if (!raw) return null
    const roots = raw.split(':').map(s => s.trim()).filter(Boolean)
    if (!roots.length) return null
    // Only the ones that actually exist. A default that lists a mount this box does
    // not have would make every scan throw "not readable" on a library that is
    // otherwise fine.
    const present = roots.filter(r => { try { return fs.statSync(r).isDirectory() } catch { return false } })
    if (!present.length) {
      this.log('source:env-folders-missing', { roots })
      return null
    }
    this.log('source:from-env', { roots: present.length })
    return { kind: 'folder', roots: present }
  }

  _readSource () {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'source.json'), 'utf8'))
      this.sourceFrom = 'dashboard'
      return saved
    } catch {
      const env = this._sourceFromEnv()
      if (env) {
        this.sourceFrom = 'env'
        return env
      }
      return { kind: 'empty' }
    }
  }

  setLibraryName (name) {
    const clean = String(name || '').trim().slice(0, 64)
    if (!clean) throw new Error('a library needs a name')
    this.libraryName = clean
    this.host.libraryName = clean
    this._writeSettings({ name: clean })
    // Every paired phone relabels at once rather than on its next reconnect.
    this.host.presence.notifyAll('library:renamed', { libraryId: this.libraryId, name: clean })
    this.log('host:renamed', { name: clean })
    return clean
  }

  // --- lifecycle ------------------------------------------------------------

  async ready () {
    // A BAD SOURCE MUST NOT STOP THE HOST FROM STARTING. If the saved credentials
    // are wrong or the drive is unplugged, scan() throws - and if that killed the
    // process, the operator would be locked out of the very dashboard they need in
    // order to fix it. Come up, serve, and say what is wrong.
    try {
      const n = await this.adapter.scan()
      this.log('host:scanned', { source: this.adapter.kind, items: n })
    } catch (e) {
      this.sourceError = e.message
      this.log('host:source-failed', { source: this.adapter.kind, err: e.message })
    }

    await this.host.ready()
    return this
  }

  startPairing (opts) { return this.host.startPairing(opts) }
  stopPairing () { return this.host.stopPairing() }
  listDevices () { return this.host.listDevices() }
  revokeDevice (k) { return this.host.revokeDevice(k) }
  leaveDevice (k) { return this.host.leaveDevice(k) }
  revokePerson (p) { return this.host.revokePerson(p) }
  // Cleanup and edits the dashboard offers. Proxied rather than reached for through
  // `.host`, so the web interface talks to PearCinemaHost and never has to know
  // there is a LibraryHost underneath it.
  deleteDevice (k) { return this.host.deleteDevice(k) }
  setDeviceExpiry (k, at) { return this.host.setDeviceExpiry(k, at) }
  deletePerson (p) { return this.host.deletePerson(p) }
  notifyOwnersDevicesChanged () { return this.host.notifyOwnersDevicesChanged() }

  async close () { return this.host.close() }
}

module.exports = { PearCinemaHost, PROTOCOL }
