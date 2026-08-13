// DOES THE PAGE ACTUALLY COME UP?
//
// This is the test PearTune did not have, and its absence is the whole reason
// PearCinema's page is a built app rather than a template literal. The donor's
// dashboard was a 700-line string; a syntax error inside it produced a completely
// BLANK CONTROL PLANE, and every test passed - because a string is a string, and
// nothing ever parsed it.
//
// Building the page catches a syntax error at build time. It does not catch a
// RUNTIME one: a bad import, a hook called wrongly, a null dereference in the first
// render. Those still produce a blank page, and every other test in this repo would
// still pass, because they all talk to the JSON API and never to the DOM.
//
// So this loads the actual committed dashboard.html into a DOM, stubs the API the
// way a real host answers it, and asserts that films appear on screen. It is slower
// than the rest of the suite and it earns that: it is the only test that can fail
// when the page is broken but the host is fine.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'host', 'ui', 'dashboard.html'), 'utf8')

const FILM = {
  type: 'movie',
  id: 'film-1',
  title: 'Metropolis',
  year: 1927,
  runtime: 153,
  overview: null,
  genres: [],
  artId: null,
  media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, size: 4096 }
}

const MKV = {
  ...FILM,
  id: 'film-2',
  title: 'Nosferatu',
  year: 1922,
  media: { ...FILM.media, container: 'matroska' }
}

const STATE = {
  library: 'The Cinema',
  libraryId: 'lib',
  hostKey: 'hostkey',
  stats: { movies: 2, series: 1, seasons: 1, episodes: 1, source: 'folder' },
  sourceError: null,
  // The host sends its ADAPTER's normalised roots: what the operator declared, and
  // what that resolved to. A bare string is the shape every host in the field saved,
  // and the panel still has to render it.
  source: {
    kind: 'folder',
    from: 'dashboard',
    roots: [
      { path: '/library/Movies', type: 'movies', holds: 'movies' },
      { path: '/library/TV Shows', type: 'auto', holds: 'shows' },
      '/library/Elements'
    ],
    url: null,
    username: null
  },
  devices: [{ deviceKey: 'dk1', label: 'A phone', platform: 'android', online: true, personId: null, claimedUser: 'Tim', lastSeen: Date.now(), scope: 'full' }],
  persons: [],
  pairing: { open: false },
  auth: { enabled: true, passwordSource: 'file' },
  bind: '127.0.0.1'
}

const ROUTES = {
  '/api/state': STATE,
  '/api/library/list?type=movies&limit=100': { items: [FILM, MKV], total: 2, cursor: null },
  '/api/library/list?type=series&limit=100': { items: [], total: 0, cursor: null },
  '/api/subtitles': { items: [] },
  '/api/source/detect': { servers: [], folders: [] },
  '/api/source/folders': { path: '/library', parent: '/', mounts: [], dirs: [{ name: 'Cartoons', path: '/library/Cartoons', video: true }] }
}

// Open the page with a stubbed API, wait for the first fetches to land, and hand
// back the document.
async function open () {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', e => errors.push(e))

  const dom = new JSDOM(PAGE, {
    runScripts: 'dangerously',
    url: 'http://localhost:8751/',
    pretendToBeVisual: true,
    virtualConsole: vc
  })

  const win = dom.window
  win.fetch = async (url) => {
    const key = Object.keys(ROUTES).find(k => String(url).startsWith(k.split('?')[0]) && String(url).includes(k.split('?')[1] || ''))
    const body = key ? ROUTES[key] : {}
    return { status: 200, ok: true, json: async () => body }
  }

  // Two turns: one for /api/state, one for the list it triggers.
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 15))

  return { dom, win, doc: win.document, errors, text: () => win.document.body.textContent }
}

test('the page mounts and shows the library, rather than a blank control plane', async (t) => {
  const { dom, doc, errors, text } = await open()
  t.after(() => dom.window.close())

  assert.deepEqual(errors, [], 'the page threw while starting up')

  const root = doc.getElementById('root')
  assert.ok(root.childNodes.length > 0, 'nothing rendered into #root - the page is blank')

  assert.match(text(), /PearCinema/)
  assert.match(text(), /Metropolis/)
  assert.match(text(), /Nosferatu/)

  // The three places, which is the whole navigation.
  assert.match(text(), /Watch/)
  assert.match(text(), /Devices/)
  assert.match(text(), /Settings/)
  assert.match(text(), /Pair a device/)
})

test('the compatibility line is on screen, and it is honest about the MKV', async (t) => {
  const { dom, doc, text } = await open()
  t.after(() => dom.window.close())

  // jsdom's canPlayType answers '' to everything, so it stands in for the strictest
  // possible browser: NOTHING is playable and nothing is repackageable either, since
  // repackaging still needs the browser to decode the picture.
  //
  // The COUNT is always shown; the reasoning is folded behind it, because three lines
  // of prose about codecs above every grid stands between somebody and their films.
  assert.match(text(), /play in this browser/)
  assert.ok(doc.querySelector('details.compat'), 'the reasoning is one click away, not in the way')
  assert.match(doc.querySelector('details.compat').textContent, /never the picture/)
})

test('clicking a film opens the player, and an MKV lands on the refusal rather than a black box', async (t) => {
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const posters = [...doc.querySelectorAll('.poster')]
  assert.equal(posters.length, 2)

  const nosferatu = posters.find(p => p.textContent.includes('Nosferatu'))
  nosferatu.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))

  // jsdom's canPlayType answers '' to everything, so it stands in for a browser that
  // can decode NOTHING - which means even repackaging cannot help it, and the player
  // has to say which half is the problem rather than spinning.
  assert.match(text(), /cannot be played here/)
  assert.match(text(), /Try anyway/)
  // A file nothing can play gets no controls either - there is nothing to control.
  assert.equal(doc.querySelector('.controls'), null)
  // And no <video> was created, so nothing is quietly buffering a film the browser
  // cannot show.
  assert.equal(doc.querySelector('video'), null)
})

test('the devices tab shows the phone and a way to cut it off', async (t) => {
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('.tab')].find(b => b.textContent.startsWith('Devices'))
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))

  assert.match(text(), /A phone/)
  assert.match(text(), /Cut off/)
})

test('EVERY FILM GETS THE SAME CONTROLS, whether it is repackaged or not', async (t) => {
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  // Metropolis here is mov/h264/aac - it plays straight from the file in a browser
  // that can open it. Nosferatu is matroska - repackaged. Under jsdom neither can be
  // decoded, so force one open to reach the player.
  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Metropolis'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))

  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  // Ours, always: one scrub bar, a clock, volume, and no native controls attribute.
  const controls = doc.querySelector('.controls')
  assert.ok(controls, 'the player has its own controls')
  assert.ok(controls.querySelector('input.scrub'), 'one scrub bar')
  assert.ok(controls.querySelector('input.vol'), 'volume')

  const v = doc.querySelector('video')
  assert.ok(v)
  assert.equal(v.hasAttribute('controls'), false, 'the native controls are gone, so there is only ever one bar')
})

test('EACH FOLDER SAYS WHAT IT HOLDS, and an untyped one says what that was read as', async (t) => {
  // The setting exists because some filenames say nothing at all - a box set numbered
  // K05 - and on the real library 34 television files were landing in the Films list
  // for want of anybody saying which folder was which. A control nobody can find does
  // not fix that, so this asserts it is on screen.
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('.tab')].find(b => b.textContent.startsWith('Settings'))
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  assert.match(text(), /\/library\/Movies/)

  const selects = [...doc.querySelectorAll('.roots .root select')]
  assert.equal(selects.length, 3, 'one per folder, including the bare string')
  assert.deepEqual(selects.map(s => s.value), ['movies', 'auto', 'auto'])

  // The resolution is SHOWN rather than silent: a folder called `TV Shows` left on
  // "work it out" says out loud that it was read as television, so nobody has to
  // reverse-engineer why their library sorted itself out.
  assert.match(selects[1].textContent, /Work it out \(tv shows\)/)
  // And a folder whose name says nothing claims nothing.
  assert.doesNotMatch(selects[2].textContent, /Work it out \(/)
})

test('a folder picked by hand arrives with a type control of its own', async (t) => {
  // The picker used to hand back a bare path, which is the shape the list held
  // before folders had types. Anything that adds a root has to add a typed one or
  // the row it produces has no control on it at all.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('.tab')].find(b => b.textContent.startsWith('Settings'))
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const add = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Add a folder'))
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const use = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Use /library'))
  assert.ok(use, 'the picker opened on what the host can see')
  use.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const rows = [...doc.querySelectorAll('.roots .root')]
  assert.equal(rows.length, 4, 'the three it had plus the one just picked')
  assert.equal(rows.every(r => r.querySelector('select')), true, 'every folder can say what it holds')
  assert.equal(rows[3].querySelector('select').value, 'auto')
})
