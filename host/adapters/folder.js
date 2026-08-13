// The folder source. A directory of films and shows, served directly.
//
// THIS IS THE MOAT. If PearCinema only ever reads Jellyfin it is a Jellyfin
// accessory, and Jellyfin is free to improve its own remote access whenever it
// likes. PearTune works standalone rather than only in front of Navidrome, and
// this does too. Jellyfin came first inside v1 because it reaches first playback
// faster, which is a sequencing convenience and not the product.
//
// It answers the same interface the Jellyfin adapter does, in the same normalised
// shapes, so nothing above learns which is behind the media API. That property is
// what keeps this path a first-class citizen instead of a fallback nobody tests.
//
// The hard parts already exist and are tested on Tim's real 12,197-file library:
//
//   ../probe.js  what a file IS       (ffprobe, container and codecs)
//   ../names.js  what a file is OF    (title, year, series, season, episode)
//   ../nfo.js    what the disk says   (Kodi sidecars, which usually know better)
//   ../items.js  the tree             (buildTree, sorts, paging)
//
// So this file is the wiring plus the two things nothing else covers: a cache, so
// a 3 TB drive is not re-probed on every restart, and surviving that drive being
// unplugged.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const items = require('../items')
const names = require('../names')
const nfo = require('../nfo')
const { walkVideos, probeAll } = require('../probe')

// How long a scan's results stand before a rescan is worth doing. A film library
// changes slowly, and a rescan of 12,000 files is twenty minutes of a spinning
// disk, so this is deliberately long. An operator who just added something uses
// the explicit rescan.
const SCAN_TTL_MS = 12 * 60 * 60 * 1000

// Probing is the expensive half of a scan and the only part that touches every
// byte-range of the disk. Four at a time is right for one external drive; see the
// note in probe.js about why this is a disk limit rather than a CPU one.
const PROBE_CONCURRENCY = 4

class FolderAdapter {
  // `roots` is a list of directories. MULTI-ROOT from the start, because a real
  // collection is `Movies` on one disk and `TV Shows` on another more often than
  // it is one tidy tree - and because a root that is missing must not take the
  // others down with it.
  constructor ({ roots = [], dataDir = null, libraryId = null, ids, log = () => {}, ffprobe = 'ffprobe' } = {}) {
    if (!ids) throw new Error('FolderAdapter needs the protocol id factory')

    this.kind = 'folder'
    this.roots = (Array.isArray(roots) ? roots : [roots]).filter(Boolean).map(r => path.resolve(String(r)))
    this.dataDir = dataDir
    this.libraryId = libraryId
    this.ids = ids
    this.log = log
    this.ffprobe = ffprobe

    this.scannedAt = null
    this.scanError = null

    // The library, in memory. A film library is thousands of rows, not millions,
    // so holding it is cheaper and far simpler than a database - and a restart
    // rebuilds it from the cache file rather than from the disk.
    this._byId = new Map()
    this._movies = []
    this._tree = null
    // our id -> absolute path. THE ONLY PLACE a path is ever resolved from an id,
    // which is what makes the traversal guard below a single chokepoint.
    this._paths = new Map()
    this._scanning = null
  }

  _cacheFile () {
    return this.dataDir ? path.join(this.dataDir, 'folder-scan.json') : null
  }

  // Which roots can we actually see right now? A drive gets unplugged, a mount
  // goes stale, and the answer must be "the rest of the library still works"
  // rather than a scan that throws.
  visibleRoots () {
    return this.roots.filter(root => {
      try {
        return fs.statSync(root).isDirectory()
      } catch {
        return false
      }
    })
  }

  async ping () {
    const visible = this.visibleRoots()
    if (!this.roots.length) return { ok: false, detail: 'no folders configured' }
    if (!visible.length) return { ok: false, detail: `no configured folder is readable: ${this.roots.join(', ')}` }
    return {
      ok: true,
      detail: visible.length === this.roots.length
        ? `${visible.length} folder(s)`
        : `${visible.length} of ${this.roots.length} folders readable`
    }
  }

  // --- scanning -------------------------------------------------------------

  // One scan at a time. A cold host answering a screen of requests would otherwise
  // start a dozen, and each one walks the whole disk.
  async scan ({ force = false } = {}) {
    if (this._scanning) return this._scanning
    this._scanning = this._scan({ force }).finally(() => { this._scanning = null })
    return this._scanning
  }

  async _scan ({ force }) {
    if (!this.roots.length) throw new Error('no folders configured')

    if (!force && await this._loadCache()) {
      this.log('folder:cache-loaded', { items: this._byId.size, scannedAt: this.scannedAt })
      return this._movies.length + this._episodeCount()
    }

    const visible = this.visibleRoots()
    if (!visible.length) {
      // A THROW, and deliberately: the dashboard's Test button and the startup log
      // both need to say "your drive is not there" rather than "your library is
      // empty". Those are different sentences and the second one is a lie.
      throw new Error(`no configured folder is readable: ${this.roots.join(', ')}`)
    }
    if (visible.length < this.roots.length) {
      const missing = this.roots.filter(r => !visible.includes(r))
      this.scanError = `not readable: ${missing.join(', ')}`
      this.log('folder:root-missing', { missing })
    } else {
      this.scanError = null
    }

    // 1. Walk.
    const files = []
    for (const root of visible) {
      for await (const file of walkVideos(root)) files.push({ file, root })
    }
    this.log('folder:walked', { files: files.length, roots: visible.length })

    // 2. Probe. The expensive half.
    const { results, failed } = await probeAll(files.map(f => f.file), {
      concurrency: PROBE_CONCURRENCY,
      ffprobe: this.ffprobe,
      onProgress: (n, total) => {
        if (n % 500 === 0) this.log('folder:probing', { done: n, total })
      }
    })
    if (failed.length) this.log('folder:unreadable', { count: failed.length })

    const rootOf = new Map(files.map(f => [f.file, f.root]))
    const media = new Map(results.map(r => [r.file, r]))

    // 3. Identify, sidecar-first.
    const movies = []
    const episodes = []
    for (const { file, root } of files) {
      if (!media.has(file)) continue // unreadable; already counted
      const built = await this._identify(file, root, media.get(file))
      if (!built) continue
      if (built.type === 'episode') episodes.push(built)
      else movies.push(built)
    }

    this._index(movies, episodes)
    this.scannedAt = Date.now()
    await this._saveCache(movies, episodes)

    this.log('folder:scanned', { movies: movies.length, episodes: episodes.length, unreadable: failed.length })
    return movies.length + episodes.length
  }

  // One file: what is it, and what does the disk already say about it?
  async _identify (file, root, probed) {
    const dir = path.dirname(file)
    const filename = path.basename(file)
    const stem = filename.replace(/\.[^.]+$/, '')
    const rel = path.relative(root, file)
    const parts = rel.split(path.sep)

    // A file directly in a root is a film. Anything nested MIGHT be an episode, and
    // the top folder under the root is the show. That is the convention every
    // scanner uses and the one Tim's library follows.
    //
    // KNOWN GAP, measured against the real library (2026-08-12): a NESTED file with
    // no parseable episode code falls through to being a film. On Tim's drive that
    // is 34 of 2,746 television files - the MST3K box set numbered `K05` - and they
    // land in the Films list rather than under their show. Wrong, but wrong in a
    // visible and recoverable way rather than a silent one, and the fix is a root
    // that declares whether it holds films or shows. See TODO.md.
    const seriesFolder = parts.length > 1 ? parts[0] : null
    const seasonFolder = parts.length > 2 ? parts[parts.length - 2] : null

    const episode = names.parseEpisode(filename, { seriesFolder, seasonFolder })
    const sidecar = await this._readSidecar(dir, stem)

    // The id is derived from the path RELATIVE to its root, never the absolute one.
    // A drive that mounts at a different letter or mount point must not orphan
    // every resume position on every phone.
    const id = this.ids.itemId(this.libraryId, this.kind, rel)

    if (episode) {
      const show = names.parseShowFolder(seriesFolder || episode.series)
      const merged = nfo.applyNfo(episode, sidecar)
      const seriesId = this.ids.itemId(this.libraryId, this.kind, `series:${root}:${seriesFolder || show.title}`)
      const seasonId = this.ids.itemId(this.libraryId, this.kind, `season:${root}:${seriesFolder || show.title}:${merged.season}`)

      return {
        ...items.episode({
          id,
          seriesId,
          seasonId,
          seriesTitle: show.title,
          seasonNumber: merged.season,
          episodeNumber: merged.episode,
          title: merged.title || stem,
          year: merged.year ?? show.year,
          runtime: merged.runtime ?? probed.duration,
          overview: merged.overview,
          genres: merged.genres,
          artId: null,
          media: items.media(probed)
        }),
        _file: file
      }
    }

    const movie = names.parseMovie(filename)
    const merged = nfo.applyNfo(movie, sidecar)
    return {
      ...items.movie({
        id,
        title: merged.title,
        year: merged.year,
        runtime: merged.runtime ?? probed.duration,
        overview: merged.overview,
        genres: merged.genres,
        artId: null,
        media: items.media(probed)
      }),
      _file: file
    }
  }

  // The sidecar beside a file: `Film.nfo`, or the folder's own `movie.nfo` /
  // `tvshow.nfo` when the film has a directory to itself.
  async _readSidecar (dir, stem) {
    for (const candidate of [`${stem}.nfo`, 'movie.nfo', 'episode.nfo']) {
      try {
        const parsed = nfo.parseNfo(await fsp.readFile(path.join(dir, candidate), 'utf8'))
        if (parsed) return parsed
      } catch {
        // absent, unreadable, or not a sidecar at all - try the next
      }
    }
    return null
  }

  // `_file` is internal and must never leave the adapter - it is an absolute path
  // on the host, and putting one on the wire would tell every paired phone the
  // shape of somebody's disk.
  static _strip (item) {
    const { _file, ...rest } = item
    return rest
  }

  _index (movies, episodes) {
    const cleanMovies = movies.map(FolderAdapter._strip)
    const cleanEpisodes = episodes.map(FolderAdapter._strip)

    this._movies = items.sortItems(cleanMovies, 'title')
    this._tree = items.buildTree(cleanEpisodes)

    this._byId = new Map()
    this._paths = new Map()
    for (const [raw, clean] of [...movies.map((m, i) => [m, cleanMovies[i]]), ...episodes.map((e, i) => [e, cleanEpisodes[i]])]) {
      this._byId.set(clean.id, clean)
      if (raw._file) this._paths.set(clean.id, raw._file)
    }
    for (const s of this._tree.series) this._byId.set(s.id, s)
    for (const s of this._tree.seasons) this._byId.set(s.id, s)
  }

  _episodeCount () {
    if (!this._tree) return 0
    return this._tree.seasons.reduce((n, s) => n + s.episodeCount, 0)
  }

  // --- cache ----------------------------------------------------------------
  //
  // A rescan of 12,000 files is twenty minutes of a spinning USB disk. Doing that
  // on every restart would make the host unusable on exactly the libraries it is
  // built for.

  async _loadCache () {
    const file = this._cacheFile()
    if (!file) return false
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (raw.version !== 1) return false
      // A cache built from different folders describes a different library.
      if (JSON.stringify(raw.roots) !== JSON.stringify(this.roots)) return false
      if (!raw.scannedAt || Date.now() - raw.scannedAt > SCAN_TTL_MS) return false

      this._index(raw.movies || [], raw.episodes || [])
      this.scannedAt = raw.scannedAt
      return true
    } catch {
      return false
    }
  }

  async _saveCache (movies, episodes) {
    const file = this._cacheFile()
    if (!file) return
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, JSON.stringify({
        version: 1,
        roots: this.roots,
        scannedAt: this.scannedAt,
        movies,
        episodes
      }))
    } catch (e) {
      // A cache that cannot be written is slow, not broken.
      this.log('folder:cache-write-failed', { err: e?.message })
    }
  }

  // --- the interface --------------------------------------------------------

  async stats () {
    return {
      movies: this._movies.length,
      series: this._tree?.series.length || 0,
      seasons: this._tree?.seasons.length || 0,
      episodes: this._episodeCount(),
      source: this.kind,
      sourceName: 'Folder',
      // THE PATHS ARE NOT REPORTED, only how many there are. `library.stats` is
      // answered to any paired PHONE, and the host's directory layout is not a
      // phone's business - it is a small, free disclosure of the shape of somebody's
      // disk, and there is nothing a client does with it.
      //
      // (The Jellyfin adapter does report its base URL, and that is a deliberate
      // difference rather than an inconsistency: a server address is a network
      // location the operator typed and may want to see confirmed, not a filesystem
      // layout.)
      //
      // The operator sees the actual folders in the dashboard, which reads the
      // config directly rather than going through here.
      folders: this.roots.length,
      scannedAt: this.scannedAt,
      sourceError: this.scanError
    }
  }

  async list ({ type = 'movies', seriesId = null, seasonId = null, limit, cursor, sort, order } = {}) {
    let pool = []

    if (type === 'movies') pool = this._movies
    else if (type === 'series') pool = this._tree?.series || []
    else if (type === 'seasons') pool = seriesId ? (this._tree?.seasonsOf(seriesId) || []) : []
    else if (type === 'episodes') {
      if (seasonId) pool = this._tree?.episodesOf(seasonId) || []
      else if (seriesId) {
        pool = (this._tree?.seasonsOf(seriesId) || []).flatMap(s => this._tree.episodesOf(s.id))
      }
    }

    const sorted = sort ? items.sortItems(pool, sort, order) : pool
    return items.page(sorted, { limit, cursor })
  }

  async get ({ id } = {}) {
    return this._byId.get(String(id)) || null
  }

  async search ({ q = '', limit = 50 } = {}) {
    const needle = String(q).toLowerCase()
    if (!needle) return { items: [] }

    const hit = (s) => String(s || '').toLowerCase().includes(needle)
    const out = []
    for (const item of this._byId.values()) {
      if (hit(item.title) || hit(item.seriesTitle)) out.push(item)
      if (out.length >= Math.max(1, Number(limit) || 50) * 4) break
    }
    return { items: items.sortItems(out, 'title').slice(0, Math.max(1, Number(limit) || 50)) }
  }

  async art () {
    // Artwork discovery on disk is its own piece of work and is not in yet. Null is
    // the honest answer and the app draws its own placeholder - the same answer the
    // Jellyfin adapter gives for an item with no poster.
    return null
  }

  // --- streaming ------------------------------------------------------------

  // Byte-range reads, which is why direct-play seeking inside a two-hour film
  // works with no protocol change: `media.stream` already carries offset and
  // length, and this hands back exactly that slice of the file.
  async stream ({ itemId, offset = 0, length } = {}) {
    const file = this._resolve(itemId)
    if (!file) return null

    const start = Math.max(0, Number(offset) || 0)
    const end = length ? start + Number(length) - 1 : undefined

    try {
      // Existence is checked before the stream is built, so a missing file is a
      // clean ENOTFOUND rather than an error event on a stream the caller is
      // already piping.
      await fsp.access(file, fs.constants.R_OK)
    } catch {
      this.log('folder:file-missing', { itemId })
      return null
    }

    return fs.createReadStream(file, end === undefined ? { start } : { start, end })
  }

  // THE ONLY PLACE AN ID BECOMES A PATH, and the guard lives here for that reason.
  //
  // Ids are minted by us from a scan, so a caller cannot forge one into a path -
  // but a lookup that ever fell back to treating the id AS a path would turn
  // `media.stream` into arbitrary file read on the host. The map is the whole
  // mechanism: no entry, no file, no exceptions.
  _resolve (itemId) {
    const file = this._paths.get(String(itemId))
    if (!file) return null

    // Belt and braces: the path came from our own walk, so it is already under a
    // root. Re-checking costs nothing and means a future cache-loading bug cannot
    // widen this into a traversal.
    const resolved = path.resolve(file)
    const inRoot = this.roots.some(root => resolved === root || resolved.startsWith(root + path.sep))
    if (!inRoot) {
      this.log('folder:path-outside-root', { itemId })
      return null
    }
    return resolved
  }
}

module.exports = { FolderAdapter, SCAN_TTL_MS }
