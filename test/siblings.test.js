// library.siblings: the episode on either side, for the player's Previous and
// Next buttons. The pins: structural order rather than watch state, season
// boundaries crossed in both directions, and non-episodes answering with two
// nulls instead of an error.

const test = require('node:test')
const assert = require('node:assert')
const { createMethods } = require('../host/methods')

const ctxFor = (params = {}) => ({
  params,
  badParams: (m) => Object.assign(new Error(m), { code: 'EBADPARAMS' }),
  notFound: (m) => Object.assign(new Error(m), { code: 'ENOTFOUND' })
})

// Two seasons of two, in order, plus a film - the smallest tree with a season
// boundary in it.
const EPS = [
  { id: 'e1', type: 'episode', seriesId: 'show', seasonId: 's1', episodeNumber: 1 },
  { id: 'e2', type: 'episode', seriesId: 'show', seasonId: 's1', episodeNumber: 2 },
  { id: 'e3', type: 'episode', seriesId: 'show', seasonId: 's2', episodeNumber: 1 },
  { id: 'e4', type: 'episode', seriesId: 'show', seasonId: 's2', episodeNumber: 2 }
]

const adapter = {
  get: async ({ id }) => {
    if (id === 'film') return { id: 'film', type: 'movie' }
    if (id === 'show') return { id: 'show', type: 'series' }
    return EPS.find((e) => e.id === id) || null
  },
  list: async ({ type, seriesId, seasonId }) => {
    if (type === 'seasons') {
      return { items: seriesId === 'show' ? [{ id: 's1' }, { id: 's2' }] : [] }
    }
    return { items: EPS.filter((e) => e.seasonId === seasonId) }
  }
}

const m = createMethods({ getAdapter: () => adapter, getLibraryName: () => 'L' })

test('the middle of a season answers with both neighbours', async () => {
  const out = await m['library.siblings'](ctxFor({ id: 'e2' }))
  assert.strictEqual(out.prev.id, 'e1')
  assert.strictEqual(out.next.id, 'e3')
})

test('NEXT CROSSES THE SEASON BOUNDARY - the last of season one answers with the first of season two', async () => {
  const out = await m['library.siblings'](ctxFor({ id: 'e2' }))
  assert.strictEqual(out.next.seasonId, 's2')
  const back = await m['library.siblings'](ctxFor({ id: 'e3' }))
  assert.strictEqual(back.prev.id, 'e2')
  assert.strictEqual(back.prev.seasonId, 's1')
})

test('the edges of the show are honest nulls, not wraparounds', async () => {
  const first = await m['library.siblings'](ctxFor({ id: 'e1' }))
  assert.strictEqual(first.prev, null)
  assert.strictEqual(first.next.id, 'e2')
  const last = await m['library.siblings'](ctxFor({ id: 'e4' }))
  assert.strictEqual(last.prev.id, 'e3')
  assert.strictEqual(last.next, null)
})

test('a film and a series answer with two nulls rather than an error', async () => {
  assert.deepStrictEqual(await m['library.siblings'](ctxFor({ id: 'film' })), { prev: null, next: null })
  assert.deepStrictEqual(await m['library.siblings'](ctxFor({ id: 'show' })), { prev: null, next: null })
})

test('a missing id is a refusal, an unknown item is not found', async () => {
  await assert.rejects(() => m['library.siblings'](ctxFor({})), /id required/)
  await assert.rejects(() => m['library.siblings'](ctxFor({ id: 'nope' })), /no such item/)
})
