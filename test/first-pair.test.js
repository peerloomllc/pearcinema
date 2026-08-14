// FIRST PAIR. The test the shared-host proposal asks for by name.
//
// "PearCinema reaching first pair on the package before the PearTune migration
// merges. That is what makes it a package rather than a rename."
//
// So this stands up a real PearCinema host on @peerloom/host, dials it from a real
// device over a real DHT testnet, pairs, calls the video method table, streams
// bytes, and gets revoked. Nothing below the method table is faked.
//
// It also pins the isolation claim in both directions, which is the reason
// PearCinema picked its own topics: a PearTune phone must not reach a PearCinema
// host, and a PearCinema phone must not reach a PearTune one.

// NO HARDWARE PROBE IN HERE. ready() probes the box's video engine, and this
// machine may genuinely have one - which would make these tests' behaviour depend
// on whose laptop they run on. The probe has its own tests with the ffmpeg faked.
process.env.PEARCINEMA_TRANSCODE = 'off'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const Protomux = require('protomux')
const b4a = require('b4a')
const z32 = require('z32')
const { Readable } = require('streamx')

const { createProtocol } = require('@peerloom/host')
const { PearCinemaHost, PROTOCOL } = require('../host/server')
const items = require('../host/items')

const FILM = items.movie({
  id: 'metropolis',
  title: 'Metropolis',
  year: 1927,
  runtime: 9180,
  media: { container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080 }
})

const BYTES = b4a.from('METROPOLIS-FILM-BYTES')

// A stand-in source, standing in for Jellyfin and the folder adapter that follow.
// It answers the documented contract in normalized shapes, which is the point: the
// method table above it never learns which adapter it is talking to.
class TestAdapter {
  constructor () { this.kind = 'test' }
  async ping () { return { ok: true, detail: 'test' } }
  async scan () { return 1 }
  async stats () { return { movies: 1, series: 0, seasons: 0, episodes: 0 } }
  async list ({ type }) {
    return items.page(type === 'movies' ? [FILM] : [], {})
  }
  async get ({ id }) { return id === FILM.id ? FILM : null }
  async search ({ q }) {
    return { items: FILM.title.toLowerCase().includes(q.toLowerCase()) ? [FILM] : [] }
  }
  async art () { return null }
  async stream ({ itemId, offset = 0, length }) {
    if (itemId !== FILM.id) return null
    const end = length ? offset + length : BYTES.length
    return Readable.from([BYTES.subarray(offset, end)])
  }
}

async function cinema (t) {
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-'))

  const h = new PearCinemaHost({
    dataDir: dir,
    libraryName: 'The Cinema',
    bootstrap: testnet.bootstrap,
    log: () => {}
  })
  h.adapter = new TestAdapter()
  await h.ready()

  t.after(async () => {
    await h.close()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  return { h, testnet, dir }
}

function device (testnet) {
  const dht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const keyPair = HyperDHT.keyPair()
  return {
    dht,
    keyPair,
    publicKey: keyPair.publicKey,
    connect (hostKey) {
      const conn = dht.connect(hostKey, { keyPair })
      conn.on('error', () => {})
      return conn
    },
    destroy () { return dht.destroy() }
  }
}

function media (conn, libraryId, protocol = PROTOCOL) {
  const mux = Protomux.from(conn)
  const pending = new Map()
  const chunks = new Map()
  let nextId = 1
  const built = protocol.channels.mediaChannel(mux, {
    id: b4a.from(libraryId),
    onres: (m) => pending.get(m.id)?.({ kind: 'res', body: m.body }),
    onerr: (m) => pending.get(m.id)?.({ kind: 'err', code: m.code, message: m.message }),
    onchunk: (m) => {
      if (!chunks.has(m.id)) chunks.set(m.id, [])
      chunks.get(m.id).push(b4a.from(m.data))
    },
    onend: (m) => pending.get(m.id)?.({ kind: 'end', total: m.total, data: b4a.concat(chunks.get(m.id) || []) })
  })
  built.channel.open()
  return {
    call (method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 8000)
        pending.set(id, (v) => { clearTimeout(timer); resolve(v) })
        built.messages.req.send({ id, method, params })
      })
    }
  }
}

function pairThrough (conn, libraryId, link, dev, protocol = PROTOCOL) {
  const mux = Protomux.from(conn)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pairing timed out')), 8000)
    const built = protocol.channels.pairChannel(mux, {
      id: b4a.from(libraryId),
      onpaired: (m) => { clearTimeout(timer); resolve(m) }
    })
    built.channel.open()
    built.messages.hello.send({
      rv: protocol.link.parseLink(link).rv,
      deviceKey: dev.publicKey,
      label: 'Test Phone',
      platform: 'android'
    })
  })
}

const settle = (ms = 300) => new Promise(r => setTimeout(r, ms))

async function paired (t) {
  const { h, testnet } = await cinema(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const link = h.startPairing()
  const pairConn = dev.connect(h.publicKey)
  const ack = await pairThrough(pairConn, h.libraryId, link, dev)
  pairConn.destroy()
  await settle(200)

  return { h, testnet, dev, link, ack }
}

test('a device pairs with PearCinema and browses the library', async (t) => {
  const { h, dev, link, ack } = await paired(t)

  assert.ok(link.startsWith('pear://pearcinema/pair?'))
  assert.equal(ack.libraryId, h.libraryId)
  assert.equal(ack.libraryName, 'The Cinema')

  const conn = dev.connect(h.publicKey)
  const m = media(conn, h.libraryId)

  const pong = await m.call('ping')
  assert.equal(pong.body.app, 'pearcinema')
  assert.equal(pong.body.libraryId, h.libraryId)

  const stats = await m.call('library.stats')
  assert.equal(stats.body.movies, 1)
  assert.equal(stats.body.source, 'test')

  const films = await m.call('library.list', { type: 'movies' })
  assert.equal(films.body.total, 1)
  assert.equal(films.body.items[0].title, 'Metropolis')
  assert.equal(films.body.items[0].type, 'movie')

  const one = await m.call('library.get', { id: 'metropolis' })
  assert.equal(one.body.year, 1927)
  assert.equal(one.body.media.videoCodec, 'h264')

  const found = await m.call('library.search', { q: 'metro' })
  assert.equal(found.body.items.length, 1)

  const who = await m.call('identity.get')
  assert.equal(who.body.deviceName, 'Test Phone')
  assert.equal(who.body.libraryName, 'The Cinema')
  assert.equal(who.body.owner, false)

  conn.destroy()
})

test('a paired device streams a film, and SEEKS INTO IT', async (t) => {
  // The single biggest inherited win. media.stream already carried offset and
  // length, so seeking inside a two-hour film works on day one with no protocol
  // change - which is exactly why v1 can be direct-play only.
  const { h, dev } = await paired(t)

  const conn = dev.connect(h.publicKey)
  const m = media(conn, h.libraryId)

  const whole = await m.call('media.stream', { itemId: 'metropolis' })
  assert.equal(whole.kind, 'end')
  assert.ok(b4a.equals(whole.data, BYTES))

  const seeked = await m.call('media.stream', { itemId: 'metropolis', offset: 11 })
  assert.equal(b4a.toString(seeked.data), 'FILM-BYTES')

  const ranged = await m.call('media.stream', { itemId: 'metropolis', offset: 11, length: 4 })
  assert.equal(b4a.toString(ranged.data), 'FILM')

  conn.destroy()
})

test('REVOKE CUTS A PAIRED DEVICE OFF MID-CONNECTION', async (t) => {
  const { h, dev } = await paired(t)

  const conn = dev.connect(h.publicKey)
  const m = media(conn, h.libraryId)
  await m.call('ping')

  const closed = new Promise(r => conn.on('close', () => r('closed')))
  const { killed } = await h.revokeDevice(dev.publicKey)
  assert.ok(killed >= 1)

  assert.equal(await Promise.race([closed, settle(3000).then(() => 'alive')]), 'closed')

  const again = dev.connect(h.publicKey)
  const back = await Promise.race([
    new Promise(r => again.on('open', () => r('readmitted'))),
    new Promise(r => again.on('close', () => r('refused'))),
    settle(4000).then(() => 'refused')
  ])
  assert.equal(back, 'refused')
  again.destroy()
})

test('DEVICE.LEAVE ends this device\'s own access, with revoke\'s teeth', async (t) => {
  // "Remove this library" on the phone must end access HERE - not leave a live
  // grant behind a stale UI. Found missing by the first real client smoke test
  // (2026-08-14), which got "unknown method" where a PearTune phone gets a goodbye.
  const { h, dev } = await paired(t)

  const conn = dev.connect(h.publicKey)
  const m = media(conn, h.libraryId)
  const closed = new Promise(r => conn.on('close', () => r('closed')))

  const out = await m.call('device.leave')
  assert.equal(out.body?.ok ?? out.ok ?? (out.kind === 'res' ? out.body.ok : false), true)

  // The connection dies with the grant - leaving IS a revoke, self-inflicted.
  assert.equal(await Promise.race([closed, settle(3000).then(() => 'alive')]), 'closed')

  // And it stays ended: readmission is refused exactly as after an operator revoke.
  const again = dev.connect(h.publicKey)
  const back = await Promise.race([
    new Promise(r => again.on('open', () => r('readmitted'))),
    new Promise(r => again.on('close', () => r('refused'))),
    settle(4000).then(() => 'refused')
  ])
  assert.equal(back, 'refused')
  again.destroy()
})

test('the method table refuses what it does not understand, and survives', async (t) => {
  const { h, dev } = await paired(t)
  const conn = dev.connect(h.publicKey)
  const m = media(conn, h.libraryId)

  // A PearTune method. This host is not a music host and says so typedly.
  assert.equal((await m.call('speaker.volume', { level: 3 })).code, 'ENOMETHOD')
  assert.equal((await m.call('library.list', { type: 'albums' })).code, 'EBADPARAMS')

  // Episodes unscoped is a bad request, not a full-library dump.
  assert.equal((await m.call('library.list', { type: 'episodes' })).code, 'EBADPARAMS')
  assert.equal((await m.call('library.list', { type: 'seasons' })).code, 'EBADPARAMS')

  assert.equal((await m.call('library.get', { id: 'nope' })).code, 'ENOTFOUND')
  assert.equal((await m.call('media.stream', {})).code, 'EBADPARAMS')

  // The channel survived every one of them.
  assert.equal((await m.call('ping')).kind, 'res')
  conn.destroy()
})

test('CROSS-APP ISOLATION: a PearTune phone cannot reach a PearCinema host', async (t) => {
  // The reason PearCinema picked its own topics. A PearTune phone completes Noise,
  // opens a mux, asks for peartune/media/1, gets no channel, and goes away. Quiet
  // and total, with no half-connected state to reason about.
  const { h, dev } = await paired(t)
  const tune = createProtocol({ app: 'peartune', displayName: 'PearTune' })

  const conn = dev.connect(h.publicKey)
  const m = media(conn, h.libraryId, tune)

  const outcome = await Promise.race([
    m.call('ping').then(() => 'answered').catch(() => 'no-answer'),
    settle(3000).then(() => 'no-answer')
  ])
  assert.equal(outcome, 'no-answer', 'a PearTune channel must never open on a PearCinema host')

  // And the same device on the RIGHT protocol still works, so this is the protocol
  // being refused rather than the device.
  const right = media(dev.connect(h.publicKey), h.libraryId)
  assert.equal((await right.call('ping')).kind, 'res')
  conn.destroy()
})

test('a PearCinema pairing link cross-rejects, and PearTune\'s cross-rejects back', () => {
  const tune = createProtocol({ app: 'peartune', displayName: 'PearTune' })
  const rv = require('hypercore-crypto').randomBytes(32)
  const hostKey = require('hypercore-crypto').keyPair().publicKey

  const ours = PROTOCOL.link.encodeLink({ rv, hostKey })
  const theirs = tune.link.encodeLink({ rv, hostKey })

  assert.throws(() => tune.link.parseLink(ours), /invalid PearTune pairing link/)
  assert.throws(() => PROTOCOL.link.parseLink(theirs), /invalid PearCinema pairing link/)
  assert.equal(PROTOCOL.link.isPairLink(theirs), false)
})

test('PEARCINEMA BAKES IN NO RELAY KEY', () => {
  // Video at 8 Mbps is 3.6 GB/hour. One person watching two hours a day is
  // 216 GB/month by themselves, against the 500 GB/month tier PearTune's relay
  // sits on. A null key kills the path with no architectural change, and the
  // honest cost - no off-LAN path for a symmetric-NAT user - is disclosed rather
  // than papered over.
  assert.equal(PROTOCOL.relayKey, null)
  assert.equal(PROTOCOL.relayKeyBuffer, null)
  assert.equal(
    PROTOCOL.relay.relayThroughFor({
      force: true, randomized: true, useRelay: true, relayKey: PROTOCOL.relayKeyBuffer
    }),
    null
  )
})

test('an unpaired device gets nothing when no window is open', async (t) => {
  const { h, testnet } = await cinema(t)
  const dev = device(testnet)
  t.after(() => dev.destroy())

  const conn = dev.connect(h.publicKey)
  const outcome = await Promise.race([
    new Promise(r => conn.on('open', () => r('opened'))),
    new Promise(r => conn.on('close', () => r('refused'))),
    settle(4000).then(() => 'refused')
  ])
  assert.equal(outcome, 'refused')
})

test('a renamed library reaches every paired phone, and survives a restart', async (t) => {
  const { h, dev, testnet } = await paired(t)

  const conn = dev.connect(h.publicKey)
  const m = media(conn, h.libraryId)
  await m.call('ping')

  h.setLibraryName('Tim\'s Films')
  assert.equal((await m.call('identity.get')).body.libraryName, 'Tim\'s Films')
  conn.destroy()

  // The persisted rename wins over the constructor default on the next start.
  //
  // The second host's lifecycle is managed INLINE rather than in a t.after hook.
  // It opens a Corestore in the same directory the outer hook is about to delete,
  // and a store that is still open when the delete runs is an ENOTEMPTY on
  // store/db - RocksDB has files open that no amount of retrying will release.
  // That is exactly how this test failed: intermittently, in cleanup, pointing at
  // a directory rather than at anything it was testing.
  const dir = h.dataDir
  await h.close()

  const again = new PearCinemaHost({
    dataDir: dir,
    libraryName: 'ignored default',
    bootstrap: testnet.bootstrap,
    log: () => {}
  })
  assert.equal(again.libraryName, 'Tim\'s Films')
  await again.ready()
  await again.close()
})

test('a host with NO SOURCE still starts, still pairs, and says so', async (t) => {
  // A freshly installed host has no source until the operator picks one. It must
  // still come up and be pairable, or the operator is locked out of the very screen
  // they need in order to configure it.
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-bare-'))
  const h = new PearCinemaHost({ dataDir: dir, bootstrap: testnet.bootstrap, log: () => {} })
  await h.ready()

  const dev = device(testnet)
  t.after(async () => {
    await dev.destroy()
    await h.close()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  assert.equal(h.adapter.kind, 'empty')
  assert.equal(h.sourceError, null, 'no source is not the same as a broken source')

  const link = h.startPairing()
  const pairConn = dev.connect(h.publicKey)
  await pairThrough(pairConn, h.libraryId, link, dev)
  pairConn.destroy()
  await settle(200)

  const m = media(dev.connect(h.publicKey), h.libraryId)
  const stats = await m.call('library.stats')
  assert.equal(stats.body.movies, 0)
  assert.equal(stats.body.source, 'empty')

  const list = await m.call('library.list', { type: 'movies' })
  assert.deepEqual(list.body.items, [])
})
