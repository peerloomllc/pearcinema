// device.revoke: the owner's kill, reached over the wire. The pins: owner
// scope comes off the connection (never a parameter), a device cannot revoke
// itself this way, and the hook receives exactly the target key. The kill
// mechanics themselves are revokeDevice's, hardware-proven separately.

const test = require('node:test')
const assert = require('node:assert')
const { createMethods } = require('../host/methods')

const ctxFor = (over = {}) => ({
  params: {},
  deviceKey: 'me-key',
  isOwner: false,
  forbidden: (m) => Object.assign(new Error(m), { code: 'EFORBIDDEN' }),
  badParams: (m) => Object.assign(new Error(m), { code: 'EBADPARAMS' }),
  notFound: (m) => Object.assign(new Error(m), { code: 'ENOTFOUND' }),
  ...over
})

test('device.revoke is owner-gated, self-refusing, and hands the hook the target', async () => {
  const seen = []
  const m = createMethods({
    getAdapter: () => ({}),
    getLibraryName: () => 'L',
    revoke: async (k) => { seen.push(k); return { killed: 1 } }
  })

  await assert.rejects(() => m['device.revoke'](ctxFor({ params: { deviceKey: 'victim' } })), /owner only/)
  await assert.rejects(() => m['device.revoke'](ctxFor({ isOwner: true, params: { deviceKey: 'me-key' } })), /device.leave/)
  await assert.rejects(() => m['device.revoke'](ctxFor({ isOwner: true, params: {} })), /deviceKey required/)

  const out = await m['device.revoke'](ctxFor({ isOwner: true, params: { deviceKey: 'victim' } }))
  assert.deepStrictEqual(out, { ok: true, killed: 1 })
  assert.deepStrictEqual(seen, ['victim'])
})

test('a host composed without the hook refuses rather than pretending', async () => {
  const m = createMethods({ getAdapter: () => ({}), getLibraryName: () => 'L' })
  await assert.rejects(() => m['device.revoke'](ctxFor({ isOwner: true, params: { deviceKey: 'x' } })), /cannot revoke/)
})
