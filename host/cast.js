// Casting a film to a television (video-deltas proposal §5) - PearTune's
// cast.js with the video deltas, and its security shape inherited whole.
//
// THE SECURITY SHAPE, because this is the part that can go wrong quietly.
//
// Revoke's teeth on the P2P path destroy a device's HyperDHT connections. A
// TELEVISION IS NOT ONE OF THOSE: the film reaches it from this process over
// plain LAN HTTP, on a path with no relationship to the revoked phone's
// connection. So there are TWO mechanisms and BOTH are required:
//
//   1. Every fetch of a video URL RE-READS THE LIVE GRANT. A revoked device
//      fails its next byte. Necessary, not sufficient: a TV buffers minutes
//      ahead, so the room can keep playing for a while after the last GET -
//      video makes this WORSE than the donor's speakers, not better.
//   2. Revoke actively stops every entity that device has playing. This is
//      what makes the screen go dark. `stopFor()` is the entry point, and it
//      is wired into @peerloom/host's `silence` hook, which the package calls
//      wherever it kills connections - revoke, leave, person revoke, expiry.
//
// THE VIDEO DELTAS against the donor:
//
//   - Range on direct files. A Chromecast seeks by byte range, and a two-hour
//     film without seek is unacceptable (the same measurement that shaped
//     remux). Generated streams stay unseekable and say so - the phone seeks
//     those by re-casting at a new position, the web player's restart shape.
//   - The host DECIDES per play with the television's capabilities, the same
//     decide() the browser and the phone go through. The Default Media
//     Receiver plays H.264 in MP4 and nothing Matroska, so most of a real
//     library arrives repackaged or converted - by this host's own engines.
//   - No voice, no host-held queue. A film is not a playlist; the phone that
//     started the cast hears cast:ended and decides what happens next.
//
// The listener answers the LAN (a Cast device fetches the URL ITSELF, so
// loopback would name the TELEVISION), protected the donor's way: the path IS
// the capability - 32 random bytes, no listing route - every fetch re-reads
// the live grant, tokens expire, and a play that fails to start deletes its
// token immediately. Video crosses the LAN in cleartext exactly as the donor's
// audio does, accepted for the same reasons; everything LEAVING the house
// stays encrypted. Opt-out: PEARCINEMA_CAST_BIND=127.0.0.1.

const crypto = require('crypto')
const http = require('http')
const os = require('os')

const { decide } = require('@peerloom/host')
const { SCOPE } = require('@peerloom/host/constants')

// A cast token outlives one film by a margin, not by a season: four hours
// covers any feature plus a long pause, and a longer tail is a bigger window
// for a token that leaked to a co-resident process.
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000

// How often we ask HA what the entity is doing, while a cast is live. Only
// runs while at least one cast exists, so an idle host makes no HA traffic.
const POLL_MS = 2000

// How often a playing television's position is written to watch state. The
// phone writes every fifteen seconds; the television gets the same cadence,
// so putting the phone down and picking the film up elsewhere works mid-cast.
const REPORT_MS = 15000

// 8752, the port DECISIONS reserved beside the dashboard's 8751 (8742 is
// PearTune's cast server on the same box).
const PREFERRED_PORT = Number(process.env.PEARCINEMA_CAST_PORT || 8752)

const BIND = process.env.PEARCINEMA_CAST_BIND || '0.0.0.0'

// What the Default Media Receiver actually plays, declared the way any client
// declares itself. Conservative on purpose: an HEVC-capable Google TV will get
// an H.264 conversion it did not strictly need, which costs the engine some
// work; the liberal list would hand an older Chromecast a film it plays as a
// black screen, which costs the feature its credibility.
const CAST_CAPS = {
  containers: ['mp4', 'mov'],
  videoCodecs: ['h264'],
  audioCodecs: ['aac', 'mp3']
}

// Who may light up a television. OWNER only, the donor's phase 1 rule kept
// with its reasoning: a guest streaming to their own phone is one thing, a
// guest starting the living-room TV is another. Easy to relax, painful to
// tighten - relaxing is one entry here.
const CAST_SCOPES = new Set([SCOPE.OWNER])

// The address we tell the television to fetch from - a different question from
// what we bind. First non-internal IPv4, overridable for multi-homed boxes.
function castHost () {
  if (process.env.PEARCINEMA_CAST_HOST) return process.env.PEARCINEMA_CAST_HOST
  if (BIND !== '0.0.0.0' && BIND !== '::') return BIND
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return '127.0.0.1'
}

function newToken () {
  return crypto.randomBytes(32).toString('base64url')
}

// bytes=A-B against a known size. Single range only, the same rule the
// dashboard's stream route applies.
function parseRange (header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m || (!m[1] && !m[2])) return null
  let start = m[1] ? Number(m[1]) : null
  let end = m[2] ? Number(m[2]) : null
  if (start === null) { start = Math.max(0, size - end); end = size - 1 }
  else if (end === null || end >= size) end = size - 1
  if (start >= size || start > end) return { unsatisfiable: true }
  return { start, end }
}

class CastSessions {
  // `media` is the seam to the host's playback machinery, the same calls the
  // dashboard routes ride: decide/openStream/openRemux/getItem. `report` is
  // how a television's position lands in watch state - async ({ deviceKey,
  // itemId, positionMs, ended }), implemented by the host against the same
  // rules resume.set applies.
  constructor ({ speakers, grants, media, presence = null, report = null, log = () => {} }) {
    this.speakers = speakers
    this.grants = grants
    this.media = media
    this.presence = presence
    this.report = report
    this.log = log

    // token -> { deviceKey, itemId, entityId, mode, at, expiresAt }
    this.tokens = new Map()
    // deviceKey -> Map<entityId, { token, itemId, mode, at, startedAt, sawPlaying, lastReportAt }>
    this.byDevice = new Map()

    this.server = null
    this.port = 0
    this.timer = null
  }

  async start () {
    if (this.server) return this.port
    this.server = http.createServer((req, res) => this._serve(req, res))
    const listen = (srv, port) => new Promise((resolve, reject) => {
      const onErr = (e) => { srv.removeListener('error', onErr); reject(e) }
      srv.once('error', onErr)
      srv.listen(port, BIND, () => { srv.removeListener('error', onErr); resolve() })
    })
    try {
      await listen(this.server, PREFERRED_PORT)
    } catch (e) {
      // A fresh server for the retry - an http.Server whose listen() failed
      // cannot simply be listened on again (the donor's measured lesson).
      this.log('cast:port-busy', { port: PREFERRED_PORT, err: e?.code })
      try { this.server.close() } catch {}
      this.server = http.createServer((req, res) => this._serve(req, res))
      await listen(this.server, 0)
    }
    this.port = this.server.address().port
    this.log('cast:listening', { port: this.port, bind: BIND, advertise: castHost() })
    return this.port
  }

  async close () {
    this._stopPolling()
    for (const deviceKey of [...this.byDevice.keys()]) {
      // Best-effort: a host shutting down should not leave a television
      // playing from a URL that is about to stop answering.
      await this.stopFor(deviceKey).catch(() => {})
    }
    this.tokens.clear()
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve))
      this.server = null
    }
  }

  // --- the video route ----------------------------------------------------
  //
  // GET /v/<token>. Direct files honour Range, because a television seeks by
  // byte range; generated streams say accept-ranges: none and the phone seeks
  // those by re-casting at a new position.
  async _serve (req, res) {
    const deny = (code) => {
      // No body and no reason. A caller that is not the television has no
      // business learning whether a token was wrong, expired or revoked.
      res.writeHead(code)
      res.end()
    }

    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const m = /^\/v\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
      if (!m) return deny(404)
      if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405)

      const entry = this.tokens.get(m[1])
      if (!entry) return deny(404)
      if (Date.now() > entry.expiresAt) {
        this.tokens.delete(m[1])
        return deny(404)
      }

      // THE LIVE RE-READ. Not the grant we minted with - the grant as it is
      // right now. This is what makes a revoked, expired or person-revoked
      // device fail its next fetch mid-film.
      const lookup = await this.grants.lookup(entry.deviceKey)
      const verdict = decide(lookup)
      if (!verdict.allow || !CAST_SCOPES.has(lookup.grant?.scope)) {
        this.log('cast:fetch-denied', {
          device: String(entry.deviceKey).slice(0, 8),
          reason: verdict.allow ? 'scope' : verdict.reason
        })
        this.tokens.delete(m[1])
        return deny(403)
      }

      if (entry.mode === 'direct') return this._serveDirect(req, res, entry, deny)
      return this._serveGenerated(req, res, entry, deny)
    } catch (e) {
      this.log('cast:serve-failed', { err: e?.message })
      try { deny(500) } catch {}
    }
  }

  async _serveDirect (req, res, entry, deny) {
    const item = await this.media.getItem(entry.itemId)
    const size = item?.media?.size
    if (!size) return deny(404)

    const range = req.headers.range ? parseRange(req.headers.range, size) : null
    if (range?.unsatisfiable) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      return res.end()
    }
    const start = range ? range.start : 0
    const end = range ? range.end : size - 1

    res.writeHead(range ? 206 : 200, {
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
    })
    if (req.method === 'HEAD') return res.end()

    let stream = await this.media.openStream({ itemId: entry.itemId, offset: start, length: end - start + 1 })
    if (!stream) return res.end()
    // An adapter hands back a Node Readable (folder, off disk) or a web
    // ReadableStream (Jellyfin, off fetch) - same normalisation as the
    // dashboard's stream route.
    if (typeof stream.pipe !== 'function') stream = require('stream').Readable.fromWeb(stream)
    // A television abandons ranges as it seeks; without this every seek leaks
    // a file handle on the library drive.
    res.on('close', () => stream.destroy?.())
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  async _serveGenerated (req, res, entry, deny) {
    let out
    try {
      out = await this.media.openRemux({ itemId: entry.itemId, at: entry.at, capabilities: CAST_CAPS })
    } catch (e) {
      if (e.code === 'BUSY') return deny(503)
      throw e
    }
    if (!out || (out.mode !== 'remux' && out.mode !== 'transcode')) return deny(409)

    res.writeHead(200, {
      'content-type': 'video/mp4',
      'accept-ranges': 'none',
      'cache-control': 'no-store'
    })
    if (req.method === 'HEAD') { out.session.kill(); return res.end() }

    // The process dies with the response - an ffmpeg that outlives its reader
    // is an orphan holding a file handle on the library drive.
    res.on('close', () => out.session.kill())
    out.session.stdout.on('error', () => out.session.kill())
    out.session.stdout.pipe(res)
  }

  // --- control -------------------------------------------------------------

  // Is this grant allowed to cast at all? One place, so the media channel can
  // refuse with a typed error before doing any work.
  static allows (grant) {
    return !!grant && !grant.revokedAt && CAST_SCOPES.has(grant.scope)
  }

  // Start (or move) a cast. The HOST decides how the film travels, with the
  // television's capabilities through the same decide() every client goes
  // through - direct for an mp4 the receiver opens, generated otherwise. A
  // refusal throws BEFORE Home Assistant is told anything, so a film that
  // cannot reach this television fails on the phone, not as a black screen.
  async play ({ deviceKey, itemId, entityId, at = 0 }) {
    if (!this.speakers.enabled) throw new Error('Home Assistant is not configured')
    await this.start()

    const item = await this.media.getItem(itemId)
    if (!item) throw new Error('no such item')

    const verdict = await this.media.decide({ itemId, capabilities: CAST_CAPS })
    const mode = verdict?.mode
    if (mode !== 'direct' && mode !== 'remux' && mode !== 'transcode') {
      throw new Error(verdict?.reason || 'this film cannot play on that television')
    }
    // A direct cast starts at 0 and the television seeks itself; a generated
    // one starts where the viewer is, because generated bytes cannot seek.
    const startAt = mode === 'direct' ? 0 : Math.max(0, Number(at) || 0)

    // Replace whatever this device had on this entity, rather than stacking
    // tokens: one device plays one thing on one television.
    const prev = this.byDevice.get(deviceKey)?.get(entityId)
    if (prev) this.tokens.delete(prev.token)

    const token = newToken()
    this.tokens.set(token, {
      deviceKey,
      itemId,
      entityId,
      mode,
      at: startAt,
      expiresAt: Date.now() + TOKEN_TTL_MS
    })

    let set = this.byDevice.get(deviceKey)
    if (!set) {
      set = new Map()
      this.byDevice.set(deviceKey, set)
    }
    set.set(entityId, { token, itemId, mode, at: startAt, startedAt: Date.now(), sawPlaying: false, lastReportAt: 0 })

    // castHost(), not loopback: the television fetches this URL ITSELF.
    const url = `http://${castHost()}:${this.port}/v/${token}`
    try {
      // The title rides along for the receiver's own display - a Roku shows
      // it on its player, a Cast device on its loading screen.
      await this.speakers.play(entityId, url, { title: item.title || null })
    } catch (e) {
      // Do not leave a live token behind for a play that never started.
      this.tokens.delete(token)
      set.delete(entityId)
      if (!set.size) this.byDevice.delete(deviceKey)
      throw e
    }

    this.log('cast:play', { device: String(deviceKey).slice(0, 8), entityId, itemId, mode, at: startAt })
    this._startPolling()
    return { ok: true, mode, at: startAt }
  }

  async stop (deviceKey, entityId) {
    const set = this.byDevice.get(deviceKey)
    const row = set?.get(entityId)
    if (row) {
      await this._reportRow(deviceKey, entityId, row).catch(() => {})
      this.tokens.delete(row.token)
      set.delete(entityId)
      if (!set.size) this.byDevice.delete(deviceKey)
    }
    await this.speakers.stop(entityId).catch(() => {})
    if (!this.byDevice.size) this._stopPolling()
    return { ok: true }
  }

  // THE REVOKE PATH, wired into the package's `silence` hook so it runs
  // wherever connections are killed. Kills the tokens AND stops the
  // televisions - the token alone would leave the room playing out whatever
  // the device had already buffered, and video buffers are MINUTES.
  async stopFor (deviceKey) {
    const set = this.byDevice.get(deviceKey)
    if (!set || !set.size) return 0
    const entities = [...set.keys()]
    for (const row of set.values()) this.tokens.delete(row.token)
    this.byDevice.delete(deviceKey)

    let stopped = 0
    for (const entityId of entities) {
      try {
        await this.speakers.stop(entityId)
        stopped++
      } catch (e) {
        // Log loudly. A television we failed to darken is a security-relevant
        // failure, not a cosmetic one.
        this.log('cast:stop-failed', { entityId, err: e?.message })
      }
    }
    this.log('cast:stopped-for-device', {
      device: String(deviceKey).slice(0, 8), entities: entities.length, stopped
    })
    if (!this.byDevice.size) this._stopPolling()
    return stopped
  }

  async stopForAll (deviceKeys) {
    let n = 0
    for (const k of deviceKeys) n += await this.stopFor(k)
    return n
  }

  // Every device with a live cast, for the package's expiry sweep: a phone can
  // start a cast and close the app, and a connection-only sweep would never
  // look at that device again while its film kept playing.
  deviceKeys () {
    return [...this.byDevice.keys()]
  }

  // Which entities a device currently has playing, so a phone reopening the
  // app can re-attach to a cast it started.
  active (deviceKey) {
    const set = this.byDevice.get(deviceKey)
    if (!set) return []
    return [...set.entries()].map(([entityId, row]) => ({
      entityId, itemId: row.itemId, mode: row.mode, at: row.at, startedAt: row.startedAt
    }))
  }

  // --- the poll ------------------------------------------------------------
  //
  // Two jobs while a cast is live: notice the film ENDED (the television has
  // no queue and nobody else can see it finish), and write the television's
  // POSITION into watch state on the phone's own cadence - put the phone down,
  // cast from the sofa, pick the film up on a laptop at the right minute.
  _startPolling () {
    if (this.timer || !this.byDevice.size) return
    this.timer = setInterval(() => { this._poll().catch(() => {}) }, POLL_MS)
    this.timer.unref?.()
  }

  _stopPolling () {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  // Where the television is NOW. HA reports position as of a stamp, not live,
  // so while playing the elapsed time since the stamp is part of the answer.
  _positionMs (row, state) {
    if (state.position === null || state.position === undefined) return null
    let sec = Number(state.position) || 0
    if (state.state === 'playing' && state.positionUpdatedAt) {
      const stamped = Date.parse(state.positionUpdatedAt)
      if (Number.isFinite(stamped)) sec += Math.max(0, (Date.now() - stamped) / 1000)
    }
    // A generated stream starts its clock at zero wherever it actually began,
    // so the cast's own start offset is part of the true position.
    return Math.round((row.at + sec) * 1000)
  }

  // One last honest write on the way out, so a viewer who stops a cast finds
  // the film at the right minute on their next device.
  async _reportRow (deviceKey, entityId, row) {
    if (!this.report) return
    const s = await this.speakers.getState(entityId).catch(() => null)
    if (!s) return
    const positionMs = this._positionMs(row, s)
    if (positionMs === null || positionMs <= 0) return
    await this.report({ deviceKey, itemId: row.itemId, positionMs })
    row.lastReportAt = Date.now()
  }

  async _poll () {
    for (const [deviceKey, set] of [...this.byDevice.entries()]) {
      for (const [entityId, row] of [...set.entries()]) {
        let state
        try {
          state = await this.speakers.getState(entityId)
        } catch {
          continue // HA blipped; try again next tick rather than ending the cast
        }
        if (!state) continue

        if (state.state === 'playing' || state.state === 'paused') {
          if (state.state === 'playing') row.sawPlaying = true
          if (this.report && row.sawPlaying && Date.now() - row.lastReportAt >= REPORT_MS) {
            const positionMs = this._positionMs(row, state)
            if (positionMs !== null && positionMs > 0) {
              this.report({ deviceKey, itemId: row.itemId, positionMs }).catch(() => {})
              row.lastReportAt = Date.now()
            }
          }
          continue
        }

        // `sawPlaying` guards the startup race: an entity is still 'idle' for
        // a beat after play_media returns. 'unavailable' means HA or the
        // device went away - the end of the cast, not something to retry.
        const ended = row.sawPlaying && (state.state === 'idle' || state.state === 'off' ||
          state.state === 'standby' || state.state === 'unavailable')
        if (!ended) continue

        this.tokens.delete(row.token)
        set.delete(entityId)
        if (!set.size) this.byDevice.delete(deviceKey)
        this.log('cast:ended', { device: String(deviceKey).slice(0, 8), entityId, state: state.state })

        // An idle television reports no position, so the credits moment is
        // the one write we make on trust: the film RAN OUT, which is what
        // ended means to watch state.
        if (this.report) {
          this.report({ deviceKey, itemId: row.itemId, positionMs: null, ended: true }).catch(() => {})
        }
        if (this.presence) {
          this.presence.notify(deviceKey, 'cast:ended', { entityId, itemId: row.itemId })
        }
      }
    }
    if (!this.byDevice.size) this._stopPolling()
  }
}

module.exports = { CastSessions, CAST_SCOPES, CAST_CAPS, TOKEN_TTL_MS, castHost, BIND }
