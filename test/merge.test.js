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
