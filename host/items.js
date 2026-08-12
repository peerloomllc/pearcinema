// The item model. A film is a leaf; a show is a three-level tree.
//
// THIS IS THE LARGEST SINGLE PIECE OF NEW CODE IN PEARCINEMA AND IT IS NOT A
// RENAME of PearTune's track/album/artist. The shapes genuinely differ:
//
//   PearTune   artist -> album -> track       three levels, leaves at the bottom
//   PearCinema movie                          ONE level, a leaf on its own
//              series -> season -> episode    three levels, leaves at the bottom
//
// So a library has TWO root shapes living side by side, and every list, sort and
// lookup has to cope with a leaf and a container appearing in the same result set.
// That is the whole difficulty, and it is why this file exists instead of a rename
// sweep through the donor's browse code.
//
// "Continue watching" is a third shape again: a FLAT list of leaves cutting across
// both trees, ordered by when you last touched them. It is not a level of either
// hierarchy, which is why resume state is keyed by leaf id and nothing else.

// --- the type vocabulary ----------------------------------------------------

// Leaves: a thing you can actually press play on, and the only things that carry a
// resume position, a runtime or a media file.
const LEAF_TYPES = new Set(['movie', 'episode'])

// Containers: a thing you open to find more things. They carry artwork and counts
// and never a stream.
const CONTAINER_TYPES = new Set(['series', 'season'])

const ITEM_TYPES = new Set([...LEAF_TYPES, ...CONTAINER_TYPES])

// What `library.list` will answer for. `movies` and `series` are the two library
// roots; `seasons` and `episodes` are always scoped to a parent, and asking for
// them unscoped is a bad request rather than a full-library dump.
const LIST_TYPES = new Set(['movies', 'series', 'seasons', 'episodes'])

const SCOPED_LIST_TYPES = new Set(['seasons', 'episodes'])

const isLeaf = (type) => LEAF_TYPES.has(type)
const isContainer = (type) => CONTAINER_TYPES.has(type)

// --- string hygiene ---------------------------------------------------------

// Titles come off a filename, an .nfo written by anything, or a remote server. All
// three are outside our control, so they are cleaned HERE, at the point they enter
// the model, rather than wherever they happen to be rendered.
const TITLE_MAX = 300
const TEXT_MAX = 4000

function clean (s, max = TITLE_MAX) {
  if (typeof s !== 'string') return ''
  // Control characters to a space FIRST (a newline in a dashboard row, a NUL in a log
  // line), then collapse runs, then trim, then cap. Cap LAST, so a title padded with
  // 400 spaces does not survive as 300 spaces.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

// A year, or null. Rejects the nonsense a filename parser will hand us: `1080` from
// a resolution tag, a season number, a stray episode code.
//
// THE UPPER BOUND IS 2100 AND THAT IS NOT AN ARBITRARY ROUND NUMBER. `2160` is the
// 4K resolution tag, and it sits inside any range generous enough to look
// future-proof - a filename like `Dune.2160p.mkv` would otherwise be filed as a
// film from the year 2160. No release date this side of the heat death of cinema
// needs 2100, so the bound is set where it excludes the tag.
const YEAR_MIN = 1878 // the first moving picture
const YEAR_MAX = 2100
function year (v) {
  const n = Number(v)
  if (!Number.isInteger(n)) return null
  if (n < YEAR_MIN || n > YEAR_MAX) return null
  return n
}

function count (v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

// Runtime in SECONDS, or null. Seconds and not milliseconds, matching the donor's
// track duration, so a resume position and a runtime are the same unit and nobody
// has to remember which. Jellyfin reports ticks and folders report nothing, so both
// convert at the adapter and this only validates.
function runtime (v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n)
}

function list (v, max = 30) {
  if (!Array.isArray(v)) return []
  return v.map(x => clean(x, 120)).filter(Boolean).slice(0, max)
}

// --- media facts ------------------------------------------------------------
//
// The reason PearCinema v1 exists in the shape it does. It ships DIRECT PLAY ONLY,
// against a real library, precisely to learn which files a real phone can actually
// open - because building a transcode pipeline first means building it against a
// guess.
//
// So every leaf carries what its file IS, and the host reports it rather than
// judging it. `mode` and a capabilities negotiation are deliberately NOT in v1
// (see the proposal): guessing client-side is how this goes wrong, and guessing
// host-side before there is data is how it goes wrong more slowly.

function media (m = {}) {
  const width = count(m.width) || null
  const height = count(m.height) || null
  return {
    container: clean(m.container, 16).toLowerCase() || null,
    videoCodec: clean(m.videoCodec, 16).toLowerCase() || null,
    audioCodec: clean(m.audioCodec, 16).toLowerCase() || null,
    width,
    height,
    // Bytes. Matters here in a way it never did for audio: a film is a thousand
    // times a song, which is the reason offline downloads are out of v1 and need a
    // different budget model rather than a bigger number.
    size: count(m.size) || null
  }
}

// A short, honest label for what this file is, for the UI and the operator's own
// eyes. NOT a playability verdict - we do not have the data to make one yet, and
// pretending otherwise would answer the exact question v1 was built to ask.
function mediaLabel (m) {
  if (!m) return ''
  const parts = []
  if (m.height) parts.push(m.height >= 2000 ? '4K' : `${m.height}p`)
  if (m.videoCodec) parts.push(m.videoCodec.toUpperCase())
  if (m.audioCodec) parts.push(m.audioCodec.toUpperCase())
  if (m.container) parts.push(m.container.toUpperCase())
  return parts.join(' · ')
}

// --- normalizers ------------------------------------------------------------
//
// Every adapter funnels through these, so a Jellyfin row and a folder row are the
// same object by the time anything downstream sees them. That is what keeps the
// folder path a first-class citizen rather than a fallback nobody tests.

function movie (row = {}) {
  return {
    type: 'movie',
    id: String(row.id || ''),
    title: clean(row.title) || 'Untitled',
    year: year(row.year),
    runtime: runtime(row.runtime),
    overview: clean(row.overview, TEXT_MAX) || null,
    genres: list(row.genres),
    artId: row.artId ? String(row.artId) : null,
    media: media(row.media)
  }
}

function series (row = {}) {
  return {
    type: 'series',
    id: String(row.id || ''),
    title: clean(row.title) || 'Untitled',
    year: year(row.year),
    overview: clean(row.overview, TEXT_MAX) || null,
    genres: list(row.genres),
    artId: row.artId ? String(row.artId) : null,
    seasonCount: count(row.seasonCount),
    episodeCount: count(row.episodeCount)
  }
}

function season (row = {}) {
  const number = Number.isInteger(Number(row.number)) ? Number(row.number) : null
  return {
    type: 'season',
    id: String(row.id || ''),
    seriesId: String(row.seriesId || ''),
    seriesTitle: clean(row.seriesTitle) || null,
    // Season 0 is real and it is SPECIALS, which is why this is `null`-checked
    // rather than falsy-checked. A truthiness test here files every special under
    // "no season" and they vanish from the tree.
    number,
    title: clean(row.title) || (number === 0 ? 'Specials' : number === null ? 'Season' : `Season ${number}`),
    artId: row.artId ? String(row.artId) : null,
    episodeCount: count(row.episodeCount)
  }
}

function episode (row = {}) {
  const seasonNumber = Number.isInteger(Number(row.seasonNumber)) ? Number(row.seasonNumber) : null
  const episodeNumber = Number.isInteger(Number(row.episodeNumber)) ? Number(row.episodeNumber) : null
  return {
    type: 'episode',
    id: String(row.id || ''),
    seriesId: String(row.seriesId || ''),
    seasonId: String(row.seasonId || ''),
    seriesTitle: clean(row.seriesTitle) || null,
    seasonNumber,
    episodeNumber,
    title: clean(row.title) || 'Untitled',
    year: year(row.year),
    runtime: runtime(row.runtime),
    overview: clean(row.overview, TEXT_MAX) || null,
    artId: row.artId ? String(row.artId) : null,
    media: media(row.media)
  }
}

const NORMALIZE = { movie, series, season, episode }

function normalize (row) {
  const fn = NORMALIZE[row?.type]
  if (!fn) throw new Error(`unknown item type: ${row?.type}`)
  return fn(row)
}

// --- display ----------------------------------------------------------------

// `S01E03`, padded so a list sorts and reads straight. Null where the numbers are
// not both known, because "S??E03" is worse than nothing.
function episodeCode (e) {
  if (!e || e.seasonNumber === null || e.episodeNumber === null) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `S${pad(e.seasonNumber)}E${pad(e.episodeNumber)}`
}

// One line naming an item unambiguously. The two leaf shapes read differently on
// purpose: a film is its title and year, an episode is its show and its slot.
function displayTitle (item) {
  if (!item) return ''
  if (item.type === 'movie') return item.year ? `${item.title} (${item.year})` : item.title
  if (item.type === 'episode') {
    const code = episodeCode(item)
    const head = [item.seriesTitle, code].filter(Boolean).join(' ')
    return head ? `${head} - ${item.title}` : item.title
  }
  if (item.type === 'season') {
    return item.seriesTitle ? `${item.seriesTitle} - ${item.title}` : item.title
  }
  return item.year ? `${item.title} (${item.year})` : item.title
}

// --- sorting ----------------------------------------------------------------

// Locale-aware and numeric, so "Episode 2" sorts before "Episode 10" and accents do
// not exile a title to the end of the list.
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

// Leading articles are dropped for SORTING only, never for display. "The Wire"
// belongs under W in a list people scan, and this is what every media library does.
const ARTICLES = /^(the|a|an)\s+/i
const sortKey = (title) => String(title || '').replace(ARTICLES, '')

const byTitle = (a, b) =>
  collator.compare(sortKey(a.title), sortKey(b.title)) ||
  collator.compare(a.id, b.id)

const byYear = (a, b) =>
  // Undated last, rather than pretending they are year zero.
  ((b.year ?? -Infinity) - (a.year ?? -Infinity)) || byTitle(a, b)

// The one order that is structural rather than cosmetic. Specials (season 0) go
// LAST despite sorting first numerically, because nobody watches a show starting
// with its Christmas special.
const bySeason = (a, b) => {
  const rank = (s) => (s.number === null ? 9998 : s.number === 0 ? 9999 : s.number)
  return rank(a) - rank(b) || byTitle(a, b)
}

const byEpisode = (a, b) =>
  (a.seasonNumber ?? 9999) - (b.seasonNumber ?? 9999) ||
  (a.episodeNumber ?? 9999) - (b.episodeNumber ?? 9999) ||
  byTitle(a, b)

const SORTS = {
  title: byTitle,
  year: byYear,
  season: bySeason,
  episode: byEpisode
}

// The sort a type gets when nobody asked for one. An episode list in title order
// would be unusable, so this is not a cosmetic default.
const DEFAULT_SORT = {
  movies: 'title',
  series: 'title',
  seasons: 'season',
  episodes: 'episode'
}

function sortItems (items, sort, order = 'asc') {
  const cmp = SORTS[sort] || byTitle
  const out = [...items].sort(cmp)
  return order === 'desc' ? out.reverse() : out
}

// --- the tree ---------------------------------------------------------------

// Build series -> season -> episode from a FLAT list of episodes, which is what a
// folder scan produces and what a server that only answers "give me every episode"
// produces too.
//
// Grouping is by the ids the caller already minted, not by title, so two shows that
// happen to share a name stay apart and one show spelled two ways does not split.
// Counts are computed here rather than trusted from a source, because a source that
// reports a season count and an episode list that disagree is a real thing.
function buildTree (episodes) {
  const seriesById = new Map()
  const seasonById = new Map()
  const episodesBySeason = new Map()

  for (const raw of episodes) {
    const e = raw.type === 'episode' ? raw : episode(raw)
    if (!e.id || !e.seriesId || !e.seasonId) continue

    if (!seriesById.has(e.seriesId)) {
      seriesById.set(e.seriesId, series({
        id: e.seriesId,
        title: e.seriesTitle || 'Untitled',
        year: e.year
      }))
    }
    if (!seasonById.has(e.seasonId)) {
      seasonById.set(e.seasonId, season({
        id: e.seasonId,
        seriesId: e.seriesId,
        seriesTitle: e.seriesTitle,
        number: e.seasonNumber
      }))
    }
    if (!episodesBySeason.has(e.seasonId)) episodesBySeason.set(e.seasonId, [])
    episodesBySeason.get(e.seasonId).push(e)
  }

  for (const s of seasonById.values()) {
    s.episodeCount = episodesBySeason.get(s.id)?.length || 0
  }
  for (const s of seriesById.values()) {
    const seasons = [...seasonById.values()].filter(x => x.seriesId === s.id)
    s.seasonCount = seasons.length
    s.episodeCount = seasons.reduce((n, x) => n + x.episodeCount, 0)
    // A series takes the EARLIEST year across its episodes: a show is dated by when
    // it started, not by whichever episode happened to be scanned first.
    const years = seasons
      .flatMap(x => episodesBySeason.get(x.id) || [])
      .map(e => e.year)
      .filter(y => y !== null)
    s.year = years.length ? Math.min(...years) : null
  }

  return {
    series: sortItems([...seriesById.values()], 'title'),
    seasons: sortItems([...seasonById.values()], 'season'),
    episodes: episodesBySeason,
    seasonsOf (seriesId) {
      return sortItems([...seasonById.values()].filter(s => s.seriesId === seriesId), 'season')
    },
    episodesOf (seasonId) {
      return sortItems(episodesBySeason.get(seasonId) || [], 'episode')
    }
  }
}

// --- paging -----------------------------------------------------------------

// A film library is small in rows and huge in bytes, the opposite of a music
// library, so the cap here is about a phone's render budget rather than the wire.
const PAGE_MAX = 500
const PAGE_DEFAULT = 100

function page (items, { limit = PAGE_DEFAULT, cursor = 0 } = {}) {
  const start = Math.max(0, Math.floor(Number(cursor) || 0))
  // An ABSENT limit takes the default; an explicit one is clamped. Written as a
  // finite check rather than `Number(limit) || PAGE_DEFAULT`, because that form
  // turns `limit: 0` into a hundred rows - a falsy-zero bug that would only ever
  // show up as a client asking for nothing and receiving a page.
  const asked = Number(limit)
  const size = Number.isFinite(asked)
    ? Math.min(PAGE_MAX, Math.max(1, Math.floor(asked)))
    : PAGE_DEFAULT
  const slice = items.slice(start, start + size)
  const next = start + slice.length
  return {
    items: slice,
    total: items.length,
    cursor: next < items.length ? next : null
  }
}

module.exports = {
  LEAF_TYPES,
  CONTAINER_TYPES,
  ITEM_TYPES,
  LIST_TYPES,
  SCOPED_LIST_TYPES,
  isLeaf,
  isContainer,

  movie,
  series,
  season,
  episode,
  normalize,
  media,
  mediaLabel,

  episodeCode,
  displayTitle,

  SORTS,
  DEFAULT_SORT,
  sortItems,
  collator,

  buildTree,
  page,
  PAGE_MAX,
  PAGE_DEFAULT
}
