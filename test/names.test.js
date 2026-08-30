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
    { type: 'movie', title: '2001 A Space Odyssey', year: null, part: null })

  assert.deepEqual(names.parseMovie('Blade Runner 2049.mkv'),
    { type: 'movie', title: 'Blade Runner 2049', year: null, part: null })

  assert.deepEqual(names.parseMovie('300.mkv'),
    { type: 'movie', title: '300', year: null, part: null })

  // Reporting no year is the RIGHT answer here, not a shortfall. A sidecar .nfo
  // settles it properly, and "Blade Runner" for Blade Runner 2049 is a wrong
  // library rather than an incomplete one.
})

test('a year counts when something CONFIRMS it', () => {
  // Parenthesised: unambiguous.
  assert.deepEqual(names.parseMovie('Ghostbusters (1984).mkv'),
    { type: 'movie', title: 'Ghostbusters', year: 1984, part: null })

  // Followed by a release tag: nobody writes "1080p" after a title word.
  assert.deepEqual(names.parseMovie('Blade.1998.1080p.BluRay.x265-RARBG.mp4'),
    { type: 'movie', title: 'Blade', year: 1998, part: null })

  assert.deepEqual(names.parseMovie('Despicable.Me.2.2013.1080p.BluRay.x264.YIFY.mp4'),
    { type: 'movie', title: 'Despicable Me 2', year: 2013, part: null })

  assert.deepEqual(names.parseMovie('Despicable Me 3 2017 1080p BluRay REMUX AVC DTS-X 7 1-FGT.mkv'),
    { type: 'movie', title: 'Despicable Me 3', year: 2017, part: null })

  assert.deepEqual(names.parseMovie('The Shining 1980 REMASTERED 1080p BluRay HEVC x265 5.1 BONE.mkv'),
    { type: 'movie', title: 'The Shining', year: 1980, part: null })
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

test('THE HALF OF A FILM THE FILENAME KNOWS AND A DATABASE DOES NOT', () => {
  // Tim's real pair, and the reason any of this exists: both files enrich to the same
  // TMDB record, so the filename is the only thing that ever says which half is which.
  assert.equal(names.parseMovie('The Two Towers (ext ) - Pt 1.mkv').part, 1)
  assert.equal(names.parseMovie('The Two Towers (ext ) - Pt 2.mkv').part, 2)

  // The other spellings people use, and what is left of the title once the marker is
  // taken out of it.
  for (const [file, title, part] of [
    ['The Lord of the Rings The Two Towers (2002) - Pt 2.mkv', 'The Lord of the Rings The Two Towers', 2],
    ['Gone with the Wind (1939) CD1.avi', 'Gone with the Wind', 1],
    ['Gone.with.the.Wind.1939.1080p.BluRay.part2.mkv', 'Gone with the Wind', 2],
    ['Fanny and Alexander (Part 1).mkv', 'Fanny and Alexander', 1],
    ['Das Boot - disc 2.mkv', 'Das Boot', 2],
    // The marker survives release tags sitting after it, because it usually does.
    ['Gone with the Wind (1939) CD2 1080p BluRay x265-RARBG.mkv', 'Gone with the Wind', 2]
  ]) {
    const out = names.parseMovie(file)
    assert.equal(out.part, part, file)
    assert.equal(out.title, title, file)
  }
})

test('A NUMBER IN SOMEBODY\'S TITLE IS NOT A HALF, WHICH IS THE EXPENSIVE MISTAKE', () => {
  // Deleting a number that was part of a real title is a worse bug than the one the
  // part marker fixes, so every one of these has to come back untouched.
  for (const [file, title] of [
    // Spelled out. `Dune - Part Two` is a film.
    ['Dune - Part Two.mkv', 'Dune - Part Two'],
    // The marker is not at the end - the year is after it, so `Part 1` is the title's.
    ['Harry Potter and the Deathly Hallows Part 1 (2010).mkv', 'Harry Potter and the Deathly Hallows Part 1'],
    // A bare space in front of `Part` is how titles are written, not how appendices are.
    ['Kill Bill Part 2.mkv', 'Kill Bill Part 2'],
    ['Nymphomaniac Vol. 1.mkv', 'Nymphomaniac Vol. 1'],
    ['Deadpool 2.mkv', 'Deadpool 2']
  ]) {
    const out = names.parseMovie(file)
    assert.equal(out.part, null, file)
    assert.equal(out.title, title, `${file} keeps its own words`)
  }
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

test('A DECLARED TELEVISION ROOT IS THE OTHER WAY OF SAYING "this is a show"', () => {
  // The loose fallback is guarded on the caller already knowing this is television.
  // A series folder is one way to know it; a root the operator typed as shows is the
  // other, and it is the only one available for a file sitting directly in that root.
  assert.equal(names.parseEpisode('Some Show Part 2.mkv'), null)
  const e = names.parseEpisode('Some Show Part 2.mkv', { television: true })
  assert.equal(e.season, 1)
  assert.equal(e.episode, 2)
  assert.equal(e.loose, true)
})

// --- what a root holds -------------------------------------------------------

test('a folder called TV Shows is not a guess, it is what somebody wrote on the front', () => {
  for (const name of ['Movies', 'movies', 'Films', 'film', 'Cinema']) {
    assert.equal(names.rootTypeFromName(name), 'movies', name)
  }
  for (const name of ['TV Shows', 'tvshows', 'TV', 'Series', 'Television', 'Shows']) {
    assert.equal(names.rootTypeFromName(name), 'shows', name)
  }
})

test('it reads the LAST segment, because a root is a path', () => {
  assert.equal(names.rootTypeFromName('/library/Elements (3)/Video/TV Shows'), 'shows')
  assert.equal(names.rootTypeFromName('/mnt/Movies/'), 'movies')
})

test('DELIBERATELY NARROW: a name that says nothing gets no type', () => {
  // A folder called `Video` holding somebody's phone recordings is not a film
  // library, and a folder called `Media` says nothing at all. Guessing at these
  // would silently reclassify a library on the strength of a generic word.
  for (const name of ['Video', 'Media', 'Downloads', 'Elements (3)', 'Stuff', '', null]) {
    assert.equal(names.rootTypeFromName(name), null, String(name))
  }
})

// A USER'S 17,000-FILE LIBRARY, 2026-08-30. They diffed their whole disk against the
// host's scan record and sent the result: 8,183 of 15,603 episodes (52%) were indexed
// with no season or episode number at all - One Piece 1,284, Pokemon 1,213, Detective
// Conan 672. Every shape below is theirs, verbatim. Re-running the fixed parser over
// their 8,183 rows recovers 5,159 of them (63%).

test('A BARE E01 IS EPISODE ONE, not an unnumbered file', () => {
  const r = names.parseEpisode('Confidence.Man.JP.E01.720p-[KoreanDramaX.me].mkv', {
    seriesFolder: 'The Confidence Man JP (2018)', television: true
  })
  assert.equal(r.season, 1, 'no season in the name means the folder\'s, or one')
  assert.equal(r.episode, 1)
  // The season folder still wins where there is one.
  const s2 = names.parseEpisode('Show.E04.mkv', { seriesFolder: 'Show', seasonFolder: 'Season 2', television: true })
  assert.equal(s2.season, 2)
  assert.equal(s2.episode, 4)
  // And a release tag that merely contains an e-and-digits is not an episode.
  assert.equal(names.parseEpisode('Film.2019.1080p.x264-E5.mkv', { television: true })?.episode, undefined)
})

test('ABSOLUTE NUMBERING IS AN EPISODE NUMBER: the anime half of the library', () => {
  const cases = [
    ['Great_Teacher_Onizuka_01.mp4', 'Great Teacher Onizuka (1998)', 1],
    ['One Piece - 0001.mkv', 'One Piece', 1],
    ['Pokemon 001.mkv', 'Pokemon', 1],
    ['[HorribleSubs] Naruto Shippuden - 500 [1080p].mkv', 'Naruto Shippuden', 500],
    // The number sits after the title, and the fansub tail after it is unreadable
    // noise this parser deliberately never has to understand.
    ['Mobile Fighter G Gundam (1994) - 07 VOSTFR BDrip 1080p FLAC x265 v2-GundamGuy.mkv', 'Mobile Fighter G Gundam (1994)', 7]
  ]
  for (const [file, folder, episode] of cases) {
    const r = names.parseEpisode(file, { seriesFolder: folder, television: true })
    assert.ok(r, file + ' should parse')
    assert.equal(r.episode, episode, file)
    assert.equal(r.season, 1, file + ' has no season, so it is one')
  }
})

test('A YEAR IS NOT AN EPISODE, and a film in an auto root is not an episode at all', () => {
  // Under a declared shows root a trailing year is skipped, not taken.
  assert.equal(names.parseEpisode('Firefly 2002 1080p BluRay.mkv', { seriesFolder: 'Firefly', television: true }), null)
  // THE GUARD THAT MATTERS. Absolute numbering runs ONLY where the operator declared
  // television. A folder is not a promise: these are films, and reading the number in
  // their titles as an episode would be the worst kind of wrong.
  for (const [file, folder] of [['Blade 2 (2002).mkv', 'Blade 2 (2002)'], ["Ocean's 11 (2001).mkv", "Ocean's 11 (2001)"], ['Apollo 13.mkv', 'Apollo 13']]) {
    assert.equal(names.parseEpisode(file, { seriesFolder: folder, television: false }), null, file + ' is a film')
  }
})

test('a fansub version suffix and a glued series abbreviation still carry a code', () => {
  // 27 Bleach files: S17E14v2, a re-release. The v2 broke the word boundary.
  const b = names.parseEpisode('[Judas] Bleach - Thousand Year Blood War - S17E14v2.mkv', { television: true })
  assert.equal(b.season, 17)
  assert.equal(b.episode, 14)
  // 251 Godzilla Island files: GI01x01, the series' initials glued to the code.
  const g = names.parseEpisode('GI01x01 - Mecha-King Ghidorah.mkv', { seriesFolder: 'Godzilla Island', television: true })
  assert.equal(g.season, 1)
  assert.equal(g.episode, 1)
})

test('a bracketed number is the episode where the tail is all brackets', () => {
  const r = names.parseEpisode('[DBD-Raws][Boku no Hero Academia S6][12][1080P][BDRip][HEVC-10bit][FLAC].mkv', { television: true })
  assert.ok(r, 'the bracketed release shape parses')
  assert.equal(r.episode, 12)
})
