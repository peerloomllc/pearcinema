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
const remux = require('./remux')
const transcode = require('./transcode')
const tmdb = require('./tmdb')

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
    // Non-null while a scan is running, so the page can say "reading your library,
    // 1,500 of 2,986" instead of showing an empty grid that looks like a bug.
    this.scanning = null

    // The repackaging engine. Concurrency-capped, because remux is I/O bound rather
    // than CPU bound but three films at once on a Pi-class box is still three films
    // at once, and an unbounded count of child processes is how a host stops being a
    // host. Nothing is written to disk - see host/remux.js.
    this.remuxer = new remux.Remuxer({
      ffmpeg: process.env.PEARCINEMA_FFMPEG || 'ffmpeg',
      maxConcurrent: Number(process.env.PEARCINEMA_MAX_REMUX) || 3,
      log
    })

    // The re-encoding engine, and ITS OWN CAP: remux exhausts disk I/O where this
    // exhausts the video engine, and one pool for both would let three cheap remuxes
    // block the transcode a viewer actually needs, or the reverse. Default 4 against
    // a measured ceiling of ~10 concurrent 1080p streams on the N100 (DECISIONS
    // 2026-08-13), leaving headroom for whatever else shares /dev/dri.
    //
    // WHETHER IT MAY RUN AT ALL is `this.transcode`, and it starts closed: only the
    // startup probe in ready() opens it, and only when the hardware produced real
    // bytes. There is no software fallback anywhere - see the proposal's rule 3.
    this.transcoder = new transcode.Transcoder({
      ffmpeg: process.env.PEARCINEMA_FFMPEG || 'ffmpeg',
      maxConcurrent: Number(process.env.PEARCINEMA_MAX_TRANSCODE) || 4,
      device: process.env.PEARCINEMA_VAAPI_DEVICE || transcode.DEVICE_DEFAULT,
      log
    })
    this.transcode = { available: false, reason: 'the hardware has not been probed yet' }

    this.host = new LibraryHost({
      protocol: PROTOCOL,
      dataDir: this.dataDir,
      libraryName: this.libraryName,
      // THE VOCABULARY IS THE APP'S. The store is inherited from a music host, where
      // a favourite is of a track, an album or an artist; here it is of a film, an
      // episode, a show or a season. `itemId` rather than `trackId` for the same
      // reason - and the keys are unaffected either way, because they carry the id
      // and not its name.
      state: {
        kinds: ['movie', 'episode', 'series', 'season'],
        requestKinds: ['movie', 'series'],
        idField: 'itemId'
      },
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
          grants: this.host.grants,
          // The per-person store, built by the package on its own Hyperbee. Safe to
          // read here for the same reason `grants` is: `media` is a FUNCTION the
          // package calls once the host exists, not an object built alongside it.
          state: this.host.userState
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
    // The opt-in TMDB artwork store. Holds nothing until the operator saves a key
    // and turns it on; its cache lives in the data dir and is disposable.
    this.enricher = new tmdb.Enricher({ dataDir: this.dataDir, log })

    this._inner = buildAdapter(this.source, {
      libraryId: this.host.libraryId,
      ids: PROTOCOL.ids,
      dataDir: this.dataDir,
      log
    })
    this.adapter = this._decorated(this._inner)
  }

  // THE ADAPTER BOTH TRANSPORTS SEE, with online artwork laid over the gaps. A
  // Proxy rather than edits at every call site, so the browser routes and the
  // phone's method table cannot disagree about which films have posters - the same
  // one-implementation rule the byte path follows.
  //
  // Only four calls change: items out of list/get/search get a tmdb: artId WHERE
  // THEY HAVE NONE (sidecar always wins, enforced in decorate), and art() answers
  // tmdb: ids from the cache. Everything else passes through untouched.
  _decorated (inner) {
    const en = this.enricher
    return new Proxy(inner, {
      get (t, p) {
        if (p === 'list') {
          return async (params) => {
            const page = await t.list(params)
            return { ...page, items: (page.items || []).map(i => en.decorate(i)) }
          }
        }
        if (p === 'get') return async (params) => en.decorate(await t.get(params))
        if (p === 'search') {
          return async (params) => {
            const out = await t.search(params)
            return { ...out, items: (out.items || []).map(i => en.decorate(i)) }
          }
        }
        if (p === 'art') {
          return async ({ artId, ...rest } = {}) => {
            if (String(artId || '').startsWith('tmdb:')) return en.art(artId)
            return t.art({ artId, ...rest })
          }
        }
        const v = t[p]
        return typeof v === 'function' ? v.bind(t) : v
      }
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

  // REPACKAGE a film into something this client will open, starting at `at` seconds.
  //
  // Rung one of proposals/2026-08-13-remux.md: the container changes, the picture
  // never does. It sits beside openStream rather than inside it because the two
  // answer different questions - openStream says "which bytes of the file", this says
  // "make me some bytes" - and folding a process spawn into the byte path would put a
  // child process behind the one method where a mistake hands out the library.
  //
  // THE HOST DECIDES. `capabilities` is what the client says it can open; direct play
  // always wins where it works, because it is free and it is the actual file.
  async openRemux ({ itemId, at = 0, capabilities = {} } = {}) {
    const item = await this.adapter.get({ id: String(itemId) })
    if (!item) return null

    // The transcode flag is rule 2's gate reaching the decision: false until the
    // startup probe produced real bytes, and decide() refuses video exactly as it
    // always did while it is.
    const verdict = remux.decide(item.media, capabilities, { transcode: this.transcode.available })
    if (verdict.mode !== 'remux' && verdict.mode !== 'transcode') {
      return { ...verdict, session: null, item }
    }

    if (!this.adapter.ffmpegInput) {
      return { mode: 'refuse', reason: 'this source cannot be repackaged', session: null, item }
    }
    const source = await this.adapter.ffmpegInput({ itemId: String(itemId) })
    if (!source) return null

    // Same session shape, different engine and different cap: remux is the disk's
    // pool, transcode is the video engine's.
    const engine = verdict.mode === 'transcode' ? this.transcoder : this.remuxer
    const session = engine.start({
      input: source.input,
      headers: source.headers || null,
      at: Math.max(0, Number(at) || 0),
      audio: verdict.audio || 'copy',
      media: item.media || null
    })

    this.log('host:' + verdict.mode, { at, audio: verdict.audio, running: engine.running })
    return { ...verdict, session, item }
  }

  // Change where the films come from, live, without a restart.
  //
  // The adapter is swapped ATOMICALLY and only after the new one has scanned: if the
  // Jellyfin credentials are wrong, this throws and the old source is still serving.
  // A library that goes dark because someone mistyped a password is not an
  // acceptable way to find out you mistyped a password.
  // `force` walks the disk again instead of trusting the scan cache. It has to be a
  // parameter rather than a decision made inside the adapter, because the operator
  // is the only one who knows they just added a film - or that they are running a
  // build that reads something off the disk the last scan did not.
  async setSource (cfg, { force = false } = {}) {
    const next = buildAdapter(cfg, {
      libraryId: this.host.libraryId,
      ids: PROTOCOL.ids,
      dataDir: this.dataDir,
      log: this.log
    })
    const leaves = await next.scan({ force }) // throws on a bad URL, bad credentials, no folder

    this._inner = next
    this.adapter = this._decorated(next)
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
  // The per-person store, on its own Hyperbee inside the package. The dashboard
  // reaches it through here for the same reason the method table does: one store, so
  // a browser and a phone can never disagree about where somebody got to.
  get userState () { return this.host.userState }
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

  // --- online metadata, opt in ----------------------------------------------
  //
  // The key lives in the settings file in the data dir, which already holds the
  // host identity seed - anybody who can read one can read the other, so this adds
  // no new place a secret lives. It is never sent to a client; the dashboard is
  // told only THAT a key is saved.

  metadataSettings () {
    const t = this._readSettings().tmdb || {}
    return { enabled: !!t.enabled, hasKey: !!t.key }
  }

  _metadataKey () { return (this._readSettings().tmdb || {}).key || null }

  async testMetadataKey (key) {
    return new tmdb.TmdbClient({ key }).test()
  }

  // Saving a key means it was just TESTED by the route - a key that silently fails
  // is worse than none, because the library simply looks wrong.
  saveMetadata ({ key, enabled } = {}) {
    const cur = this._readSettings().tmdb || {}
    const next = {
      key: key !== undefined ? String(key || '').trim() || undefined : cur.key,
      enabled: enabled !== undefined ? !!enabled : !!cur.enabled
    }
    this._writeSettings({ tmdb: next })
    this.log('host:metadata', { enabled: next.enabled, hasKey: !!next.key })
    return this.metadataSettings()
  }

  // The pass, over the INNER adapter - "has artwork" must mean artwork on disk,
  // not artwork the last pass invented.
  async runMetadata ({ retryMissed = false } = {}) {
    const key = this._metadataKey()
    if (!key) throw new Error('no TMDB key is saved')
    return this.enricher.run(this._inner, { key, retryMissed })
  }

  async confirmMetadata ({ itemId, tmdbId }) {
    return this.enricher.confirm({ itemId, tmdbId, key: this._metadataKey() })
  }

  // After a scan, quietly fill any gaps - but only when the operator has opted in,
  // and never twice at once. Errors are logged rather than thrown: a rate-limited
  // TMDB must not take the library down with it.
  async _autoMetadata () {
    const { enabled, hasKey } = this.metadataSettings()
    if (!enabled || !hasKey || this.enricher.running) return
    try {
      await this.runMetadata()
    } catch (e) {
      this.log('tmdb:failed', { err: e.message })
    }
  }

  // --- lifecycle ------------------------------------------------------------

  // THE SCAN DOES NOT BLOCK THE HOST FROM COMING UP, and on a real library that is
  // the difference between working and looking broken.
  //
  // Measured on the Umbrel against the actual 3 TB drive (2026-08-13): the first
  // scan walks 2,986 films and episodes and probes every one with ffprobe, which
  // takes MINUTES. Scanning first meant the DHT was silent and the web page did not
  // exist for that whole time - so a fresh install answered nothing at all, which is
  // indistinguishable from a broken one and is exactly the experience this app spends
  // so much effort avoiding elsewhere.
  //
  // So: listen first, scan after, and report progress while it happens. A phone can
  // pair during the scan, which is also the moment somebody is most likely to try.
  async ready ({ rescan = false, waitForScan = false } = {}) {
    await this.host.ready()

    // THE HARDWARE PROBE, beside the scan rather than in front of the listen: the
    // host must come up whether or not the box can transcode. Fire and record - a
    // playback that arrives before the probe settles simply gets today's refusal,
    // which is correct for a host whose hardware is not yet proven.
    this._probeTranscode()

    const scan = this._scan({ rescan }).then(() => this._autoMetadata())
    if (waitForScan) await scan
    return this
  }

  // Rule 2 of the transcode proposal: only hardware that proved itself at startup
  // may re-encode, and the proof is real bytes out of the real pipeline on synthetic
  // input - the presence of /dev/dri is not the test, because a device node with no
  // driver behind it initialises and then fails.
  //
  // PEARCINEMA_TRANSCODE=off is the feature's rollback and skips the probe entirely.
  async _probeTranscode () {
    if (String(process.env.PEARCINEMA_TRANSCODE || '').toLowerCase() === 'off') {
      this.transcode = { available: false, reason: 'turned off by configuration' }
      this.log('host:transcode', this.transcode)
      return this.transcode
    }
    this.transcode = await transcode.probeTranscode({
      ffmpeg: process.env.PEARCINEMA_FFMPEG || 'ffmpeg',
      device: this.transcoder.device
    })
    this.log('host:transcode', { available: this.transcode.available, reason: this.transcode.reason || undefined })
    return this.transcode
  }

  // A BAD SOURCE MUST NOT STOP THE HOST. If the credentials are wrong or the drive is
  // unplugged, scan() throws - and if that propagated, the operator would be locked
  // out of the very page they need in order to fix it. Come up, serve, say what is
  // wrong.
  async _scan ({ rescan = false } = {}) {
    this.scanning = { done: 0, total: 0, startedAt: Date.now() }
    try {
      const n = await this.adapter.scan({
        force: rescan,
        onProgress: (done, total) => { this.scanning = { ...this.scanning, done, total } }
      })
      this.sourceError = null
      this.log('host:scanned', { source: this.adapter.kind, items: n })
    } catch (e) {
      this.sourceError = e.message
      this.log('host:source-failed', { source: this.adapter.kind, err: e.message })
    } finally {
      this.scanning = null
    }
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

  async close () {
    // BEFORE the host, and unconditionally. An ffmpeg left running after the daemon
    // exits is an orphan holding a file handle on somebody's library drive, and on a
    // small box it is the whole box.
    this.remuxer.killAll()
    this.transcoder.killAll()
    return this.host.close()
  }
}

module.exports = { PearCinemaHost, PROTOCOL }
