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
  // What a clear actually wrote, so a test can prove it forgot the places
  // rather than only answering as though it had.
  const wrote = []
  // Which rows resolveRequest was actually asked to write.
  const resolved = []
  const state = {
    listResume: async () => [{ itemId: 'a' }, { itemId: 'b' }, { itemId: 'c' }],
    setResume: async (owner, itemId, positionMs) => {
      wrote.push({ owner, itemId, positionMs })
      return { positionMs: 60000 }
    },
    setWatched: async () => {},
    setFav: async () => {},
    addRequest: async (requester, { kind, name }) => ({ id: 'r1', kind, name, count: 1, requester }),
    // `gone` is the id of a request that is not there, so a handler can be caught
    // writing before it has checked.
    getRequest: async (id) => (id === 'gone' ? null : { id, requester: 'p:ada', name: 'Solaris' }),
    deleteRequest: async () => {},
    resolveRequest: async (id) => {
      resolved.push(id)
      return id === 'gone' ? null : { id, requester: 'p:ada', title: 'Metropolis' }
    }
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
  return { m, ctx, pushes, owners, devices, events, wrote, resolved }
}

test('a position write tells the person s other devices where the film is', async () => {
  const { m, ctx, pushes } = harness()
  await m['resume.set'](ctx({ itemId: 'film1', positionMs: 60000 }))
  assert.deepStrictEqual(pushes[0], { kind: 'resume:changed', data: { itemId: 'film1', finished: false } })
})

test('CLEARING THE SHELF FORGETS THE PLACES, and tells the other devices', async () => {
  // Tim, 2026-08-20: emptying the shelf means letting the places go. A clear
  // that only hid the row would leave every film still offering to resume,
  // which is two different answers to one question.
  const { m, ctx, pushes, wrote } = harness()
  const out = await m['resume.clear'](ctx({}))

  assert.strictEqual(out.cleared, 3)
  // A ZERO IS THE DELETE, the same write a finished film makes - there is no
  // second deletion path to keep honest.
  assert.deepStrictEqual(wrote.map((w) => [w.itemId, w.positionMs]), [['a', 0], ['b', 0], ['c', 0]])
  assert.ok(wrote.every((w) => w.owner === 'p:ada'), 'and only this person s own places')
  assert.deepStrictEqual(pushes[0], { kind: 'resume:cleared', data: { cleared: 3 } })
})

test('clearing is a WRITE, so a readonly device cannot do it', () => {
  // It only ever touches the caller's own rows, but it is still a mutation and
  // has to be refused at the package's chokepoint rather than inside the
  // handler - the rule every mutating method on this table follows.
  const { MUTATING } = require('../host/methods')
  assert.ok(MUTATING.includes('resume.clear'))
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

// --- the person who asked may close their own copy ---------------------------
//
// An ask is filed with every reachable host and only the one that ANSWERS writes it
// down, so the sibling copies would stay pending for good. Hosts do not talk to each
// other, so the requesting device closes them - and on those hosts it may be a guest
// (proposal 2026-08-22-the-requester-closes-the-ask).

test('THE PERSON WHO FILED AN ASK MAY RESOLVE IT, owner or not', async () => {
  const { m, ctx, owners } = harness()
  const guest = { ...ctx({ id: 'r1', status: 'added' }), isOwner: false }
  await m['request.resolve'](guest)
  assert.deepStrictEqual(owners[0].data, { id: 'r1', title: 'Metropolis', status: 'added' })
})

test('AND NOBODY ELSE MAY, which is the whole of the new permission', async () => {
  // Not the owner, and not the person whose row it is. The store's row belongs to
  // p:ada; this is somebody else holding its id, and an id is not a capability.
  const { m, ctx } = harness()
  const stranger = { ...ctx({ id: 'r1', status: 'added' }), isOwner: false, owner: 'p:bob' }
  await assert.rejects(() => m['request.resolve'](stranger), /owner only/)
})

test('the library s owner still answers anybody s ask', async () => {
  const { m, ctx, events } = harness()
  const owner = { ...ctx({ id: 'r1', status: 'declined' }), owner: 'p:bob', isOwner: true }
  await m['request.resolve'](owner)
  assert.deepStrictEqual(events.map(e => e.kind), ['request:resolved'])
})

test('a request that is not there is refused BEFORE anything is written', async () => {
  // The row is read first now, because the permission depends on whose it is. A
  // missing one must not fall through to the write and must say what it is - not
  // found, rather than a permission the caller could go and get.
  const { m, ctx, resolved } = harness()
  await assert.rejects(() => m['request.resolve'](ctx({ id: 'gone', status: 'added' })), /no such request/)
  assert.deepStrictEqual(resolved, [], 'nothing was written')
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
