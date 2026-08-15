// The PearCinema worklet: the P2P backend that runs inside the phone.
//
// It holds:
//   1. the device identity (a keypair, persisted; it IS this device's grant)
//   2. the paired-host list (hosts.json, via @peerloom/client's pure bookkeeping)
//   3. the live connection to the active host (@peerloom/client Client)
//   4. the localhost streaming shim, which is how a video player ever sees bytes
//
// The shell talks to it over BareKit IPC with { id, method, args }; replies are
// { id, result } or { id, error }; pushes are { event, data }. That envelope is
// the suite convention documented in @peerloom/client's index.
//
// Composition, not implementation: everything below the method table lives in
// @peerloom/client, extracted from PearTune precisely so this file could be
// short. What is PearCinema's here is the vocabulary (itemId/artId), the video
// method surface, and nothing else.

/* global Bare, BareKit */

const b4a = require('b4a')
const z32 = require('z32')
const hcrypto = require('hypercore-crypto')
const fs = require('bare-fs')
const path = require('bare-path')

const { createProtocol } = require('@peerloom/host/protocol')
const { Client } = require('@peerloom/client/client')
const H = require('@peerloom/client/hosts')
const { createAudioShim } = require('@peerloom/client/shim')
const { AudioCache } = require('@peerloom/client/cache')

const DATA_DIR = Bare.argv[0] || '/tmp/pearcinema'
const PLATFORM = Bare.argv[1] || 'android'

const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

// Small device-local preferences (theme and friends), beside the identity the
// same way the donor keeps them - so the shell could one day read the theme
// before the WebView paints.
function readSettings () {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {} } catch { return {} }
}
function writeSettings (s) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s))
}

const protocol = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })

const caps = require('./capabilities')

// WHAT THIS DEVICE DECLARES IT CAN PLAY. Starts as the conservative static
// floor; the shell probes the device's REAL decoder list (MediaCodecList lives
// RN-side) and hands it over via capabilities.declare moments after boot, and
// src/capabilities.js turns it into the declaration under its measured-lesson
// rules. A device that under-declares costs the host some engine time; one
// that over-declares costs the viewer a black screen - which is why video
// needs hardware, HEVC needs Main 10, and the player-error retry below exists
// for whatever lies through both.
let capabilities = caps.STATIC

// Video codecs this device claimed and its decoder then refused at runtime,
// per item - the honest correction for a lying chip. Consulted by every path
// that describes the device to the host, so the retry's HLS playlist and
// segment calls describe it the same way stream.url did. RAM-only: a fresh
// process retries direct play once and re-learns in one failed attempt.
const refusedVideo = new Map()

const DATA_SAVER_KBPS = 2500

function capsFor (itemId) {
  const bad = refusedVideo.get(itemId)
  const base = bad ? caps.without(capabilities, bad) : capabilities
  // Data saver rides the capability declaration as a stated link budget -
  // still a description of THIS client's situation, and the host still
  // decides. One seam covers decide, playlist and every segment.
  return readSettings().dataSaver ? { ...base, maxKbps: DATA_SAVER_KBPS } : base
}

// --- IPC --------------------------------------------------------------------

function send (msg) {
  BareKit.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
}

function emit (name, data) {
  send({ event: name, data })
}

function log (msg, data) {
  console.warn('[worklet]', msg, data ? JSON.stringify(data) : '')
  emit('log', { msg, data })
}

// --- identity ---------------------------------------------------------------

// The device keypair is not a convenience, it is the account. The host's grant is
// keyed to this public key, so losing this file means the phone is a stranger
// again and must re-pair.

function loadIdentity () {
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'))
    return {
      publicKey: b4a.from(raw.publicKey, 'hex'),
      secretKey: b4a.from(raw.secretKey, 'hex')
    }
  } catch {
    const kp = hcrypto.keyPair()
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify({
      publicKey: b4a.toString(kp.publicKey, 'hex'),
      secretKey: b4a.toString(kp.secretKey, 'hex')
    }))
    log('identity:created', {})
    return kp
  }
}

// --- hosts ------------------------------------------------------------------

// The pure bookkeeping lives in the package; this file owns only the disk.

function readHosts () {
  try {
    return H.normalize(JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')))
  } catch {
    return H.empty()
  }
}

function writeHosts (state) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(state))
}

// --- the live client --------------------------------------------------------

const keyPair = loadIdentity()
let hostsState = readHosts()

// ONE client at a time for the milestone: the active host. The multi-host merged
// pool is PearTune's later shape and arrives when the app has more than one
// screen to show it on.
let client = null
let connecting = null

async function connected () {
  const active = H.activeHost(hostsState)
  if (!active) throw new Error('not paired with any library')

  if (client && client.conn && !client.conn.destroyed) return client
  if (connecting) return connecting

  connecting = (async () => {
    if (client) { try { await client.close() } catch {} }
    client = new Client({ protocol, keyPair, log: (m, d) => log(m, d) })
    await client.connect({ hostKey: z32.decode(active.hostKey), libraryId: active.libraryId })
    client.onPush = (m) => emit('host:push', m)
    client.conn.once('close', () => emit('host:disconnected', { hostKey: active.hostKey }))
    emit('host:connected', { hostKey: active.hostKey, libraryName: active.libraryName })
    return client
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
}

// --- the shim ---------------------------------------------------------------

// The player and the <img> tags see http://127.0.0.1:<port>/...; the bytes ride
// the P2P connection. PearCinema's vocabulary rides in via the two mappers - the
// host answers { itemId } and { artId }, not the donor's trackId/coverId.
// The UI PAGE IS SERVED FROM THE SHIM, and that is a bug fix rather than a
// nicety: a WebView document injected as a string with a faked base URL loads
// <img> from the shim and then refuses <video> and fetch() against the very same
// URLs (measured on the TCL, 2026-08-14 - instant MediaError code 4, zero
// requests). Served from http://127.0.0.1:<port>/ the page IS the shim's origin
// and everything is same-origin plain http. The shell hands the HTML over IPC at
// boot, because only the shell can read the app's assets.
let uiPage = null

// The film store: write-through for whole plays (LRU, capped) and the home of
// pinned DOWNLOADS, which the store exempts from the cap by design. The shim
// serves a cache hit straight off disk with full Range support - which is the
// entire offline story: no connection needed once a film is here.
const cache = new AudioCache({ dir: path.join(DATA_DIR, 'films'), cap: 512 * 1024 * 1024, log: (m, d) => log(m, d) })

const CONTAINER_MIME = {
  matroska: 'video/x-matroska', mkv: 'video/x-matroska', mov: 'video/mp4',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mpegts: 'video/mp2t'
}

// Live downloads, itemId -> { cancel, got, size }. RAM-only: a killed app
// leaves an uncommitted sink, which the store never marks complete - restart
// and download again.
const downloads = new Map()

async function startDownload (itemId) {
  if (cache.has(itemId)) {
    cache.setPinned(itemId, true)
    emit('download:done', { itemId })
    return { ok: true, already: true }
  }
  if (downloads.has(itemId)) return { ok: true, running: true }
  const c = await connected()
  const item = await c.get({ id: itemId })
  const size = item?.media?.size
  if (!size) throw new Error('this one cannot be downloaded')
  const mime = CONTAINER_MIME[String(item?.media?.container || '').toLowerCase()] || 'video/mp4'
  const active = H.activeHost(hostsState)
  const sink = cache.createSink(itemId, { mime, size, library: active?.libraryId || null, pinned: true })
  let got = 0
  let lastEmit = 0
  const p = c.streamTo({ itemId, offset: 0, length: size }, (chunk) => {
    got += chunk.length
    sink.write(chunk)
    if (got - lastEmit > 16 * 1024 * 1024 || got === size) {
      lastEmit = got
      emit('download:progress', { itemId, got, size })
    }
  })
  downloads.set(itemId, { cancel: () => p.cancel?.(), got: () => got, size })
  p.then(async (out) => {
    downloads.delete(itemId)
    if (out?.cancelled) {
      sink.abort()
      emit('download:failed', { itemId, reason: 'cancelled' })
      return
    }
    const stored = await sink.commit()
    emit(stored ? 'download:done' : 'download:failed', { itemId, reason: stored ? undefined : 'incomplete' })
  }).catch((e) => {
    downloads.delete(itemId)
    sink.abort()
    emit('download:failed', { itemId, reason: e.message })
  })
  emit('download:progress', { itemId, got: 0, size })
  return { ok: true }
}

const shim = createAudioShim({
  log: (m, d) => log(m, d),
  cache,
  defaultClient: () => connected(),
  streamParams: (id, extra) => ({ itemId: id, ...extra }),
  artParams: (id, size) => ({ artId: id, size }),
  // THE HLS ROUTES: the playlist is fetched from the host and served with its
  // segment lines rewritten to this shim's own /hlsseg/ path; each segment pull
  // becomes one media.segment call whose bytes stream straight through. The
  // capabilities ride every call because the host is stateless about them.
  extra: async (req, res) => {
    const url = req.url || ''

    let m = /^\/hls\/([a-z0-9]+)\.m3u8/i.exec(url)
    if (m) {
      const itemId = m[1]
      try {
        const c = await connected()
        const out = await c.request('media.playlist', { itemId, capabilities: capsFor(itemId) })
        if (!out?.playlist) {
          res.writeHead(409, { 'content-type': 'text/plain' })
          res.end(out?.reason || 'no playlist for this item')
          return true
        }
        const body = out.playlist.replace(/^(\d+)\.ts$/gm, `/hlsseg/${itemId}/$1.ts`)
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' })
        res.end(body)
      } catch (e) {
        log('hls:playlist-failed', { err: e.message })
        try { res.writeHead(502); res.end() } catch {}
      }
      return true
    }

    m = /^\/hlsseg\/([a-z0-9]+)\/(\d+)\.ts/i.exec(url)
    if (m) {
      const itemId = m[1]
      const seq = Number(m[2])
      let dead = false
      let cancelSeg = null
      // A scrub away from a transcoding segment cancels it on the wire, which
      // EPIPEs the host's per-segment ffmpeg and frees the engine slot at the
      // scrub instead of four seconds later (stream-cancel proposal).
      res.on('close', () => { dead = true; try { cancelSeg?.() } catch {} })
      try {
        const c = await connected()
        res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' })
        const p = c.request('media.segment', { itemId, seq, capabilities: capsFor(itemId) }, {
          stream: true,
          buffer: false,
          onchunk: (chunk) => {
            if (dead) return
            try { res.write(chunk) } catch { dead = true }
          }
        })
        cancelSeg = p.cancel || null
        await p
        cancelSeg = null
        if (!dead) { try { res.end() } catch {} }
      } catch (e) {
        log('hls:segment-failed', { seq, err: e.message })
        try { res.destroy() } catch {}
      }
      return true
    }

    return false
  },
  // PearCinema's items carry their facts under `media`, and the MIME comes from
  // the CONTAINER the probe recorded rather than a filename we do not have.
  itemMeta: (t) => ({
    size: t?.media?.size,
    mime: {
      matroska: 'video/x-matroska',
      mkv: 'video/x-matroska',
      mov: 'video/mp4',
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      avi: 'video/x-msvideo',
      mpegts: 'video/mp2t'
    }[String(t?.media?.container || '').toLowerCase()] || 'video/mp4'
  }),
  page: () => uiPage || '<!doctype html><title>PearCinema</title>starting…'
})
let shimPort = null

// --- the method table -------------------------------------------------------

// Invoked UNBOUND by the IPC loop - nothing here may use `this`.
const methods = {
  // The shell hands the WebView's HTML over at boot; the shim serves it at /.
  'ui.page': async ({ html }) => {
    uiPage = String(html || '')
    return { ok: true, port: shimPort }
  },

  'getSettings': async () => readSettings(),
  'setSettings': async (patch) => {
    const next = { ...readSettings(), ...patch }
    writeSettings(next)
    return next
  },

  // Everything the UI needs to draw its first screen, in one call.
  'app.state': async () => {
    const active = H.activeHost(hostsState)
    return {
      platform: PLATFORM,
      deviceKey: z32.encode(keyPair.publicKey),
      hosts: hostsState.hosts.map((h) => ({ ...h, active: h.hostKey === hostsState.activeHostKey })),
      active: active ? { hostKey: active.hostKey, libraryName: active.libraryName } : null,
      shimPort
    }
  },

  // Pair by the link a QR or a paste carries. On success the host joins the list
  // and becomes active.
  'pair': async ({ link, label = '' }) => {
    const c = new Client({ protocol, keyPair, log: (m, d) => log(m, d) })
    try {
      const paired = await c.pair(link, { label, platform: PLATFORM })
      hostsState = H.addHost(hostsState, {
        hostKey: z32.encode(paired.hostKey),
        libraryId: paired.libraryId,
        libraryName: paired.libraryName
      }, Date.now())
      writeHosts(hostsState)
      emit('hosts:changed', {})
      return { libraryId: paired.libraryId, libraryName: paired.libraryName }
    } finally {
      await c.close().catch(() => {})
    }
  },

  'hosts.setActive': async ({ hostKey }) => {
    hostsState = H.setActive(hostsState, hostKey)
    writeHosts(hostsState)
    if (client) { try { await client.close() } catch {} ; client = null }
    return { ok: true }
  },

  // Leave: tell the host to drop this device's own grant (best-effort - an
  // unreachable host still gets removed locally; its grant dies of expiry or the
  // operator's hand), then forget it here.
  'hosts.remove': async ({ hostKey }) => {
    const leaving = hostsState.hosts.find((h) => h.hostKey === hostKey)
    if (leaving) {
      try {
        const c = await connected()
        if (z32.encode(c.hostKey) === hostKey || b4a.equals(c.hostKey, z32.decode(hostKey))) {
          await c.deviceLeave().catch(() => {})
        }
      } catch {}
    }
    // removeHost returns { file, removed } - the file is the new state, and
    // assigning the wrapper instead would silently eat the whole host list on
    // the next write. Caught the first time a UI actually called this.
    hostsState = H.removeHost(hostsState, hostKey).file
    writeHosts(hostsState)
    if (client) { try { await client.close() } catch {} ; client = null }
    emit('hosts:changed', {})
    return { ok: true }
  },

  // The library, proxied. The UI's vocabulary IS the host's - no translation
  // layer to drift.
  'library.stats': async () => (await connected()).stats(),
  'library.list': async (args) => (await connected()).list(args),
  'library.get': async (args) => (await connected()).get(args),
  'library.search': async (args) => (await connected()).search(args),

  // Watch state - the same per-person store the dashboard writes, which is the
  // claim this app exists to prove: a laptop and a phone sharing one position.
  'resume.set': async (args) => (await connected()).request('resume.set', args),
  'resume.get': async (args) => (await connected()).request('resume.get', args),
  'resume.list': async (args) => (await connected()).request('resume.list', args),
  'watched.set': async (args) => (await connected()).request('watched.set', args),
  'watched.list': async (args) => (await connected()).request('watched.list', args),

  // The watchlist, requests, the owner's view and this device's identity -
  // straight proxies; the host derives WHO from the connection, never a param.
  'fav.set': async (args) => (await connected()).request('fav.set', args),
  'fav.list': async (args) => (await connected()).request('fav.list', args),
  'request.add': async (args) => (await connected()).request('request.add', args),
  'request.list': async (args) => (await connected()).request('request.list', args),
  'request.remove': async (args) => (await connected()).request('request.remove', args),
  'request.all': async (args) => (await connected()).request('request.all', args),
  'request.resolve': async (args) => (await connected()).request('request.resolve', args),
  'device.list': async (args) => (await connected()).request('device.list', args),
  'device.revoke': async (args) => (await connected()).request('device.revoke', args),
  'identity.get': async (args) => (await connected()).request('identity.get', args),
  'identity.set': async (args) => (await connected()).request('identity.set', args),
  'avatar.set': async (args) => (await connected()).request('avatar.set', args),

  // Downloads: pin a film for offline. The bytes ride the same media.stream
  // chokepoint as playback; the shim then serves the finished file off disk,
  // connection or none.
  'download.start': async ({ itemId }) => startDownload(String(itemId || '')),
  'download.cancel': async ({ itemId }) => {
    downloads.get(String(itemId || ''))?.cancel()
    return { ok: true }
  },
  'download.remove': async ({ itemId }) => {
    const id = String(itemId || '')
    cache.remove(id)
    cache.save()
    emit('download:removed', { itemId: id })
    return { ok: true }
  },
  'download.list': async () => {
    const items = Object.entries(cache.index || {})
      .filter(([, e]) => e.pinned)
      .map(([id, e]) => ({ itemId: id, size: e.size || 0, mime: e.mime || null }))
    const running = [...downloads.entries()].map(([id, d]) => ({ itemId: id, got: d.got(), size: d.size }))
    return { items, running }
  },

  'subtitle.list': async (args) => (await connected()).request('subtitle.list', args),

  // The track's text, as WebVTT. The host STREAMS it (subtitle bytes ride the
  // same chokepoint as film bytes); buffered here because a subtitle file is
  // tens of kilobytes and the shell wants one string, not a byte feed.
  'subtitle.get': async (args) => {
    const buf = await (await connected()).request('subtitle.get', args, { stream: true })
    return { vtt: b4a.toString(buf) }
  },

  // The shell hands over the raw MediaCodecList probe at boot; the mapper's
  // policy turns it into this device's declaration. A missing or broken probe
  // changes nothing - the static floor stands, and under-declaring only costs
  // the host some engine time.
  'capabilities.declare': async ({ probe }) => {
    const mapped = caps.fromProbe(probe)
    if (mapped) capabilities = mapped
    log('capabilities:declared', { fromProbe: !!mapped, ...capabilities })
    return { ok: true, fromProbe: !!mapped, capabilities }
  },

  // Where the player should point - and WHICH KIND of stream that is. The host
  // decides from this device's declared capabilities: direct play gets the
  // byte-range shim URL; a codec this device does not declare gets the HLS
  // playlist whose segments the host transcodes on demand. The player cannot
  // tell it is being helped.
  //
  // `deviceRefusedVideo` is the UI's retry after the native player errored on
  // a direct-played file: the decoder just proved the declaration wrong for
  // this item's video codec, so the device re-describes itself without it and
  // the host decides again - usually landing on transcode. The client still
  // never ASKS for a mode; it only tells the truth about itself.
  'stream.url': async ({ itemId, deviceRefusedVideo = false }) => {
    // A downloaded film needs no host at all - the shim serves it off disk
    // with full Range support. Checked BEFORE connecting, or offline playback
    // would die asking a host it does not need.
    if (!deviceRefusedVideo && cache.has(String(itemId))) {
      return { url: shim.urlFor(itemId), mode: 'download' }
    }
    const c = await connected()
    if (deviceRefusedVideo) {
      const item = await c.get({ id: itemId }).catch(() => null)
      const bad = item?.media?.videoCodec
      if (bad) {
        refusedVideo.set(itemId, bad)
        log('stream:device-refused', { itemId, videoCodec: bad })
      }
    }
    const verdict = await c.request('media.decide', { itemId, capabilities: capsFor(itemId) }).catch(() => null)
    if (verdict?.mode === 'transcode') {
      return { url: `http://127.0.0.1:${shimPort}/hls/${itemId}.m3u8`, mode: 'transcode' }
    }
    // `remux` collapses to direct on a phone: ExoPlayer opens the containers a
    // browser refuses, which is why the phone declared them.
    return { url: shim.urlFor(itemId), mode: verdict?.mode || 'direct' }
  },
  'art.base': async () => ({ base: shim.artBase() }),

  'ping': async () => (await connected()).ping()
}

// --- IPC loop ---------------------------------------------------------------

let buf = ''
BareKit.IPC.on('data', async (data) => {
  buf += b4a.toString(data)
  const lines = buf.split('\n')
  buf = lines.pop()

  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    const fn = methods[msg.method]
    if (!fn) {
      send({ id: msg.id, error: `unknown method: ${msg.method}` })
      continue
    }

    try {
      const result = await fn(msg.args || {})
      send({ id: msg.id, result })
    } catch (e) {
      log('method:failed', { method: msg.method, err: e.message })
      send({ id: msg.id, error: e.message })
    }
  }
})

// The shim listens at boot so the UI can compose URLs from its very first state
// read. Port 0: the OS picks, and the URLs are only valid for this process's
// life - which is exactly the lifetime of the WebView that holds them.
shim.listen().then((port) => {
  shimPort = port
  emit('shim:ready', { port })
}).catch((e) => log('shim:failed', { err: e.message }))

log('worklet:loaded', { platform: PLATFORM })
emit('ready', {})
