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

const { CastSessions, CAST_CAPS, ROKU_CAPS } = require('../host/cast')

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
    async play (entityId, url, opts) { this.calls.push(['play', entityId, url, opts]) },
    async stop (entityId) { this.calls.push(['stop', entityId]) },
    async pause (entityId) { this.calls.push(['pause', entityId]) },
    async resume (entityId) { this.calls.push(['resume', entityId]) },
    async seek (entityId, pos) { this.calls.push(['seek', entityId, pos]) },
    async getState (entityId) { return this.states.get(entityId) || null }
  }
}

// The media seam, the same calls the dashboard routes ride. `mode` decides
// which serving path a fetch takes; the session double records kills the way
// the fake speakers record stops.
function fakeMedia ({ mode = 'direct', container = 'mp4', expectCaps = CAST_CAPS } = {}) {
  const m = {
    mode,
    killed: 0,
    remuxAt: null,
    segmentsAsked: [],
    async getItem (id) {
      return { id, title: 'The Film', runtime: 5700, media: { container, videoCodec: 'h264', audioCodec: 'aac', size: BYTES.length } }
    },
    async decide ({ capabilities }) {
      assert.deepEqual(capabilities, expectCaps)
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
    },
    // Ten 4-second segments, the host playlist's exact shape.
    async playlist () {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0']
      for (let i = 0; i < 10; i++) lines.push('#EXTINF:4.000,', i + '.ts')
      lines.push('#EXT-X-ENDLIST')
      return { mode: 'transcode', playlist: lines.join('\n'), segments: 10, segmentSeconds: 4 }
    },
    async segment ({ seq }) {
      m.segmentsAsked.push(seq)
      const stdout = new PassThrough()
      stdout.write('SEG' + seq)
      stdout.end()
      return { at: seq * 4, audio: 'aac', stdout, kill: () => { m.killed++ } }
    }
  }
  return m
}

async function build ({ grantRows = { [DEVICE]: okGrant() }, mode = 'direct', container = 'mp4', expectCaps = CAST_CAPS, report = null } = {}) {
  const speakers = fakeSpeakers()
  const grants = fakeGrants(grantRows)
  const media = fakeMedia({ mode, container, expectCaps })
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

test('a converted cast travels as HLS, sliced to start at the resume point', async (t) => {
  // A Roku REFUSES an unbounded progressive stream (measured on the living
  // room stick: "Full-content response on a range request"), so transcode
  // mode serves the same playlist-and-segments the phone rides.
  const { casts, speakers, media } = await build({ mode: 'transcode' })
  t.after(() => casts.close())

  const out = await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv', at: 13 })
  assert.equal(out.mode, 'transcode')
  const url = urlOf(speakers)
  assert.match(url, /\/index\.m3u8$/)
  assert.equal(speakers.calls[0][3].format, 'hls')

  // 13 seconds in = segment 3 on a 4-second cadence: everything before it is
  // sliced away and the sequence tag says so.
  const pl = await fetch(url)
  assert.equal(pl.status, 200)
  const body = await pl.text()
  assert.ok(!body.includes('\n2.ts'))
  assert.ok(body.includes('3.ts'))
  assert.ok(body.includes('#EXT-X-MEDIA-SEQUENCE:3'))

  // Segment names keep their TRUE indices, so a fetch maps to the right
  // minutes of film.
  const seg = await fetch(url.replace('index.m3u8', '7.ts'))
  assert.equal(seg.status, 200)
  assert.equal(await seg.text(), 'SEG7')
  assert.deepEqual(media.segmentsAsked, [7])
})

test('a Cast-family remux stays progressive and dies with its reader', async (t) => {
  const { casts, speakers, media } = await build({ mode: 'remux' })
  t.after(() => casts.close())

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

test('a Roku declares Matroska and a mkv film direct-plays with the honest label', async (t) => {
  const { casts, speakers } = await build({ container: 'matroska', expectCaps: ROKU_CAPS })
  t.after(() => casts.close())

  const out = await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.living_room_roku' })
  assert.equal(out.mode, 'direct')
  assert.equal(speakers.calls[0][3].format, 'mkv')

  const res = await fetch(urlOf(speakers))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'video/x-matroska')
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), BYTES.toString())
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

// --- skipping about from the phone, as the remote ---------------------------
//
// The two transports skip by entirely different means, and the sharp edge is
// that play() pins a DIRECT cast's start to zero - so re-casting a direct
// stream to skip would restart the film from the beginning. These pin down
// which mechanism each mode uses, and that a television which cannot seek is
// told so rather than silently rewound.

const TV = 'media_player.tv'
const SEEKABLE = 2 // HA's MediaPlayerEntityFeature.SEEK

test('a direct cast skips by telling the television to seek, not by starting again', async (t) => {
  const { casts, speakers } = await build()
  t.after(() => casts.close())
  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV })
  const playsBefore = speakers.calls.filter(c => c[0] === 'play').length

  speakers.states.set(TV, { state: 'playing', position: 600, duration: 7200, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  const out = await casts.seek({ deviceKey: DEVICE, entityId: TV, deltaMs: 30000 })

  assert.equal(out.restarted, false, 'a direct stream is never re-minted to skip')
  assert.deepEqual(speakers.calls.filter(c => c[0] === 'seek'), [['seek', TV, 630]])
  assert.equal(speakers.calls.filter(c => c[0] === 'play').length, playsBefore, 'no second play')
  assert.equal(out.positionMs, 630000)
})

test('a television that cannot seek is told so, rather than restarted from zero', async (t) => {
  const { casts, speakers } = await build()
  t.after(() => casts.close())
  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV })
  const playsBefore = speakers.calls.filter(c => c[0] === 'play').length

  // A Roku's media_player declares no SEEK, the same way it declares no
  // media_stop. Re-casting here would be the WORST outcome: play() pins a
  // direct cast to zero, so an attempt to nudge forward would restart the film.
  speakers.states.set(TV, { state: 'playing', position: 600, duration: 7200, positionUpdatedAt: null, supportedFeatures: 0 })
  await assert.rejects(
    casts.seek({ deviceKey: DEVICE, entityId: TV, deltaMs: 30000 }),
    /cannot skip/
  )
  assert.equal(speakers.calls.filter(c => c[0] === 'seek').length, 0)
  assert.equal(speakers.calls.filter(c => c[0] === 'play').length, playsBefore, 'the film was not restarted')
})

test('a converted cast skips by starting the stream again at the new point', async (t) => {
  const { casts, speakers } = await build({ mode: 'transcode', container: 'matroska', expectCaps: CAST_CAPS })
  t.after(() => casts.close())
  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV, at: 100 })

  // A generated stream's own clock starts at zero wherever it began, so the
  // television reporting 20s means 120s of film - and a 30s skip lands at 150.
  speakers.states.set(TV, { state: 'playing', position: 20, duration: 7200, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  const out = await casts.seek({ deviceKey: DEVICE, entityId: TV, deltaMs: 30000 })

  assert.equal(out.restarted, true)
  assert.equal(out.positionMs, 150000)
  assert.equal(speakers.calls.filter(c => c[0] === 'seek').length, 0, 'a generated stream is not seeked in place')
  const row = casts.active(DEVICE)[0]
  assert.equal(row.at, 150, 'the new offset is what makes the reported position honest')
  assert.equal(casts.tokens.size, 1, 'the old token went with the old stream')
})

test('skipping back past the start lands at the start rather than failing', async (t) => {
  const { casts, speakers } = await build()
  t.after(() => casts.close())
  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV })
  speakers.states.set(TV, { state: 'playing', position: 5, duration: 7200, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  const out = await casts.seek({ deviceKey: DEVICE, entityId: TV, deltaMs: -30000 })
  assert.equal(out.positionMs, 0)
  assert.deepEqual(speakers.calls.filter(c => c[0] === 'seek'), [['seek', TV, 0]])
})

test('skipping forward stops short of the ending, so a nudge cannot mark a film watched', async (t) => {
  const { casts, speakers } = await build()
  t.after(() => casts.close())
  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV })
  speakers.states.set(TV, { state: 'playing', position: 7195, duration: 7200, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  const out = await casts.seek({ deviceKey: DEVICE, entityId: TV, deltaMs: 30000 })
  assert.equal(out.positionMs, 7192000, 'clamped to eight seconds short of the end')
})

test('skipping a television that is playing nothing of ours is refused', async (t) => {
  const { casts } = await build()
  t.after(() => casts.close())
  await assert.rejects(
    casts.seek({ deviceKey: DEVICE, entityId: TV, deltaMs: 30000 }),
    /nothing is playing/
  )
})

// --- where the film has got to, for the phone acting as remote --------------
//
// Asking the television is not enough, and these pin down why: a generated
// stream's clock starts at zero wherever the film began, and an HLS playlist
// sliced to a resume point reports the length of what is LEFT. Both would put
// the wrong minute on the remote.

test('the remote is told the film s clock, not the television s', async (t) => {
  const { casts, speakers } = await build({ mode: 'transcode', container: 'matroska' })
  t.after(() => casts.close())
  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV, at: 1800 })

  // The television is twenty seconds into a stream that itself began half an
  // hour into the film, which is 1820s of film - not 20.
  speakers.states.set(TV, { state: 'playing', position: 20, duration: 3900, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  const w = await casts.where({ deviceKey: DEVICE, entityId: TV })

  assert.equal(w.positionMs, 1820000)
  // And the duration is the FILM's, off the item, not the 3900s of stream the
  // television can see - otherwise a resumed film would look shorter than it is.
  assert.equal(w.durationMs, 5700000)
  assert.equal(w.mode, 'transcode')
})

test('a direct cast reports the television s own clock unchanged', async (t) => {
  const { casts, speakers } = await build()
  t.after(() => casts.close())
  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV })
  speakers.states.set(TV, { state: 'playing', position: 640, duration: 5700, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  const w = await casts.where({ deviceKey: DEVICE, entityId: TV })
  assert.equal(w.positionMs, 640000, 'a direct cast starts at zero, so there is no offset to add')
  assert.equal(w.durationMs, 5700000)
})

test('asking where a television is that this device is not casting to answers nothing', async (t) => {
  const { casts } = await build()
  t.after(() => casts.close())
  assert.equal(await casts.where({ deviceKey: DEVICE, entityId: TV }), null)
})
