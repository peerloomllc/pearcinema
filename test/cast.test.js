// Casting a film to a television (video-deltas proposal §5).
//
// The video route is a NEW way to get bytes out of the library, and it is NOT
// covered by the revoke machinery that protects the P2P path: killing
// connections cannot reach a television, because the film travels from this
// process over LAN HTTP. So the tests that matter are the donor's, re-proven
// here against the video deltas: a revoked device stops getting bytes, revoke
// actively darkens the screen, and - new for video - a direct file honours
// Range, a generated stream dies with its reader, and the television's
// position lands in watch state.
//
// Every fetch below goes through the real http server on real loopback,
// because "the token check runs on every request" is precisely the thing that
// would rot if it were only asserted against a mocked handler.

process.env.PEARCINEMA_CAST_PORT = '0'
process.env.PEARCINEMA_CAST_BIND = '127.0.0.1'
process.env.PEARCINEMA_CAST_HOST = '127.0.0.1'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable, PassThrough } = require('stream')

const { CastSessions, CAST_CAPS } = require('../host/cast')

const DEVICE = 'device-key-aaa'

const BYTES = Buffer.from('FILM-BYTES-FOR-THE-TELEVISION-0123456789')

function fakeGrants (rows) {
  return {
    rows,
    async lookup (deviceKey) {
      const grant = this.rows[deviceKey] || null
      return { grant, person: grant?.person || null }
    }
  }
}

const okGrant = (over = {}) => ({
  deviceKey: DEVICE, revokedAt: null, expiresAt: null, scope: 'owner', person: null, ...over
})

// Records what HA was asked to do, so "revoke darkened the television" is an
// assertion about a call that was actually made.
function fakeSpeakers () {
  return {
    enabled: true,
    calls: [],
    states: new Map(),
    async play (entityId, url) { this.calls.push(['play', entityId, url]) },
    async stop (entityId) { this.calls.push(['stop', entityId]) },
    async pause (entityId) { this.calls.push(['pause', entityId]) },
    async resume (entityId) { this.calls.push(['resume', entityId]) },
    async getState (entityId) { return this.states.get(entityId) || null }
  }
}

// The media seam, the same calls the dashboard routes ride. `mode` decides
// which serving path a fetch takes; the session double records kills the way
// the fake speakers record stops.
function fakeMedia ({ mode = 'direct' } = {}) {
  const m = {
    mode,
    killed: 0,
    remuxAt: null,
    async getItem (id) {
      return { id, title: 'The Film', runtime: 5700, media: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', size: BYTES.length } }
    },
    async decide ({ capabilities }) {
      assert.deepEqual(capabilities, CAST_CAPS)
      if (m.mode === 'refuse') return { mode: 'refuse', reason: 'nothing can play this' }
      return { mode: m.mode }
    },
    async openStream ({ offset = 0, length }) {
      const end = length ? offset + length : BYTES.length
      return Readable.from([BYTES.subarray(offset, end)])
    },
    async openRemux ({ at }) {
      m.remuxAt = at
      const stdout = new PassThrough()
      stdout.write('GENERATED')
      const session = { at, audio: 'copy', stdout, kill: () => { m.killed++; stdout.destroy() } }
      return { mode: 'remux', session }
    }
  }
  return m
}

async function build ({ grantRows = { [DEVICE]: okGrant() }, mode = 'direct', report = null } = {}) {
  const speakers = fakeSpeakers()
  const grants = fakeGrants(grantRows)
  const media = fakeMedia({ mode })
  const casts = new CastSessions({ speakers, grants, media, report })
  const port = await casts.start()
  return { casts, speakers, grants, media, port }
}

// The URL cast.js handed HA, which is the only way a real fetch could happen.
const urlOf = (speakers) => speakers.calls.find(c => c[0] === 'play')[2]

test('a direct cast serves the file with Range honoured, off a real fetch', async (t) => {
  const { casts, speakers } = await build()
  t.after(() => casts.close())

  const out = await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv' })
  assert.equal(out.mode, 'direct')
  const url = urlOf(speakers)
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/v\/[A-Za-z0-9_-]+$/)

  const whole = await fetch(url)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  assert.equal(Buffer.from(await whole.arrayBuffer()).toString(), BYTES.toString())

  // The television seeks by byte range, which is the whole reason direct
  // exists on this listener.
  const part = await fetch(url, { headers: { range: 'bytes=5-14' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 5-14/${BYTES.length}`)
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), BYTES.subarray(5, 15).toString())

  // A wrong token is silence, not an explanation.
  const bad = await fetch(url.replace(/\/v\/.*$/, '/v/not-a-token'))
  assert.equal(bad.status, 404)
})

test('a generated cast starts at the asked-for position and dies with its reader', async (t) => {
  const { casts, speakers, media } = await build({ mode: 'transcode' })
  t.after(() => casts.close())

  // The viewer was 300 seconds in; generated bytes cannot seek, so the cast
  // itself starts there.
  const out = await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv', at: 300 })
  assert.equal(out.at, 300)

  const res = await fetch(urlOf(speakers))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('accept-ranges'), 'none')
  assert.equal(media.remuxAt, 300)

  // The reader walks away; the ffmpeg behind the stream must die with it.
  const reader = res.body.getReader()
  await reader.read()
  await reader.cancel()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(media.killed, 1)
})

test('a film nothing can fix refuses on the phone, before HA hears anything', async (t) => {
  const { casts, speakers } = await build({ mode: 'refuse' })
  t.after(() => casts.close())

  await assert.rejects(
    casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv' }),
    /nothing can play this/
  )
  assert.equal(speakers.calls.length, 0)
  assert.equal(casts.tokens.size, 0)
})

test('a revoked device fails its next fetch, and stopFor darkens the screen', async (t) => {
  const { casts, speakers, grants } = await build()
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv' })
  const url = urlOf(speakers)
  assert.equal((await fetch(url)).status, 200)

  // THE LIVE RE-READ: the grant dies and the very next byte is refused. The
  // token is also burned, so this is not retryable.
  grants.rows[DEVICE] = okGrant({ revokedAt: Date.now() })
  assert.equal((await fetch(url)).status, 403)
  assert.equal(casts.tokens.size, 0)

  // AND the active stop, because the buffered minutes keep playing without
  // it. This call is what the package's silence hook reaches.
  const darkened = await casts.stopFor(DEVICE)
  assert.equal(darkened, 1)
  assert.ok(speakers.calls.some(c => c[0] === 'stop' && c[1] === 'media_player.tv'))
  assert.equal(casts.byDevice.size, 0)
})

test('a readonly grant cannot fetch even with a valid token', async (t) => {
  const { casts, speakers, grants } = await build()
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv' })
  // The scope narrows AFTER the cast started - a demotion mid-film.
  grants.rows[DEVICE] = okGrant({ scope: 'full' })
  assert.equal((await fetch(urlOf(speakers))).status, 403)
})

test('the poll writes the television\'s position and reports the ending', async (t) => {
  const reports = []
  const { casts, speakers } = await build({
    mode: 'transcode',
    report: async (r) => { reports.push(r) }
  })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv', at: 60 })

  // Playing, 40 seconds into the STREAM - which is 100 seconds into the FILM,
  // because the generated stream started at 60. The stamp arithmetic runs off
  // "now", so the position lands at-or-after 100.
  speakers.states.set('media_player.tv', {
    state: 'playing', position: 40, duration: 5700, positionUpdatedAt: new Date().toISOString()
  })
  await casts._poll()
  assert.equal(reports.length, 1)
  assert.equal(reports[0].itemId, 'film1')
  assert.ok(reports[0].positionMs >= 100 * 1000 && reports[0].positionMs < 102 * 1000)

  // The film runs out: the row goes, the report says ended, and the token is
  // dead - an idle TV reports no position, so ended is the one write on trust.
  speakers.states.set('media_player.tv', { state: 'idle', position: null, duration: null })
  await casts._poll()
  assert.equal(casts.byDevice.size, 0)
  assert.equal(casts.tokens.size, 0)
  const ended = reports.find(r => r.ended)
  assert.ok(ended)
  assert.equal(ended.itemId, 'film1')
})

test('the host wires the package silence hook to the television', async (t) => {
  // A real PearCinemaHost, its HA client swapped for the recorder: the claim
  // under test is the WIRING - that the package's silence hook reaches
  // casts.stopFor - not HA itself.
  const os = require('os')
  const path = require('path')
  const fsp = require('fs/promises')
  const createTestnet = require('hyperdht/testnet')
  const { PearCinemaHost } = require('../host/server')

  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-cast-'))
  const host = new PearCinemaHost({ dataDir: dir, bootstrap: testnet.bootstrap, log: () => {} })
  await host.ready()
  t.after(async () => {
    await host.close()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  const speakers = fakeSpeakers()
  host.casts.speakers = speakers
  // A live cast for a device, planted directly - pairing is proven elsewhere.
  host.casts.byDevice.set('some-device-key', new Map([
    ['media_player.tv', { token: 't', itemId: 'x', mode: 'direct', at: 0, startedAt: Date.now(), sawPlaying: true, lastReportAt: 0 }]
  ]))

  const silenced = await host.host._silenceFor('some-device-key')
  assert.equal(silenced, 1)
  assert.ok(speakers.calls.some(c => c[0] === 'stop' && c[1] === 'media_player.tv'))
})
