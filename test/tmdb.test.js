// Opt-in online artwork: the client, the caution and the cache.
//
// Everything here runs against an INJECTED fetch - no network, no key, and the
// tests assert the exact URLs that would have been asked, because "what does this
// feature tell a third party" is the privacy question and it deserves a pin.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const tmdb = require('../host/tmdb')

const POSTER_BYTES = Buffer.from('a-real-enough-jpeg')

const respond = (obj, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => obj,
  arrayBuffer: async () => POSTER_BYTES.buffer.slice(POSTER_BYTES.byteOffset, POSTER_BYTES.byteOffset + POSTER_BYTES.length)
})

// A router of URL patterns, and a log of everything asked - the log IS the
// privacy assertion.
function fakeFetch (routes) {
  const asked = []
  const f = async (url) => {
    asked.push(url)
    for (const [re, out] of routes) {
      if (re.test(url)) return typeof out === 'function' ? out(url) : out
    }
    throw new Error('unexpected fetch: ' + url)
  }
  f.asked = asked
  return f
}

async function tmpdir () {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-tmdb-'))
}

/* ---------------------------------------------------------------- the key -- */

test('both shapes of TMDB credential work without asking which one it is', async () => {
  // The short v3 key rides as a query parameter.
  const v3 = tmdb.authFor('abc123')
  assert.match(v3.query, /api_key=abc123/)
  assert.deepEqual(v3.headers, {})

  // The long v4 token is a JWT and rides as a Bearer header.
  const v4 = tmdb.authFor('eyJhbGciOi.something.signed')
  assert.equal(v4.query, '')
  assert.match(v4.headers.authorization, /^Bearer eyJ/)
})

test('the Test button asks for the one thing every valid key can read', async () => {
  const good = new tmdb.TmdbClient({
    key: 'k',
    fetch: fakeFetch([[/\/configuration/, respond({ images: {} })]])
  })
  assert.deepEqual(await good.test(), { ok: true })

  const bad = new tmdb.TmdbClient({
    key: 'nope',
    fetch: fakeFetch([[/\/configuration/, respond({}, 401)]])
  })
  const out = await bad.test()
  assert.equal(out.ok, false)
  assert.match(out.error, /did not accept/)
})

/* ------------------------------------------------------------- the search -- */

test('a film and a show ask different endpoints and come back as one shape', async () => {
  const f = fakeFetch([
    [/search\/movie/, respond({ results: [{ id: 62, title: '2001: A Space Odyssey', release_date: '1968-04-02', poster_path: '/p.jpg', overview: 'o' }] })],
    [/search\/tv/, respond({ results: [{ id: 4087, name: 'The X-Files', first_air_date: '1993-09-10', poster_path: '/x.jpg' }] })]
  ])
  const c = new tmdb.TmdbClient({ key: 'k', fetch: f })

  const film = await c.search({ type: 'movie', title: '2001 A Space Odyssey', year: 1968 })
  assert.equal(film[0].tmdbId, 62)
  assert.equal(film[0].year, 1968)

  const show = await c.search({ type: 'series', title: 'The X-Files' })
  assert.equal(show[0].tmdbId, 4087)
  assert.equal(show[0].year, 1993)

  // The privacy pin: the title and year went out, and NOTHING else about the
  // library did - no paths, no ids, no counts.
  assert.equal(f.asked.some(u => /year=1968/.test(u)), true)
  assert.equal(f.asked.some(u => /library|itemId|\/home\//.test(u)), false)
})

test('a wrong year empties the search, so it retries once without one', async () => {
  // Rips are routinely off by one. A miss for a film TMDB knows perfectly well
  // would put it in the missed pile for the sake of a metadata quibble.
  const f = fakeFetch([
    [/search\/movie.*year=1997/, respond({ results: [] })],
    [/search\/movie/, respond({ results: [{ id: 9, title: 'Contact', release_date: '1997-07-11' }] })]
  ])
  const c = new tmdb.TmdbClient({ key: 'k', fetch: f })
  const out = await c.search({ type: 'movie', title: 'Contact', year: 1997 })
  assert.equal(out.length, 1)
  assert.equal(f.asked.length, 2)
})

/* ----------------------------------------------------------- the matching -- */

test('MATCHING IS BEST-EFFORT AND HONEST ABOUT DOUBT: everything picks, only certainty says so', async () => {
  const item = { title: 'Solaris', year: 1972 }

  // Exact title, year agreeing: sure.
  const exact = tmdb.bestMatch(item, [
    { tmdbId: 1, title: 'Solaris', year: 1972 },
    { tmdbId: 2, title: 'Solaris: The Documentary', year: 2005 }
  ])
  assert.equal(exact.candidate.tmdbId, 1)
  assert.equal(exact.sure, true)

  // TWO exact matches - the remake problem. 1972 and 2002 both call themselves
  // Solaris, and with no year on the file a GUESS is still made (Tim, 2026-08-14,
  // revising the hold-it-back first cut) - but marked unsure, which is what the
  // notice and the tile's pencil key off.
  const remake = tmdb.bestMatch({ title: 'Solaris', year: null }, [
    { tmdbId: 1, title: 'Solaris', year: 1972 },
    { tmdbId: 3, title: 'Solaris', year: 2002 }
  ])
  assert.equal(remake.candidate.tmdbId, 1, 'the best guess still ships a poster')
  assert.equal(remake.sure, false, 'and admits it was a guess')

  // A lone result is safe whatever it is called.
  const lone = tmdb.bestMatch({ title: 'An Obscure Thing', year: null }, [
    { tmdbId: 7, title: 'An Obscure Thing Entirely', year: 1999 }
  ])
  assert.equal(lone.candidate.tmdbId, 7)
  assert.equal(lone.sure, true)

  // Several inexact results: TMDB's own first result, unsure.
  const inexact = tmdb.bestMatch({ title: 'Crash', year: null }, [
    { tmdbId: 1, title: 'Crash Landing', year: 2005 },
    { tmdbId: 2, title: 'The Crash', year: 2017 }
  ])
  assert.equal(inexact.candidate.tmdbId, 1)
  assert.equal(inexact.sure, false)

  // Off-by-one years still count as agreeing.
  const dune = tmdb.bestMatch({ title: 'Dune', year: 2022 }, [
    { tmdbId: 1, title: 'Dune', year: 2021 },
    { tmdbId: 2, title: 'Dune', year: 1984 }
  ])
  assert.equal(dune.candidate.tmdbId, 1)
  assert.equal(dune.sure, true)

  // Nothing found is still nothing.
  assert.equal(tmdb.bestMatch(item, []), null)
})

test('titles are compared as words, not as bytes', async () => {
  assert.equal(tmdb.normTitle('WALL·E'), tmdb.normTitle('Wall-E'))
  assert.equal(tmdb.normTitle('Amélie'), tmdb.normTitle('amelie'))
})

/* --------------------------------------------------------------- the pass -- */

// A library of one film with sidecar art, one without, one ambiguous name, and a
// show with a season of two episodes - one of which TMDB has no still for.
function fakeAdapter () {
  const movies = [
    { id: 'has-art', type: 'movie', title: 'Covered', year: 2000, artId: 'real-art' },
    { id: 'bare', type: 'movie', title: 'Uncovered', year: 2001, artId: null },
    { id: 'vague', type: 'movie', title: 'Crash', year: null, artId: null }
  ]
  const series = [{ id: 'show', type: 'series', title: 'A Show', year: null, artId: null }]
  // `number`, NOT `seasonNumber` - the real season model's field name
  // (host/items.js). The first version of this fake used the wrong name and
  // passed, while the real library skipped every season it had.
  const seasons = [{ id: 'show-s1', type: 'season', seriesId: 'show', number: 1, artId: null }]
  const episodes = [
    { id: 'show-e1', type: 'episode', seasonId: 'show-s1', episodeNumber: 1, artId: null },
    { id: 'show-e2', type: 'episode', seasonId: 'show-s1', episodeNumber: 2, artId: null }
  ]
  return {
    list: async ({ type, seriesId = null, seasonId = null }) => ({
      items: type === 'movies'
        ? movies
        : type === 'series'
          ? series
          : type === 'seasons'
            ? (seriesId === 'show' ? seasons : [])
            : type === 'episodes'
              ? (seasonId === 'show-s1' ? episodes : [])
              : [],
      cursor: null
    }),
    items: { movies, series, seasons, episodes }
  }
}

const ROUTES = [
  [/search\/movie.*Uncovered|search\/movie.*query=Uncovered/, respond({ results: [{ id: 11, title: 'Uncovered', release_date: '2001-01-01', poster_path: '/u.jpg' }] })],
  [/search\/movie.*Crash/, respond({
    results: [
      { id: 21, title: 'Crash', release_date: '1996-01-01', poster_path: '/c1.jpg' },
      { id: 22, title: 'Crash', release_date: '2004-01-01', poster_path: '/c2.jpg' }
    ]
  })],
  [/search\/tv/, respond({ results: [{ id: 31, name: 'A Show', first_air_date: '2010-01-01', poster_path: '/s.jpg' }] })],
  [/\/movie\/22\b/, respond({ id: 22, title: 'Crash', release_date: '2004-01-01', poster_path: '/c2.jpg', overview: 'the other one' })],
  // The show's one season: a poster of its own, a still for episode 1 and nothing
  // for episode 2 - the shape TMDB really answers for specials and oddities.
  [/\/tv\/31\/season\/1\b/, respond({
    poster_path: '/sp.jpg',
    episodes: [{ episode_number: 1, still_path: '/st1.jpg' }, { episode_number: 2, still_path: null }]
  })],
  // Details BY ID, which is how a fix applies a pick - and how a match made before
  // summaries were kept goes back for its words without re-guessing anything.
  [/\/movie\/11\b/, respond({ id: 11, title: 'Uncovered', release_date: '2001-01-01', poster_path: '/u.jpg', overview: 'what it is about' })],
  [/\/movie\/21\b/, respond({ id: 21, title: 'Crash', release_date: '1996-01-01', poster_path: '/c1.jpg' })],
  [/\/tv\/31\b(?!\/season)/, respond({ id: 31, name: 'A Show', first_air_date: '2010-01-01', poster_path: '/s.jpg', overview: 'a show about things' })],
  [/image\.tmdb\.org/, respond({})]
]

test('THE PASS: sidecar art untouched, everything else gets its best guess, doubt is counted', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({ dataDir: dir, fetch: fakeFetch(ROUTES) })
  const adapter = fakeAdapter()

  const out = await en.run(adapter, { key: 'k' })
  assert.equal(out.looked, 3, 'the covered film was never looked up at all')
  assert.equal(out.matched, 3, 'every bare item got a poster, ambiguous or not')
  assert.equal(out.uncertain, 1, 'and the guessed one is counted as a guess')
  assert.equal(out.missed, 0)

  // The poster is real bytes in the DATA dir, nowhere near the library - the
  // ambiguous Crash included, wearing its best guess, and the show's season
  // poster and episode still beside them.
  const posters = await fsp.readdir(path.join(dir, 'tmdb', 'posters'))
  assert.deepEqual(posters.sort(), ['bare.jpg', 'show-e1.jpg', 'show-s1.jpg', 'show.jpg', 'vague.jpg'])
  assert.equal(en.matched.vague.uncertain, true)
  assert.equal(en.matched.bare.uncertain, undefined)
  assert.equal(out.pictures, 2, 'the season and the one episode TMDB has a still for')

  // Decoration fills only the gap, with a copy rather than a mutation.
  const bare = adapter.items.movies[1]
  const dec = en.decorate(bare)
  assert.equal(dec.artId, 'tmdb:bare')
  assert.equal(bare.artId, null, 'the adapter cache must not be poisoned')
  assert.equal(en.decorate(adapter.items.movies[0]).artId, 'real-art', 'sidecar always wins')

  // And the art route can serve it.
  const stream = en.artStream('tmdb:bare')
  const chunks = []
  for await (const c of stream) chunks.push(c)
  assert.deepEqual(Buffer.concat(chunks), POSTER_BYTES)
})

test('the state survives a restart, and a second pass does no work', async () => {
  const dir = await tmpdir()
  const f = fakeFetch(ROUTES)
  const en = new tmdb.Enricher({ dataDir: dir, fetch: f })
  await en.run(fakeAdapter(), { key: 'k' })
  const askedOnce = f.asked.length

  const again = new tmdb.Enricher({ dataDir: dir, fetch: f })
  assert.equal(again.decorate({ id: 'bare', artId: null }).artId, 'tmdb:bare')
  const out = await again.run(fakeAdapter(), { key: 'k' })
  assert.equal(out.looked, 0, 'matched and missed are both remembered')
  // ONE ask is allowed on the second pass: episode 2 has no still, so its season
  // is asked again in case TMDB has grown one - a single cheap call, not a
  // re-fetch of anything already held.
  assert.equal(f.asked.length, askedOnce + 1, 'only the still-less season is asked again')
})

test('SEASON POSTERS AND EPISODE STILLS ride on the show match, and leave with it', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({ dataDir: dir, fetch: fakeFetch(ROUTES) })
  await en.run(fakeAdapter(), { key: 'k' })

  // The season and the episode with a still are decorated; the still-less episode
  // stays a placeholder rather than wearing something invented.
  assert.equal(en.decorate({ id: 'show-s1', artId: null }).artId, 'tmdb:show-s1')
  assert.equal(en.decorate({ id: 'show-e1', artId: null }).artId, 'tmdb:show-e1')
  assert.equal(en.decorate({ id: 'show-e2', artId: null }).artId, null)

  // And the bytes serve through the same art contract.
  const stream = en.artStream('tmdb:show-s1')
  const chunks = []
  for await (const c of stream) chunks.push(c)
  assert.deepEqual(Buffer.concat(chunks), POSTER_BYTES)

  // Unmatching the SHOW takes its seasons' pictures with it - the old programme's
  // stills under a new match would be the worst version of wrong.
  await en.unmatch('show')
  assert.equal(en.decorate({ id: 'show-s1', artId: null }).artId, null)
  assert.equal(en.artStream('tmdb:show-e1'), null)
  const posters = await fsp.readdir(path.join(dir, 'tmdb', 'posters'))
  assert.equal(posters.includes('show-s1.jpg'), false, 'the files are gone too')
})

test('THE FIX FLOW: the operator corrects a guess from the tile, or drops the artwork', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({ dataDir: dir, fetch: fakeFetch(ROUTES) })
  await en.run(fakeAdapter(), { key: 'k' })

  // The guessed Crash was the 1996 one; the operator says it is the 2004 one. The
  // poster is fetched fresh BY ID - nothing from the page is trusted but the id.
  const fixed = await en.fix({ itemId: 'vague', tmdbId: 22, type: 'movie', key: 'k' })
  assert.equal(fixed.how, 'fixed')
  assert.equal(fixed.tmdbId, 22)
  assert.equal(fixed.uncertain, undefined, 'a person chose it, so it is not a guess')
  assert.equal(en.summary().uncertain, 0)
  assert.equal(en.decorate({ id: 'vague', artId: null }).artId, 'tmdb:vague')

  // And the fix search takes the operator's own words, because the filename being
  // wrong is usually the whole problem.
  const cands = await en.search({ item: { id: 'vague', type: 'movie', title: 'Crash' }, q: 'Uncovered', key: 'k' })
  assert.equal(cands[0].tmdbId, 11)

  // Unmatching drops the poster and is remembered, so the next automatic pass
  // leaves the item alone rather than re-guessing.
  assert.equal(await en.unmatch('vague'), true)
  assert.equal(en.artStream('tmdb:vague'), null)
  assert.equal(en.decorate({ id: 'vague', artId: null }).artId, null)
  const out = await en.run(fakeAdapter(), { key: 'k' })
  assert.equal(out.looked, 0, 'the unmatched item is not re-guessed')
})

// THE SUMMARY WAS FETCHED AND THROWN AWAY on every lookup, while the title page
// told anybody without one to turn artwork on and PearCinema would ask TMDB for it
// (found 2026-08-20, working on the pencil). It is the other half of what a match
// IS: the picture and the words.
test('a match brings the summary with it, and a summary already there wins', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({ dataDir: dir, fetch: fakeFetch(ROUTES) })
  await en.run(fakeAdapter(), { key: 'k' })

  // The fix flow's candidate is fetched by id and carries TMDB's own words.
  await en.fix({ itemId: 'vague', tmdbId: 22, type: 'movie', key: 'k' })
  assert.equal(en.decorate({ id: 'vague', artId: null, overview: null }).overview, 'the other one')

  // TWO GAPS, ASKED SEPARATELY. A file can have its own poster and no summary at
  // all, which is exactly the film that started this - one answer for both would
  // have left it with nothing.
  const own = en.decorate({ id: 'vague', artId: 'poster-on-disk', overview: null })
  assert.equal(own.artId, 'poster-on-disk', 'the disk still wins the picture')
  assert.equal(own.overview, 'the other one', 'and it still gets the words')

  // A summary of its own is a sidecar like any other and is never overwritten.
  assert.equal(en.decorate({ id: 'vague', artId: null, overview: 'from the nfo' }).overview, 'from the nfo')

  // Nothing to add is nothing done - the same object comes back.
  const untouched = { id: 'nobody', artId: null, overview: null }
  assert.equal(en.decorate(untouched), untouched)

  // And forgetting the match takes the words with the picture.
  await en.unmatch('vague')
  assert.equal(en.decorate({ id: 'vague', artId: null, overview: null }).overview, null)
})

// EVERY MATCH ALREADY MADE has a picture and no words - 264 of them on the real
// library the day the summary started being kept. Without this the change would have
// done nothing at all on a library that had already had its pass.
test('a match made before summaries were kept goes back for its words, once', async () => {
  const dir = await tmpdir()
  const f = fakeFetch(ROUTES)
  const en = new tmdb.Enricher({ dataDir: dir, fetch: f })
  await en.run(fakeAdapter(), { key: 'k' })

  // What a state file written by the older build looks like.
  for (const m of Object.values(en.matched)) delete m.overview
  const out = await en.run(fakeAdapter(), { key: 'k' })
  assert.equal(out.looked, 0, 'nothing is re-guessed - the matches themselves do not change')
  assert.equal(en.decorate({ id: 'bare', artId: null, overview: null }).overview, 'what it is about')
  assert.equal(en.decorate({ id: 'show', artId: null, overview: null }).overview, 'a show about things')

  // A title TMDB says nothing about answers nothing, and that answer sticks - or
  // every pass from here would ask about it again.
  assert.equal(en.matched.vague.overview, '')
  const asks = () => f.asked.filter(u => /\/movie\/21\b/.test(u)).length
  const before = asks()
  await en.run(fakeAdapter(), { key: 'k' })
  assert.equal(asks(), before, 'the second pass asks nothing more')
})

// The dialog cannot work out whether a match exists by looking at the item: a
// poster off the disk wins the picture and says nothing about what is behind it.
test('the host can say what a title is currently matched to', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({ dataDir: dir, fetch: fakeFetch(ROUTES) })
  await en.run(fakeAdapter(), { key: 'k' })

  assert.equal(en.matchFor('nobody'), null)
  const m = en.matchFor('vague')
  assert.equal(m.tmdbId, 21)
  assert.equal(m.title, 'Crash')
  assert.equal(m.uncertain, true, 'and whether it was a guess')

  await en.unmatch('vague')
  assert.equal(en.matchFor('vague'), null)
})

test('no key refuses loudly, and a key TMDB rejects fails the pass rather than one item', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({ dataDir: dir, fetch: fakeFetch(ROUTES) })
  await assert.rejects(() => en.run(fakeAdapter(), {}), /no TMDB key/)

  const rejecting = new tmdb.Enricher({
    dataDir: await tmpdir(),
    fetch: fakeFetch([[/./, respond({}, 401)]])
  })
  await assert.rejects(() => rejecting.run(fakeAdapter(), { key: 'revoked' }), /did not accept/)
  assert.equal(rejecting.running, null, 'and the pass is over, not wedged')
})

test('one flaky lookup costs that item only, and lands in missed', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({
    dataDir: dir,
    fetch: fakeFetch([
      [/search\/movie.*Uncovered/, respond({}, 500)],
      ...ROUTES
    ])
  })
  const out = await en.run(fakeAdapter(), { key: 'k' })
  assert.equal(out.missed, 1)
  assert.equal(out.matched, 2, 'the show and the guessable film still got their posters')
})

test('WHICH ONES FOUND NOTHING, resolved against the library rather than read from the store', async () => {
  // A count you cannot act on is a count (Tim, 2026-08-19). The store keeps ids and a
  // reason; the list has to carry the title and the type, because what it feeds is the
  // fix dialog - and the only thing that knows what an id currently IS is the library.
  const dir = await tmpdir()
  const en = new tmdb.Enricher({
    dataDir: dir,
    fetch: fakeFetch([[/search\/movie.*Uncovered/, respond({}, 500)], ...ROUTES])
  })
  const adapter = fakeAdapter()
  await en.run(adapter, { key: 'k' })

  const missing = await en.missedList(adapter)
  assert.deepEqual(missing.map(m => m.id), ['bare'])
  assert.equal(missing[0].title, 'Uncovered')
  assert.equal(missing[0].type, 'movie', 'the type the fix dialog needs')
  assert.ok(missing[0].reason, 'and why it came back with nothing')

  // Matched by hand afterwards, so it is not missing any more whatever the store says.
  await en.fix({ itemId: 'bare', tmdbId: 22, type: 'movie', key: 'k', adapter })
  assert.deepEqual(await en.missedList(adapter), [])
})
