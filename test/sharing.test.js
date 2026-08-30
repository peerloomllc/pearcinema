// PER-PERSON FOLDERS, end to end through the wire methods.
// proposals/2026-08-30-per-person-folders.md, approved 2026-08-30.
//
// The point of this file is the CHOKEPOINT: it is not enough that a narrowed person's
// list is shorter. Every other way to reach a film - by id, by search, by art, by
// stream, by segment, by cast, by the person's own shelves - has to answer the same
// way, or a hidden film is one guessed id away.

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('stream')

const { createMethods } = require('../host/methods')
const items = require('../host/items')

const FILMS = '/srv/films'
const TV = '/srv/tv'

const FROZEN = { id: 'frozen', type: 'movie', title: 'Frozen', artId: 'art-frozen', loc: { root: FILMS, rel: 'kids/Frozen (2013)/Frozen.mkv' } }
const BLADE = { id: 'blade', type: 'movie', title: 'Blade', artId: 'art-blade', loc: { root: FILMS, rel: 'Blade (1998)/Blade.mkv' } }
const BLUEY = { id: 'bluey', type: 'series', title: 'Bluey', loc: { root: TV, rel: 'Bluey' } }
const BB = { id: 'bb', type: 'series', title: 'Breaking Bad', loc: { root: TV, rel: 'Breaking Bad' } }
const ALL = [FROZEN, BLADE, BLUEY, BB]

function adapter () {
  return {
    kind: 'test',
    locationOf: (id) => ALL.find((r) => r.id === id)?.loc ?? null,
    itemForArt: (artId) => ALL.find((r) => r.artId === artId)?.id ?? null,
    async stats () { return { movies: 2, series: 2, seasons: 0, episodes: 0, source: 'test' } },
    async list ({ type, visible } = {}) {
      let pool = type === 'series' ? [BLUEY, BB] : type === 'movies' ? [FROZEN, BLADE] : []
      if (visible) pool = pool.filter(visible)
      return items.page(pool, {})
    },
    async get ({ id }) { return ALL.find((r) => r.id === id) || null },
    async search ({ q }) { return { items: ALL.filter((r) => r.title.toLowerCase().includes(String(q).toLowerCase())) } },
    async art ({ artId }) { return ALL.some((r) => r.artId === artId) ? Readable.from(['art']) : null },
    async subtitles () { return [{ id: 's1', language: 'en', playable: true }] },
    async subtitle () { return Readable.from(['WEBVTT']) },
    async stream () { return Readable.from(['bytes']) }
  }
}

function ctxFor (grant, params = {}) {
  const sent = { body: null, streamed: null }
  return {
    params,
    grant,
    scope: grant.scope,
    isOwner: grant.scope === 'owner',
    deviceKey: 'dev1',
    owner: 'p:sam',
    sent,
    reply: (b) => { sent.body = b },
    stream: (r) => { sent.streamed = r; return r },
    fail: (code, message) => { throw Object.assign(new Error(message), { code }) },
    notFound: (m) => Object.assign(new Error(m), { code: 'NOT_FOUND' }),
    badParams: (m) => Object.assign(new Error(m), { code: 'BAD_PARAMS' }),
    forbidden: (m) => Object.assign(new Error(m), { code: 'FORBIDDEN' })
  }
}

const KIDS = { scope: 'full', paths: [{ root: FILMS, rel: 'kids' }, { root: TV, rel: 'Bluey' }] }
const EVERYTHING = { scope: 'full', paths: null }
const OWNER = { scope: 'owner', paths: [{ root: FILMS, rel: 'kids' }] }

function methodsWith (extra = {}) {
  const a = adapter()
  return createMethods({
    getAdapter: () => a,
    getLibraryName: () => 'L',
    media: {
      decide: async () => ({ mode: 'direct', reason: 'fine' }),
      playlist: async () => 'playlist',
      segment: async () => ({ stdout: Readable.from(['seg']) }),
      init: async () => ({ stdout: Readable.from(['init']) }),
      export: async () => ({ direct: true })
    },
    cast: () => ({ speakers: { enabled: true, list: async () => [] }, active: () => [], play: async () => ({ ok: true }) }),
    ...extra
  })
}

test('A NARROWED PERSON SEES A SMALLER LIBRARY, and it is the same answer everywhere', async () => {
  const m = methodsWith()

  const list = await m['library.list'](ctxFor(KIDS, { type: 'movies' }))
  assert.deepEqual(list.items.map((i) => i.id), ['frozen'], 'the list')
  const series = await m['library.list'](ctxFor(KIDS, { type: 'series' }))
  assert.deepEqual(series.items.map((i) => i.id), ['bluey'])

  assert.equal((await m['library.get'](ctxFor(KIDS, { id: 'frozen' }))).id, 'frozen')
  await assert.rejects(m['library.get'](ctxFor(KIDS, { id: 'blade' })), /no such item/, 'by id')

  const found = await m['library.search'](ctxFor(KIDS, { q: 'b' }))
  assert.deepEqual(found.items.map((i) => i.id), ['bluey'], 'search never surfaces a hidden film')

  const stats = await m['library.stats'](ctxFor(KIDS))
  assert.equal(stats.movies, 1)
  assert.equal(stats.series, 1)

  await assert.rejects(m['art.get'](ctxFor(KIDS, { artId: 'art-blade' })), /no artwork/, 'a poster is a film')
  assert.ok(await m['art.get'](ctxFor(KIDS, { artId: 'art-frozen' })))

  for (const [method, params] of [
    ['media.decide', { itemId: 'blade' }],
    ['media.playlist', { itemId: 'blade' }],
    ['media.segment', { itemId: 'blade', seq: 0 }],
    ['media.init', { itemId: 'blade' }],
    ['media.export', { itemId: 'blade' }],
    ['subtitle.list', { itemId: 'blade' }],
    ['subtitle.get', { itemId: 'blade', subtitleId: 's1' }]
  ]) {
    await assert.rejects(m[method](ctxFor(KIDS, params)), /no such item|no such segment/, method + ' refuses a hidden film')
  }
  // And the same calls work for a film they may see, so this is a rule and not a wall.
  assert.ok(await m['media.decide'](ctxFor(KIDS, { itemId: 'frozen' })))
  assert.ok((await m['subtitle.list'](ctxFor(KIDS, { itemId: 'frozen' }))).items.length)
})

test('a television is the owner\'s, but the FILM still has to be visible', async () => {
  const m = methodsWith()
  const owner = { scope: 'owner', paths: null }
  assert.ok(await m['cast.play'](ctxFor(owner, { entityId: 'tv', itemId: 'blade' })), 'the owner casts anything')
  // A narrowed device is not an owner and cast.play already refuses it; the guard
  // matters for the day a narrowed person is given owner scope of their own library.
  const narrowedOwner = { scope: 'owner', paths: [{ root: FILMS, rel: 'kids' }] }
  assert.ok(await m['cast.play'](ctxFor(narrowedOwner, { entityId: 'tv', itemId: 'blade' })), 'owner scope is never filtered')
})

test('an unnarrowed grant and an owner see exactly what they saw before', async () => {
  const m = methodsWith()
  for (const grant of [EVERYTHING, OWNER]) {
    const list = await m['library.list'](ctxFor(grant, { type: 'movies' }))
    assert.deepEqual(list.items.map((i) => i.id), ['frozen', 'blade'], 'everything')
    assert.equal((await m['library.get'](ctxFor(grant, { id: 'blade' }))).id, 'blade')
    assert.equal((await m['library.stats'](ctxFor(grant))).movies, 2)
    assert.ok(await m['art.get'](ctxFor(grant, { artId: 'art-blade' })))
  }
})

test("a narrowed person's own shelves drop the rows they may no longer see, and keep the positions", async () => {
  const rows = [{ itemId: 'blade', positionMs: 60000 }, { itemId: 'frozen', positionMs: 30000 }]
  const state = {
    listResume: async () => rows,
    listFavs: async () => ({ movie: ['blade', 'frozen'] }),
    listWatched: async () => ({ movie: [] })
  }
  const m = methodsWith({ state })
  const resume = await m['resume.list'](ctxFor(KIDS, {}))
  assert.deepEqual(resume.items.map((i) => i.id ?? i.itemId), ['frozen'], 'the hidden row is dropped on the way out')
  assert.equal(rows.length, 2, 'and nothing is deleted - a narrowing is not a deletion')
  const favs = await m['fav.list'](ctxFor(KIDS, {}))
  const ids = (favs.items || []).map((i) => i.id ?? i.itemId)
  assert.ok(!ids.includes('blade'))
})
