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

// Artwork and subtitles are found by READING EACH DIRECTORY ONCE, during the walk.
//
// The obvious implementation - stat a handful of candidate names per film - is
// 12,197 files times six candidates on a spinning USB drive, and it is slower than
// the ffprobe pass it sits beside. One readdir per directory answers both questions
// for every file in it at once.

// Generic artwork names, in preference order. These name the FOLDER's artwork
// rather than one file's, so they only apply where the folder is about one thing:
// a film in its own directory, a season, a show. In a flat `Blurays/` folder of 200
// films a single `folder.jpg` is not 200 posters, and treating it as such would put
// the same wrong picture on every one of them.
const GENERIC_ART = ['poster', 'folder', 'cover', 'show', 'default', 'banner', 'fanart', 'thumb']
const ART_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const ART_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

// What a browser or a phone can be handed directly. SRT and WebVTT are text and
// convert to each other in one pass (host/ui/server.js does it). The rest are
// listed and refused with a reason rather than hidden, the same rule the Jellyfin
// adapter follows for embedded PGS - somebody hunting for subtitles a folder
// demonstrably contains is worse served by silence than by "not yet".
const SUBTITLE_PLAYABLE = new Set(['srt', 'vtt'])
const SUBTITLE_REASON = {
  ass: 'ASS and SSA subtitles carry their own styling and positioning, which needs converting before a player can show them. This version does not do that yet.',
  ssa: 'ASS and SSA subtitles carry their own styling and positioning, which needs converting before a player can show them. This version does not do that yet.',
  sub: 'This is an image-based subtitle (VobSub). Showing it means drawing it into the picture, which needs a full re-encode.'
}

const stemOf = (name) => name.slice(0, name.lastIndexOf('.') === -1 ? name.length : name.lastIndexOf('.'))
const extOf = (name) => name.slice(name.lastIndexOf('.')).toLowerCase()

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
    // Artwork and subtitles get their OWN id namespaces and their own path maps,
    // for the same reason `_paths` exists: an id must never be usable as a path.
    // A poster and a film are different things to hand out, so they are different
    // maps rather than one with a type tag somebody can get wrong.
    this._artPaths = new Map()
    this._subPaths = new Map()
    this._subs = new Map() // itemId -> the listed tracks, wire-shaped
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
  async scan ({ force = false, onProgress = null } = {}) {
    if (this._scanning) return this._scanning
    this._scanning = this._scan({ force, onProgress }).finally(() => { this._scanning = null })
    return this._scanning
  }

  async _scan ({ force, onProgress = null }) {
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
        // The log every 500; the caller on EVERY file, because the page shows a
        // count and a number that moves once a minute reads as a hang.
        if (n % 500 === 0) this.log('folder:probing', { done: n, total })
        if (onProgress) onProgress(n, total)
      }
    })
    if (failed.length) this.log('folder:unreadable', { count: failed.length })

    const media = new Map(results.map(r => [r.file, r]))

    // 3. Read every directory that holds a video, ONCE, plus the folders above
    // them - a show's poster lives in the show folder, not beside the episode.
    const dirs = await this._readDirs(files)

    // 4. Identify, sidecar-first.
    const movies = []
    const episodes = []
    for (const { file, root } of files) {
      if (!media.has(file)) continue // unreadable; already counted
      const built = await this._identify(file, root, media.get(file), dirs)
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

  // Every directory that matters, read once, with a count of how many videos are in
  // each. That count is what decides whether a generic `poster.jpg` belongs to one
  // film or to none of them.
  //
  // The parents are read too, because artwork for a SHOW or a SEASON is a level or
  // two above the episode that needs it.
  async _readDirs (files) {
    const want = new Set()
    const videos = new Map()

    for (const { file, root } of files) {
      const dir = path.dirname(file)
      videos.set(dir, (videos.get(dir) || 0) + 1)
      // The directory itself and everything up to (and including) the root. Bounded
      // by the tree's depth, and every one of them is a directory we already know
      // exists.
      let at = dir
      while (at.startsWith(root)) {
        want.add(at)
        if (at === root) break
        at = path.dirname(at)
      }
    }

    const out = new Map()
    for (const dir of want) {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true })
        out.set(dir, {
          files: entries.filter(e => e.isFile()).map(e => e.name),
          videos: videos.get(dir) || 0
        })
      } catch {
        out.set(dir, { files: [], videos: videos.get(dir) || 0 })
      }
    }
    this.log('folder:dirs-read', { dirs: out.size })
    return out
  }

  // The best artwork in a directory for a thing called `stem`.
  //
  // Stem-specific always wins: `Blade Runner (1982).jpg` is unambiguously about
  // that film. A generic `poster.jpg` is only used when the folder is about ONE
  // thing, which the caller decides - see GENERIC_ART above for why.
  _pickArt (dir, stem, dirs, { allowGeneric }) {
    const entry = dirs.get(dir)
    if (!entry) return null

    const arts = entry.files.filter(f => ART_EXT.has(extOf(f)))
    if (!arts.length) return null

    // stem may be null for a folder that is not named after a file - a season
    // directory has artwork but no stem of its own.
    if (stem) {
      const want = String(stem).toLowerCase()
      const specific = arts.find(f => {
        const s = stemOf(f).toLowerCase()
        return s === want || s === want + '-poster' || s === want + '-thumb' || s === want + '-fanart'
      })
      if (specific) return path.join(dir, specific)
    }

    if (!allowGeneric) return null

    for (const name of GENERIC_ART) {
      const hit = arts.find(f => stemOf(f).toLowerCase() === name)
      if (hit) return path.join(dir, hit)
    }
    return null
  }

  // Kodi and Sonarr put season posters in the SHOW folder, named `season01-poster.jpg`
  // (and `season-specials-poster.jpg` for season 0), rather than inside the season
  // folder. Both conventions are in the wild, so both are looked for.
  _pickSeasonArt (seasonDir, seriesDir, number, dirs) {
    const inSeason = seasonDir ? this._pickArt(seasonDir, null, dirs, { allowGeneric: true }) : null
    if (inSeason) return inSeason
    if (!seriesDir || number === null || number === undefined) return null

    const entry = dirs.get(seriesDir)
    if (!entry) return null
    const want = number === 0 ? 'season-specials-poster' : `season${String(number).padStart(2, '0')}-poster`
    const hit = entry.files.find(f => ART_EXT.has(extOf(f)) && stemOf(f).toLowerCase() === want)
    return hit ? path.join(seriesDir, hit) : null
  }

  // An absolute artwork path becomes an id nothing can reverse. Derived from the
  // path RELATIVE to its root, for the same reason item ids are: a drive that
  // remounts somewhere else must not orphan every poster.
  //
  // PURE. It mints, it does not remember - `_index` builds the id-to-path map, from
  // the same fields, whether they came from a fresh scan or from the cache file.
  // Remembering here would work on a scan and quietly leave a cache-loaded host with
  // ids that resolve to nothing.
  _artIdFor (file, root) {
    return file ? this.ids.itemId(this.libraryId, this.kind, `art:${path.relative(root, file)}`) : null
  }

  // External subtitle files sitting beside a video.
  //
  // THE UI MUST REACH FOR THESE FIRST, which is a measured point rather than a
  // preference: the real Movies collection has 232 embedded PGS tracks (image-based,
  // unshowable without a re-encode) against 383 external `.srt` files on disk. Lead
  // with the embedded track and most films look like they have subtitles that do not
  // work. Lead with the file on disk and most of them just work.
  _findSubtitles (dir, stem, dirs, root) {
    const entry = dirs.get(dir)
    if (!entry) return []

    const out = []
    for (const name of entry.files) {
      const parsed = names.parseSubtitleName(name, stem)
      if (!parsed) continue

      const file = path.join(dir, name)
      const id = this.ids.itemId(this.libraryId, this.kind, `sub:${path.relative(root, file)}`)

      const playable = SUBTITLE_PLAYABLE.has(parsed.format)
      out.push({
        id,
        // Internal, stripped before this ever reaches a client - see _index.
        _file: file,
        language: parsed.language,
        title: [parsed.language ? parsed.language.toUpperCase() : 'Subtitles', parsed.forced && 'forced', parsed.sdh && 'SDH']
          .filter(Boolean).join(' '),
        codec: parsed.format,
        external: true,
        forced: parsed.forced,
        sdh: parsed.sdh,
        playable,
        reason: playable ? null : (SUBTITLE_REASON[parsed.format] || `unsupported subtitle format: ${parsed.format}`)
      })
    }

    // Playable first, then forced (a forced track is usually the one somebody wants
    // on an otherwise English film), then by language for a stable order.
    return out.sort((a, b) =>
      (b.playable - a.playable) ||
      (b.forced - a.forced) ||
      String(a.language || '').localeCompare(String(b.language || ''))
    )
  }

  // One file: what is it, and what does the disk already say about it?
  async _identify (file, root, probed, dirs) {
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

    // A generic `poster.jpg` describes the FOLDER. That only means "this film"
    // where the folder holds exactly one video. See GENERIC_ART.
    const soleVideo = (dirs.get(dir)?.videos || 0) === 1
    const artFile = this._pickArt(dir, stem, dirs, { allowGeneric: soleVideo })
    const subs = this._findSubtitles(dir, stem, dirs, root)

    if (episode) {
      const show = names.parseShowFolder(seriesFolder || episode.series)
      const merged = nfo.applyNfo(episode, sidecar)
      const seriesId = this.ids.itemId(this.libraryId, this.kind, `series:${root}:${seriesFolder || show.title}`)
      const seasonId = this.ids.itemId(this.libraryId, this.kind, `season:${root}:${seriesFolder || show.title}:${merged.season}`)

      // A show's poster lives in the show folder and a season's in the season
      // folder, so both are resolved here, off the same directory listings, and
      // carried up to be attached after buildTree - the tree is built from
      // episodes and has nowhere else to learn this.
      const seriesDir = seriesFolder ? path.join(root, seriesFolder) : null
      const seasonDir = parts.length > 2 ? path.dirname(file) : null
      const seriesArtFile = seriesDir ? this._pickArt(seriesDir, seriesFolder, dirs, { allowGeneric: true }) : null
      const seasonArtFile = this._pickSeasonArt(seasonDir, seriesDir, merged.season, dirs)

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
          artId: this._artIdFor(artFile, root),
          media: items.media(probed)
        }),
        _file: file,
        _artFile: artFile,
        _subs: subs,
        _seriesArtFile: seriesArtFile,
        _seriesArtId: this._artIdFor(seriesArtFile, root),
        _seasonArtFile: seasonArtFile,
        _seasonArtId: this._artIdFor(seasonArtFile, root)
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
        artId: this._artIdFor(artFile, root),
        media: items.media(probed)
      }),
      _file: file,
      _artFile: artFile,
      _subs: subs
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

  // EVERY UNDERSCORE FIELD IS INTERNAL and must never leave the adapter. `_file`
  // and its artwork and subtitle equivalents are absolute paths on the host, and
  // putting one on the wire would tell every paired phone the shape of somebody's
  // disk. The tests caught exactly this leak once already, in `library.stats`.
  //
  // Written as an explicit destructure rather than a filter over keys, so adding a
  // new internal field is a compile-time visit to this line instead of a silent
  // disclosure.
  static _strip (item) {
    const { _file, _artFile, _subs, _seriesArtFile, _seriesArtId, _seasonArtFile, _seasonArtId, ...rest } = item
    return rest
  }

  _index (movies, episodes) {
    const cleanMovies = movies.map(FolderAdapter._strip)
    const cleanEpisodes = episodes.map(FolderAdapter._strip)

    this._movies = items.sortItems(cleanMovies, 'title')
    this._tree = items.buildTree(cleanEpisodes)

    this._byId = new Map()
    this._paths = new Map()
    this._artPaths = new Map()
    this._subPaths = new Map()
    this._subs = new Map()

    const pairs = [
      ...movies.map((m, i) => [m, cleanMovies[i]]),
      ...episodes.map((e, i) => [e, cleanEpisodes[i]])
    ]

    for (const [raw, clean] of pairs) {
      this._byId.set(clean.id, clean)
      if (raw._file) this._paths.set(clean.id, raw._file)
      if (raw._artFile && clean.artId) this._artPaths.set(clean.artId, raw._artFile)

      if (raw._subs?.length) {
        // Strip `_file` off each track on the way into the public list, and keep the
        // pairing in `_subPaths` where nothing serialises it.
        this._subs.set(clean.id, raw._subs.map(({ _file: f, ...track }) => {
          if (f) this._subPaths.set(track.id, f)
          return track
        }))
      }
    }

    // buildTree mints series and season rows from the episodes, so it has no way to
    // know about a poster sitting in the show folder. Attach it now, from the first
    // episode that found one - they all resolve to the same file, and taking the
    // first non-null means one episode in a season folder with no art does not blank
    // the whole season.
    for (const e of episodes) {
      if (e._seriesArtId) {
        const s = this._tree.series.find(x => x.id === e.seriesId)
        if (s && !s.artId) { s.artId = e._seriesArtId; this._artPaths.set(e._seriesArtId, e._seriesArtFile) }
      }
      if (e._seasonArtId) {
        const s = this._tree.seasons.find(x => x.id === e.seasonId)
        if (s && !s.artId) { s.artId = e._seasonArtId; this._artPaths.set(e._seasonArtId, e._seasonArtFile) }
      }
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
      // Version 2 added artwork and subtitle discovery. A version 1 cache has none
      // of it, so a host loading one would come up with a library of grey
      // placeholders and no subtitles and no way to know why - rebuild instead.
      if (raw.version !== 2) return false
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
        version: 2,
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

  // --- artwork and subtitles --------------------------------------------------

  // `size` is accepted and IGNORED, deliberately. Resizing means an image library in
  // an image that currently has none, and a poster is tens of kilobytes over a LAN.
  // Accepting the parameter keeps the adapter contract honest; pretending to honour
  // it would not.
  async art ({ artId } = {}) {
    const file = this._resolveIn(this._artPaths, artId, 'art')
    if (!file) return null
    try {
      await fsp.access(file, fs.constants.R_OK)
    } catch {
      return null
    }

    const stream = fs.createReadStream(file)
    // A hint, hung on the stream rather than added to the adapter contract, because
    // only this adapter knows a poster's extension - Jellyfin re-encodes and always
    // hands back JPEG. The HTTP route reads it and falls back to image/jpeg. Not
    // strictly required (browsers sniff images), but a PNG served as JPEG is the
    // kind of small lie that eventually meets something stricter than a browser.
    stream.contentType = ART_MIME[extOf(file)] || 'image/jpeg'
    return stream
  }

  // WHAT FFMPEG SHOULD OPEN for this item, for remux only.
  //
  // This is the one place a path leaves the adapter, and it is deliberate rather than
  // a hole: repackaging a film means handing ffmpeg something seekable, and a pipe is
  // not seekable - `-ss` on a pipe would decode from the start of a two-hour film to
  // reach the seek point. So the remux engine gets a path, from the SAME chokepoint
  // `media.stream` uses, and nothing else does.
  //
  // It never travels. host/server.js calls it and hands the result to ffmpeg's argv;
  // no method table exposes it, and no response carries it.
  async ffmpegInput ({ itemId } = {}) {
    const file = this._resolve(itemId)
    return file ? { input: file } : null
  }

  async subtitles ({ itemId } = {}) {
    return this._subs.get(String(itemId)) || []
  }

  async subtitle ({ itemId, subtitleId } = {}) {
    // The track must belong to the item that asked for it. Without this check any
    // subtitle id serves against any item id, which is not a disclosure on its own -
    // they are all in the same library - but it is the kind of loose coupling that
    // stops being harmless the moment there are per-item permissions.
    const owned = (this._subs.get(String(itemId)) || []).some(s => s.id === String(subtitleId))
    if (!owned) return null

    const file = this._resolveIn(this._subPaths, subtitleId, 'subtitle')
    if (!file) return null
    try {
      await fsp.access(file, fs.constants.R_OK)
    } catch {
      return null
    }
    return fs.createReadStream(file)
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
    return this._resolveIn(this._paths, itemId, 'item')
  }

  // ONE CHOKEPOINT FOR ALL THREE. Films, posters and subtitle files are three kinds
  // of bytes off the same disk, and three copies of this guard would be three places
  // for it to be forgotten - it only takes one to turn a stream method into
  // arbitrary file read on the host.
  //
  // The map IS the mechanism: no entry, no file, no exceptions. The root re-check
  // below is belt and braces, because these paths came from our own walk and are
  // already under a root - but a future cache-loading bug must not be able to widen
  // this into a traversal, and re-checking costs nothing.
  _resolveIn (map, id, what) {
    const file = map.get(String(id))
    if (!file) return null

    const resolved = path.resolve(file)
    const inRoot = this.roots.some(root => resolved === root || resolved.startsWith(root + path.sep))
    if (!inRoot) {
      this.log('folder:path-outside-root', { what, id: String(id).slice(0, 12) })
      return null
    }
    return resolved
  }
}

module.exports = { FolderAdapter, SCAN_TTL_MS }
