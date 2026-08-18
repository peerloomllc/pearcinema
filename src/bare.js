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

// Title, year and runtime per downloaded item, written at download time. The
// cache index only knows bytes, so without this an offline Downloads list can
// name a film nothing better than 'A removed title'.
const DL_META_FILE = path.join(DATA_DIR, 'download-meta.json')

function readDlMeta () {
  try { return JSON.parse(fs.readFileSync(DL_META_FILE, 'utf8')) || {} } catch { return {} }
}
function writeDlMeta (m) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(DL_META_FILE, JSON.stringify(m))
}

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

// The image subtitle track the viewer chose for an item, to be BURNED into the
// picture by the host - per item, set and cleared by stream.url. Rides the
// capability declaration for the same reason data saver does: one seam covers
// decide, the playlist and every segment, and the host still decides. RAM-only
// on purpose - a fresh process starts unburned, like a fresh playback.
const burnSub = new Map()

const DATA_SAVER_KBPS = 2500

function capsFor (itemId) {
  const bad = refusedVideo.get(itemId)
  const base = bad ? caps.without(capabilities, bad) : capabilities
  const settings = readSettings()
  let out = settings.dataSaver ? { ...base, maxKbps: DATA_SAVER_KBPS } : base
  // The 35mm skin's tone rides the declaration like data saver does: a fact
  // about how this viewer wants to watch, and the host still decides - no
  // engine means the film arrives untinted under the skin's overlay.
  if (settings.playerSkin === 'film' && ['bw', 'sepia'].includes(settings.playerTone)) {
    out = { ...out, tone: settings.playerTone }
  }
  const burn = burnSub.get(itemId)
  return burn ? { ...out, burnSubtitleId: burn } : out
}

// Downloads describe the device without the viewing session: a subtitle choice
// or a skin's tone made in the player must not bake itself into the copy the
// phone keeps, nor steer the download's decide toward a conversion it does
// not need.
function capsForDownload (itemId) {
  const { burnSubtitleId, tone, ...rest } = capsFor(itemId)
  return rest
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

// N clients, one per paired host (proposal 2026-08-16-merged-libraries §1).
// Each entry is single-flight; all connections come off the one shared DHT.
// An offline host is a caught error at its call site, never a poisoned pool.
const merge = require('./merge')
const hostConns = new Map() // libraryId -> { client, connecting }

function hostRow (libraryId) {
  return hostsState.hosts.find((h) => h.libraryId === libraryId) || null
}

async function connectedLib (libraryId) {
  const row = hostRow(libraryId)
  if (!row) throw new Error('not paired with that library')

  let slot = hostConns.get(libraryId)
  if (!slot) { slot = { client: null, connecting: null }; hostConns.set(libraryId, slot) }
  if (slot.client && slot.client.conn && !slot.client.conn.destroyed) return slot.client
  if (slot.connecting) return slot.connecting

  slot.connecting = (async () => {
    if (slot.client) { try { await slot.client.close() } catch {} }
    const c = new Client({ protocol, keyPair, log: (m, d) => log(m, d) })
    await c.connect({ hostKey: z32.decode(row.hostKey), libraryId: row.libraryId })
    // Pushes from EVERY connected host flow to the one UI handler, tagged with
    // their library so a shelf can scope its refetch.
    c.onPush = (m) => emit('host:push', { ...(m && typeof m === 'object' ? m : { value: m }), libraryId })
    c.conn.once('close', () => emit('host:disconnected', { hostKey: row.hostKey, libraryId }))
    slot.client = c
    emit('host:connected', { hostKey: row.hostKey, libraryId, libraryName: row.libraryName })
    // A host coming online that the merged index has not heard from yet is
    // catalog we are not showing - rebuild (debounced, and a no-op single-host).
    if (mergedOn() && !contributedLibs.has(libraryId)) buildSoon('host-online')
    return c
  })()

  try {
    return await slot.connecting
  } finally {
    slot.connecting = null
  }
}

// The active host, for everything that is per-device or per-dashboard rather
// than per-item: identity, devices, pairing, requests.
async function connected () {
  const active = H.activeHost(hostsState)
  if (!active) throw new Error('not paired with any library')
  return connectedLib(active.libraryId)
}

// The host that OWNS an id (item, season, series or art), for everything that
// is per-item: streams, art, watch-state writes. Falls back to the active host
// when ownership is unknown - which is exactly the single-host case.
async function clientForId (id) {
  const lib = owners.get(String(id))
  if (lib && hostRow(lib)) return connectedLib(lib)
  return connected()
}

function closeAllConns () {
  for (const slot of hostConns.values()) {
    if (slot.client) { try { slot.client.close() } catch {} }
    slot.client = null
  }
  hostConns.clear()
}

function connectedLibs () {
  const out = new Set()
  for (const [lib, slot] of hostConns) {
    if (slot.client && slot.client.conn && !slot.client.conn.destroyed) out.add(lib)
  }
  return out
}

// --- the merged library (proposal 2026-08-16-merged-libraries) ---------------
//
// With more than one paired host the browse surface is the MERGED index: every
// reachable host's full catalog, deduped in memory, served without touching
// the wire. One host keeps today's exact pass-through behavior.

const MERGED_DIR = path.join(DATA_DIR, '_merged')
const CATALOGS_FILE = path.join(MERGED_DIR, 'catalogs.json')

let mergedIndex = null
let owners = new Map() // any id (item/season/series) -> owning libraryId
let artOwners = new Map() // artId -> owning libraryId
let contributedLibs = new Set() // libraryIds inside the current index
let buildFlight = null
let buildTimer = null

function mergedOn () { return hostsState.hosts.length > 1 }
function libraryFilter () { return readSettings().libraryFilter || '_all' }

function adoptCatalogs (catalogs) {
  mergedIndex = merge.buildIndex(catalogs)
  owners = new Map()
  artOwners = new Map()
  contributedLibs = new Set()
  for (const c of catalogs) {
    contributedLibs.add(c.libraryId)
    for (const list of [c.movies, c.series, c.episodes]) {
      for (const x of list || []) {
        owners.set(String(x.id), c.libraryId)
        if (x.artId) artOwners.set(String(x.artId), c.libraryId)
        // Season and series ids ride on episodes, so the real-id tree paths
        // route without a separate seasons fetch.
        if (x.seasonId) owners.set(String(x.seasonId), c.libraryId)
        if (x.seriesId) owners.set(String(x.seriesId), c.libraryId)
      }
    }
  }
}

// The cold cache: last run's catalogs, so a launch renders the blend instantly
// and refreshes behind it. Stale is fine - it is the same staleness a single
// host's first paint always had.
try { adoptCatalogs(JSON.parse(fs.readFileSync(CATALOGS_FILE, 'utf8'))) } catch {}

// One host's ENTIRE catalog: movies and series paged to exhaustion, episodes
// walked per series. Personal scale - the Umbrel's 2,746 episodes arrive in a
// handful of pages.
async function fetchCatalog (c, libraryId) {
  const drain = async (params) => {
    const out = []
    let cursor = 0
    for (;;) {
      const page = await c.list({ ...params, limit: 500, cursor })
      out.push(...(page.items || []))
      if (!page.cursor || !(page.items || []).length) break
      cursor = page.cursor
    }
    return out
  }
  const movies = await drain({ type: 'movies' })
  const series = await drain({ type: 'series' })
  const episodes = []
  for (const s of series) {
    episodes.push(...await drain({ type: 'episodes', seriesId: s.id }))
  }
  return { libraryId, movies, series, episodes }
}

async function buildMerged (reason) {
  if (!mergedOn()) return
  if (buildFlight) return buildFlight
  buildFlight = (async () => {
    const cats = []
    await Promise.all(hostsState.hosts.map(async (h) => {
      try {
        cats.push(await raced((async () => {
          const c = await connectedLib(h.libraryId)
          return fetchCatalog(c, h.libraryId)
        })(), 30000))
      } catch (e) {
        // Offline is absence, not failure: the host's items simply are not in
        // this build, and its next connect triggers another one.
        log('merged:host-absent', { library: h.libraryName, err: e.message })
      }
    }))
    if (!cats.length) return
    adoptCatalogs(cats)
    try {
      fs.mkdirSync(MERGED_DIR, { recursive: true })
      fs.writeFileSync(CATALOGS_FILE, JSON.stringify(cats))
    } catch {}
    log('merged:built', { reason, hosts: cats.length, movies: mergedIndex.movies.length, series: mergedIndex.series.length, episodes: mergedIndex.episodes.length })
    emit('merged:changed', { reason })
  })().finally(() => { buildFlight = null })
  return buildFlight
}

function buildSoon (reason) {
  if (!mergedOn()) return
  clearTimeout(buildTimer)
  buildTimer = setTimeout(() => buildMerged(reason).catch((e) => log('merged:build-failed', { err: e.message })), 800)
}

// A fan-out branch must not wait forever. A host that is DOWN fails its
// connect quickly, but a ZOMBIE - a paused container, a machine mid-sleep -
// black-holes the wire and a request to it simply never answers (found on the
// TCL with the Umbrel container paused: the resume offer never appeared,
// because one branch of the fan-out hung the whole Promise.all). Every
// per-host branch races this; the healthy hosts' answers are what the person
// gets.
const FAN_TIMEOUT_MS = 6000
function raced (p, ms = FAN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('host timed out')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

// Ask every paired host the same question, tolerating the offline ones.
// Answers come back in host-list order so unions are stable across calls.
async function fanOut (fn) {
  const rs = await Promise.all(hostsState.hosts.map(async (h) => {
    try { return await raced((async () => fn(await connectedLib(h.libraryId)))()) } catch { return null }
  }))
  return rs.filter(Boolean)
}

// The merged series row a UI-held seriesId belongs to - the UI navigates with
// real host ids (the primary's), so the tree handlers translate.
function findMergedSeries (seriesId) {
  if (!mergedIndex) return null
  const id = String(seriesId || '')
  return mergedIndex.series.find((s) => s.copies.some((c) => c.id === id)) || null
}

// The device-aware copy rank (proposal §5): a copy this chip direct-plays
// outranks one that would need the host's engine. The declaration is the same
// one capsFor sends; refusals are per-item so a lying chip's correction rides
// along.
function copyRank () {
  return (copy) => {
    const codec = String(copy.videoCodec || '').toLowerCase()
    if (!codec) return 0
    const declared = (capabilities.videoCodecs || []).includes(codec)
    const refused = [...refusedVideo.values()].includes(codec)
    return declared && !refused ? 1 : 0
  }
}

// The merged movie or episode an id belongs to, by any of its copies.
function mergedEntityFor (id) {
  if (!mergedIndex) return null
  const key = String(id || '')
  return mergedIndex.movies.find((m) => m.copies.some((c) => c.id === key)) ||
    mergedIndex.episodes.find((e) => e.copies.some((c) => c.id === key)) || null
}

// Every host holding a copy of an id, each with ITS OWN id for it - the write
// fan-out's address book (phase 2). Series included: a heart on a show must
// land on both hosts that carry it. An id the index does not know falls back
// to its owner alone.
function copyRefs (id) {
  const key = String(id || '')
  const e = mergedEntityFor(key) ||
    (mergedIndex ? mergedIndex.series.find((s) => s.copies.some((c) => c.id === key)) : null)
  if (!e) {
    const lib = owners.get(key)
    return lib ? [{ libraryId: lib, id: key }] : []
  }
  return e.copies.map((c) => ({ libraryId: c.libraryId, id: c.id }))
}

// A write that must land on EVERY copy - a position or a watched mark saved to
// one host of two is a shelf that disagrees with itself depending on which
// server answers first. Best-effort per host; ok when ANY landed, because an
// offline host misses presence pushes exactly the same way and catches up the
// next time the state is written.
async function writeToCopies (id, fn) {
  const refs = copyRefs(id)
  if (refs.length < 2) return fn(await clientForId(id), String(id))
  let ok = 0
  let out = null
  await Promise.all(refs.map(async (ref) => {
    try { out = await raced((async () => fn(await connectedLib(ref.libraryId), ref.id))()); ok++ } catch {}
  }))
  if (!ok) throw new Error('no library reachable for that')
  return out
}

// Which copy of a merged item should actually stream (proposal §5): the filter
// chip's library if reachable, else the best copy for THIS device among the
// reachable ones. Returns the copy's own id - the caller streams THAT. When
// the pick diverges from the asked-for id, resume still records against the
// asked-for id; a cross-host position merge is phase 2.
function pickCopyId (itemId) {
  if (!mergedOn() || !mergedIndex) return String(itemId)
  const entity = mergedEntityFor(itemId)
  if (!entity || entity.copies.length < 2) return String(itemId)
  const live = connectedLibs()
  const prefer = libraryFilter() === '_all' ? null : libraryFilter()
  const pick = merge.bestCopy(entity, live.size ? live : null, prefer, copyRank())
  if (pick && pick.id && pick.id !== String(itemId)) {
    log('merged:copy-pick', { asked: String(itemId).slice(0, 8), picked: String(pick.id).slice(0, 8), library: pick.libraryId })
    return String(pick.id)
  }
  return String(itemId)
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
  // Downloads pick a copy the way play does (phase 3): the bytes come from the
  // best copy for this device, but they are STORED under the id the UI asked
  // for - the download list, the cache check in stream.url and the pin all
  // speak that id, and the shim serves a cache hit by id alone.
  const srcId = pickCopyId(itemId)
  const c = await clientForId(srcId)
  const item = await c.get({ id: srcId })
  const size = item?.media?.size
  if (!size) throw new Error('this one cannot be downloaded')
  const dlMeta = readDlMeta()
  dlMeta[itemId] = { title: item.title || '', year: item.year || null, runtime: item.runtime || null }
  writeDlMeta(dlMeta)
  const mime = CONTAINER_MIME[String(item?.media?.container || '').toLowerCase()] || 'video/mp4'
  // The cache tags the film with the library the bytes CAME from, which in
  // merged mode is the picked copy's host, not whichever library is active.
  const active = { libraryId: owners.get(srcId) || H.activeHost(hostsState)?.libraryId || null }

  // THE HOST DECIDES for downloads exactly as for playback: the same declared
  // capabilities, the same decide(). A transcode verdict - the file busts the
  // data-saver budget, or this device cannot decode it at all - means the
  // download is the CONVERTED film, which is also the only version the phone
  // could have played offline.
  const verdict = await c.request('media.decide', { itemId: srcId, capabilities: capsForDownload(srcId) }).catch(() => null)
  if (verdict?.mode === 'transcode') return startExportDownload({ c, itemId, srcId, item, active })
  const sink = cache.createSink(itemId, { mime, size, library: active?.libraryId || null, pinned: true })
  let got = 0
  let lastEmit = 0
  const p = c.streamTo({ itemId: srcId, offset: 0, length: size }, (chunk) => {
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

// The converted-download path: one media.export call streamed whole into the
// cache. No known final size - the host is encoding as it sends - so progress
// runs against an estimate from the encoder's own bitrate ladder, and the sink
// commits whatever cleanly ended. Truncation is the HOST's job to catch: its
// export stream only ends cleanly when ffmpeg exited 0, anything else arrives
// here as a wire error and aborts the sink.
function startExportDownload ({ c, itemId, srcId = itemId, item, active }) {
  // The ladder the host encodes with, capped at the declared budget - the same
  // arithmetic as host/transcode.js bitrateFor/capBitrate, plus audio headroom.
  const w = Number(item?.media?.width) || 0
  const ladder = w >= 1600 ? 6000 : w >= 1000 ? 3000 : 1500
  const budget = Number(capsForDownload(srcId).maxKbps) || 0
  const kbps = (budget ? Math.min(ladder, budget) : ladder) + 200
  const est = Math.max(1, Math.round((kbps * 1000 / 8) * (Number(item?.runtime) || 0)))

  const sink = cache.createSink(itemId, { mime: 'video/mp4', size: null, library: active?.libraryId || null, pinned: true })
  let got = 0
  let lastEmit = 0
  const p = c.request('media.export', { itemId: srcId, capabilities: capsForDownload(srcId) }, {
    stream: true,
    buffer: false,
    onchunk: (chunk) => {
      got += chunk.length
      sink.write(chunk)
      if (got - lastEmit > 16 * 1024 * 1024) {
        lastEmit = got
        // The estimate can undershoot; hold the bar at 99% rather than lie past it.
        emit('download:progress', { itemId, got: Math.min(got, Math.round(est * 0.99)), size: est, approx: true })
      }
    }
  })
  downloads.set(itemId, { cancel: () => p.cancel?.(), got: () => Math.min(got, Math.round(est * 0.99)), size: est, approx: true })
  p.then(async (out) => {
    downloads.delete(itemId)
    if (out?.cancelled) {
      sink.abort()
      emit('download:failed', { itemId, reason: 'cancelled' })
      return
    }
    // The saver was toggled between decide and export - the host refused to
    // convert what needs no converting. Nothing was streamed; take the bytes.
    if (out?.direct) {
      sink.abort()
      startDownload(itemId).catch((e) => emit('download:failed', { itemId, reason: e.message }))
      return
    }
    const stored = await sink.commit()
    emit(stored ? 'download:done' : 'download:failed', { itemId, reason: stored ? undefined : 'incomplete' })
  }).catch((e) => {
    downloads.delete(itemId)
    sink.abort()
    emit('download:failed', { itemId, reason: e.message })
  })
  emit('download:progress', { itemId, got: 0, size: est, approx: true })
  return { ok: true, converting: true }
}

const shim = createAudioShim({
  log: (m, d) => log(m, d),
  cache,
  defaultClient: () => connected(),
  // Multi-host routing (proposal 2026-08-16 §5): the shim resolves each
  // request's OWNING host through the merged index's ownership maps. URLs stay
  // id-only - ids are namespaced by library, so a lookup is enough - and a
  // cache hit never gets this far.
  hostClient: (lib) => connectedLib(lib),
  libForTrack: (id) => owners.get(String(id)) || null,
  libForCover: (id) => artOwners.get(String(id)) || null,
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
        const c = await clientForId(itemId)
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
        const c = await clientForId(itemId)
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
    const live = connectedLibs()
    return {
      platform: PLATFORM,
      deviceKey: z32.encode(keyPair.publicKey),
      hosts: hostsState.hosts.map((h) => ({
        ...h,
        active: h.hostKey === hostsState.activeHostKey,
        online: live.has(h.libraryId),
        inMerge: contributedLibs.has(h.libraryId)
      })),
      active: active ? { hostKey: active.hostKey, libraryName: active.libraryName } : null,
      // The merged view: on with more than one library, filtered by the chip.
      merged: { on: mergedOn(), ready: !!mergedIndex, filter: libraryFilter() },
      shimPort
    }
  },

  // The filter chip (proposal §6): '_all' is the blend, a libraryId narrows to
  // one host. A preference, persisted like the theme.
  'merged.filter': async ({ libraryId }) => {
    const next = { ...readSettings(), libraryFilter: String(libraryId || '_all') }
    writeSettings(next)
    return { filter: next.libraryFilter }
  },

  // A pull-to-refresh for the blend, and the boot hook the UI calls once its
  // first screen is up.
  'merged.refresh': async () => {
    await buildMerged('refresh')
    return { ok: true, ready: !!mergedIndex }
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
      // A second library just arrived - the merged view wants its catalog.
      buildSoon('paired')
      emit('hosts:changed', {})
      return { libraryId: paired.libraryId, libraryName: paired.libraryName }
    } finally {
      await c.close().catch(() => {})
    }
  },

  'hosts.setActive': async ({ hostKey }) => {
    hostsState = H.setActive(hostsState, hostKey)
    writeHosts(hostsState)
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
    // The removed host's connection dies with its row, and the merged index
    // must stop offering its items.
    closeAllConns()
    buildSoon('removed')
    emit('hosts:changed', {})
    return { ok: true }
  },

  // The library. One host: proxied straight through, the UI's vocabulary IS
  // the host's. More than one: served from the merged index (proposal
  // 2026-08-16), which speaks the same vocabulary - the UI cannot tell.
  'library.stats': async () => (await connected()).stats(),
  'library.list': async (args) => {
    if (!mergedOn() || !mergedIndex) return (await connected()).list(args)
    const type = String(args.type || 'movies')
    if (type === 'movies' || type === 'series') {
      const src = type === 'movies' ? mergedIndex.movies : mergedIndex.series
      const sorted = merge.sortItems(merge.filterByLibrary(src, libraryFilter()), args.sort || 'title', args.order || 'asc')
      const start = Math.max(0, Math.floor(Number(args.cursor) || 0))
      const size = Math.min(500, Math.max(1, Math.floor(Number(args.limit) || 100)))
      const items = sorted.slice(start, start + size)
      return { items, cursor: start + size < sorted.length ? start + size : null, total: sorted.length }
    }
    if (type === 'seasons') {
      const s = findMergedSeries(args.seriesId)
      if (s) return { items: merge.seasonsFor(mergedIndex, s.key), cursor: null }
      return (await clientForId(args.seriesId)).list(args)
    }
    if (type === 'episodes') {
      const parsed = merge.parseMergedSeasonId(args.seasonId)
      if (parsed) {
        return { items: merge.episodesFor(mergedIndex, parsed.seriesKey, parsed.seasonNumber, parsed.seasonTitle), cursor: null }
      }
      return (await clientForId(args.seasonId || args.seriesId)).list(args)
    }
    return (await connected()).list(args)
  },
  'library.get': async (args) => (await clientForId(args.id)).get(args),
  'library.search': async (args) => {
    if (!mergedOn() || !mergedIndex) return (await connected()).search(args)
    const r = merge.searchIndex(mergedIndex, args.q, Number(args.limit) || 60)
    const items = [...r.movies, ...r.series, ...r.episodes].slice(0, Number(args.limit) || 60)
    return { items }
  },
  // The player's next and previous episode. One host answers structurally; the
  // merged view answers from its own interleaved run, because a series can
  // SPAN hosts and the season-boundary neighbour may live on the other one.
  'library.siblings': async (args) => {
    if (!mergedOn() || !mergedIndex) return (await connected()).request('library.siblings', args)
    const id = String(args.id || '')
    const ep = mergedIndex.episodes.find((e) => e.copies.some((c) => c.id === id))
    if (!ep) return (await clientForId(id)).request('library.siblings', args)
    const run = merge.seriesRun(mergedIndex, ep.seriesKey)
    const at = run.findIndex((e) => e.key === ep.key)
    if (at < 0) return { prev: null, next: null }
    return { prev: run[at - 1] || null, next: run[at + 1] || null }
  },

  // Watch state - the same per-person store the dashboard writes. A position
  // lands on EVERY host holding a copy (phase 2), so either server resumes the
  // same film at the same minute; a read takes the freshest answer across
  // them. The Continue shelf is every host's answer concatenated newest-first.
  'resume.set': async (args) => writeToCopies(args.itemId, (c, id) => c.request('resume.set', { ...args, itemId: id })),
  'resume.get': async (args) => {
    const refs = copyRefs(args.itemId)
    if (refs.length < 2) return (await clientForId(args.itemId)).request('resume.get', args)
    let best = { resume: null }
    await Promise.all(refs.map(async (ref) => {
      try {
        const r = await raced((async () => (await connectedLib(ref.libraryId)).request('resume.get', { ...args, itemId: ref.id }))())
        if (r?.resume && (!best.resume || (r.resume.playedAt || 0) > (best.resume.playedAt || 0))) best = r
      } catch {}
    }))
    return best
  },
  'resume.list': async (args) => {
    if (!mergedOn()) return (await connected()).request('resume.list', args)
    const rows = await fanOut((c) => c.request('resume.list', args))
    const items = rows.flatMap((r) => r?.items || [])
      .sort((a, b) => (b.resume?.playedAt || 0) - (a.resume?.playedAt || 0))
    return { items: items.slice(0, Number(args.limit) || 20) }
  },
  'watched.set': async (args) => writeToCopies(args.itemId, (c, id) => c.request('watched.set', { ...args, itemId: id })),
  'watched.list': async (args) => {
    if (!mergedOn()) return (await connected()).request('watched.list', args)
    const rows = await fanOut((c) => c.request('watched.list', args))
    return { items: [...new Set(rows.flatMap((r) => r?.items || []))] }
  },

  // The watchlist: a heart lands on every host holding a copy (phase 2), the
  // list is the union.
  'fav.set': async (args) => writeToCopies(args.id, (c, id) => c.request('fav.set', { ...args, id })),
  'fav.list': async (args) => {
    if (!mergedOn()) return (await connected()).request('fav.list', args)
    const rows = await fanOut((c) => c.request('fav.list', args))
    const seen = new Set()
    const items = []
    for (const r of rows) {
      for (const i of r?.items || []) {
        const k = String(i.id)
        if (seen.has(k)) continue
        seen.add(k)
        items.push(i)
      }
    }
    return { items }
  },
  // Requests across the blend (phase 2, PearTune's shipped shape): an ask is
  // filed with EVERY reachable host - none of them has the film, so any of
  // their owners might add it - and the lists collapse the per-host rows to
  // one ask carrying the best status. The owner's queue folds the same rows
  // pending-first, because that view is a to-do list and one library resolved
  // must not hide the copies that are not.
  'request.add': async (args) => {
    if (!mergedOn()) return (await connected()).request('request.add', args)
    const rs = await fanOut((c) => c.request('request.add', args))
    if (!rs.length) throw new Error('no library reachable to ask')
    return rs[0]
  },
  'request.list': async (args) => {
    if (!mergedOn()) return (await connected()).request('request.list', args)
    const rows = []
    await Promise.all(hostsState.hosts.map(async (h) => {
      try {
        const r = await raced((async () => (await connectedLib(h.libraryId)).request('request.list', args))())
        for (const row of r?.items || []) rows.push({ ...row, libraryId: h.libraryId, libraryName: h.libraryName })
      } catch {}
    }))
    return { items: merge.collapseRequests(rows) }
  },
  'request.remove': async ({ id, refs }) => {
    if (!mergedOn()) return (await connected()).request('request.remove', { id })
    const targets = merge.requestTargets({ refs, id }, { pendingOnly: false, fallbackLibraryId: owners.get(String(id)) })
    let ok = 0
    await Promise.all(targets.map(async (t) => {
      try { await raced((async () => (await connectedLib(t.libraryId)).request('request.remove', { id: t.id }))()); ok++ } catch {}
    }))
    if (!ok) throw new Error('no library reachable for that')
    return { ok: true }
  },
  'request.all': async (args) => {
    if (!mergedOn()) return (await connected()).request('request.all', args)
    const rows = []
    await Promise.all(hostsState.hosts.map(async (h) => {
      try {
        const r = await raced((async () => (await connectedLib(h.libraryId)).request('request.all', args))())
        for (const row of r?.items || []) rows.push({ ...row, libraryId: h.libraryId, libraryName: h.libraryName })
      } catch {}
    }))
    return { items: merge.collapseRequests(rows, { pendingWins: true }) }
  },
  'request.resolve': async ({ id, status, refs }) => {
    if (!mergedOn()) return (await connected()).request('request.resolve', { id, status })
    // Only the copies still PENDING: an added fan-out must never rewrite a
    // copy another owner already declined.
    const targets = merge.requestTargets({ refs, id }, { fallbackLibraryId: owners.get(String(id)) })
    let ok = 0
    await Promise.all(targets.map(async (t) => {
      try { await raced((async () => (await connectedLib(t.libraryId)).request('request.resolve', { id: t.id, status }))()); ok++ } catch {}
    }))
    if (!ok) throw new Error('no library reachable for that')
    return { ok: true }
  },
  // --- casting to a television (video-deltas §5) ---------------------------
  //
  // The HOST does the casting - the phone only says which film on which TV.
  // Every target carries the library whose Home Assistant reported it, because
  // the film must stream FROM that host: a cast URL minted by one server
  // cannot serve another server's file. That is also the merged-mode copy-pick
  // rule in cast.play below.
  'cast.list': async (args) => {
    const out = { enabled: false, targets: [], active: [] }
    // Asked FOR a film, only libraries holding a copy answer - a television
    // whose host cannot serve the film is a button that ends in an error.
    let libsWithCopy = null
    if (args?.itemId && mergedOn() && mergedIndex) {
      const entity = mergedEntityFor(String(args.itemId))
      if (entity) libsWithCopy = new Set(entity.copies.map((c) => c.libraryId))
    }
    const hosts = hostsState.hosts.filter((h) => !libsWithCopy || libsWithCopy.has(h.libraryId))
    await Promise.all(hosts.map(async (h) => {
      try {
        const r = await raced((async () => (await connectedLib(h.libraryId)).request('cast.list', {}))())
        if (r?.enabled) out.enabled = true
        for (const t of r?.targets || []) out.targets.push({ ...t, libraryId: h.libraryId, libraryName: h.libraryName })
        for (const a of r?.active || []) out.active.push({ ...a, libraryId: h.libraryId, libraryName: h.libraryName })
      } catch {}
    }))
    return out
  },
  'cast.play': async (args) => {
    const lib = args.libraryId || null
    // THE COPY PICK, merged phase 3's last sliver: the television belongs to
    // one host's Home Assistant, so the copy that streams must be THAT host's
    // own - the blend offers only televisions from libraries holding a copy,
    // and this resolves the blended id to that library's file.
    let id = String(args.itemId)
    if (mergedOn() && mergedIndex && lib) {
      const entity = mergedEntityFor(id)
      if (entity) {
        const copy = entity.copies.find((c) => c.libraryId === lib)
        if (!copy) throw new Error('that library does not hold this film')
        id = String(copy.id)
      }
    }
    const c = lib ? await connectedLib(lib) : await connected()
    return c.request('cast.play', { entityId: args.entityId, itemId: id, at: Number(args.at) || 0 })
  },
  'cast.stop': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.stop', { entityId: args.entityId })
  },
  'cast.pause': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.pause', { entityId: args.entityId })
  },
  'cast.resume': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.resume', { entityId: args.entityId })
  },
  'cast.seek': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.seek', { entityId: args.entityId, deltaMs: args.deltaMs })
  },
  'cast.state': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.state', { entityId: args.entityId })
  },
  'device.list': async (args) => (await connected()).request('device.list', args),
  'device.revoke': async (args) => (await connected()).request('device.revoke', args),
  'identity.get': async (args) => {
    const out = await (await connected()).request('identity.get', args)
    // The host reports its CURRENT library name here - that is how a dashboard
    // rename reaches an already-paired phone. Fold it back into the stored host
    // row, which was captured at pair time and is never otherwise refreshed
    // (renameHost is idempotent, so the steady state costs nothing). Without
    // this, two libraries both showing "My Library" is the norm, not the edge.
    const active = H.activeHost(hostsState)
    if (active && out?.libraryName && out.libraryName !== active.libraryName) {
      hostsState = H.renameHost(hostsState, active.hostKey, out.libraryName)
      writeHosts(hostsState)
      emit('hosts:changed', {})
    }
    return out
  },
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
    const dlMeta = readDlMeta()
    if (dlMeta[id]) { delete dlMeta[id]; writeDlMeta(dlMeta) }
    emit('download:removed', { itemId: id })
    return { ok: true }
  },
  'download.list': async () => {
    const dlMeta = readDlMeta()
    const items = Object.entries(cache.index || {})
      .filter(([, e]) => e.pinned)
      .map(([id, e]) => ({ itemId: id, size: e.size || 0, mime: e.mime || null, ...(dlMeta[id] || {}) }))
    const running = [...downloads.entries()].map(([id, d]) => ({ itemId: id, got: d.got(), size: d.size, approx: !!d.approx }))
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
  'stream.url': async ({ itemId, deviceRefusedVideo = false, burnSubtitleId = null }) => {
    // A downloaded film needs no host at all - the shim serves it off disk
    // with full Range support. Checked BEFORE connecting, or offline playback
    // would die asking a host it does not need. A burn request skips the disk
    // copy on purpose: the download has no subtitles pressed in, so the burned
    // stream must come from the host. Checked against the id the UI asked for,
    // BEFORE any copy pick - the download lives under that id.
    if (!deviceRefusedVideo && !burnSubtitleId && cache.has(String(itemId))) {
      burnSub.delete(itemId)
      return { url: shim.urlFor(itemId), mode: 'download' }
    }

    // The merged copy pick (proposal §5): a film held by two hosts plays from
    // the one that suits this device. A burn request stays on the asked-for
    // copy - the subtitle id the person chose belongs to THAT file.
    if (!burnSubtitleId) itemId = pickCopyId(itemId)

    // The burn choice is per playback, so EVERY stream.url settles it: a call
    // that asks for a track sets it, any other call clears it - starting a
    // film fresh must never inherit the last session's burned subtitles.
    if (burnSubtitleId) burnSub.set(itemId, String(burnSubtitleId))
    else burnSub.delete(itemId)
    const c = await clientForId(itemId)
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

// The blend refreshes itself at boot: the cold cache above painted instantly,
// this fetches what changed overnight. A single-host install no-ops.
buildSoon('boot')

log('worklet:loaded', { platform: PLATFORM })
emit('ready', {})
