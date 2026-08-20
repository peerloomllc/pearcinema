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
function fakeMedia ({ mode = 'direct', container = 'mp4', expectCaps = CAST_CAPS, boundaries = null } = {}) {
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
    // Ten 4-second segments, the host playlist's exact shape - or, when the film
    // is COPIED rather than re-encoded, the uneven keyframe-cut shape a real one
    // has, with the boundaries the host sends alongside it.
    async playlist () {
      if (boundaries) {
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:14', '#EXT-X-MEDIA-SEQUENCE:0']
        for (let i = 0; i < boundaries.length; i++) {
          const end = i + 1 < boundaries.length ? boundaries[i + 1] : boundaries[i] + 5
          lines.push(`#EXTINF:${(end - boundaries[i]).toFixed(3)},`, i + '.ts')
        }
        lines.push('#EXT-X-ENDLIST')
        return {
          mode: 'remux',
          engine: 'copy',
          playlist: lines.join('\n'),
          segments: boundaries.length,
          segmentSeconds: 4,
          boundaries
        }
      }
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

async function build ({ grantRows = { [DEVICE]: okGrant() }, mode = 'direct', container = 'mp4', expectCaps = CAST_CAPS, report = null, boundaries = null, startOffset = true } = {}) {
  const speakers = fakeSpeakers()
  const grants = fakeGrants(grantRows)
  const media = fakeMedia({ mode, container, expectCaps, boundaries })
  const casts = new CastSessions({ speakers, grants, media, report, startOffset })
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
  //
  // THE SLICED SHAPE, which is no longer the default but is still what a receiver that
  // ignores #EXT-X-START gets - see the two shapes at the end of this file.
  const { casts, speakers, media } = await build({ mode: 'transcode', startOffset: false })
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
    startOffset: false,
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
  const { casts, speakers } = await build({ startOffset: false, mode: 'transcode', container: 'matroska', expectCaps: CAST_CAPS })
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
  const { casts, speakers } = await build({ startOffset: false, mode: 'transcode', container: 'matroska' })
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

test('A CONVERTED FILM IS LABELLED MP4, WHATEVER IT WAS ON THE DISK', async (t) => {
  // Found on Tim's Roku 2026-08-19, minutes after multichannel audio started sending
  // films down the remux path for the first time. The film is Matroska; the remux
  // output is always fragmented MP4; and the format hint still read the SOURCE
  // container, so the television was told "mkv" and handed an MP4. It tried to demux
  // it as Matroska and sat at 13% forever.
  //
  // The hint has to describe what the television WILL RECEIVE, and on a Roku that is
  // not decoration - its player picks a demuxer with it.
  // A television that takes a progressive stream receives that remux as one MP4,
  // and the hint says so rather than repeating the disk's container.
  const cast = await build({ mode: 'remux', container: 'matroska' })
  t.after(() => cast.casts.close())
  await cast.casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv' })
  assert.equal(cast.speakers.calls[0][3].format, 'mp4', 'a progressive remux always outputs MP4, whatever went in')

  // A Roku receives the same remux in SEGMENTS, because it refuses a progressive
  // stream outright - so the hint that describes what it will receive is hls.
  const { casts, speakers } = await build({ mode: 'remux', container: 'matroska', expectCaps: ROKU_CAPS })
  t.after(() => casts.close())

  const out = await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.living_room_roku' })
  assert.equal(out.mode, 'remux')
  assert.equal(speakers.calls[0][3].format, 'hls', 'a Roku is told hls, never the disk container')
})

// --- the transport is the television's question, not the film's ---------------

test('A ROKU TAKES A REMUX IN SEGMENTS, because it refuses a progressive stream', async (t) => {
  // The last blocker on surround-sound casting, in the Roku's own words:
  // "reader pick stream error:HTTP error:Full-content response on a range
  // request:200". A generated stream answers 200 with accept-ranges:none and this
  // device will not have it. cast.js knew that and routed only TRANSCODE around it,
  // which was fine until the 5.1 fix started sending films down the REMUX path -
  // and remux went progressive, straight into the same wall.
  //
  // What decides the transport is what the television accepts. What the film needs
  // is decided separately, inside the segment engine, where a copied picture stays
  // copied.
  const { casts, speakers, media } = await build({
    mode: 'remux',
    container: 'matroska',
    expectCaps: ROKU_CAPS,
    boundaries: [0, 4.859, 10.74, 19.874, 26.339, 31.386]
  })
  t.after(() => casts.close())

  const out = await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.living_room_roku' })
  assert.equal(out.mode, 'remux')
  const url = urlOf(speakers)
  assert.match(url, /\/index\.m3u8$/, 'segments, not a pipe')
  assert.equal(speakers.calls[0][3].format, 'hls')

  const pl = await fetch(url)
  assert.equal(pl.status, 200)
  assert.equal(pl.headers.get('content-type'), 'application/vnd.apple.mpegurl')
  const body = await pl.text()
  // The durations are the REAL ones. A Roku takes the film's length from their
  // sum, measured 2026-08-19, so an even 4.000 everywhere would be a lie.
  assert.match(body, /#EXTINF:4\.859,\n0\.ts/)
  assert.match(body, /#EXTINF:9\.134,\n2\.ts/)

  const seg = await fetch(url.replace('index.m3u8', '3.ts'))
  assert.equal(seg.status, 200)
  assert.equal(seg.headers.get('content-type'), 'video/mp2t')
  assert.equal(await seg.text(), 'SEG3')
  assert.deepEqual(media.segmentsAsked, [3])
})

test('a Cast-family remux is still a pipe, and a Cast-family transcode is still segments', async (t) => {
  // Nothing about fixing the Roku wanted to move the televisions that were already
  // working. A device that accepts progressive keeps exactly the transport it was
  // measured with.
  const remuxed = await build({ mode: 'remux' })
  t.after(() => remuxed.casts.close())
  await remuxed.casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv' })
  assert.doesNotMatch(urlOf(remuxed.speakers), /index\.m3u8/)
  assert.equal(remuxed.speakers.calls[0][3].format, 'mp4')

  const converted = await build({ mode: 'transcode' })
  t.after(() => converted.casts.close())
  await converted.casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv' })
  assert.match(urlOf(converted.speakers), /index\.m3u8$/)
  assert.equal(converted.speakers.calls[0][3].format, 'hls')
})

test('A RESUME SNAPS TO A REAL CUT POINT, and the position report follows it', async (t) => {
  // A copied picture is cut on the film's own keyframes, so segments are uneven -
  // 4.0 s to 14.0 s on real films. Dividing by four would name a segment that does
  // not begin where it claims, and every position the poll reported afterwards
  // would carry that error.
  const { casts, speakers } = await build({
    mode: 'remux',
    expectCaps: ROKU_CAPS,
    boundaries: [0, 4.859, 10.74, 19.874, 26.339, 31.386],
    // The sliced shape: this test is about row.at carrying the real cut point, which is
    // the arithmetic that shape depends on.
    startOffset: false
  })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.living_room_roku', at: 24 })
  const url = urlOf(speakers)
  const body = await (await fetch(url)).text()

  // 24 seconds in lands in the segment that STARTS at 19.874, not the one a
  // four-second cadence would have named.
  assert.match(body, /#EXT-X-MEDIA-SEQUENCE:3/)
  assert.ok(!body.includes('\n2.ts'), 'everything before the resume is sliced away')
  assert.ok(body.includes('3.ts'))

  // And the row the poll reads carries that same real boundary. A television
  // reports its position against the PLAYLIST it was given (measured on Tim's
  // Roku 2026-08-19: a playlist sliced to start 59.622 s in reported 0 at its
  // start), so this offset is the whole difference between a resumed film
  // reporting its true minute and reporting the minutes since the resume.
  speakers.states.set('media_player.living_room_roku', { state: 'playing', position: 6, duration: 40, positionUpdatedAt: new Date().toISOString() })
  const where = await casts.where({ deviceKey: DEVICE, entityId: 'media_player.living_room_roku' })
  assert.equal(Math.round(where.positionMs / 100), Math.round((19.874 + 6) * 10), 'the boundary plus the television\'s own clock')

  // The film's length comes from the ITEM, never from the sliced playlist.
  assert.equal(where.durationMs, 5700 * 1000)
})

test('an even grid still divides, so a re-encoded cast is unchanged', async (t) => {
  // A host that sends no boundaries is describing an even grid, which is what a
  // re-encode produces and what every caller predating the copy engine sends.
  const { segmentAt, segmentStart } = require('../host/cast')

  assert.equal(segmentAt(13, { segmentSeconds: 4 }), 3)
  assert.equal(segmentStart(3, { segmentSeconds: 4 }), 12)

  // With boundaries it snaps BACK to the last cut point at or before the moment,
  // so a resume rewinds by up to one group of pictures rather than stepping over
  // the seconds it was meant to land on.
  const out = { boundaries: [0, 4.859, 10.74, 19.874], segmentSeconds: 4 }
  assert.equal(segmentAt(0, out), 0)
  assert.equal(segmentAt(4.858, out), 0)
  assert.equal(segmentAt(4.859, out), 1)
  assert.equal(segmentAt(19.873, out), 2)
  assert.equal(segmentAt(1e9, out), 3, 'past the end is the last segment, never off the end')
  assert.equal(segmentStart(2, out), 10.74)
  assert.equal(segmentStart(99, out), 19.874)
})

test('THE OTHER PLAYLIST SHAPE: the whole film, joined in the middle', async (t) => {
  // What the television's OWN clock says depends on which shape it was handed. Sliced,
  // the receiver holds only what is left, so its display reads zero at a resume and
  // resets to zero on every skip - true about the stream it was given, and not what
  // anybody in the room means (Tim, 2026-08-19, watching his TV).
  //
  // With `#EXT-X-START` the receiver holds the WHOLE film and is told where to join it,
  // so its clock is the film's clock. The tag is optional in the standard - a receiver
  // may ignore it and start at the beginning - which is why this is a setting measured
  // per television rather than the default.
  const { casts, speakers, media } = await build({ mode: 'transcode' })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv', at: 13 })
  const url = urlOf(speakers)
  const body = await (await fetch(url)).text()

  // NOTHING IS DROPPED. Every segment is still there, which is what makes the
  // receiver's timeline the film's timeline.
  assert.ok(body.includes('\n0.ts'), 'the film still begins at its beginning')
  assert.ok(body.includes('3.ts'))
  assert.match(body, /#EXT-X-START:TIME-OFFSET=12\.000,PRECISE=YES/)
  assert.match(body, /#EXT-X-VERSION:6/, 'the tag needs version 6')
  assert.doesNotMatch(body, /#EXT-X-MEDIA-SEQUENCE:3/, 'nothing was cut, so nothing re-sequenced')

  // AND row.at GOES TO ZERO WITH IT. The poll adds row.at to what the television
  // reports; the television is now reporting the film's own minute, so adding the
  // offset again would double it.
  const where = await casts.where({ deviceKey: DEVICE, entityId: 'media_player.tv' })
  assert.ok(where === null || where.positionMs != null)
  const row = casts.byDevice.get(DEVICE).get('media_player.tv')
  assert.equal(row.at, 0)
  void media
})

test('and the sliced shape is still there for a receiver that ignores the tag', async (t) => {
  // Measured as honoured on the living room Roku (2026-08-20), so the offset shape is
  // the default - but a receiver that ignores EXT-X-START would start a resumed film
  // from the beginning, which is a worse thing to be wrong about than a clock. One env
  // var goes back.
  const { casts, speakers } = await build({ mode: 'transcode', startOffset: false })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.tv', at: 13 })
  const body = await (await fetch(urlOf(speakers))).text()
  assert.doesNotMatch(body, /#EXT-X-START/)
  assert.match(body, /#EXT-X-MEDIA-SEQUENCE:3/)
})

test('on the offset shape the television reports the film itself, so nothing is added', async (t) => {
  // The mirror of the snap-to-a-real-cut-point test above. There, the playlist is cut
  // and the television counts from zero, so row.at is the boundary and the poll adds
  // it. Here the television holds the whole film and joins it in the middle, so its own
  // clock IS the film's minute - and adding anything to it would double the offset.
  const { casts, speakers } = await build({
    mode: 'remux',
    expectCaps: ROKU_CAPS,
    boundaries: [0, 4.859, 10.74, 19.874, 26.339, 31.386]
  })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: 'media_player.living_room_roku', at: 24 })
  const body = await (await fetch(urlOf(speakers))).text()
  assert.match(body, /#EXT-X-START:TIME-OFFSET=19\.874/)

  speakers.states.set('media_player.living_room_roku', { state: 'playing', position: 25.874, duration: 40, positionUpdatedAt: new Date().toISOString() })
  const where = await casts.where({ deviceKey: DEVICE, entityId: 'media_player.living_room_roku' })
  assert.equal(Math.round(where.positionMs / 100), Math.round(25.874 * 10), 'the television\'s own clock, untouched')
})

test('A SKIP OF THIRTY SECONDS IS THIRTY SECONDS, not sixty', async (t) => {
  // Tim, 2026-08-20, on the real Roku: skipping ahead jumped about a minute, and the
  // phone read twenty or thirty seconds ahead of the television before settling back.
  //
  // Both came from one field doing two jobs. `row.at` was what the poll ADDS to the
  // television's clock AND where the playlist was told to begin, and on the offset
  // shape those are different numbers - the television is already reporting the film's
  // own minute, so adding the start to it counts the skip twice. It was zeroed when the
  // playlist was fetched, which left a two or three second window - exactly the length
  // of re-cutting a stream - where every reading was double.
  const { casts, speakers } = await build({ mode: 'transcode', container: 'matroska', expectCaps: CAST_CAPS })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV, at: 100 })
  const row = casts.active(DEVICE)[0]
  assert.equal(row.at, 0, 'nothing to add: the television reports the film itself')

  // The television, having arrived, reports the film's own minute.
  speakers.states.set(TV, { state: 'playing', position: 120, duration: 7200, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  const w = await casts.where({ deviceKey: DEVICE, entityId: TV })
  assert.equal(w.positionMs, 120000, 'not 220000 - the offset is not added twice')

  const out = await casts.seek({ deviceKey: DEVICE, entityId: TV, deltaMs: 30000 })
  assert.equal(out.positionMs, 150000, 'thirty seconds on from a hundred and twenty')
})

test('and until the television gets there, it is asked where it is GOING', async (t) => {
  // The other half of the same two or three seconds. A skip re-cuts the stream and the
  // television plays the old one meanwhile - so asking it where the film is gets a
  // truthful answer to a question about the previous stream, and the phone jumped to
  // the right minute and then back to the old one until the next poll.
  const { casts, speakers } = await build({ mode: 'transcode', container: 'matroska', expectCaps: CAST_CAPS })
  t.after(() => casts.close())

  await casts.play({ deviceKey: DEVICE, itemId: 'film1', entityId: TV, at: 600 })
  // Still playing the stream it had, forty seconds back.
  speakers.states.set(TV, { state: 'playing', position: 560, duration: 7200, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  assert.equal((await casts.where({ deviceKey: DEVICE, entityId: TV })).positionMs, 600000, 'where it is going')

  // It arrives, and from then on the television is believed - including once the film
  // has legitimately run far away from where it started.
  speakers.states.set(TV, { state: 'playing', position: 603, duration: 7200, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  assert.equal((await casts.where({ deviceKey: DEVICE, entityId: TV })).positionMs, 603000)
  speakers.states.set(TV, { state: 'playing', position: 1500, duration: 7200, positionUpdatedAt: null, supportedFeatures: SEEKABLE })
  assert.equal((await casts.where({ deviceKey: DEVICE, entityId: TV })).positionMs, 1500000, 'the latch holds: this is playback, not a television that never arrived')
})
