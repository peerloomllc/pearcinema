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

class TestAdapter {
  constructor () {
    this.kind = 'test'
    this.calls = []
  }

  async ping () { return { ok: true, detail: 'test' } }
  async scan () { return 2 }
  async stats () { return { movies: 2, series: 0, seasons: 0, episodes: 0, source: 'test' } }
  async list ({ type }) { return items.page(type === 'movies' ? [FILM, MP4] : [], {}) }
  async get ({ id }) { return [FILM, MP4].find(f => f.id === id) || null }
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
  let cookie = null
  return {
    get cookie () { return cookie },
    async req (method, pathname, { body, headers = {} } = {}) {
      const url = new URL(pathname, base)
      return new Promise((resolve, reject) => {
        const r = http.request({
          method,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers
          }
        }, res => {
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => {
            const set = res.headers['set-cookie']
            if (set) cookie = String(set[0]).split(';')[0]
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
