// Reading a film or an episode out of a file path.
//
// The folder adapter's hardest small problem, and the one most worth doing
// carefully, because everything downstream inherits whatever this gets wrong. A
// server source has a database behind it; a folder has a filename somebody typed
// in 2011 and a scene release group's opinion about underscores.
//
// EVERY RULE HERE WAS DERIVED FROM A REAL LIBRARY (Tim's, 12,197 files, scanned
// 2026-08-12) rather than from a idea of how people name things. The test file
// uses the real filenames verbatim. That matters because the naive version of this
// parser is wrong in ways that only real data reveals - see the year rule below.

// Scene, quality and release tags. Everything from the FIRST of these onward is
// noise, in every naming convention observed. The list is long because it has to
// be: a tag that is not recognised ends up in a title, and a title with `WEB-DL`
// in it is the kind of thing nobody notices until the library is built.
const TAGS = new Set([
  // resolution and source
  '480p', '576p', '720p', '1080p', '1440p', '2160p', '4k', 'uhd', 'hd', 'sd',
  'bluray', 'blu-ray', 'brrip', 'bdrip', 'bdremux', 'remux', 'dvdrip', 'dvd', 'hddvd',
  'webrip', 'web-dl', 'webdl', 'web', 'hdtv', 'pdtv', 'dsr', 'cam', 'ts', 'tc',
  'amzn', 'nf', 'dsnp', 'hmax', 'atvp', 'hulu', 'stan', 'ip',
  // video codecs
  'x264', 'x265', 'h264', 'h265', 'avc', 'hevc', 'xvid', 'divx', 'vp9', 'av1', '10bit', '8bit', 'hi10p',
  // audio
  'aac', 'ac3', 'eac3', 'dd', 'dd5', 'ddp', 'dts', 'dts-hd', 'dts-x', 'truehd', 'atmos',
  'flac', 'mp3', 'opus', 'aac2', '5.1', '7.1', '2.0', 'dual-audio', 'dualaudio',
  // edition and misc
  'remastered', 'extended', 'unrated', 'uncut', 'proper', 'repack', 'internal',
  'limited', 'imax', 'hdr', 'hdr10', 'dv', 'sdr', 'complete', 're-encode', 'reencode',
  'multi', 'subbed', 'dubbed'
])

// Release groups seen trailing a name after a hyphen. Not exhaustive and does not
// need to be: the tag scan usually stops before them. This catches the ones that
// arrive attached to a tag, like `x265-RARBG`.
const GROUP_AFTER_TAG = /-[a-z0-9]+$/i

const isTag = (word) => {
  const w = word.toLowerCase().replace(/^[[({]+|[\])}]+$/g, '')
  if (!w) return false
  if (TAGS.has(w)) return true
  // `x265-RARBG`, `DTS-HD`, `AAC2.0` and friends: the head is a tag.
  const head = w.split('-')[0]
  return TAGS.has(head)
}

// A plausible release year. The upper bound is 2100 rather than something roomier
// for the same reason items.js uses it: 2160 is a resolution.
const YEAR_MIN = 1878
const YEAR_MAX = 2100
const isYearish = (word) => /^\d{4}$/.test(word) && +word >= YEAR_MIN && +word <= YEAR_MAX

// Separators people actually use, normalised to spaces. Dots are the interesting
// one: `The.x-files.s06e17.trevor` is all dots, but `Dr. Strangelove` and
// `Final.Fantasy.VII` are not, so dots become spaces only when the name is
// clearly dot-separated (three or more).
function toWords (name) {
  let s = name
  const dots = (s.match(/\./g) || []).length
  if (dots >= 3) s = s.replace(/\./g, ' ')
  s = s.replace(/_/g, ' ')
  return s.replace(/\s+/g, ' ').trim()
}

// THE YEAR RULE, and it is the opposite of the obvious one.
//
// The obvious parser takes any 4-digit number in range as the year. On a real
// library that is wrong constantly, and wrong in a way that mangles the title:
//
//   2001 A Space Odyssey      -> title "A Space Odyssey", year 2001   WRONG
//   Blade Runner 2049         -> title "Blade Runner",    year 2049   WRONG
//   300                       -> (safe, only 3 digits, but it shows the shape)
//
// So a bare number is NEVER taken as a year. It counts only when something else
// confirms it:
//
//   1. It is in parentheses or brackets - `Ghostbusters (1984)`. Unambiguous.
//   2. It is immediately followed by a release tag - `Blade 1998 1080p BluRay`,
//      `Despicable Me 3 2017 1080p BluRay REMUX`. Nobody writes a tag after a
//      title word that happens to be a number.
//
// Everything else keeps its number and reports no year. `Arrival 2016.mkv` comes
// back as "Arrival 2016" with no year, which is worse-looking and far better than
// "Blade Runner" for Blade Runner 2049. A sidecar .nfo settles those properly, and
// most libraries have one.
function findYear (words) {
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]
    const bare = raw.replace(/^[[(]|[\])]$/g, '')
    if (!isYearish(bare)) continue

    // 1: parenthesised.
    if (/^[[(]/.test(raw) && /[\])]$/.test(raw)) return { year: +bare, at: i }

    // 2: followed by a tag. A year at position 0 is never a year - `2001 A Space
    // Odyssey` - so require something before it too.
    if (i > 0 && i + 1 < words.length && isTag(words[i + 1])) return { year: +bare, at: i }
  }
  return { year: null, at: -1 }
}

// Where the noise starts. Everything from the first release tag onward is dropped.
function firstTagIndex (words, from = 0) {
  for (let i = from; i < words.length; i++) {
    if (isTag(words[i])) return i
  }
  return -1
}

// A parenthetical group that is entirely release tags - `(1080p BluRay x265
// Silence)` - is noise. One that is not - `(1)` in `Calling (1)`, `(US)` in `The
// Office (US)` - is part of the name and stays. Getting this backwards either
// leaves a wall of tags in every episode title or deletes the part number that
// tells two-parters apart.
function stripTagParens (s) {
  return s.replace(/[([]([^)\]]*)[)\]]/g, (whole, inner) => {
    const parts = inner.trim().split(/\s+/).filter(Boolean)
    if (!parts.length) return ''
    const tagged = parts.filter(isTag).length
    // Mostly tags, or a single tag on its own.
    return tagged >= Math.max(1, Math.ceil(parts.length / 2)) ? '' : whole
  })
}

function tidy (s) {
  return s
    .replace(/\s+/g, ' ')
    // Trailing junk left by a strip: a dangling dash, an empty bracket pair.
    .replace(/[\s\-–—_]+$/g, '')
    .replace(/^[\s\-–—_]+/g, '')
    .trim()
}

// --- episodes ---------------------------------------------------------------

// The codes people actually write. Ordered most-specific first, because `S01E02E03`
// and `S01E02-E03` are double episodes and must not be read as `S01E02` plus junk.
const EPISODE_PATTERNS = [
  // S01E02E03 / S01E02-E03 - a double episode. The second `e` is REQUIRED, and
  // that is not a stylistic choice:
  //
  //   - Without it, an optional trailing number backtracks INTO the episode number
  //     itself. `S02E22` parsed as season 2 episode 2 with a range end of 2, which
  //     is wrong on a real filename from this library and looks plausible enough to
  //     ship.
  //   - Allowing a bare number after a separator (`S01E02-03`) is worse still:
  //     `Show S01E02 5.1 BluRay` would read the audio channel count as the second
  //     half of a double episode.
  //
  // So only the explicit form is recognised. A `S01E02-03` release parses as the
  // single episode 2, which is a small loss and not a wrong one.
  /\bs(\d{1,2})[\s._-]*e(\d{1,3})[\s._-]*e(\d{1,3})\b/i,
  // S01E02 / s01e02 / S1E2
  /\bs(\d{1,2})[\s._-]*e(\d{1,3})\b/i,
  // 1x02
  /\b(\d{1,2})x(\d{1,3})\b/i,
  // Season 1 Episode 2, spelled out
  /\bseason[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})\b/i
]

// Pull the season and episode out of a name. Returns null when there is none,
// which is how a film is told from an episode in the first place.
function parseEpisodeCode (name) {
  for (const re of EPISODE_PATTERNS) {
    const m = name.match(re)
    if (!m) continue
    const season = +m[1]
    const episode = +m[2]
    const last = m[3] ? +m[3] : null
    return {
      season,
      episode,
      // A double episode keeps its range, so "S01E02-E03" does not silently become
      // one episode and lose the other.
      episodeEnd: last && last > episode ? last : null,
      index: m.index,
      length: m[0].length
    }
  }
  return null
}

// A `Season 03` / `Series 3` / `S03` folder. Deliberately NOT the only source of a
// season number: this library holds `MST3K - Complete 35 DVD Collection/MST3K DVD
// 18/`, where the folder is a disc number and the real season lives in the
// filename. The filename wins wherever both exist.
function parseSeasonFolder (name) {
  const m = String(name).match(/^(?:season|series|s)[\s._-]*(\d{1,3})$/i)
  if (m) return +m[1]
  if (/^specials?$/i.test(String(name).trim())) return 0
  return null
}

// --- the two shapes ---------------------------------------------------------

// A film, from its filename.
function parseMovie (filename) {
  const base = String(filename).replace(/\.[a-z0-9]{1,5}$/i, '')
  const words = toWords(base).split(' ').filter(Boolean)

  const { year, at } = findYear(words)
  const tagAt = firstTagIndex(words, year !== null ? at + 1 : 0)

  // Cut at whichever comes first: the year, or the first tag.
  let cut = words.length
  if (year !== null) cut = Math.min(cut, at)
  if (tagAt !== -1) cut = Math.min(cut, tagAt)

  let title = words.slice(0, cut).join(' ')
  title = stripTagParens(title)
  title = title.replace(GROUP_AFTER_TAG, (m) => (isTag(m.slice(1)) ? '' : m))

  return { type: 'movie', title: tidy(title) || tidy(base), year }
}

// An episode, from its path. `seriesFolder` is the show's own directory name, and
// it is PREFERRED over whatever the filename says the show is called - the same
// library holds `The Legend of Korra/Season 02/Legend of Korra - s02e09.mkv`, where
// the filename drops the article. One show should not become two.
// The fallback for shows that never write SxxExx. Measured against the real
// library: 24 of the 65 files that carry no code are one of these two shapes.
//
//   Band Of Brothers/Band Of Brothers Part 2 Day Of Days.mkv     -> S01E02
//   The Legend of Korra/Season 04/... - Chapter 03-3.mkv         -> S04E03
//
// The season comes from the folder (defaulting to 1, which is what a miniseries
// with no season folder is), and the episode from the numbered word.
//
// ONLY RUNS WHEN THE CALLER ALREADY KNOWS THIS IS TELEVISION - that is what
// `seriesFolder` means. Without that guard `Dune - Part Two.mkv` is safe only by
// luck of being spelled out, and the next film named `Part 2` would become an
// episode of itself.
const LOOSE_EPISODE = /\b(?:chapter|part|episode|ep|pt)[\s._-]*(\d{1,3})\b/i

function parseEpisode (filename, { seriesFolder = null, seasonFolder = null } = {}) {
  const base = String(filename).replace(/\.[a-z0-9]{1,5}$/i, '')
  const normalised = toWords(base)

  let code = parseEpisodeCode(normalised)
  let loose = false

  if (!code && seriesFolder) {
    const m = normalised.match(LOOSE_EPISODE)
    if (m) {
      const folderSeason = seasonFolder !== null ? parseSeasonFolder(seasonFolder) : null
      code = {
        season: folderSeason ?? 1,
        episode: +m[1],
        episodeEnd: null,
        index: m.index,
        length: m[0].length
      }
      loose = true
    }
  }

  if (!code) return null

  // The episode's own title is whatever follows the code, cleaned.
  const after = normalised.slice(code.index + code.length)
  const afterWords = after.split(' ').filter(Boolean)
  const tagAt = firstTagIndex(afterWords)
  let epTitle = (tagAt === -1 ? afterWords : afterWords.slice(0, tagAt)).join(' ')
  epTitle = tidy(stripTagParens(epTitle))

  // The show's name. Folder first, then the part of the filename before the code.
  let series = seriesFolder ? String(seriesFolder) : normalised.slice(0, code.index)
  const seriesParsed = parseShowFolder(series)

  // The folder can say `Season 03`; the filename's code wins where they disagree,
  // because the folder is sometimes a disc number.
  const folderSeason = seasonFolder !== null ? parseSeasonFolder(seasonFolder) : null

  return {
    type: 'episode',
    series: seriesParsed.title,
    seriesYear: seriesParsed.year,
    season: code.season,
    episode: code.episode,
    episodeEnd: code.episodeEnd,
    title: epTitle || null,
    // Recorded rather than resolved, so a mismatch is visible instead of silently
    // picking a winner. The filename is used; this says what the folder claimed.
    folderSeason,
    // The numbering was INFERRED from a `Part 2` or `Chapter 03`, not read from a
    // declared SxxExx. Carried so a sidecar .nfo can overrule it without argument,
    // and so a UI can say where the number came from if it turns out wrong.
    loose
  }
}

// A show's directory name: `Smallville (2001)`, `The Office (US) (2005)`, `Firefly`.
// The LAST parenthesised year is the show's year; earlier parentheticals like
// `(US)` are part of the name and stay.
function parseShowFolder (name) {
  let s = tidy(toWords(String(name || '')))
  let year = null

  const m = s.match(/[([](\d{4})[)\]]\s*$/)
  if (m && isYearish(m[1])) {
    year = +m[1]
    s = s.slice(0, m.index)
  }

  s = stripTagParens(s)
  return { title: tidy(s), year }
}

// --- artwork and subtitles --------------------------------------------------

// Poster filenames, in the order they should win. `poster.jpg` and `folder.jpg` are
// the Kodi and Jellyfin conventions; `<name>-poster.jpg` and `<name>.jpg` sit
// beside a file in a flat directory, which is what a `Blurays/` folder of 200 films
// looks like.
const POSTER_NAMES = ['poster', 'folder', 'cover', 'movie', 'default', 'show']
const ART_EXT = ['.jpg', '.jpeg', '.png', '.webp']

// Does this filename look like artwork for `base`?
function isArtworkFor (filename, base) {
  const name = String(filename)
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (!ART_EXT.includes(ext)) return false
  const stem = name.slice(0, name.lastIndexOf('.')).toLowerCase()
  const want = String(base).toLowerCase()
  if (stem === want) return true
  if (stem === want + '-poster' || stem === want + '-thumb' || stem === want + '-fanart') return true
  return POSTER_NAMES.includes(stem)
}

// An external subtitle beside a video, and what language it claims.
// `Film.en.srt`, `Film.eng.forced.srt`, `Film.srt`.
function parseSubtitleName (filename, base) {
  const name = String(filename)
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (!['.srt', '.vtt', '.ass', '.ssa', '.sub'].includes(ext)) return null

  const stem = name.slice(0, name.lastIndexOf('.'))
  const want = String(base)
  if (!stem.toLowerCase().startsWith(want.toLowerCase())) return null

  const rest = stem.slice(want.length).replace(/^[.\-_ ]+/, '')
  const parts = rest ? rest.split(/[.\-_ ]+/).filter(Boolean) : []

  const forced = parts.some(p => /^forced$/i.test(p))
  const sdh = parts.some(p => /^(sdh|cc|hi)$/i.test(p))
  const lang = parts.find(p => /^[a-z]{2,3}$/i.test(p) && !/^(sdh|cc|hi)$/i.test(p)) || null

  return { language: lang ? lang.toLowerCase() : null, forced, sdh, format: ext.slice(1) }
}

module.exports = {
  parseMovie,
  parseEpisode,
  parseEpisodeCode,
  parseSeasonFolder,
  parseShowFolder,
  isArtworkFor,
  parseSubtitleName,
  isTag,
  toWords,
  stripTagParens,
  TAGS,
  POSTER_NAMES
}
