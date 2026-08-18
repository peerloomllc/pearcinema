// One person's devices act as one - the push half. The store was per-person
// from the start; what was missing was the NEWS: a write on one device now
// pushes to the person's other devices (the donor's exceptSelf shape), so a
// shelf follows a sibling phone without a reopen.

const test = require('node:test')
const assert = require('node:assert')
const { createMethods } = require('../host/methods')

function harness () {
  const pushes = []
  const owners = []
  // Per-DEVICE pushes, which is how the operators are reached: notifyOwners walks
  // the grant store and notifies each owner device by key.
  const devices = []
  // The dashboard's local channel, which is not a paired device and so hears
  // nothing from either push path.
  const events = []
  const state = {
    setResume: async () => ({ positionMs: 60000 }),
    setWatched: async () => {},
    setFav: async () => {},
    addRequest: async (requester, { kind, name }) => ({ id: 'r1', kind, name, count: 1, requester }),
    getRequest: async (id) => ({ id, requester: 'p:ada', name: 'Solaris' }),
    deleteRequest: async () => {},
    resolveRequest: async (id) => ({ id, requester: 'p:ada', title: 'Metropolis' })
  }
  const adapter = { get: async ({ id }) => ({ id, runtime: 3600 }) }
  // Two owner devices and one plain viewer, so a test proves the owners are
  // picked by SCOPE rather than by everybody being notified.
  const grants = {
    list: async () => [
      { deviceKey: 'owner-tv', scope: 'owner' },
      { deviceKey: 'owner-laptop', scope: 'owner' },
      { deviceKey: 'guest-phone', scope: 'readonly' },
      { deviceKey: 'owner-old', scope: 'owner', revokedAt: 1 }
    ]
  }
  const m = createMethods({
    getAdapter: () => adapter,
    getLibraryName: () => 'L',
    state,
    grants,
    events: (kind, data) => events.push({ kind, data })
  })
  const ctx = (params = {}) => ({
    params,
    owner: 'p:ada',
    deviceKey: 'phone-1',
    isOwner: true,
    pushToOwner: (kind, data) => { pushes.push({ kind, data }); return 1 },
    presence: {
      notifyOwner: (owner, kind, data) => { owners.push({ owner, kind, data }); return 1 },
      notify: (deviceKey, kind, data) => { devices.push({ deviceKey, kind, data }); return 1 }
    },
    badParams: (x) => new Error(x),
    notFound: (x) => new Error(x),
    forbidden: (x) => new Error(x)
  })
  return { m, ctx, pushes, owners, devices, events }
}

test('a position write tells the person s other devices where the film is', async () => {
  const { m, ctx, pushes } = harness()
  await m['resume.set'](ctx({ itemId: 'film1', positionMs: 60000 }))
  assert.deepStrictEqual(pushes[0], { kind: 'resume:changed', data: { itemId: 'film1', finished: false } })
})

test('a bookmark travels to the other phones, payload included', async () => {
  const { m, ctx, pushes } = harness()
  await m['fav.set'](ctx({ kind: 'movie', id: 'film1', on: true }))
  assert.deepStrictEqual(pushes[0], { kind: 'favorites:changed', data: { kind: 'movie', id: 'film1', on: true } })
})

test('marking watched travels the same way', async () => {
  const { m, ctx, pushes } = harness()
  await m['watched.set'](ctx({ itemId: 'film1', watched: true }))
  assert.deepStrictEqual(pushes[0], { kind: 'watched:changed', data: { itemId: 'film1', watched: true } })
})

test('resolving a request tells the REQUESTER, wherever they are signed in', async () => {
  const { m, ctx, owners } = harness()
  await m['request.resolve'](ctx({ id: 'r1', status: 'added' }))
  assert.deepStrictEqual(owners[0], { owner: 'p:ada', kind: 'request:resolved', data: { id: 'r1', title: 'Metropolis', status: 'added' } })
})

// --- the operator's half of the same conversation ---------------------------
//
// An ask used to reach the store and stop there: an owner watching Manage saw
// nothing until they left the screen and came back. These three prove the news
// leaves the handler, and that it reaches the operators SPECIFICALLY.

test('a new ask reaches every owner device, and nobody else', async () => {
  const { m, ctx, devices } = harness()
  await m['request.add'](ctx({ kind: 'movie', name: 'Stalker' }))
  assert.deepStrictEqual(devices.map(d => d.deviceKey), ['owner-tv', 'owner-laptop'])
  assert.deepStrictEqual(devices[0], {
    deviceKey: 'owner-tv',
    kind: 'request:created',
    data: { id: 'r1', name: 'Stalker', kind: 'movie', count: 1 }
  })
})

test('withdrawing an ask takes it off the operator s screen too', async () => {
  const { m, ctx, devices } = harness()
  await m['request.remove'](ctx({ id: 'r1' }))
  assert.deepStrictEqual(devices.map(d => d.kind), ['request:removed', 'request:removed'])
  assert.deepStrictEqual(devices.map(d => d.deviceKey), ['owner-tv', 'owner-laptop'])
  assert.deepStrictEqual(devices[0].data, { id: 'r1' })
})

test('the operator s own dashboard hears all three, being no device s push', async () => {
  const { m, ctx, events } = harness()
  await m['request.add'](ctx({ kind: 'movie', name: 'Stalker' }))
  await m['request.resolve'](ctx({ id: 'r1', status: 'declined' }))
  await m['request.remove'](ctx({ id: 'r1' }))
  assert.deepStrictEqual(events.map(e => e.kind), ['request:created', 'request:resolved', 'request:removed'])
  assert.deepStrictEqual(events[1].data, { id: 'r1', title: 'Metropolis', status: 'declined' })
})
