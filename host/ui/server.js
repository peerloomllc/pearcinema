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
            roots: host.source?.roots || (host.source?.root ? [host.source.root] : []),
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
                guest: !!host.pairSession.expiresMs,
                owner: !!host.pairSession.owner,
                expiresMs: host.pairSession.expiresMs || null
              }
            : { open: false },
          auth: { enabled: auth.enabled, passwordSource: pwSource },
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

      // --- subtitles -----------------------------------------------------------
      if (req.method === 'GET' && url.pathname === '/api/subtitles') {
        const itemId = url.searchParams.get('itemId')
        if (!itemId) return json(res, 400, { error: 'itemId required' })
        if (!host.adapter.subtitles) return json(res, 200, { items: [] })
        const list = await host.adapter.subtitles({ itemId: String(itemId) }).catch(() => [])
        return json(res, 200, { items: list })
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

      // --- REPACKAGED BYTES ----------------------------------------------------
      //
      // The other half of the player, and the one that turns a tenth of a real
      // library into nearly all of it: 83% of the measured collection is in a
      // container Chrome and Safari will not open, and this hands them the same
      // picture in a box they will.
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
        // cannot ask to be remuxed, only describe itself.
        const caps = {
          containers: (url.searchParams.get('containers') || 'mp4').split(',').filter(Boolean),
          videoCodecs: (url.searchParams.get('video') || 'h264').split(',').filter(Boolean),
          audioCodecs: (url.searchParams.get('audio') || 'aac').split(',').filter(Boolean)
        }

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
        if (out.mode !== 'remux') {
          // Direct play would work, or nothing will. Either way this route has
          // nothing to do, and saying which is the whole point.
          return json(res, 409, { mode: out.mode, reason: out.reason })
        }

        res.writeHead(200, {
          'content-type': 'video/mp4',
          'accept-ranges': 'none',
          'cache-control': 'no-store',
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

      // --- the source ----------------------------------------------------------
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

      if (req.method === 'POST' && url.pathname === '/api/source/rescan') {
        try {
          const n = await host.adapter.scan({ force: true })
          host.sourceError = null
          return json(res, 200, { ok: true, items: n, ...(await host.adapter.stats().catch(() => ({}))) })
        } catch (e) {
          host.sourceError = e.message
          return json(res, 400, { error: e.message })
        }
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
          const row = await host.grants.assign(deviceKey, personId || null)
          host.notifyOwnersDevicesChanged()
          return json(res, 200, { ok: true, grant: row })
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
    close: () => new Promise(resolve => server.close(resolve))
  }
}

module.exports = { startDashboard, parseRange, srtToVtt, mimeFor, MIME }
