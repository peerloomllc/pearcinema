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
  // Where this person got to. Metropolis is half watched, Nosferatu is finished.
  '/api/watch/state': {
    watching: { id: 'p1', name: 'Me' },
    choose: [],
    watched: ['film-2'],
    continue: [{ ...FILM, resume: { positionMs: 76_500, playedAt: Date.now() } }],
    upNext: [{
      ...FILM,
      id: 'wire-s01e02',
      type: 'episode',
      seriesTitle: 'The Wire',
      seasonNumber: 1,
      episodeNumber: 2,
      title: 'The Detail',
      upNext: true
    }]
  },
  // A show half way through, so the tile can say which one is being watched.
  '/api/watch/shows': { shows: { 'show-1': { total: 10, watched: 4, unwatched: 6, complete: false } } },
  '/api/source/folders': { path: '/library', parent: '/', mounts: [], dirs: [{ name: 'Cartoons', path: '/library/Cartoons', video: true }] }
}

// Open the page with a stubbed API, wait for the first fetches to land, and hand
// back the document.
async function open (state = STATE, extraRoutes = {}) {
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
    const routes = { ...ROUTES, ...extraRoutes }
    const hit = Object.keys(routes).find(k => String(url).startsWith(k.split('?')[0]) && String(url).includes(k.split('?')[1] || ''))
    const body = hit === '/api/state' ? state : (hit ? routes[hit] : {})
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

  // The LIBRARY grid, not the continue-watching shelf above it - that one holds a
  // second copy of anything half-watched.
  const posters = [...doc.querySelectorAll('.grid')].slice(-1)[0].querySelectorAll('.poster')
  assert.equal(posters.length, 2)

  const nosferatu = [...posters].find(p => p.textContent.includes('Nosferatu'))
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

test('two folders holding the same file is said out loud, not absorbed', async (t) => {
  // A leaf id is minted from the path relative to its root, so two roots holding the
  // same collection mint the same id and only one copy stays reachable. Silence there
  // looks exactly like a library with fewer films in it than the drive has.
  const { dom, doc, win, text } = await open({ ...STATE, stats: { ...STATE.stats, duplicates: 3 } })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('.tab')].find(b => b.textContent.startsWith('Settings'))
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  assert.match(text(), /hold the same files/)
  assert.match(text(), /only one copy of each is reachable/)
})

/* --------------------------------------- where you stopped, on the page -- */

test('CONTINUE WATCHING IS ON SCREEN, with a bar showing how far through', async (t) => {
  // The row people actually use, so it sits above the library rather than behind a
  // tab. A shelf that renders empty would be a reproach, so it is only there when it
  // has something in it - and this state has one thing.
  const { dom, doc, text } = await open()
  t.after(() => dom.window.close())

  assert.match(text(), /Continue watching/)

  const bar = doc.querySelector('.resumebar i')
  assert.ok(bar, 'a poster in the shelf shows how far through it is')
  // Metropolis is 153 seconds and the position is 76.5 - half way, and the bar is
  // computed from a runtime in SECONDS against a position in MILLISECONDS.
  assert.equal(bar.style.width, '50%')
})

test('a film you have finished wears a tick, and one you have not does not', async (t) => {
  const { dom, doc } = await open()
  t.after(() => dom.window.close())

  const posters = [...doc.querySelectorAll('.poster')]
  const nosferatu = posters.filter(p => p.textContent.includes('Nosferatu'))
  const metropolis = posters.filter(p => p.textContent.includes('Metropolis'))

  // The tick IS the toggle now: one click on the thing itself corrects it, rather
  // than a trip into the player. Set means watched.
  assert.ok(nosferatu.some(p => p.querySelector('.mark.on')), 'the watched one is ticked')
  // Metropolis appears twice - once in the shelf, once in the grid - and neither is
  // ticked, because a half-watched film is not a finished one.
  assert.equal(metropolis.some(p => p.querySelector('.mark.on')), false)
  assert.ok(metropolis.every(p => p.querySelector('.mark')), 'but both can be marked by hand')
})

test('WITH ONE PERSON THERE IS NO CHOICE TO MAKE', async (t) => {
  // A household of one must never be asked a question with one answer.
  const { dom, doc } = await open()
  t.after(() => dom.window.close())
  assert.equal(doc.querySelector('.watchas'), null)
})

test('a second person on the box brings out the chooser', async (t) => {
  const { dom, doc, text } = await open(STATE, {
    '/api/watch/state': {
      watching: { id: 'p1', name: 'Me' },
      choose: [{ id: 'p1', name: 'Me' }, { id: 'p2', name: 'Ben' }],
      watched: [],
      continue: []
    }
  })
  t.after(() => dom.window.close())

  const sel = doc.querySelector('.watchas select')
  assert.ok(sel, 'the control appears only once there is somebody else to be')
  assert.match(text(), /Watching as/)
  assert.deepEqual([...sel.options].map(o => o.textContent), ['Me', 'Ben'])
})

test('opening a half-watched film OFFERS to resume rather than jumping', async (t) => {
  // Somebody who opened a film to watch the beginning again should not have to scrub
  // backwards out of a jump they never asked for.
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Metropolis'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  // jsdom decodes nothing, so every file lands on the refusal - and a film that
  // cannot play is not offered a resume, which is right. Force it open the way a
  // viewer would when canPlayType is wrong about their browser.
  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const offer = doc.querySelector('.resumeoffer')
  assert.ok(offer, 'the card is there')
  assert.match(offer.textContent, /You stopped at/)
  assert.match(offer.textContent, /Resume/)
  assert.match(offer.textContent, /Start over/)
  assert.ok(!/^0:00/.test(text()), 'and nothing has jumped on its own')
})

test('the next episode sits on the same shelf, saying it has not been started', async (t) => {
  const { dom, doc, text } = await open()
  t.after(() => dom.window.close())

  assert.match(text(), /The Detail/)
  const next = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Detail'))
  assert.ok(next.querySelector('.next'), 'a card for something unstarted says Next')
  assert.equal(next.querySelector('.resumebar'), null, 'and carries no how-far-through bar')

  // Mid-film first, then what to start next: one was stopped in the middle and the
  // other is a suggestion.
  const shelf = [...doc.querySelectorAll('.grid')][0].querySelectorAll('.poster')
  assert.match(shelf[0].textContent, /Metropolis/)
  assert.match(shelf[1].textContent, /The Detail/)
})

test('MARKING A FILM WATCHED IS ONE CLICK ON THE FILM', async (t) => {
  // The automatic rule will be wrong sometimes - a film watched on another device, an
  // episode somebody else put on - so the correction lives where the mistake is.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const sent = []
  const realFetch = win.fetch
  win.fetch = async (url, opts) => {
    if (String(url).includes('/api/watch/watched')) {
      sent.push(JSON.parse(opts.body))
      return { status: 200, ok: true, json: async () => ({ ok: true }) }
    }
    return realFetch(url, opts)
  }

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Nosferatu'))
  poster.querySelector('.mark').dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  assert.deepEqual(sent, [{ itemId: 'film-2', watched: false }], 'a watched film is marked UNwatched')
  // And the click must not have opened the player underneath it.
  assert.equal(doc.querySelector('video'), null)
  assert.equal(doc.querySelector('.refusal'), null)
})

test('THE ONE YOU ARE IN THE MIDDLE OF IS MARKED, not just counted', async (t) => {
  // A count of what is left cannot say it: a show nobody has touched and a show half
  // done both just show a number, and the one somebody is actually watching is the
  // one they came to the page for.
  const SHOW = {
    type: 'series', id: 'show-1', title: 'The Wire', year: 2002,
    seasonCount: 5, episodeCount: 60, overview: null, genres: [], artId: null
  }
  const { dom, doc, win } = await open(STATE, {
    '/api/library/list?type=series&limit=100': { items: [SHOW], total: 1, cursor: null }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Shows'))
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const tile = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Wire'))
  assert.ok(tile, 'the show is on screen')
  assert.ok(tile.classList.contains('started'), 'and it says it is the one being watched')

  // The same bar as a half-watched film, meaning the same thing at a different scale:
  // four episodes of ten.
  assert.equal(tile.querySelector('.resumebar i').style.width, '40%')
  assert.match(tile.textContent, /6/, 'and still says how many are left')
})

test('a show nobody has started is counted but not marked', async (t) => {
  const SHOW = {
    type: 'series', id: 'show-1', title: 'The Wire', year: 2002,
    seasonCount: 5, episodeCount: 60, overview: null, genres: [], artId: null
  }
  const { dom, doc, win } = await open(STATE, {
    '/api/library/list?type=series&limit=100': { items: [SHOW], total: 1, cursor: null },
    '/api/watch/shows': { shows: { 'show-1': { total: 10, watched: 0, unwatched: 10, complete: false } } }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Shows'))
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const tile = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Wire'))
  assert.equal(tile.classList.contains('started'), false)
  assert.equal(tile.querySelector('.resumebar'), null, 'and no bar, because there is nothing to show')
})
