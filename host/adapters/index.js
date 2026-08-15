// The source adapter contract.
//
// ONE INTERFACE, several implementations, and the app never learns which is
// behind the media API. That is what keeps the FOLDER path a first-class citizen
// instead of a fallback nobody tests - and the folder adapter is the moat. If
// PearCinema only ever reads Jellyfin it is a Jellyfin accessory, and Jellyfin is
// free to improve its own remote access whenever it likes.
//
// Jellyfin is FIRST only because it reaches first playback fastest. That is a
// sequencing convenience inside v1, not a scope cut (Tim, 2026-08-12).
//
// Every adapter answers in the normalized shapes from ../items.js. A row that has
// not been through `items.movie()` and friends must never leave an adapter, or the
// two sources drift into two models and every consumer downstream grows a branch.
//
// THE CONTRACT
//
//   kind            'jellyfin' | 'folder' | 'empty'
//   async ping()    -> { ok, detail } . Can we reach the source at all?
//   async scan()    -> number of LEAVES found. Throws on bad credentials or a
//                      missing folder - the dashboard's Test button depends on it
//                      throwing rather than reporting an empty library.
//   async stats()   -> { movies, series, seasons, episodes }
//   async list(q)   -> { items, total, cursor } . q: { type, seriesId, seasonId,
//                      limit, cursor, sort, order }
//   async get(q)    -> a normalized item, or null. q: { id, type }
//   async search(q) -> { items } . q: { q, limit }
//   async art(q)    -> a Readable, or null. q: { artId, size }
//   async stream(q) -> a Readable, or null. q: { itemId, offset, length }
//
// `stream` TAKES offset AND length AND THAT IS WHY V1 IS DIRECT-PLAY ONLY. The
// donor's media.stream already carried both and FolderAdapter.stream already did
// real byte-range reads, so seeking inside a two-hour film works on day one with
// no protocol change. Progressive delivery with `accept-ranges: none` would not be
// acceptable for a film, and we do not have to ship it.

const { EmptyAdapter } = require('./empty')
const { JellyfinAdapter } = require('./jellyfin')
const { FolderAdapter } = require('./folder')
const ffmpegBin = require('../ffmpeg-bin')

const KINDS = new Set(['empty', 'jellyfin', 'folder'])

// Build an adapter from a saved source config. Unknown kinds fall back to the
// empty adapter rather than throwing, because a host that will not start is a host
// whose dashboard the operator cannot reach to fix the config.
function buildAdapter (cfg, { libraryId, ids, dataDir = null, log = () => {} } = {}) {
  const kind = cfg?.kind || 'empty'

  switch (kind) {
    case 'folder':
      return new FolderAdapter({
        roots: cfg.roots || (cfg.root ? [cfg.root] : []),
        dataDir,
        libraryId,
        ids,
        log,
        // The same binaries the rest of the host uses, through the one
        // resolution point (setting, bundled, PATH - see host/ffmpeg-bin.js).
        ffprobe: ffmpegBin.ffprobe(),
        ffmpeg: ffmpegBin.ffmpeg()
      })

    case 'jellyfin':
      return new JellyfinAdapter({
        url: cfg.url,
        username: cfg.username,
        password: cfg.password,
        libraryId,
        ids,
        log
      })

    case 'empty':
    default:
      if (kind !== 'empty') log('source:unknown-kind', { kind })
      return new EmptyAdapter({ libraryId, log })
  }
}

module.exports = { buildAdapter, KINDS, EmptyAdapter, JellyfinAdapter, FolderAdapter }
