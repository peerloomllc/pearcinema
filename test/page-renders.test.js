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
  source: { kind: 'folder', from: 'dashboard', roots: ['/library/Movies'], url: null, username: null },
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
  '/api/subtitles': { items: [] }
}

// Open the page with a stubbed API, wait for the first fetches to land, and hand
// back the document.
async function open () {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', e => errors.push(e))

  const dom = new JSDOM(PAGE, {
    runScripts: 'dangerously',
    url: 'http://localhost:8742/',
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
  const { dom, text } = await open()
  t.after(() => dom.window.close())

  // jsdom's canPlayType answers '' to everything, so it stands in for the strictest
  // possible browser: NOTHING is playable. The line must still be there and must
  // still count correctly rather than quietly showing a full library.
  assert.match(text(), /Your browser can play/)
  assert.match(text(), /remux/, 'the refusal has to point at the fix, not just refuse')
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
