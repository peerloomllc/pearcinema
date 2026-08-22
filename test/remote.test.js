// THE DESKTOP AS A CLIENT (proposal 2026-08-16-desktop-client): one machine's
// dashboard browsing and streaming ANOTHER host's library over a real DHT
// testnet, through the /remote/<lib>/ twins. Two whole PearCinemaHosts, one
// with the films and one - the "desktop" - with nothing but a paste-to-pair.

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

const BYTES = b4a.from('NOSFERATU-FILM-BYTES-FOR-THE-DESKTOP')

const FILM = items.movie({
  id: 'nosferatu',
  title: 'Nosferatu',
  year: 1922,
  runtime: 5700,
  media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, size: BYTES.length }
})

// A small show beside the film, for the phase 2 rollups: two episodes in one
// season, enough to tell "one watched" from "complete".
const SHOW = items.series({ id: 'show1', title: 'The Show', seasonCount: 1, episodeCount: 2 })
const SEASON = items.season({ id: 'sea1', seriesId: 'show1', number: 1 })
const EPS = [1, 2].map((n) => items.episode({
  id: 'ep' + n,
  seriesId: 'show1',
  seasonId: 'sea1',
  seasonNumber: 1,
  episodeNumber: n,
  title: 'Episode ' + n,
  runtime: 1200,
  media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', size: 100 }
}))

const ALL = new Map([FILM, SHOW, SEASON, ...EPS].map((i) => [i.id, i]))

class FriendAdapter {
  constructor () { this.kind = 'test' }
  async ping () { return { ok: true, detail: 'test' } }
  async scan () { return 1 }
  async stats () { return { movies: 1, series: 1, seasons: 1, episodes: 2, source: 'test' } }
  async list ({ type, seriesId = null, seasonId = null }) {
    if (type === 'movies') return items.page([FILM], {})
    if (type === 'series') return items.page([SHOW], {})
    if (type === 'seasons') return items.page(seriesId === SHOW.id ? [SEASON] : [], {})
    if (type === 'episodes') {
      return items.page(EPS.filter((e) =>
        (!seriesId || e.seriesId === seriesId) && (!seasonId || e.seasonId === seasonId)
      ), {})
    }
    return items.page([], {})
  }

  async get ({ id }) { return ALL.get(id) || null }
  async search ({ q }) { return { items: FILM.title.toLowerCase().includes(String(q).toLowerCase()) ? [FILM] : [] } }
  async art () { return null }
  async subtitles () { return [] }
  async stream ({ itemId, offset = 0, length }) {
    if (itemId !== FILM.id) return null
    const end = length ? offset + length : BYTES.length
    return Readable.from([BYTES.subarray(offset, end)])
  }
}

class EmptyAdapter {
  constructor () { this.kind = 'empty' }
  async ping () { return { ok: true, detail: 'empty' } }
  async scan () { return 0 }
  async stats () { return { movies: 0, series: 0, seasons: 0, episodes: 0, source: 'empty' } }
  async list () { return items.page([], {}) }
  async get () { return null }
  async search () { return { items: [] } }
  async art () { return null }
}

async function rig (t) {
  const testnet = await createTestnet(3)
  const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-friend-'))
  const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-desktop-'))

  const friend = new PearCinemaHost({
    dataDir: dirA, libraryName: 'The Friend', bootstrap: testnet.bootstrap, log: () => {}
  })
  friend.adapter = new FriendAdapter()
  await friend.ready()

  const desktop = new PearCinemaHost({
    dataDir: dirB, libraryName: 'The Desktop', bootstrap: testnet.bootstrap, log: () => {}
  })
  desktop.adapter = new EmptyAdapter()
  await desktop.ready()

  const dash = await startDashboard({
    host: desktop, bind: '127.0.0.1', port: 0, password: '', passwordSource: 'none'
  })

  t.after(async () => {
    await dash.close()
    await desktop.close()
    // Tolerates a test that already closed the friend on purpose - the
    // downloads test does, to prove a kept film outlives its library.
    await friend.close().catch(() => {})
    await testnet.destroy()
    await fsp.rm(dirA, { recursive: true, force: true })
    await fsp.rm(dirB, { recursive: true, force: true })
  })

  const base = `http://127.0.0.1:${dash.port}`
  const get = async (p, headers = {}) => {
    const res = await fetch(base + p, { headers })
    return res
  }
  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    return res.json()
  }

  return { friend, desktop, base, get, post }
}

test('the desktop pairs to a friend, browses, streams by range and leaves', { timeout: 120000 }, async (t) => {
  const { friend, post, get } = await rig(t)

  // Paste-to-pair, exactly what the wizard's friend fork sends.
  const link = friend.startPairing()
  const paired = await post('/api/remote/pair', { link })
  assert.equal(paired.libraryName, 'The Friend')
  const lib = paired.libraryId
  assert.ok(lib)

  // The list names it. `online` is false here and that is honest: pairing's
  // transient client closed, and a live connection exists only once something
  // is asked of it.
  const listed = await (await get('/api/remote/list')).json()
  assert.equal(listed.remotes.length, 1)
  assert.equal(listed.remotes[0].libraryName, 'The Friend')
  assert.equal(listed.remotes[0].online, false)

  // Browse through the twin - the same shape the local route answers - and the
  // call is what dials, so the list says online AFTERWARDS.
  const rows = await (await get(`/remote/${lib}/api/library/list?type=movies&limit=100`)).json()
  assert.equal(rows.items.length, 1)
  assert.equal(rows.items[0].title, 'Nosferatu')
  const relisted = await (await get('/api/remote/list')).json()
  assert.equal(relisted.remotes[0].online, true)

  const found = await (await get(`/remote/${lib}/api/library/search?q=nosfer`)).json()
  assert.equal(found.items.length, 1)

  // The film itself, a real Range honoured over the wire.
  const whole = await get(`/remote/${lib}/api/stream?id=${FILM.id}`)
  assert.equal(whole.status, 200)
  assert.equal(b4a.toString(b4a.from(await whole.arrayBuffer())), b4a.toString(BYTES))

  const part = await get(`/remote/${lib}/api/stream?id=${FILM.id}`, { range: 'bytes=10-19' })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${BYTES.length}`)
  assert.equal(b4a.toString(b4a.from(await part.arrayBuffer())), b4a.toString(BYTES.subarray(10, 20)))

  // Watch state lives on the FRIEND's host - written there, read back from there.
  await post(`/remote/${lib}/api/watch/position`, { itemId: FILM.id, positionMs: 90000 })
  const w = await (await get(`/remote/${lib}/api/watch/state`)).json()
  assert.equal(w.continue.length, 1)
  assert.equal(w.continue[0].id, FILM.id)
  assert.equal(w.continue[0].resume.positionMs, 90000)

  // Leave: gone from the list, and the twins refuse.
  await post('/api/remote/remove', { hostKey: listed.remotes[0].hostKey })
  const after = await (await get('/api/remote/list')).json()
  assert.equal(after.remotes.length, 0)
  const refused = await get(`/remote/${lib}/api/library/list?type=movies`)
  assert.equal(refused.status, 404)
})

test('an unknown remote id is a 404, not a hang', { timeout: 60000 }, async (t) => {
  const { get } = await rig(t)
  const res = await get('/remote/nope/api/library/list?type=movies')
  assert.equal(res.status, 404)
})

// Wait for a condition, politely - downloads land on their own schedule.
async function until (fn, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn()
    if (v) return v
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('timed out waiting')
}

test('a downloaded film is byte-exact and outlives the friend', { timeout: 120000 }, async (t) => {
  const { friend, desktop, post, get } = await rig(t)

  const link = friend.startPairing()
  const paired = await post('/api/remote/pair', { link })
  const lib = paired.libraryId

  // The friend decides raw-or-converted with the same decide() playback uses;
  // a browser that takes the container as-is gets the original bytes.
  const started = await post(`/remote/${lib}/api/download`, {
    itemId: FILM.id,
    capabilities: { containers: ['mp4', 'mov'], videoCodecs: ['h264'], audioCodecs: ['aac'] }
  })
  assert.equal(started.ok, true)

  const row = await until(async () => {
    const r = await (await get('/api/downloads')).json()
    const d = (r.items || []).find((x) => x.itemId === FILM.id)
    return d && !d.downloading ? d : null
  })
  assert.equal(row.size, BYTES.length)
  assert.equal(row.title, 'Nosferatu')

  // THE POINT OF A DOWNLOAD: the friend goes dark and the film still plays,
  // Range and all, because nothing in the kept path touches the wire.
  await friend.close()

  const part = await get(`/remote/${lib}/api/stream?id=${FILM.id}`, { range: 'bytes=10-19' })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${BYTES.length}`)
  assert.equal(b4a.toString(b4a.from(await part.arrayBuffer())), b4a.toString(BYTES.subarray(10, 20)))

  const whole = await get(`/remote/${lib}/api/stream?id=${FILM.id}`)
  assert.equal(whole.status, 200)
  assert.equal(b4a.toString(b4a.from(await whole.arrayBuffer())), b4a.toString(BYTES))

  // Remove: the file and the row both go.
  await post('/api/downloads/remove', { itemId: FILM.id })
  const after = await (await get('/api/downloads')).json()
  assert.equal(after.items.length, 0)
  assert.equal(desktop.downloads.fileFor(FILM.id), null)
})

test('requests and the rollups travel the wire', { timeout: 120000 }, async (t) => {
  const { friend, post, get } = await rig(t)

  const link = friend.startPairing()
  const paired = await post('/api/remote/pair', { link })
  const lib = paired.libraryId

  // Ask the friend for what is not there, see it, withdraw it.
  const asked = await post(`/remote/${lib}/api/request`, { kind: 'movie', name: 'The General' })
  assert.ok(asked.request?.id)
  const mine = await (await get(`/remote/${lib}/api/requests`)).json()
  assert.equal(mine.items.length, 1)
  assert.equal(mine.items[0].name, 'The General')
  assert.equal(mine.items[0].status, 'pending')
  // And it genuinely landed on the FRIEND's host, where their devices answer it.
  assert.equal((await friend.userState.listRequests()).length, 1)
  await post(`/remote/${lib}/api/request/remove`, { id: asked.request.id })
  assert.equal((await (await get(`/remote/${lib}/api/requests`)).json()).items.length, 0)

  // One episode watched: the show's rollup knows, over the wire.
  await post(`/remote/${lib}/api/watch/watched`, { itemId: 'ep1' })
  const shows = await (await get(`/remote/${lib}/api/watch/shows`)).json()
  assert.equal(shows.shows.show1.total, 2)
  assert.equal(shows.shows.show1.watched, 1)
  assert.equal(shows.shows.show1.complete, false)
  const seasons = await (await get(`/remote/${lib}/api/watch/seasons?seriesId=show1`)).json()
  assert.equal(seasons.seasons.sea1.watched, 1)

  // Marking the SEASON marks its episodes - the local route's rule, fanned
  // over the wire because watched.set is per item.
  const marked = await post(`/remote/${lib}/api/watch/watched`, { itemId: 'sea1' })
  assert.equal(marked.items, 2)
  const done = await (await get(`/remote/${lib}/api/watch/shows`)).json()
  assert.equal(done.shows.show1.complete, true)

  // The LOCAL twins answer honestly rather than 404.
  const local = await post('/api/download', { itemId: FILM.id })
  assert.match(local.error, /already on this machine/)
  assert.equal((await (await get('/api/requests')).json()).items.length, 0)
})

test('ONE QUEUE ACROSS YOUR MACHINES, and answering it reaches them all', { timeout: 120000 }, async (t) => {
  // A request is filed with EVERY library the person can reach, and only the machine
  // that answers writes it down. So answering on one dashboard used to leave the ask
  // pending on the other, and one owner could add a film the other had already added
  // (Tim, 2026-08-21). The phone's half shipped in #159; this is the dashboards'.
  const { friend, desktop, post, get } = await rig(t)

  // Paired as an OWNER of the other machine, which is what "your other machine" means -
  // `request.all` is owner-only, and a library this one is merely a guest of stays out
  // of the queue by that rule alone.
  const link = friend.startPairing({ owner: true })
  const paired = await post('/api/remote/pair', { link })
  assert.ok(paired.libraryId)

  // The same ask on both machines, as a phone would file it.
  await friend.userState.addRequest('p:ada', { kind: 'movie', name: 'The General' })
  await desktop.userState.addRequest('p:ada', { kind: 'movie', name: 'The General' })

  const queue = await (await get('/api/asked')).json()
  assert.equal(queue.items.length, 1, 'one ask, not one per machine')
  const row = queue.items[0]
  assert.equal(row.name, 'The General')
  assert.equal(row.status, 'pending')
  assert.equal(row.refs.length, 2, 'carrying both copies')
  assert.deepEqual(row.libraries.sort(), ['The Desktop', 'The Friend'], 'and saying where they are')

  // Answer it here, once.
  const answered = await post('/api/asked/resolve', { id: row.id, status: 'added', refs: row.refs })
  assert.ok(!answered.error, answered.error)

  // BOTH stores say added - the point of the whole exercise.
  assert.equal((await desktop.userState.listRequests())[0].status, 'added')
  assert.equal((await friend.userState.listRequests())[0].status, 'added', 'the other machine heard it too')

  // And the queue reads as done rather than showing it again.
  const after = await (await get('/api/asked')).json()
  assert.equal(after.items.length, 1)
  assert.equal(after.items[0].status, 'added')
})

test('A DECLINE ON ONE MACHINE IS NOT AN ANSWER FOR THE OTHER', { timeout: 120000 }, async (t) => {
  // The same rule the phone follows: one owner declining is their answer about their
  // own library, and the fan-out only touches copies still PENDING. Here the other
  // machine has already added it, and an operator declining locally must not rewrite
  // that.
  const { friend, desktop, post, get } = await rig(t)
  const link = friend.startPairing({ owner: true })
  await post('/api/remote/pair', { link })

  const there = await friend.userState.addRequest('p:ada', { kind: 'movie', name: 'Stalker' })
  await friend.userState.resolveRequest(there.id, 'added')
  await desktop.userState.addRequest('p:ada', { kind: 'movie', name: 'Stalker' })

  const queue = await (await get('/api/asked')).json()
  assert.equal(queue.items.length, 1, 'one row, both machines')
  const row = queue.items[0]
  assert.equal(row.refs.length, 2, 'and it knows about both copies, or the guard below proves nothing')
  assert.equal(row.status, 'pending', 'the owner queue folds pending-first: there is still work here')

  await post('/api/asked/resolve', { id: row.id, status: 'declined', refs: row.refs })
  assert.equal((await desktop.userState.listRequests())[0].status, 'declined')
  assert.equal((await friend.userState.listRequests())[0].status, 'added', 'their answer stands')
})

// --- news that arrives on its own -------------------------------------------
//
// The dashboard had a 10s poll standing in for pushes on the requests card, and
// the client underneath it wired no onPush at all - so an answer from a friend
// reached this machine and was dropped. These two cover the channel that
// replaced it: the route that carries news to an open page, and the plumbing
// that gets a friend's push onto it.

// Reads server-sent events off a held-open response. Returns { next, stop }:
// `next` resolves with the first frame whose kind matches, so a test says what
// it is waiting for rather than counting frames it did not ask about.
async function listen (base, path = '/api/events') {
  const ctrl = new AbortController()
  const res = await fetch(base + path, { signal: ctrl.signal })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const frames = []
  const waiters = []
  const pump = (async () => {
    let buf = ''
    const dec = new TextDecoder()
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop()
      for (const p of parts) {
        const line = p.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue // a heartbeat comment, which is not news
        const m = JSON.parse(line.slice(6))
        frames.push(m)
        for (const w of waiters.splice(0)) w(m)
      }
    }
  })().catch(() => {})

  return {
    async next (kind, ms = 15000) {
      const found = frames.find((f) => f.kind === kind)
      if (found) return found
      return await Promise.race([
        new Promise((resolve) => {
          const check = (m) => { if (m.kind === kind) resolve(m); else waiters.push(check) }
          waiters.push(check)
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no ' + kind + ' frame in ' + ms + 'ms')), ms).unref())
      ])
    },
    stop () { ctrl.abort(); return pump }
  }
}

test('the live channel carries this host s own news to an open page', { timeout: 120000 }, async (t) => {
  const { desktop, base } = await rig(t)
  const ev = await listen(base)
  t.after(() => ev.stop())

  // What host/methods.js calls when a phone asks THIS box for something. The
  // dashboard is not a paired device, so this hook is the only thing that tells
  // it - which is exactly why an operator's own browser saw nothing.
  assert.equal(typeof desktop.onevent, 'function')
  desktop.onevent('request:created', { id: 'r1', name: 'Solaris', kind: 'movie', count: 1 })

  const m = await ev.next('request:created')
  assert.deepEqual(m.data, { id: 'r1', name: 'Solaris', kind: 'movie', count: 1 })
})

test('a friend s answer reaches this machine s page instead of the floor', { timeout: 120000 }, async (t) => {
  const { friend, base, post } = await rig(t)

  const link = friend.startPairing()
  const paired = await post('/api/remote/pair', { link })
  const lib = paired.libraryId

  const asked = await post(`/remote/${lib}/api/request`, { kind: 'movie', name: 'The General' })
  assert.ok(asked.request?.id)

  // Listen only AFTER the ask, so the frame under test cannot be an echo of it.
  const ev = await listen(base)
  t.after(() => ev.stop())

  // The friend's owner answers. Whoever asked hears about it wherever they are
  // signed in - and this machine is one of those places.
  const row = (await friend.userState.listRequests())[0]
  assert.ok(row.requester, 'the ask carries who made it')
  friend.host.presence.notifyOwner(row.requester, 'request:resolved', {
    id: row.id, title: 'The General', status: 'declined'
  })

  const m = await ev.next('request:resolved')
  assert.equal(m.data.status, 'declined')
  assert.equal(m.data.title, 'The General')
  // Tagged with which library answered, since a page may be paired with several.
  assert.equal(m.data.libraryId, lib)
})
