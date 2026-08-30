// WHAT ONE PERSON MAY SEE, decided in one place. proposals/2026-08-30-per-person-folders.md.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const { visibleTo, narrowed, viewOf, locate, under } = require('../host/visibility')

const FILMS = '/srv/films'
const TV = '/srv/tv'
const at = (root, rel) => ({ root, rel })

test('null paths is everything, an owner is never filtered, an unplaceable item is hidden from a narrowed grant', () => {
  assert.equal(visibleTo({ scope: 'full', paths: null }, at(FILMS, 'Blade (1998)/Blade.mkv')), true)
  assert.equal(visibleTo({ scope: 'full', paths: null }, null), true, 'no narrowing, no need to place anything')
  assert.equal(visibleTo({ scope: 'owner', paths: [at(FILMS, 'kids')] }, at(TV, 'x')), true, 'the owner is the library')
  assert.equal(visibleTo({ scope: 'full', paths: [at(FILMS, 'kids')] }, null), false, 'cannot place it: hidden, never shown')
  assert.equal(visibleTo(null, at(FILMS, 'kids/a')), false)
  assert.equal(visibleTo({ scope: 'full', paths: [] }, at(FILMS, 'kids/a')), false, 'an empty list the store should never hold reads as nothing, not everything')
})

test('a prefix covers its folder and everything beneath, on folder boundaries, whatever the slashes', () => {
  const kids = { scope: 'full', paths: [at(FILMS, 'kids/')] }
  assert.equal(visibleTo(kids, at(FILMS, 'kids/Frozen (2013)/Frozen.mkv')), true)
  assert.equal(visibleTo(kids, at(FILMS, 'kids')), true, 'the folder itself')
  assert.equal(visibleTo(kids, at(FILMS, 'kids2/Not For Kids.mkv')), false, 'a sibling that merely shares the letters')
  assert.equal(visibleTo(kids, at(FILMS, 'Blade (1998)/Blade.mkv')), false)
  assert.equal(visibleTo(kids, at(TV, 'kids/Bluey/S01E01.mkv')), false, 'same folder name under another root is another folder')
  assert.equal(under(at(FILMS, 'kids\\Frozen\\a.mkv'), at(FILMS, '/kids/')), true, 'Windows separators and stray slashes are the same prefix')
  const whole = { scope: 'full', paths: [at(TV, '')] }
  assert.equal(visibleTo(whole, at(TV, 'Bluey/Season 1/S01E01.mkv')), true, "rel '' is the whole root")
  assert.equal(visibleTo(whole, at(FILMS, 'kids/a.mkv')), false)
  const two = { scope: 'full', paths: [at(FILMS, 'kids'), at(TV, 'Bluey')] }
  assert.equal(visibleTo(two, at(TV, 'Bluey/Season 1/S01E01.mkv')), true)
  assert.equal(visibleTo(two, at(TV, 'Breaking Bad/S01E01.mkv')), false)
})

test('narrowed() is the fast path: an unnarrowed grant gets the real adapter back', () => {
  const adapter = { list: async () => ({ items: [] }) }
  assert.equal(narrowed({ scope: 'full', paths: null }), false)
  assert.equal(narrowed({ scope: 'owner', paths: [at(FILMS, 'kids')] }), false)
  assert.equal(narrowed({ scope: 'full', paths: [at(FILMS, 'kids')] }), true)
  assert.equal(viewOf(adapter, { scope: 'full', paths: null }), adapter, 'same object, nothing wrapped')
  assert.equal(viewOf(adapter, { scope: 'owner', paths: [at(FILMS, 'kids')] }), adapter)
})

test('THE VIEW: list, get, search and stats all answer the same narrower library', async () => {
  const rows = [
    { id: 'frozen', type: 'movie', title: 'Frozen', loc: at(FILMS, 'kids/Frozen (2013)/Frozen.mkv') },
    { id: 'blade', type: 'movie', title: 'Blade', loc: at(FILMS, 'Blade (1998)/Blade.mkv') },
    { id: 'lost', type: 'movie', title: 'Lost Tape', loc: null }
  ]
  const series = [{ id: 'bluey', type: 'series', title: 'Bluey', loc: at(TV, 'Bluey') }, { id: 'bb', type: 'series', title: 'Breaking Bad', loc: at(TV, 'Breaking Bad') }]
  const seasons = { bluey: [{ id: 'bluey-s1', type: 'season', loc: at(TV, 'Bluey/Season 1') }], bb: [{ id: 'bb-s1', type: 'season', loc: at(TV, 'Breaking Bad/Season 1') }] }
  const episodes = { 'bluey-s1': [{ id: 'bluey-1', type: 'episode', loc: at(TV, 'Bluey/Season 1/S01E01.mkv') }], 'bb-s1': [{ id: 'bb-1', type: 'episode', loc: at(TV, 'Breaking Bad/Season 1/S01E01.mkv') }] }
  const all = [...rows, ...series, ...Object.values(seasons).flat(), ...Object.values(episodes).flat()]
  const calls = []
  const adapter = {
    kind: 'test',
    locationOf: (id) => all.find((r) => r.id === id)?.loc ?? null,
    async list ({ type, seriesId, seasonId, visible } = {}) {
      calls.push(type)
      let pool = type === 'movies' ? rows : type === 'series' ? series : type === 'seasons' ? (seasons[seriesId] || []) : (episodes[seasonId] || [])
      // Half the adapters honour the predicate (folder does); the view must not depend on it.
      if (visible && type === 'movies') pool = pool.filter(visible)
      return { items: pool, total: pool.length, cursor: null }
    },
    async get ({ id }) { return all.find((r) => r.id === id) || null },
    async search ({ q }) { return { items: all.filter((r) => (r.title || '').toLowerCase().includes(q.toLowerCase())) } },
    async stats () { return { movies: 3, series: 2, seasons: 2, episodes: 2, source: 'test' } },
    async art () { return 'art-bytes' }
  }
  const sam = { scope: 'full', paths: [at(FILMS, 'kids'), at(TV, 'Bluey')] }
  const view = viewOf(adapter, sam)
  assert.notEqual(view, adapter)

  assert.deepEqual((await view.list({ type: 'movies' })).items.map((r) => r.id), ['frozen'], 'Blade hidden, and the unplaceable tape too')
  assert.deepEqual((await view.list({ type: 'series' })).items.map((r) => r.id), ['bluey'], 'filtered even though this adapter ignored the predicate for series')
  assert.equal(await view.get({ id: 'blade' }), null, 'a hidden id is no such item')
  assert.equal((await view.get({ id: 'frozen' }))?.id, 'frozen')
  assert.equal(await view.get({ id: 'lost' }), null)
  assert.deepEqual((await view.search({ q: 'b' })).items.map((r) => r.id), ['bluey'], 'Blade and Breaking Bad do not surface through search')
  const stats = await view.stats()
  assert.deepEqual({ movies: stats.movies, series: stats.series, seasons: stats.seasons, episodes: stats.episodes }, { movies: 1, series: 1, seasons: 1, episodes: 1 }, 'counts are what is visible')
  assert.equal(stats.source, 'test', 'the rest of stats passes through')
  assert.equal(await view.art(), 'art-bytes', 'untouched methods pass through to the adapter')
  assert.equal(view.kind, 'test')
  assert.equal(view.visible({ id: 'blade' }), false)
})

test('locate() places a file under one of the roots, or nowhere', () => {
  const roots = [{ path: FILMS }, { path: TV }]
  assert.deepEqual(locate(path.join(FILMS, 'kids', 'Frozen (2013)', 'Frozen.mkv'), roots), at(FILMS, 'kids/Frozen (2013)/Frozen.mkv'))
  assert.deepEqual(locate(FILMS, roots), at(FILMS, ''))
  assert.equal(locate('/srv/films-old/x.mkv', roots), null, 'a sibling directory sharing the prefix is outside')
  assert.equal(locate('/elsewhere/x.mkv', roots), null)
  assert.equal(locate(null, roots), null)
  assert.deepEqual(locate('/srv/tv/Bluey/S01E01.mkv', ['/srv/tv']), at(TV, 'Bluey/S01E01.mkv'), 'roots may be plain strings')
})
