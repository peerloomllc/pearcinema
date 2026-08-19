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
const { canSeek } = require('./speakers')

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

// What the receiver actually plays, declared the way any client declares
// itself - PER FAMILY, because the living room proved the two main families
// disagree. Conservative on purpose: an HEVC-capable device gets an H.264
// conversion it did not strictly need, which costs the engine some work; the
// liberal list would hand an older device a film it plays as a black screen,
// which costs the feature its credibility.
// WHETHER A TELEVISION WILL TAKE AN UNBOUNDED PROGRESSIVE STREAM, declared with the
// codecs because it is the same kind of fact and belongs in the same place. A
// generated stream has no length and no byte offsets, so it answers 200 with
// `accept-ranges: none`; a Chromecast plays that happily and a Roku refuses it
// outright ("Full-content response on a range request:200", its own error field).
// The transport is chosen from THIS rather than from the conversion mode - those
// are different questions, and treating them as one is what left a remuxed film
// stalling on a Roku while a transcoded one played.
const CAST_CAPS = {
  // The Default Media Receiver: H.264 in MP4 and nothing Matroska.
  containers: ['mp4', 'mov'],
  videoCodecs: ['h264'],
  audioCodecs: ['aac', 'mp3'],
  // STEREO, and this is the fix for a silent television. See ROKU_CAPS below.
  maxAudioChannels: 2,
  progressive: true
}
const ROKU_CAPS = {
  // A Roku opens Matroska natively (mkv is on its documented format list), so
  // most of a real library DIRECT-plays with Range and real seek - the best
  // transport there is. Video stays h264-only: the 4K sticks decode HEVC but
  // the Express class does not, and per-model caps are a refinement for the
  // day a real HEVC-capable Roku shows the need.
  containers: ['mp4', 'mov', 'matroska', 'mkv'],
  videoCodecs: ['h264'],
  audioCodecs: ['aac', 'mp3'],
  // STEREO ONLY, AND THE CODEC LIST ALONE HID THIS FOR MONTHS. A Roku decodes AAC
  // and does NOT decode AAC 5.1: handed one it plays the picture in perfect silence,
  // which is the worst kind of failure because nothing looks wrong. Found by Tim
  // casting Avatar S01E02 (matroska, h264, AAC 5.1) on 2026-08-19 - the device
  // reported `audio="none"` while the video played - and proven by re-encoding the
  // same twenty seconds to stereo and hearing it come back.
  //
  // A film that needs this now takes the remux path with its soundtrack mixed down,
  // which is the cheapest conversion there is.
  maxAudioChannels: 2,
  // AND IT WILL NOT TAKE THAT REMUX PROGRESSIVELY. Measured on Tim's Streaming
  // Stick Plus 2026-08-19: a generated stream is refused with a range error before
  // a frame is drawn. Everything generated reaches this device in segments.
  progressive: false
}

function capsFor (entityId) {
  return /roku/i.test(String(entityId)) ? ROKU_CAPS : CAST_CAPS
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

// WHICH SEGMENT HOLDS A MOMENT, and where that segment truly begins. Two shapes
// answer, and the arithmetic one is only correct for the even grid a re-encode
// produces: `boundaries` is authoritative whenever the host sends it, which it does
// for every copied stream. Snapping BACK (the last boundary at or before the time)
// keeps a resume from stepping over the seconds it was meant to land on.
function segmentAt (at, out) {
  const seconds = Math.max(0, Number(at) || 0)
  const boundaries = out?.boundaries
  if (Array.isArray(boundaries) && boundaries.length) {
    let k = 0
    while (k + 1 < boundaries.length && boundaries[k + 1] <= seconds) k++
    return k
  }
  return Math.floor(seconds / (out?.segmentSeconds || 4))
}

function segmentStart (seq, out) {
  const boundaries = out?.boundaries
  if (Array.isArray(boundaries) && boundaries.length) {
    return boundaries[Math.min(seq, boundaries.length - 1)]
  }
  return seq * (out?.segmentSeconds || 4)
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
      const m = /^\/v\/([A-Za-z0-9_-]+)(?:\/(index\.m3u8|\d+\.ts))?$/.exec(url.pathname)
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
      // device fail its next fetch mid-film - and on an HLS cast the next
      // fetch is at most one segment away.
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

      const sub = m[2] || null
      if (sub === 'index.m3u8') return this._servePlaylist(req, res, entry, deny)
      if (sub) return this._serveSegment(req, res, entry, Number(sub.slice(0, -3)), deny)
      if (entry.mode === 'direct') return this._serveDirect(req, res, entry, deny)
      return this._serveGenerated(req, res, entry, deny)
    } catch (e) {
      this.log('cast:serve-failed', { err: e?.message })
      try { deny(500) } catch {}
    }
  }

  // The playlist, sliced to START at the resume segment: an HLS receiver
  // cannot be told where to begin, so the playlist begins there instead - the
  // web player's restart shape, one level up. Segment NAMES keep their true
  // indices, so each fetch maps to the right minutes of film and the
  // position arithmetic in the poll stays honest through row.at.
  //
  // WHICH SEGMENT A RESUME LANDS IN is no longer arithmetic. A copied picture is
  // cut on the film's own keyframes, so segments are uneven - measured from 4.0 s
  // to 14.0 s on real films - and dividing by four would name a segment that does
  // not start where it claims. The host sends the real boundaries and the resume
  // snaps BACK to the last one at or before where the viewer was, so a resume
  // rewinds by up to one group of pictures rather than skipping past anything.
  async _servePlaylist (req, res, entry, deny) {
    const out = await this.media.playlist({ itemId: entry.itemId, capabilities: entry.caps || CAST_CAPS })
    if (!out?.playlist) return deny(409)

    let body = out.playlist
    const skip = segmentAt(entry.at, out)
    if (skip > 0) {
      const lines = body.split('\n')
      const kept = []
      let dropped = 0
      for (let i = 0; i < lines.length; i++) {
        const seg = /^(\d+)\.ts$/.exec(lines[i])
        if (seg && Number(seg[1]) < skip) {
          // The EXTINF line above this segment goes with it.
          if (kept.length && kept[kept.length - 1].startsWith('#EXTINF')) kept.pop()
          dropped++
          continue
        }
        kept.push(lines[i])
      }
      body = kept.join('\n')
      // The true start of what remains, so a player's clock does not guess.
      body = body.replace(/#EXT-X-MEDIA-SEQUENCE:\d+/, `#EXT-X-MEDIA-SEQUENCE:${skip}`)
      // Every segment actually served begins at skip - keep row.at exact, because
      // the poll adds it to whatever the television reports. Measured on a Roku
      // 2026-08-19: it reports position against the PLAYLIST it was given, not
      // against the timestamps inside the segments, so this offset is the whole
      // difference between a resumed film reporting its true minute and reporting
      // the minutes since the resume.
      entry.at = segmentStart(skip, out)
      // AND THE ROW, which is the copy the poll actually reads. These were allowed
      // to drift apart while the snap was at most four seconds; on a copied stream
      // it is up to a whole group of pictures, and a position report that is
      // fourteen seconds out is a resume that lands in the wrong scene.
      const row = this.byDevice.get(entry.deviceKey)?.get(entry.entityId)
      if (row) row.at = entry.at
      this.log('cast:playlist-sliced', { skip, dropped, engine: out.engine || 'encode' })
    }

    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' })
    if (req.method === 'HEAD') return res.end()
    res.end(body)
  }

  async _serveSegment (req, res, entry, seq, deny) {
    let session
    try {
      session = await this.media.segment({ itemId: entry.itemId, seq, capabilities: entry.caps || CAST_CAPS })
    } catch (e) {
      if (e.code === 'BUSY') return deny(503)
      throw e
    }
    if (!session) return deny(404)

    res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' })
    if (req.method === 'HEAD') { session.kill(); return res.end() }
    // The per-segment ffmpeg dies with its reader, same as every generated
    // path - a receiver seeking away must free the engine slot at the seek.
    res.on('close', () => session.kill())
    session.stdout.on('error', () => session.kill())
    session.stdout.pipe(res)
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

    const container = String(item.media?.container || '').toLowerCase()
    res.writeHead(range ? 206 : 200, {
      // Honest about Matroska - a Roku direct-plays it and deserves the
      // right label; everything else direct is the ISO family.
      'content-type': ['matroska', 'mkv'].includes(container) ? 'video/x-matroska' : 'video/mp4',
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
    // Reworded 2026-08-18: casting no longer requires Home Assistant, so naming it here
    // sent an owner who has none off to configure software they do not need.
    if (!this.speakers.enabled) throw new Error('no way to reach a television from this library')
    await this.start()

    const item = await this.media.getItem(itemId)
    if (!item) throw new Error('no such item')

    const caps = capsFor(entityId)
    const verdict = await this.media.decide({ itemId, capabilities: caps })
    const mode = verdict?.mode
    if (mode !== 'direct' && mode !== 'remux' && mode !== 'transcode') {
      throw new Error(verdict?.reason || 'this film cannot play on that television')
    }

    // HOW THE FILM TRAVELS, the living room's measured lesson (2026-08-17,
    // corrected 2026-08-19):
    //
    //   direct     the raw file, Range honoured, the television seeks itself.
    //   generated  HLS when this television refuses progressive streams,
    //              progressive otherwise. Segments also mean revoke bites within
    //              one segment rather than one film.
    //
    // THE TRANSPORT IS NOT THE MODE. Until today this branched on
    // `mode === 'transcode'`, which quietly assumed that a converted film is a
    // re-encoded one. The 5.1 fix broke that assumption the day it shipped: it
    // started sending films down the REMUX path, which took the progressive
    // branch, which a Roku refuses. What decides is what the television accepts.
    // What the film needs decided separately, inside the segment engine, where a
    // copied picture stays copied.
    //
    // A direct cast starts at 0 and the television seeks itself; a generated
    // one starts where the viewer is - HLS by slicing the playlist to begin
    // at the resume segment, progressive by -ss.
    // A television that refuses progressive takes everything generated in segments.
    // One that accepts progressive keeps exactly the behaviour it was measured with:
    // a re-encode still rides segments there (revoke bites within one segment rather
    // than one film), and a remux still goes down the pipe. Nothing about fixing the
    // Roku wanted to move the Cast family.
    const viaHls = mode !== 'direct' && (caps.progressive === false || mode === 'transcode')
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
      caps,
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
    const base = `http://${castHost()}:${this.port}/v/${token}`
    const url = viaHls ? `${base}/index.m3u8` : base
    // THE FORMAT HINT DESCRIBES WHAT THE TELEVISION WILL RECEIVE, not what is on the
    // disk, and those stop being the same thing the moment anything is converted.
    //
    // Found on Tim's Roku 2026-08-19, minutes after the 5.1 fix started sending films
    // down the remux path for the first time: the film is Matroska, the remux output is
    // always fragmented MP4, and this line still said "mkv" because it read the SOURCE
    // container. The television dutifully tried to demux an MP4 as Matroska and sat at
    // 13% forever. It is load-bearing on a Roku specifically - the format hint is what
    // its player picks a demuxer with.
    const format = viaHls
      ? 'hls'
      : mode !== 'direct'
        ? 'mp4'
        : ['matroska', 'mkv'].includes(String(item.media?.container || '').toLowerCase()) ? 'mkv' : 'mp4'
    try {
      // The title rides along for the receiver's own display - a Roku shows
      // it on its player, a Cast device on its loading screen.
      await this.speakers.play(entityId, url, { title: item.title || null, format })
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

  // --- skipping about, from the phone acting as the remote -----------------
  //
  // RELATIVE, not absolute, and deliberately so: the host already knows where
  // the film is (it polls for exactly that, and _positionMs is the only place
  // that gets a generated stream's offset right). A phone sending "back thirty
  // seconds" cannot disagree with it; a phone sending an absolute position it
  // worked out from a stale poll can, and would land the film somewhere nobody
  // asked for.
  //
  // The two transports skip by entirely different means:
  //
  //   direct     the television is playing a file and seeking is its own job,
  //              so ask Home Assistant to seek it. Some televisions cannot -
  //              a Roku's media_player does not declare SEEK - and the honest
  //              answer there is to say so, because the alternative is a
  //              re-cast that would restart a direct stream from the very
  //              beginning (play() pins a direct cast's `at` to 0).
  //   generated  the stream's own clock starts wherever it began, so skipping
  //              means minting it again at the new offset. That is play(),
  //              which already slices an HLS playlist to a start point.
  async seek ({ deviceKey, entityId, deltaMs }) {
    const row = this.byDevice.get(deviceKey)?.get(entityId)
    if (!row) throw new Error('nothing is playing on that television')

    const state = await this.speakers.getState(entityId)
    if (!state) throw new Error('that television is not answering')

    const nowMs = this._positionMs(row, state)
    if (nowMs === null) throw new Error('that television does not say where it is')

    const durationMs = state.duration ? Math.round(Number(state.duration) * 1000) : 0
    // Clamped so a skip near either end is a no-op rather than an error. The
    // eight seconds off the end keep a forward skip from tipping the film into
    // its own ending, which the poll would then report as watched.
    const ceiling = durationMs > 8000 ? durationMs - 8000 : null
    let targetMs = Math.max(0, nowMs + Number(deltaMs || 0))
    if (ceiling !== null) targetMs = Math.min(targetMs, ceiling)

    if (row.mode === 'direct') {
      if (!canSeek(state.supportedFeatures)) {
        throw new Error('this television cannot skip while playing this film')
      }
      await this.speakers.seek(entityId, targetMs / 1000)
      return { ok: true, mode: row.mode, positionMs: targetMs, restarted: false }
    }

    // A generated stream is re-minted at the new offset. play() replaces this
    // device's token for this entity, so nothing is left holding the old one.
    await this.play({ deviceKey, itemId: row.itemId, entityId, at: Math.floor(targetMs / 1000) })
    return { ok: true, mode: row.mode, positionMs: targetMs, restarted: true }
  }

  // Where the film is, for a phone acting as the remote.
  //
  // NOT the same as asking the television, which is why this exists. A
  // generated stream's own clock starts at zero wherever the film began, so a
  // Roku forty minutes in reports forty minutes MINUS the start offset - and an
  // HLS playlist sliced to a resume point reports the length of what is left
  // rather than the length of the film. Both corrections live here: the
  // position is the row's offset plus the television's clock, and the duration
  // comes from the ITEM, which is the only thing that knows how long the film
  // actually is.
  async where ({ deviceKey, entityId }) {
    const row = this.byDevice.get(deviceKey)?.get(entityId)
    if (!row) return null
    const state = await this.speakers.getState(entityId).catch(() => null)
    if (!state) return null
    const item = await this.media.getItem(row.itemId).catch(() => null)
    return {
      itemId: row.itemId,
      mode: row.mode,
      state: state.state,
      positionMs: this._positionMs(row, state),
      durationMs: item?.runtime ? Math.round(Number(item.runtime) * 1000) : null
    }
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

module.exports = { CastSessions, CAST_SCOPES, CAST_CAPS, ROKU_CAPS, TOKEN_TTL_MS, castHost, BIND, capsFor, segmentAt, segmentStart }
