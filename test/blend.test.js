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

// THE SPANNING SHOW, the blend's flagship case: episode one lives on the
// friend, episode two on the local disk, and only the blend can say the
// season is two episodes long.
function spanEpisode (side, n) {
  return items.episode({
    id: side + 'ep' + n,
    seriesId: side + 'span',
    seasonId: side + 'spanS1',
    seriesTitle: 'The Span',
    seasonNumber: 1,
    episodeNumber: n,
    title: 'Part ' + n,
    runtime: 1500,
    media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', size: 90 }
  })
}
function spanSeries (side) {
  return items.series({ id: side + 'span', title: 'The Span', seasonCount: 1, episodeCount: 1 })
}

function adapterOf (rows, bytesById, { series = [], episodes = [] } = {}) {
  return {
    kind: 'test',
    async ping () { return { ok: true, detail: 'test' } },
    async scan () { return rows.length },
    async stats () { return { movies: rows.length, series: series.length, seasons: series.length, episodes: episodes.length, source: 'test' } },
    async list ({ type, seriesId = null, seasonId = null }) {
      if (type === 'movies') return items.page(rows, {})
      if (type === 'series') return items.page(series, {})
      if (type === 'episodes') {
        return items.page(episodes.filter((e) =>
          (!seriesId || e.seriesId === seriesId) && (!seasonId || e.seasonId === seasonId)
        ), {})
      }
      return items.page([], {})
    },
    async get ({ id }) {
      return rows.find((r) => r.id === id) || series.find((s) => s.id === id) ||
        episodes.find((e) => e.id === id) || null
    },
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
  friend.adapter = adapterOf([F_SHARED, F_ONLY], { fshared: REMOTE_BYTES, fonly: ONLY_BYTES }, {
    series: [spanSeries('f')], episodes: [spanEpisode('f', 1)]
  })
  await friend.ready()

  const desktop = new PearCinemaHost({
    dataDir: dirB, libraryName: 'The Desktop', bootstrap: testnet.bootstrap, log: () => {}
  })
  desktop.adapter = adapterOf([L_SHARED, L_ONLY], { lshared: LOCAL_BYTES }, {
    series: [spanSeries('l')], episodes: [spanEpisode('l', 2)]
  })
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

// THE SEASON-BOUNDARY NEIGHBOUR CAN LIVE ON THE OTHER HOST, which is the whole
// reason the blend answers this itself instead of asking the library that owns
// the id - that library would stop at the half it has. Straight against the
// index, because the walk is the claim and a two-host testnet proves nothing
// extra about it.
test('the blend walks a spanning show for the next episode, not one library', () => {
  const { Blend } = require('../host/blend')
  const merge = require('../src/merge')

  const ep = (over) => items.episode({
    seriesId: 'the-wire', seriesTitle: 'The Wire', seasonId: 'wire-s01',
    seasonNumber: 1, episodeNumber: 1, title: 'The Target', ...over
  })
  const blend = Object.create(Blend.prototype)
  blend.index = merge.buildIndex([
    { libraryId: 'A', episodes: [ep({ id: 'a1' }), ep({ id: 'a2', episodeNumber: 2, title: 'The Detail' })] },
    { libraryId: 'B', episodes: [ep({ id: 'b1', seasonId: 'wire-s02', seasonNumber: 2, episodeNumber: 1, title: 'Ebb Tide' })] }
  ])

  const last = blend.siblings('a2')
  assert.equal(last.next.title, 'Ebb Tide', 'the last of season one is followed by the first of season two')
  assert.equal(last.next.libraryId, 'B', 'even though that season is on the other host')
  assert.equal(last.prev.title, 'The Target')

  assert.equal(blend.siblings('a1').prev, null)
  assert.equal(blend.siblings('b1').next, null)
  // An id the blend does not hold is a null rather than two nulls: the caller
  // has to be able to tell "not merged" from "no neighbours" so it can fall
  // through to whichever library owns it.
  assert.equal(blend.siblings('nothing-here'), null)
})

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

  // A position on a remote-only film lands on its one copy through the fan
  // (phase 2 replaced phase 1's owner redirect with the fan-out).
  const rows = await (await get('/blend/api/library/list?type=movies&limit=100')).json()
  const only = rows.items.find((i) => i.title === 'City Lights')
  const w = await (await post('/blend/api/watch/position', { itemId: only.id, positionMs: 120000 })).json()
  assert.equal(w.ok, true)
  assert.equal(w.landed, 1)

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

test('the write fan and the merged rollups span the disk and the wire', { timeout: 120000 }, async (t) => {
  const { friend, desktop, get, post } = await rig(t)
  const { ownerOf } = require('@peerloom/host')

  await (await get('/api/blend')).json()

  // One show out of two halves: episode one on the friend, episode two on
  // this disk - only the blend can count to two.
  const shows = await (await get('/blend/api/library/list?type=series&limit=50')).json()
  assert.equal(shows.items.length, 1)
  const span = shows.items[0]
  assert.equal(span.episodeCount, 2)

  // Mark the whole SHOW watched through the blend: it expands to the merged
  // episodes and fans each to its own library - the friend's copy over the
  // wire, the local one into this box's own store.
  const marked = await (await post('/blend/api/watch/watched', { itemId: span.id })).json()
  assert.equal(marked.items, 2)

  const grant = (await friend.host.grants.list())[0]
  const friendSet = await friend.host.userState.watchedSet(ownerOf(grant))
  assert.ok(friendSet.has('fep1'), 'the friend heard about its half')
  const localPersons = await desktop.host.grants.listPersons()
  const localSet = await desktop.host.userState.watchedSet('p:' + localPersons[0].id)
  assert.ok(localSet.has('lep2'), 'the local store heard about its half')

  // The rollup agrees from both directions: complete on the show, complete
  // on the merged season.
  const rollups = await (await get('/blend/api/watch/shows')).json()
  assert.equal(rollups.shows[span.id].total, 2)
  assert.equal(rollups.shows[span.id].complete, true)
  const seasons = await (await get(`/blend/api/watch/seasons?seriesId=${span.id}`)).json()
  const season = Object.values(seasons.seasons)[0]
  assert.equal(season.total, 2)
  assert.equal(season.complete, true)

  // A position on the shared film lands on BOTH libraries - the shelf can
  // never disagree with itself depending on who answers first.
  const films = await (await get('/blend/api/library/list?type=movies&limit=100')).json()
  const sunrise = films.items.find((i) => i.title === 'Sunrise')
  const fanned = await (await post('/blend/api/watch/position', { itemId: sunrise.id, positionMs: 300000 })).json()
  assert.equal(fanned.landed, 2)
  const friendResume = await friend.host.userState.getResume(ownerOf(grant), 'fshared')
  assert.equal(friendResume.positionMs, 300000)
  const localResume = await desktop.host.userState.getResume('p:' + localPersons[0].id, 'lshared')
  assert.equal(localResume.positionMs, 300000)
})
