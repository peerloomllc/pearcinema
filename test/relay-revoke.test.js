// REVOKE CUTS A RELAY-CARRIED STREAM. The relay proposal's verify item 4, and the one
// claim on that list I would least like to leave to reasoning.
//
// Why it needs its own test rather than riding first-pair's revoke test. A relay is a
// third party holding a socket to BOTH ends of a live connection. `connections.kill()`
// destroys the host's end - and the honest question is whether anything on the relayed
// path keeps a stream alive past that: hyperdht deliberately keeps a failed connection
// alive while a relay socket exists (`maybeDestroyEncryptedSocket` returns early on
// `if (c.relaySocket) return`), which is the behaviour that makes a relay useful and
// exactly the shape of thing that could make a revoke soft.
//
// HOW A GENUINELY RELAYED CONNECTION IS BUILT HERE, because a testnet cannot make a
// hole-punch fail (PearTune found this in July: on loopback every peer punches, so
// `dht.connect(key, { relayThrough })` goes direct despite the offer, and a test written
// that way proves nothing about the relay). So the transport is assembled by hand, the
// same way hyperdht assembles it internally in `relayConnection`:
//
//   1. a real blind-relay node on a real DHT testnet
//   2. both ends dial IT and pair on a shared token - this is the relay's actual job
//   3. each end connects its raw udx stream to the relay-allocated stream
//   4. a Noise stream is wrapped over each raw stream, so the host still authenticates
//      the device by key exactly as it does over a punched connection
//   5. the host's own `_onconnection` takes the server end, and the device speaks the
//      real media protocol over the client end
//
// Every byte in this test therefore passes through the relay process. Nothing about the
// grant model, the method table or the kill is faked or bypassed.
//
// THREE TRAPS, all of which present as "the file times out with no failing test", which is
// a uniquely unhelpful way to fail. Recorded because the next relay test will meet them:
//   1. A relayed udx stream only learns where its peer is when that peer SENDS, so an
//      initiator-first Noise handshake deadlocks. See teachTheRelay.
//   2. The relay's forwarding streams and sessions need error handlers. An unhandled
//      ECONNRESET when a peer vanishes takes the process down mid-teardown.
//   3. Teardown is ordered: relay streams, then the relay server, then the DHTs, then the
//      testnet last - a DHT destroyed after its bootstrap has gone waits forever.

process.env.PEARCINEMA_TRANSCODE = 'off'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const Protomux = require('protomux')
const blindRelay = require('blind-relay')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const { Readable } = require('streamx')

const { PearCinemaHost, PROTOCOL } = require('../host/server')
const items = require('../host/items')

const FILM = items.movie({
  id: 'metropolis',
  title: 'Metropolis',
  year: 1927,
  runtime: 9180,
  media: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080 }
})

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms))

// A film that never ends, so there is always a stream in flight to cut. Chunks land
// every 25ms: fast enough that the test is quick, slow enough that a revoke arrives
// mid-film rather than after it.
function endlessFilm () {
  let stopped = false
  const stream = new Readable({
    read (cb) {
      if (stopped) return cb(null)
      setTimeout(() => {
        this.push(b4a.alloc(4096, 7))
        cb(null)
      }, 25)
    },
    destroy (cb) { stopped = true; cb(null) }
  })
  return stream
}

class EndlessAdapter {
  constructor () { this.kind = 'test' }
  async ping () { return { ok: true, detail: 'test' } }
  async scan () { return 1 }
  async stats () { return { movies: 1, series: 0, seasons: 0, episodes: 0 } }
  async list ({ type }) { return items.page(type === 'movies' ? [FILM] : [], {}) }
  async get ({ id }) { return id === FILM.id ? FILM : null }
  async search () { return { items: [] } }
  async art () { return null }
  async stream ({ itemId }) { return itemId === FILM.id ? endlessFilm() : null }
}

// The blind relay, in the shape PearTune's relay/relay.js runs in production: a DHT
// server with NO firewall - it is open by construction, because it forwards ciphertext
// for anyone holding a valid token and holds no key to what it carries.
async function relayNode (t, testnet) {
  const keyPair = HyperDHT.keyPair(hcrypto.randomBytes(32))
  const dht = new HyperDHT({ bootstrap: testnet.bootstrap })
  // Every stream the relay allocates for forwarding is remembered, because the DHT will
  // not destroy while it still holds them - see the teardown below.
  const streams = new Set()
  const server = new blindRelay.Server({
    createStream: (opts) => {
      const s = dht.createRawStream(opts)
      // A peer vanishing mid-relay is normal - and an unhandled ECONNRESET here does not
      // just log, it takes the process down and makes teardown look like a hang.
      s.on('error', () => {})
      streams.add(s)
      s.on('close', () => streams.delete(s))
      return s
    }
  })
  const sessions = new Set()

  const node = dht.createServer({ firewall: () => false }, (conn) => {
    conn.on('error', () => {})
    // `id` MUST be the dialing peer's own public key: that is the key it opened its
    // Protomux channel under, so from this side it is conn.remotePublicKey. A mismatch
    // means the channel never opens and no pairing ever happens.
    const session = server.accept(conn, { id: conn.remotePublicKey })
    session.on('error', () => {})
    sessions.add(session)
    session.on('close', () => sessions.delete(session))
  })
  await node.listen(keyPair)

  // Order matters, and PearTune's RelayNode.close learned it the same way: the RELAY
  // closes first (which ends its sessions and tears down the live links it is forwarding),
  // then the DHT server, then the node. Destroying the DHT while it still holds forwarding
  // streams simply never returns.
  t.after(async () => {
    for (const s of sessions) { try { s.destroy() } catch {} }
    for (const s of streams) { try { s.destroy() } catch {} }
    try { await server.close() } catch {}
    try { await node.close() } catch {}
    try { await dht.destroy({ force: true }) } catch {}
  })

  return { publicKey: keyPair.publicKey, server }
}

// One end of a relayed pair: dial the relay, pair on the token, and point a raw stream
// at the stream the relay allocated for us. Lifted from the shape hyperdht uses in
// lib/connect.js relayConnection, minus the hole-punch it is standing in for.
async function throughRelay (t, dht, relayKey, token, isInitiator) {
  const socket = dht.connect(relayKey)
  socket.on('error', () => {})
  const client = blindRelay.Client.from(socket, { id: socket.publicKey })
  const raw = dht.createRawStream()

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay pairing timed out')), 10000)
    client.pair(isInitiator, token, raw)
      .on('error', (err) => { clearTimeout(timer); reject(err) })
      .on('data', (remoteId) => {
        clearTimeout(timer)
        const { remotePort, remoteHost, socket: s } = socket.rawStream
        raw.connect(s, remoteId, remotePort, remoteHost)
        resolve()
      })
  })

  return { raw, socket }
}

// THE DEADLOCK THIS AVOIDS, which cost an hour to find. A relayed udx stream only learns
// where a peer is when that peer SENDS - blind-relay's firewall hook is what teaches it -
// so the side that speaks first is unreachable until the other side has spoken. A Noise
// handshake is initiator-first, so wrapping the pair straight away hangs forever: the
// initiator's first message has nowhere to go.
//
// hyperdht never hits this because a relayed connection there is built AFTER the DHT has
// already carried the handshake, so both ends have something to send immediately. Here an
// unreliable probe on each end does the same job without touching the reliable stream the
// Noise framing rides on.
function teachTheRelay (...raws) {
  for (const raw of raws) raw.send(b4a.from([0]))
}

// EVERY relayed handle, closed IN THE TEST BODY rather than in an after-hook. The host's
// close() waits on its live connections, so a connection still open when the after-hooks
// run makes the whole FILE hang after its last passing assertion - which reports as a
// timeout with no failed test, and is a genuinely confusing way to lose an afternoon.
function teardown (...handles) {
  for (const h of handles) { try { h.destroy() } catch {} }
}

// The testnet is passed IN rather than created here, because teardown order turned out to
// matter more than it looks: node runs after-hooks in the order they were registered, and
// a DHT destroyed AFTER its bootstrap has gone waits forever on a network that is no
// longer there. Every DHT in a test must therefore be torn down before the testnet, which
// means the testnet's own hook has to be registered last.
async function cinema (t, testnet) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-relay-'))

  const h = new PearCinemaHost({
    dataDir: dir,
    libraryName: 'The Cinema',
    bootstrap: testnet.bootstrap,
    log: () => {}
  })
  h.adapter = new EndlessAdapter()
  await h.ready()

  t.after(async () => {
    await h.close()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  return { h }
}

function pairThrough (conn, libraryId, link, deviceKey) {
  const mux = Protomux.from(conn)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pairing timed out')), 8000)
    const built = PROTOCOL.channels.pairChannel(mux, {
      id: b4a.from(libraryId),
      onpaired: (m) => { clearTimeout(timer); resolve(m) }
    })
    built.channel.open()
    built.messages.hello.send({
      rv: PROTOCOL.link.parseLink(link).rv,
      deviceKey,
      label: 'Relayed Phone',
      platform: 'android'
    })
  })
}

// The device's media channel over whatever connection it is handed, plus the two things
// this test watches: chunks arriving, and the moment they stop.
function media (conn, libraryId) {
  const mux = Protomux.from(conn)
  const pending = new Map()
  let nextId = 1
  let chunks = 0
  let onchunk = null
  const built = PROTOCOL.channels.mediaChannel(mux, {
    id: b4a.from(libraryId),
    onres: (m) => pending.get(m.id)?.({ kind: 'res', body: m.body }),
    onerr: (m) => pending.get(m.id)?.({ kind: 'err', code: m.code, message: m.message }),
    onchunk: () => { chunks++; onchunk?.() },
    onend: (m) => pending.get(m.id)?.({ kind: 'end', total: m.total })
  })
  built.channel.open()
  return {
    get chunks () { return chunks },
    firstChunk () { return new Promise((r) => { onchunk = () => { onchunk = null; r() } }) },
    call (method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 8000)
        pending.set(id, (v) => { clearTimeout(timer); resolve(v) })
        built.messages.req.send({ id, method, params })
      })
    },
    send (method, params = {}) {
      built.messages.req.send({ id: nextId++, method, params })
    }
  }
}

test('REVOKE CUTS A STREAM THAT IS RUNNING THROUGH THE RELAY', async (t) => {
  const testnet = await createTestnet(3)
  const relay = await relayNode(t, testnet)
  const { h } = await cinema(t, testnet)
  t.after(() => testnet.destroy())

  // Pair normally first. Pairing is not what is under test, and a device has to hold a
  // grant before there is anything to revoke.
  const devKeyPair = HyperDHT.keyPair(hcrypto.randomBytes(32))
  const devDht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const hostSideDht = new HyperDHT({ bootstrap: testnet.bootstrap })
  t.after(async () => { await devDht.destroy({ force: true }); await hostSideDht.destroy({ force: true }) })

  const link = h.startPairing()
  const pairConn = devDht.connect(h.publicKey, { keyPair: devKeyPair })
  await pairThrough(pairConn, h.libraryId, link, devKeyPair.publicKey)
  pairConn.destroy()
  await settle(200)

  // Now the relayed connection, assembled by hand because a testnet cannot fail a punch.
  const token = blindRelay.token()
  const [clientEnd, hostEnd] = await Promise.all([
    throughRelay(t, devDht, relay.publicKey, token, true),
    throughRelay(t, hostSideDht, relay.publicKey, token, false)
  ])

  teachTheRelay(clientEnd.raw, hostEnd.raw)

  const clientConn = new NoiseSecretStream(true, clientEnd.raw, { keyPair: devKeyPair })
  const hostConn = new NoiseSecretStream(false, hostEnd.raw, { keyPair: h.host.identity.keyPair })
  clientConn.on('error', () => {})
  hostConn.on('error', () => {})
  await Promise.all([clientConn.opened, hostConn.opened])

  // The host takes it exactly as it takes a punched connection: same handler, same
  // registry, so the same kill can find it.
  h.host._onconnection(hostConn)

  const m = media(clientConn, h.libraryId)
  const pong = await m.call('ping')
  assert.equal(pong.body.app, 'pearcinema', 'the method table answered over the relay')

  // A film in flight, proven in flight rather than assumed.
  const first = m.firstChunk()
  m.send('media.stream', { itemId: 'metropolis' })
  await first
  const before = m.chunks
  assert.ok(before >= 1, 'bytes are crossing the relay')

  const closed = new Promise((r) => clientConn.on('close', () => r('closed')))
  const started = Date.now()
  const { killed } = await h.revokeDevice(devKeyPair.publicKey)
  assert.ok(killed >= 1, 'the host found the relayed connection in its registry and killed it')

  // WITHIN A SECOND is the acceptance test in CLAUDE.md, so it is asserted as a number
  // rather than as "eventually".
  const outcome = await Promise.race([closed, settle(2000).then(() => 'alive')])
  assert.equal(outcome, 'closed', 'a relayed connection must die on revoke like any other')
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms, the claim is within a second`)

  // And the film really stopped, rather than the socket dying while bytes kept coming.
  const atDeath = m.chunks
  await settle(300)
  assert.equal(m.chunks, atDeath, 'no chunk arrived after the kill')

  teardown(clientConn, hostConn, clientEnd.raw, hostEnd.raw, clientEnd.socket, hostEnd.socket)
})

test('a relayed device that has been revoked cannot simply reconnect through the relay', async (t) => {
  // The relay is a route, not an authority. A device holding a dead grant must be
  // refused at the media channel however it arrives - otherwise the relay would be a way
  // around the grant model rather than a way to the library.
  const testnet = await createTestnet(3)
  const relay = await relayNode(t, testnet)
  const { h } = await cinema(t, testnet)
  t.after(() => testnet.destroy())

  const devKeyPair = HyperDHT.keyPair(hcrypto.randomBytes(32))
  const devDht = new HyperDHT({ bootstrap: testnet.bootstrap })
  const hostSideDht = new HyperDHT({ bootstrap: testnet.bootstrap })
  t.after(async () => { await devDht.destroy({ force: true }); await hostSideDht.destroy({ force: true }) })

  const link = h.startPairing()
  const pairConn = devDht.connect(h.publicKey, { keyPair: devKeyPair })
  await pairThrough(pairConn, h.libraryId, link, devKeyPair.publicKey)
  pairConn.destroy()
  await settle(200)

  await h.revokeDevice(devKeyPair.publicKey)

  const token = blindRelay.token()
  const [clientEnd, hostEnd] = await Promise.all([
    throughRelay(t, devDht, relay.publicKey, token, true),
    throughRelay(t, hostSideDht, relay.publicKey, token, false)
  ])
  teachTheRelay(clientEnd.raw, hostEnd.raw)

  const clientConn = new NoiseSecretStream(true, clientEnd.raw, { keyPair: devKeyPair })
  const hostConn = new NoiseSecretStream(false, hostEnd.raw, { keyPair: h.host.identity.keyPair })
  clientConn.on('error', () => {})
  hostConn.on('error', () => {})
  await Promise.all([clientConn.opened, hostConn.opened])
  h.host._onconnection(hostConn)

  const m = media(clientConn, h.libraryId)
  const answer = await Promise.race([
    m.call('ping').then(() => 'answered'),
    new Promise((r) => clientConn.on('close', () => r('refused'))),
    settle(3000).then(() => 'refused')
  ])
  assert.equal(answer, 'refused', 'a revoked device gets nothing, relay or no relay')

  teardown(clientConn, hostConn, clientEnd.raw, hostEnd.raw, clientEnd.socket, hostEnd.socket)
})
