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

class FriendAdapter {
  constructor () { this.kind = 'test' }
  async ping () { return { ok: true, detail: 'test' } }
  async scan () { return 1 }
  async stats () { return { movies: 1, series: 0, seasons: 0, episodes: 0, source: 'test' } }
  async list ({ type }) { return type === 'movies' ? items.page([FILM], {}) : items.page([], {}) }
  async get ({ id }) { return id === FILM.id ? FILM : null }
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
    await friend.close()
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
