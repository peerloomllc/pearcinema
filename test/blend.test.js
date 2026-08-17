// The blend (approved proposal 2026-08-17): the phone's merged index in the
// host process, local library plus remotes, served through /blend twins that
// answer from the index and redirect bytes and writes to the owning route.
//
// The engine itself is the phone's src/merge.js and carries its own tests;
// what is proven here is the DESKTOP plumbing: the local member, the
// local-wins pick, the redirects, and the unions.

process.env.PEARCINEMA_TRANSCODE = 'off'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const createTestnet = require('hyperdht/testnet')
const b4a = require('b4a')
const { Readable } = require('streamx')

const { PearCinemaHost } = require('../host/server')
const { startDashboard } = require('../host/ui/server')
const items = require('../host/items')

const REMOTE_BYTES = b4a.from('THE-FRIENDS-COPY-OF-THE-SHARED-FILM')
const LOCAL_BYTES = b4a.from('THE-LOCAL-COPY-WINS-EVERY-TIME')
const ONLY_BYTES = b4a.from('ONLY-ON-THE-FRIENDS-SHELF')

// The SHARED film exists on both sides under different ids - same title and
// year, which is the dedup key. Each side also holds one film of its own.
const F_SHARED = items.movie({
  id: 'fshared',
  title: 'Sunrise',
  year: 1927,
  runtime: 5700,
  media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', size: REMOTE_BYTES.length }
})
const F_ONLY = items.movie({
  id: 'fonly',
  title: 'City Lights',
  year: 1931,
  runtime: 5200,
  media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', size: ONLY_BYTES.length }
})
const L_SHARED = items.movie({
  id: 'lshared',
  title: 'Sunrise',
  year: 1927,
  runtime: 5700,
  // A poster, so the dedup's better-item rule makes the LOCAL copy primary -
  // which also makes the redirect assertions unambiguous.
  artId: 'localart',
  media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', size: LOCAL_BYTES.length }
})
const L_ONLY = items.movie({
  id: 'lonly',
  title: 'Metropolis',
  year: 1927,
  runtime: 8900,
  media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', size: 11 }
})

function adapterOf (rows, bytesById) {
  return {
    kind: 'test',
    async ping () { return { ok: true, detail: 'test' } },
    async scan () { return rows.length },
    async stats () { return { movies: rows.length, series: 0, seasons: 0, episodes: 0, source: 'test' } },
    async list ({ type }) { return type === 'movies' ? items.page(rows, {}) : items.page([], {}) },
    async get ({ id }) { return rows.find((r) => r.id === id) || null },
    async search ({ q }) { return { items: rows.filter((r) => r.title.toLowerCase().includes(String(q).toLowerCase())) } },
    async art () { return null },
    async subtitles () { return [] },
    async stream ({ itemId, offset = 0, length }) {
      const bytes = bytesById[itemId]
      if (!bytes) return null
      const end = length ? offset + length : bytes.length
      return Readable.from([bytes.subarray(offset, end)])
    }
  }
}

async function rig (t) {
  const testnet = await createTestnet(3)
  const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-bfriend-'))
  const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-bdesk-'))

  const friend = new PearCinemaHost({
    dataDir: dirA, libraryName: 'The Friend', bootstrap: testnet.bootstrap, log: () => {}
  })
  friend.adapter = adapterOf([F_SHARED, F_ONLY], { fshared: REMOTE_BYTES, fonly: ONLY_BYTES })
  await friend.ready()

  const desktop = new PearCinemaHost({
    dataDir: dirB, libraryName: 'The Desktop', bootstrap: testnet.bootstrap, log: () => {}
  })
  desktop.adapter = adapterOf([L_SHARED, L_ONLY], { lshared: LOCAL_BYTES })
  await desktop.ready()

  const dash = await startDashboard({
    host: desktop, bind: '127.0.0.1', port: 0, password: '', passwordSource: 'none'
  })

  t.after(async () => {
    await dash.close()
    await desktop.close()
    await friend.close().catch(() => {})
    await testnet.destroy()
    await fsp.rm(dirA, { recursive: true, force: true })
    await fsp.rm(dirB, { recursive: true, force: true })
  })

  const base = `http://127.0.0.1:${dash.port}`
  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' })
  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual'
    })
    return res
  }

  const link = friend.startPairing()
  const pairRes = await fetch(base + '/api/remote/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ link })
  })
  const paired = await pairRes.json()

  return { friend, desktop, base, get, post, lib: paired.libraryId }
}

test('the blend dedupes across the local disk and the wire, and local wins', { timeout: 120000 }, async (t) => {
  const { desktop, base, get, lib } = await rig(t)

  const state = await (await get('/api/blend')).json()
  assert.equal(state.available, true)
  assert.equal(state.libraries.length, 2)

  // Four films, three entities: Sunrise collapsed to one with two copies.
  const rows = await (await get('/blend/api/library/list?type=movies&limit=100')).json()
  assert.equal(rows.items.length, 3)
  const sunrise = rows.items.find((i) => i.title === 'Sunrise')
  assert.equal(sunrise.copies.length, 2)

  // THE PICK: the shared film streams from THIS disk, whatever copy is
  // primary - a 307 aimed at the local route with the local id.
  const shared = await get(`/blend/api/stream?id=${sunrise.id}`)
  assert.equal(shared.status, 307)
  assert.equal(shared.headers.get('location'), '/api/stream?id=lshared')

  // A remote-only film routes to the friend's twin with the friend's id.
  const only = rows.items.find((i) => i.title === 'City Lights')
  const rstream = await get(`/blend/api/stream?id=${only.id}`)
  assert.equal(rstream.status, 307)
  assert.equal(rstream.headers.get('location'), `/remote/${lib}/api/stream?id=fonly`)

  // Following the redirect the way a browser would lands on real bytes.
  const followed = await fetch(base + rstream.headers.get('location'))
  assert.equal(b4a.toString(b4a.from(await followed.arrayBuffer())), b4a.toString(ONLY_BYTES))

  // Search covers everything, once.
  const found = await (await get('/blend/api/library/search?q=sunrise')).json()
  assert.equal(found.items.length, 1)

  // Downloading a film already on this disk is refused honestly; a
  // remote-only one is a real download of the friend's copy.
  const refuse = await (await fetch(base + '/blend/api/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: sunrise.id })
  })).json()
  assert.match(refuse.error, /already on this machine/)

  // The pick survives the primary being local: pickCopy said local, so the
  // desktop's own blend agrees with what the route did.
  const pick = desktop.blend.pickCopy(sunrise.id)
  assert.equal(pick.local, true)
  assert.equal(pick.id, 'lshared')
})

test('watch state reads as one union with ids translated to the shown copy', { timeout: 120000 }, async (t) => {
  const { friend, get, post, lib } = await rig(t)

  await (await get('/api/blend')).json()

  // A position lands on the FRIEND's copy of the shared film over the wire
  // (the write redirect in action: the blend hands the POST to the owner).
  const rows = await (await get('/blend/api/library/list?type=movies&limit=100')).json()
  const only = rows.items.find((i) => i.title === 'City Lights')
  const w = await post('/blend/api/watch/position', { itemId: only.id, positionMs: 120000 })
  assert.equal(w.status, 307)
  assert.equal(w.headers.get('location'), `/remote/${lib}/api/watch/position`)
  // Follow it the way a browser replays a 307.
  await fetch((await get('/api/state')).url.replace('/api/state', '') + w.headers.get('location'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: only.id, positionMs: 120000 })
  })

  // Mark the friend's copy of SUNRISE watched directly on the friend - the
  // union must light the tick on the id the blend SHOWS (the local primary).
  const sunrise = rows.items.find((i) => i.title === 'Sunrise')
  const friendCopy = sunrise.copies.find((c) => c.id === 'fshared')
  assert.ok(friendCopy)
  const dev = (await friend.host.grants.list())[0]
  const { ownerOf } = require('@peerloom/host')
  await friend.host.userState.setWatched(ownerOf(dev), 'fshared', true, { auto: false })

  const state = await (await get('/blend/api/watch/state')).json()
  assert.ok(state.watched.includes(sunrise.id), 'watched id translated to the primary')
  assert.equal(state.continue.length, 1)
  assert.equal(state.continue[0].id, only.id)
  assert.equal(state.continue[0].resume.positionMs, 120000)
})
