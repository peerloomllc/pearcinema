// The web interface: the lock, the bytes and the page.
//
// THE ONE THAT MATTERS MOST is the group under "the gate". This page can revoke
// every device, open a pairing window onto the whole library, and - new in
// PearCinema and not true of PearTune's dashboard - hand out the actual film. So
// every route is tested for what it does when nobody has logged in, and /api/stream
// is tested first, because that is the one where a mistake is a stranger on the wifi
// downloading somebody's collection.
//
// The second group pins the claim that there is only ONE streaming implementation.
// The browser's Range header must arrive at the same adapter call the phone's
// `media.stream` makes, with the same offset and length, or there are two pieces of
// byte-range arithmetic to keep honest and they will diverge.

// NO HARDWARE PROBE IN HERE. ready() probes the box's video engine, and this
// machine may genuinely have one - which would turn the refuse-409 assertions below
// into live transcodes on whose laptop they happen to run. The probe has its own
// tests with the ffmpeg faked.
process.env.PEARCINEMA_TRANSCODE = 'off'

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const http = require('http')
const createTestnet = require('hyperdht/testnet')
const b4a = require('b4a')
const { Readable } = require('streamx')

const { PearCinemaHost } = require('../host/server')
const { startDashboard, parseRange, srtToVtt, mimeFor } = require('../host/ui/server')
const items = require('../host/items')

const PASSWORD = 'a-good-long-password'

// A tiny real MKV, built once, so the remux route has something ffmpeg can actually
// open. Everything else in this file is wiring; that route produces bytes.
const FIXTURE_MKV = path.join(os.tmpdir(), 'pearcinema-dash-fixture.mkv')

// 4 KB of recognisable bytes, so a range response can be checked exactly rather
// than by length alone.
const BYTES = b4a.from(Array.from({ length: 4096 }, (_, i) => i % 251))

const FILM = items.movie({
  id: 'metropolis',
  title: 'Metropolis',
  year: 1927,
  runtime: 153,
  media: { container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, size: BYTES.length }
})

const MP4 = items.movie({
  id: 'nosferatu',
  title: 'Nosferatu',
  year: 1922,
  media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, size: BYTES.length }
})

const SHOW = items.series({ id: 'the-wire', title: 'The Wire' })
const SEASON = items.season({ id: 'wire-s01', seriesId: 'the-wire', seriesTitle: 'The Wire', number: 1 })
const EPISODES = [1, 2, 3].map(n => items.episode({
  id: 'wire-s01e0' + n,
  seriesId: SHOW.id,
  seasonId: 'wire-s01',
  seriesTitle: 'The Wire',
  seasonNumber: 1,
  episodeNumber: n,
  title: 'Episode ' + n,
  runtime: 3600,
  media: { container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', size: BYTES.length }
}))

class TestAdapter {
  constructor () {
    this.kind = 'test'
    this.calls = []
  }

  async ping () { return { ok: true, detail: 'test' } }
  async scan () { return 2 }
  async stats () { return { movies: 2, series: 0, seasons: 0, episodes: 0, source: 'test' } }
  // A show with three episodes, so the next-episode shelf has something to be about.
  // Everything else in this file is films; a tree is what "up next" means.
  async list ({ type, seriesId, seasonId }) {
    if (type === 'movies') return items.page([FILM, MP4], {})
    if (type === 'series') return items.page([SHOW], {})
    if (type === 'seasons' && seriesId === SHOW.id) return items.page([SEASON], {})
    if (type === 'episodes' && (seriesId === SHOW.id || seasonId === SEASON.id)) return items.page(EPISODES, {})
    return items.page([], {})
  }

  async get ({ id }) { return [FILM, MP4, SHOW, SEASON, ...EPISODES].find(f => f.id === id) || null }
  async search ({ q }) {
    return { items: [FILM, MP4].filter(f => f.title.toLowerCase().includes(String(q).toLowerCase())) }
  }

  async art () { return null }
  async subtitles () { return [{ id: 's1', title: 'English', language: 'eng', playable: true, external: true, codec: 'subrip', reason: null }] }
  async subtitle () { return Readable.from([b4a.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n')]) }

  // The remux seam. A real path, because ffmpeg needs something seekable - see the
  // note on FolderAdapter.ffmpegInput about why this is the one place a path leaves.
  async ffmpegInput ({ itemId }) {
    return await this.get({ id: itemId }) ? { input: FIXTURE_MKV } : null
  }

  async stream ({ itemId, offset = 0, length }) {
    this.calls.push({ itemId, offset, length })
    if (!this.get({ id: itemId })) return null
    const end = length ? offset + length : BYTES.length
    return Readable.from([BYTES.subarray(offset, end)])
  }
}

async function cinema (t, { bind = '127.0.0.1', password = PASSWORD } = {}) {
  const testnet = await createTestnet(3)
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-dash-'))

  const host = new PearCinemaHost({
    dataDir: dir,
    libraryName: 'The Cinema',
    bootstrap: testnet.bootstrap,
    log: () => {}
  })
  const adapter = new TestAdapter()
  host.adapter = adapter
  await host.ready()

  const dash = await startDashboard({
    host, bind, port: 0, password, passwordSource: password ? 'file' : 'none'
  })

  t.after(async () => {
    await dash.close()
    await host.close()
    await testnet.destroy()
    await fsp.rm(dir, { recursive: true, force: true })
  })

  return { host, adapter, dash, base: `http://127.0.0.1:${dash.port}`, dir }
}

// A tiny client that keeps one cookie, so "logged in" and "logged out" are two
// clients rather than a flag.
function client (base) {
  // A JAR, not one cookie. The dashboard sets two: the session, which is a
  // credential, and the person this browser watches as, which is a preference.
  // Keeping only the newest would have the second log the first out - a real browser
  // holds both, and a harness that does not would prove the wrong thing.
  const jar = new Map()
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ') || null

  return {
    get cookie () { return cookieHeader() },
    async req (method, pathname, { body, headers = {} } = {}) {
      const url = new URL(pathname, base)
      return new Promise((resolve, reject) => {
        const r = http.request({
          method,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            ...(cookieHeader() ? { cookie: cookieHeader() } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers
          }
        }, res => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            for (const raw of (res.headers['set-cookie'] || [])) {
              const [k, v] = String(raw).split(';')[0].split('=')
              jar.set(k, v)
            }
            const buf = Buffer.concat(chunks)
            let json = null
            try { json = JSON.parse(buf.toString()) } catch {}
            resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString(), json })
          })
        })
        r.on('error', reject)
        if (body !== undefined) r.write(JSON.stringify(body))
        r.end()
      })
    },
    async login (password) {
      return this.req('POST', '/api/login', { body: { password } })
    }
  }
}

let ffmpegOk = false
test('build a real film for the remux route to repackage', async () => {
  try {
    await new Promise((resolve, reject) => {
      require('child_process').execFile('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=3',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
        '-c:a', 'ac3', '-ac', '2', '-shortest', FIXTURE_MKV, '-y'
      ], (e) => e ? reject(e) : resolve())
    })
    ffmpegOk = true
  } catch {
    ffmpegOk = false
  }
})

/* ---------------------------------------------------------------- the gate -- */

test('the dashboard refuses to start on a non-loopback bind with no password', async () => {
  await assert.rejects(
    () => startDashboard({ host: {}, bind: '0.0.0.0', port: 0, password: '' }),
    /refusing to start/
  )
})

test('the mention in that refusal names OUR env var, not the donor s', async () => {
  await assert.rejects(
    () => startDashboard({ host: {}, bind: '0.0.0.0', port: 0, password: '' }),
    /PEARCINEMA_PASSWORD/
  )
})

test('nothing is readable without a session, and that includes the film', async (t) => {
  const { base } = await cinema(t)
  const c = client(base)

  // THE ONE THAT MATTERS. A byte of the library must not leave this host to
  // somebody who has not logged in.
  const stream = await c.req('GET', '/api/stream?id=' + FILM.id)
  assert.equal(stream.status, 401)
  assert.equal(stream.body.length < 200, true, 'a 401 must not carry film bytes')

  for (const route of [
    '/api/state',
    // Repackaged bytes are still library bytes. A second door to the films is
    // exactly what "the player sits behind the gate, not beside it" forbids.
    '/api/remux?id=' + FILM.id,
    '/api/library/list?type=movies',
    '/api/library/item?id=' + FILM.id,
    '/api/library/search?q=metro',
    '/api/art?id=x',
    '/api/subtitles?itemId=' + FILM.id,
    '/api/source/folders?path=/'
  ]) {
    const res = await c.req('GET', route)
    assert.equal(res.status, 401, route + ' should be 401 when logged out')
  }

  for (const route of ['/api/pair/start', '/api/revoke', '/api/source', '/api/library', '/api/password']) {
    const res = await c.req('POST', route, { body: {} })
    assert.equal(res.status, 401, route + ' should be 401 when logged out')
  }
})

test('logged out, the page itself is the login form and not the control plane', async (t) => {
  const { base } = await cinema(t)
  const res = await client(base).req('GET', '/')
  assert.equal(res.status, 200)
  assert.match(res.text, /Unlock/)
  assert.doesNotMatch(res.text, /id="root"/, 'the application bundle must not be served to a stranger')
})

test('the wrong password does not let you in; the right one does', async (t) => {
  const { base } = await cinema(t)
  const c = client(base)

  const bad = await c.login('not it')
  assert.equal(bad.status, 401)

  const good = await c.login(PASSWORD)
  assert.equal(good.status, 200)
  assert.ok(c.cookie)

  const state = await c.req('GET', '/api/state')
  assert.equal(state.status, 200)
  assert.equal(state.json.library, 'The Cinema')

  // The transcode gate reaches the page, and in here it is OFF BY CONFIG (the env
  // at the top of this file), which is also what proves the flag works: a passing
  // probe on the laptop running these tests must not leak through it.
  assert.equal(state.json.transcode.available, false)
  assert.match(state.json.transcode.reason, /turned off by configuration/)

  const page = await c.req('GET', '/')
  assert.match(page.text, /id="root"/, 'a logged-in browser gets the built app')
})

test('a loopback host with no password has no gate at all', async (t) => {
  const { base } = await cinema(t, { password: '' })
  const res = await client(base).req('GET', '/api/state')
  assert.equal(res.status, 200)
  assert.equal(res.json.auth.enabled, false)
})

/* ------------------------------------------------------------- the bytes -- */

async function loggedIn (t, opts) {
  const ctx = await cinema(t, opts)
  const c = client(ctx.base)
  if (opts?.password !== '') await c.login(PASSWORD)
  return { ...ctx, c }
}

test('a whole film comes back with a length and an accept-ranges', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('GET', '/api/stream?id=' + FILM.id)
  assert.equal(res.status, 200)
  assert.equal(res.headers['accept-ranges'], 'bytes')
  assert.equal(Number(res.headers['content-length']), BYTES.length)
  assert.deepEqual(res.body, Buffer.from(BYTES))
})

test('a range gets exactly those bytes, and the SAME adapter call the phone makes', async (t) => {
  const { c, adapter } = await loggedIn(t)
  adapter.calls.length = 0

  const res = await c.req('GET', '/api/stream?id=' + FILM.id, { headers: { range: 'bytes=1000-1999' } })

  assert.equal(res.status, 206)
  assert.equal(res.headers['content-range'], `bytes 1000-1999/${BYTES.length}`)
  assert.equal(Number(res.headers['content-length']), 1000)
  assert.deepEqual(res.body, Buffer.from(BYTES.subarray(1000, 2000)))

  // The whole reason the web player is a second TRANSPORT and not a second
  // implementation: offset and length reach the adapter unchanged, exactly as they
  // do through media.stream.
  assert.deepEqual(adapter.calls, [{ itemId: FILM.id, offset: 1000, length: 1000 }])
})

test('an open-ended range runs to the end of the file', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('GET', '/api/stream?id=' + FILM.id, { headers: { range: 'bytes=4000-' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers['content-range'], `bytes 4000-4095/${BYTES.length}`)
  assert.deepEqual(res.body, Buffer.from(BYTES.subarray(4000)))
})

test('a suffix range gets the LAST bytes - which is how Safari finds an mp4 index', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('GET', '/api/stream?id=' + FILM.id, { headers: { range: 'bytes=-100' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers['content-range'], `bytes 3996-4095/${BYTES.length}`)
  assert.deepEqual(res.body, Buffer.from(BYTES.subarray(4096 - 100)))
})

test('a range past the end is refused with 416, not with the wrong bytes', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('GET', '/api/stream?id=' + FILM.id, { headers: { range: 'bytes=99999-' } })
  assert.equal(res.status, 416)
  assert.equal(res.headers['content-range'], `bytes */${BYTES.length}`)
})

test('HEAD answers the headers a player probes with and no body', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('HEAD', '/api/stream?id=' + FILM.id)
  assert.equal(res.status, 200)
  assert.equal(Number(res.headers['content-length']), BYTES.length)
  assert.equal(res.body.length, 0)
})

test('an unknown id is a 404 rather than an empty stream', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('GET', '/api/stream?id=not-a-film')
  assert.equal(res.status, 404)
})

test('the container is labelled honestly, matroska included', async (t) => {
  const { c } = await loggedIn(t)
  const mkv = await c.req('HEAD', '/api/stream?id=' + FILM.id)
  assert.equal(mkv.headers['content-type'], 'video/x-matroska')

  // ffprobe collapses the whole ISO base media family to `mov`, so an ordinary mp4
  // arrives labelled `mov`. It must still go out as video/mp4 or canPlayType has
  // nothing useful to say about it.
  const mp4 = await c.req('HEAD', '/api/stream?id=' + MP4.id)
  assert.equal(mp4.headers['content-type'], 'video/mp4')
})

/* ----------------------------------------------------------- the library -- */

test('the library reads through the same adapter the phone does', async (t) => {
  const { c } = await loggedIn(t)

  const list = await c.req('GET', '/api/library/list?type=movies')
  assert.equal(list.status, 200)
  assert.equal(list.json.items.length, 2)

  const one = await c.req('GET', '/api/library/item?id=' + FILM.id)
  assert.equal(one.json.title, 'Metropolis')

  const found = await c.req('GET', '/api/library/search?q=metro')
  assert.equal(found.json.items.length, 1)

  const nothing = await c.req('GET', '/api/library/search?q=')
  assert.deepEqual(nothing.json, { items: [] })

  const bad = await c.req('GET', '/api/library/list?type=nonsense')
  assert.equal(bad.status, 400)

  // Unscoped seasons and episodes are a bad request rather than a full-library
  // dump, same rule as the method table.
  assert.equal((await c.req('GET', '/api/library/list?type=seasons')).status, 400)
  assert.equal((await c.req('GET', '/api/library/list?type=episodes')).status, 400)
})

test('the player can ask what sits on either side of an episode', async (t) => {
  const { c } = await loggedIn(t)

  // The middle one has both neighbours.
  const mid = await c.req('GET', '/api/siblings?itemId=wire-s01e02')
  assert.equal(mid.status, 200)
  assert.equal(mid.json.prev.id, 'wire-s01e01')
  assert.equal(mid.json.next.id, 'wire-s01e03')
  // The card is going to render these, so they have to arrive as whole items
  // rather than as bare ids.
  assert.equal(mid.json.next.title, 'Episode 3')
  assert.equal(mid.json.next.episodeNumber, 3)

  // The ends answer with a null on the side that has nothing, not an error.
  assert.equal((await c.req('GET', '/api/siblings?itemId=wire-s01e01')).json.prev, null)
  assert.equal((await c.req('GET', '/api/siblings?itemId=wire-s01e03')).json.next, null)

  // A FILM IS TWO NULLS, not a 400 - the player asks about whatever is playing
  // and must not have to branch on the type before it can ask.
  const film = await c.req('GET', '/api/siblings?itemId=' + FILM.id)
  assert.equal(film.status, 200)
  assert.deepEqual(film.json, { prev: null, next: null })

  assert.equal((await c.req('GET', '/api/siblings?itemId=nope')).status, 404)
  assert.equal((await c.req('GET', '/api/siblings')).status, 400)
})

test('subtitles come back as WebVTT, because a <track> accepts nothing else', async (t) => {
  const { c } = await loggedIn(t)

  const list = await c.req('GET', '/api/subtitles?itemId=' + FILM.id)
  assert.equal(list.json.items.length, 1)

  const vtt = await c.req('GET', '/api/subtitle?itemId=' + FILM.id + '&subtitleId=s1')
  assert.equal(vtt.status, 200)
  assert.match(vtt.headers['content-type'], /text\/vtt/)
  assert.match(vtt.text, /^WEBVTT/)
  assert.match(vtt.text, /00:00:01\.000 --> 00:00:02\.000/)
})

/* ------------------------------------------------------ the folder picker -- */

test('the folder picker lists folders and never files', async (t) => {
  const { c } = await loggedIn(t)
  // Its own tree, NOT the host's data dir - that one has corestore's `store` in it
  // and the assertion below is about what the picker shows, not about rocksdb.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-browse-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  await fsp.mkdir(path.join(dir, 'Movies'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'Movies', 'Metropolis.mkv'), 'x')
  await fsp.writeFile(path.join(dir, 'a-secret.txt'), 'x')

  const res = await c.req('GET', '/api/source/folders?path=' + encodeURIComponent(dir))
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.dirs.map(d => d.name), ['Movies'])
  assert.equal(res.json.dirs[0].video, true, 'a folder with video in it should say so')
  assert.doesNotMatch(res.text, /a-secret\.txt/, 'the picker must never list files')
})

test('a path that does not exist says WHY, and what the host can actually see', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('GET', '/api/source/folders?path=/definitely-not-here')
  assert.equal(res.status, 400)
  assert.match(res.json.error, /does not exist inside the PearCinema container/)
})

/* ------------------------------------------------------------- operating -- */

test('a pairing window hands back a PearCinema link and a QR', async (t) => {
  const { c, host } = await loggedIn(t)

  const res = await c.req('POST', '/api/pair/start', { body: {} })
  assert.equal(res.status, 200)
  // The scheme is the app's own, which is what stops a PearTune phone parsing it.
  assert.match(res.json.link, /^pear:\/\/pearcinema\/pair\?/)
  assert.match(res.json.svg, /^<svg/)
  assert.equal(res.json.owner, false)
  assert.equal(res.json.guest, false)

  // Reload the page mid-window and the code must come back rather than the button.
  const state = await c.req('GET', '/api/state')
  assert.equal(state.json.pairing.open, true)
  assert.equal(state.json.pairing.link, res.json.link)

  const guest = await c.req('POST', '/api/pair/start', { body: { expiresMs: 3600e3 } })
  assert.equal(guest.json.guest, true)

  const owner = await c.req('POST', '/api/pair/start', { body: { owner: true } })
  assert.equal(owner.json.owner, true)
  assert.equal(owner.json.guest, false, 'owner XOR guest - an owner is never time-limited')

  await c.req('POST', '/api/pair/stop', { body: {} })
  assert.equal(host.pairing, false)
})

test('revoke reports how many live connections it cut, because that is the claim', async (t) => {
  const { c, host } = await loggedIn(t)
  const key = b4a.alloc(32, 7)
  await host.grants.grant({ deviceKey: key, label: 'A phone', platform: 'android' })

  const before = await c.req('GET', '/api/state')
  assert.equal(before.json.devices.length, 1)

  // Device keys travel as z32 everywhere, which is what the page has in hand.
  const res = await c.req('POST', '/api/revoke', { body: { deviceKey: before.json.devices[0].deviceKey } })
  assert.equal(res.status, 200)
  assert.equal(typeof res.json.killed, 'number')

  const after = await c.req('GET', '/api/state')
  assert.ok(after.json.devices[0].revokedAt, 'the row survives as a tombstone')
})

test('renaming the library sticks, and an empty name is refused', async (t) => {
  const { c, host } = await loggedIn(t)
  assert.equal((await c.req('POST', '/api/library', { body: { name: '  ' } })).status, 400)

  const ok = await c.req('POST', '/api/library', { body: { name: 'Tim s Films' } })
  assert.equal(ok.json.name, 'Tim s Films')
  assert.equal(host.libraryName, 'Tim s Films')
})

test('the source Test button checks without saving, and a bad save leaves the old one serving', async (t) => {
  const { c, host } = await loggedIn(t)

  const bad = await c.req('POST', '/api/source', { body: { kind: 'folder', roots: ['/definitely-not-here'] } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.stillServing, 'test', 'the old adapter must still be the live one')
  assert.equal(host.adapter.kind, 'test')
})

test('A FOLDER SAVED WITH A TYPE COMES BACK WITH IT, and the state says what it resolved to', async (t) => {
  // The round trip is the whole feature: the panel saves what the operator declared,
  // the adapter reads its files that way, and the state hands back BOTH - what was
  // declared and what it was read as - so an untyped folder called `TV Shows` can say
  // out loud that it is being treated as television.
  const { c } = await loggedIn(t)

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-roots-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await fsp.mkdir(path.join(root, 'TV Shows'), { recursive: true })
  await fsp.mkdir(path.join(root, 'Odds and Ends'), { recursive: true })

  const res = await c.req('POST', '/api/source', {
    body: {
      kind: 'folder',
      roots: [
        { path: path.join(root, 'Odds and Ends'), type: 'shows' },
        path.join(root, 'TV Shows')
      ]
    }
  })
  assert.equal(res.status, 200)

  const state = await c.req('GET', '/api/state')
  assert.deepEqual(state.json.source.roots.map(r => [path.basename(r.path), r.type, r.holds]), [
    ['Odds and Ends', 'shows', 'shows'],
    // Nobody typed this one; its own name did.
    ['TV Shows', 'auto', 'shows']
  ])
})

test('a platform-set password cannot be changed from the page', async (t) => {
  const ctx = await cinema(t)
  const c = client(ctx.base)
  await c.login(PASSWORD)
  await ctx.dash.close()

  // Restart it as the platform would: the password came from the environment.
  const dash = await startDashboard({
    host: ctx.host, bind: '127.0.0.1', port: 0, password: PASSWORD, passwordSource: 'explicit'
  })
  t.after(() => dash.close())

  const c2 = client(`http://127.0.0.1:${dash.port}`)
  await c2.login(PASSWORD)
  const res = await c2.req('POST', '/api/password', { body: { current: PASSWORD, next: 'something-else' } })
  assert.equal(res.status, 400)
  assert.match(res.json.error, /PEARCINEMA_PASSWORD/)
})

test('changing an owned password takes effect immediately and is persisted 0600', async (t) => {
  const { c, dir } = await loggedIn(t)

  assert.equal((await c.req('POST', '/api/password', { body: { current: 'wrong', next: 'long-enough-1' } })).status, 401)
  assert.equal((await c.req('POST', '/api/password', { body: { current: PASSWORD, next: 'short' } })).status, 400)

  const ok = await c.req('POST', '/api/password', { body: { current: PASSWORD, next: 'long-enough-1' } })
  assert.equal(ok.status, 200)

  const file = path.join(dir, 'dashboard-password')
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'long-enough-1')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

/* ---------------------------------------------------------------- the page -- */

test('the built page is committed, self-contained and actually the app', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'host', 'ui', 'dashboard.html'), 'utf8')

  assert.ok(html.length > 20_000, 'the bundle looks empty - has npm run build:dashboard been run?')
  assert.match(html, /<div id="root">/)

  // Self-contained: a page that fetched a CDN would be broken on the LAN-only,
  // offline-by-design box this ships to.
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external script')
  assert.doesNotMatch(html, /<link[^>]+stylesheet/, 'no external stylesheet')

  // The build escapes </script> inside the bundle. If that ever regressed the page
  // would truncate silently, which is precisely the blank-control-plane failure the
  // build exists to prevent.
  const scripts = html.match(/<\/script>/g) || []
  assert.equal(scripts.length, 1, 'exactly one closing script tag')

  // THE STALE-BUILD CHECK. Strings that only exist in the current source, so a
  // forgotten rebuild after adding a screen fails here rather than shipping.
  for (const marker of ['Pair a device', 'Try anyway', 'Where the films are', 'Welcome to PearCinema', 'repackaged', 'Reading your library']) {
    assert.ok(html.includes(marker), `the built page is stale: it is missing "${marker}"`)
  }
})

test('the login page is one intact template literal and carries a form, not the app', () => {
  // The donor's trap: a stray backtick in this file closes the string and the page
  // stops parsing. Requiring it is the parse.
  const page = require('../host/ui/login')
  assert.equal(typeof page, 'string')
  assert.match(page, /<form/)
  assert.match(page, /\/api\/login/)
  assert.doesNotMatch(page, /id="root"/)
})

/* -------------------------------------------------------------- the units -- */

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 })
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 })
  assert.deepEqual(parseRange('bytes=0-99999', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=1000-', 1000), { unsatisfiable: true })
  assert.deepEqual(parseRange('bytes=500-100', 1000), { unsatisfiable: true })
  // Malformed is "serve the whole thing", not an error - a browser that asked badly
  // still wants video.
  assert.equal(parseRange('bytes=abc', 1000), null)
  assert.equal(parseRange('', 1000), null)
})

test('srtToVtt', () => {
  const out = srtToVtt('1\n00:01:02,500 --> 00:01:04,000\nHi\n')
  assert.match(out, /^WEBVTT\n\n/)
  assert.match(out, /00:01:02\.500 --> 00:01:04\.000/)
  // Already-VTT input is left alone rather than getting a second header.
  assert.equal(srtToVtt('WEBVTT\n\nx').startsWith('WEBVTT\n\nx'), true)
})

test('mimeFor never guesses a playable type for something it does not know', () => {
  assert.equal(mimeFor('matroska'), 'video/x-matroska')
  assert.equal(mimeFor('avi'), 'video/x-msvideo')
  assert.equal(mimeFor(null), 'application/octet-stream')
  assert.equal(mimeFor('wildly-unknown'), 'application/octet-stream')
})

/* --------------------------------------------------------------- the remux -- */

test('a film the browser refuses comes back repackaged, and the picture is not touched', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg on this machine')
  const { c } = await loggedIn(t)

  // FILM is matroska/h264/aac - the 83% case. A Chrome-shaped client refuses the
  // container and can decode everything inside it.
  const res = await c.req('GET', '/api/stream'.replace('stream', 'remux') +
    '?id=' + FILM.id + '&containers=mp4&video=h264&audio=aac')

  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'video/mp4')
  // Generated bytes have no stable offsets, so seeking is a re-request rather than a
  // range. Saying `none` is how the browser is told not to try.
  assert.equal(res.headers['accept-ranges'], 'none')
  assert.equal(res.headers['x-pearcinema-start'], '0')
  assert.equal(res.headers['x-pearcinema-audio'], 'copy', 'AAC needs no rebuilding')
  assert.ok(res.body.length > 1000, 'it produced actual video')
  // `ftyp` then `moov`: a fragmented MP4 header, which is what makes this pipeable.
  assert.equal(res.body.subarray(4, 8).toString(), 'ftyp')
})

test('THE HOST DECIDES: a client that can already open the file is told to direct play', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg on this machine')
  const { c, adapter } = await loggedIn(t)
  adapter.calls.length = 0

  // ExoPlayer-shaped: opens Matroska happily.
  const res = await c.req('GET', '/api/remux?id=' + FILM.id + '&containers=mp4,matroska&video=h264&audio=aac')

  assert.equal(res.status, 409)
  assert.equal(res.json.mode, 'direct')
  assert.equal(adapter.calls.length, 0, 'and no bytes were produced for it')
})

test('a film that cannot be repackaged says so instead of starting an encoder', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg on this machine')
  const { c } = await loggedIn(t)
  // A client that cannot decode H.264 at all. Repackaging cannot change the picture.
  const res = await c.req('GET', '/api/remux?id=' + FILM.id + '&containers=mp4&video=vp9&audio=aac')
  assert.equal(res.status, 409)
  assert.equal(res.json.mode, 'refuse')
  assert.match(res.json.reason, /cannot change the picture/)
})

test('a seek asks the host to start again, and it says where it actually started', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg on this machine')
  const { c } = await loggedIn(t)
  const res = await c.req('GET', '/api/remux?id=' + FILM.id + '&t=1&containers=mp4&video=h264&audio=aac')
  assert.equal(res.status, 200)
  // `-ss` with `-c copy` lands on the nearest keyframe at or before the asked-for
  // time, so the player is told the offset it GOT rather than the one it wanted.
  assert.equal(res.headers['x-pearcinema-start'], '1')
})

test('an unknown film is a 404 rather than a spawned process', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg on this machine')
  const { c, host } = await loggedIn(t)
  const res = await c.req('GET', '/api/remux?id=not-a-film&containers=mp4&video=h264&audio=aac')
  assert.equal(res.status, 404)
  assert.equal(host.remuxer.running, 0)
})

test('NO FFMPEG OUTLIVES ITS RESPONSE', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg on this machine')
  const { c, host } = await loggedIn(t)

  await c.req('GET', '/api/remux?id=' + FILM.id + '&containers=mp4&video=h264&audio=aac')
  // The response is complete, so the process must be gone. An ffmpeg left holding a
  // file handle on somebody's library drive is, on a small box, the whole box.
  await new Promise(r => setTimeout(r, 400))
  assert.equal(host.remuxer.running, 0)
})

test('the host refuses a fourth film rather than queueing it behind three', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg on this machine')
  const { c, host } = await loggedIn(t)

  // Fill the cap without draining the responses, which is what a real viewer does.
  for (let i = 0; i < 3; i++) {
    host.remuxer.start({ input: FIXTURE_MKV, at: 0, audio: 'copy' })
  }
  const res = await c.req('GET', '/api/remux?id=' + FILM.id + '&containers=mp4&video=h264&audio=aac')
  assert.equal(res.status, 503)
  assert.match(res.json.error, /already repackaging/)
  host.remuxer.killAll()
})

test('THE PAGE IS SERVED WHILE THE LIBRARY IS STILL BEING READ', async (t) => {
  // Measured on the Umbrel against the real 3 TB drive: the first scan walks 2,986
  // films and episodes and probes every one with ffprobe, which takes about four
  // minutes. Scanning before listening meant the DHT was silent and the page did not
  // exist for that whole time, so a fresh install answered nothing at all - which is
  // indistinguishable from a broken one.
  const { c, host } = await loggedIn(t)

  host.scanning = { done: 1500, total: 2986, startedAt: Date.now() }
  const res = await c.req('GET', '/api/state')

  assert.equal(res.status, 200, 'the page answers DURING a scan, not only after')
  assert.deepEqual(res.json.scanning, { done: 1500, total: 2986, startedAt: host.scanning.startedAt })

  host.scanning = null
  assert.equal((await c.req('GET', '/api/state')).json.scanning, null)
})

test('a device can pair while the library is still being read', async (t) => {
  // The moment somebody is MOST likely to try, on a fresh install. Pairing does not
  // depend on the scan, so it must not wait for it.
  const { c, host } = await loggedIn(t)
  host.scanning = { done: 10, total: 2986, startedAt: Date.now() }

  const res = await c.req('POST', '/api/pair/start', { body: {} })
  assert.equal(res.status, 200)
  assert.match(res.json.link, /^pear:\/\/pearcinema\/pair\?/)
  host.stopPairing()
})

/* ------------------------------------------- where you stopped, per person -- */
//
// Approved as a T2 in proposals/2026-08-13-watch-state.md. The claim being pinned is
// Tim's requirement: per USER, not per device. A phone gets that free - the package
// derives its owner from the Noise-authenticated connection - but a browser arrives
// with a password and nothing else, so the routes below are where it is either true
// or quietly wrong.

test('A BROWSER THAT HAS NEVER WATCHED ANYTHING HOLDS NOBODY', async (t) => {
  // Lazily created, so a host nobody watches on carries no person it never needed.
  const { c, host } = await loggedIn(t)
  assert.deepEqual(await host.grants.listPersons(), [])

  const state = await c.req('GET', '/api/watch/state')
  assert.equal(state.json.watching, null)
  assert.deepEqual(state.json.continue, [])
})

test('the first thing watched creates the person, and it is renameable like any other', async (t) => {
  const { c, host } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 90_000 } })

  const persons = await host.grants.listPersons()
  assert.equal(persons.length, 1, 'one, not one per browser')
  assert.equal(persons[0].name, 'Me')

  const state = await c.req('GET', '/api/watch/state')
  assert.equal(state.json.watching.name, 'Me')
  assert.deepEqual(state.json.choose, [], 'one person is not a choice worth showing')
})

test('IT REMEMBERS WHERE YOU STOPPED, and the film comes back with its title', async (t) => {
  const { c } = await loggedIn(t)
  // Metropolis is 153 SECONDS in this fixture, so 100 seconds in is two thirds
  // through - part-watched rather than finished.
  await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 100_000 } })

  const state = await c.req('GET', '/api/watch/state')
  assert.equal(state.json.continue.length, 1)
  assert.equal(state.json.continue[0].title, 'Metropolis')
  assert.equal(state.json.continue[0].resume.positionMs, 100_000)
})

test('THE RUNTIME COMES FROM THE LIBRARY, never from the browser', async (t) => {
  // A client that could name its own duration could mark anything watched by
  // claiming a two-hour film is one second long. Metropolis is 153 seconds here, so
  // 150 seconds in is finished and the browser said nothing about it.
  const { c } = await loggedIn(t)
  const res = await c.req('POST', '/api/watch/position', {
    body: { itemId: FILM.id, positionMs: 150_000, durationMs: 1 }
  })
  assert.equal(res.json.finished, true)

  const state = await c.req('GET', '/api/watch/state')
  assert.deepEqual(state.json.watched, [FILM.id])
  assert.deepEqual(state.json.continue, [], 'and it is not also sitting in continue-watching')
})

test('ONE PLACE CAN BE FORGOTTEN WITHOUT CLAIMING TO HAVE WATCHED IT', async (t) => {
  // Marking something watched already takes it off the shelf, and for anything
  // abandoned rather than finished that is a lie which then shows up as a tick
  // everywhere else. A zero position is the delete, the same write a finished
  // film makes, so there is no second removal path.
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 100_000 } })
  assert.equal((await c.req('GET', '/api/watch/state')).json.continue.length, 1)

  await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 0 } })
  const after = await c.req('GET', '/api/watch/state')
  assert.deepEqual(after.json.continue, [], 'off the shelf')
  assert.deepEqual(after.json.watched, [], 'and NOT marked as watched')
})

test('CLEARING THE SHELF FORGETS THE PLACES, it does not merely hide them', async (t) => {
  // Tim, 2026-08-20. A clear that kept the positions would leave every one of
  // those films still offering to resume, which is two answers to one question.
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 100_000 } })
  await c.req('POST', '/api/watch/position', { body: { itemId: 'wire-s01e02', positionMs: 900_000 } })
  assert.equal((await c.req('GET', '/api/watch/state')).json.continue.length, 2)

  const cleared = await c.req('POST', '/api/watch/clear', { body: {} })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.cleared, 2)

  const after = await c.req('GET', '/api/watch/state')
  assert.deepEqual(after.json.continue, [])
  assert.deepEqual(after.json.watched, [], 'clearing is not marking everything watched')
  // The places are GONE, not hidden: nothing left to resume.
  assert.equal((await c.req('POST', '/api/watch/clear', { body: {} })).json.cleared, 0)
})

test('a minute in is not watching it', async (t) => {
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: MP4.id, positionMs: 20_000 } })
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.continue, [])
})

test('MARKING IT UNWATCHED BY HAND STICKS', async (t) => {
  // The affordance everybody reaches for when somebody else watched an episode. It
  // must beat the automatic mark rather than being overwritten by it.
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 150_000 } })
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.watched, [FILM.id])

  await c.req('POST', '/api/watch/watched', { body: { itemId: FILM.id, watched: false } })
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.watched, [])
})

test('marking it watched by hand clears the position too', async (t) => {
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 90_000 } })
  await c.req('POST', '/api/watch/watched', { body: { itemId: FILM.id, watched: true } })

  const state = await c.req('GET', '/api/watch/state')
  assert.deepEqual(state.json.watched, [FILM.id])
  assert.deepEqual(state.json.continue, [], 'a finished film does not also sit half-watched')
})

test('an item that has left the library is dropped rather than drawn as a dead card', async (t) => {
  const { c, host } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: 'gone-away', positionMs: 90_000 } })
  assert.equal((await c.req('GET', '/api/watch/state')).json.continue.length, 0)
  assert.ok(host)
})

test('TWO PEOPLE ON ONE MACHINE KEEP TWO HISTORIES', async (t) => {
  // The whole requirement in one test: per USER, not per device. Same browser, same
  // password, two people - and the film one of them finished is not ticked for the
  // other.
  const { c, host } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 150_000 } })

  const ben = await host.grants.addPerson('Ben')
  await c.req('POST', '/api/watch/as', { body: { personId: ben.id } })

  const asBen = await c.req('GET', '/api/watch/state')
  assert.equal(asBen.json.watching.name, 'Ben')
  assert.deepEqual(asBen.json.watched, [], "Ben has not seen Tim's film")
  // And with a second person on the box, the page is offered the choice.
  assert.equal(asBen.json.choose.length, 2)

  await c.req('POST', '/api/watch/position', { body: { itemId: MP4.id, positionMs: 120_000 } })
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.continue.map(i => i.id), [MP4.id])
})

test('IT ASKS RATHER THAN GUESSING when there are several people and no choice made', async (t) => {
  // Filing a film under the wrong person is worse than filing it under nobody.
  const { c, host } = await loggedIn(t)
  await host.grants.addPerson('Tim')
  await host.grants.addPerson('Ben')

  const state = await c.req('GET', '/api/watch/state')
  assert.equal(state.json.watching, null)
  assert.equal(state.json.choose.length, 2)

  const write = await c.req('POST', '/api/watch/position', { body: { itemId: FILM.id, positionMs: 90_000 } })
  assert.equal(write.json.needsPerson, true, 'and it does not invent a third person to hold it')
  assert.equal((await host.grants.listPersons()).length, 2)
})

test('a cookie naming a DELETED person does not file a film under a stranger', async (t) => {
  const { c, host } = await loggedIn(t)
  const ben = await host.grants.addPerson('Ben')
  await c.req('POST', '/api/watch/as', { body: { personId: ben.id } })
  await host.grants.deletePerson(ben.id)

  const state = await c.req('GET', '/api/watch/state')
  assert.equal(state.json.watching, null, 'the cookie is checked against the live list')
})

test('watching as somebody who does not exist is refused', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('POST', '/api/watch/as', { body: { personId: 'not-a-person' } })
  assert.equal(res.status, 400)
})

test('NONE OF THE WATCH ROUTES ANSWER A STRANGER', async (t) => {
  // The same rule every other route on this page follows. A watch position is a
  // small thing to leak and the list of them is not.
  const ctx = await cinema(t)
  const anon = client(ctx.base)

  // No body on the GET: a request the server answers 401 to without ever draining is
  // a reset socket rather than a clean status, which reads as a broken test instead
  // of the passing gate it is.
  assert.equal((await anon.req('GET', '/api/watch/state')).status, 401)
  for (const route of ['/api/watch/position', '/api/watch/watched', '/api/watch/as']) {
    assert.equal((await anon.req('POST', route, { body: {} })).status, 401, route)
  }
})

test('A PERSON CAN BE ADDED WITHOUT A DEVICE, or the chooser could never appear', async (t) => {
  // People used to exist only once a paired phone claimed a name. That is fine while
  // a person is a way to group devices and wrong the moment watch state is per
  // person: a household watching on one laptop would have nobody but the
  // auto-created "Me" and no way to make a second.
  const { c, host } = await loggedIn(t)
  const res = await c.req('POST', '/api/person', { body: { name: 'Ben' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.name, 'Ben')
  assert.equal((await host.grants.listPersons()).length, 1)

  // And it is immediately somebody this browser can watch as.
  const state = await c.req('GET', '/api/watch/state')
  assert.equal(state.json.watching.name, 'Ben', 'the only person is the one watching')
})

test('two people of one name is refused, because "revoke Sam" has to mean something', async (t) => {
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/person', { body: { name: 'Ben' } })
  const dup = await c.req('POST', '/api/person', { body: { name: 'ben' } })
  assert.equal(dup.status, 400)
  assert.match(dup.json.error, /already somebody called Ben/)

  assert.equal((await c.req('POST', '/api/person', { body: { name: '  ' } })).status, 400)
})

test('FINISH AN EPISODE AND THE NEXT ONE IS WAITING', async (t) => {
  // Deliberately left out of the first cut of watch state and built after, because it
  // is not the resume store at all - it is a lookup over the show's episodes that
  // happens to land on the same shelf.
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/watched', { body: { itemId: EPISODES[0].id, watched: true } })

  const state = await c.req('GET', '/api/watch/state')
  assert.deepEqual(state.json.upNext.map(i => i.id), [EPISODES[1].id])
  assert.equal(state.json.upNext[0].upNext, true, 'and it says it has not been started')
})

test('THE SAME EPISODE IS NEVER OFFERED TWICE', async (t) => {
  // Half way through episode two it is already on the shelf under its own name, with a
  // bar showing how far through. A "Next" card for it beside that would be worse than
  // offering nothing.
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/watched', { body: { itemId: EPISODES[0].id, watched: true } })
  await c.req('POST', '/api/watch/position', { body: { itemId: EPISODES[1].id, positionMs: 600_000 } })

  const state = await c.req('GET', '/api/watch/state')
  assert.deepEqual(state.json.continue.map(i => i.id), [EPISODES[1].id])
  assert.deepEqual(state.json.upNext, [])
})

test('a finished show stops appearing rather than looping back to episode one', async (t) => {
  const { c } = await loggedIn(t)
  for (const e of EPISODES) {
    await c.req('POST', '/api/watch/watched', { body: { itemId: e.id, watched: true } })
  }
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.upNext, [])
})

test('a finished FILM does not put up a next episode of anything', async (t) => {
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/watched', { body: { itemId: FILM.id, watched: true } })
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.upNext, [])
})

test('A SEASON SAYS WHAT IS LEFT OF IT, and a finished one says nothing more', async (t) => {
  // The show tile answers "is this worth opening"; the season tile answers "which one
  // am I on". Both are rollups over the episodes underneath, computed rather than
  // stored, so an episode landing in a folder cannot leave either one stale.
  const { c } = await loggedIn(t)

  // NOTHING BEFORE ANYBODY HAS WATCHED ANYTHING. A brand-new library has no person
  // yet, so every season would report "all of it left" - which is noise rather than
  // information, and it would put a number on every tile the day somebody installs.
  assert.deepEqual((await c.req('GET', '/api/watch/seasons?seriesId=' + SHOW.id)).json.seasons, {})

  await c.req('POST', '/api/watch/watched', { body: { itemId: EPISODES[0].id, watched: true } })
  let seasons
  seasons = (await c.req('GET', '/api/watch/seasons?seriesId=' + SHOW.id)).json.seasons
  assert.equal(seasons['wire-s01'].unwatched, 2)
  assert.equal(seasons['wire-s01'].complete, false)

  for (const e of EPISODES.slice(1)) {
    await c.req('POST', '/api/watch/watched', { body: { itemId: e.id, watched: true } })
  }
  seasons = (await c.req('GET', '/api/watch/seasons?seriesId=' + SHOW.id)).json.seasons
  assert.equal(seasons['wire-s01'].complete, true)
  assert.equal(seasons['wire-s01'].unwatched, 0)
})

test('MARKING A SEASON WATCHED MARKS ITS EPISODES, because that is all it could mean', async (t) => {
  // A show is not watched in its own right - it is watched when its episodes are. A
  // flag on the container would be a second source of truth that disagrees with the
  // count on its own tile the first time an episode is added.
  const { c } = await loggedIn(t)
  const res = await c.req('POST', '/api/watch/watched', { body: { itemId: 'wire-s01', watched: true } })
  assert.equal(res.json.items, 3)

  const state = await c.req('GET', '/api/watch/state')
  assert.deepEqual(state.json.watched.sort(), EPISODES.map(e => e.id).sort())

  // And back again, which is the half people actually need - somebody else watched a
  // season on your login.
  await c.req('POST', '/api/watch/watched', { body: { itemId: 'wire-s01', watched: false } })
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.watched, [])
})

test('marking a whole SHOW watched reaches every episode in it', async (t) => {
  const { c } = await loggedIn(t)
  const res = await c.req('POST', '/api/watch/watched', { body: { itemId: SHOW.id, watched: true } })
  assert.equal(res.json.items, 3)
  assert.equal((await c.req('GET', '/api/watch/state')).json.watched.length, 3)

  // A show whose episodes are all watched has nothing to offer next.
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.upNext, [])
})

test('marking a season watched clears any position inside it', async (t) => {
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: EPISODES[1].id, positionMs: 600_000 } })
  assert.equal((await c.req('GET', '/api/watch/state')).json.continue.length, 1)

  await c.req('POST', '/api/watch/watched', { body: { itemId: 'wire-s01', watched: true } })
  assert.deepEqual((await c.req('GET', '/api/watch/state')).json.continue, [])
})

test('STARTING AN EPISODE MARKS ITS SEASON AS THE ONE BEING WATCHED', async (t) => {
  // Tim's report, end to end: start the pilot, see it on the shelf, and the season it
  // belongs to has to say it is the one in progress - even though nothing in it is
  // finished.
  const { c } = await loggedIn(t)
  await c.req('POST', '/api/watch/position', { body: { itemId: EPISODES[0].id, positionMs: 480_000 } })

  const seasons = (await c.req('GET', '/api/watch/seasons?seriesId=' + SHOW.id)).json.seasons
  assert.equal(seasons['wire-s01'].started, true)
  assert.equal(seasons['wire-s01'].inProgress, 1)
  assert.equal(seasons['wire-s01'].watched, 0, 'and nothing is claimed as finished')

  // The show one level up says the same thing.
  const shows = (await c.req('GET', '/api/watch/shows')).json.shows
  assert.equal(shows[SHOW.id].started, true)
})

test('THE DOOR AND THE ROOM ARE THE SAME COLOURS', async (t) => {
  // The login page is the first thing anybody sees, and one in a different palette from
  // the app behind it reads as two programs - or as a phishing page, which is worse.
  // It is a standalone string by design (it is served to somebody not yet
  // authenticated, so it cannot pull in the dashboard bundle), which is exactly why the
  // palette can drift without anything noticing.
  const ctx = await cinema(t)
  const c = client(ctx.base)
  const res = await c.req('GET', '/')

  const page = res.text
  const app = fs.readFileSync(path.join(__dirname, '..', 'host', 'ui', 'dashboard.html'), 'utf8')

  for (const token of ['#e6b24e', '#0c0a07', '#f3ede1']) {
    assert.ok(page.includes(token), `the login page uses ${token}`)
    assert.ok(app.includes(token), `and so does the app: ${token}`)
  }
  assert.ok(!/#6ea8fe|#0e0f13/.test(page), 'and none of the palette it used to have')
})

test('A CODE ALREADY UP COMES BACK WITH ITS QR, not an empty white panel', async (t) => {
  // A window opened before the page loaded - a reload, a second tab, the phone being
  // carried to the machine - has to show the SAME code rather than silently opening a
  // second one. The link always came back; the picture of it did not.
  const { c } = await loggedIn(t)

  const started = await c.req('POST', '/api/pair/start', { body: {} })
  assert.equal(started.status, 200)
  assert.match(started.json.svg, /^<svg/)

  const state = await c.req('GET', '/api/state')
  assert.equal(state.json.pairing.open, true)
  assert.equal(state.json.pairing.link, started.json.link)
  assert.equal(state.json.pairing.svg, started.json.svg, 'the same code, not a fresh one')

  await c.req('POST', '/api/pair/stop', { body: {} })
  assert.equal((await c.req('GET', '/api/state')).json.pairing.open, false)
})

test('the transcode cap is a dashboard setting, zero is the off switch, and typos are refused', async (t) => {
  const { host, base } = await cinema(t)
  const c = client(base)
  await c.login(PASSWORD)

  // The field's save: applied live, remembered as the dashboard's choice.
  let res = await c.req('POST', '/api/transcode-cap', { body: { cap: 6 } })
  assert.equal(res.status, 200)
  assert.equal(res.json.cap, 6)
  assert.equal(res.json.source, 'dashboard')
  assert.equal(host.transcoder.maxConcurrent, 6)

  const state = await c.req('GET', '/api/state')
  assert.equal(state.json.transcodeCap.cap, 6)

  // ZERO IS THE OFF SWITCH, and it must reach decide() as "no transcode" -
  // honest refusals - not as starts bouncing off a closed pool as BUSY.
  host.transcode = { available: true, reason: null }
  assert.equal(host.transcodeOn(), true)
  await c.req('POST', '/api/transcode-cap', { body: { cap: 0 } })
  assert.equal(host.transcodeOn(), false)
  assert.equal(host.transcode.available, true, 'the probe verdict itself is untouched')

  // A cap of 200 is a typo, not a plan.
  res = await c.req('POST', '/api/transcode-cap', { body: { cap: 99 } })
  assert.equal(res.status, 400)
  res = await c.req('POST', '/api/transcode-cap', { body: { cap: 'lots' } })
  assert.equal(res.status, 400)
  assert.equal(host.transcoder.maxConcurrent, 0, 'refusals change nothing')
})

test('log out everywhere drops the other browsers and keeps the presser', async (t) => {
  const { base } = await cinema(t)
  const me = client(base)
  const laptop = client(base)
  await me.login(PASSWORD)
  await laptop.login(PASSWORD)

  assert.equal((await laptop.req('GET', '/api/state')).status, 200)

  const res = await me.req('POST', '/api/logout-everywhere', { body: {} })
  assert.equal(res.status, 200)
  assert.equal(res.json.others, 1)

  assert.equal((await me.req('GET', '/api/state')).status, 200, 'the presser stays')
  assert.equal((await laptop.req('GET', '/api/state')).status, 401, 'the laptop is out')
})

test('A HOST WHOSE DRIVE HAS GONE SAYS SO, and stops saying it when it comes back', async (t) => {
  // The dashboard already renders `sourceError` in two places - the Source panel and
  // across the top of the library - so the whole job is putting the truth in it. What
  // was missing is that nothing ever asked: a bind mount whose disk has been remounted
  // elsewhere is present, readable and empty, so the host stayed green while every
  // film 404d (Tim's Umbrel, 2026-08-19).
  const { host } = await cinema(t)

  // A source that cannot answer the question at all is left alone rather than being
  // reported as broken - a Jellyfin library has no drive to lose.
  assert.equal(await host._checkSource(), null)
  assert.equal(host.sourceError, null)

  let health = { ok: true }
  host._inner = { health: async () => health }

  await host._checkSource()
  assert.equal(host.sourceError, null)

  health = { ok: false, detail: '/library is readable but holds none of this library files - is the drive still mounted?' }
  await host._checkSource()
  assert.match(host.sourceError, /is the drive still mounted/)

  health = { ok: true }
  await host._checkSource()
  assert.equal(host.sourceError, null, 'and it clears itself when the drive returns')
})

test('the watchdog never tidies away a message it did not write', async (t) => {
  // `sourceError` belongs to whatever last failed. A scan that broke for its own
  // reasons owns it until a scan succeeds, and a watchdog that cleared it on the next
  // healthy tick would hide a real fault behind a readable folder.
  const { host } = await cinema(t)
  host._inner = { health: async () => ({ ok: true }) }

  host.sourceError = 'the credentials were refused'
  await host._checkSource()
  assert.equal(host.sourceError, 'the credentials were refused', 'not its message, not its to clear')
})

test('RESCAN ANSWERS AT ONCE AND SAYS SO ON /api/state', async (t) => {
  // Tim pressed Rescan against the real 3 TB library, watched the button read
  // "Rescanning…" for several minutes and had no way to tell whether anything was
  // happening (2026-08-19). Two faults in one: the route awaited the whole scan inside
  // the request, and it called `adapter.scan` directly - going around `host._scan`,
  // which is the only thing that sets `scanning`. So nothing anywhere could report it.
  const { host, adapter, base } = await cinema(t, { password: '' })
  const c = client(base)

  let release = null
  const held = new Promise(resolve => { release = resolve })
  adapter.scan = async ({ onProgress } = {}) => {
    onProgress?.(7, 42)
    await held
    return 42
  }

  const started = Date.now()
  const res = await c.req('POST', '/api/source/rescan', { body: {} })
  assert.equal(res.status, 200)
  assert.equal(res.json.started, true)
  assert.ok(Date.now() - started < 1000, 'it did not wait for the scan')

  const state = await c.req('GET', '/api/state')
  assert.equal(state.json.scanning.done, 7, 'and the progress is where every other slow thing puts it')
  assert.equal(state.json.scanning.total, 42)

  // Asking twice while one runs does not start a second walk of the drive.
  const again = await c.req('POST', '/api/source/rescan', { body: {} })
  assert.equal(again.json.started, undefined)
  assert.ok(again.json.scanning)

  release()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(host.scanning, null, 'and it is over when it is over')
})
