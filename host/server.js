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

    this.source = this._readSource()
    this.adapter = buildAdapter(this.source, { log })
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
          return this.adapter.stream({
            itemId: String(params.itemId),
            offset: Number(params.offset) || 0,
            length: params.length ? Number(params.length) : undefined
          })
        }
      })
    })
  }

  get protocol () { return PROTOCOL }
  get publicKey () { return this.host.publicKey }
  get libraryId () { return this.host.libraryId }
  get grants () { return this.host.grants }
  get pairing () { return this.host.pairing }

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

  _readSource () {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'source.json'), 'utf8'))
    } catch {
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

  async close () { return this.host.close() }
}

module.exports = { PearCinemaHost, PROTOCOL }
