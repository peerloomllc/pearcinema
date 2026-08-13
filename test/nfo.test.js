// Reading the `.nfo` files that Kodi, Jellyfin, Emby, Sonarr and Radarr leave
// beside the media.
//
// The fixtures below are REAL, copied from Tim's library. Byte-order marks,
// self-closing empties, absolute Windows artwork paths and all - because those are
// the three things that actually break a reader, and none of them appear in a
// hand-written example.

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseNfo, applyNfo, detectKind, runtimeSeconds } = require('../host/nfo')

// Real: Video/Movies/HD-DVDs/King Kong.nfo (trimmed, structure verbatim).
const MOVIE = `\uFEFF<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<movie>
  <plot>In 1933 New York, an overly ambitious movie producer coerces his cast and hired ship crew to travel to mysterious Skull Island.</plot>
  <lockdata>false</lockdata>
  <dateadded>2018-03-08 01:23:54</dateadded>
  <title>King Kong</title>
  <originaltitle>King Kong</originaltitle>
  <director>Peter Jackson</director>
  <writer>Peter Jackson</writer>
  <writer>Fran Walsh</writer>
  <rating>6.872</rating>
  <year>2005</year>
  <mpaa>PG-13</mpaa>
  <imdbid>tt0360717</imdbid>
  <tmdbid>254</tmdbid>
  <premiered>2005-12-12</premiered>
  <runtime>187</runtime>
  <tagline>The eighth wonder of the world.</tagline>
  <country>New Zealand</country>
  <country>United States of America</country>
  <genre>Adventure</genre>
  <genre>Drama</genre>
  <genre>Action</genre>
  <studio>Universal Pictures</studio>
  <art>
    <poster>F:\\Video\\Movies\\HD-DVDs\\King Kong-poster.jpg</poster>
    <fanart>F:\\Video\\Movies\\HD-DVDs\\King Kong-backdrop.jpg</fanart>
  </art>
  <actor>
    <name>Naomi Watts</name>
    <role>Ann Darrow</role>
    <thumb>F:\\metadata\\naomi.jpg</thumb>
  </actor>
  <actor>
    <name>Jack Black</name>
    <role>Carl Denham</role>
  </actor>
</movie>`

// Real: Video/TV Shows/The Legend of Korra/Book 2/Legend of Korra - s02e01.nfo
const EPISODE = `\uFEFF<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<episodedetails>
  <plot>Korra struggles to find a deeper connection with the Spirit World.</plot>
  <lockdata>false</lockdata>
  <title>Rebel Spirit</title>
  <director>Colin Heck</director>
  <rating>7.692</rating>
  <year>2013</year>
  <mpaa>TV-Y7</mpaa>
  <imdbid>tt2268096</imdbid>
  <tvdbid>4618883</tvdbid>
  <runtime>24</runtime>
  <genre>Animation</genre>
  <genre>Action</genre>
  <season>2</season>
  <episode>1</episode>
  <art>
    <poster>F:\\Video\\TV Shows\\The Legend of Korra\\Book 2\\metadata\\thumb.jpg</poster>
  </art>
</episodedetails>`

// Real: a season.nfo, which is mostly EMPTY SELF-CLOSING ELEMENTS.
const SEASON = `\uFEFF<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<season>
  <plot />
  <outline />
  <lockdata>false</lockdata>
  <title>Season 1</title>
  <writer>Gary Parker</writer>
  <year>2006</year>
  <tvdbid>16219</tvdbid>
  <premiered>2006-03-05</premiered>
  <art>
  </art>
</season>`

const SHOW = `<?xml version="1.0" encoding="utf-8"?>
<tvshow>
  <title>Firefly</title>
  <plot>Five hundred years in the future.</plot>
  <year>2002</year>
  <genre>Science Fiction</genre>
  <tvdbid>78874</tvdbid>
</tvshow>`

// --- the three things that actually break a reader --------------------------

test('A BYTE-ORDER MARK does not stop the root element being found', () => {
  // Every file in the real library starts with one. Without stripping it, the root
  // match fails and every sidecar in the library reads as "not a .nfo".
  assert.equal(detectKind(MOVIE), 'movie')
  assert.equal(detectKind(EPISODE), 'episode')
  assert.equal(detectKind(SEASON), 'season')
  assert.equal(detectKind(SHOW), 'series')
})

test('SELF-CLOSING EMPTIES yield nothing, not the string "/>"', () => {
  // The real season.nfo files are full of `<plot />`.
  const s = parseNfo(SEASON)
  assert.equal(s.plot, null)
  assert.equal(s.title, 'Season 1')
})

test('ARTWORK PATHS ARE IGNORED, because they point at somebody else\'s machine', () => {
  // The real files carry `F:\Video\Movies\HD-DVDs\King Kong-poster.jpg` - an
  // absolute path on the Windows box that wrote them years ago. Following it fails
  // on every host that is not that machine, and on that machine it is a traversal
  // waiting to happen. Artwork is found by looking beside the file instead.
  const m = parseNfo(MOVIE)
  const asText = JSON.stringify(m)
  assert.ok(!asText.includes('F:'), 'no Windows path may survive into the model')
  assert.ok(!asText.includes('poster'))
  assert.equal(m.art, undefined)
})

// --- fields -----------------------------------------------------------------

test('a film comes back whole', () => {
  const m = parseNfo(MOVIE)
  assert.equal(m.kind, 'movie')
  assert.equal(m.title, 'King Kong')
  assert.equal(m.year, 2005)
  assert.equal(m.tagline, 'The eighth wonder of the world.')
  assert.deepEqual(m.genres, ['Adventure', 'Drama', 'Action'])
  assert.deepEqual(m.countries, ['New Zealand', 'United States of America'])
  assert.deepEqual(m.directors, ['Peter Jackson'])
  assert.equal(m.rating, 6.872)
  assert.equal(m.mpaa, 'PG-13')
  assert.deepEqual(m.ids, { imdb: 'tt0360717', tmdb: '254', tvdb: null })
  assert.match(m.plot, /^In 1933 New York/)
})

test('KODI RUNTIME IS MINUTES and becomes seconds', () => {
  // 187 read as seconds turns King Kong into a three-minute film, which looks like
  // a bug in the player rather than in the reader.
  assert.equal(parseNfo(MOVIE).runtime, 187 * 60)
  assert.equal(parseNfo(EPISODE).runtime, 24 * 60)
  assert.equal(runtimeSeconds('<runtime>0</runtime>'), null)
  assert.equal(runtimeSeconds('<x/>'), null)
})

test('THE CAST SURVIVES the block-stripping that protects everything else', () => {
  // `<actor><name>` would collide with a bare `<name>` scan, so actor blocks are
  // removed before the scalar pass - and then parsed separately. Billing order is
  // meaningful, so it is preserved rather than sorted.
  const m = parseNfo(MOVIE)
  assert.deepEqual(m.cast, [
    { name: 'Naomi Watts', role: 'Ann Darrow' },
    { name: 'Jack Black', role: 'Carl Denham' }
  ])
})

test('an episode carries its numbering when the sidecar has it', () => {
  const e = parseNfo(EPISODE)
  assert.equal(e.kind, 'episode')
  assert.equal(e.title, 'Rebel Spirit')
  assert.equal(e.season, 2)
  assert.equal(e.episode, 1)
  assert.equal(e.ids.tvdb, '4618883')
})

test('a year is recovered from premiered when <year> is missing', () => {
  const noYear = SHOW.replace('<year>2002</year>', '')
  assert.equal(parseNfo(noYear).year, null)
  assert.equal(parseNfo('<movie><premiered>1999-03-31</premiered></movie>').year, 1999)
  assert.equal(parseNfo('<movie><aired>1977-05-25</aired></movie>').year, 1977)
})

test('entities are decoded', () => {
  const x = '<movie><title>Fire &amp; Fury &lt;Special&gt;</title></movie>'
  assert.equal(parseNfo(x).title, 'Fire & Fury <Special>')
  assert.equal(parseNfo('<movie><title>Caf&#233;</title></movie>').title, 'Café')
})

test('CDATA survives as its contents', () => {
  const x = '<movie><plot><![CDATA[A plot with <b>markup</b> in it.]]></plot></movie>'
  assert.equal(parseNfo(x).plot, 'A plot with <b>markup</b> in it.')
})

test('a file that is not one of the four kinds is not a sidecar', () => {
  // Empty files, half-written ones, and somebody's actual notes saved as .nfo all
  // exist in the wild.
  assert.equal(parseNfo(''), null)
  assert.equal(parseNfo('just some notes about this rip'), null)
  assert.equal(parseNfo('<something><title>x</title></something>'), null)
  assert.equal(parseNfo('<?xml version="1.0"?>'), null)
})

test('A SCENE RELEASE .nfo IS NOT METADATA, and must not be read as any', () => {
  // The `.nfo` extension predates Kodi by decades: it was, and still is, a release
  // group's ASCII-art readme. Six of the 346 sidecars in the real library are these,
  // sitting in season folders under names like `Season 1 i.nfo` where a metadata
  // reader would absolutely go looking.
  //
  // Refusing them is the whole behaviour. There is nothing to salvage, and a reader
  // that scraped a title out of the ASCII art would file an episode under a banner.
  const scene = '\uFEFFUploaded and Encoded by: https://kat.cr/user/ImEverlasting/\r\n' +
    'Source: Parks.and.Recreation.S01.1080p.WEB-DL.DD5.1.H.264-TvT (5.01 GBs)\r\n\r\n' +
    '-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-\r\n' +
    '      _________ __                __________.__\r\n' +
    '     /   _____//  |______  ___  __\\_____   \\__|\r\n'

  assert.equal(parseNfo(scene), null)
  assert.equal(detectKind(scene), null)
})

// --- merging ----------------------------------------------------------------

test('THE SIDECAR WINS, which is the whole sidecar-first rule', () => {
  // The filename parser refuses to guess a year from `King Kong.mkv`. The sidecar
  // knows it.
  const fromName = { type: 'movie', title: 'King Kong', year: null }
  const merged = applyNfo(fromName, parseNfo(MOVIE))

  assert.equal(merged.year, 2005)
  assert.equal(merged.runtime, 187 * 60)
  assert.deepEqual(merged.genres, ['Adventure', 'Drama', 'Action'])
  assert.match(merged.overview, /^In 1933/)
})

test('a missing sidecar field falls back rather than blanking what the name knew', () => {
  const fromName = { type: 'movie', title: 'Blade Runner 2049', year: null }
  const merged = applyNfo(fromName, parseNfo('<movie><plot>Something.</plot></movie>'))
  assert.equal(merged.title, 'Blade Runner 2049', 'the filename title survives')
  assert.equal(merged.overview, 'Something.')
})

test('no sidecar at all leaves the parsed name untouched', () => {
  const fromName = { type: 'movie', title: 'Deadpool', year: null }
  assert.equal(applyNfo(fromName, null), fromName)
})

test('AN EPISODE KEEPS ITS FILENAME NUMBERING when the sidecar omits it', () => {
  // Plenty of real .nfo files carry no <season>/<episode>, and a null would unfile
  // the episode entirely.
  const fromName = { type: 'episode', title: 'x', season: 5, episode: 11, loose: false }
  const merged = applyNfo(fromName, parseNfo('<episodedetails><title>The Gunslinger</title></episodedetails>'))
  assert.equal(merged.season, 5)
  assert.equal(merged.episode, 11)
  assert.equal(merged.title, 'The Gunslinger')
})

test('a sidecar that DOES carry numbering overrules an inferred one', () => {
  // The MST3K case: the filename says K05 and nothing can be inferred, but the
  // sidecar beside it knows exactly which episode this is.
  const guessed = { type: 'episode', title: null, season: 1, episode: 5, loose: true }
  const merged = applyNfo(guessed, parseNfo(EPISODE))
  assert.equal(merged.season, 2)
  assert.equal(merged.episode, 1)
  assert.equal(merged.loose, false, 'no longer a guess')
})
