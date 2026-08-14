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

test('MATCHING IS CAUTIOUS: only an exact title or a lone result applies itself', async () => {
  const item = { title: 'Solaris', year: 1972 }

  // Exact title, year agreeing: sure.
  assert.equal(tmdb.autoMatch(item, [
    { tmdbId: 1, title: 'Solaris', year: 1972 },
    { tmdbId: 2, title: 'Solaris: The Documentary', year: 2005 }
  ])?.tmdbId, 1)

  // TWO exact matches - the remake problem. 1972 and 2002 both call themselves
  // Solaris, and with no year on the file nobody should guess.
  assert.equal(tmdb.autoMatch({ title: 'Solaris', year: null }, [
    { tmdbId: 1, title: 'Solaris', year: 1972 },
    { tmdbId: 3, title: 'Solaris', year: 2002 }
  ]), null)

  // A lone result is safe whatever it is called.
  assert.equal(tmdb.autoMatch({ title: 'An Obscure Thing', year: null }, [
    { tmdbId: 7, title: 'An Obscure Thing Entirely', year: 1999 }
  ])?.tmdbId, 7)

  // Several inexact results: wait for the operator.
  assert.equal(tmdb.autoMatch({ title: 'Crash', year: null }, [
    { tmdbId: 1, title: 'Crash Landing', year: 2005 },
    { tmdbId: 2, title: 'The Crash', year: 2017 }
  ]), null)

  // Off-by-one years still count as agreeing.
  assert.equal(tmdb.autoMatch({ title: 'Dune', year: 2022 }, [
    { tmdbId: 1, title: 'Dune', year: 2021 },
    { tmdbId: 2, title: 'Dune', year: 1984 }
  ])?.tmdbId, 1)
})

test('titles are compared as words, not as bytes', async () => {
  assert.equal(tmdb.normTitle('WALL·E'), tmdb.normTitle('Wall-E'))
  assert.equal(tmdb.normTitle('Amélie'), tmdb.normTitle('amelie'))
})

/* --------------------------------------------------------------- the pass -- */

// A library of one film with sidecar art, one without, and one ambiguous name.
function fakeAdapter () {
  const movies = [
    { id: 'has-art', type: 'movie', title: 'Covered', year: 2000, artId: 'real-art' },
    { id: 'bare', type: 'movie', title: 'Uncovered', year: 2001, artId: null },
    { id: 'vague', type: 'movie', title: 'Crash', year: null, artId: null }
  ]
  const series = [{ id: 'show', type: 'series', title: 'A Show', year: null, artId: null }]
  return {
    list: async ({ type }) => ({ items: type === 'movies' ? movies : type === 'series' ? series : [], cursor: null }),
    items: { movies, series }
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
  [/image\.tmdb\.org/, respond({})]
]

test('THE PASS: sidecar art untouched, sure matches applied, ambiguity held for the operator', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({ dataDir: dir, fetch: fakeFetch(ROUTES) })
  const adapter = fakeAdapter()

  const out = await en.run(adapter, { key: 'k' })
  assert.equal(out.looked, 3, 'the covered film was never looked up at all')
  assert.equal(out.matched, 2, 'the bare film and the show')
  assert.equal(out.pending, 1, 'the two Crashes wait for a click')

  // The poster is real bytes in the DATA dir, nowhere near the library.
  const posters = await fsp.readdir(path.join(dir, 'tmdb', 'posters'))
  assert.deepEqual(posters.sort(), ['bare.jpg', 'show.jpg'])

  // Decoration fills only the gap, with a copy rather than a mutation.
  const bare = adapter.items.movies[1]
  const dec = en.decorate(bare)
  assert.equal(dec.artId, 'tmdb:bare')
  assert.equal(bare.artId, null, 'the adapter cache must not be poisoned')
  assert.equal(en.decorate(adapter.items.movies[0]).artId, 'real-art', 'sidecar always wins')

  // And the art route can serve it.
  const stream = en.art('tmdb:bare')
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
  assert.equal(out.looked, 0, 'matched, pending and missed are all remembered')
  assert.equal(f.asked.length, askedOnce, 'and nothing was asked again')
})

test('the operator settles an ambiguous match, or dismisses it', async () => {
  const dir = await tmpdir()
  const en = new tmdb.Enricher({ dataDir: dir, fetch: fakeFetch(ROUTES) })
  await en.run(fakeAdapter(), { key: 'k' })

  assert.equal(en.summary().pending.length, 1)
  const done = await en.confirm({ itemId: 'vague', tmdbId: 22, key: 'k' })
  assert.equal(done.how, 'confirmed')
  assert.equal(en.summary().pending.length, 0)
  assert.equal(en.decorate({ id: 'vague', artId: null }).artId, 'tmdb:vague')

  // Dismissing is remembered too - a rejected row must not come back every pass.
  const en2 = new tmdb.Enricher({ dataDir: await tmpdir(), fetch: fakeFetch(ROUTES) })
  await en2.run(fakeAdapter(), { key: 'k' })
  assert.equal(en2.dismiss('vague'), true)
  assert.equal(en2.summary().pending.length, 0)
  const out = await en2.run(fakeAdapter(), { key: 'k' })
  assert.equal(out.looked, 0)
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
  assert.equal(out.matched, 1, 'the show still got its poster')
})
