// Reading the `.nfo` files that Kodi, Jellyfin, Emby, Sonarr and Radarr leave
// beside the media.
//
// THIS IS WHY THE FOLDER ADAPTER NEEDS NO INTERNET. Self-hosted libraries are
// overwhelmingly populated by tools that already did the identifying, and all of
// them write the answer to disk in the same XML dialect. So a folder can have
// titles, years, plots, cast, episode ordering and artwork with zero network
// calls, no API key and no third party learning what you own.
//
// It matters more here than the proposal assumed. The name parser deliberately
// refuses to guess a year from a bare title - `Blade Runner 2049` is a film, not a
// year - so only 19 of the 240 films in the real library yield one from their
// filename. The `.nfo` beside them carries it, along with everything else.
//
// FOUR ROOTS, one per thing:
//
//   <movie>           a film
//   <episodedetails>  an episode
//   <tvshow>          a show      (tvshow.nfo in the show's folder)
//   <season>          a season    (season.nfo in the season's folder)
//
// NO XML LIBRARY, on purpose. This dialect is flat, machine-generated and stable,
// and the alternative is a parser dependency in a host that currently has almost
// none. The cost is that this is a scanner rather than a real parser: it is
// deliberately narrow, it ignores what it does not recognise, and the container
// blocks that could confuse it are removed before it looks at anything.

// Blocks holding NESTED elements whose names collide with the scalar fields we
// want. `<art><poster>` holds a path, `<actor><name>` holds a name; scanning for a
// bare `<name>` or a bare `<poster>` across the whole document would find those.
// Removed wholesale first, then parsed separately where they are wanted.
const NESTED_BLOCKS = ['actor', 'art', 'fileinfo', 'resume', 'ratings', 'uniqueid', 'thumb']

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"
}

function decode (s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m])
}

function clean (xml) {
  return String(xml)
    // A byte-order mark. Every file in the real library has one, and it makes the
    // root-element match fail if it is not removed first.
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // CDATA survives as its contents.
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner)
}

function stripNested (xml) {
  let out = xml
  for (const tag of NESTED_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi'), '')
    out = out.replace(new RegExp(`<${tag}(\\s[^>]*)?/>`, 'gi'), '')
  }
  return out
}

// Every value for one element name, in document order. Self-closing `<plot />` -
// which the real season.nfo files are full of - yields nothing rather than the
// string "/>".
function all (xml, tag) {
  const out = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  let m
  while ((m = re.exec(xml)) !== null) {
    const v = decode(m[1]).trim()
    if (v) out.push(v)
  }
  return out
}

const one = (xml, tag) => all(xml, tag)[0] ?? null

function num (xml, tag) {
  const v = one(xml, tag)
  if (v === null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int (xml, tag) {
  const n = num(xml, tag)
  return n === null ? null : Math.trunc(n)
}

// KODI RUNTIME IS IN MINUTES. PearCinema is in seconds throughout, so that a
// runtime and a resume position never need anyone to remember which is which. A
// 187 read as seconds turns King Kong into a three-minute film, which is the kind
// of wrong that looks like a bug in the player.
function runtimeSeconds (xml) {
  const mins = num(xml, 'runtime')
  return mins && mins > 0 ? Math.round(mins * 60) : null
}

// A `<premiered>2005-12-12</premiered>` or `<releasedate>`, for a year the
// `<year>` element did not carry.
function yearFrom (xml) {
  const y = int(xml, 'year')
  if (y) return y
  for (const tag of ['premiered', 'releasedate', 'aired']) {
    const v = one(xml, tag)
    const m = v && v.match(/^(\d{4})/)
    if (m) return +m[1]
  }
  return null
}

// The cast, from the `<actor>` blocks removed above. Order is meaningful - Kodi
// writes billing order - so it is preserved and capped rather than sorted.
const CAST_MAX = 20
function actors (xml) {
  const out = []
  const re = /<actor(?:\s[^>]*)?>([\s\S]*?)<\/actor>/gi
  let m
  while ((m = re.exec(xml)) !== null && out.length < CAST_MAX) {
    const name = one(m[1], 'name')
    if (!name) continue
    out.push({ name, role: one(m[1], 'role') || null })
  }
  return out
}

const ROOTS = {
  movie: 'movie',
  episodedetails: 'episode',
  tvshow: 'series',
  season: 'season'
}

// What KIND of thing does this file describe? Read from the root element rather
// than from the filename, because `Firefly - S01E07.nfo` and `tvshow.nfo` are both
// just names and either could hold either.
function detectKind (xml) {
  const m = clean(xml).match(/<(movie|episodedetails|tvshow|season)(?:\s[^>]*)?>/i)
  return m ? ROOTS[m[1].toLowerCase()] : null
}

// Parse a .nfo into the fields PearCinema's item model uses. Returns null when the
// file is not one of the four kinds - which includes an empty file, a half-written
// one, and somebody's actual notes saved as .nfo, all of which exist in the wild.
//
// ARTWORK PATHS ARE DELIBERATELY IGNORED. The real files carry
// `<art><poster>F:\Video\Movies\HD-DVDs\King Kong-poster.jpg</poster></art>` - an
// absolute path on the Windows machine that wrote them, years ago. Following it
// would fail on every host that is not that machine, and on that machine it would
// be a path traversal waiting to happen. Artwork is found by looking next to the
// file instead (see names.isArtworkFor).
function parseNfo (xml) {
  const kind = detectKind(xml)
  if (!kind) return null

  const raw = clean(xml)
  const flat = stripNested(raw)

  const base = {
    kind,
    title: one(flat, 'title'),
    originalTitle: one(flat, 'originaltitle'),
    sortTitle: one(flat, 'sorttitle'),
    year: yearFrom(flat),
    // `<outline>` is the short form and `<plot>` the long one; prefer the long.
    plot: one(flat, 'plot') || one(flat, 'outline'),
    tagline: one(flat, 'tagline'),
    runtime: runtimeSeconds(flat),
    genres: all(flat, 'genre'),
    studios: all(flat, 'studio'),
    directors: all(flat, 'director'),
    countries: all(flat, 'country'),
    rating: num(flat, 'rating'),
    mpaa: one(flat, 'mpaa'),
    ids: {
      imdb: one(flat, 'imdbid') || one(flat, 'imdb_id'),
      tmdb: one(flat, 'tmdbid') || one(flat, 'tmdb_id'),
      tvdb: one(flat, 'tvdbid') || one(flat, 'tvdb_id')
    },
    cast: actors(raw)
  }

  if (kind === 'episode') {
    return {
      ...base,
      season: int(flat, 'season'),
      episode: int(flat, 'episode'),
      showTitle: one(flat, 'showtitle')
    }
  }

  if (kind === 'season') {
    return { ...base, season: int(flat, 'seasonnumber') ?? int(flat, 'season') }
  }

  return base
}

// Merge a sidecar over a parsed filename. SIDECAR WINS, ALWAYS - that is the whole
// "sidecar-first" rule. Something that already identified this file beats our
// guess about a filename, every time, and a missing field falls back rather than
// blanking what the filename knew.
//
// The one exception is deliberate: an episode's season and episode NUMBERS keep
// the filename's answer unless the sidecar actually carries them, because plenty
// of real `.nfo` files omit both and a null would unfile the episode entirely.
function applyNfo (parsed, nfo) {
  if (!nfo) return parsed
  const pick = (a, b) => (a === null || a === undefined || a === '' ? b : a)

  const merged = {
    ...parsed,
    title: pick(nfo.title, parsed.title),
    year: pick(nfo.year, parsed.year ?? null),
    overview: pick(nfo.plot, parsed.overview ?? null),
    runtime: pick(nfo.runtime, parsed.runtime ?? null),
    genres: nfo.genres?.length ? nfo.genres : (parsed.genres || []),
    tagline: nfo.tagline || null,
    rating: nfo.rating ?? null,
    ids: nfo.ids,
    cast: nfo.cast?.length ? nfo.cast : []
  }

  if (parsed.type === 'episode' || nfo.kind === 'episode') {
    merged.season = pick(nfo.season, parsed.season)
    merged.episode = pick(nfo.episode, parsed.episode)
    // A sidecar that names the episode overrules a filename that guessed at the
    // numbering - which is exactly the MST3K case, where the filename says K05 and
    // nothing can be inferred from it.
    if (nfo.season !== null && nfo.episode !== null) merged.loose = false
  }

  return merged
}

module.exports = { parseNfo, applyNfo, detectKind, decode, runtimeSeconds, CAST_MAX }
