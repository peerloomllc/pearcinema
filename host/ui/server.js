// The PearCinema web interface: the operator's control plane AND a player.
//
// WHY IT IS BOTH. PearTune's dashboard manages a library; you listen on a phone.
// That answer does not survive the move to video, for two reasons that are not
// preferences:
//
//   1. It is the fastest route to actually watching something. Everything else on
//      the roadmap is weeks of phone work; this is reachable the day it exists.
//   2. A browser is a SECOND compatibility engine, with published rules, run
//      against the same library. "Which of these files actually play" stops being
//      an opinion. The answer it gives is bleak on purpose - see the player.
//
// WHAT IS INHERITED AND WHAT IS NOT. The LOCK is @peerloom/host's
// (createDashboardAuth / requireSafeBind / resolveDashboardPassword) - written and
// tested once, because two divergent copies of a control-plane gate is a security
// problem rather than a tidiness one. The PAGE is ours, because it carries our
// branding and our screens.
//
// AUTH IS NOT OPTIONAL HERE, AND IT IS STRICTER THAN PEARTUNE'S NEEDED TO BE.
// PearTune's dashboard could revoke devices and open pairing windows. This one does
// that AND serves library bytes: /api/stream hands out the actual film. So the
// player sits BEHIND the gate, never beside it, and there is no capability-token
// side door for it - a <video> element on a same-origin page carries the session
// cookie, so it needs no help. requireSafeBind still refuses to start on a
// non-loopback bind with no password, which is what makes that guarantee real.
//
// THE PAGE IS BUILT, NOT WRITTEN AS A STRING. PearTune's dashboard was a 700-line
// hand-written template literal until a syntax error inside the string produced a
// blank control plane that every test passed straight through. It is a Preact app
// under host/ui/app/, bundled by scripts/build-dashboard.mjs into one committed
// self-contained HTML file, which this reads once at startup.

const http = require('http')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const QRCode = require('qrcode')
const z32 = require('z32')

const {
  createDashboardAuth, requireSafeBind
} = require('@peerloom/host')

const { browse } = require('../browse')
const { detectSources } = require('../detect')
const items = require('../items')
const remux = require('../remux')

// The browser's capability description, as the local /api/remux reads it - one
// parser for both the local route and the remote twins.
function capsFromQuery (url) {
  return {
    containers: (url.searchParams.get('containers') || 'mp4').split(',').filter(Boolean),
    videoCodecs: (url.searchParams.get('video') || 'h264').split(',').filter(Boolean),
    audioCodecs: (url.searchParams.get('audio') || 'aac').split(',').filter(Boolean)
  }
}
const watch = require('../watch')
const { MEDIA_CHANNEL_NAME } = require('../roku')
const subtitleRules = require('../subtitles')
const { siblings } = require('../siblings')
const mergeLib = require('../../src/merge')

// A bounded fan over the wire: the remote rollups ask one episode list per
// series, and a library of shows should neither go one-at-a-time nor open
// thirty concurrent requests on somebody else's box.
async function eachLimit (rows, limit, fn) {
  const queue = [...rows]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift())
  })
  await Promise.all(workers)
}

// Mark one remote id watched, expanding a show or a season to its episodes -
// the local route's rule, fanned over the wire because watched.set is per
// item. Shared by the remote twin and the blend's write fan.
async function remoteWatched (remote, lib, id, on) {
  const item = await remote.call(lib, 'library.get', { id }).catch(() => null)
  if (item && (item.type === 'series' || item.type === 'season')) {
    const eps = (await remote.call(lib, 'library.list', {
      type: 'episodes',
      ...(item.type === 'series' ? { seriesId: item.id } : { seasonId: item.id }),
      limit: 500
    })).items || []
    await eachLimit(eps, 8, (e) => remote.call(lib, 'watched.set', { itemId: e.id, watched: on }))
    return { ok: true, watched: on, items: eps.length }
  }
  return remote.call(lib, 'watched.set', { itemId: id, watched: on })
}

const PAGE_FILE = path.join(__dirname, 'dashboard.html')
const LOGIN_PAGE = require('./login')

function json (res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': buf.length,
    'cache-control': 'no-store'
  })
  res.end(buf)
}

async function readBody (req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return {}
  }
}

// An adapter hands back either a Node Readable (the folder source, off disk) or a
// web ReadableStream (the Jellyfin source, straight off fetch). Both are async
// iterable, which is how the P2P side consumes them, but only one can be piped at
// an http response - so normalize rather than branching at every use.
function toNodeStream (stream) {
  if (!stream) return null
  return typeof stream.pipe === 'function' ? stream : Readable.fromWeb(stream)
}

// The container's MIME type. NOT a playability claim: a browser is free to refuse
// video/x-matroska, and it will. This only labels the bytes honestly so the browser
// can make its own decision, which is the whole point of using it as a second
// compatibility engine.
//
// `mov` maps to video/mp4 on purpose. ffprobe reports the whole ISO base media
// family as `mov,mp4,m4a,3gp,3g2,mj2` and host/probe.js keeps the first word, so a
// perfectly ordinary .mp4 arrives here labelled `mov`. QuickTime and MP4 go through
// the same demuxer in every browser, and video/mp4 is the label that makes
// canPlayType answer usefully - video/quicktime makes it answer "".
const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  matroska: 'video/x-matroska',
  'matroska,webm': 'video/x-matroska',
  avi: 'video/x-msvideo',
  'avi,divx': 'video/x-msvideo',
  ts: 'video/mp2t',
  mpegts: 'video/mp2t',
  m2ts: 'video/mp2t',
  wmv: 'video/x-ms-wmv',
  asf: 'video/x-ms-asf',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  'mov,mp4,m4a,3gp,3g2,mj2': 'video/mp4'
}

function mimeFor (container) {
  return MIME[String(container || '').toLowerCase()] || 'application/octet-stream'
}

// `bytes=0-`, `bytes=1000-2000`, `bytes=-500`. Anything else is not a range we
// serve, and answering the whole file is the correct response to an unsatisfiable
// or malformed one rather than a 400 - a browser that asked badly still wants video.
function parseRange (header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m

  let start
  let end
  if (rawStart === '') {
    if (rawEnd === '') return null
    // A suffix range: the LAST n bytes. Safari asks for this to read the moov atom
    // at the end of an MP4, so a player that ignores it never starts.
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size) return { unsatisfiable: true }
  if (end >= size) end = size - 1
  if (end < start) return { unsatisfiable: true }
  return { start, end }
}

// SubRip in, WebVTT out. A <track> element accepts WebVTT and nothing else, and the
// difference between the two formats is a header line and a comma. Doing it here
// rather than asking every source for VTT keeps the conversion in one place and
// costs nothing.
//
// Only TEXT subtitles ever reach this. The image-based ones (PGS, and per the real
// library measurement they are roughly one per FILM) are marked unplayable by the
// adapter and never requested - burning those in needs a full re-encode, which this
// version does not have.
function srtToVtt (text) {
  const body = String(text)
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return body.startsWith('WEBVTT') ? body : 'WEBVTT\n\n' + body
}

// WHO IS WATCHING, in a browser.
//
// Every phone arrives with a grant, so the package derives its owner from the
// Noise-authenticated connection and nothing has to be asked. The dashboard arrives
// with a password and nothing else, and watch state is per PERSON by design (Tim,
// 2026-08-13) - so the browser has to say which person it is watching as.
//
// THIS IS NOT AUTHENTICATION AND MUST NOT BE DRESSED UP AS IT. Anyone holding the
// dashboard password can already see the whole library; choosing a person only
// decides whose history a position is filed under. It selects an EXISTING person and
// never becomes one, so there is no second identity system here - the `person:` rows
// the operator already manages are the only ones.
//
// The cookie is separate from the session cookie on purpose: logging out must not
// forget who was watching, and the session cookie is a credential where this is a
// preference.
const WATCH_COOKIE = 'pearcinema-person'

function cookieValue (req, name) {
  const raw = req.headers.cookie || ''
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null
}

async function collect (stream, limit = 8 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const c of stream) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
    total += buf.length
    if (total > limit) break
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function startDashboard ({
  host,
  bind = '127.0.0.1',
  port = 8751,
  password = '',
  passwordSource = 'none',
  version = null,
  log = () => {}
} = {}) {
  // Before anything listens. A control plane that can revoke every device, open a
  // pairing window onto the whole library and stream the films themselves is not
  // something we are willing to run unauthenticated on a LAN, so this throws rather
  // than warns.
  requireSafeBind(bind, password, { envVar: 'PEARCINEMA_PASSWORD' })

  // The cookie is named per app by the package, because a box running PearTune on
  // 8741 and PearCinema on 8751 shares an ORIGIN as far as cookies are concerned -
  // they ignore the port. One cookie name would mean logging into one dashboard
  // logs you into the other.
  const auth = createDashboardAuth({ app: host.protocol.app, password })

  // Read once at startup. The file is committed and copied into the image, so a
  // page load never touches disk - and a missing build is a startup failure with a
  // sentence to act on rather than a 500 the first time somebody opens a browser.
  let PAGE
  try {
    PAGE = fs.readFileSync(PAGE_FILE, 'utf8')
  } catch {
    throw new Error(
      `the dashboard has not been built: ${PAGE_FILE} is missing.\n` +
      '  Run `npm run build:dashboard` and commit the result.'
    )
  }

  let pwSource = passwordSource

  // THE CODE FOR THE WINDOW THAT IS CURRENTLY OPEN, so a page loaded after it was
  // opened - a reload, a second tab, a phone brought to the machine - shows the same
  // QR rather than an empty white panel. Keyed by the link, so a stale one from a
  // previous window can never be handed out for a new one.
  let openQr = null

  // --- the live channel ----------------------------------------------------
  //
  // Requests are the first thing on this page that has to ARRIVE rather than be
  // asked for: an ask reaches the operator, an answer reaches the asker, and
  // neither side should have to reopen a card to find out. The phone already had
  // this over its own connection; the browser had a 10s poll standing in.
  //
  // Server-sent events rather than a websocket, because the traffic is one-way
  // and tiny, EventSource reconnects on its own, and it rides the same cookie the
  // rest of the page already carries - every route below this point is past the
  // auth gate. Best-effort throughout: a browser that misses a frame still has
  // the card's own load, and a write to a dead socket is not news.
  const liveClients = new Set()
  function live (kind, data = null) {
    if (liveClients.size === 0) return 0
    const frame = `data: ${JSON.stringify({ kind, data })}\n\n`
    let n = 0
    for (const res of liveClients) {
      try { res.write(frame); n++ } catch {}
    }
    return n
  }

  // Asks and answers reaching THIS host over P2P - a phone asking for a film,
  // or this host's owner answering one. host/server.js hands them over.
  host.onevent = (kind, data) => live(kind, data)

  // The same news from a library this machine is paired WITH, where this machine
  // is the asker and the answer arrives from the friend's host. Without this the
  // client dropped every push it was sent.
  if (host.remote) {
    host.remote.onpush = (libraryId, m) => {
      if (!m || !m.kind) return
      live(m.kind, { ...(m.data || {}), libraryId })
    }
  }

  // The person this browser is watching as, as an ownerId the state store accepts.
  //
  // LAZY, and that matters: a host nobody has ever watched anything on holds no
  // person it did not need. The first write creates one, named plainly and
  // renameable in People like any other, and a single-person household never meets a
  // choice - which is what Tim asked for (2026-08-13). A second person on the box is
  // what makes the dashboard's selector worth showing.
  async function watcher (req, { create = false } = {}) {
    const persons = (await host.grants.listPersons()).filter(p => !p.revokedAt)
    const asked = cookieValue(req, WATCH_COOKIE)

    // A cookie naming somebody who has since been deleted must not silently file a
    // film under a stranger, so it is checked against the live list rather than
    // trusted.
    const chosen = asked && persons.find(p => p.id === asked)
    if (chosen) return { owner: 'p:' + chosen.id, person: chosen, persons }

    if (persons.length === 1) return { owner: 'p:' + persons[0].id, person: persons[0], persons }
    // Several people and no choice made: do NOT guess. Watch state filed under the
    // wrong person is worse than none, and the UI asks instead.
    if (persons.length > 1) return { owner: null, person: null, persons }

    if (!create) return { owner: null, person: null, persons }
    const made = await host.grants.addPerson('Me')
    log('dashboard:watcher-created', { person: made.id.slice(0, 8) })
    return { owner: 'p:' + made.id, person: made, persons: [made] }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    try {
      // Login, logout and the 401 for everything else - including /api/stream, so
      // there is no unauthenticated path to a single byte of the library. Returns
      // true if it dealt with the request itself.
      if (auth.enabled && auth.handle(req, res, url)) return

      // --- the page ---
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') {
        const html = auth.enabled && !auth.guard(req) ? LOGIN_PAGE : PAGE
        const body = Buffer.from(html)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length })
        return req.method === 'HEAD' ? res.end() : res.end(body)
      }

      // --- the live channel ---------------------------------------------------
      // Held open for the life of the tab. The comment heartbeat is what keeps a
      // silent night from looking like a dead socket to anything in between, and
      // the close handler is not optional: without it every reload leaks a
      // response object that later writes throw into.
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          // Nothing here is proxied today, but a buffering proxy would hold the
          // whole point of this route in a buffer.
          'x-accel-buffering': 'no'
        })
        res.write(': open\n\n')
        liveClients.add(res)
        const beat = setInterval(() => { try { res.write(': beat\n\n') } catch {} }, 25000)
        const drop = () => { clearInterval(beat); liveClients.delete(res) }
        req.on('close', drop)
        res.on('close', drop)
        return
      }

      // --- what the whole dashboard runs on -----------------------------------
      if (req.method === 'GET' && url.pathname === '/api/state') {
        // A BROKEN SOURCE MUST NOT BREAK THE DASHBOARD. stats() talks to the source,
        // so an unreachable Jellyfin or an unplugged drive makes it throw - and a
        // 500 here would blank the one page the operator needs in order to fix it.
        // Answer zeroes and let sourceError carry the news.
        const stats = await host.adapter.stats().catch(() => ({
          movies: 0, series: 0, seasons: 0, episodes: 0, source: host.adapter.kind
        }))
        const devices = await host.listDevices()
        const personLabel = await host.grants.personLabels()
        const persons = (await host.grants.listPersons())
          .map(p => ({ ...p, label: personLabel.get(p.id) || p.name }))

        return json(res, 200, {
          library: host.libraryName,
          libraryId: host.libraryId,
          hostKey: z32.encode(host.publicKey),
          version,
          stats,
          sourceError: host.sourceError,
          // Non-null while the library is being read. On the real 3 TB drive the
          // first scan probes 2,986 files and takes minutes, and an empty grid for
          // that long is indistinguishable from a broken app.
          scanning: host.scanning || null,
          // The operator's own view of the source, which is NOT what a phone gets.
          // library.stats deliberately hides the folder paths from paired devices
          // (they are the shape of somebody's disk and no client needs them); the
          // operator owns this box and is the one person who does need them.
          source: {
            kind: host.source?.kind || 'empty',
            from: host.sourceFrom,
            // THE ADAPTER'S NORMALISED ROOTS, not the raw config, so the panel shows
            // what each folder is actually being read AS. A root saved as a bare
            // string (every host in the field before root types existed) comes back
            // as `{ path, type: 'auto', holds }` - and `holds` is what the operator
            // needs to see, because it is what decided whether their nested files
            // became episodes or films.
            roots: host.adapter?.kind === 'folder'
              ? host.adapter.roots
              : (host.source?.roots || (host.source?.root ? [host.source.root] : [])),
            url: host.source?.url || null,
            username: host.source?.username || null
          },
          devices,
          persons,
          // `pairing` is a boolean on the host (is a window open); `pairSession` is
          // the window. Reload the page mid-window and the QR must come back, so
          // this carries the live link rather than only its existence.
          pairing: host.pairing
            ? {
                open: true,
                link: host.pairSession.link,
                // Only when it is a code for THIS window.
                svg: openQr?.link === host.pairSession.link ? openQr.svg : null,
                guest: !!host.pairSession.expiresMs,
                owner: !!host.pairSession.owner,
                expiresMs: host.pairSession.expiresMs || null
              }
            : { open: false },
          auth: { enabled: auth.enabled, passwordSource: pwSource },
          // Whether this box may re-encode video, decided by the startup hardware
          // probe and nothing else. The app folds it into its verdicts: an HEVC
          // refusal on a host that can convert is a film that plays.
          transcode: host.transcode || { available: false, reason: 'not supported by this host' },
          transcodeCap: host.transcodeCap(),
          rescanIntervalMin: host.getRescanIntervalMin(),
          // Enough about the artwork feature for the LIBRARY to act on: whether the
          // tiles should wear a fix control, and the live progress of a pass. Rides
          // here because the page already polls this route - the full summary stays
          // on /api/metadata.
          metadata: { ...host.metadataSettings(), running: host.enricher.running },
          bind
        })
      }

      // --- the library ---------------------------------------------------------
      //
      // These read through the SAME adapter interface the phone's method table
      // uses. They are not a parallel model of the library: `library.list` in
      // methods.js and this route both end at `adapter.list()`, so a browser and a
      // phone can never disagree about what is in the collection.
      if (req.method === 'GET' && url.pathname === '/api/library/list') {
        const type = String(url.searchParams.get('type') || 'movies')
        if (!items.LIST_TYPES.has(type)) return json(res, 400, { error: `unknown list type: ${type}` })
        const seriesId = url.searchParams.get('seriesId') || null
        const seasonId = url.searchParams.get('seasonId') || null
        if (type === 'seasons' && !seriesId) return json(res, 400, { error: 'seriesId required for seasons' })
        if (type === 'episodes' && !seasonId && !seriesId) {
          return json(res, 400, { error: 'seasonId or seriesId required for episodes' })
        }

        const page = await host.adapter.list({
          type,
          seriesId,
          seasonId,
          limit: url.searchParams.get('limit'),
          cursor: url.searchParams.get('cursor'),
          sort: url.searchParams.get('sort') || items.DEFAULT_SORT[type],
          order: url.searchParams.get('order') === 'desc' ? 'desc' : 'asc'
        }).catch(() => ({ items: [], total: 0, cursor: null }))
        return json(res, 200, page)
      }

      if (req.method === 'GET' && url.pathname === '/api/library/item') {
        const id = url.searchParams.get('id')
        if (!id) return json(res, 400, { error: 'id required' })
        const item = await host.adapter.get({ id: String(id) }).catch(() => null)
        if (!item) return json(res, 404, { error: 'no such item' })
        return json(res, 200, item)
      }

      if (req.method === 'GET' && url.pathname === '/api/library/search') {
        const q = String(url.searchParams.get('q') || '').trim()
        if (!q) return json(res, 200, { items: [] })
        const out = await host.adapter.search({ q, limit: url.searchParams.get('limit') }).catch(() => ({ items: [] }))
        return json(res, 200, out)
      }

      // --- artwork ---
      // Behind the same gate as everything else; an <img> carries the session
      // cookie because it is same-origin.
      if (req.method === 'GET' && url.pathname === '/api/art') {
        const artId = url.searchParams.get('id')
        const stream = artId ? toNodeStream(await host.adapter.art({ artId, size: 400 }).catch(() => null)) : null
        if (!stream) { res.writeHead(404); return res.end() }
        // The folder adapter hangs the real type on the stream (a poster on disk can
        // be a PNG); Jellyfin always re-encodes to JPEG and says nothing.
        res.writeHead(200, {
          'content-type': stream.contentType || 'image/jpeg',
          'cache-control': 'private, max-age=300'
        })
        res.on('close', () => stream.destroy?.())
        return stream.pipe(res)
      }

      // THE EPISODE ON EITHER SIDE, the same walk the phone gets over the wire.
      // The player asks once per episode: it drives Previous and Next, and it is
      // what the card at the end of an episode offers. Answering with two nulls
      // for a film is not an error - the player asks about whatever is playing.
      if (req.method === 'GET' && url.pathname === '/api/siblings') {
        const itemId = url.searchParams.get('itemId')
        if (!itemId) return json(res, 400, { error: 'itemId required' })
        const out = await siblings(host.adapter, String(itemId))
        if (!out) return json(res, 404, { error: 'no such item' })
        return json(res, 200, out)
      }

      // --- subtitles -----------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/subtitles') {
        const itemId = url.searchParams.get('itemId')
        if (!itemId) return json(res, 400, { error: 'itemId required' })
        if (!host.adapter.subtitles) return json(res, 200, { items: [] })
        const list = await host.adapter.subtitles({ itemId: String(itemId) }).catch(() => [])
        // `burnable` mirrors the phone's subtitle.list rule: an unplayable
        // EMBEDDED image track this host could press into the picture instead,
        // offered only when the engine has proven itself.
        return json(res, 200, {
          items: list.map(t => ({
            ...t,
            burnable: !!(host.transcode.available && !t.playable && !t.external && subtitleRules.burnable(t.codec))
          }))
        })
      }

      if (req.method === 'GET' && url.pathname === '/api/subtitle') {
        const itemId = url.searchParams.get('itemId')
        const subtitleId = url.searchParams.get('subtitleId')
        if (!itemId || !subtitleId) return json(res, 400, { error: 'itemId and subtitleId required' })
        if (!host.adapter.subtitle) { res.writeHead(404); return res.end() }
        const raw = toNodeStream(await host.adapter.subtitle({
          itemId: String(itemId), subtitleId: String(subtitleId)
        }).catch(() => null))
        if (!raw) { res.writeHead(404); return res.end() }
        const vtt = srtToVtt((await collect(raw)).toString('utf8'))
        const buf = Buffer.from(vtt)
        res.writeHead(200, {
          'content-type': 'text/vtt; charset=utf-8',
          'content-length': buf.length,
          'cache-control': 'private, max-age=300'
        })
        return res.end(buf)
      }

      // --- THE BYTES -----------------------------------------------------------
      //
      // Straight through host.openStream, which is the same call the phone's
      // `media.stream` makes. The only thing this adds is HTTP: parse Range, set
      // Content-Range, pipe. If seeking ever breaks for one client and not the
      // other, the bug is in this file's arithmetic and nowhere deeper - which is
      // exactly the property having one implementation buys.
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/stream') {
        const id = url.searchParams.get('id')
        if (!id) return json(res, 400, { error: 'id required' })

        const item = await host.adapter.get({ id: String(id) }).catch(() => null)
        if (!item || !items.isLeaf(item.type)) return json(res, 404, { error: 'no such item' })

        const size = item.media?.size || null
        const type = mimeFor(item.media?.container)

        // No known size means no ranges, which means no seeking. Say so with
        // Accept-Ranges rather than accepting a range we cannot honour and handing
        // back the wrong bytes.
        if (!size) {
          res.writeHead(200, { 'content-type': type, 'accept-ranges': 'none', 'cache-control': 'no-store' })
          if (req.method === 'HEAD') return res.end()
          const stream = toNodeStream(await host.openStream({ itemId: String(id) }))
          if (!stream) return res.end()
          res.on('close', () => stream.destroy?.())
          return stream.pipe(res)
        }

        const range = req.headers.range ? parseRange(req.headers.range, size) : null

        if (range?.unsatisfiable) {
          res.writeHead(416, { 'content-range': `bytes */${size}` })
          return res.end()
        }

        const start = range ? range.start : 0
        const end = range ? range.end : size - 1
        const length = end - start + 1

        res.writeHead(range ? 206 : 200, {
          'content-type': type,
          'content-length': length,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
        })
        if (req.method === 'HEAD') return res.end()

        const stream = toNodeStream(await host.openStream({ itemId: String(id), offset: start, length }))
        if (!stream) return res.end()
        // A browser abandons a range the instant the user drags the scrubber. Without
        // this every seek leaks a file handle, and a two-hour film gets scrubbed a lot.
        res.on('close', () => stream.destroy?.())
        return stream.pipe(res)
      }

      // --- GENERATED BYTES: remux and transcode --------------------------------
      //
      // The other half of the player, and the one that turns a tenth of a real
      // library into nearly all of it: 83% of the measured collection is in a
      // container Chrome and Safari will not open, and this hands them the same
      // picture in a box they will. With proven hardware it goes one further and
      // converts the picture itself - the HEVC 76% of the television no browser
      // decodes. The HOST decides which; one route serves both, because to the
      // player they are the same thing: generated MP4 down a socket.
      //
      // NOT SEEKABLE BY RANGE, and it says so. These bytes are generated, so there
      // is no byte 2,400,000,000 to ask for until everything before it has been
      // made. Seeking is the client re-requesting with a new `t`, which is why the
      // response carries the offset it actually started at - `-ss` with `-c copy`
      // lands on the nearest keyframe at or before the asked-for time, and a player
      // that assumed otherwise would show a clock that lies.
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/remux') {
        const id = url.searchParams.get('id')
        if (!id) return json(res, 400, { error: 'id required' })
        const at = Math.max(0, Number(url.searchParams.get('t')) || 0)

        // What the CLIENT says it can open. The host decides from it; a client
        // cannot ask to be remuxed, only describe itself. `burn` is the one
        // deliberate exception in spirit - the viewer CHOSE image subtitles -
        // but it still rides the description and the host still decides: a
        // stale id or a cold engine simply decides as if nothing was asked.
        const caps = {
          containers: (url.searchParams.get('containers') || 'mp4').split(',').filter(Boolean),
          videoCodecs: (url.searchParams.get('video') || 'h264').split(',').filter(Boolean),
          audioCodecs: (url.searchParams.get('audio') || 'aac').split(',').filter(Boolean)
        }
        const burnId = url.searchParams.get('burn')
        if (burnId) caps.burnSubtitleId = String(burnId)

        let out
        try {
          out = await host.openRemux({ itemId: String(id), at, capabilities: caps })
        } catch (e) {
          // BUSY is a real answer, not a failure. A viewer told the host is busy can
          // try again; a viewer watching a spinner assumes it is broken.
          if (e.code === 'BUSY') return json(res, 503, { error: e.message })
          throw e
        }

        if (!out) return json(res, 404, { error: 'no such item' })
        if (out.mode !== 'remux' && out.mode !== 'transcode') {
          // Direct play would work, or nothing will. Either way this route has
          // nothing to do, and saying which is the whole point.
          return json(res, 409, { mode: out.mode, reason: out.reason })
        }

        res.writeHead(200, {
          'content-type': 'video/mp4',
          'accept-ranges': 'none',
          'cache-control': 'no-store',
          'x-pearcinema-mode': out.mode,
          'x-pearcinema-start': String(out.session.at),
          'x-pearcinema-audio': out.session.audio
        })
        if (req.method === 'HEAD') { out.session.kill(); return res.end() }

        // THE PROCESS DIES WITH THE RESPONSE. A browser abandons this the instant
        // the viewer drags the scrubber or closes the tab, and an ffmpeg that
        // outlives its reader is an orphan holding a file handle on the library
        // drive. On a Pi-class box a few of those is the whole box.
        res.on('close', () => out.session.kill())
        out.session.stdout.on('error', () => out.session.kill())
        return out.session.stdout.pipe(res)
      }

      // --- REMOTE LIBRARIES (proposal 2026-08-16-desktop-client) ----------------
      //
      // This machine as a CLIENT of somebody else's library, in these same pages.
      // The routes twin the local read surface under /remote/<lib>/, so the app
      // swaps a base prefix and nothing else changes shape. All of it sits behind
      // the same auth gate as the rest of the dashboard: a remote library must
      // never be reachable to someone the dashboard would refuse.
      const remote = host.remote || null

      // Films kept on THIS machine from those libraries (phase 2). The list is
      // global - downloads from every remote in one card - and the per-library
      // start lives under the twin below, so the page's base-prefix rewrite
      // routes it without knowing anything new.
      const dls = host.downloads || null
      if (dls && req.method === 'GET' && url.pathname === '/api/downloads') {
        return json(res, 200, { items: dls.list() })
      }
      if (dls && req.method === 'POST' && url.pathname === '/api/downloads/cancel') {
        const { itemId } = await readBody(req)
        if (!itemId) return json(res, 400, { error: 'itemId required' })
        return json(res, 200, dls.cancel(String(itemId)))
      }
      if (dls && req.method === 'POST' && url.pathname === '/api/downloads/remove') {
        const { itemId } = await readBody(req)
        if (!itemId) return json(res, 400, { error: 'itemId required' })
        return json(res, 200, dls.remove(String(itemId)))
      }
      // The LOCAL twins of the per-library routes answer honestly rather than
      // 404: the page only asks these of the active library, and the active
      // library being this box means the question does not apply.
      if (req.method === 'POST' && url.pathname === '/api/download') {
        return json(res, 400, { error: 'these films are already on this machine - downloading is for a friend\'s library' })
      }
      if (req.method === 'GET' && url.pathname === '/api/requests') {
        return json(res, 200, { items: [] })
      }

      // WHAT PEOPLE HAVE ASKED **THIS** LIBRARY FOR, which the dashboard has never
      // shown. `/api/requests` above is the other direction - what this machine asked
      // somebody else's library for - and asking your own library is not a thing, so
      // it answers empty and always has. Tim made requests from a paired phone on
      // 2026-08-19 and found nowhere on the dashboard they could appear.
      //
      // The store was built for this: listRequests with no requester is documented in
      // the package as "every request (the operator's dashboard/owner view)", and the
      // wire has had `request.all` for the phone's owner view all along. Only the
      // dashboard was missing.
      // `/api/asked`, NOT `/api/requests/...`, and the name is load-bearing. The
      // dashboard proxies anything matching `/api/requests` to whichever remote
      // library is selected, because asking and withdrawing are per-library - so these
      // two, which are about THIS host and can never be about another, were being sent
      // to somebody else's server and answered "no such remote route" (Tim, 2026-08-19).
      if (req.method === 'GET' && url.pathname === '/api/asked') {
        try {
          const rows = await host.userState.listRequests()
          const labels = await host.grants.personLabels()
          return json(res, 200, {
            items: rows.map((r) => ({
              ...r,
              // WHO ASKED, by the name their owner chose rather than by a key. A
              // request nobody can attribute is one nobody can answer.
              requesterLabel: labels.get(r.requester) || null
            }))
          })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      // AN ANSWERED REQUEST CAN BE CLEARED. Nothing removed them before, so the list
      // only ever grew - a declined ask sat there for good (Tim, 2026-08-19).
      if (req.method === 'POST' && url.pathname === '/api/asked/remove') {
        const body = await readBody(req)
        try {
          const row = await host.userState.getRequest(String(body?.id || ''))
          if (!row) return json(res, 404, { error: 'no such request' })
          await host.userState.deleteRequest(row.id)
          host.onevent?.('request:removed', { id: row.id })
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/asked/resolve') {
        const body = await readBody(req)
        const status = String(body?.status || '')
        if (!['added', 'declined'].includes(status)) return json(res, 400, { error: 'bad status' })
        try {
          const row = await host.userState.resolveRequest(String(body?.id || ''), status)
          if (!row) return json(res, 404, { error: 'no such request' })
          // The requester hears the answer wherever they are signed in - the same
          // push the wire method sends, because it is the same event.
          if (host.host?.presence && row.requester) {
            host.host.presence.notifyOwner(row.requester, 'request:resolved', { id: row.id, title: row.title || null, status })
          }
          host.onevent?.('request:resolved', { id: row.id, title: row.title || null, status })
          return json(res, 200, { request: row })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      if (req.method === 'POST' && (url.pathname === '/api/request' || url.pathname === '/api/request/remove')) {
        return json(res, 400, { error: 'asking is for a friend\'s library - this one is yours' })
      }

      if (remote && req.method === 'GET' && url.pathname === '/api/remote/list') {
        return json(res, 200, { remotes: remote.list() })
      }
      if (remote && req.method === 'POST' && url.pathname === '/api/remote/pair') {
        const { link, label } = await readBody(req)
        if (!link) return json(res, 400, { error: 'link required' })
        try {
          return json(res, 200, await remote.pair(link, { label: label || 'desktop' }))
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      if (remote && req.method === 'POST' && url.pathname === '/api/remote/remove') {
        const { hostKey } = await readBody(req)
        if (!hostKey) return json(res, 400, { error: 'hostKey required' })
        // Kept copies go with the library - looked up BEFORE the removal
        // forgets which library the key named.
        const leaving = remote.list().find((r) => r.hostKey === String(hostKey))
        const out = await remote.remove(String(hostKey))
        if (leaving && dls) dls.removeLib(leaving.libraryId)
        return json(res, 200, out)
      }

      // --- THE BLEND (approved proposal 2026-08-17) ----------------------------
      //
      // All libraries as one collection: the index answers what it holds, and
      // everything that touches BYTES or WRITES state redirects (307, which
      // keeps the method, the body and a Range header) to the owning twin
      // with the copy's own id - one implementation of every route, the
      // base-prefix trick one more time.
      const blend = host.blend || null

      if (blend && req.method === 'GET' && url.pathname === '/api/blend') {
        await blend.ready().catch(() => {})
        return json(res, 200, {
          available: blend.available(),
          builtAt: blend.builtAt,
          libraries: [...blend.contributed],
          movies: blend.index?.movies.length || 0,
          series: blend.index?.series.length || 0
        })
      }

      const bmatch = blend && /^\/blend(\/.+)$/.exec(url.pathname)
      if (bmatch) {
        const sub = bmatch[1]
        await blend.ready().catch(() => {})
        if (!blend.available()) return json(res, 409, { error: 'the blend needs two libraries with films in them' })

        const localLib = blend.localLibraryId()
        // Where a real id lives, as a redirect base - '' is this box's own.
        const baseFor = (lib) => (lib === localLib ? '' : `/remote/${lib}`)
        const redirect = (target) => {
          res.writeHead(307, { location: target })
          return res.end()
        }

        if (req.method === 'GET' && sub === '/api/library/list') {
          const out = blend.list({
            type: url.searchParams.get('type') || 'movies',
            seriesId: url.searchParams.get('seriesId'),
            seasonId: url.searchParams.get('seasonId'),
            sort: url.searchParams.get('sort'),
            order: url.searchParams.get('order'),
            limit: url.searchParams.get('limit'),
            cursor: url.searchParams.get('cursor')
          })
          if (out) return json(res, 200, out)
          // A REAL season or series id rather than a merged one: the tree
          // navigates with the primary copy's ids, so its owner answers.
          const anchor = url.searchParams.get('seasonId') || url.searchParams.get('seriesId')
          const lib = blend.ownerOf(anchor)
          if (!lib) return json(res, 404, { error: 'no such item' })
          return redirect(`${baseFor(lib)}/api/library/list?${url.searchParams.toString()}`)
        }

        if (req.method === 'GET' && sub === '/api/library/search') {
          return json(res, 200, blend.search(url.searchParams.get('q') || '', url.searchParams.get('limit')))
        }

        // Bytes go to their owner. Art by artId's owner; streams and remux by
        // THE PICK - local wins, then the best remote copy for this browser.
        if (req.method === 'GET' && sub === '/api/art') {
          const artId = url.searchParams.get('id')
          const lib = blend.artOwnerOf(artId)
          if (!lib) { res.writeHead(404); return res.end() }
          return redirect(`${baseFor(lib)}/api/art?${url.searchParams.toString()}`)
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && sub === '/api/stream') {
          const pick = blend.pickCopy(url.searchParams.get('id'))
          if (!pick) return json(res, 404, { error: 'no such item' })
          const q = new URLSearchParams(url.searchParams)
          q.set('id', pick.id)
          return redirect(`${baseFor(pick.libraryId)}/api/stream?${q.toString()}`)
        }
        if ((req.method === 'GET' || req.method === 'HEAD') && sub === '/api/remux') {
          const pick = blend.pickCopy(url.searchParams.get('id'), capsFromQuery(url))
          if (!pick) return json(res, 404, { error: 'no such item' })
          const q = new URLSearchParams(url.searchParams)
          q.set('id', pick.id)
          return redirect(`${baseFor(pick.libraryId)}/api/remux?${q.toString()}`)
        }
        if (req.method === 'GET' && (sub === '/api/subtitles' || sub === '/api/subtitle')) {
          const lib = blend.ownerOf(url.searchParams.get('itemId'))
          if (!lib) return json(res, 404, { error: 'no such item' })
          return redirect(`${baseFor(lib)}${sub}?${url.searchParams.toString()}`)
        }

        // Neighbours across the WHOLE merged run first, and only a film or an
        // id the blend does not hold falls through to its owner. Asking the
        // owning library about a spanning show would stop at the half it has.
        if (req.method === 'GET' && sub === '/api/siblings') {
          const itemId = url.searchParams.get('itemId')
          if (!itemId) return json(res, 400, { error: 'itemId required' })
          const merged = blend.siblings(itemId)
          if (merged) return json(res, 200, merged)
          const lib = blend.ownerOf(itemId)
          if (!lib) return json(res, 404, { error: 'no such item' })
          return redirect(`${baseFor(lib)}${sub}?${url.searchParams.toString()}`)
        }

        // Keep a copy HERE: refused for films already on this disk (a copy
        // for nothing), routed to the picked remote copy otherwise.
        if (req.method === 'POST' && sub === '/api/download') {
          const { itemId, capabilities } = await readBody(req)
          const pick = blend.pickCopy(String(itemId || ''), capabilities || null)
          if (!pick) return json(res, 404, { error: 'no such item' })
          if (pick.local) return json(res, 400, { error: 'this one is already on this machine' })
          if (!dls) return json(res, 501, { error: 'no downloads on this host' })
          try {
            return json(res, 200, await dls.start(pick.libraryId, pick.id, capabilities || {}))
          } catch (e) {
            return json(res, 400, { error: e.message })
          }
        }

        // Asks fan to every REMOTE at once - a note to self is not a request.
        if (req.method === 'GET' && sub === '/api/requests') {
          const rows = []
          await Promise.all(host.remote.state.hosts.map(async (h) => {
            try {
              const r = await host.remote.call(h.libraryId, 'request.list', {})
              for (const row of r?.items || []) rows.push({ ...row, libraryId: h.libraryId, libraryName: h.libraryName })
            } catch {}
          }))
          return json(res, 200, { items: mergeLib.collapseRequests(rows) })
        }
        if (req.method === 'POST' && sub === '/api/request') {
          const { kind, name } = await readBody(req)
          if (!name || !['movie', 'series'].includes(kind)) return json(res, 400, { error: 'kind and name required' })
          let out = null
          let ok = 0
          await Promise.all(host.remote.state.hosts.map(async (h) => {
            try { out = await host.remote.call(h.libraryId, 'request.add', { kind, name: String(name) }); ok++ } catch {}
          }))
          if (!ok) return json(res, 400, { error: 'no library reachable to ask' })
          return json(res, 200, out)
        }
        if (req.method === 'POST' && sub === '/api/request/remove') {
          const { id, refs } = await readBody(req)
          const targets = mergeLib.requestTargets({ refs, id }, { pendingOnly: false })
          let ok = 0
          await Promise.all(targets.map(async (t) => {
            try { await host.remote.call(t.libraryId, 'request.remove', { id: t.id }); ok++ } catch {}
          }))
          if (!ok) return json(res, 400, { error: 'no library reachable for that' })
          return json(res, 200, { ok: true })
        }

        // Watch state: read as a union with every id translated to the copy
        // the blend SHOWS (the primary), same-film positions collapsed newest
        // first - the proposal's open question 2, answered as recommended.
        // Writes go to the id's OWNER via redirect; the fan is phase 2.
        if (req.method === 'GET' && sub === '/api/watch/state') {
          const cont = []
          const watched = new Set()

          const who = await watcher(req)
          if (who.owner) {
            for (const id of await host.userState.watchedSet(who.owner)) watched.add(blend.primaryIdFor(id))
            for (const r of await host.userState.listResume(who.owner, 20)) {
              const item = blend.entityFor(r.itemId) || await host.adapter.get({ id: r.itemId }).catch(() => null)
              if (item) cont.push({ ...item, id: blend.primaryIdFor(r.itemId), resume: { positionMs: r.positionMs, playedAt: r.playedAt } })
            }
          }
          await Promise.all(host.remote.state.hosts.map(async (h) => {
            try {
              const [rc, rw] = await Promise.all([
                host.remote.call(h.libraryId, 'resume.list', { limit: 20 }),
                host.remote.call(h.libraryId, 'watched.list', {})
              ])
              for (const id of rw?.items || []) watched.add(blend.primaryIdFor(id))
              for (const row of rc?.items || []) {
                const item = blend.entityFor(row.id) || row
                cont.push({ ...item, id: blend.primaryIdFor(row.id), resume: row.resume })
              }
            } catch {}
          }))

          // One card per film: the newest position wins across libraries.
          cont.sort((a, b) => (b.resume?.playedAt || 0) - (a.resume?.playedAt || 0))
          const seenIds = new Set()
          const merged = cont.filter((i) => (seenIds.has(i.id) ? false : (seenIds.add(i.id), true)))

          return json(res, 200, { watching: null, choose: [], watched: [...watched], continue: merged.slice(0, 20) })
        }
        // THE WRITE FAN (phase 2): a position or a mark lands on EVERY library
        // holding the film - one host of two with the mark is a shelf that
        // disagrees with itself depending on who answers first, the phone's
        // shipped lesson. Best-effort per library, ok when ANY landed; an
        // offline member catches up the next time the state is written.
        if (req.method === 'POST' && sub === '/api/watch/position') {
          const { itemId, positionMs, ended } = await readBody(req)
          const refs = blend.copyRefs(String(itemId || ''))
          if (!refs.length) return json(res, 404, { error: 'no such item' })
          let ok = 0
          await Promise.all(refs.map(async (ref) => {
            try {
              if (ref.libraryId === localLib) {
                const who = await watcher(req, { create: true })
                if (!who.owner) return
                const item = await host.adapter.get({ id: ref.id })
                if (!item) return
                const v = watch.decide({ positionMs, runtimeSeconds: item.runtime, ended: !!ended })
                if (v.finished) await host.userState.setWatched(who.owner, ref.id, true, { auto: true })
                await host.userState.setResume(who.owner, ref.id, v.positionMs, v.durationMs, { playedAt: Date.now() })
              } else {
                await host.remote.call(ref.libraryId, 'resume.set', { itemId: ref.id, positionMs: Number(positionMs) || 0, ended: !!ended })
              }
              ok++
            } catch {}
          }))
          return json(res, 200, { ok: ok > 0, landed: ok, of: refs.length })
        }

        if (req.method === 'POST' && sub === '/api/watch/watched') {
          const { itemId, watched: on } = await readBody(req)
          const yes = on !== false
          const id = String(itemId || '')

          // CONTAINERS EXPAND IN THE BLEND: a merged season or series becomes
          // its merged episodes, and each episode fans to its own copies -
          // which is the only reading under which "mark the season" is true
          // on every library at once, spanning shows included.
          const parsed = mergeLib.parseMergedSeasonId(id)
          const series = parsed ? null : blend.seriesFor(id)
          let leafRefs
          if (parsed) {
            leafRefs = (mergeLib.episodesFor(blend.index, parsed.seriesKey, parsed.seasonNumber, parsed.seasonTitle) || [])
              .flatMap((e) => blend.copyRefs(e.id))
          } else if (series) {
            leafRefs = (mergeLib.seriesRun(blend.index, series.key) || [])
              .flatMap((e) => blend.copyRefs(e.id))
          } else {
            leafRefs = blend.copyRefs(id)
          }
          if (!leafRefs.length) return json(res, 404, { error: 'no such item' })

          const who = await watcher(req, { create: true })
          let ok = 0
          await eachLimit(leafRefs, 8, async (ref) => {
            try {
              if (ref.libraryId === localLib) {
                if (!who.owner) return
                await host.userState.setWatched(who.owner, ref.id, yes, { auto: false })
                if (yes) await host.userState.setResume(who.owner, ref.id, 0, null)
              } else {
                await host.remote.call(ref.libraryId, 'watched.set', { itemId: ref.id, watched: yes })
              }
              ok++
            } catch {}
          })
          return json(res, 200, { ok: ok > 0, watched: yes, items: leafRefs.length })
        }

        // THE MERGED ROLLUPS (phase 2): ticks computed over the BLENDED
        // episode runs with the watched and resumed sets unioned across every
        // library and translated to the ids the blend shows - a season split
        // across two servers rolls up as one season, which neither alone
        // could say.
        const unionWatch = async () => {
          const watchedSet = new Set()
          const resumed = new Set()
          const who = await watcher(req)
          if (who.owner) {
            for (const wid of await host.userState.watchedSet(who.owner)) watchedSet.add(blend.primaryIdFor(wid))
            for (const r of await host.userState.listResume(who.owner, 200)) resumed.add(blend.primaryIdFor(r.itemId))
          }
          await Promise.all(host.remote.state.hosts.map(async (h) => {
            try {
              const [rw, rc] = await Promise.all([
                host.remote.call(h.libraryId, 'watched.list', {}),
                host.remote.call(h.libraryId, 'resume.list', { limit: 200 })
              ])
              for (const wid of rw?.items || []) watchedSet.add(blend.primaryIdFor(wid))
              for (const row of rc?.items || []) resumed.add(blend.primaryIdFor(row.id))
            } catch {}
          }))
          return { watchedSet, resumed }
        }

        if (req.method === 'GET' && sub === '/api/watch/shows') {
          const { watchedSet, resumed } = await unionWatch()
          const shows = {}
          for (const s of blend.index?.series || []) {
            shows[s.id] = watch.rollup(mergeLib.seriesRun(blend.index, s.key) || [], watchedSet, resumed)
          }
          return json(res, 200, { shows })
        }
        if (req.method === 'GET' && sub === '/api/watch/seasons') {
          const s = blend.seriesFor(url.searchParams.get('seriesId'))
          if (!s) return json(res, 200, { seasons: {} })
          const { watchedSet, resumed } = await unionWatch()
          const seasons = {}
          for (const row of mergeLib.seasonsFor(blend.index, s.key) || []) {
            const parsed = mergeLib.parseMergedSeasonId(row.id)
            const eps = parsed
              ? mergeLib.episodesFor(blend.index, parsed.seriesKey, parsed.seasonNumber, parsed.seasonTitle) || []
              : []
            seasons[row.id] = watch.rollup(eps, watchedSet, resumed)
          }
          return json(res, 200, { seasons })
        }

        return json(res, 404, { error: 'no such blend route' })
      }

      const rmatch = remote && /^\/remote\/([a-z0-9]+)(\/.+)$/.exec(url.pathname)
      if (rmatch) {
        const lib = rmatch[1]
        const sub = rmatch[2]
        if (!remote.row(lib)) return json(res, 404, { error: 'not paired with that library' })

        // The browse reads, translated query-to-wire. Same response shapes as the
        // local routes because the WIRE's shapes are the adapter's shapes.
        if (req.method === 'GET' && sub === '/api/library/list') {
          const args = {}
          for (const k of ['type', 'seriesId', 'seasonId', 'sort', 'order']) {
            const v = url.searchParams.get(k)
            if (v) args[k] = v
          }
          const limit = Number(url.searchParams.get('limit'))
          if (Number.isFinite(limit)) args.limit = limit
          const cursor = url.searchParams.get('cursor')
          if (cursor) args.cursor = cursor
          return json(res, 200, await remote.call(lib, 'library.list', args))
        }
        if (req.method === 'GET' && sub === '/api/library/search') {
          const q = url.searchParams.get('q') || ''
          return json(res, 200, await remote.call(lib, 'library.search', { q, limit: 60 }))
        }
        if (req.method === 'GET' && sub === '/api/art') {
          const artId = url.searchParams.get('id')
          if (!artId) return json(res, 400, { error: 'id required' })
          try {
            const c = await remote.connected(lib)
            const buf = await c.art({ artId: String(artId), size: url.searchParams.get('size') || undefined })
            res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400' })
            return res.end(buf)
          } catch {
            res.writeHead(404)
            return res.end()
          }
        }
        if (req.method === 'GET' && sub === '/api/subtitles') {
          const itemId = url.searchParams.get('itemId')
          if (!itemId) return json(res, 400, { error: 'itemId required' })
          return json(res, 200, await remote.call(lib, 'subtitle.list', { itemId: String(itemId) }))
        }
        // The friend's host walks its own show - it is the authority on what
        // follows what in a library that is not ours.
        if (req.method === 'GET' && sub === '/api/siblings') {
          const itemId = url.searchParams.get('itemId')
          if (!itemId) return json(res, 400, { error: 'itemId required' })
          return json(res, 200, await remote.call(lib, 'library.siblings', { id: String(itemId) }))
        }
        if (req.method === 'GET' && sub === '/api/subtitle') {
          const itemId = url.searchParams.get('itemId')
          const subtitleId = url.searchParams.get('subtitleId')
          if (!itemId || !subtitleId) return json(res, 400, { error: 'itemId and subtitleId required' })
          const c = await remote.connected(lib)
          const buf = await c.request('subtitle.get', { itemId: String(itemId), subtitleId: String(subtitleId) }, { stream: true })
          res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(buf)
        }

        // Watch state, written to the FRIEND's host - it is the authority for its
        // own films, and this machine is just another device of whoever paired it
        // (approved open question 2). The rollup extras the local page computes by
        // walking its own adapter are computed here by walking the WIRE instead
        // (phase 2) - same watch.rollup, the episode lists fetched per series.
        // Up next stays local-only: it needs "recently finished", which the wire
        // does not say, and the phone lives without it too.
        if (req.method === 'GET' && sub === '/api/watch/state') {
          const [cont, watched] = await Promise.all([
            remote.call(lib, 'resume.list', { limit: 20 }).catch(() => ({ items: [] })),
            remote.call(lib, 'watched.list', {}).catch(() => ({ items: [] }))
          ])
          return json(res, 200, {
            watching: null,
            choose: [],
            watched: watched.items || [],
            continue: cont.items || []
          })
        }
        if (req.method === 'POST' && sub === '/api/watch/position') {
          // `ended`, matching what the page sends and what the wire reads -
          // this used to read `finished` and forward a field resume.set
          // ignores, so the credits moment never traveled (caught building
          // the blend's write fan, 2026-08-17).
          const { itemId, positionMs, ended } = await readBody(req)
          if (!itemId) return json(res, 400, { error: 'itemId required' })
          return json(res, 200, await remote.call(lib, 'resume.set', { itemId: String(itemId), positionMs: Number(positionMs) || 0, ended: !!ended }))
        }
        if (req.method === 'POST' && sub === '/api/watch/watched') {
          const { itemId, watched } = await readBody(req)
          if (!itemId) return json(res, 400, { error: 'itemId required' })
          return json(res, 200, await remoteWatched(remote, lib, String(itemId), watched !== false))
        }

        // HOW MUCH OF EACH SHOW IS LEFT, over the wire - one episode list per
        // series, asked only while the shows list is on screen, the same reason
        // the local route is separate from /api/watch/state.
        if (req.method === 'GET' && sub === '/api/watch/shows') {
          const [w, r, s] = await Promise.all([
            remote.call(lib, 'watched.list', {}).catch(() => ({ items: [] })),
            remote.call(lib, 'resume.list', { limit: 200 }).catch(() => ({ items: [] })),
            remote.call(lib, 'library.list', { type: 'series', limit: 500 }).catch(() => ({ items: [] }))
          ])
          const watchedSet = new Set(w.items || [])
          const resumed = new Set((r.items || []).map((i) => i.id))
          const shows = {}
          await eachLimit(s.items || [], 4, async (row) => {
            const eps = (await remote.call(lib, 'library.list', { type: 'episodes', seriesId: row.id, limit: 500 }).catch(() => ({ items: [] }))).items || []
            shows[row.id] = watch.rollup(eps, watchedSet, resumed)
          })
          return json(res, 200, { shows })
        }
        if (req.method === 'GET' && sub === '/api/watch/seasons') {
          const seriesId = url.searchParams.get('seriesId')
          if (!seriesId) return json(res, 400, { error: 'seriesId required' })
          const [w, r, s] = await Promise.all([
            remote.call(lib, 'watched.list', {}).catch(() => ({ items: [] })),
            remote.call(lib, 'resume.list', { limit: 200 }).catch(() => ({ items: [] })),
            remote.call(lib, 'library.list', { type: 'seasons', seriesId, limit: 200 }).catch(() => ({ items: [] }))
          ])
          const watchedSet = new Set(w.items || [])
          const resumed = new Set((r.items || []).map((i) => i.id))
          const seasons = {}
          await eachLimit(s.items || [], 4, async (row) => {
            const eps = (await remote.call(lib, 'library.list', { type: 'episodes', seasonId: row.id, limit: 500 }).catch(() => ({ items: [] }))).items || []
            seasons[row.id] = watch.rollup(eps, watchedSet, resumed)
          })
          return json(res, 200, { seasons })
        }

        // Keep a film HERE (phase 2). The friend decides converted-or-raw with
        // the same decide() playback uses; progress and the finished list are
        // global under /api/downloads above.
        if (req.method === 'POST' && sub === '/api/download') {
          if (!dls) return json(res, 501, { error: 'no downloads on this host' })
          const { itemId, capabilities } = await readBody(req)
          if (!itemId) return json(res, 400, { error: 'itemId required' })
          try {
            return json(res, 200, await dls.start(lib, String(itemId), capabilities || {}))
          } catch (e) {
            return json(res, 400, { error: e.message })
          }
        }

        // Asking the friend for what is not there (phase 2) - the phone's
        // request surface, proxied. Your own asks only; the friend answers on
        // their own devices.
        if (req.method === 'GET' && sub === '/api/requests') {
          return json(res, 200, await remote.call(lib, 'request.list', {}))
        }
        if (req.method === 'POST' && sub === '/api/request') {
          const { kind, name } = await readBody(req)
          if (!name || !['movie', 'series'].includes(kind)) return json(res, 400, { error: 'kind and name required' })
          try {
            return json(res, 200, await remote.call(lib, 'request.add', { kind, name: String(name) }))
          } catch (e) {
            return json(res, 400, { error: e.message })
          }
        }
        if (req.method === 'POST' && sub === '/api/request/remove') {
          const { id } = await readBody(req)
          if (!id) return json(res, 400, { error: 'id required' })
          return json(res, 200, await remote.call(lib, 'request.remove', { id: String(id) }))
        }

        // The film itself, Range honoured - the twin of /api/stream, bytes off the
        // wire instead of the disk. UNLESS it was downloaded: then the kept file
        // answers, byte-ranged off this machine's own disk, which is also what
        // makes a downloaded film play with the friend's box switched off -
        // nothing below the download check touches the wire.
        if ((req.method === 'GET' || req.method === 'HEAD') && sub === '/api/stream') {
          const id = url.searchParams.get('id')
          if (!id) return json(res, 400, { error: 'id required' })

          const dl = dls?.row(id)
          if (dl) {
            const file = dls.fileFor(id)
            const size = dl.size
            const range = req.headers.range ? parseRange(req.headers.range, size) : null
            if (range?.unsatisfiable) {
              res.writeHead(416, { 'content-range': `bytes */${size}` })
              return res.end()
            }
            const start = range ? range.start : 0
            const end = range ? range.end : size - 1
            res.writeHead(range ? 206 : 200, {
              'content-type': mimeFor(dl.media?.container),
              'content-length': end - start + 1,
              'accept-ranges': 'bytes',
              'cache-control': 'no-store',
              ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
            })
            if (req.method === 'HEAD') return res.end()
            return fs.createReadStream(file, { start, end }).pipe(res)
          }

          const item = await remote.call(lib, 'library.get', { id: String(id) }).catch(() => null)
          if (!item) return json(res, 404, { error: 'no such item' })
          const size = item.media?.size || null
          const type = mimeFor(item.media?.container)
          if (!size) return json(res, 409, { error: 'that one cannot be streamed here' })

          const range = req.headers.range ? parseRange(req.headers.range, size) : null
          if (range?.unsatisfiable) {
            res.writeHead(416, { 'content-range': `bytes */${size}` })
            return res.end()
          }
          const start = range ? range.start : 0
          const end = range ? range.end : size - 1
          const length = end - start + 1

          res.writeHead(range ? 206 : 200, {
            'content-type': type,
            'content-length': length,
            'accept-ranges': 'bytes',
            'cache-control': 'no-store',
            ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
          })
          if (req.method === 'HEAD') return res.end()

          const c = await remote.connected(lib)
          let dead = false
          const p = c.streamTo({ itemId: String(id), offset: start, length }, (chunk) => {
            if (dead) return
            try { res.write(chunk) } catch { dead = true }
          })
          // A browser abandons a range the instant the viewer drags the scrubber;
          // cancelling on the wire is what frees the friend's disk read.
          res.on('close', () => { dead = true; try { p.cancel?.() } catch {} })
          try { await p } catch {}
          if (!dead) { try { res.end() } catch {} }
          return
        }

        // The wire HLS, proxied - the friend's hardware transcoding for us. The
        // playlist twin exists for ffmpeg below to read, and the segments stream
        // through one call each.
        let hm = /^\/hls\/([a-z0-9]+)\.m3u8$/.exec(sub)
        if (hm && req.method === 'GET') {
          const itemId = hm[1]
          const caps = capsFromQuery(url)
          const out = await remote.call(lib, 'media.playlist', { itemId, capabilities: caps })
          if (!out?.playlist) return json(res, 409, { error: out?.reason || 'no playlist for this item' })
          const qs = url.searchParams.toString()
          const body = out.playlist.replace(/^(\d+)\.ts$/gm, `/remote/${lib}/hlsseg/${itemId}/$1.ts${qs ? '?' + qs : ''}`)
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' })
          return res.end(body)
        }
        hm = /^\/hlsseg\/([a-z0-9]+)\/(\d+)\.ts$/.exec(sub)
        if (hm && req.method === 'GET') {
          const itemId = hm[1]
          const seq = Number(hm[2])
          const caps = capsFromQuery(url)
          const c = await remote.connected(lib)
          let dead = false
          let cancelSeg = null
          res.on('close', () => { dead = true; try { cancelSeg?.() } catch {} })
          res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' })
          const p = c.request('media.segment', { itemId, seq, capabilities: caps }, {
            stream: true,
            buffer: false,
            onchunk: (chunk) => {
              if (dead) return
              try { res.write(chunk) } catch { dead = true }
            }
          })
          cancelSeg = p.cancel || null
          try { await p } catch {}
          cancelSeg = null
          if (!dead) { try { res.end() } catch {} }
          return
        }

        // Generated MP4 for a remote film - the twin of /api/remux, with one hard
        // rule: THIS machine never re-encodes someone else's stream. A container
        // the browser refuses is repackaged here with a stream copy off the raw
        // bytes; a codec the browser refuses is transcoded by the FRIEND's
        // hardware into wire HLS and only rewrapped here, still a copy. Both runs
        // ride host.remuxer, so the same cap and kill-with-response govern them.
        //
        // ffmpeg reads its input back through this server on loopback, which is
        // why this route needs the passwordless loopback bind the desktop always
        // has - on a passworded LAN dashboard the self-read would be refused, so
        // the route says so plainly instead.
        if ((req.method === 'GET' || req.method === 'HEAD') && sub === '/api/remux') {
          const id = url.searchParams.get('id')
          if (!id) return json(res, 400, { error: 'id required' })
          const at = Math.max(0, Number(url.searchParams.get('t')) || 0)
          const caps = capsFromQuery(url)

          // A DOWNLOADED film repackages straight off the kept file - still a
          // stream copy, and with no wire and no loopback self-read the
          // password gate below does not apply. The verdict runs against what
          // is IN the file, which for a converted download is the mp4 the
          // friend's hardware made, not the original on their disk.
          const dl = dls?.row(id)
          if (dl) {
            const verdict = remux.decide(dl.media, caps, { transcode: false })
            if (verdict.mode !== 'remux') return json(res, 409, { mode: verdict.mode, reason: verdict.reason })
            let session
            try {
              session = host.remuxer.start({ input: dls.fileFor(id), at, audio: verdict.audio || 'copy' })
            } catch (e) {
              if (e.code === 'BUSY') return json(res, 503, { error: e.message })
              throw e
            }
            res.writeHead(200, {
              'content-type': 'video/mp4',
              'accept-ranges': 'none',
              'cache-control': 'no-store',
              'x-pearcinema-mode': 'remux',
              'x-pearcinema-start': String(session.at),
              'x-pearcinema-audio': session.audio
            })
            if (req.method === 'HEAD') { session.kill(); return res.end() }
            res.on('close', () => session.kill())
            session.stdout.on('error', () => session.kill())
            return session.stdout.pipe(res)
          }

          if (pwSource !== 'none') {
            return json(res, 501, { error: 'watching a remote library needs the desktop app (this dashboard is password-bound)' })
          }

          const item = await remote.call(lib, 'library.get', { id: String(id) }).catch(() => null)
          if (!item) return json(res, 404, { error: 'no such item' })

          // Decide LOCALLY with transcode off: this machine only copies. What a
          // copy cannot fix is the remote host's to transcode.
          const verdict = remux.decide(item.media, caps, { transcode: false })
          const port = req.socket.localPort
          let input = null
          let audio = 'copy'
          if (verdict.mode === 'direct') return json(res, 409, { mode: 'direct', reason: verdict.reason })
          if (verdict.mode === 'remux') {
            input = `http://127.0.0.1:${port}/remote/${lib}/api/stream?id=${encodeURIComponent(id)}`
            audio = verdict.audio || 'copy'
          } else {
            const v = await remote.call(lib, 'media.decide', { itemId: String(id), capabilities: caps }).catch(() => null)
            if (v?.mode !== 'transcode') {
              return json(res, 409, { mode: verdict.mode, reason: v?.reason || verdict.reason })
            }
            const qs = new URLSearchParams({
              containers: caps.containers.join(','),
              video: caps.videoCodecs.join(','),
              audio: caps.audioCodecs.join(',')
            }).toString()
            input = `http://127.0.0.1:${port}/remote/${lib}/hls/${encodeURIComponent(id)}.m3u8?${qs}`
            audio = 'copy'
          }

          let session
          try {
            session = host.remuxer.start({ input, at, audio })
          } catch (e) {
            if (e.code === 'BUSY') return json(res, 503, { error: e.message })
            throw e
          }

          res.writeHead(200, {
            'content-type': 'video/mp4',
            'accept-ranges': 'none',
            'cache-control': 'no-store',
            'x-pearcinema-mode': verdict.mode === 'remux' ? 'remux' : 'transcode',
            'x-pearcinema-start': String(session.at),
            'x-pearcinema-audio': session.audio
          })
          if (req.method === 'HEAD') { session.kill(); return res.end() }
          res.on('close', () => session.kill())
          session.stdout.on('error', () => session.kill())
          return session.stdout.pipe(res)
        }

        return json(res, 404, { error: 'no such remote route' })
      }

      // --- where you stopped, and what you have finished ------------------------
      //
      // The SAME store the phone writes through `resume.set` on the P2P channel, keyed
      // by the same ownerId shape. Two implementations of "where did I get to" would be
      // two answers to it, and the whole point is that a laptop and a phone agree.

      if (req.method === 'POST' && url.pathname === '/api/watch/position') {
        const { itemId, positionMs, ended } = await readBody(req)
        if (!itemId) return json(res, 400, { error: 'itemId required' })

        const who = await watcher(req, { create: true })
        if (!who.owner) return json(res, 200, { ok: false, needsPerson: true })

        // The RUNTIME comes from the library, never from the browser - the same rule
        // the P2P method follows, and for the same reason: a client that names its own
        // duration can mark anything watched by claiming it is a second long.
        const item = await host.adapter.get({ id: String(itemId) })
        if (!item) return json(res, 404, { error: 'no such item' })

        const verdict = watch.decide({ positionMs, runtimeSeconds: item.runtime, ended: !!ended })
        if (verdict.finished) await host.userState.setWatched(who.owner, String(itemId), true, { auto: true })
        await host.userState.setResume(who.owner, String(itemId), verdict.positionMs, verdict.durationMs, {
          playedAt: Date.now()
        })
        return json(res, 200, { ok: true, finished: verdict.finished })
      }

      if (req.method === 'POST' && url.pathname === '/api/watch/watched') {
        const { itemId, watched: on } = await readBody(req)
        if (!itemId) return json(res, 400, { error: 'itemId required' })

        const who = await watcher(req, { create: true })
        if (!who.owner) return json(res, 200, { ok: false, needsPerson: true })

        const yes = on !== false
        const id = String(itemId)

        // MARKING A SHOW OR A SEASON MARKS ITS EPISODES, because that is the only
        // thing it could honestly mean. A show is not watched in its own right - it
        // is watched when its episodes are (DECISIONS: a rollup is derived, never
        // stored), so a flag on the container would be a second source of truth that
        // disagrees with the count on its own tile the moment an episode is added.
        const item = await host.adapter.get({ id })
        const container = item && (item.type === 'series' || item.type === 'season')

        const targets = container
          ? ((await host.adapter.list({
              type: 'episodes',
              seriesId: item.type === 'series' ? item.id : null,
              seasonId: item.type === 'season' ? item.id : null,
              limit: 500
            })).items || []).map(e => e.id)
          : [id]

        for (const t of targets) {
          await host.userState.setWatched(who.owner, t, yes, { auto: false })
          if (yes) await host.userState.setResume(who.owner, t, 0, null)
        }
        return json(res, 200, { ok: true, watched: yes, items: targets.length })
      }

      // WHAT IS LEFT OF EACH SEASON of one show. Asked for while a show is open, the
      // same shape and for the same reason as /api/watch/shows: computing it walks
      // episodes, and doing that for every season in a library to draw one page would
      // be one HTTP call per season on a Jellyfin source.
      if (req.method === 'GET' && url.pathname === '/api/watch/seasons') {
        const seriesId = url.searchParams.get('seriesId')
        if (!seriesId) return json(res, 400, { error: 'seriesId required' })

        const who = await watcher(req)
        if (!who.owner) return json(res, 200, { seasons: {} })

        // BOTH SETS. A season somebody is half way through episode one of has no
        // watched episodes at all, so counting only finished ones would report the
        // season they are actually watching as untouched.
        const watched = await host.userState.watchedSet(who.owner)
        const resumed = new Set((await host.userState.listResume(who.owner, 200)).map(r => r.itemId))
        const seasons = (await host.adapter.list({ type: 'seasons', seriesId, limit: 200 })).items || []

        const out = {}
        for (const s of seasons) {
          const eps = (await host.adapter.list({ type: 'episodes', seasonId: s.id, limit: 500 })).items || []
          out[s.id] = watch.rollup(eps, watched, resumed)
        }
        return json(res, 200, { seasons: out })
      }

      // Everything this person has going: the continue-watching shelf and the set of
      // ids that get a tick. ONE call, because the library page needs both to draw a
      // single screen and two round trips is two chances to render half of it.
      if (req.method === 'GET' && url.pathname === '/api/watch/state') {
        const who = await watcher(req)
        if (!who.owner) {
          return json(res, 200, {
            watching: null,
            // Several people and nobody chosen. The page asks rather than guessing.
            choose: who.persons.map(p => ({ id: p.id, name: p.name })),
            watched: [],
            continue: []
          })
        }

        const [watchedIds, rows] = await Promise.all([
          host.userState.watchedSet(who.owner),
          host.userState.listResume(who.owner, 20)
        ])

        // A position whose film has since left the library is dropped rather than
        // drawn as a card that cannot be opened.
        const cont = []
        for (const r of rows) {
          const item = await host.adapter.get({ id: r.itemId })
          if (item) cont.push({ ...item, resume: { positionMs: r.positionMs, playedAt: r.playedAt } })
        }

        // AND THE NEXT EPISODE OF ANYTHING RECENTLY FINISHED.
        //
        // Bounded by RECENCY rather than by the library: only shows this person has
        // just finished something in are looked at, which is a handful rather than
        // the twenty-eight on the real drive. Walking every series to find one card
        // would be free on a folder source and one HTTP call per show on a Jellyfin
        // one, which is the same trap `/api/watch/shows` is kept separate for.
        const resumed = new Set(cont.map(i => i.id))
        const seenSeries = new Set()
        const upNext = []

        for (const row of await host.userState.recentWatched(who.owner, 12)) {
          const done = await host.adapter.get({ id: row.itemId })
          if (!done || done.type !== 'episode' || !done.seriesId) continue
          if (seenSeries.has(done.seriesId)) continue
          seenSeries.add(done.seriesId)

          const eps = (await host.adapter.list({ type: 'episodes', seriesId: done.seriesId, limit: 500 })).items || []
          const next = watch.nextEpisode(eps, watchedIds, resumed)
          if (next) upNext.push({ ...next, upNext: true })
          if (upNext.length >= 6) break
        }

        return json(res, 200, {
          watching: { id: who.person.id, name: who.person.name },
          choose: who.persons.length > 1 ? who.persons.map(p => ({ id: p.id, name: p.name })) : [],
          watched: [...watchedIds],
          // MID-FILM FIRST, then what to start next. Both are "carry on", but one is
          // something the person literally stopped in the middle of and the other is
          // a suggestion, and burying the first under the second would be wrong.
          continue: cont,
          upNext
        })
      }

      // HOW MUCH OF EACH SHOW IS LEFT. A separate route from /api/watch/state, and
      // deliberately: answering it means walking every series' episodes, which the
      // folder adapter holds in memory and a Jellyfin source does not - it is one
      // HTTP call per show. So it is asked for only when the shows list is on screen,
      // rather than folded into the call every library page makes.
      if (req.method === 'GET' && url.pathname === '/api/watch/shows') {
        const who = await watcher(req)
        if (!who.owner) return json(res, 200, { shows: {} })

        const watched = await host.userState.watchedSet(who.owner)
        const resumed = new Set((await host.userState.listResume(who.owner, 200)).map(r => r.itemId))
        const series = (await host.adapter.list({ type: 'series', limit: 500 })).items || []

        const shows = {}
        for (const s of series) {
          const eps = (await host.adapter.list({ type: 'episodes', seriesId: s.id, limit: 500 })).items || []
          shows[s.id] = watch.rollup(eps, watched, resumed)
        }
        return json(res, 200, { shows })
      }

      // Switching who is watching. A preference, not a credential - see WATCH_COOKIE.
      if (req.method === 'POST' && url.pathname === '/api/watch/as') {
        const { personId } = await readBody(req)
        const persons = (await host.grants.listPersons()).filter(p => !p.revokedAt)
        const person = persons.find(p => p.id === String(personId || ''))
        if (!person) return json(res, 400, { error: 'no such person' })

        res.setHeader('set-cookie',
          `${WATCH_COOKIE}=${encodeURIComponent(person.id)}; Path=/; SameSite=Strict; Max-Age=31536000`)
        return json(res, 200, { watching: { id: person.id, name: person.name } })
      }

      // --- the source ----------------------------------------------------------
      // --- online artwork, opt in --------------------------------------------
      //
      // The key never leaves the host: the page is told only that one is saved.
      // The Test button is its own route because a key that silently fails is worse
      // than none - the library just looks wrong with nothing saying why.

      if (req.method === 'GET' && url.pathname === '/api/metadata') {
        return json(res, 200, {
          ...host.metadataSettings(),
          ...host.enricher.summary(),
          canWriteSidecars: host.canWriteSidecars()
        })
      }

      // WHICH TITLES CAME BACK WITH NOTHING. Its own route rather than part of the
      // summary above, because the summary is polled every two seconds while a pass
      // runs and this can be hundreds of rows - and nobody is looking at it except
      // when they have opened the window that shows it.
      if (req.method === 'GET' && url.pathname === '/api/metadata/missing') {
        return json(res, 200, { items: await host.enricher.missedList(host.adapter) })
      }

      // The explicit save-to-library action. Synchronous on purpose: it is a
      // few hundred small files at most and the operator is looking at the
      // button that asked for them - a fire-and-forget here would just move
      // the answer into a poll nobody wants.
      if (req.method === 'POST' && url.pathname === '/api/metadata/sidecars') {
        return json(res, 200, await host.writeSidecars())
      }

      if (req.method === 'POST' && url.pathname === '/api/metadata/test') {
        const { key } = await readBody(req)
        if (!key) return json(res, 400, { error: 'key required' })
        return json(res, 200, await host.testMetadataKey(String(key)))
      }

      if (req.method === 'POST' && url.pathname === '/api/metadata') {
        const { key, enabled } = await readBody(req)
        // A key is TESTED before it is saved, on the same rule the source has: a
        // saved credential that does not work is a library that quietly looks
        // wrong, which is the worst version of failure.
        if (key) {
          const t = await host.testMetadataKey(String(key))
          if (!t.ok) return json(res, 400, { error: t.error })
        }
        const out = host.saveMetadata({ key, enabled })
        // Turning it on IS asking for the artwork - do not make the operator find
        // a second button. Fire and forget; progress shows in /api/metadata.
        if (out.enabled && out.hasKey && !host.enricher.running) {
          host.runMetadata().catch(e => host.log('tmdb:failed', { err: e.message }))
        }
        return json(res, 200, out)
      }

      if (req.method === 'POST' && url.pathname === '/api/metadata/run') {
        const { retryMissed } = await readBody(req)
        if (host.enricher.running) return json(res, 200, { running: host.enricher.running })
        host.runMetadata({ retryMissed: !!retryMissed }).catch(e => host.log('tmdb:failed', { err: e.message }))
        return json(res, 200, { started: true })
      }

      // The fix flow, from the tile's pencil: search again, apply the operator's
      // pick, or drop the fetched artwork entirely.
      if (req.method === 'POST' && url.pathname === '/api/metadata/search') {
        const { itemId, q } = await readBody(req)
        if (!itemId) return json(res, 400, { error: 'itemId required' })
        const out = await host.searchMetadata({ itemId: String(itemId), q: q ? String(q) : null })
        if (!out) return json(res, 404, { error: 'no such item' })
        return json(res, 200, { candidates: out })
      }

      if (req.method === 'POST' && url.pathname === '/api/metadata/fix') {
        const { itemId, tmdbId, type } = await readBody(req)
        if (!itemId || !tmdbId) return json(res, 400, { error: 'itemId and tmdbId required' })
        const out = await host.fixMetadata({ itemId: String(itemId), tmdbId, type: String(type || 'movie') })
        if (!out) return json(res, 404, { error: 'TMDB does not know that id' })
        return json(res, 200, out)
      }

      // A candidate's poster thumbnail, relayed through the host. The path is held
      // to TMDB's own shape - one path segment, an image extension - so this can
      // never be pointed anywhere else.
      if (req.method === 'GET' && url.pathname === '/api/metadata/preview') {
        const p = String(url.searchParams.get('p') || '')
        if (!/^\/[A-Za-z0-9_-]+\.(?:jpg|png)$/.test(p)) return json(res, 400, { error: 'not a TMDB image path' })
        const bytes = await host.previewMetadataPoster(p)
        if (!bytes) { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' })
        return res.end(bytes)
      }

      if (req.method === 'POST' && url.pathname === '/api/metadata/unmatch') {
        const { itemId } = await readBody(req)
        if (!itemId) return json(res, 400, { error: 'itemId required' })
        return json(res, 200, { ok: await host.unmatchMetadata({ itemId: String(itemId) }) })
      }

      if (req.method === 'POST' && url.pathname === '/api/source/test') {
        const cfg = await readBody(req)
        try {
          return json(res, 200, await host.testSource(cfg))
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/source') {
        const cfg = await readBody(req)
        try {
          return json(res, 200, await host.setSource(cfg))
        } catch (e) {
          // The OLD source is still serving - setSource swaps only after the new one
          // scans clean. Say that, because "save failed" otherwise reads as "my
          // library is gone".
          return json(res, 400, { error: e.message, stillServing: host.adapter.kind })
        }
      }

      // Scheduled auto-rescan, PearTune's control: pick new files up without a
      // manual Rescan. 0 turns it off.
      if (req.method === 'POST' && url.pathname === '/api/rescan-interval') {
        const { minutes } = await readBody(req)
        return json(res, 200, { ok: true, minutes: host.setRescanIntervalMin(minutes) })
      }

      // The Support Development rails, QR included, rendered host-side the same
      // way the pairing code is - the page never needs a QR library of its own.
      if (req.method === 'GET' && url.pathname === '/api/donate') {
        // EVERY CAPTION SAYS WHICH THING IT IS. Two of these three are Bitcoin and the
        // page never said so - "Lightning" and "On-chain" are only obvious to somebody
        // who already knows (Tim, 2026-08-19). They also stay within two lines each, so
        // the address and the buttons under them do not jump when you switch rails.
        const RAILS = {
          ln: { value: 'peerloomllc@strike.me', caption: 'Bitcoin over Lightning, the cheapest way to send a small amount. Scan with any wallet, or copy the address.' },
          onchain: { value: 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf', caption: 'Bitcoin on-chain. Fees are higher, so Lightning is better for a small tip.' },
          usd: { value: 'https://buymeacoffee.com/peerloomllc', caption: 'Card or bank, through Buy Me a Coffee. Scan it, or open it here.' }
        }
        const out = {}
        for (const [k, r] of Object.entries(RAILS)) {
          out[k] = { ...r, svg: await QRCode.toString(r.value, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }) }
        }
        return json(res, 200, { rails: out })
      }

      // STARTED, NOT FINISHED. A full rescan of the real library is minutes of ffprobe,
      // and awaiting it here held the request open for all of them while `scanning`
      // stayed null because this went around `host._scan` instead of through it. The
      // answer is immediate now and the progress is on /api/state, which every surface
      // already reads.
      if (req.method === 'POST' && url.pathname === '/api/source/rescan') {
        return json(res, 200, host.rescan())
      }

      // WHAT IS ALREADY ON THIS BOX. Servers and folders together, because the
      // operator is asking one question - where are the films - and does not care
      // which shape the answer takes.
      if (req.method === 'GET' && url.pathname === '/api/source/detect') {
        return json(res, 200, await detectSources().catch(() => ({ servers: [], folders: [] })))
      }

      // The folder picker. Directory names only, never file contents.
      if (req.method === 'GET' && url.pathname === '/api/source/folders') {
        try {
          return json(res, 200, await browse(url.searchParams.get('path') || '/'))
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      // --- library name ---
      if (req.method === 'POST' && url.pathname === '/api/library') {
        const { name } = await readBody(req)
        try {
          return json(res, 200, { name: host.setLibraryName(name) })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      // --- the dashboard password ----------------------------------------------
      //
      // Only changeable when WE own it. A platform-set password ('explicit', which
      // on Umbrel is ${APP_PASSWORD}) must be changed where the platform sets it, or
      // the next container restart silently reverts it and the operator is locked
      // out of a box they thought they had secured.
      // --- casting to a television (video-deltas §5) ---------------------------
      //
      // The operator points the host at their Home Assistant; phones do the
      // actual casting over the wire. The token is write-only, the donor's
      // posture: the page learns it is set, never what it is.
      if (req.method === 'GET' && url.pathname === '/api/cast') {
        return json(res, 200, host.ha.publicConfig())
      }
      if (req.method === 'POST' && url.pathname === '/api/cast') {
        const body = await readBody(req)
        try {
          return json(res, 200, host.ha.save(body))
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/cast/test') {
        try {
          return json(res, 200, await host.ha.test())
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      // The media players BY NAME, because a count is not enough to find the
      // television among the kitchen speakers (Tim, 2026-08-17) - PearTune's
      // panel lists them and this one does too.
      //
      // NOT GATED ON HOME ASSISTANT, and that was a real bug rather than a layout
      // preference: a person with a Roku and no Home Assistant was shown "casting is
      // off" and an empty page while casting worked perfectly from their phone. Their
      // server had found the television. The page simply never asked.
      if (req.method === 'GET' && url.pathname === '/api/cast/targets') {
        try {
          return json(res, 200, {
            targets: await host.speakers.list(),
            // What was found on the wire and NOT offered, so the page can say why.
            needsChannel: host.roku?.needsChannel || [],
            mediaChannel: MEDIA_CHANNEL_NAME
          })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      // Hiding, for either kind of television. One entity and a boolean: the router
      // decides which store the answer lands in, and the page does not have to know.
      if (req.method === 'POST' && url.pathname === '/api/cast/hidden') {
        const body = await readBody(req)
        try {
          host.speakers.setHidden(body?.entityId, !!body?.hidden)
          return json(res, 200, { targets: await host.speakers.list() })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }
      // Look again now, for the person who just switched a television on and does not
      // want to wait out the roster's own refresh.
      if (req.method === 'POST' && url.pathname === '/api/cast/rescan') {
        try {
          // BOTH KINDS OF FOUND TELEVISION, and neither failure loses the other: a Roku
          // asleep must not stop a Samsung being found, and a network without multicast
          // costs both of them and nothing else.
          await Promise.all([
            host.roku?.scan().catch(() => {}),
            host.dlna?.scan().catch(() => {})
          ])
          return json(res, 200, {
            targets: await host.speakers.list(),
            needsChannel: host.roku?.needsChannel || [],
            mediaChannel: MEDIA_CHANNEL_NAME
          })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      // The video engine's cap, from the This host card. Zero is the off
      // switch and reaches decide() as honest refusals, not BUSY errors.
      if (req.method === 'POST' && url.pathname === '/api/transcode-cap') {
        const { cap } = await readBody(req)
        try {
          return json(res, 200, host.setTranscodeCap(cap))
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      // Log out every OTHER browser - the button people look for after handing
      // a laptop back. The session pressing it survives, so the answer is a
      // count rather than the login page. Changing the password does not do
      // this (sessions deliberately survive a password change), which is
      // exactly why the button has to exist.
      if (req.method === 'POST' && url.pathname === '/api/logout-everywhere') {
        if (!auth.enabled) return json(res, 400, { error: 'this host has no dashboard password (it is bound to loopback)' })
        const others = auth.logoutEverywhere(auth.sessionIdOf(req))
        return json(res, 200, { ok: true, others })
      }

      if (req.method === 'POST' && url.pathname === '/api/password') {
        if (!auth.enabled) return json(res, 400, { error: 'this host has no dashboard password (it is bound to loopback)' })
        if (pwSource === 'explicit') {
          return json(res, 400, { error: 'this password is set by PEARCINEMA_PASSWORD - change it there' })
        }
        const { current, next } = await readBody(req)
        if (!auth.verify(current || '')) return json(res, 401, { error: 'that is not the current password' })
        const clean = String(next || '')
        if (clean.length < 8) return json(res, 400, { error: 'use at least 8 characters' })
        fs.mkdirSync(host.dataDir, { recursive: true })
        fs.writeFileSync(path.join(host.dataDir, 'dashboard-password'), clean + '\n', { mode: 0o600 })
        auth.setPassword(clean)
        pwSource = 'file'
        log('dashboard:password-changed')
        return json(res, 200, { ok: true })
      }

      // --- pairing ---------------------------------------------------------------
      if (req.method === 'POST' && url.pathname === '/api/pair/start') {
        const body = await readBody(req)
        const expiresMs = Number(body.expiresMs) > 0 ? Number(body.expiresMs) : null
        // owner:true opens an OWNER window. Only this password-gated page can ask for
        // one, which is what keeps owner scope rooted in dashboard access.
        // startPairing enforces owner XOR guest.
        const link = host.startPairing({ expiresMs, owner: !!body.owner })
        const svg = await QRCode.toString(link, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' })
        openQr = { link, svg }
        return json(res, 200, {
          link,
          svg,
          ttlMs: host.pairSession.ttl,
          guest: !!host.pairSession.expiresMs,
          owner: !!host.pairSession.owner,
          expiresMs: host.pairSession.expiresMs || null
        })
      }

      if (req.method === 'POST' && url.pathname === '/api/pair/stop') {
        openQr = null
        host.stopPairing()
        return json(res, 200, { ok: true })
      }

      // --- devices and people ------------------------------------------------------
      if (req.method === 'POST' && url.pathname === '/api/revoke') {
        const { deviceKey } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        const out = await host.revokeDevice(deviceKey)
        return json(res, 200, { ok: true, killed: out.killed })
      }

      if (req.method === 'POST' && url.pathname === '/api/device/delete') {
        const { deviceKey } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        try {
          const out = await host.deleteDevice(deviceKey)
          if (!out.deleted) return json(res, 404, { error: 'no such device' })
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/device/expiry') {
        const { deviceKey, expiresAt } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        const out = await host.setDeviceExpiry(deviceKey, expiresAt ?? null)
        if (!out.grant) return json(res, 404, { error: 'no such device' })
        return json(res, 200, { ok: true, killed: out.killed })
      }

      // A PERSON WITH NO DEVICE YET, added by the operator.
      //
      // Until now a person only came into existence when a paired device claimed a
      // name, which was fine while people were only ever a way to group devices. It
      // stops being fine the moment watch state is per person: a household that
      // watches on one laptop has nobody but the auto-created "Me", so the "watching
      // as" chooser could never appear and the second person in the house has nowhere
      // to put their history. A device can be attached to them later, or never.
      if (req.method === 'POST' && url.pathname === '/api/person') {
        const { name } = await readBody(req)
        const clean = String(name || '').trim()
        if (!clean) return json(res, 400, { error: 'name required' })

        // The same rule confirming a claim follows: two people of one name is a
        // dashboard nobody can read, and it makes "revoke Sam" ambiguous.
        const existing = (await host.grants.listPersons())
          .find(p => !p.revokedAt && p.name.toLowerCase() === clean.toLowerCase())
        if (existing) return json(res, 400, { error: `there is already somebody called ${existing.name}` })

        return json(res, 200, await host.grants.addPerson(clean))
      }

      if (req.method === 'POST' && url.pathname === '/api/person/confirm') {
        const { deviceKey, asNew, personId } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        try {
          return json(res, 200, await host.grants.confirmClaim(deviceKey, { asNew: !!asNew, personId: personId || null }))
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/assign') {
        const { deviceKey, personId } = await readBody(req)
        if (!deviceKey) return json(res, 400, { error: 'deviceKey required' })
        try {
          // Through the host, not the store: assignDevice also refreshes the
          // device's LIVE connections and nudges it, so the change is true
          // now rather than at its next reconnect.
          const out = await host.assignDevice(deviceKey, personId || null)
          return json(res, 200, { ok: true, grant: out.grant, refreshed: out.refreshed })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/person/rename') {
        const { personId, name } = await readBody(req)
        if (!personId) return json(res, 400, { error: 'personId required' })
        try {
          return json(res, 200, { person: await host.grants.renamePerson(personId, name) })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/person/revoke') {
        const { personId } = await readBody(req)
        if (!personId) return json(res, 400, { error: 'personId required' })
        const out = await host.revokePerson(personId)
        return json(res, 200, { ok: true, devices: out.revoked.length, killed: out.killed })
      }

      if (req.method === 'POST' && url.pathname === '/api/person/delete') {
        const { personId } = await readBody(req)
        if (!personId) return json(res, 400, { error: 'personId required' })
        try {
          const out = await host.deletePerson(personId)
          if (!out.deleted) return json(res, 404, { error: 'no such person' })
          return json(res, 200, { ok: true })
        } catch (e) {
          return json(res, 400, { error: e.message })
        }
      }

      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'not found' }))
    } catch (e) {
      log('dashboard:error', { path: url.pathname, err: e?.message })
      // The message, not the stack. This page is password-gated, but a stack trace
      // in a response body is how internal paths end up in a screenshot.
      if (!res.headersSent) return json(res, 500, { error: e?.message || 'internal error' })
      res.end()
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  log('dashboard:listening', { url: `http://${bind}:${port}`, auth: auth.enabled, passwordSource })

  return {
    server,
    port: server.address().port,
    url: `http://${bind === '0.0.0.0' ? 'localhost' : bind}:${server.address().port}`,
    auth,
    // The live channels have to be hung up BY HAND. server.close() waits for
    // open connections to end, and a held-open event stream never does - so a
    // restart with one dashboard tab open would wait forever.
    close: () => new Promise(resolve => {
      for (const res of liveClients) { try { res.end() } catch {} }
      liveClients.clear()
      server.close(resolve)
    })
  }
}

module.exports = { startDashboard, parseRange, srtToVtt, mimeFor, MIME }
