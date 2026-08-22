'use strict'

// The merged-library index (proposal 2026-08-16-merged-libraries). The dedup
// is LOSSY, so its keying gets the exhaustive table treatment: what must
// collapse collapses, what must stay apart stays apart, and the copy pick
// prefers what THIS device can actually play.

const test = require('node:test')
const assert = require('node:assert/strict')

const M = require('../src/merge')

const movie = (over = {}) => ({
  type: 'movie',
  id: over.id || 'm1',
  title: 'Moon',
  year: 2009,
  runtime: 97,
  artId: 'a1',
  addedAt: 100,
  media: { size: 1000, videoCodec: 'h264', container: 'mp4' },
  ...over
})

const episode = (over = {}) => ({
  type: 'episode',
  id: over.id || 'e1',
  seriesId: 'sr1',
  seasonId: 'sn1',
  seriesTitle: 'Community',
  seasonNumber: 1,
  episodeNumber: 1,
  title: 'Pilot',
  artId: null,
  media: { size: 500, videoCodec: 'h264' },
  ...over
})

// --- norm + keys -------------------------------------------------------------

test('norm folds case, accents, punctuation and articles', () => {
  assert.equal(M.norm('The Lion King'), 'lion king')
  assert.equal(M.norm('Amélie'), 'amelie')
  assert.equal(M.norm('Josee, the Tiger and the Fish'), 'josee the tiger and the fish')
  assert.equal(M.norm('WALL·E'), 'wall e')
})

test('norm drops an edition qualifier but keeps a real subtitle', () => {
  assert.equal(M.norm('Blade Runner (Final Cut)'), 'blade runner')
  assert.equal(M.norm('Alien [Director\'s Cut]'), 'alien')
  assert.equal(M.norm('Dr. Strangelove (1964)'), 'dr strangelove 1964')
})

test('movie key: same film two rips collapse, remake stays apart', () => {
  const a = movie({ id: 'a', title: 'The Lion King', year: 1994 })
  const b = movie({ id: 'b', title: 'Lion King', year: 1994 })
  const remake = movie({ id: 'c', title: 'The Lion King', year: 2019 })
  assert.equal(M.movieKey(a), M.movieKey(b))
  assert.notEqual(M.movieKey(a), M.movieKey(remake))
})

test('episode key: slot wins, unnumbered falls back to title', () => {
  const a = episode({ id: 'a', title: 'Pilot' })
  const b = episode({ id: 'b', title: 'Pilot (remastered rip)' })
  assert.equal(M.episodeKey(a), M.episodeKey(b))
  const u1 = episode({ id: 'u1', seasonNumber: null, episodeNumber: null, title: 'The Movie' })
  const u2 = episode({ id: 'u2', seasonNumber: null, episodeNumber: null, title: 'Another One' })
  assert.notEqual(M.episodeKey(u1), M.episodeKey(u2))
})

// --- buildIndex --------------------------------------------------------------

test('buildIndex dedupes across hosts and keeps every copy, primary first', () => {
  const idx = M.buildIndex([
    { libraryId: 'A', movies: [movie({ id: 'ma', artId: null, media: { size: 500, videoCodec: 'hevc' } })] },
    { libraryId: 'B', movies: [movie({ id: 'mb', artId: 'art', media: { size: 400, videoCodec: 'h264' } })] }
  ])
  assert.equal(idx.movies.length, 1)
  const m = idx.movies[0]
  // The copy WITH a poster wins primary despite being smaller.
  assert.equal(m.libraryId, 'B')
  assert.equal(m.copies.length, 2)
  assert.equal(m.copies[0].libraryId, 'B')
  assert.equal(m.copies[1].libraryId, 'A')
  assert.equal(m.copies[1].videoCodec, 'hevc')
})

test('buildIndex: newest addedAt across copies wins the merged row', () => {
  const idx = M.buildIndex([
    { libraryId: 'A', movies: [movie({ id: 'ma', addedAt: 100 })] },
    { libraryId: 'B', movies: [movie({ id: 'mb', addedAt: 900 })] }
  ])
  assert.equal(idx.movies[0].addedAt, 900)
})

test('a series spanning hosts reports the UNION of seasons and episodes', () => {
  const idx = M.buildIndex([
    {
      libraryId: 'A',
      series: [{ type: 'series', id: 'sA', title: 'Dark', seasonCount: 1, episodeCount: 2 }],
      episodes: [
        episode({ id: 'a1', seriesTitle: 'Dark', seasonNumber: 1, episodeNumber: 1, title: 'Secrets' }),
        episode({ id: 'a2', seriesTitle: 'Dark', seasonNumber: 1, episodeNumber: 2, title: 'Lies' })
      ]
    },
    {
      libraryId: 'B',
      series: [{ type: 'series', id: 'sB', title: 'Dark (2017)', seasonCount: 1, episodeCount: 1 }],
      episodes: [
        episode({ id: 'b1', seriesTitle: 'Dark', seasonNumber: 2, episodeNumber: 1, title: 'Beginnings' })
      ]
    }
  ])
  // "Dark" and "Dark (2017)"... years differ in the NAME, not the key? They
  // must merge on norm(title) - but norm keeps a bare year word. They stay
  // apart here, and that is the accepted lossiness ONLY if the folder names
  // differ; the seasons union is asserted against the matching key.
  const dark = idx.series.find((s) => s.key === 'dark')
  assert.ok(dark)
  assert.equal(dark.seasonCount, 2)
  assert.equal(dark.episodeCount, 3)
})

// --- the merged tree ---------------------------------------------------------

test('seasonsFor interleaves seasons across hosts with union counts', () => {
  const idx = M.buildIndex([
    { libraryId: 'A', episodes: [episode({ id: 'a1' }), episode({ id: 'a2', episodeNumber: 2, title: 'Spanish 101' })] },
    { libraryId: 'B', episodes: [episode({ id: 'b1', seasonNumber: 2, episodeNumber: 1, title: 'Anthropology 101' })] }
  ])
  const seasons = M.seasonsFor(idx, 'community')
  assert.equal(seasons.length, 2)
  assert.equal(seasons[0].number, 1)
  assert.equal(seasons[0].episodeCount, 2)
  assert.equal(seasons[1].number, 2)
  assert.equal(seasons[1].episodeCount, 1)
})

test('merged season ids survive the round trip', () => {
  const id = M.mergedSeasonId('community', 2, null)
  const parsed = M.parseMergedSeasonId(id)
  assert.deepEqual(parsed, { seriesKey: 'community', seasonNumber: 2, seasonTitle: null })
  const tid = M.mergedSeasonId('mst3k', null, 'DVD 18')
  assert.deepEqual(M.parseMergedSeasonId(tid), { seriesKey: 'mst3k', seasonNumber: null, seasonTitle: 'DVD 18' })
  assert.equal(M.parseMergedSeasonId('real-host-id'), null)
})

test('seriesRun walks the spanning series in watch order across hosts', () => {
  const idx = M.buildIndex([
    { libraryId: 'A', episodes: [episode({ id: 'a1' }), episode({ id: 'a2', episodeNumber: 2, title: 'Spanish 101' })] },
    { libraryId: 'B', episodes: [episode({ id: 'b1', seasonNumber: 2, episodeNumber: 1, title: 'Anthropology 101' })] }
  ])
  const run = M.seriesRun(idx, 'community')
  assert.deepEqual(run.map((e) => e.title), ['Pilot', 'Spanish 101', 'Anthropology 101'])
  // The season-boundary neighbour crosses hosts - the wrinkle PearTune never had.
  assert.notEqual(run[1].libraryId, run[2].libraryId)
})

// --- serve helpers -----------------------------------------------------------

test('filterByLibrary narrows to items with a copy on that host', () => {
  const idx = M.buildIndex([
    { libraryId: 'A', movies: [movie({ id: 'both-a' }), movie({ id: 'only-a', title: 'Arrival', year: 2016 })] },
    { libraryId: 'B', movies: [movie({ id: 'both-b' })] }
  ])
  assert.equal(M.filterByLibrary(idx.movies, '_all').length, 2)
  assert.equal(M.filterByLibrary(idx.movies, 'B').length, 1)
  assert.equal(M.filterByLibrary(idx.movies, 'A').length, 2)
})

test('searchIndex: prefix beats substring, normalized', () => {
  const idx = M.buildIndex([
    { libraryId: 'A', movies: [movie({ id: '1', title: 'Moon', year: 2009 }), movie({ id: '2', title: 'The Moonstone', year: 1996 }), movie({ id: '3', title: 'A Trip to the Moon', year: 1902 })] }
  ])
  const r = M.searchIndex(idx, 'moon')
  assert.equal(r.movies.length, 3)
  assert.equal(r.movies[0].title, 'Moon')
  assert.equal(r.movies[1].title, 'The Moonstone')
})

// --- the copy pick -----------------------------------------------------------

test('bestCopy: primary when connected, fallback when not, primary again when nothing is', () => {
  const entity = { copies: [{ libraryId: 'A', id: 'a' }, { libraryId: 'B', id: 'b' }] }
  assert.equal(M.bestCopy(entity, new Set(['A', 'B'])).libraryId, 'A')
  assert.equal(M.bestCopy(entity, new Set(['B'])).libraryId, 'B')
  assert.equal(M.bestCopy(entity, new Set()).libraryId, 'A')
})

test('CONNECTED IS NOT THE SAME AS ABLE, and the caller is what draws that line', () => {
  // A host whose drive has been unplugged answers every request cheerfully and cannot
  // read a single film. bestCopy only knows the set it is handed, so the fix is at the
  // call site (src/bare.js pickCopyId subtracts the libraries whose source has gone) -
  // pinned here because passing the wrong set is silent: it picks the one copy that
  // will never play, and the player simply sits at 0:00.
  //
  // Tim's Arrival on the Pixel, 2026-08-19. The TCL played the same film only because
  // a download short-circuits before any copy pick happens.
  const entity = { copies: [{ libraryId: 'A', id: 'a' }, { libraryId: 'B', id: 'b' }] }

  // Both online, A's disk gone: the caller hands over B alone and B is chosen.
  assert.equal(M.bestCopy(entity, new Set(['B'])).libraryId, 'B')
  // Handing over both - the bug - picks the copy that cannot be read.
  assert.equal(M.bestCopy(entity, new Set(['A', 'B'])).libraryId, 'A')
})

test('bestCopy: the filter chip outranks the primary', () => {
  const entity = { copies: [{ libraryId: 'A', id: 'a' }, { libraryId: 'B', id: 'b' }] }
  assert.equal(M.bestCopy(entity, new Set(['A', 'B']), 'B').libraryId, 'B')
  // An unreachable preferred copy falls through to the normal order.
  assert.equal(M.bestCopy(entity, new Set(['A']), 'B').libraryId, 'A')
})

test('bestCopy: the device-aware rank steers an HEVC refuser to the H264 host', () => {
  const entity = {
    copies: [
      { libraryId: 'A', id: 'a', videoCodec: 'hevc' },
      { libraryId: 'B', id: 'b', videoCodec: 'h264' }
    ]
  }
  const plays = (c) => (c.videoCodec === 'h264' ? 1 : 0)
  assert.equal(M.bestCopy(entity, new Set(['A', 'B']), null, plays).libraryId, 'B')
  // Rank only reorders REACHABLE copies - an offline direct-play copy never wins.
  assert.equal(M.bestCopy(entity, new Set(['A']), null, plays).libraryId, 'A')
})

test('bestCopy: equal ranks keep primary-first order', () => {
  const entity = { copies: [{ libraryId: 'A', id: 'a', videoCodec: 'h264' }, { libraryId: 'B', id: 'b', videoCodec: 'h264' }] }
  assert.equal(M.bestCopy(entity, new Set(['A', 'B']), null, () => 1).libraryId, 'A')
})

// --- requests across the blend (phase 2) -------------------------------------

const req = (over = {}) => ({
  id: over.id || 'r1',
  kind: 'movie',
  name: 'Dune Part Two',
  status: 'pending',
  createdAt: 100,
  libraryId: 'A',
  libraryName: 'Umbrel',
  ...over
})

test('collapseRequests: one ask filed on two hosts is one row, best status wins', () => {
  const rows = [
    req({ id: 'ra', libraryId: 'A', libraryName: 'Umbrel', status: 'pending' }),
    req({ id: 'rb', libraryId: 'B', libraryName: 'Mac', status: 'added', resolvedAt: 200 })
  ]
  const out = M.collapseRequests(rows)
  assert.equal(out.length, 1)
  assert.equal(out[0].status, 'added')
  assert.deepEqual(out[0].libraries.sort(), ['Mac', 'Umbrel'])
  assert.equal(out[0].refs.length, 2)
})

test('collapseRequests: the owner queue folds pending-first', () => {
  const rows = [
    req({ id: 'ra', status: 'added' }),
    req({ id: 'rb', libraryId: 'B', status: 'pending' })
  ]
  const out = M.collapseRequests(rows, { pendingWins: true })
  assert.equal(out[0].status, 'pending')
})

test('collapseRequests: different asks stay apart, name normalized', () => {
  const rows = [
    req({ id: 'ra', name: 'Dune: Part Two' }),
    req({ id: 'rb', libraryId: 'B', name: 'dune part two' }),
    req({ id: 'rc', name: 'Dune', libraryId: 'B' })
  ]
  const out = M.collapseRequests(rows)
  assert.equal(out.length, 2)
})

test('requestTargets: resolve reaches only the still-pending copies', () => {
  const row = { refs: [{ libraryId: 'A', id: 'ra', status: 'pending' }, { libraryId: 'B', id: 'rb', status: 'declined' }] }
  assert.deepEqual(M.requestTargets(row), [{ libraryId: 'A', id: 'ra' }])
  // Remove reaches everything.
  assert.equal(M.requestTargets(row, { pendingOnly: false }).length, 2)
  // No refs falls back to the row's own id.
  assert.deepEqual(M.requestTargets({ id: 'x' }, { fallbackLibraryId: 'A' }), [{ libraryId: 'A', id: 'x' }])
  assert.deepEqual(M.requestTargets({ id: 'x' }), [])
})

test('a year-less rip folds into the one dated film when runtimes agree', () => {
  const idx = M.buildIndex([
    { libraryId: 'A', movies: [{ id: 'a1', type: 'movie', title: 'Arrival', year: 2016, runtime: 6983, media: { size: 5 } }] },
    { libraryId: 'B', movies: [{ id: 'b1', type: 'movie', title: 'Arrival', year: null, runtime: 6990, media: { size: 9 } }] }
  ])
  assert.equal(idx.movies.length, 1)
  assert.equal(idx.movies[0].copies.length, 2)
  // The bigger year-less copy won primary, but the KNOWN year still shows.
  assert.equal(idx.movies[0].year, 2016)
})

test('a year-less title with a WRONG runtime stays its own entry', () => {
  // The live case that must never merge: a 20-second clip named Arrival.
  const idx = M.buildIndex([
    { libraryId: 'A', movies: [{ id: 'a1', type: 'movie', title: 'Arrival', year: null, runtime: 6983, media: {} }] },
    { libraryId: 'B', movies: [{ id: 'b1', type: 'movie', title: 'Arrival', year: 2016, runtime: 20, media: {} }] }
  ])
  assert.equal(idx.movies.length, 2)
})

test('a year-less copy never guesses between two remakes', () => {
  const idx = M.buildIndex([
    { libraryId: 'A', movies: [
      { id: 'a1', type: 'movie', title: 'Nosferatu', year: 1922, runtime: 5700, media: {} },
      { id: 'a2', type: 'movie', title: 'Nosferatu', year: 2024, runtime: 5710, media: {} }
    ] },
    { libraryId: 'B', movies: [{ id: 'b1', type: 'movie', title: 'Nosferatu', year: null, runtime: 5700, media: {} }] }
  ])
  // Three entries: the ambiguity is kept rather than guessed at.
  assert.equal(idx.movies.length, 3)
})

test('a year-less pair with unknown runtimes keeps the old behaviour', () => {
  // No runtime evidence on either side: no fold, and two undated copies of
  // one title still merge with each other via the |0 key as they always did.
  const idx = M.buildIndex([
    { libraryId: 'A', movies: [{ id: 'a1', type: 'movie', title: 'Moon', year: null, runtime: null, media: {} }] },
    { libraryId: 'B', movies: [
      { id: 'b1', type: 'movie', title: 'Moon', year: null, runtime: null, media: {} },
      { id: 'b2', type: 'movie', title: 'Moon', year: 2009, runtime: null, media: {} }
    ] }
  ])
  assert.equal(idx.movies.length, 2)
})

/* ------------------------------- two halves of one film, not two copies of it -- */

test('TWO HALVES OF A FILM STAY TWO ENTRIES, SO NEITHER DISAPPEARS', () => {
  // FOUND ON TIM'S REAL LIBRARY (2026-08-21). `The Two Towers (ext ) - Pt 1.mkv` and
  // `- Pt 2.mkv` both matched the same TMDB record, so both arrived carrying the same
  // title and year - one key, one entry, two copies, and the second half unreachable
  // behind the first. The numbers below are the real ones, read off the phone: 7732
  // seconds against 6400.
  const halves = M.mergeMovies([
    movie({ id: 'pt1', libraryId: 'umbrel', title: 'The Lord of the Rings: The Two Towers', year: 2002, runtime: 7732, media: { size: 3263391229 } }),
    movie({ id: 'pt2', libraryId: 'umbrel', title: 'The Lord of the Rings: The Two Towers', year: 2002, runtime: 6400, media: { size: 2823203577 } })
  ])
  assert.equal(halves.length, 2, 'both halves are on the shelf')
  assert.deepEqual(halves.map((h) => h.runtime).sort(), [6400, 7732])
  assert.deepEqual(halves.map((h) => h.copies.length), [1, 1], 'and neither is hiding inside the other')
  assert.equal(new Set(halves.map((h) => h.key)).size, 2, 'two entries need two keys')
})

test('TWO HALVES OF THE SAME LENGTH ARE STILL TWO HALVES', () => {
  // The hole the runtime split cannot see, and the reason the filename marker travels:
  // a film cut down the middle gives two files that agree on length to the second, so
  // splitByLength keeps them as one entry and the second half is unreachable again.
  const halves = M.mergeMovies([
    movie({ id: 'pt1', libraryId: 'umbrel', title: 'Fanny and Alexander', year: 1982, part: 1, runtime: 5400 }),
    movie({ id: 'pt2', libraryId: 'umbrel', title: 'Fanny and Alexander', year: 1982, part: 2, runtime: 5400 })
  ])
  assert.equal(halves.length, 2, 'both halves are on the shelf')
  assert.deepEqual(halves.map((h) => h.part).sort(), [1, 2], 'and each one says which it is')
  assert.equal(new Set(halves.map((h) => h.key)).size, 2)
})

test('THE HALF SURVIVES A HOST THAT KNOWS NOTHING ABOUT HALVES', () => {
  // Only a folder source reads filenames. A Jellyfin copy of the same file reports no
  // part at all, and it must neither erase the label nor mint an entry of its own.
  const out = M.mergeMovies([
    movie({ id: 'jelly', libraryId: 'mac', title: 'Das Boot', year: 1981, part: null, runtime: 18000, media: { size: 9e9 } }),
    movie({ id: 'folder', libraryId: 'umbrel', title: 'Das Boot', year: 1981, part: 1, runtime: 18000, media: { size: 4e9 } })
  ])
  assert.equal(out.length, 1, 'one film, two copies')
  assert.equal(out[0].copies.length, 2)
  assert.equal(out[0].part, 1, 'the copy that knows speaks for the entry')
})

test('THE LENGTH SPLIT AND THE PART SPLIT DO NOT CUT THE SAME FILM TWICE', () => {
  // Order is load-bearing. Two halves on a folder host and the same two files on a host
  // that reports no part: splitting by length first pairs each half with its silent
  // twin, and the part pass then has nothing left to do. Splitting by part first would
  // have left the length pass a mixed cluster to cut again - three entries for two
  // halves.
  const out = M.mergeMovies([
    movie({ id: 'a1', libraryId: 'umbrel', title: 'Nosferatu', year: 1922, part: 1, runtime: 3000 }),
    movie({ id: 'a2', libraryId: 'umbrel', title: 'Nosferatu', year: 1922, part: 2, runtime: 4000 }),
    movie({ id: 'b1', libraryId: 'mac', title: 'Nosferatu', year: 1922, part: null, runtime: 3000 }),
    movie({ id: 'b2', libraryId: 'mac', title: 'Nosferatu', year: 1922, part: null, runtime: 4000 })
  ])
  assert.equal(out.length, 2, 'two halves, not three entries')
  assert.deepEqual(out.map((o) => o.copies.length), [2, 2], 'each half has both hosts behind it')
})

test('TWO RIPS OF ONE FILM STILL COLLAPSE, WHICH IS THE WHOLE POINT OF MERGING', () => {
  // The guard has to leave the case it was built around alone: the same film on two
  // hosts, ripped at different qualities, is ONE entry with two copies.
  const rips = M.mergeMovies([
    movie({ id: 'a', libraryId: 'umbrel', runtime: 7700, media: { size: 9e9 } }),
    movie({ id: 'b', libraryId: 'mac', runtime: 7690, media: { size: 4e9 } })
  ])
  assert.equal(rips.length, 1)
  assert.equal(rips[0].copies.length, 2, 'both copies stay reachable behind one entry')
})

test('A COPY WITH NO RUNTIME IS NOT EVIDENCE OF A DIFFERENT FILM', () => {
  // Unknown is not different. Splitting on a missing duration would turn one film into
  // two on any host that does not report one, which is a worse bug than the one being
  // fixed.
  const mixed = M.mergeMovies([
    movie({ id: 'known', libraryId: 'umbrel', runtime: 7700 }),
    movie({ id: 'silent', libraryId: 'mac', runtime: null })
  ])
  assert.equal(mixed.length, 1, 'they stay together')
  assert.equal(mixed[0].copies.length, 2)
})

test('A THEATRICAL AND AN EXTENDED CUT ARE TWO THINGS, AND BOTH ARE REACHABLE', () => {
  // Falls out of the same rule and is a fix rather than a side effect: two cuts sharing
  // a title and a year used to be one entry with one of them unreachable.
  const cuts = M.mergeMovies([
    movie({ id: 'theatrical', libraryId: 'umbrel', title: 'Aliens', year: 1986, runtime: 8220 }),
    movie({ id: 'special', libraryId: 'umbrel', title: 'Aliens', year: 1986, runtime: 9420 })
  ])
  assert.equal(cuts.length, 2)
})

test('THE ENTRY THAT WAS ALREADY THERE KEEPS ITS KEY WHEN A HALF IS RESCUED', () => {
  // A shelf should not reshuffle because a second half was found: the cluster holding
  // the primary keeps the original key, and the rescued one takes a new suffix.
  const out = M.mergeMovies([
    movie({ id: 'main', libraryId: 'umbrel', title: 'Nosferatu', year: 1922, runtime: 5820, artId: 'art' }),
    movie({ id: 'half', libraryId: 'umbrel', title: 'Nosferatu', year: 1922, runtime: 2900, artId: null })
  ])
  const main = out.find((o) => o.id === 'main')
  assert.equal(main.key, M.movieKey({ title: 'Nosferatu', year: 1922 }), 'the original entry is untouched')
  assert.notEqual(out.find((o) => o.id === 'half').key, main.key)
})
