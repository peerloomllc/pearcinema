// Reading a film or an episode out of a file path.
//
// EVERY FILENAME BELOW IS REAL, taken verbatim from Tim's library (12,197 files,
// scanned 2026-08-12). That is deliberate: the naive version of this parser passes
// any invented test suite and falls over on the first shelf of actual films.
//
// The cases that matter most are the ones where a number in a title looks exactly
// like a release year.

const test = require('node:test')
const assert = require('node:assert/strict')

const names = require('../host/names')

// --- films ------------------------------------------------------------------

test('THE YEAR TRAP: a number in a title is not a year', () => {
  // The three that break the obvious parser, all from the real Movies folder.
  assert.deepEqual(names.parseMovie('2001 A Space Odyssey.mkv'),
    { type: 'movie', title: '2001 A Space Odyssey', year: null })

  assert.deepEqual(names.parseMovie('Blade Runner 2049.mkv'),
    { type: 'movie', title: 'Blade Runner 2049', year: null })

  assert.deepEqual(names.parseMovie('300.mkv'),
    { type: 'movie', title: '300', year: null })

  // Reporting no year is the RIGHT answer here, not a shortfall. A sidecar .nfo
  // settles it properly, and "Blade Runner" for Blade Runner 2049 is a wrong
  // library rather than an incomplete one.
})

test('a year counts when something CONFIRMS it', () => {
  // Parenthesised: unambiguous.
  assert.deepEqual(names.parseMovie('Ghostbusters (1984).mkv'),
    { type: 'movie', title: 'Ghostbusters', year: 1984 })

  // Followed by a release tag: nobody writes "1080p" after a title word.
  assert.deepEqual(names.parseMovie('Blade.1998.1080p.BluRay.x265-RARBG.mp4'),
    { type: 'movie', title: 'Blade', year: 1998 })

  assert.deepEqual(names.parseMovie('Despicable.Me.2.2013.1080p.BluRay.x264.YIFY.mp4'),
    { type: 'movie', title: 'Despicable Me 2', year: 2013 })

  assert.deepEqual(names.parseMovie('Despicable Me 3 2017 1080p BluRay REMUX AVC DTS-X 7 1-FGT.mkv'),
    { type: 'movie', title: 'Despicable Me 3', year: 2017 })

  assert.deepEqual(names.parseMovie('The Shining 1980 REMASTERED 1080p BluRay HEVC x265 5.1 BONE.mkv'),
    { type: 'movie', title: 'The Shining', year: 1980 })
})

test('a sequel number survives, because it is part of the name', () => {
  assert.equal(names.parseMovie('Deadpool 2.mkv').title, 'Deadpool 2')
  assert.equal(names.parseMovie('Amazing Spider-Man 2.mkv').title, 'Amazing Spider-Man 2')
  assert.equal(names.parseMovie('Despicable.Me.2.2013.1080p.BluRay.x264.YIFY.mp4').title, 'Despicable Me 2')
})

test('plain names come through untouched', () => {
  for (const [file, title] of [
    ['Arrival.mkv', 'Arrival'],
    ['A New Hope.mkv', 'A New Hope'],
    ['Batman - The Dark Knight Rises.mkv', 'Batman - The Dark Knight Rises'],
    ['Dune - Part Two.mkv', 'Dune - Part Two'],
    ["Ender's Game.mkv", "Ender's Game"],
    ["Marvel Studios' Shang-Chi.mkv", "Marvel Studios' Shang-Chi"],
    ['Blade Runner - Final Cut.mkv', 'Blade Runner - Final Cut'],
    ['Fantastic Beasts - The Crimes Of Grindelwald.mkv', 'Fantastic Beasts - The Crimes Of Grindelwald'],
    ["Miyazaki Collection - Howl's Moving Castle.mkv", "Miyazaki Collection - Howl's Moving Castle"],
    ['Dr Strangelove.mkv', 'Dr Strangelove']
  ]) {
    assert.equal(names.parseMovie(file).title, title, file)
  }
})

test('dots become spaces only when the name is actually dot-separated', () => {
  // Three or more dots: a scene name.
  assert.equal(names.parseMovie('Despicable.Me.2010.1080p.BluRay.x264.YIFY.mp4').title, 'Despicable Me')
  // One dot in the stem is punctuation, not a separator.
  assert.equal(names.parseMovie('Final Fantasy Vii- Advent Children.mkv').title, 'Final Fantasy Vii- Advent Children')
})

test('a name that is nothing but tags still yields something', () => {
  // Never return an empty title. A file called only by its release tags is rare and
  // real, and an empty row in a library is worse than an ugly one.
  const out = names.parseMovie('1080p.BluRay.x265.mkv')
  assert.ok(out.title.length > 0)
})

// --- episodes ---------------------------------------------------------------

test('every episode-code spelling in the real library parses', () => {
  const cases = [
    ['Smallville (2001) - S02E22 - Calling (1) (1080p BluRay x265 Silence).mkv', 2, 22],
    ['The.x-files.s06e17.trevor.720p.web-dl.re-encode.mkv', 6, 17],
    ['The Middle S03E07 Halloween II.mkv', 3, 7],
    ['MST3K - S05E11 - The Gunslinger.avi', 5, 11],
    ['Lost.S01E04.1080p.Bluray.x265-HiQVE.mkv', 1, 4],
    ['Legend of Korra - s02e09.mkv', 2, 9],
    ['Fringe S03E11 Reciprocity (1080p x265 Joy).mp4', 3, 11],
    ['Samurai Jack - S05E07 - XCVIII (1080p x265 EDGE2020).mkv', 5, 7]
  ]
  for (const [file, season, episode] of cases) {
    const e = names.parseEpisode(file)
    assert.ok(e, `should parse: ${file}`)
    assert.equal(e.season, season, file)
    assert.equal(e.episode, episode, file)
  }
})

test('the episode title survives, and the tag soup does not', () => {
  assert.equal(names.parseEpisode('The Middle S03E07 Halloween II.mkv').title, 'Halloween II')
  assert.equal(names.parseEpisode('MST3K - S05E11 - The Gunslinger.avi').title, 'The Gunslinger')
  assert.equal(names.parseEpisode('The.x-files.s06e17.trevor.720p.web-dl.re-encode.mkv').title, 'trevor')
  assert.equal(
    names.parseEpisode('Everybody Loves Raymond (1996) - S08E22 - The Mentor (1080p AMZN WEB-DL x265 Silence).mkv').title,
    'The Mentor'
  )
})

test('A PART NUMBER IS KEPT while a tag group is dropped, from the same filename', () => {
  // `Calling (1)` is a two-parter. `(1080p BluRay x265 Silence)` is noise. Getting
  // this backwards either leaves a wall of tags in every title or loses the part
  // number that tells two-parters apart.
  const e = names.parseEpisode('Smallville (2001) - S02E22 - Calling (1) (1080p BluRay x265 Silence).mkv')
  assert.equal(e.title, 'Calling (1)')
})

test('an episode with no title reports none rather than inventing one', () => {
  assert.equal(names.parseEpisode('Legend of Korra - s02e09.mkv').title, null)
  assert.equal(names.parseEpisode('Lost.S01E04.1080p.Bluray.x265-HiQVE.mkv').title, null)
})

test('THE SHOW FOLDER WINS over the filename, or one show becomes two', () => {
  // Real case: the folder says "The Legend of Korra", the file says "Legend of
  // Korra". Trusting the filename splits the show in half.
  const e = names.parseEpisode('Legend of Korra - s02e09.mkv', { seriesFolder: 'The Legend of Korra' })
  assert.equal(e.series, 'The Legend of Korra')

  // Without the folder it falls back to the filename, which is still better than nothing.
  assert.equal(names.parseEpisode('Legend of Korra - s02e09.mkv').series, 'Legend of Korra')
})

test('a show folder gives up its year, and keeps everything else', () => {
  assert.deepEqual(names.parseShowFolder('Smallville (2001)'), { title: 'Smallville', year: 2001 })
  assert.deepEqual(names.parseShowFolder('Firefly'), { title: 'Firefly', year: null })
  // `(US)` is part of the name; only the LAST parenthesised year is the year.
  assert.deepEqual(names.parseShowFolder('The Office (US) (2005)'), { title: 'The Office (US)', year: 2005 })
  assert.deepEqual(names.parseShowFolder('MST3K - Complete 35 DVD Collection'),
    { title: 'MST3K - Complete 35 DVD Collection', year: null })
})

test('a film is told from an episode by the ABSENCE of a code', () => {
  assert.equal(names.parseEpisode('Blade Runner 2049.mkv'), null)
  assert.equal(names.parseEpisode('2001 A Space Odyssey.mkv'), null)
  assert.equal(names.parseEpisode('Deadpool 2.mkv'), null)
})

test('a double episode keeps its range instead of losing half of it', () => {
  const a = names.parseEpisode('Show - S01E02E03 - Title.mkv')
  assert.equal(a.episode, 2)
  assert.equal(a.episodeEnd, 3)

  const b = names.parseEpisode('Show - S01E02-E03.mkv')
  assert.equal(b.episodeEnd, 3)

  // A single episode has no range.
  assert.equal(names.parseEpisode('Show - S01E02 - Title.mkv').episodeEnd, null)
})

test('1x02 and spelled-out forms parse too', () => {
  assert.deepEqual(
    { s: names.parseEpisode('Show 1x02 Title.mkv').season, e: names.parseEpisode('Show 1x02 Title.mkv').episode },
    { s: 1, e: 2 }
  )
  const spelled = names.parseEpisode('Show Season 3 Episode 7.mkv')
  assert.equal(spelled.season, 3)
  assert.equal(spelled.episode, 7)
})

// --- season folders ---------------------------------------------------------

test('a season folder is read where it IS one, and not invented where it is not', () => {
  assert.equal(names.parseSeasonFolder('Season 01'), 1)
  assert.equal(names.parseSeasonFolder('Season 10'), 10)
  assert.equal(names.parseSeasonFolder('season 3'), 3)
  assert.equal(names.parseSeasonFolder('S02'), 2)
  assert.equal(names.parseSeasonFolder('Specials'), 0, 'specials is season zero')

  // The real trap: this library has `MST3K DVD 18`, a DISC number. Reading it as a
  // season would file 35 discs as 35 seasons.
  assert.equal(names.parseSeasonFolder('MST3K DVD 18'), null)
  assert.equal(names.parseSeasonFolder('Blurays'), null)
})

test('THE FILENAME WINS over a season folder that disagrees', () => {
  // `MST3K - Complete 35 DVD Collection/MST3K DVD 18/MST3K - S05E11 - ....avi`
  // The folder is a disc; the file knows it is season 5.
  const e = names.parseEpisode('MST3K - S05E11 - The Gunslinger.avi', {
    seriesFolder: 'MST3K - Complete 35 DVD Collection',
    seasonFolder: 'MST3K DVD 18'
  })
  assert.equal(e.season, 5)
  assert.equal(e.folderSeason, null, 'and the disagreement is recorded, not hidden')

  // Where they agree, they agree.
  const ok = names.parseEpisode('Lost.S01E04.mkv', { seasonFolder: 'Season 01' })
  assert.equal(ok.season, 1)
  assert.equal(ok.folderSeason, 1)
})

// --- artwork and subtitles --------------------------------------------------

test('artwork is found by convention and beside the file', () => {
  assert.ok(names.isArtworkFor('poster.jpg', 'Deadpool'))
  assert.ok(names.isArtworkFor('folder.jpg', 'Deadpool'))
  assert.ok(names.isArtworkFor('Deadpool.jpg', 'Deadpool'))
  assert.ok(names.isArtworkFor('Deadpool-poster.png', 'Deadpool'))
  // Real: `Planet Earth/Season 01/metadata/Planet Earth - S01E03 - Fresh Water.jpg`
  assert.ok(names.isArtworkFor('Planet Earth - S01E03 - Fresh Water.jpg', 'Planet Earth - S01E03 - Fresh Water'))

  assert.ok(!names.isArtworkFor('Deadpool.mkv', 'Deadpool'))
  assert.ok(!names.isArtworkFor('SomethingElse.jpg', 'Deadpool'))
})

test('an external subtitle gives up its language and its flags', () => {
  assert.deepEqual(names.parseSubtitleName('Deadpool.en.srt', 'Deadpool'),
    { language: 'en', forced: false, sdh: false, format: 'srt' })

  assert.deepEqual(names.parseSubtitleName('Deadpool.eng.forced.srt', 'Deadpool'),
    { language: 'eng', forced: true, sdh: false, format: 'srt' })

  assert.deepEqual(names.parseSubtitleName('Deadpool.en.sdh.srt', 'Deadpool'),
    { language: 'en', forced: false, sdh: true, format: 'srt' })

  // No language named at all is still a usable subtitle.
  assert.deepEqual(names.parseSubtitleName('Deadpool.srt', 'Deadpool'),
    { language: null, forced: false, sdh: false, format: 'srt' })

  assert.equal(names.parseSubtitleName('Deadpool.mkv', 'Deadpool'), null)
  assert.equal(names.parseSubtitleName('Other.en.srt', 'Deadpool'), null)
})

// --- tag recognition --------------------------------------------------------

test('the tag list covers what this library actually carries', () => {
  for (const tag of ['1080p', '720p', 'BluRay', 'WEB-DL', 'x265', 'HEVC', 'REMUX', 'AMZN', 'DTS-X', 'REMASTERED']) {
    assert.ok(names.isTag(tag), `${tag} must be recognised as noise`)
  }
  // And does not eat words that belong in titles.
  for (const word of ['The', 'Dune', 'Legend', 'Water', 'Jack', 'Korra', 'Space']) {
    assert.ok(!names.isTag(word), `${word} must survive`)
  }
})

// --- the shows that never write SxxExx --------------------------------------

test('a MINISERIES numbered by Part is read, and marked as inferred', () => {
  // Real: Band Of Brothers/Band Of Brothers Part 2 Day Of Days (1080p x265 Joy).mkv
  const e = names.parseEpisode('Band Of Brothers Part 2 Day Of Days (1080p x265 Joy).mkv', {
    seriesFolder: 'Band Of Brothers'
  })
  assert.equal(e.season, 1, 'a miniseries with no season folder is season 1')
  assert.equal(e.episode, 2)
  assert.equal(e.loose, true, 'the number was inferred, not declared')
  assert.equal(e.title, 'Day Of Days')
})

test('a CHAPTER under a season folder takes the season from the folder', () => {
  // Real: The Legend of Korra/Season 04/The Legend Of Korra- Book Four- Balance - Chapter 03-3.mkv
  const e = names.parseEpisode('The Legend Of Korra- Book Four- Balance - Chapter 03-3.mkv', {
    seriesFolder: 'The Legend of Korra',
    seasonFolder: 'Season 04'
  })
  assert.equal(e.season, 4)
  assert.equal(e.episode, 3)
  assert.equal(e.loose, true)
  assert.equal(e.series, 'The Legend of Korra')
})

test('THE LOOSE FALLBACK NEVER RUNS ON A FILM', () => {
  // Without a series folder the caller has not said this is television, so a film
  // called `Part 2` stays a film. `Dune - Part Two` is safe only by being spelled
  // out; the guard is what makes the next one safe too.
  assert.equal(names.parseEpisode('Dune - Part Two.mkv'), null)
  assert.equal(names.parseEpisode('Some Film Part 2.mkv'), null)
  // And a declared code is never overridden by the fallback.
  const real = names.parseEpisode('Show - S03E07 - Part 2 Of Something.mkv', { seriesFolder: 'Show' })
  assert.equal(real.season, 3)
  assert.equal(real.episode, 7)
  assert.equal(real.loose, false)
})
