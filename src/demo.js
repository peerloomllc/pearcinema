'use strict'

// The DEMO LIBRARY: a few public-domain films that ship inside the app and play with
// no host at all (proposal 2026-08-26-app-review-demo, approved, PR #191).
//
// WHY IT EXISTS. PearCinema has no account and no cloud. An App Store reviewer installs
// it, opens it and is asked to pair with a dashboard on a machine they do not own -
// which reads, fairly, as an app that does nothing (Guideline 2.1). It is not only a
// review trick: anyone who installs before setting up a server hits the same wall, and
// this gives them the app working in their hand while they decide whether to run one.
//
// WHAT THIS MODULE IS. Everything about the demo library that does not need a device:
//   - buildDemoCatalog: manifest -> the movie/series/season/episode rows the browse
//     methods already serve, in the SAME shapes host/items.js emits
//   - the browse answers over that catalog (list, get, search, siblings)
//   - the watch state a library with no host has to keep on the phone
//   - the routes and the Range arithmetic the shim serves the bundled bytes with
//
// All of it is unit-testable in Node with a hand-written manifest and no phone, no
// host and no network. That is why the demo library is built here rather than inline
// in src/bare.js, which cannot be required by a test at all.
//
// THE FILMS ARE NOT COPIED ANYWHERE, and that is the one deliberate difference from
// PearTune, which installs its five CC0 tracks as pinned entries in the audio cache.
// Eighteen megabytes of music can afford that; 164 MB of film cannot. Copying it into
// the app's Documents directory would double the space the demo costs, put a second
// copy of bundled media into the iCloud backup - which Apple's own data-storage
// guidance says not to do - and make the demo show up in Downloads and in the storage
// figures as if somebody had chosen to keep it. So a demo film is served straight from
// the app bundle by the shim's /demo/ route, and the cache never learns it exists.

const merge = require('./merge')

// THE WATCH RULES ARE THE APP'S, NOT A SECOND SET. host/watch.js is pure (no requires,
// no storage) and owns what "started" and "finished" mean; a demo library that invented
// its own thresholds would put a film on the Continue shelf at a minute where a real
// library would not. It is the only place the phone reaches into host/, and it is worth
// it to keep one answer to that question rather than two that drift.
const watch = require('../host/watch')

const fs = typeof Bare !== 'undefined' ? require('bare-fs') : require('fs')

// The demo library's "source kind", the way 'folder' and 'jellyfin' name a real one.
// It is part of every id, so a demo id can never collide with a real library's - not
// even one pointed at these very files.
const DEMO_KIND = 'demo'

// Unmistakable in the library menu, per the proposal: it must never read as a paired
// library.
const DEMO_LIBRARY_NAME = 'Demo library'

// A constant stands in for the host public key a real library derives its id from.
// Deterministic on purpose: the same demo library on every install and every launch,
// so a resume position survives a relaunch rather than being filed under a fresh id.
const DEMO_HOST_SEED = 'pearcinema/demo-library/1'

// `ids` is protocol.ids from @peerloom/host - passed in rather than built here, so the
// app slug that seeds every namespace is named in exactly one place (src/bare.js).
function demoLibraryId (ids) {
  return ids.libraryId(hash(DEMO_HOST_SEED))
}

// hypercore-crypto is already in the worklet's graph; required lazily so a test that
// only wants the Range maths does not drag the whole crypto module in.
function hash (s) {
  const hcrypto = require('hypercore-crypto')
  const b4a = require('b4a')
  return hcrypto.hash(b4a.from(s))
}

// Size and mtime per bundled file, keyed by the manifest's file NAME. The shell hands
// over the RESOLVED local path of each asset (expo-asset names bundled files itself, so
// the manifest's name is a key and never a path).
//
// A file that cannot be statted yields zeros rather than throwing: the catalog build
// below leaves it out, so the demo library is one film shorter, which is a far better
// failure than a worklet that will not start.
function statDemoFiles (files = {}) {
  const out = {}
  for (const [name, p] of Object.entries(files)) {
    try {
      const s = fs.statSync(p)
      out[name] = { size: s.size, addedAt: s.mtimeMs ? Math.round(s.mtimeMs) : null }
    } catch {
      out[name] = { size: 0, addedAt: null }
    }
  }
  return out
}

const clean = (s, max = 300) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max)

function mediaOf (m = {}, size = null) {
  return {
    container: m.container || null,
    videoCodec: m.videoCodec || null,
    audioCodec: m.audioCodec || null,
    audioChannels: m.audioChannels || null,
    width: m.width || null,
    height: m.height || null,
    size: size || null
  }
}

// manifest -> the whole demo library, in the shapes the app already consumes.
//
// `files` is the shell's { manifest name -> local path } map. A film missing from it
// (an asset that would not resolve) is left out of the catalog entirely rather than
// listed and unplayable, and a show whose every episode is missing does not appear.
//
// `stats` is statDemoFiles' output, or {}: it supplies each file's byte size, and the
// catalog builds without it - which is what makes this function pure enough to test
// against a manifest and no files on disk at all.
function buildDemoCatalog (manifest, { ids, files = {}, stats = {} } = {}) {
  if (!ids) throw new Error('buildDemoCatalog needs protocol ids')
  const m = manifest || {}
  const libraryId = demoLibraryId(ids)
  const have = (name) => !Object.keys(files).length || !!files[name]

  const paths = new Map() // itemId -> the manifest file name
  const art = new Map() // artId -> the manifest's poster file name
  const movies = []
  for (const f of Array.isArray(m.films) ? m.films : []) {
    if (!f?.file || !have(f.file)) continue
    // The FILE NAME is the source key, so an id is stable across launches and app
    // versions as long as the bundled file keeps its name. The same rule a folder
    // library follows with its relative path, and for the same reason: resume
    // positions are filed under it.
    const id = ids.itemId(libraryId, DEMO_KIND, f.file)
    paths.set(id, f.file)
    if (f.poster) art.set(id, f.poster)
    const st = stats[f.file] || {}
    movies.push({
      type: 'movie',
      id,
      libraryId,
      addedAt: st.addedAt || null,
      title: clean(f.title) || f.file,
      year: f.year ?? null,
      part: null,
      runtime: f.runtime ?? null,
      overview: clean(f.overview, 4000) || null,
      genres: Array.isArray(f.genres) ? f.genres.slice(0, 30) : [],
      artId: id,
      media: mediaOf(f.media, st.size)
    })
  }

  const series = []
  const seasons = []
  const episodes = []
  for (const sh of Array.isArray(m.shows) ? m.shows : []) {
    if (!sh?.title) continue
    const seriesId = ids.groupId(libraryId, DEMO_KIND, 'series', clean(sh.title).toLowerCase())
    const rows = (Array.isArray(sh.episodes) ? sh.episodes : []).filter((e) => e?.file && have(e.file))
    if (!rows.length) continue
    if (sh.poster) art.set(seriesId, sh.poster)

    const bySeason = new Map()
    for (const e of rows) {
      const number = Number.isInteger(e.season) ? e.season : null
      const seasonId = ids.groupId(libraryId, DEMO_KIND, 'season', `${clean(sh.title).toLowerCase()}|${number ?? ''}`)
      const id = ids.itemId(libraryId, DEMO_KIND, e.file)
      paths.set(id, e.file)
      const st = stats[e.file] || {}
      episodes.push({
        type: 'episode',
        id,
        libraryId,
        addedAt: st.addedAt || null,
        seriesId,
        seasonId,
        seriesTitle: clean(sh.title),
        seasonNumber: number,
        episodeNumber: Number.isInteger(e.episode) ? e.episode : null,
        seasonTitle: null,
        title: clean(e.title) || e.file,
        year: e.year ?? null,
        runtime: e.runtime ?? null,
        overview: clean(e.overview, 4000) || null,
        artId: seriesId,
        media: mediaOf(e.media, st.size)
      })
      if (!bySeason.has(seasonId)) {
        bySeason.set(seasonId, {
          type: 'season',
          id: seasonId,
          libraryId,
          seriesId,
          seriesTitle: clean(sh.title),
          number,
          // Season 0 is Specials, and the null check is not a style choice: a
          // truthiness test files every special under "no season" (host/items.js
          // carries the same note, and PearCinema shipped that bug once).
          title: number === 0 ? 'Specials' : number === null ? 'Season' : `Season ${number}`,
          artId: seriesId,
          episodeCount: 0
        })
      }
      bySeason.get(seasonId).episodeCount++
    }

    seasons.push(...bySeason.values())
    series.push({
      type: 'series',
      id: seriesId,
      libraryId,
      title: clean(sh.title),
      year: sh.year ?? null,
      overview: clean(sh.overview, 4000) || null,
      genres: Array.isArray(sh.genres) ? sh.genres.slice(0, 30) : [],
      artId: seriesId,
      seasonCount: bySeason.size,
      episodeCount: rows.length
    })
  }

  episodes.sort((a, b) =>
    (a.seasonNumber ?? Infinity) - (b.seasonNumber ?? Infinity) ||
    (a.episodeNumber ?? Infinity) - (b.episodeNumber ?? Infinity) ||
    String(a.title).localeCompare(String(b.title)))

  return {
    libraryId,
    name: clean(m.name) || DEMO_LIBRARY_NAME,
    kind: DEMO_KIND,
    movies,
    series,
    seasons,
    episodes,
    paths,
    art,
    // Every id the demo owns, which is what the router asks about before it answers a
    // request from the bundle rather than from a host.
    ids: new Set([...paths.keys(), ...series.map((s) => s.id), ...seasons.map((s) => s.id)])
  }
}

// Which leaves the demo holds, for the counts and for the install.
function demoLeaves (catalog) {
  return [...catalog.movies, ...catalog.episodes]
}

// The `stats` a demo library reports. The same shape every adapter answers, so the
// library screen, the source label and the counts all render off it unchanged.
function demoStats (catalog) {
  return {
    source: DEMO_KIND,
    sourceName: catalog.name,
    demo: true,
    root: null,
    roots: [],
    movies: catalog.movies.length,
    series: catalog.series.length,
    episodes: catalog.episodes.length,
    scannedAt: null,
    sourceError: null
  }
}

// --- browse ------------------------------------------------------------------
//
// The same answers a host gives, over five records in memory. Paging is honoured
// because the UI's list code is written against a cursor and would otherwise never
// stop asking.

function page (items, { cursor = 0, limit = 100 } = {}) {
  const start = Math.max(0, Math.floor(Number(cursor) || 0))
  const size = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)))
  const slice = items.slice(start, start + size)
  return { items: slice, cursor: start + size < items.length ? start + size : null, total: items.length }
}

function demoList (catalog, args = {}) {
  const type = String(args.type || 'movies')
  if (type === 'movies') return page(merge.sortItems(catalog.movies, args.sort || 'title', args.order || 'asc'), args)
  if (type === 'series') return page(merge.sortItems(catalog.series, args.sort || 'title', args.order || 'asc'), args)
  if (type === 'seasons') {
    const seriesId = String(args.seriesId || '')
    const items = catalog.seasons
      .filter((s) => s.seriesId === seriesId)
      .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity))
    return { items, cursor: null, total: items.length }
  }
  if (type === 'episodes') {
    const seasonId = String(args.seasonId || '')
    const seriesId = String(args.seriesId || '')
    const items = catalog.episodes.filter((e) => (seasonId ? e.seasonId === seasonId : e.seriesId === seriesId))
    return { items, cursor: null, total: items.length }
  }
  return { items: [], cursor: null, total: 0 }
}

function demoGet (catalog, id) {
  const want = String(id || '')
  return [...catalog.movies, ...catalog.series, ...catalog.seasons, ...catalog.episodes]
    .find((x) => x.id === want) || null
}

// Title match, films first, then shows, then episodes - the order the merged search
// returns and the order the search screen renders.
function demoSearch (catalog, q, limit = 60) {
  const needle = merge.norm(q)
  if (!needle) return { items: [] }
  const hit = (s) => merge.norm(s).includes(needle)
  const items = [
    ...catalog.movies.filter((m) => hit(m.title)),
    ...catalog.series.filter((s) => hit(s.title)),
    ...catalog.episodes.filter((e) => hit(`${e.seriesTitle || ''} ${e.title}`))
  ]
  return { items: items.slice(0, Math.max(1, Number(limit) || 60)) }
}

// The player's next and previous episode, in airing order across the whole show.
function demoSiblings (catalog, id) {
  const want = String(id || '')
  const ep = catalog.episodes.find((e) => e.id === want)
  if (!ep) return { prev: null, next: null }
  const run = catalog.episodes.filter((e) => e.seriesId === ep.seriesId)
  const at = run.findIndex((e) => e.id === want)
  return { prev: run[at - 1] || null, next: run[at + 1] || null }
}

// --- watch state -------------------------------------------------------------
//
// Where you got to, what you have finished and what you saved - kept on the phone,
// because the demo library has no host to keep it for you.
//
// It is NOT a private copy of the real watch store and must never become one: a demo
// library is retired the moment a real one is paired, and this goes with it. It exists
// so the Continue shelf, the watched tick and the watchlist are real in the demo rather
// than three buttons that do nothing - which is most of what a reviewer presses.

function emptyDemoState () {
  return { resume: {}, watched: [], favs: [] }
}

function clean1 (state) {
  const s = state && typeof state === 'object' ? state : {}
  return {
    resume: s.resume && typeof s.resume === 'object' ? s.resume : {},
    watched: Array.isArray(s.watched) ? s.watched : [],
    favs: Array.isArray(s.favs) ? s.favs : []
  }
}

// Returns the NEW state. `runtime` is in seconds and `positionMs` in milliseconds, the
// same mismatch the rest of the app carries and the reason the decision is made by
// watch.decide rather than here.
function setDemoResume (state, { id, positionMs, runtime, ended = false, now = Date.now() }) {
  const s = clean1(state)
  const key = String(id || '')
  if (!key) return s
  const d = watch.decide({ positionMs, runtimeSeconds: runtime, ended })
  const resume = { ...s.resume }
  const watched = new Set(s.watched)
  // Zero means "forget where they were", which is what the host's store does with it -
  // a restart abandoned in the first minute must not leave the old position standing.
  if (d.positionMs > 0) resume[key] = { positionMs: d.positionMs, playedAt: now }
  else delete resume[key]
  if (d.finished) watched.add(key)
  return { ...s, resume, watched: [...watched] }
}

function demoResume (state, id) {
  const r = clean1(state).resume[String(id || '')]
  return r ? { resume: { positionMs: r.positionMs, playedAt: r.playedAt || null } } : { resume: null }
}

// The Continue shelf: the leaves with a position, newest first, carrying the same
// `resume` field a host's answer carries so the card renders unchanged.
function demoResumeShelf (catalog, state, limit = 20) {
  const s = clean1(state)
  const byId = new Map(demoLeaves(catalog).map((x) => [x.id, x]))
  return {
    items: Object.entries(s.resume)
      .filter(([id]) => byId.has(id))
      .sort((a, b) => (b[1].playedAt || 0) - (a[1].playedAt || 0))
      .slice(0, Math.max(1, Number(limit) || 20))
      .map(([id, r]) => ({ ...byId.get(id), resume: { positionMs: r.positionMs, playedAt: r.playedAt || null } }))
  }
}

function setDemoWatched (state, id, on) {
  const s = clean1(state)
  const key = String(id || '')
  const watched = new Set(s.watched)
  const resume = { ...s.resume }
  if (on) {
    watched.add(key)
    // Marking something watched by hand takes it off the Continue shelf, or the same
    // film sits in two places disagreeing about itself.
    delete resume[key]
  } else watched.delete(key)
  return { ...s, watched: [...watched], resume }
}

function setDemoFav (state, id, on) {
  const s = clean1(state)
  const key = String(id || '')
  const favs = new Set(s.favs)
  if (on) favs.add(key)
  else favs.delete(key)
  return { ...s, favs: [...favs] }
}

// The watchlist, resolved to items the way a host resolves it: a saved id whose item is
// not in the library any more is dropped rather than sent as a card that cannot open.
function demoFavShelf (catalog, state) {
  const s = clean1(state)
  const all = new Map([...catalog.movies, ...catalog.series, ...catalog.episodes].map((x) => [x.id, x]))
  return { items: s.favs.map((id) => all.get(id)).filter(Boolean) }
}

// --- serving the bytes -------------------------------------------------------

// The shim's own route for a demo film, which exists because a demo film is the one
// playable thing in this app with no host and no cache entry behind it.
const DEMO_PATH = /^\/demo\/([a-z0-9]+)(?:\?|$)/i

function demoRoute (url = '') {
  const m = DEMO_PATH.exec(String(url))
  return m ? m[1] : null
}

// Parse a Range header against a known size. Returns { start, end, partial }, or null
// for "no range asked", or { unsatisfiable: true } for one that cannot be answered.
//
// ONLY `bytes=` AND ONLY ONE RANGE, which is what every player this app faces actually
// sends. A multipart response is a genuinely different reply and no player needs it.
function parseRange (header, size) {
  const raw = String(header || '').trim()
  if (!raw) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(raw)
  if (!m || !size) return { unsatisfiable: true }
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  if (!hasStart && !hasEnd) return { unsatisfiable: true }
  let start
  let end
  if (!hasStart) {
    // A SUFFIX RANGE (`bytes=-65536`): the LAST n bytes. iOS asks for one to read the
    // moov atom of an MP4 whose index is at the end, so getting this wrong is not an
    // edge case - it is "the film will not open".
    const n = Number(m[2])
    if (!n) return { unsatisfiable: true }
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = hasEnd ? Number(m[2]) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { unsatisfiable: true }
  }
  return { start, end: Math.min(end, size - 1), partial: true }
}

// What to answer a request for a demo film with, as pure data: the status, the headers
// and which bytes to read. The route in src/bare.js writes them and pipes the file, so
// everything decidable is decided here where a test can see it.
function demoStreamHead ({ size, mime = 'video/mp4', range = null }) {
  const r = parseRange(range, size)
  if (r?.unsatisfiable) {
    return { status: 416, headers: { 'content-range': `bytes */${size}` }, start: 0, end: 0 }
  }
  const start = r ? r.start : 0
  const end = r ? r.end : size - 1
  return {
    status: r ? 206 : 200,
    headers: {
      'content-type': mime,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      // Never cached by the WebView: the bundle path can change under it when the app
      // updates, and a stale 164 MB response is not worth the round trip it saves.
      'cache-control': 'no-store',
      ...(r ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
    },
    start,
    end
  }
}

// Serve one bundled demo file - a film or a poster - with full Range support, so the
// player seeks, scrubs and resumes exactly as it does against a host.
//
// It reads in a STREAM rather than a readFileSync, and that is not tidiness: a 61 MB
// episode read faster than the player drains it would sit in the phone's memory in one
// piece. The pause/resume pair is the same backpressure the shared shim applies to a
// cached film.
//
// Returns true always: the shim's `extra` hook reads that as "handled".
function serveDemoFile ({ file, req, res, mime = 'video/mp4', log = () => {} }) {
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    // The bundle moved under us, which an app update does. Say so rather than serving
    // nothing: the paths are resolved afresh at every launch, so this heals itself.
    log('demo:file-missing', { file })
    try { res.writeHead(404); res.end() } catch {}
    return true
  }
  const head = demoStreamHead({ size, mime, range: req.headers?.range || req.headers?.Range })
  res.writeHead(head.status, head.headers)
  if (head.status === 416 || req.method === 'HEAD') { res.end(); return true }

  const rs = fs.createReadStream(file, { start: head.start, end: head.end })
  rs.on('data', (c) => { if (res.write(c) === false) { rs.pause(); res.once('drain', () => rs.resume()) } })
  rs.on('end', () => res.end())
  rs.on('error', (err) => {
    log('demo:read-failed', { file, err: err?.message })
    try { res.destroy() } catch {}
  })
  return true
}

// --- posters -----------------------------------------------------------------

// A poster is served from the bundle exactly as a film is, by the same route hook and
// ahead of the shim's own art path. It is NOT put in the art store, for the reason the
// films are not put in the cache: it is already on this phone, so storing it would be a
// second copy of a file the app is shipping anyway, and retiring the demo would then
// have something to clean up.
//
// The size the UI asks for is ignored. The shim's art path answers a size by fetching
// that size from a host, and a demo library has no host to ask - so every request gets
// the one bundled poster, which the grid scales like any other image.
const ART_PATH = /^\/art\/(?:_g\d+\/)?([^/?]+)/

function demoArtRoute (url = '') {
  const m = ART_PATH.exec(String(url))
  if (!m) return null
  try { return decodeURIComponent(m[1]) } catch { return m[1] }
}

module.exports = {
  DEMO_KIND,
  DEMO_LIBRARY_NAME,
  DEMO_HOST_SEED,
  demoLibraryId,
  statDemoFiles,
  buildDemoCatalog,
  demoLeaves,
  demoStats,
  demoList,
  demoGet,
  demoSearch,
  demoSiblings,
  emptyDemoState,
  setDemoResume,
  demoResume,
  demoResumeShelf,
  setDemoWatched,
  setDemoFav,
  demoFavShelf,

  demoRoute,
  demoArtRoute,
  parseRange,
  demoStreamHead,
  serveDemoFile
}
