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

const { createProtocol, LibraryHost, ownerOf } = require('@peerloom/host')

const { buildAdapter } = require('./adapters')
const { createMethods, MUTATING } = require('./methods')
const remux = require('./remux')
const transcode = require('./transcode')
const ffmpegBin = require('./ffmpeg-bin')
const tmdb = require('./tmdb')
const remoteLibs = require('./remote')
const remoteDownloads = require('./remote-downloads')
const blendLib = require('./blend')
const { Speakers } = require('./speakers')
const { RokuSpeakers } = require('./roku')
const { DlnaSpeakers } = require('./dlna')
const { CastTargets } = require('./cast-targets')
const { Televisions } = require('./televisions')
const castLib = require('./cast')
const watch = require('./watch')
const sidecars = require('./sidecars')
const subtitles = require('./subtitles')
const hls = require('./hls')
const keyframes = require('./keyframes')

// THE FIELD'S CEILING WHEN THIS BOX HAS NEVER BEEN MEASURED. A round number chosen
// for the machine this was built on: a cap of 200 is a typo rather than a plan, and
// that is all this constant knows. A box that has measured itself uses its own answer
// instead (transcodeMax).
const TRANSCODE_CAP_LIMIT = 16

// How often the host asks whether its library is still on the disk. A minute is
// often enough that nobody watches a dead grid for long, and cheap enough to be
// invisible: five stats against files it already knows the paths of.
const SOURCE_CHECK_MS = 60_000

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
    // Set by the watchdog, so that clearing the message again is only ever undoing
    // its own and never a failed scan's.
    this._sourceGone = false
    // Non-null while a scan is running, so the page can say "reading your library,
    // 1,500 of 2,986" instead of showing an empty grid that looks like a bug.
    this.scanning = null

    // Set by the dashboard when it starts: news worth putting on an open page the
    // moment it happens, rather than on its next load. Null while nothing is
    // listening, which is the normal state of a host with no browser open.
    this.onevent = null

    // Non-null while the engine is measuring itself, so the dashboard can say which
    // level it is on rather than spinning. The same shape `scanning` has.
    this.measuringEngine = null

    // The repackaging engine. Concurrency-capped, because remux is I/O bound rather
    // than CPU bound but three films at once on a Pi-class box is still three films
    // at once, and an unbounded count of child processes is how a host stops being a
    // host. Nothing is written to disk - see host/remux.js.
    this.remuxer = new remux.Remuxer({
      ffmpeg: ffmpegBin.ffmpeg(),
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
      ffmpeg: ffmpegBin.ffmpeg(),
      maxConcurrent: Number(process.env.PEARCINEMA_MAX_TRANSCODE) || 4,
      device: process.env.PEARCINEMA_VAAPI_DEVICE || transcode.DEVICE_DEFAULT,
      log
    })
    // The DASHBOARD's cap wins over the env var: it is the newer, explicit
    // intent, saved through setTranscodeCap and restored here. The env var
    // remains the deployment-level default underneath it.
    const savedCap = this._readSettings().transcodeCap
    if (Number.isFinite(Number(savedCap)) && savedCap !== null) {
      this.transcoder.maxConcurrent = Math.max(0, Math.min(16, Math.trunc(Number(savedCap))))
    }
    // `probing` until the startup probe answers, so a dashboard opened in the first
    // second says "checking" rather than reporting hardware that has not been asked yet
    // as hardware that failed. Both probe branches assign a fresh object, so the flag
    // clears itself.
    this.transcode = { available: false, probing: true, reason: 'the hardware has not been probed yet' }

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
      // THE TELEVISION HOOKS (video-deltas §5). A cast target is not a HyperDHT
      // connection, so the package calls `silence` wherever it kills
      // connections - revoke, leave, person revoke, expiry - and sweeps the
      // extra keys so a phone that cast and closed its app still expires.
      // Lazy closures: this.casts is built a few lines further down.
      silence: (deviceKey) => this.casts ? this.casts.stopFor(deviceKey) : 0,
      extraLiveKeys: () => this.casts ? this.casts.deviceKeys() : [],
      media: () => ({
        methods: createMethods({
          // Getters, not values. A connection outlives a source change and a
          // library rename, and both must reach an already-connected phone.
          getAdapter: () => this.adapter,
          getLibraryName: () => this.libraryName,
          getSourceError: () => this.sourceError,
          grants: this.host.grants,
          // The dashboard's live channel, when one is listening. notifyOwners
          // reaches paired DEVICES; this reaches the operator's own browser,
          // which is not one and is usually the thing that is open.
          events: (kind, data) => { try { this.onevent?.(kind, data) } catch {} },
          // So a push that reached nobody is a line in the log rather than a
          // theory - see `told` in methods.js.
          log: this.log,
          // The per-person store, built by the package on its own Hyperbee. Safe to
          // read here for the same reason `grants` is: `media` is a FUNCTION the
          // package calls once the host exists, not an object built alongside it.
          state: this.host.userState,
          // device.leave: the phone removed this library, so drop its own grant and
          // cut its connections - same teeth as revoke, logged as self-initiated.
          leave: (deviceKey) => this.host.leaveDevice(deviceKey),
          // device.revoke: an OWNER phone cutting another device off - the
          // dashboard's own kill, reached over the wire. Scope-gated in the
          // method; the mechanics (grant dead, live connections destroyed,
          // cast silenced) are revokeDevice's and already hardware-proven.
          revoke: (deviceKey) => this.host.revokeDevice(deviceKey),
          // Device photos, one small jpeg per device key, beside the grant data.
          // A file store rather than bee rows so a photo never rides a grants
          // scan it was not asked for.
          avatars: {
            dir: path.join(this.dataDir, 'avatars'),
            set: (deviceKey, b64) => {
              const dir = path.join(this.dataDir, 'avatars')
              fs.mkdirSync(dir, { recursive: true })
              const file = path.join(dir, String(deviceKey).replace(/[^a-z0-9]/gi, '') + '.b64')
              if (b64) fs.writeFileSync(file, String(b64))
              else fs.rmSync(file, { force: true })
            },
            get: (deviceKey) => {
              try {
                return fs.readFileSync(path.join(this.dataDir, 'avatars', String(deviceKey).replace(/[^a-z0-9]/gi, '') + '.b64'), 'utf8')
              } catch { return null }
            }
          },
          // The phone's transcode path: decide, playlist, one segment at a time.
          media: {
            decide: (p) => this.decideFor(p),
            playlist: (p) => this.hlsPlaylist(p),
            segment: (p) => this.hlsSegment(p),
            export: (p) => this.exportFor(p),
            // Whether THIS host could burn an image subtitle track into the
            // picture - the engine must have proven itself. subtitle.list uses
            // it to mark tracks, so a phone only offers what would work.
            canBurn: (codec) => this.transcodeOn() && subtitles.burnable(codec)
          },
          // Something is being WATCHED through this connection - the one thing
          // the host knows for certain. Feeds the dashboard's now-playing and
          // keeps lastSeenAt honest on long-lived connections.
          seen: (deviceKey, itemId) => this.noteWatching(deviceKey, itemId),
          // The television, one getter away - a getter because the sessions
          // object is built after the host that calls this factory.
          cast: () => this.casts
        }),
        onStream: (params, ctx) => this.noteWatching(ctx.deviceKey, params.itemId),
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

    // Casting to a television (video-deltas §5): PearTune's HA client trimmed
    // to video, and the session machinery with the video deltas. Disabled and
    // binding nothing until the operator configures Home Assistant.
    // TWO WAYS TO FIND A TELEVISION, one interface (proposal
    // 2026-08-18-cast-to-nearby-televisions, feature A). Home Assistant when the operator
    // configured it, and Rokus found on the host's own network when they answer - so an
    // owner who does not run HA is no longer locked out of casting entirely. The topology
    // is unchanged either way: the host finds, commands, serves and stops.
    this.ha = new Speakers({ dataDir: this.dataDir, log })
    // The televisions this library has met, kept between sightings so that switching
    // one off makes it read as unavailable rather than delete it from the picker.
    this.televisions = new Televisions({ dataDir: this.dataDir, log })
    this.roku = new RokuSpeakers({ log, televisions: this.televisions })
    // AND THE TELEVISIONS THAT SPEAK DLNA. Tim's Samsung was offered by Home Assistant
    // and did nothing when a film was sent to it (HA answered 500); the set takes the
    // film directly. Two discovery backends now, each minting its own kind of id.
    this.dlna = new DlnaSpeakers({ log, televisions: this.televisions })
    this.speakers = new CastTargets({ configured: this.ha, discovered: [this.roku, this.dlna], log })
    this.casts = new castLib.CastSessions({
      speakers: this.speakers,
      grants: this.host.grants,
      media: {
        getItem: (id) => this.adapter.get({ id: String(id) }),
        decide: (p) => this.decideFor(p),
        openStream: (p) => this.openStream(p),
        openRemux: (p) => this.openRemux(p),
        // The HLS pair, for cast targets that refuse unbounded progressive
        // streams (a Roku does, measured) - the same playlist and per-segment
        // engine the phone rides.
        playlist: (p) => this.hlsPlaylist(p),
        segment: (p) => this.hlsSegment(p)
      },
      presence: this.host.presence,
      report: (p) => this.reportCastProgress(p),
      // WHICH PLAYLIST SHAPE A RESUME GETS. See Casts._servePlaylist: the offset one
      // makes the television's OWN clock the film's clock, and it rests on a tag a
      // receiver is allowed to ignore - measured as honoured on the living room Roku,
      // 2026-08-20, so it is the default. An env var rather than a setting on a page,
      // because it is a measurement about a television and not a preference.
      startOffset: process.env.PEARCINEMA_HLS_SLICE !== '1',
      log
    })

    // The OUTBOUND side (proposal 2026-08-16-desktop-client): this machine as a
    // device of other libraries, riding the host's own DHT node. Costs nothing
    // until the dashboard pairs one.
    this.remote = new remoteLibs.RemoteLibraries({
      dataDir: this.dataDir,
      protocol: PROTOCOL,
      dht: this.host.dht,
      log
    })

    // Films kept HERE from those libraries (phase 2 of the same proposal): the
    // phone's download shape, a directory of plain files beside the data.
    this.downloads = new remoteDownloads.RemoteDownloads({
      dataDir: this.dataDir,
      remote: this.remote,
      log
    })

    // The blend (approved proposal 2026-08-17): the phone's merged index in
    // this process, local library plus remotes. Rebuilds follow the members:
    // pairing changes, a remote coming back, a local scan.
    this.blend = new blendLib.Blend({
      getAdapter: () => this.adapter,
      getLibraryId: () => this.host.libraryId,
      remote: this.remote,
      log
    })
    this.remote.onchange = () => this.blend.buildSoon('libraries-changed')
    this.remote.onconnect = () => this.blend.buildSoon('host-online')

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
            if (String(artId || '').startsWith('tmdb:')) return en.artStream(artId)
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
    // always did while it is. `burn` is the browser's chosen image subtitle
    // track resolved to a stream index - null unless it survives the same
    // refusals the phone path applies (host/sidecars-adjacent _burnTarget).
    const burn = this._burnTarget(itemId, capabilities)
    const verdict = remux.decide(item.media, capabilities, { transcode: this.transcodeOn(), burn: !!burn })
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
      media: item.media || null,
      burn: verdict.mode === 'transcode' ? burn : null
    })

    this.log('host:' + verdict.mode, { at, audio: verdict.audio, burn: !!burn, running: engine.running })
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
    this.log('presence:pushed', {
      kind: 'library:renamed',
      to: 'everyone',
      reached: this.host.presence.notifyAll('library:renamed', { libraryId: this.libraryId, name: clean })
    })
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

  // The fix flow, from the tile: candidates for one item (optionally with the
  // operator's own retyped query), one applied by TMDB id, or the match dropped.
  async searchMetadata ({ itemId, q = null }) {
    const item = await this._inner.get({ id: String(itemId) })
    if (!item) return null
    const candidates = await this.enricher.search({ item, q, key: this._metadataKey() })
    // What it is matched to RIGHT NOW rides back with the candidates. The dialog
    // cannot work it out from the item: artwork off the disk wins the picture and
    // so says nothing about whether a match exists behind it.
    return { candidates, matched: this.enricher.matchFor(itemId) }
  }

  // ONLY A FILM THIS BOX HOLDS. All libraries now offers the pencil, and the id it
  // sends is the local copy's - but a merged view is one bad rule away from
  // handing over a friend's id, and matching a stranger's film would record a
  // match against an id this library has never heard of.
  async fixMetadata ({ itemId, tmdbId, type }) {
    const item = await this._inner.get({ id: String(itemId) })
    if (!item) return { error: 'that one is not on this machine' }
    // The inner adapter rides along so re-matching a show can refresh its seasons'
    // pictures in the same breath.
    const match = await this.enricher.fix({ itemId, tmdbId, type, key: this._metadataKey(), adapter: this._inner })
    if (!match) return null
    this._artworkChanged()
    // THE ITEM AS IT NOW READS, so the page can patch the tile in place rather than
    // guess at what changed. Guessing is what the old dialog did - it assumed a fix
    // always swaps the picture - and it is wrong on the film that made this whole
    // item: one with a poster.jpg beside it, where the match changes and the
    // picture deliberately does not.
    return { match, item: this.enricher.decorate(item) }
  }

  async unmatchMetadata ({ itemId }) {
    const ok = await this.enricher.unmatch(String(itemId))
    if (ok) this._artworkChanged()
    const item = await this._inner.get({ id: String(itemId) }).catch(() => null)
    return { ok, item: item ? this.enricher.decorate(item) : null }
  }

  // A MATCH CHANGED, so the merged index is out of date about this library - it
  // holds the art ids and summaries as they were when it was built. Cheap, and
  // debounced by buildSoon.
  _artworkChanged () {
    this.blend?.buildSoon('metadata-fixed')
  }

  // Whether the write-into-the-library button should exist at all: only a
  // folder library has a disk of its own to write beside. A Jellyfin library
  // is that server's to manage and writing behind its back would be rude twice
  // over - it re-scans on its own schedule and it has its own metadata.
  canWriteSidecars () {
    return this._inner?.kind === 'folder'
  }

  // The explicit action (host/sidecars.js). Guarded like the enricher's own
  // run: a second click while one pass writes joins it rather than racing it.
  async writeSidecars () {
    if (!this.canWriteSidecars()) {
      return { supported: false, reason: 'sidecars can only be written into a folder library' }
    }
    if (!this._writingSidecars) {
      this._writingSidecars = sidecars
        .write({ adapter: this._inner, enricher: this.enricher, log: this.log })
        .finally(() => { this._writingSidecars = null })
    }
    return this._writingSidecars
  }

  // --- the phone's transcode path: decide, playlist, segment ------------------
  //
  // Stateless by design: every call recomputes the verdict from the same decide()
  // the browser uses, so there is no session row to leak and revoke needs no new
  // teeth - a revoked phone simply cannot call again, and the segment its player
  // already asked for dies with the connection like any stream.

  // The file's real average rate, for the data-saver comparison. Size over
  // runtime - approximate on VBR, exactly wrong nowhere it matters.
  _fileKbps (item) {
    const size = item?.media?.size
    const secs = item?.runtime
    return size > 0 && secs > 0 ? (size * 8) / (secs * 1000) : 0
  }

  // AUTO-RESCAN, PearTune's shape verbatim: a settings-file interval, a timer
  // armed at ready() and re-armed on change, and unref so a background timer
  // never keeps the process alive. Most useful for a folder library - a
  // server source watches its own files, so there the timer is just a
  // periodic stats refresh.
  getRescanIntervalMin () { return Number(this._readSettings().rescanIntervalMin) || 0 }

  setRescanIntervalMin (min) {
    const n = Math.max(0, Math.min(1440, Math.round(Number(min) || 0)))
    this._writeSettings({ rescanIntervalMin: n })
    this._armRescan(n)
    this.log('host:rescan-interval', { minutes: n })
    return n
  }

  _armRescan (min = this.getRescanIntervalMin()) {
    if (this._rescanTimer) { clearInterval(this._rescanTimer); this._rescanTimer = null }
    if (min > 0) {
      this._rescanTimer = setInterval(() => {
        this.rescan().catch(e => this.log('host:auto-rescan-failed', { err: e.message }))
      }, min * 60000)
      this._rescanTimer.unref?.()
    }
  }

  // THE WATCHDOG. A drive that goes away does not announce itself: in a container a
  // bind mount whose disk has been remounted elsewhere leaves a directory that is
  // present, readable and empty, so the host stays green while every film 404s. That
  // is what happened to Tim's Umbrel on 2026-08-19 and what nothing on any screen
  // said. Asked every minute, and it is five stats - not a scan.
  //
  // IT ONLY CLEARS WHAT IT SET. A scan that failed for its own reasons owns
  // `sourceError` until a scan succeeds; this must not tidy that away underneath it.
  _armWatchdog () {
    if (this._watchdog) clearInterval(this._watchdog)
    this._watchdog = setInterval(() => { this._checkSource().catch(() => {}) }, SOURCE_CHECK_MS)
    this._watchdog.unref?.()
  }

  async _checkSource () {
    const adapter = this._inner || this.adapter
    if (typeof adapter?.health !== 'function') return null

    const health = await adapter.health()
    if (health.ok) {
      if (this._sourceGone) {
        this._sourceGone = false
        this.sourceError = null
        this.log('host:source-back', {})
      }
      return health
    }

    if (!this._sourceGone) this.log('host:source-gone', { detail: health.detail })
    this._sourceGone = true
    this.sourceError = health.detail
    return health
  }

  // The one rescan everybody calls - the dashboard button, the auto-rescan
  // timer - so the sourceError bookkeeping cannot drift between them.
  async rescan () {
    try {
      const n = await this.adapter.scan({ force: true })
      this.sourceError = null
      this._sourceGone = false
      return n
    } catch (e) {
      this.sourceError = e.message
      throw e
    }
  }

  // MAY A CONVERSION START? The probe's verdict AND the operator's cap: zero
  // is the off switch, and it must reach decide() as "no transcode" so phones
  // and browsers get honest refusals rather than bouncing off a closed pool
  // as BUSY errors. The probe result itself stays untouched - the dashboard
  // still says what the hardware CAN do even while the operator says no.
  transcodeOn () {
    return this.transcode.available && this.transcoder.maxConcurrent > 0
  }

  // The cap, where it came from and what this box was measured at - what the
  // dashboard field needs to say something honest.
  //
  // `measured` used to be the constant 10, from the machine this was built on, shown
  // to every install regardless of what it was running (Tim, 2026-08-19). It is now
  // either this box's own measurement or nothing at all.
  transcodeCap () {
    const measured = this._readSettings().transcodeMeasured || null
    return {
      cap: this.transcoder.maxConcurrent,
      source: this._readSettings().transcodeCap !== undefined
        ? 'dashboard'
        : (process.env.PEARCINEMA_MAX_TRANSCODE ? 'environment' : 'default'),
      measured,
      // WHAT THE FIELD MAY BE SET TO. A measurement bounds it (Tim's call: the answer
      // lands as the field's maximum rather than as another sentence); without one the
      // limit is the same round number it always was, which is a guess about nothing
      // in particular and is labelled as such by the absence of `measured`.
      max: this.transcodeMax(),
      measuring: this.measuringEngine || null
    }
  }

  transcodeMax () {
    const measured = this._readSettings().transcodeMeasured
    // At least one: a box measured under realtime can still be told to convert one
    // film, and refusing to let the operator ask is not our call to make.
    return measured ? Math.max(1, Number(measured.cap) || 0) : TRANSCODE_CAP_LIMIT
  }

  // Open question 1 of the transcode proposal, answered yes: the default of 4
  // is sized for sharing the engine, and a box serving one household member
  // should not refuse at it. Clamped to what this machine may do - its own
  // measurement when it has one - and applied LIVE: the next start obeys it,
  // running conversions are left to finish.
  setTranscodeCap (cap) {
    const n = Math.trunc(Number(cap))
    const max = this.transcodeMax()
    if (!Number.isFinite(n) || n < 0 || n > max) {
      throw new Error(`the cap is a whole number from 0 (conversions off) to ${max}`)
    }
    this._writeSettings({ transcodeCap: n })
    this.transcoder.maxConcurrent = n
    this.log('host:transcode-cap', { cap: n })
    return this.transcodeCap()
  }

  // THE FILM THE MEASUREMENT USES: the hardest real one in the library, because the
  // number is about what this box does with the operator's own films rather than
  // with a test pattern. Hardest means the engine's own worst case - HEVC, the
  // biggest picture - and the seek lands past the opening, where a black frame would
  // encode in no time and flatter the result.
  async _measurementSubject () {
    const { items = [] } = await this.adapter.list({ type: 'movies', limit: 200 })
    return transcode.hardestFilm(items)
  }

  // MEASURE THIS BOX, on this box's own films. Refuses while anything is converting -
  // sixteen ffmpegs beside somebody's film is a measurement that ruins the thing it
  // is measuring - and refuses a second run while one is going.
  async measureEngine () {
    if (!this.transcode.available) throw new Error('this host has no video engine to measure')
    if (this.measuringEngine) throw new Error('it is already measuring')
    if (this.transcoder.running) throw new Error('something is being converted right now - try again when it has finished')

    const item = await this._measurementSubject()
    if (!item) throw new Error('there is nothing in the library to convert, so there is nothing to measure')
    const source = this.adapter.ffmpegInput ? await this.adapter.ffmpegInput({ itemId: String(item.id) }) : null
    if (!source?.input) throw new Error('that film could not be opened')

    const at = Math.min(120, Math.max(0, Math.round((Number(item.runtime) || 0) * 0.1)))
    this.measuringEngine = { concurrency: 0, step: 0, steps: 0, startedAt: Date.now() }
    this.onevent?.('engine:measuring', this.measuringEngine)
    try {
      const out = await transcode.measureEngine({
        ffmpeg: ffmpegBin.ffmpeg(),
        device: this.transcoder.device,
        engine: this.transcoder.engine,
        input: source.input,
        headers: source.headers || null,
        media: item.media,
        at,
        onLevel: ({ concurrency, step, steps }) => {
          this.measuringEngine = { ...this.measuringEngine, concurrency, step, steps }
          this.onevent?.('engine:measuring', this.measuringEngine)
        }
      })
      // WHICH FILM IT WAS MEASURED ON, kept because the number is meaningless without
      // it. This box holds four conversions of a 1080p film and two of the 4K HEVC one
      // (measured 2026-08-20), and the answer is the harder of those - so the row has
      // to be able to say what it was up against, or a ceiling of 2 on a machine that
      // manages 4 most of the time reads as PearCinema being timid.
      this._writeSettings({
        transcodeMeasured: {
          ...out,
          film: item.title || null,
          codec: item.media?.videoCodec || null,
          width: Number(item.media?.width) || null
        }
      })
      // A CAP ABOVE WHAT THE BOX CAN DO IS NOT A CAP. If the operator's number is
      // higher than the measurement, it comes down to it - leaving it would promise
      // a household more films at once than this machine can actually keep up with.
      const max = this.transcodeMax()
      if (this.transcoder.maxConcurrent > max) {
        this._writeSettings({ transcodeCap: max })
        this.transcoder.maxConcurrent = max
      }
      this.log('host:engine-measured', { cap: out.cap, ladder: out.ladder.length, film: item.title })
      return this.transcodeCap()
    } finally {
      this.measuringEngine = null
      this.onevent?.('engine:measured', { cap: this._readSettings().transcodeMeasured?.cap ?? null })
    }
  }

  // The chosen image subtitle track's stream index, or null - and null MEANS
  // the burn request is ignored rather than half-honoured: a stale id, a text
  // track, another item's track, an adapter that cannot resolve one (Jellyfin)
  // or a host with no proven engine all decide as if nothing was asked.
  _burnTarget (itemId, capabilities = {}) {
    const subtitleId = capabilities?.burnSubtitleId
    if (!subtitleId || !this.transcodeOn()) return null
    if (typeof this._inner?.subtitleBurnTarget !== 'function') return null
    return this._inner.subtitleBurnTarget({ itemId: String(itemId), subtitleId: String(subtitleId) })
  }

  async decideFor ({ itemId, capabilities = {} }) {
    const item = await this.adapter.get({ id: String(itemId) })
    if (!item) return null
    const burn = this._burnTarget(itemId, capabilities)
    const verdict = remux.decide(item.media, capabilities, { transcode: this.transcodeOn(), fileKbps: this._fileKbps(item), burn: !!burn })
    return { mode: verdict.mode, reason: verdict.reason }
  }

  // ONE PLAN, TWO ENGINES, and the whole reason the segment path stopped being
  // the transcode path (2026-08-19).
  //
  //   transcode  the picture is re-encoded, so a segment can start anywhere and
  //              the plan is even four-second steps, exactly as before.
  //   remux      the picture is COPIED and only the sound is rebuilt, so segments
  //              can only start on the film's own keyframes. host/keyframes.js
  //              reads them out of the container's index in milliseconds.
  //
  // A remux with no readable index falls back to the encode engine, which is what
  // this host did for every generated stream before today - slower, never wrong.
  // Both the playlist and every segment recompute the plan from the same cached
  // index, so the two cannot disagree about where a segment begins.
  async _hlsPlan ({ item, verdict, source }) {
    if (verdict.mode !== 'remux') return hls.gridPlan(item.runtime)
    if (!source) return null

    // A Jellyfin source hands out an HTTP URL rather than a path, and the index is
    // read out of that the same way - two or three Range requests, with the
    // server's own credentials, rather than a download (2026-08-20).
    const index = await keyframes.read(source.input, {
      ffprobe: ffmpegBin.ffprobe(),
      headers: source.headers || null
    })
    if (!index) {
      this.log('host:hls-no-keyframes', { itemId: String(item.id), engine: 'encode' })
      return this.transcodeOn() ? hls.gridPlan(item.runtime) : null
    }

    const plan = hls.copyPlan(index.times, { runtime: item.runtime, reorderDelay: index.reorderDelay })
    if (!plan) return this.transcodeOn() ? hls.gridPlan(item.runtime) : null
    return plan
  }

  async _hlsContext ({ itemId, capabilities }) {
    const item = await this.adapter.get({ id: String(itemId) })
    if (!item) return null
    const burn = this._burnTarget(itemId, capabilities)
    const verdict = remux.decide(item.media, capabilities, { transcode: this.transcodeOn(), fileKbps: this._fileKbps(item), burn: !!burn })
    if (verdict.mode !== 'transcode' && verdict.mode !== 'remux') return { item, verdict, burn, source: null, plan: null }

    const source = this.adapter.ffmpegInput
      ? await this.adapter.ffmpegInput({ itemId: String(itemId) })
      : null
    const plan = await this._hlsPlan({ item, verdict, source })
    return { item, verdict, burn, source, plan }
  }

  async hlsPlaylist ({ itemId, capabilities = {} }) {
    const ctx = await this._hlsContext({ itemId, capabilities })
    if (!ctx) return null
    const { item, verdict, plan } = ctx
    if (verdict.mode !== 'transcode' && verdict.mode !== 'remux') {
      return { mode: verdict.mode, reason: verdict.reason, playlist: null }
    }
    const playlist = plan ? hls.playlistFor(item, { plan }) : null
    if (!playlist) {
      // Two ways to get here and they deserve different words, because one is a
      // fact about the film and the other is a fact about this host.
      const reason = Number(item.runtime) > 0
        ? 'this film has to be converted to reach that client, and this host cannot cut it into segments'
        : 'this item reports no runtime, so a playlist cannot be computed'
      return { mode: 'refuse', reason, playlist: null }
    }
    return {
      mode: verdict.mode,
      engine: plan.engine,
      playlist,
      segments: plan.starts.length,
      segmentSeconds: hls.SEGMENT_SECONDS,
      // WHERE EACH SEGMENT REALLY BEGINS. A copy plan's segments are uneven, so a
      // cast resuming mid-film cannot work out its start point by dividing - it
      // has to be told. host/cast.js snaps to these.
      boundaries: plan.starts
    }
  }

  async hlsSegment ({ itemId, seq, capabilities = {} }) {
    const ctx = await this._hlsContext({ itemId, capabilities })
    if (!ctx) return null
    const { item, verdict, burn, source, plan } = ctx
    if (verdict.mode !== 'transcode' && verdict.mode !== 'remux') return null
    if (!plan || !source) return null

    const k = Number(seq)
    if (!Number.isInteger(k) || k < 0 || k >= plan.starts.length) return null

    const argv = plan.engine === 'copy'
      ? hls.copySegmentArgs({
        input: source.input,
        headers: source.headers || null,
        seq: k,
        plan,
        audio: verdict.audio || 'aac',
        audioCodec: item.media?.audioCodec || null,
        // The client's own speaker count, which is the whole reason a film with
        // a perfect picture is being touched at all - held down to the film's own
        // count, so a stereo soundtrack is never upmixed to fill a television.
        audioChannels: hls.channelsFor(capabilities.maxAudioChannels, item.media?.audioChannels)
      })
      : hls.segmentArgs({
        input: source.input,
        headers: source.headers || null,
        seq: k,
        plan,
        media: item.media || {},
        device: this.transcoder.device,
        engine: this.transcoder.engine,
        hwDecode: transcode.HW_DECODE.has(remux.codec(item.media?.videoCodec)),
        // The width ladder, capped at the client's stated budget when it gave one.
        bitrate: transcode.capBitrate(transcode.bitrateFor(item.media?.width), Number(capabilities.maxKbps) || 0),
        audioChannels: hls.channelsFor(capabilities.maxAudioChannels, item.media?.audioChannels),
        burn: burn || null,
        tone: ['bw', 'sepia'].includes(capabilities.tone) ? capabilities.tone : null
      })

    // Through the SAME pool as the browser's transcodes: one engine, one cap,
    // one BUSY message, one kill path. A copied segment barely touches the video
    // hardware, but it still holds a file handle on the library drive and still
    // has to die when a revoke says so.
    const session = this.transcoder.start({ argv, at: plan.starts[k], audio: 'aac', media: item.media })
    this.log('host:hls-segment', { seq: k, engine: plan.engine, running: this.transcoder.running })
    return session
  }

  // One whole converted film as a single progressive fMP4, for a download the
  // phone keeps. Same decide() as playback: an item the client could take as-is
  // answers { direct: true } and the byte-exact path applies instead - the host
  // never converts what needs no converting. Runs through the transcoder pool,
  // so it shares the engine cap, the BUSY message and revoke's killAll.
  async exportFor ({ itemId, capabilities = {} }) {
    const item = await this.adapter.get({ id: String(itemId) })
    if (!item) return null
    // A download is the film, not the viewing session - a subtitle choice or
    // a skin's tone made in the player must not bake itself into the copy the
    // phone keeps.
    const { burnSubtitleId, tone, ...caps } = capabilities
    const verdict = remux.decide(item.media, caps, { transcode: this.transcodeOn(), fileKbps: this._fileKbps(item) })
    if (verdict.mode !== 'transcode') return { direct: true }
    if (!this.adapter.ffmpegInput) return null
    const source = await this.adapter.ffmpegInput({ itemId: String(itemId) })
    if (!source) return null

    const argv = transcode.transcodeArgs({
      input: source.input,
      headers: source.headers || null,
      at: 0,
      audio: verdict.audio || 'copy',
      media: item.media || {},
      device: this.transcoder.device,
      engine: this.transcoder.engine,
      maxKbps: Number(capabilities.maxKbps) || 0
    })
    const session = this.transcoder.start({ argv, at: 0, audio: verdict.audio, media: item.media })
    this.log('host:export', { itemId: String(itemId), running: this.transcoder.running })

    // THE TRUNCATION GUARD. A crashed ffmpeg ends its stdout CLEANLY, and a
    // clean end becomes a clean end frame on the wire - the phone would store
    // half a film as a finished download and only find out at the missing
    // third act. So the wire stream only ends when the process exited 0;
    // any other exit destroys it, which reaches the phone as a stream error.
    const { PassThrough } = require('stream')
    const out = new PassThrough()
    session.stdout.pipe(out, { end: false })
    session.proc.on('close', (code) => {
      if (code === 0) out.end()
      else out.destroy(new Error('the conversion died before the end of the film'))
    })
    // A cancel from the phone destroys `out`; the kill frees the engine slot.
    out.on('close', () => session.kill())
    return { stream: out }
  }

  // A candidate's thumbnail for the fix dialog, PROXIED - the promise on the panel
  // is that the HOST talks to TMDB, so the browser must not be sent to fetch from
  // TMDB itself. The path shape is checked by the route; this only relays.
  async previewMetadataPoster (posterPath) {
    const key = this._metadataKey()
    if (!key) return null
    return new tmdb.TmdbClient({ key }).poster(posterPath, 'w185').catch(() => null)
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
    // The saved auto-rescan interval survives a restart the way the name does.
    this._armRescan()
    this._armWatchdog()
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
    // The cards this machine has, so the dashboard can name the one in use only when
    // there is more than one to choose between.
    const nodes = transcode.renderNodes()
    // WHOSE CARD IT IS, decided by running each vendor's real encoder rather than by
    // reading a device name. Intel and AMD answer through VAAPI, NVIDIA through NVENC,
    // and a machine with neither says why (host/engines.js).
    this.transcode = await transcode.chooseEngine({
      ffmpeg: ffmpegBin.ffmpeg(),
      device: this.transcoder.device,
      only: process.env.PEARCINEMA_ENGINE || null
    })
    // Every argv built from here on is built for the card that actually answered.
    if (this.transcode.available) {
      this.transcoder.engine = transcode.engineFor(this.transcode.engine)
      if (this.transcode.device) this.transcoder.device = this.transcode.device
    }
    this.transcode = { ...this.transcode, nodes }
    this.log('host:transcode', {
      available: this.transcode.available,
      engine: this.transcode.engine || undefined,
      device: this.transcode.device || undefined,
      reason: this.transcode.reason || undefined
    })
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
      // The blend's local member just changed shape.
      this.blend.buildSoon('scan')
    } catch (e) {
      this.sourceError = e.message
      this.log('host:source-failed', { source: this.adapter.kind, err: e.message })
    } finally {
      this.scanning = null
    }
  }

  // RESCANNING DOES NOT BLOCK THE PERSON WHO ASKED FOR IT (Tim, 2026-08-19: he pressed
  // Rescan on the real library, watched the button say "Rescanning…" for several
  // minutes and had no way to tell whether anything was happening). The dashboard used
  // to await `adapter.scan()` inside the request, which on the 3 TB drive is minutes of
  // ffprobe against one held-open HTTP connection - and because it went round `_scan`
  // rather than through it, `scanning` stayed null the whole time, so nothing else on
  // the page could say so either.
  //
  // Now it starts the same scan the startup and the timer use, and answers at once.
  // Progress lives where every other slow thing's does: `scanning` on /api/state.
  rescan () {
    if (this.scanning) return { scanning: this.scanning }
    this._scan({ rescan: true }).catch(() => {})
    return { started: true, scanning: this.scanning }
  }

  startPairing (opts) { return this.host.startPairing(opts) }
  stopPairing () { return this.host.stopPairing() }
  // The package's rows, plus what each device is WATCHING right now - resolved
  // to a title here, because the dashboard renders people, not ids.
  async listDevices () {
    const rows = await this.host.listDevices()
    for (const r of rows) {
      const w = this.watchingOf(r.deviceKey)
      if (!w) continue
      const item = await this.adapter.get({ id: w.itemId }).catch(() => null)
      if (item) r.watching = { itemId: w.itemId, title: item.title, artId: item.artId || null, at: w.at }
    }
    return rows
  }
  revokeDevice (k) { return this.host.revokeDevice(k) }

  // deviceKey -> { itemId, at }. RAM-only and coarse on purpose: the dashboard
  // asks "what is this person watching", not for a play log.
  noteWatching (deviceKey, itemId) {
    if (!deviceKey || !itemId) return
    if (!this.nowStreaming) this.nowStreaming = new Map()
    this.nowStreaming.set(String(deviceKey), { itemId: String(itemId), at: Date.now() })
    this.host.grants.touch(deviceKey).catch(() => {})
  }

  watchingOf (deviceKey) {
    const w = this.nowStreaming?.get(String(deviceKey))
    // Stale after ten minutes without a byte - a paused film holds its buffer.
    return w && Date.now() - w.at < 10 * 60 * 1000 ? w : null
  }

  // A television's position, landing in watch state under the CASTING DEVICE's
  // owner - the same rules resume.set applies on the wire: the runtime comes
  // from the library, finishing writes the tick and clears the position, and
  // the person's other devices hear about it. Put the phone down, cast from
  // the sofa, pick the film up on a laptop at the right minute.
  async reportCastProgress ({ deviceKey, itemId, positionMs = null, ended = false }) {
    const lookup = await this.host.grants.lookup(deviceKey)
    if (!lookup?.grant || lookup.grant.revokedAt) return
    const owner = ownerOf(lookup.grant)

    const item = await this.adapter.get({ id: String(itemId) })
    if (!item) return

    const verdict = watch.decide({ positionMs: positionMs || 0, runtimeSeconds: item.runtime, ended })
    if (verdict.finished) await this.host.userState.setWatched(owner, String(itemId), true, { auto: true })
    await this.host.userState.setResume(owner, String(itemId), verdict.positionMs, verdict.durationMs, {
      playedAt: Date.now(),
      deviceKey
    })
    this.log('presence:pushed', {
      kind: 'resume:changed',
      to: String(owner || '?').slice(0, 14),
      reached: this.host.presence.notifyOwner(owner, 'resume:changed', { itemId: String(itemId), finished: verdict.finished })
    })
  }
  leaveDevice (k) { return this.host.leaveDevice(k) }
  revokePerson (p) { return this.host.revokePerson(p) }
  // Cleanup and edits the dashboard offers. Proxied rather than reached for through
  // `.host`, so the web interface talks to PearCinemaHost and never has to know
  // there is a LibraryHost underneath it.
  deleteDevice (k) { return this.host.deleteDevice(k) }
  setDeviceExpiry (k, at) { return this.host.setDeviceExpiry(k, at) }
  deletePerson (p) { return this.host.deletePerson(p) }
  notifyOwnersDevicesChanged () { return this.host.notifyOwnersDevicesChanged() }

  // Assignment applies to LIVE connections, not just future ones - the package
  // swaps the grant snapshot on every open channel and tells the device
  // (grant:changed), so a phone watching mid-assignment files its very next
  // position under the new person.
  assignDevice (deviceKey, personId) { return this.host.assignDevice(deviceKey, personId) }

  async close () {
    if (this._rescanTimer) { clearInterval(this._rescanTimer); this._rescanTimer = null }
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null }
    // BEFORE the host, and unconditionally. An ffmpeg left running after the daemon
    // exits is an orphan holding a file handle on somebody's library drive, and on a
    // small box it is the whole box.
    this.remuxer.killAll()
    this.transcoder.killAll()
    this.downloads.close()
    // Before the store closes: stopFor() darkens televisions, and a TV left
    // playing a dead URL freezes on the last buffered frame.
    await this.casts.close().catch(() => {})
    await this.remote.close().catch(() => {})
    return this.host.close()
  }
}

module.exports = { PearCinemaHost, PROTOCOL }
