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
const subtitles = require('../subtitles')
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

// THE CACHE FORMAT'S VERSION, in one place because two of them now read it: the item
// index and the probe store beside it.
const CACHE_VERSION = 7

// How many files to stat at once when deciding which of them need probing. A stat is
// nothing next to an ffprobe, but three thousand at once is three thousand open file
// descriptors, so it goes in handfuls.
const STAT_CONCURRENCY = 64

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

// AND THE TRACKS INSIDE THE FILE, which this adapter ignored entirely until
// 2026-08-13 - it read the disk beside a film and nothing within it. On the real
// library that hid **2,715 embedded text tracks** across the television, and left
// every film whose only subtitles are PGS showing an empty Subtitles panel with no
// explanation, which reads as "this app cannot do subtitles" rather than as the
// truthful "those ones are pictures".
//
// External files still come FIRST, and that is measured rather than stylistic: the
// Movies collection is 232 PGS tracks against 383 usable `.srt` files on disk. Lead
// with what is inside the file and most films look like their subtitles are broken.

const stemOf = (name) => name.slice(0, name.lastIndexOf('.') === -1 ? name.length : name.lastIndexOf('.'))
const extOf = (name) => name.slice(name.lastIndexOf('.')).toLowerCase()

// WHAT A ROOT HOLDS, and it is the fix for a measured misfiling rather than a
// preference. Against Tim's real drive (2026-08-12) a NESTED file with no parseable
// episode code fell through to being a film, so 34 of 2,746 television files - the
// MST3K box set, numbered `K05`, which no filename rule can settle - landed in the
// Films list. No amount of parsing settles that, because the filename genuinely does
// not say. The root does.
//
//   'movies'  everything under here is a film. No episode parsing at all, which also
//             stops `Dune - Part 2.mkv` in its own folder becoming episode 2 of
//             itself via the loose `Part N` fallback - the same bug pointing the
//             other way. (`Part Two` spelled out is safe only by luck.)
//   'shows'   everything under here is television. A file with no code is an episode
//             of UNKNOWN NUMBERING filed under its show, never a film.
//   'auto'    nobody said. Resolved from the root's own folder name (`TV Shows` is
//             not a guess, it is what the person who made it wrote on the front),
//             and where the name says nothing, the filename rules decide per file -
//             exactly the behaviour that existed before roots had a type.
const ROOT_TYPES = new Set(['movies', 'shows', 'auto'])

// A root config entry, from either shape it may be saved in.
//
// A BARE STRING IS STILL VALID AND ALWAYS WILL BE. Every host in the field saved its
// roots as strings, `PEARCINEMA_FOLDERS` is a colon-separated path list, and a config
// this cannot read is a library that goes dark on upgrade.
function normaliseRoot (r) {
  const raw = typeof r === 'string' ? { path: r } : (r || {})
  if (!raw.path) return null

  const at = path.resolve(String(raw.path))
  const type = ROOT_TYPES.has(raw.type) ? raw.type : 'auto'
  return {
    path: at,
    // What the operator (or the detector) DECLARED.
    type,
    // What we will actually act on. Kept apart from `type` so the dashboard can say
    // "work it out - this looks like TV shows" rather than silently rewriting the
    // operator's choice into something they never picked.
    holds: type === 'auto' ? names.rootTypeFromName(at) : type
  }
}

class FolderAdapter {
  // `roots` is a list of directories, each a path string or `{ path, type }`.
  // MULTI-ROOT from the start, because a real collection is `Movies` on one disk and
  // `TV Shows` on another more often than it is one tidy tree - and because a root
  // that is missing must not take the others down with it.
  constructor ({ roots = [], dataDir = null, libraryId = null, ids, log = () => {}, ffprobe = 'ffprobe', ffmpeg = 'ffmpeg' } = {}) {
    if (!ids) throw new Error('FolderAdapter needs the protocol id factory')

    this.kind = 'folder'
    this.roots = (Array.isArray(roots) ? roots : [roots]).map(normaliseRoot).filter(Boolean)
    this.dataDir = dataDir
    this.libraryId = libraryId
    this.ids = ids
    this.log = log
    this.ffprobe = ffprobe
    // Only ever used to lift ONE TEXT SUBTITLE TRACK out of a file. The video path
    // has its own ffmpeg, in the remuxer, with a concurrency cap that matters there
    // and would be meaningless here.
    this.ffmpeg = ffmpeg

    this.scannedAt = null
    this.scanError = null
    // How many files claimed an id another file already had. See _index.
    this.idCollisions = 0

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
    // subtitleId -> { file, index } for a track that lives INSIDE a video, which is
    // resolved by asking ffmpeg for it rather than by opening a file of its own.
    this._subTracks = new Map()
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
        return fs.statSync(root.path).isDirectory()
      } catch {
        return false
      }
    })
  }

  // The paths alone, for the sentences an operator reads.
  rootPaths () {
    return this.roots.map(r => r.path)
  }

  async ping () {
    const visible = this.visibleRoots()
    if (!this.roots.length) return { ok: false, detail: 'no folders configured' }
    if (!visible.length) return { ok: false, detail: `no configured folder is readable: ${this.rootPaths().join(', ')}` }
    return {
      ok: true,
      detail: visible.length === this.roots.length
        ? `${visible.length} folder(s)`
        : `${visible.length} of ${this.roots.length} folders readable`
    }
  }

  // IS THE LIBRARY STILL THERE? Asked on a timer rather than only when something
  // scans, because the failure this exists for is silent: a container's bind mount
  // whose drive has been remounted elsewhere leaves a directory that is present,
  // readable and empty, so the host looks perfectly healthy while every film 404s.
  //
  // READABLE IS NOT ENOUGH, which is what `ping()` above answers and why this is a
  // second method. The stronger question is whether the files this library is made of
  // are still where it left them - so it stats a handful of them, and only calls the
  // source gone when NONE of them are. One missing film is a deleted film; none of
  // them is a missing disk.
  async health () {
    if (!this.roots.length) return { ok: false, detail: 'no folders configured' }

    const visible = this.visibleRoots()
    if (!visible.length) {
      return { ok: false, detail: `no configured folder is readable: ${this.rootPaths().join(', ')}` }
    }

    // Nothing scanned yet is nothing to check against, and not a fault.
    const sample = []
    for (const file of this._paths.values()) {
      sample.push(file)
      if (sample.length === 5) break
    }
    if (!sample.length) return { ok: true }

    const present = await Promise.all(sample.map(f => fsp.stat(f).then(() => true, () => false)))
    if (present.some(Boolean)) return { ok: true }

    return {
      ok: false,
      detail: `None of this library's files are in ${this.rootPaths().join(', ')}. Is the drive still mounted?`
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
      throw new Error(`no configured folder is readable: ${this.rootPaths().join(', ')}`)
    }
    if (visible.length < this.roots.length) {
      const missing = this.roots.filter(r => !visible.includes(r)).map(r => r.path)
      this.scanError = `not readable: ${missing.join(', ')}`
      this.log('folder:root-missing', { missing })
    } else {
      this.scanError = null
    }

    // 1. Walk. `root` travels with every file from here on, because what a root
    // HOLDS decides how its files are read - see ROOT_TYPES.
    const files = []
    for (const root of visible) {
      for await (const file of walkVideos(root.path)) files.push({ file, root })
    }
    this.log('folder:walked', { files: files.length, roots: visible.length })

    // A LIBRARY DOES NOT BECOME EMPTY BY ITSELF, and this is the guard that keeps a
    // missing drive from being written down as one.
    //
    // The roots passed the readable test above, so this is not "your folders are
    // gone" - it is a directory that is present and holds no films. In a container
    // that is exactly what a bind mount looks like after the drive underneath it is
    // remounted somewhere else, which happened to Tim's Umbrel on 2026-08-19 when the
    // same disk came back as `Elements` instead of `Elements (3)`.
    //
    // Without this, an auto-rescan walks nothing, saves nothing, and the cache that
    // held 2,986 films is replaced by an empty one. The drive coming back does not
    // undo that - the next scan has to re-probe every file, and until it does, every
    // paired phone sees a library that is simply gone. Refusing costs nothing: the
    // index already in memory keeps serving, and `rescan()` turns the throw into the
    // sourceError the dashboard shows.
    if (!files.length && this._byId.size > 0) {
      throw new Error(
        `This library has ${this._byId.size} items, but ${this.rootPaths().join(', ')} now holds no videos. ` +
        'Refusing to replace it with an empty one. Check that the drive is still mounted.'
      )
    }

    // 2. Probe - but only what has actually changed.
    //
    // A RESCAN IS NOT A RE-READ OF EVERY FILE (Tim, 2026-08-19: "Plex is pretty quick
    // to detect new/updated items, takes maybe 10-15 seconds"). It used to be exactly
    // that: `force` meant do not trust the index, and it was implemented as do not
    // trust anything - so adding one episode re-probed 2,986 files, which on a USB
    // drive is minutes. Asking ffprobe what a file is again, when the file has not
    // been touched, cannot return a different answer.
    //
    // The freshness test is the one every scanner uses: same size, same mtime. Both
    // come free - `size` off the old probe, `addedAt` being the mtime it already
    // stats for the recently-added shelf - so nothing new is stored to make this work
    // beyond the probes themselves.
    //
    // A CHANGE TO WHAT A PROBE MEANS still re-reads everything, because the whole
    // store is versioned with the cache: a version bump drops the probes with it,
    // which is what makes a fix like the missing audio channel count actually apply.
    const known = await this._loadProbes()
    const toProbe = []
    const reused = []
    for (let i = 0; i < files.length; i += STAT_CONCURRENCY) {
      await Promise.all(files.slice(i, i + STAT_CONCURRENCY).map(async ({ file }) => {
        const was = known.get(file)
        if (!was) return toProbe.push(file)
        try {
          const st = await fsp.stat(file)
          if (was.size === st.size && was.addedAt === Math.round(st.mtimeMs)) return reused.push(was)
        } catch {}
        toProbe.push(file)
      }))
    }
    this.log('folder:probe-plan', { unchanged: reused.length, toProbe: toProbe.length })

    const { results, failed } = await probeAll(toProbe, {
      concurrency: PROBE_CONCURRENCY,
      ffprobe: this.ffprobe,
      onProgress: (n, total) => {
        // The log every 500; the caller on EVERY file, because the page shows a
        // count and a number that moves once a minute reads as a hang. Counted
        // against the whole library rather than against the new files, so the bar
        // does not read as 3 of 3 for a library of three thousand.
        if (n % 500 === 0) this.log('folder:probing', { done: n, total })
        if (onProgress) onProgress(reused.length + n, reused.length + total)
      }
    })
    if (failed.length) this.log('folder:unreadable', { count: failed.length })

    const media = new Map([...reused, ...results].map(r => [r.file, r]))
    // Held for the cache write below: only what this walk found, so a file that has
    // gone leaves the store with it.
    this._probes = media

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
      while (at.startsWith(root.path)) {
        want.add(at)
        if (at === root.path) break
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

  // The tracks INSIDE the file, off the same ffprobe pass that read its codecs. No
  // extra work at scan time and no second walk of the disk.
  _embeddedSubtitles (file, root, probed) {
    return (probed?.subtitles || []).map(track => {
      const codec = String(track.codec || '').toLowerCase()
      const playable = subtitles.TEXT_SUBTITLE_CODECS.has(codec)
      return {
        // Keyed by the RELATIVE path and the track's position within the file's
        // subtitle streams, for the same reason every other id here is: a drive that
        // remounts elsewhere must not orphan them.
        id: this.ids.itemId(this.libraryId, this.kind, `emb:${path.relative(root, file)}:${track.index}`),
        _embedded: track.index,
        _sourceFile: file,
        language: track.language,
        title: subtitles.titleFor(track),
        codec,
        external: false,
        forced: !!track.forced,
        sdh: !!track.sdh,
        // The authored canvas of a picture track, for burn-in's pad. Absent on
        // text tracks and on caches probed before it was recorded.
        canvasWidth: track.width ?? null,
        canvasHeight: track.height ?? null,
        playable,
        reason: playable ? null : subtitles.reasonFor(codec)
      }
    })
  }

  // One file: what is it, and what does the disk already say about it?
  async _identify (file, rootEntry, probed, dirs) {
    const root = rootEntry.path
    const holds = rootEntry.holds // 'movies' | 'shows' | null. See ROOT_TYPES.

    const dir = path.dirname(file)
    const filename = path.basename(file)
    const stem = filename.replace(/\.[^.]+$/, '')
    const rel = path.relative(root, file)
    const parts = rel.split(path.sep)

    // A file directly in a root is a film. Anything nested MIGHT be an episode, and
    // the top folder under the root is the show. That is the convention every
    // scanner uses and the one Tim's library follows.
    const seriesFolder = parts.length > 1 ? parts[0] : null
    const seasonFolder = parts.length > 2 ? parts[parts.length - 2] : null

    // WHAT THE ROOT SAYS OUTRANKS WHAT THE FILENAME SAYS, in both directions, and
    // that is the whole point of typing a root. A films root does no episode parsing
    // at all; a shows root never produces a film.
    let episode = holds === 'movies'
      ? null
      : names.parseEpisode(filename, { seriesFolder, seasonFolder, television: holds === 'shows' })

    // Nothing parseable under a SHOWS root. This is the case that had 34 of Tim's
    // 2,746 television files filed as films: an MST3K box set numbered `K05`, which
    // no filename rule can settle because the filename genuinely does not say. It is
    // an episode of unknown numbering - which the item model already carries, since
    // `episodeCode` returns null rather than inventing "S??E01".
    if (!episode && holds === 'shows') {
      const guess = names.parseMovie(filename) // the title cleaner, not a film verdict
      episode = {
        type: 'episode',
        series: seriesFolder ? seriesFolder : guess.title,
        seriesYear: null,
        season: seasonFolder !== null ? names.parseSeasonFolder(seasonFolder) : null,
        episode: null,
        episodeEnd: null,
        title: guess.title,
        folderSeason: null,
        loose: false,
        // The numbering is not merely inferred, it is ABSENT. Carried so the season
        // below can be named after its folder rather than becoming one of several
        // rows all labelled "Season".
        unnumbered: true
      }
    }

    const sidecar = await this._readSidecar(dir, stem)

    // The id is derived from the path RELATIVE to its root, never the absolute one.
    // A drive that mounts at a different letter or mount point must not orphan
    // every resume position on every phone.
    const id = this.ids.itemId(this.libraryId, this.kind, rel)

    // A generic `poster.jpg` describes the FOLDER. That only means "this film"
    // where the folder holds exactly one video. See GENERIC_ART.
    const soleVideo = (dirs.get(dir)?.videos || 0) === 1
    const artFile = this._pickArt(dir, stem, dirs, { allowGeneric: soleVideo })
    // FILES ON DISK FIRST, then what is inside the film. Order is the whole point -
    // see the note above SUBTITLE_PLAYABLE - and it is expressed by concatenation
    // rather than by a sort key, so nothing downstream can reverse it by accident.
    const subs = [
      ...this._findSubtitles(dir, stem, dirs, root),
      ...this._embeddedSubtitles(file, root, probed)
    ]

    if (episode) {
      const show = names.parseShowFolder(seriesFolder || episode.series)
      const merged = nfo.applyNfo(episode, sidecar)

      // A season with no number is keyed by its FOLDER, so `MST3K DVD 18` and
      // `MST3K DVD 19` stay two shelves instead of collapsing into one anonymous
      // heap.
      const numbered = merged.season !== null && merged.season !== undefined
      const seasonKey = numbered
        ? String(merged.season)
        : (seasonFolder ? `dir:${seasonFolder}` : 'unnumbered')

      // NOTHING ABSOLUTE IN A PREIMAGE. These two carried the full root path until
      // 2026-08-13, which quietly contradicted the rule three lines above: a film
      // survived its drive being plugged in somewhere else and a SHOW did not, so a
      // remount would have orphaned every television watch position while leaving
      // the films alone. The show folder relative to its root is the portable name,
      // which is the same thing the item id is built from.
      //
      // The consequence, and it is wanted rather than tolerated: the same show under
      // two roots is now ONE show with both sets of seasons. A collection split
      // across two drives is a real shape, and two identical entries in the show list
      // was never the better answer.
      const seriesKey = seriesFolder || show.title
      const seriesId = this.ids.itemId(this.libraryId, this.kind, `series:${seriesKey}`)
      const seasonId = this.ids.itemId(this.libraryId, this.kind, `season:${seriesKey}:${seasonKey}`)

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
          seasonTitle: numbered ? null : seasonFolder,
          title: merged.title || stem,
          year: merged.year ?? show.year,
          runtime: merged.runtime ?? probed.duration,
          overview: merged.overview,
          genres: merged.genres,
          addedAt: probed.addedAt,
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
        // FROM THE FILENAME, NEVER FROM THE SIDECAR. A .nfo describes the film and
        // a TMDB match describes the film; neither knows the file it was written
        // beside is only half of one, which is exactly why both halves used to
        // arrive identical.
        part: movie.part,
        runtime: merged.runtime ?? probed.duration,
        overview: merged.overview,
        genres: merged.genres,
        addedAt: probed.addedAt,
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
    this._subTracks = new Map()
    this._subs = new Map()

    const pairs = [
      ...movies.map((m, i) => [m, cleanMovies[i]]),
      ...episodes.map((e, i) => [e, cleanEpisodes[i]])
    ]

    // TWO FILES CANNOT SHARE AN ID, and if they ever do it must not be silent.
    //
    // A leaf id is minted from the path RELATIVE to its root, which is what makes it
    // survive a remount - and the price is that two roots holding the same relative
    // path (`/a/Movies/Blade.mkv` and `/b/Movies/Blade.mkv`, one drive being a copy
    // of another) mint the same id. The second would overwrite the first in the path
    // map and one film would quietly play as the other, with nothing anywhere saying
    // so. Rare, and precisely the kind of thing nobody would think to look for.
    let collisions = 0

    for (const [raw, clean] of pairs) {
      if (this._paths.has(clean.id)) collisions++
      this._byId.set(clean.id, clean)
      if (raw._file) this._paths.set(clean.id, raw._file)
      if (raw._artFile && clean.artId) this._artPaths.set(clean.artId, raw._artFile)

      if (raw._subs?.length) {
        // Strip the internals off each track on the way into the public list, and
        // keep the pairing where nothing serialises it. A track is one of two things
        // and they resolve differently: a FILE beside the video, or an index into the
        // video's own subtitle streams. Both are host paths in the end, so neither
        // may travel.
        this._subs.set(clean.id, raw._subs.map(({ _file: f, _sourceFile: src, _embedded: idx, ...track }) => {
          if (f) this._subPaths.set(track.id, f)
          if (src && idx !== undefined) this._subTracks.set(track.id, { file: src, index: idx })
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

    // Reported rather than repaired. Renaming somebody's files is not this program's
    // business - the scanner never touches the library - and the honest fix is for
    // the operator to drop one of two roots that hold the same collection. Kept on
    // the adapter so the dashboard can say it, which is the whole point of noticing.
    this.idCollisions = collisions
    if (collisions) this.log('folder:id-collision', { count: collisions })
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
      //
      // Version 3 added the root type. A version 2 cache was built with every root
      // read as "work it out", so it holds exactly the misfiling this version fixes.
      // Loading one would leave the operator having typed their roots and seen
      // nothing change, which is worse than the wait.
      //
      // Version 4 made series and season ids portable across a remount. A version 3
      // cache holds the ids minted the old way, and they are internally consistent -
      // so serving it looks fine right up until the drive moves and the shows a phone
      // remembers are gone. The property is the whole point; a stale set of ids that
      // does not have it is the bug, not a saving.
      //
      // Version 5 added the subtitle tracks INSIDE each file. A version 4 cache has
      // only the files found beside them, so a host loading one would show an empty
      // Subtitles panel on 2,715 television episodes that have perfectly good text
      // tracks - the exact complaint this version answers.
      // Version 6 added the AUDIO CHANNEL COUNT, and a version 5 cache is why a film
      // with 5.1 sound cast to a television in silence: ffprobe reported the count all
      // along, the media object dropped it, and every decision was made on the codec
      // alone. A cache without it cannot be reasoned about - the fix would apply to
      // nothing until each file was probed again, which is exactly the kind of silent
      // half-fix that reads as "it did not work".
      //
      // Version 7 keeps the PROBES themselves beside the index, so a rescan re-reads
      // only files whose size or mtime has changed. A version 6 cache has none, which
      // costs one full probe pass and then behaves like any other.
      if (raw.version !== CACHE_VERSION) return false
      // A cache built from different folders describes a different library - and a
      // root whose TYPE changed describes the same files read a different way, which
      // is just as stale. Both are covered by comparing the normalised roots.
      if (JSON.stringify(raw.roots) !== JSON.stringify(this.roots)) return false
      if (!raw.scannedAt || Date.now() - raw.scannedAt > SCAN_TTL_MS) return false

      this._index(raw.movies || [], raw.episodes || [])
      this.scannedAt = raw.scannedAt
      return true
    } catch {
      return false
    }
  }

  // WHAT WAS READ OFF EACH FILE, kept so the next rescan does not have to read it
  // again. Loaded on its own rather than through `_loadCache`, because the two answer
  // different questions: that one asks whether this INDEX can be trusted (same roots,
  // recent enough), and a probe of an untouched file is true regardless of either.
  async _loadProbes () {
    const file = this._cacheFile()
    if (!file) return new Map()
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (raw.version !== CACHE_VERSION) return new Map()
      return new Map(Object.entries(raw.probes || {}))
    } catch {
      return new Map()
    }
  }

  async _saveCache (movies, episodes) {
    const file = this._cacheFile()
    if (!file) return
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, JSON.stringify({
        version: CACHE_VERSION,
        roots: this.roots,
        scannedAt: this.scannedAt,
        movies,
        episodes,
        probes: Object.fromEntries(this._probes || [])
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
      sourceError: this.scanError,
      // How many files claimed an id another file already had - two roots holding
      // the same collection. A COUNT, not the paths, for the same reason as above.
      // Reported rather than repaired: the answer is to drop one of the roots, and
      // that is the operator's call.
      duplicates: this.idCollisions
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

  // RANKED, NOT MERELY MATCHED - see items.searchItems for what the ranks mean.
  //
  // Every row is considered rather than the first few hundred. The old version stopped
  // collecting at four times the limit and then sorted, which meant the BEST match
  // could be discarded before anything had judged it: on a library this size, whether
  // the film called "Christmas" appeared at all depended on where it happened to sit
  // in a Map.
  async search ({ q = '', limit = 50 } = {}) {
    return { items: items.searchItems(this._byId.values(), q, limit) }
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

  // WHERE A THING LIVES ON DISK, for sidecar writing (host/sidecars.js) - the
  // one explicit action allowed to put NEW files beside the library's own.
  //
  // The second deliberate path exit after ffmpegInput, with the same discipline:
  // host/server.js calls it, nothing puts the answer on the wire.
  //
  // A film or an episode answers with its file. A series or a season answers
  // with the folder that holds it, derived from any of its episodes' paths -
  // the tree minted those rows from episodes and they have no file of their
  // own. The derivation repeats _identify's convention on purpose: the top
  // folder under the root is the show, a deeper folder is the season.
  //
  // Null for anything the disk cannot place: an id that is gone, an episode
  // sitting directly in a root (no show folder exists to receive a tvshow.nfo)
  // or a season the tree keyed by folder rather than number.
  locate (id) {
    const item = this._byId?.get(String(id))
    if (!item) return null

    if (item.type === 'movie' || item.type === 'episode') {
      const file = this._paths.get(item.id)
      return file ? { type: item.type, file } : null
    }
    if (item.type !== 'series' && item.type !== 'season') return null

    // The FIRST episode that places it suffices. A show split across two roots
    // has a folder in each, and both are that show's folder - writing into the
    // one its first episode names is no more arbitrary than either.
    for (const [epId, ep] of this._byId) {
      if (ep.type !== 'episode') continue
      if ((item.type === 'series' ? ep.seriesId : ep.seasonId) !== item.id) continue
      const file = this._paths.get(epId)
      if (!file) continue
      const root = this.roots.find(r => file.startsWith(r.path + path.sep))
      if (!root) continue
      const parts = path.relative(root.path, file).split(path.sep)
      if (parts.length < 2) continue
      const seriesDir = path.join(root.path, parts[0])
      if (item.type === 'series') return { type: 'series', dir: seriesDir }
      return {
        type: 'season',
        dir: parts.length > 2 ? path.dirname(file) : null,
        seriesDir,
        number: item.number ?? null
      }
    }
    return null
  }

  // CAN THIS TRACK BE SHOWN, and if not, why - decided when it is ASKED FOR rather
  // than when it was scanned.
  //
  // The verdict is a fact about what this VERSION can do, not about the file. Baking
  // it into the scan means a cache written today still says "cannot show" after the
  // day something learns to burn a picture track in, and the operator's only route
  // out is a rescan they have no reason to suspect they need. It also bit
  // immediately: the reason wording was fixed hours after a cache was written with
  // the old one, and a cached host would have gone on saying the useless version.
  _verdict (track) {
    if (track.external) {
      const playable = SUBTITLE_PLAYABLE.has(track.codec)
      return {
        playable,
        reason: playable ? null : (SUBTITLE_REASON[track.codec] || `unsupported subtitle format: ${track.codec}`)
      }
    }
    const reason = subtitles.reasonFor(track.codec)
    return { playable: !reason, reason }
  }

  async subtitles ({ itemId } = {}) {
    return (this._subs.get(String(itemId)) || []).map(t => ({ ...t, ...this._verdict(t) }))
  }

  // Where an IMAGE subtitle track lives inside its own file, for burn-in
  // (host/server.js resolves this into the transcode's overlay filter). Only an
  // EMBEDDED image track of THIS item answers: an external file, a text track
  // (which plays without a re-encode and must never trigger one) or a foreign
  // subtitle id are all null, and null means the burn request is ignored
  // rather than half-honoured.
  subtitleBurnTarget ({ itemId, subtitleId } = {}) {
    const track = (this._subs.get(String(itemId)) || []).find(s => s.id === String(subtitleId))
    if (!track || track.external) return null
    if (!subtitles.burnable(track.codec)) return null
    const embedded = this._subTracks.get(String(subtitleId))
    if (!embedded) return null
    const input = this._resolveIn(this._paths, itemId, 'burn-source')
    if (!input || input !== path.resolve(embedded.file)) return null
    return {
      index: embedded.index,
      canvasWidth: track.canvasWidth ?? null,
      canvasHeight: track.canvasHeight ?? null
    }
  }

  async subtitle ({ itemId, subtitleId } = {}) {
    // The track must belong to the item that asked for it. Without this check any
    // subtitle id serves against any item id, which is not a disclosure on its own -
    // they are all in the same library - but it is the kind of loose coupling that
    // stops being harmless the moment there are per-item permissions.
    const track = (this._subs.get(String(itemId)) || []).find(s => s.id === String(subtitleId))
    if (!track) return null

    // A track that was listed as unshowable is not served, whatever asks for it. The
    // list is honest about PGS precisely so a client can say why; handing one over
    // anyway would produce a player showing an empty subtitle track and no reason.
    // Re-decided here rather than read off the row, so this cannot disagree with the
    // list the client was given - see _verdict.
    if (!this._verdict(track).playable) return null

    // INSIDE THE FILE. One ffmpeg, reading a text track out and converting it to
    // WebVTT - kilobytes of text, no decoding, nothing written to disk. The video
    // path's concurrency limit deliberately does not apply: this is a header read,
    // not a transcode.
    const embedded = this._subTracks.get(String(subtitleId))
    if (embedded) {
      const input = this._resolveIn(this._paths, itemId, 'subtitle-source')
      if (!input || input !== path.resolve(embedded.file)) return null
      return subtitles.extractSubtitle({
        ffmpeg: this.ffmpeg,
        input,
        index: embedded.index,
        log: this.log
      })
    }

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
    const inRoot = this.roots.some(root => resolved === root.path || resolved.startsWith(root.path + path.sep))
    if (!inRoot) {
      this.log('folder:path-outside-root', { what, id: String(id).slice(0, 12) })
      return null
    }
    return resolved
  }
}

module.exports = { FolderAdapter, SCAN_TTL_MS, ROOT_TYPES, normaliseRoot }
