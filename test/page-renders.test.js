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
  // Artwork is on, so the tiles wear their fix control and the library can show a
  // pass's progress.
  metadata: { enabled: true, hasKey: true, running: null },
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
  // The tip rails. Stubbed because the page that renders them had NO test at all,
  // which is how it shipped throwing a ReferenceError the moment they arrived.
  '/api/donate': {
    rails: {
      ln: { svg: '<svg></svg>', caption: 'Lightning', value: 'lnurl1example' },
      onchain: { svg: '<svg></svg>', caption: 'On-chain', value: 'bc1example' },
      usd: { svg: '<svg></svg>', caption: 'Card or bank', value: 'https://example.com/tip' }
    }
  },
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
  '/api/watch/shows': { shows: { 'show-1': { total: 10, watched: 4, unwatched: 6, inProgress: 0, started: true, complete: false } } },
  '/api/source/folders': { path: '/library', parent: '/', mounts: [], dirs: [{ name: 'Cartoons', path: '/library/Cartoons', video: true }] },
  // BEFORE '/api/metadata', because the stub matches on prefix and the first key
  // wins - the search route would otherwise be shadowed by the summary.
  // The fix dialog's search, when a pencil is pressed.
  '/api/metadata/search': {
    candidates: [
      { tmdbId: 21, title: 'Crash', year: 1996, poster: '/c1.jpg', overview: 'the Cronenberg one' },
      { tmdbId: 22, title: 'Crash', year: 2004, poster: '/c2.jpg', overview: 'the other one' }
    ]
  },
  // WHICH ONE CAME BACK WITH NOTHING. Listed before '/api/metadata' for the same
  // reason the search route is: the stub matches by prefix in insertion order.
  '/api/metadata/missing': {
    items: [{ id: 'film-9', title: 'K05', year: null, type: 'movie', reason: null }]
  },
  // The artwork panel after a pass: posters fetched, two of them guesses - so the
  // honesty notice renders and can be asserted on.
  '/api/metadata': {
    enabled: true,
    hasKey: true,
    running: null,
    lastRun: { at: 1, looked: 6, matched: 5, uncertain: 2, missed: 1 },
    matched: 5,
    uncertain: 2,
    missed: 1
  }
}

// Open the page with a stubbed API, wait for the first fetches to land, and hand
// back the document.
// `delay` matters more than it looks. A stub that answers instantly cannot reproduce
// anything about REQUESTS IN FLIGHT - and the empty-season bug was exactly that: a
// first request still running when the real one arrived. A test written against an
// instant stub passed against the broken code.
async function open (state = STATE, extraRoutes = {}, asked = null, delay = 0) {
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
    if (asked) asked.push(String(url))
    if (delay) await new Promise(r => setTimeout(r, delay))
    const key = Object.keys(ROUTES).find(k => String(url).startsWith(k.split('?')[0]) && String(url).includes(k.split('?')[1] || ''))
    const routes = { ...ROUTES, ...extraRoutes }
    const hit = Object.keys(routes).find(k => String(url).startsWith(k.split('?')[0]) && String(url).includes(k.split('?')[1] || ''))
    const body = hit === '/api/state' ? state : (hit ? routes[hit] : {})
    return { status: 200, ok: true, json: async () => body }
  }

  // Two turns: one for /api/state, one for the list it triggers.
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 15))

  // THE RENDERED PAGE, NOT THE WHOLE DOCUMENT. `body.textContent` includes the inlined
  // script - the entire application bundle - so any assertion that something is ABSENT
  // matched its own source code and could never fail. Found 2026-08-13 by a test that
  // passed while the thing it was testing plainly worked.
  return { dom, win, doc: win.document, errors, text: () => win.document.getElementById('root').textContent }
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

  // The whole navigation, which is now the name plus three icons rather than three
  // words - see the header test below.
  assert.match(text(), /Pair a device/)
  for (const label of ['People and devices', 'Switch theme', 'Settings']) {
    assert.ok([...doc.querySelectorAll('button')].some(b => b.getAttribute('aria-label') === label), label)
  }
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

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  // IT IS A SETTINGS PAGE NOW (Tim, 2026-08-20), reached from the nav or straight
  // from the topbar icon - which keeps its dot and keeps Cut off one press away.
  assert.ok(doc.querySelector('.settings'), 'the topbar icon lands inside Settings')
  assert.equal(doc.querySelector('.setpagename').textContent, 'People')
  assert.ok([...doc.querySelectorAll('.setnav button.on')].some(b => b.textContent === 'People'),
    'and the nav says which page you are on')
  // This phone CLAIMS a name nobody has confirmed, which is the one thing on the page
  // waiting on the operator - so it heads the page rather than being mixed in with
  // devices that are simply unassigned.
  assert.match(text(), /Needs confirming/)
  assert.match(text(), /A phone/)
  // The way to cut it off is a picture now, so its label is where the words live.
  assert.ok([...doc.querySelectorAll('.setrow .rowctl button')]
    .some(b => b.getAttribute('aria-label') === 'Cut off A phone'))
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

test('THE ARTWORK PANEL SAYS THE PRIVACY SENTENCE, and admits which matches were guesses', async (t) => {
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  // Source, Artwork and Library are one page now - they were three nav items for one
  // subject, and two held a single control each (Tim, 2026-08-19).
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent === 'Library')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // The sentence IS the consent. A toggle without it is a host quietly telling a
  // third party what somebody owns. It sits above the switch it is about, and it is
  // all that is left of a five-line paragraph: what a key is and where to get one now
  // live in the key row and in the form that opens from it.
  assert.match(text(), /tells TMDB the titles it is identifying/)
  // "Off by default" was a claim about defaults on a page that can now just say what
  // this host is actually doing. The row's own name carries the state in colour and
  // its sub-line says it in words.
  const posters = [...doc.querySelectorAll('.setrow .rowname')].find(n => n.textContent.trim() === 'Posters')
  assert.ok(posters, 'artwork is a row now, not a card with a paragraph')
  assert.ok(posters.className.includes('good'), 'on, and the name says so')
  assert.match(posters.parentElement.textContent, /On · 5 titles have artwork/)
  // Nobody is quizzed: the guesses are counted and the correction is pointed at,
  // on the tile, where the mistake is visible (Tim, 2026-08-14).
  assert.match(text(), /matched from several possibilities/)
  assert.match(text(), /pencil on its tile/)
  assert.doesNotMatch(text(), /Which one is it/)
})

test('THE PENCIL IS ON THE TILE, and pressing it opens the fix dialog with candidates', async (t) => {
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  // Metropolis has no artwork of its own, so its tile offers the fix control.
  const pencil = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Fix the artwork for Metropolis')
  assert.ok(pencil, 'the fix control is on the tile')
  pencil.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  // The dialog carries the candidates AS TILES - the poster is the choice, so the
  // candidate itself is the button, with its thumbnail relayed through the host.
  assert.match(text(), /Fix the match: Metropolis/)
  const cards = [...doc.querySelectorAll('.cand')]
  assert.equal(cards.length, 2)
  assert.match(cards[0].textContent, /Crash/)
  assert.match(cards[0].textContent, /1996/)
  assert.match(cards[1].textContent, /2004/)
  assert.match(cards[0].querySelector('img').getAttribute('src'), /^\/api\/metadata\/preview\?p=/, 'the thumbnail comes from the HOST, never from TMDB directly')
  // And pressing the pencil did NOT open the film - the tile click was stopped.
  assert.equal(doc.querySelector('video'), null)
})

// THE PICKER LIVES BEHIND ONE BUTTON NOW. It is a folder browser, a roots editor, a
// Jellyfin form and a Save - a small app rather than a setting - and left open it was
// the whole Library page. Everything about it is unchanged; it is one press further in.
async function openSourceEditor (doc, win) {
  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const change = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => b.textContent.trim() === 'Change')
  assert.ok(change, 'the source row offers a way in')
  change.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
}

test('EACH FOLDER SAYS WHAT IT HOLDS, and an untyped one says what that was read as', async (t) => {
  // The setting exists because some filenames say nothing at all - a box set numbered
  // K05 - and on the real library 34 television files were landing in the Films list
  // for want of anybody saying which folder was which. A control nobody can find does
  // not fix that, so this asserts it is on screen.
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  await openSourceEditor(doc, win)

  assert.match(text(), /\/library\/Movies/)

  const selects = [...doc.querySelectorAll('.rootlist .rootrow select')]
  assert.equal(selects.length, 3, 'one per folder, including the bare string')
  assert.deepEqual(selects.map(s => s.value), ['movies', 'auto', 'auto'])

  // EVERY CHOOSER SAYS THE SAME THREE WORDS. It used to fold the resolution into the
  // option itself - "Work it out (tv shows)" - which made three different labels down
  // one column and left Tim asking what it meant (2026-08-19).
  assert.deepEqual([...selects[1].options].map(o => o.textContent), ['Automatic', 'Films', 'TV shows'])

  // The resolution is still SHOWN rather than silent, on the row's own second line, so
  // nobody has to reverse-engineer why their library sorted itself out.
  const rows = [...doc.querySelectorAll('.rootlist .rootrow')]
  assert.match(rows[1].textContent, /Read as TV shows\./)
  // And a folder whose name says nothing claims nothing.
  assert.doesNotMatch(rows[2].textContent, /Read as/)
})

test('a folder picked by hand arrives with a type control of its own', async (t) => {
  // The picker used to hand back a bare path, which is the shape the list held
  // before folders had types. Anything that adds a root has to add a typed one or
  // the row it produces has no control on it at all.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  await openSourceEditor(doc, win)

  const add = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Add a folder'))
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // The button says "Use this folder" rather than "Use /library/...": the path is in
  // the header above it, and a button that changes width at every step is a button
  // that moves under the pointer (Tim, 2026-08-19).
  const use = [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Use folder')
  assert.ok(use, 'the picker opened on what the host can see')
  assert.match(doc.querySelector('.picker .head .mono').textContent, /\/library/)
  use.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const rows = [...doc.querySelectorAll('.rootlist .rootrow')]
  assert.equal(rows.length, 4, 'the three it had plus the one just picked')
  assert.equal(rows.every(r => r.querySelector('select')), true, 'every folder can say what it holds')
  assert.equal(rows[3].querySelector('select').value, 'auto')
})

test('A FOLDER WITH NO FILMS IN IT CANNOT BE CHOSEN, and it says why', async (t) => {
  // Tim, 2026-08-19. The host already answers this for every folder it lists - it is
  // what puts the "video" mark on a row - so answering it for the folder you are
  // standing in costs nothing, and this window is where the mistake can still be
  // fixed by stepping into the right folder.
  const { doc, win, dom, text } = await open(STATE, {
    '/api/source/folders': { path: '/library/Docs', parent: '/library', mounts: [], dirs: [{ name: 'Manuals', path: '/library/Docs/Manuals', video: false }], here: 0 }
  })
  t.after(() => dom.window.close())

  await openSourceEditor(doc, win)
  const add = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Add a folder'))
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const use = [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Use folder')
  assert.equal(use.disabled, true)
  // The reason is in words, not only in a greyed-out button - and it says where it
  // looked, because the detector is bounded and can be wrong about a deep library.
  assert.match(text(), /No video in this folder or the few levels under it\./)
})

test('the whole filesystem is not a library', async (t) => {
  const { doc, win, dom, text } = await open(STATE, {
    '/api/source/folders': { path: '/', parent: null, mounts: ['/library'], dirs: [{ name: 'library', path: '/library', video: true }], here: 0 }
  })
  t.after(() => dom.window.close())

  await openSourceEditor(doc, win)
  const add = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Add a folder'))
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // There IS video under it - that is the point. Scanning from the root is still the
  // wrong answer, so the refusal is its own sentence rather than the missing-video one.
  const use = [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Use folder')
  assert.equal(use.disabled, true)
  assert.match(text(), /Pick one of the folders inside/)
})

test('two folders holding the same file is said out loud, not absorbed', async (t) => {
  // A leaf id is minted from the path relative to its root, so two roots holding the
  // same collection mint the same id and only one copy stays reachable. Silence there
  // looks exactly like a library with fewer films in it than the drive has.
  const { dom, doc, win, text } = await open({ ...STATE, stats: { ...STATE.stats, duplicates: 3 } })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
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

  // OVER THE PICTURE, not in a strip under it: a banner below the player is a notice
  // about the film, where this is a question about watching it.
  const offer = doc.querySelector('.stage .resumeover')
  assert.ok(offer, 'the prompt is over the picture itself')
  // AN EXACT TIME. Somebody deciding whether to resume is looking for the moment they
  // stopped, and "1m" does not tell them which of two attempts this was.
  assert.match(offer.textContent, /Resume at 1:16\?/)
  assert.match(offer.textContent, /Start Over/)
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

  // THE RING IS INSIDE THE PICTURE, not around the whole tile. Around the tile it
  // encloses the caption too, which reads as a focus rectangle rather than a mark of
  // progress - Tim sent a screenshot of exactly that.
  const ring = tile.querySelector('.ring')
  assert.ok(ring, 'the ring is there')
  assert.equal(ring.parentElement.className, 'art', 'and it is drawn on the artwork')

  // The same bar as a half-watched film, meaning the same thing at a different scale:
  // four episodes of ten.
  assert.equal(tile.querySelector('.resumebar i').style.width, '40%')

  // HALF WAY THROUGH, THE COUNT IS THE POINT: "6 left" tells somebody to open
  // it, which is exactly what a tick cannot. This is the case the badge exists
  // for, and the only one it now appears in.
  const badge = tile.querySelector('.left')
  assert.ok(badge, 'a started show says how many are left')
  assert.match(badge.textContent, /^6 left$/)
})

test('a show nobody has started carries no count at all, and no mark', async (t) => {
  const SHOW = {
    type: 'series', id: 'show-1', title: 'The Wire', year: 2002,
    seasonCount: 5, episodeCount: 60, overview: null, genres: [], artId: null
  }
  const { dom, doc, win } = await open(STATE, {
    '/api/library/list?type=series&limit=100': { items: [SHOW], total: 1, cursor: null },
    '/api/watch/shows': { shows: { 'show-1': { total: 10, watched: 0, unwatched: 10, inProgress: 0, started: false, complete: false } } }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Shows'))
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const tile = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Wire'))
  assert.equal(tile.classList.contains('started'), false)
  assert.equal(tile.querySelector('.ring'), null, 'and no ring on something nobody has begun')
  assert.equal(tile.querySelector('.resumebar'), null, 'and no bar, because there is nothing to show')

  // AND NO "10 LEFT" (Tim, 2026-08-17). On an untouched show the count IS the
  // episode count, which is how it came to be read as "how many episodes are in
  // this season". A number that only restates the thing beside it earns nothing.
  assert.equal(tile.querySelector('.left'), null, 'nothing to be left of yet')
})

test('a show with only a part-watched episode in it is STILL the one being watched', async (t) => {
  // Nothing finished, so the count says "10 left" exactly like an untouched show. The
  // tile is the only thing that can tell them apart.
  const SHOW = {
    type: 'series', id: 'show-1', title: 'The Wire', year: 2002,
    seasonCount: 5, episodeCount: 60, overview: null, genres: [], artId: null
  }
  const { dom, doc, win } = await open(STATE, {
    '/api/library/list?type=series&limit=100': { items: [SHOW], total: 1, cursor: null },
    '/api/watch/shows': { shows: { 'show-1': { total: 10, watched: 0, unwatched: 10, inProgress: 1, started: true, complete: false } } }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Shows'))
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const tile = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Wire'))
  assert.ok(tile.classList.contains('started'))
  // A sliver rather than an empty groove, which reads as a rendering fault.
  assert.equal(tile.querySelector('.resumebar i').style.width, '2%')
})

test('THE RING IS MEASURED AGAINST THE ARTWORK, which is what makes it hug the picture', async (t) => {
  // Tim caught this twice from screenshots - once as square corners around the caption,
  // once as rounded ones - and both times the DOM was right and the CSS was not. The
  // ring is absolutely positioned, so without a positioned `.art` its containing block
  // is `.poster`, which is the picture AND the words under it.
  //
  // Being in the right parent is not enough; there has to be something to be measured
  // against. That is the half a screenshot shows and a DOM assertion does not.
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

  const art = doc.querySelector('.poster.started .art')
  assert.ok(art.querySelector('.ring'), 'the ring is inside the artwork')
  assert.equal(win.getComputedStyle(art).position, 'relative',
    'and the artwork is what it is measured against')
})

/* ------------------------------------------------- the look and the movement -- */

test('THE EMOJI ARE GONE, and what replaced them is drawn in our own colours', async (t) => {
  // Every platform draws its own emoji, in its own colours, at its own weight - so a
  // page that mixes them with real interface reads as half-finished, which is the one
  // thing a control plane for somebody's film collection should not look like.
  const { dom, doc } = await open()
  t.after(() => dom.window.close())

  const art = doc.querySelector('.poster .art')
  assert.ok(art.querySelector('svg'), 'a film with no poster gets a drawn placeholder')
  assert.match(doc.body.innerHTML, /<svg/, 'and the page uses inline SVG rather than an icon font')

  // No stray pictographs anywhere on screen. Ranges rather than a list, so a new one
  // slipping in is caught too.
  const text = doc.body.textContent
  assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'no emoji left on the page')
})

test('MOVING DEEPER AND COMING BACK SAY SO', async (t) => {
  // A fade says only that something changed. The class is what carries the direction,
  // and it is the whole reason this was chosen over a cross-fade: a library four levels
  // deep - films, shows, seasons, episodes - is where "which way did I just go" starts
  // to matter.
  const SHOW = {
    type: 'series', id: 'show-1', title: 'The Wire', year: 2002,
    seasonCount: 1, episodeCount: 3, overview: null, genres: [], artId: null
  }
  const { dom, doc, win } = await open(STATE, {
    '/api/library/list?type=series&limit=100': { items: [SHOW], total: 1, cursor: null },
    '/api/library/list?type=seasons&limit=100': { items: [], total: 0, cursor: null }
  })
  t.after(() => dom.window.close())

  assert.ok(doc.querySelector('.screen'), 'the library is an animated screen')

  const shows = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Shows'))
  shows.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const tile = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Wire'))
  tile.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.ok(doc.querySelector('.screen').classList.contains('deeper') ||
            !doc.querySelector('.screen').classList.contains('back'), 'going in is "deeper"')

  const crumb = [...doc.querySelectorAll('.crumbs button')].find(b => b.textContent === 'Shows')
  crumb.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.ok(doc.querySelector('.screen').classList.contains('back'), 'and coming out is "back"')
})

test('THE LIST LOADS ITSELF - no button asking a question it knows the answer to', async (t) => {
  const many = Array.from({ length: 4 }, (_, i) => ({ ...FILM, id: 'f' + i, title: 'Film ' + i }))
  const { dom, doc, text } = await open(STATE, {
    '/api/library/list?type=movies&limit=100': { items: many, total: 200, cursor: 4 }
  })
  t.after(() => dom.window.close())

  assert.doesNotMatch(text(), /Load more/, 'the button is gone')
  assert.ok(doc.querySelector('.loadmore'), 'and there is a marker for the list to watch for')
})

test('AN EPISODE CAN CLIMB BACK TO ITS SEASON AND ITS SHOW', async (t) => {
  // A film has one place to go and "back to the library" says it. An episode is four
  // levels down, and offering only the way to the very top means anybody who wanted the
  // rest of the season has to walk back in from Shows.
  const EP = {
    type: 'episode', id: 'ep-1', seriesId: 'show-1', seasonId: 'season-1',
    seriesTitle: 'The Wire', seasonNumber: 1, episodeNumber: 2, seasonTitle: null,
    title: 'The Detail', year: 2002, runtime: 3600, overview: null, artId: null,
    media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, size: 4096 }
  }
  const { dom, doc, win, text } = await open(STATE, {
    '/api/watch/state': { watching: null, choose: [], watched: [], continue: [], upNext: [] },
    '/api/library/list?type=movies&limit=100': { items: [EP], total: 1, cursor: null }
  })
  t.after(() => dom.window.close())

  const tile = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Detail'))
  tile.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const crumbs = [...doc.querySelectorAll('.crumbs button')].map(b => b.textContent)
  assert.deepEqual(crumbs, ['Shows', 'The Wire', 'Season 1'], 'every level is reachable, not just the top')
  assert.match(text(), /S01E02/, 'and where you are is named rather than linked')
})

test('NOTHING STARTS PLAYING ON ITS OWN', async (t) => {
  // Opening a page should not fill a room with sound - and on a repackaged film it also
  // spends a child process on the host before anybody has said they want it.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Metropolis'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const v = doc.querySelector('video')
  assert.ok(v, 'the player is there')
  assert.equal(v.hasAttribute('autoplay'), false, 'and it waits to be asked')
})

test('OPENING A SEASON ASKS FOR THAT SEASON, not for nothing', async (t) => {
  // The bug behind an empty season page: this mounts with no season yet, that first
  // request is in flight, and the real query - the one carrying the season - arrived a
  // tick later and was dropped as a duplicate by an over-eager guard. Crumbs, a title
  // and no episodes.
  const EP = {
    type: 'episode', id: 'ep-1', seriesId: 'show-1', seasonId: 'season-1',
    seriesTitle: 'The Wire', seasonNumber: 1, episodeNumber: 2,
    title: 'The Detail', year: 2002, runtime: 3600, overview: null, artId: null,
    media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, size: 4096 }
  }
  const asked = []
  const { dom, doc, win } = await open(STATE, {
    '/api/watch/state': { watching: null, choose: [], watched: [], continue: [], upNext: [] },
    '/api/library/list?type=movies&limit=100': { items: [EP], total: 1, cursor: null },
    '/api/library/list?type=episodes&limit=200&seasonId=season-1': { items: [EP], total: 1, cursor: null }
  }, asked, 12)
  t.after(() => dom.window.close())

  const tile = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Detail'))
  tile.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const crumb = [...doc.querySelectorAll('.crumbs button')].find(b => b.textContent === 'Season 1')
  crumb.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))

  assert.ok(
    asked.some(u => u.includes('type=episodes') && u.includes('seasonId=season-1')),
    'the season it climbed to is the one it asked the host for'
  )
})

test('SWITCHING FILMS AND SHOWS LEAVES THE SHELF AND THE SWITCH ALONE', async (t) => {
  // Sliding those out and back makes the page look like it reloaded, and it takes the
  // button somebody just pressed out from under the pointer.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const shelfBefore = [...doc.querySelectorAll('h2')].find(h => h.textContent === 'Continue watching')
  assert.ok(shelfBefore)
  assert.equal(shelfBefore.closest('.screen'), null, 'the shelf is outside the moving part')

  const shows = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Shows'))
  assert.equal(shows.closest('.screen'), null, 'and so is the switch itself')

  shows.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.ok([...doc.querySelectorAll('h2')].some(h => h.textContent === 'Continue watching'),
    'so the shelf survives the switch')
})

test('THE DETAILS ARE ONE BUTTON AWAY, and cover nothing until asked', async (t) => {
  // The file's technical facts used to hold a permanent right-hand column, which made
  // the picture smaller on every screen to keep room for something most people never
  // read.
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Nosferatu'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const sheet = doc.querySelector('.sheet')
  assert.ok(sheet, 'the sheet exists')
  assert.equal(sheet.classList.contains('open'), false, 'and starts shut')
  assert.equal(sheet.getAttribute('aria-hidden'), 'true')

  const details = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Details')
  details.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))

  assert.ok(doc.querySelector('.sheet').classList.contains('open'), 'and opens when asked')
  assert.match(text(), /How it is playing/, 'with the facts in it')
})

test('PREVIOUS AND NEXT ARE A TELEVISION IDEA', async (t) => {
  // On a film the queue is whatever list it was opened from, so "next" would mean the
  // next film alphabetically - not a thing anybody wants offered. Hidden rather than
  // disabled: a permanently greyed-out control is still a control to read past.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Nosferatu'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const acts = [...doc.querySelectorAll('.acts button')].map(b => b.textContent.trim())
  assert.equal(acts.some(t => /Previous|Next/.test(t)), false, 'a film gets neither')

  // And the two that remain are icons carrying a state that has to be readable.
  // Nosferatu is watched in this state, so the control is set - and the label says
  // which way pressing it goes rather than what it currently is, because a tick on its
  // own means both "done" and "mark done".
  const watched = doc.querySelector('.acts button.icon[aria-pressed]')
  assert.ok(watched, 'the watched control says whether it is set')
  assert.equal(watched.getAttribute('aria-pressed'), 'true')
  assert.equal(watched.getAttribute('aria-label'), 'Mark as unwatched')
  assert.ok(watched.classList.contains('on'), 'and it is filled rather than outline')
})

test('an episode gets Previous and Next, and they are the same width as the rest', async (t) => {
  const EP = {
    type: 'episode', id: 'ep-1', seriesId: 'show-1', seasonId: 'season-1',
    seriesTitle: 'The Wire', seasonNumber: 1, episodeNumber: 2,
    title: 'The Detail', year: 2002, runtime: 3600, overview: null, artId: null,
    media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, size: 4096 }
  }
  const { dom, doc, win } = await open(STATE, {
    '/api/watch/state': { watching: null, choose: [], watched: [], continue: [], upNext: [] },
    '/api/library/list?type=movies&limit=100': { items: [EP], total: 1, cursor: null }
  })
  t.after(() => dom.window.close())

  const tile = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Detail'))
  tile.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const acts = [...doc.querySelectorAll('.acts button')]
  assert.deepEqual(acts.slice(0, 2).map(b => b.textContent.trim()), ['Previous', 'Next'],
    'named plainly - "Next episode" said the obvious twice')
  assert.equal(acts.length, 4, 'four controls: previous, next, watched, details')
})

test('the list view shows how far through an episode is, like the grid does', async (t) => {
  // The grid has said this since the shelf existed and the list said nothing, so the
  // same episode looked untouched in one view and half-watched in the other.
  const EP = {
    type: 'episode', id: 'ep-1', seriesId: 'show-1', seasonId: 'season-1',
    seriesTitle: 'The Wire', seasonNumber: 1, episodeNumber: 1,
    title: 'The Target', year: 2002, runtime: 3600, overview: null, artId: null,
    media: { container: 'mov', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, size: 4096 }
  }
  const SHOW = { type: 'series', id: 'show-1', title: 'The Wire', seasonCount: 1, episodeCount: 1, artId: null, genres: [], overview: null, year: 2002 }
  const SEASON = { type: 'season', id: 'season-1', seriesId: 'show-1', number: 1, title: 'Season 1', episodeCount: 1, artId: null }

  const { dom, doc, win } = await open(STATE, {
    '/api/watch/state': {
      watching: { id: 'p1', name: 'Me' }, choose: [], watched: [], upNext: [],
      continue: [{ ...EP, resume: { positionMs: 900_000, playedAt: Date.now() } }]
    },
    '/api/library/list?type=series&limit=100': { items: [SHOW], total: 1, cursor: null },
    '/api/library/list?type=seasons&limit=100': { items: [SEASON], total: 1, cursor: null },
    '/api/library/list?type=episodes&limit=200': { items: [EP], total: 1, cursor: null }
  })
  t.after(() => dom.window.close())

  const shows = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Shows'))
  shows.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  ;[...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Wire'))
    .dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  ;[...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Season 1'))
    .dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const list = [...doc.querySelectorAll('button')].find(b => b.textContent.trim().endsWith('List'))
  if (list) list.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const row = doc.querySelector('.eprow')
  assert.ok(row, 'the episode is in the list')
  const bar = row.querySelector('.rowbar i')
  assert.ok(bar, 'and it says how far through it is')
  assert.equal(bar.style.width, '25%', '15 minutes of an hour')
})

test('THE DETAILS SHEET IS NOT CLIPPED OUT OF EXISTENCE', async (t) => {
  // What Tim screenshotted: a page-sized dim overlay with nothing in it. The edge fade
  // was a MASK on the content, and a mask - like a filter or a transform - makes its
  // element the containing block for anything `position: fixed` inside it and clips it.
  // The sheet starts translated off to the right, so it was clipped away entirely and
  // only its scrim showed.
  const { dom, doc } = await open()
  t.after(() => dom.window.close())

  const content = doc.querySelector('.content')
  const style = dom.window.getComputedStyle(content)
  assert.equal(style.maskImage || 'none', 'none', 'the content masks nothing')
  assert.equal(style.webkitMaskImage || 'none', 'none')

  // AND THE STRIPS THAT REPLACED THE MASK ARE GONE TOO. A strip painting the page
  // colour to transparent is a visible BAND wherever what is behind it is not exactly
  // that colour - in light mode, a pale bar across the top of the library. The content
  // scrolls under a solid header with a border, which is a boundary already.
  assert.equal(doc.querySelector('.edge'), null, 'no painted strips over the page')
})

test('A PAUSED FILM SHOWS A PLAY BUTTON', async (t) => {
  // It used to assume playing, which was true while the element carried `autoplay` and
  // became a lie the moment it did not.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Metropolis'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const big = doc.querySelector('.controls .iconbtn.big')
  assert.ok(big, 'the transport button is there')
  assert.equal(big.getAttribute('aria-label'), 'Play', 'and it offers to start, not to stop')
})

test('nothing in the controls is an emoji', async (t) => {
  // The skip buttons were still ⏪ and ⏩ after everything else had been drawn.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Metropolis'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const controls = doc.querySelector('.controls')
  assert.doesNotMatch(controls.textContent, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
  assert.ok(controls.querySelectorAll('svg').length >= 5, 'they are drawn instead')
})

test('THE DETAILS SHEET STATES FACTS RATHER THAN BADGING THEM', async (t) => {
  // A coloured pill reads as a status somebody is meant to act on. These are
  // explanations - and "on the player" beside every usable subtitle was a label for the
  // obvious, since that list IS the list you can turn on.
  const { dom, doc, win } = await open(STATE, {
    '/api/subtitles': {
      items: [
        { id: 's1', title: 'English', language: 'en', external: true, playable: true, reason: null },
        { id: 's2', title: 'French', language: 'fr', external: false, playable: false, reason: 'These subtitles are pictures rather than text.' }
      ]
    }
  })
  t.after(() => dom.window.close())

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Nosferatu'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  ;[...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Details')
    .dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))

  const sheet = doc.querySelector('.sheet')
  assert.doesNotMatch(sheet.textContent, /on the player/, 'no badge on the ones that work')
  assert.equal(sheet.querySelectorAll('.chip').length, 0, 'and no pills anywhere in the sheet')

  // What earns its place is the opposite: the ones you cannot have, and why.
  assert.match(sheet.textContent, /not available/)
  assert.match(sheet.textContent, /pictures rather than text/)

  // The length is exact, because this panel was opened to see the facts about a file.
  // Nosferatu has no runtime in the fixture; Metropolis does - 153 seconds.
  assert.match(sheet.textContent, /How it is playing/)
})

test('the length in the sheet is exact, not rounded to the minute', async (t) => {
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Metropolis'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))
  ;[...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Details')
    .dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))

  // 153 seconds. "3m" rounds away more than half of what it is.
  assert.match(doc.querySelector('.sheet').textContent, /2 m 33 s/)
})

test('THE HEADER IS ONE HEIGHT, whatever tab you are on', async (t) => {
  // The search box used to be rendered only on Watch, so opening Devices took it out
  // and the whole bar shrank - the page jumped under the pointer on every tab change.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())

  const slot = doc.querySelector('.topbar .searchslot')
  assert.ok(slot, 'the middle of the bar always holds the search')
  assert.ok(slot.querySelector('.searchbox'), 'and on Watch there is a box in it')

  const devices = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  devices.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  // AND IT WORKS FROM ANYWHERE. Disabling it off the Watch tab was a rule about where
  // somebody happens to be standing rather than about what they want: typing a film's
  // name means "find me this film" wherever they are.
  const after = doc.querySelector('.topbar .searchslot .searchbox')
  assert.ok(after, 'the box is still there on another tab')
  assert.equal(after.querySelector('input').disabled, false, 'and still usable')
})

test('THE PAIRING MODAL IS PEARTUNE\'S, down to the words', async (t) => {
  // Pairing is the one flow somebody meets in both apps, usually minutes apart and
  // usually with a phone in the other hand. Two shapes for the same act is where a
  // companion app stops feeling like one.
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const pair = [...doc.querySelectorAll('button')].find(b => b.textContent === 'Pair a device')
  pair.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const seg = doc.querySelector('.seg.wide')
  assert.ok(seg, 'the segmented control, full width so its options are equal')
  assert.deepEqual([...seg.querySelectorAll('button')].map(b => b.textContent),
    ['Full access', 'Guest pass', 'Owner'])

  assert.match(text(), /Permanent access\. Scan the code in PearCinema on your phone\./)
  assert.match(text(), /Show pairing code/)

  // The stack of three cards it used to be is gone.
  assert.doesNotMatch(text(), /Open a window/)
  assert.doesNotMatch(text(), /Lend it for a while/)
})

test('THE PAGE DOES NOT SHIFT SIDEWAYS WHEN A SCROLLBAR ARRIVES', async (t) => {
  // Devices is short and Watch is long, so changing tab added or removed a scrollbar
  // and every centred thing on the page jumped by its width. Reserving the gutter
  // permanently means the space is always there and nothing reflows.
  const { dom, doc } = await open()
  t.after(() => dom.window.close())

  // THE SCROLLER IS THE CONTENT, NOT THE DOCUMENT - which is what keeps the scrollbar
  // below the header rather than running past it, and it is where the gutter has to be
  // reserved so a short tab and a long one do not shift everything sideways.
  const scroller = dom.window.getComputedStyle(doc.querySelector('.scroller'))
  assert.equal(scroller.scrollbarGutter, 'stable', 'the gutter is always reserved')
  assert.equal(scroller.overflowY, 'auto', 'and the content is what scrolls')
  assert.equal(dom.window.getComputedStyle(doc.body).overflow, 'hidden', 'the page itself does not')
})

test('THE HEADER IS A NAME, A SEARCH AND SOME TOOLS - and no tabs', async (t) => {
  // Centring the search was a problem that only existed because there were tabs on one
  // side and a button on the other. Without them there is nothing to balance, and the
  // honest answer was to stop trying: it is left aligned beside the name.
  const { dom, doc } = await open()
  t.after(() => dom.window.close())

  assert.equal(doc.querySelectorAll('.topbar .tab').length, 0, 'no text tabs in the bar')

  const bar = [...doc.querySelector('.topbar').children].map(c => c.className.split(' ')[0])
  assert.deepEqual(bar, ['brand', 'searchslot', 'barright'], 'name, search, tools')

  // A HOME ICON, not the brand mark. "Click the name to go back" is a thing somebody
  // has to be told, which is the definition of the wrong affordance - so the far left
  // is a home button that happens to carry the name.
  assert.match(doc.querySelector('.brand').getAttribute('aria-label'), /Back to the library/)
  assert.ok(doc.querySelector('.brand svg'), 'with an icon that says what it does')

  for (const label of ['People and devices', 'Switch theme', 'Settings']) {
    assert.ok([...doc.querySelectorAll('.barright button')].some(b => b.getAttribute('aria-label') === label), label)
  }
})

test('the page keeps one background, however far it scrolls', async (t) => {
  // A background set only on the body is propagated to the canvas - but the glow was
  // `background-attachment: fixed` on that same body, and past the first screenful the
  // propagated painting stopped agreeing with itself.
  const { dom, doc } = await open()
  t.after(() => dom.window.close())

  const html = dom.window.getComputedStyle(doc.documentElement)
  assert.match(html.background, /var\(--bg\)/, 'the flat colour is on the root itself')

  // THE GLOW BELONGS TO THE TOP OF THE LIBRARY, not to the window. On a scroll
  // container the default keeps a background pinned to the element while its content
  // moves - which is what made the warm patch follow the screen and read as the page
  // changing colour as you scrolled. `local` ties it to the content.
  const css = fs.readFileSync(path.join(__dirname, '..', 'host', 'ui', 'dashboard.html'), 'utf8')
  assert.match(css, /\.scroller\{[^}]*background-attachment:local/, 'the glow scrolls away with the page')
  assert.doesNotMatch(css, /background-attachment:fixed/, 'and nothing is pinned to the window')
})

test('the name is one word', async (t) => {
  // The header row has a `gap`, and a gap falls between text nodes as readily as
  // between boxes - so "Pear" and "Cinema" were being pushed apart.
  const { dom, doc } = await open()
  t.after(() => dom.window.close())
  assert.equal(doc.querySelector('.brand .word').textContent, 'PearCinema')
})

test('TYPING FROM ANOTHER PAGE TAKES YOU TO THE LIBRARY', async (t) => {
  // Disabling the box off the Watch tab was a rule about where somebody is standing
  // rather than about what they want. Typing a film's name means "find me this film".
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const access = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  access.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.match(text(), /A phone/, 'we are on the access page')

  const input = doc.querySelector('.searchbox input')
  input.value = 'metro'
  input.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  assert.doesNotMatch(text(), /Cut off/, 'and typing has carried us off it')
  assert.equal(doc.querySelector('.searchbox input').value, 'metro', 'with what was typed kept')
})

test('A PERSON IS ONE ROW UNTIL YOU OPEN THEM', async (t) => {
  // A household of four should be four lines, not a wall of devices - and the devices
  // belong UNDER the person, because revoking a person cuts off everything they hold
  // and the page should make that obvious without a paragraph explaining it.
  const withPerson = {
    ...STATE,
    persons: [{ id: 'p1', name: 'Tim', label: 'Tim' }],
    devices: [{
      // `confirmed` comes from the host now rather than being worked out on the
      // page by comparing the person's name with the claim.
      deviceKey: 'dk1', label: 'A phone', platform: 'android', online: true,
      personId: 'p1', claimedUser: 'Tim', confirmed: true, lastSeen: Date.now(), scope: 'full'
    }]
  }
  const { dom, doc, win, text } = await open(withPerson)
  t.after(() => dom.window.close())

  const access = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  access.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const row = [...doc.querySelectorAll('.setrow')].find(r => /1 device/.test(r.textContent))
  assert.ok(row, 'the person is a row')
  assert.match(row.querySelector('.rowname').textContent, /Tim/)

  // FOLDED, NOT ABSENT. The panel stays in the page so the fold can animate on the
  // way out as well as in - a thing that is not there cannot animate away - so what
  // is asserted is that it is SHUT, and hidden from anything that reads the page
  // rather than looks at it.
  const fold = row.nextElementSibling
  assert.ok(fold.classList.contains('rowfold'), 'their devices are behind a fold')
  assert.equal(fold.classList.contains('on'), false, 'which starts shut')
  assert.equal(fold.getAttribute('aria-hidden'), 'true')

  // THE CHEVRON IS THE LAST CONTROL IN THE ROW, after the pencil and the cut-off.
  const btns = row.querySelectorAll('.rowctl .iconbtn')
  const chevron = btns[btns.length - 1]
  assert.equal(chevron.getAttribute('aria-expanded'), 'false')
  chevron.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  assert.ok(fold.classList.contains('on'), 'opening them shows what they hold')
  assert.equal(fold.getAttribute('aria-hidden'), 'false')
  assert.equal(chevron.getAttribute('aria-expanded'), 'true')
  assert.match(fold.textContent, /A phone/)
  // CUT OFF IS STILL ONE PRESS FROM WHERE THE DEVICE IS NAMED. The reshape was not
  // allowed to cost that (Tim, 2026-08-20). It is an icon rather than a word now, so
  // the label it carries for a screen reader is what this asserts on - and that label
  // has to NAME the device, or a page of identical pictograms is unusable without a
  // pointer.
  const dev = [...doc.querySelectorAll('.rowopen .setrow')].find(r => /A phone/.test(r.textContent))
  const cut = [...dev.querySelectorAll('.rowctl button')].find(b => /^Cut off/.test(b.getAttribute('aria-label') || ''))
  assert.ok(cut, 'the device row still cuts off in one press')
  assert.equal(cut.getAttribute('aria-label'), 'Cut off A phone')
  assert.ok(cut.classList.contains('destructive'), 'and it is the one control wearing the danger colour')
})


// A helper, because every casting assertion needs the same two clicks to get there.
async function openCasting (t, routes = {}) {
  const opened = await open(STATE, routes)
  t.after(() => opened.dom.window.close())
  const { doc, win } = opened

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const cast = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent.trim() === 'Casting')
  if (cast) {
    cast.dispatchEvent(new win.Event('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 80))
  }
  return opened
}

const ROKU_TARGET = {
  entityId: 'roku:X0012345',
  name: 'Living Room',
  state: 'idle',
  supportedFeatures: 0,
  deviceClass: 'tv',
  hidden: false,
  host: '10.0.0.7',
  via: 'roku'
}

test('the casting panel says the one thing about Rokus nobody would guess', async (t) => {
  // A Roku needs the free Media Assistant channel installed, and that is not discoverable
  // from anywhere: Roku Media Player, the channel every document points at, opens and then
  // discards the film (measured on a real stick, 2026-08-18). Without this line a person
  // with a Roku sees an empty picker and no reason, because the reason lives only in a log
  // they will never read.
  const { text } = await openCasting(t)

  assert.match(text(), /Media Assistant/, 'the requirement has to be on the screen, not in a log')
  // AND ONLY WHERE IT IS ANY USE. An empty list is exactly the moment somebody wants to
  // know what would make it not empty; a page that already lists their television does
  // not need telling how televisions get found.
  assert.match(text(), /finds televisions on its own network/, 'the discovery half needs nothing said about it')
})

test('THE TELEVISIONS SHOW WITHOUT HOME ASSISTANT, which is most people', async (t) => {
  // The bug this rebuild was for. Everything on this page used to be gated on a Home
  // Assistant token, so a person with a Roku and nothing else was told "Casting is off"
  // and shown an empty page, while casting worked perfectly from their phone. Their
  // server had found the television. The page never asked.
  const { text, doc } = await openCasting(t, {
    // The specific route first: the stub matches by prefix in insertion order, and
    // '/api/cast/targets' starts with '/api/cast'.
    '/api/cast/targets': { targets: [ROKU_TARGET], needsChannel: [], mediaChannel: 'Media Assistant' },
    '/api/cast': { enabled: false, baseUrl: 'http://127.0.0.1:8123', tokenSet: false, hidden: [], problem: null }
  })

  assert.match(text(), /Living Room/, 'the television is on the page with no Home Assistant anywhere')
  assert.match(text(), /Ready/)
  // THE ROUTE IS NOT REPEATED ON EVERY ROW. Being found on the network is the default
  // and saying so on each television was noise; only the exception is marked, and the
  // routes have a section of their own below (Tim, 2026-08-19).
  assert.doesNotMatch(text(), /Ready · found on your network/)
  assert.match(text(), /1 television found/)

  // THE SAME ROWS EVERY SETTINGS PAGE USES, and the name carries the state the way
  // the video engine's does on This host (Tim, 2026-08-19: give the rest of the pages
  // the treatment This host got).
  // Found by name rather than by position: the routes are the settings on this page
  // and the televisions are what they produced, so the routes come first (Tim,
  // 2026-08-19) and the first row on the page is no longer a television.
  const name = [...doc.querySelectorAll('.setrow .rowname')].find(n => /Living Room/.test(n.textContent))
  assert.ok(name, 'the television is a row')
  assert.ok(name.className.includes('good'), 'ready reads as ready')
  assert.equal(doc.querySelector('.tvrow'), null, 'no bespoke row shape left on this page')
  assert.doesNotMatch(text(), /Casting is off/, 'and it never says casting is off while a television is listed')
})

test('a television that is switched off says so, rather than disappearing', async (t) => {
  const { text, doc } = await openCasting(t, {
    '/api/cast/targets': {
      targets: [{ ...ROKU_TARGET, state: 'unavailable' }],
      needsChannel: [],
      mediaChannel: 'Media Assistant'
    }
  })

  assert.match(text(), /Living Room/, 'still listed')
  assert.match(text(), /Switched off or asleep/)
  // Amber rather than green, and the words say it too.
  const tv = [...doc.querySelectorAll('.setrow .rowname')].find(n => /Living Room/.test(n.textContent))
  assert.ok(tv.className.includes('warn'))
  assert.match(text(), /comes back by itself/, 'and it says what to do about it, which is nothing')
})

test('a Roku missing the channel is NAMED on the page, not left in a log', async (t) => {
  // The one case a person cannot possibly work out: a Roku sitting right there, missing
  // from the list, because of one free channel.
  const { text } = await openCasting(t, {
    '/api/cast/targets': {
      targets: [],
      needsChannel: [{ host: '10.0.0.9', name: 'Bedroom Roku' }],
      mediaChannel: 'Media Assistant'
    }
  })

  assert.match(text(), /Bedroom Roku/)
  assert.match(text(), /no Media Assistant/)
  assert.match(text(), /channel store/, 'and where to get it')
})

test('Home Assistant is folded away when it is not set up', async (t) => {
  const { doc, text } = await openCasting(t, {
    // The specific route first: the stub matches by prefix in insertion order, and
    // '/api/cast/targets' starts with '/api/cast'.
    '/api/cast/targets': { targets: [ROKU_TARGET], needsChannel: [], mediaChannel: 'Media Assistant' },
    '/api/cast': { enabled: false, baseUrl: 'http://127.0.0.1:8123', tokenSet: false, hidden: [], problem: null }
  })

  assert.match(text(), /Not set up\. Only needed for a television your server cannot find on its own/, 'honest, and only where it applies')
  // FOLDED, NOT ABSENT (2026-08-20). The panel stays in the page so it can animate
  // both ways, and the CSS takes it out of the tab order and off the accessibility
  // tree while it is shut - so what is asserted is that the fold is SHUT.
  const fold = [...doc.querySelectorAll('.rowfold')].find(f => f.querySelector('input[type=password]'))
  assert.ok(fold, 'the token form is behind a fold')
  assert.equal(fold.classList.contains('on'), false, 'which starts shut')
  assert.equal(fold.getAttribute('aria-hidden'), 'true')

  const setUp = [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Set up')
  assert.ok(setUp, 'there is a way in')
  setUp.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.ok(fold.classList.contains('on'), 'and it opens')
})

// --- This host: the first page rebuilt in the Settings row shape --------------
//
// Two nav items and three cards became one page and five rows (Tim, 2026-08-19: the
// Settings pages are busy and not aesthetically pleasing). What is pinned here is the
// consolidation - because a page that moves and takes its links with it is worse than
// a page that was ugly - and the rule that a rare action keeps its words.

async function openHost (t, state = STATE, section = 'host', asked = null) {
  const opened = await open(state, {}, asked)
  t.after(() => opened.dom.window.close())
  const { doc, win } = opened

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // Through the HASH, because that is how a bookmark or an in-app link arrives, and
  // the moved section is only interesting when it arrives that way.
  win.location.hash = 'settings/' + section
  win.dispatchEvent(new win.Event('hashchange'))
  await new Promise(r => setTimeout(r, 80))
  return opened
}

test('SECURITY MOVED INTO THIS HOST, and the old link still lands there', async (t) => {
  // Security was one password field with a nav item of its own. It is whose password
  // it is, so it lives here now - but a bookmark or an in-app link to the old address
  // must not fall silently back to Source, which is what an unknown section did.
  const { doc, text } = await openHost(t, STATE, 'security')

  assert.match(text(), /This host/)
  assert.match(text(), /Password/)
  assert.match(text(), /Video engine/, 'and the engine came along, because it is this machine\'s hardware')

  // The nav is one item shorter, and Security is not in it.
  const nav = doc.querySelector('.setnav')
  const labels = [...nav.querySelectorAll('button')].map(b => b.textContent.trim())
  assert.equal(labels.includes('Security'), false)
  assert.ok(labels.includes('This host'))
})

test('one setting per row, and the explanation is a sub-line rather than a paragraph', async (t) => {
  const { doc, text } = await openHost(t)

  // The first text node, so a row carrying a status chip is still named by its name.
  const rows = [...doc.querySelectorAll('.setrow .rowname')].map(n => n.childNodes[0].textContent.trim())
  assert.deepEqual(rows, ['Password', 'This browser', 'Other browsers', 'Video engine', 'First-time setup'])

  // THE LIBRARY'S ADDRESS IS NOT A SETTING, and it was never a control either: every
  // other use of the host key is one library reaching another, in code, and pairing
  // never asks a person for it. It sat on screen for nobody (Tim, 2026-08-19).
  assert.doesNotMatch(text(), /hostkey/)
})

test('ONE BUTTON PER ROW, because every control on the page is flush right', async (t) => {
  // Width asymmetry is invisible on a ragged left edge and glaring on a flush right
  // one. Signing this browser out and signing the others out shared a row, and their
  // two very different widths were the loudest thing on the page (Tim, 2026-08-19).
  const { doc } = await openHost(t)

  for (const row of doc.querySelectorAll('.setrow')) {
    const buttons = row.querySelectorAll('.rowctl button:not(.iconbtn)')
    assert.ok(buttons.length <= 1, 'at most one worded button in a row')
  }

  // Both say the same word at the same width; the row's own name says which browsers.
  const words = [...doc.querySelectorAll('.setrow .rowname')].map(n => n.textContent.trim())
  assert.ok(words.includes('This browser') && words.includes('Other browsers'))
  const outs = [...doc.querySelectorAll('.setrow .rowctl button')].filter(b => b.textContent.trim() === 'Sign out')
  assert.equal(outs.length, 2)

  // A rare or irreversible action still keeps its words rather than becoming a
  // pictogram somebody has to interpret correctly the first time.
  const all = [...doc.querySelectorAll('.setrow .rowctl button')].map(b => b.textContent.trim())
  assert.ok(all.includes('Run again'))
})

test('THE ENGINE NUMBER SAVES ITSELF, with no button to hunt for', async (t) => {
  // It had a Save, and that button was the only filled amber control on the page, in
  // the only row with two controls, beside the only input - four reasons for one row to
  // shout, stacked (Tim, 2026-08-19, with a screenshot). The casting hide switch already
  // saves on the spot for the same reason.
  const state = {
    ...STATE,
    transcode: { available: true, reason: null },
    transcodeCap: { cap: 4, source: 'default', measured: 10 }
  }
  const asked = []
  const { doc, win, text } = await openHost(t, state, 'host', asked)

  const num = doc.querySelector('.setrow input[type=number]')
  assert.equal(num.value, '4')
  assert.equal(doc.querySelectorAll('.setrow .rowctl button').length, 4, 'Change, Sign out, Sign out, Run again - and no Save')
  assert.equal([...doc.querySelectorAll('.setrow .rowctl button')].some(b => /Save/.test(b.textContent)), false)
  assert.doesNotMatch(text(), /leave the box/, 'and it needs no line explaining itself')

  // CHANGING IT IS THE SAVE. No blur, no Enter, no button - the request goes on its
  // own shortly after the typing stops.
  num.value = '6'
  num.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(asked.some(u => String(u).includes('/api/transcode-cap')), false, 'but not on the keystroke itself')
  await new Promise(r => setTimeout(r, 900))
  assert.ok(asked.some(u => String(u).includes('/api/transcode-cap')), 'once the typing settles')
})

test('typing 16 never sets the cap to 1 on the way', async (t) => {
  // Saving per keystroke would put a cap of 1 in force for as long as it stood, and a
  // cap of 1 refuses conversions. Each change cancels the last timer.
  const state = {
    ...STATE,
    transcode: { available: true, reason: null },
    transcodeCap: { cap: 4, source: 'default', measured: 10 }
  }
  const asked = []
  const { doc, win } = await openHost(t, state, 'host', asked)
  const num = doc.querySelector('.setrow input[type=number]')

  for (const v of ['1', '16']) {
    num.value = v
    num.dispatchEvent(new win.Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 120))
  }
  await new Promise(r => setTimeout(r, 900))

  const sent = asked.filter(u => String(u).includes('/api/transcode-cap'))
  assert.equal(sent.length, 1, 'one request, for the number that was settled on')
})

test('an unusable number puts the real one back rather than sending a guess', async (t) => {
  const state = {
    ...STATE,
    transcode: { available: true, reason: null },
    transcodeCap: { cap: 4, source: 'default', measured: 10 }
  }
  const asked = []
  const { doc, win } = await openHost(t, state, 'host', asked)
  const num = doc.querySelector('.setrow input[type=number]')

  num.value = ''
  num.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))
  num.dispatchEvent(new win.Event('blur', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(num.value, '4', 'the box comes back rather than emptying the setting')
  assert.equal(asked.some(u => String(u).includes('/api/transcode-cap')), false, 'and nothing was sent')

  // Out of range is clamped to what the host will accept rather than bounced back as
  // an error the person has to read.
  num.value = '99'
  num.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))
  num.dispatchEvent(new win.Event('blur', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(num.value, '16')
})

test('A ROW\'S NAME AND ITS SUB-LINE ARE TWO LINES', async (t) => {
  // They are spans inside a flex child. Without a block display they run together and
  // the sub-line reads as part of the name - "PasswordOther browsers will need the new
  // one." Every text assertion in this file passed while it was wrong, because the
  // words were all present and in the right order; it took a screenshot to see.
  const { dom, doc } = await openHost(t)

  for (const row of doc.querySelectorAll('.setrow')) {
    const sub = row.querySelector('.rowsub')
    if (!sub) continue
    assert.equal(dom.window.getComputedStyle(sub).display, 'block', 'the sub-line takes its own line')
    assert.equal(dom.window.getComputedStyle(row.querySelector('.rowname')).display, 'block')
  }
})

test('a password this host does not own cannot be changed from here', async (t) => {
  // One set by the platform would be quietly put back on the next restart, so offering
  // to change it would be offering something that does not work.
  const platform = { ...STATE, auth: { enabled: true, passwordSource: 'explicit' } }
  const { doc, text } = await openHost(t, platform)

  assert.match(text(), /Set by the platform that installed this/)
  const change = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => b.textContent.trim() === 'Change')
  assert.equal(change, undefined, 'and there is no button offering to')
})

test('THE PAGE IS SAID ONCE AND LOUDLY, and no page of rows carries a chip', async (t) => {
  // The type scale was the disease, not the borders: nine sizes lived between .74 and
  // 1.05rem, so a heading, a setting's name and a line explaining it all read at the
  // same importance, and a box around each one was the compensation. Four steps with
  // real gaps replace them, and the boxes come off.
  const state = {
    ...STATE,
    transcode: { available: true, reason: null },
    transcodeCap: { cap: 4, source: 'default', measured: 10 }
  }
  const { doc, text } = await openHost(t, state)

  const title = doc.querySelector('.setbody .setpage')
  assert.ok(title, 'the page names itself once, at the top')
  assert.match(title.querySelector('.setpagename').textContent, /This host/)

  // NO CHIPS ANYWHERE. The page's name carried one first, where it was a fact with
  // nothing to attach to; then the row did, where it was one more object on a page
  // whose problem was objects. The row's own name carries the state now.
  assert.equal(doc.querySelector('.setbody .chip'), null)

  // AND IT CLAIMS NOTHING ABOUT HARDWARE NOBODY MEASURED. The old line said "this
  // hardware managed about 10 in testing" on every install, where the 10 is a constant
  // from the machine this was built against.
  assert.doesNotMatch(text(), /in testing/)

  // NO GROUP LABELS ON A FIVE-ROW PAGE. Structure where there is structure: the
  // merged Library page has two genuine subjects and gets them, this one does not and
  // dividing it twice was decoration (Tim, 2026-08-19).
  assert.equal(doc.querySelector('.setbody .setgroup'), null)

  // And the box is gone: the settings are on the page, not inside a panel on it.
  assert.equal(doc.querySelector('.setbody .card'), null, 'no card around a page of rows')
})

test('a host that cannot convert says so in its own name, and in words', async (t) => {
  const state = { ...STATE, transcode: { available: false, reason: 'no /dev/dri on this machine' } }
  const { doc, text } = await openHost(t, state)

  const name = [...doc.querySelectorAll('.setrow .rowname')].find(n => /Video engine/.test(n.textContent))
  assert.ok(name.className.includes('dim'))
  assert.equal(name.className.includes('good'), false, 'and it does not claim to be fine')
  // The reason is still there, as the whole of that row's sub-line rather than a
  // sentence wrapped around it.
  assert.match(text(), /no \/dev\/dri on this machine/)
})

test('THE ENGINE READS THE CAP TOO, not only the hardware', async (t) => {
  // Whether anything is actually converted is the hardware AND the operator's cap.
  // Reading only the hardware, a host with a working engine and the cap set to zero
  // said "ready" while nothing would ever be converted - with the zero sitting in the
  // field beside it saying otherwise (found answering Tim's question, 2026-08-19).
  const off = {
    ...STATE,
    transcode: { available: true, reason: null },
    transcodeCap: { cap: 0, source: 'dashboard', measured: 10 }
  }
  const { doc, text } = await openHost(t, off)
  const name = [...doc.querySelectorAll('.setrow .rowname')].find(n => /Video engine/.test(n.textContent))
  assert.ok(name.className.includes('warn'), 'and it is not green')
  assert.match(text(), /Nothing is converted while this is 0/)
})

test('an engine nobody has asked yet says checking, not broken', async (t) => {
  // The probe runs at startup without being awaited, so a dashboard opened in the
  // first second used to report hardware that had not been tried as hardware that
  // failed.
  const early = { ...STATE, transcode: { available: false, probing: true, reason: 'the hardware has not been probed yet' } }
  const { doc, text } = await openHost(t, early)
  const name = [...doc.querySelectorAll('.setrow .rowname')].find(n => /Video engine/.test(n.textContent))
  assert.ok(name.className.includes('dim'))
  // COLOUR IS NEVER THE ONLY CARRIER: the words say which of the two dim states it is.
  assert.match(text(), /Asking the hardware what it can do/)
})

test('the engine line says what the number MEANS, and claims nothing more', async (t) => {
  // Tim asked the line to carry more than "0 turns it off". What is honestly available
  // is the cap - which is exactly how many conversions may run at the same time - and
  // the device doing them. What is NOT available is how many this machine could manage:
  // nothing has ever measured that, and the line that used to claim it was quoting the
  // hardware this was built on. That number arrives when a host can measure its own
  // engine, and it arrives as the field's ceiling rather than as another sentence.
  const oneCard = {
    ...STATE,
    transcode: { available: true, reason: null, device: '/dev/dri/renderD128', nodes: ['/dev/dri/renderD128'] },
    transcodeCap: { cap: 3, source: 'dashboard', measured: 10 }
  }
  const one = await openHost(t, oneCard)
  assert.match(one.text(), /Up to 3 conversions run at once\. Setting it to 0 turns conversions off\./)
  assert.doesNotMatch(one.text(), /in testing/, 'never a measurement of somebody else\'s hardware')

  // AND THE CARD IS NAMED ONLY WHERE THERE IS A CHOICE. A render node is the graphics
  // card, not a folder - it holds nothing and nothing is written to it - but the raw
  // path reads like a location, and on a one-card machine it changes nothing.
  assert.doesNotMatch(one.text(), /renderD128/, 'one card, nothing to decide, nothing said')

  const twoCards = {
    ...oneCard,
    transcode: { ...oneCard.transcode, nodes: ['/dev/dri/renderD128', '/dev/dri/renderD129'] }
  }
  const two = await openHost(t, twoCards)
  assert.match(two.text(), /Up to 3 conversions run at once, on \/dev\/dri\/renderD128/)
})

// --- five pages, down from eight ---------------------------------------------

test('EIGHT SETTINGS PAGES BECAME SIX, and every old address still lands', async (t) => {
  // Source, Artwork and Library were three nav items for one subject, and two of them
  // held a single control each. Security was a password field with a page of its own.
  // A section that MOVES must not turn every link and bookmark into a silent fall back
  // to the first page - and the topbar's own download indicator points at the old
  // remotes address, so this is load-bearing inside the app too.
  const { doc, win, dom } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const labels = [...doc.querySelectorAll('.setnav button')].map(b => b.textContent.trim())
  // People joined them on 2026-08-20, beside Sharing: the two pages about other
  // people sit together.
  assert.deepEqual(labels, ['Library', 'Sharing', 'People', 'Casting', 'This host', 'Support development'])

  const lands = async (hash, expect) => {
    win.location.hash = 'settings/' + hash
    win.dispatchEvent(new win.Event('hashchange'))
    await new Promise(r => setTimeout(r, 60))
    const on = doc.querySelector('.setnav button.on')
    assert.equal(on.textContent.trim(), expect, `${hash} lands on ${expect}`)
  }

  await lands('source', 'Library')
  await lands('artwork', 'Library')
  await lands('casting', 'Casting')
  // Both directions: the page was Casting, then Televisions for a day, then Casting
  // again (Tim, 2026-08-19), and a bookmark from that day still has to land.
  await lands('televisions', 'Casting')
  await lands('remotes', 'Sharing')
  // '#who' was a TAB of its own until People became a page, so the old address has
  // to land rather than falling back to the library.
  await lands('who', 'People')
  await lands('security', 'This host')
  // AN ADDRESS THAT NEVER EXISTED LEAVES YOU WHERE YOU ARE. A stray hash should not
  // yank somebody off the page they are reading; only a real section moves them, and
  // only a fresh load with no usable hash starts at the first page.
  await lands('nonsense', 'This host')
})

test('a merged page names itself once and labels what it holds', async (t) => {
  const { doc, win, dom, text } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  assert.equal(doc.querySelector('.setbody .setpage .setpagename').textContent.trim(), 'Library')

  // ONE GROUP, because there is one genuinely separate subject on this page. The
  // source used to carry a heading of its own; it is a row now, and a heading over a
  // single row is a heading over nothing.
  const groups = [...doc.querySelectorAll('.setbody .setgroup')].map(g => g.textContent.trim())
  assert.deepEqual(groups, ['Artwork'])

  // EVERYTHING IS A ROW. The name, where the films are, the two halves of keeping it
  // fresh, and then artwork - rather than one row and two panels of loose controls.
  const rows = [...doc.querySelectorAll('.setrow .rowname')].map(n => n.textContent.trim())
  assert.deepEqual(rows, [
    'Name', 'Where the films are', 'Rescan', 'Automatic rescan',
    'Posters', 'TMDB key', 'Titles with no artwork'
  ])

  // The row says what it is and what was found in it, so the counts are not something
  // you open a picker to read.
  const src = [...doc.querySelectorAll('.setrow .rowname')].find(n => n.textContent.trim() === 'Where the films are')
  assert.ok(src.className.includes('good'))
  assert.match(src.parentElement.textContent, /3 folders on this machine · 2 films, 1 show, 1 episode/)

  // ONE WORDED BUTTON PER ROW, so the right-hand column is one width.
  for (const row of doc.querySelectorAll('.setrow')) {
    assert.ok(row.querySelectorAll('.rowctl button:not(.iconbtn)').length <= 1)
  }

  // RESCANNING SURVIVED THE MOVE, and this is the assertion that matters most on this
  // page: it came out of the source panel, and the last time these controls changed
  // hands the settings page lost them entirely. They are visible without opening
  // anything now.
  const buttons = [...doc.querySelectorAll('.setrow .rowctl button')].map(b => b.textContent.trim())
  assert.ok(buttons.includes('Rescan'))
  assert.ok(doc.querySelector('.setrow .rowctl select'), 'the schedule is a chooser that commits itself')
  assert.doesNotMatch(text(), /Auto-rescan/, 'it is a row with a name now, not a label beside a box')
})

test('A SCAN IN PROGRESS IS SAID IN THE LINE AND ON THE BAR, not in the button', async (t) => {
  // Tim pressed Rescan on the real library and watched a button read "Rescanning…" for
  // several minutes with nothing else on the page saying anything (2026-08-19). A word
  // that changes inside a button also makes that button wider than every other one,
  // which is the ragged right edge the whole page shape exists to stop.
  const { doc, win, dom, text } = await open({ ...STATE, scanning: { done: 412, total: 2986, startedAt: 1 } })
  t.after(() => dom.window.close())

  // On the bar, from anywhere in the app - not only on the page that started it.
  const light = [...doc.querySelectorAll('.barright button')].find(b => /Reading the library/.test(b.getAttribute('aria-label') || ''))
  assert.ok(light, 'the top bar says something is happening')

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const row = [...doc.querySelectorAll('.setrow .rowname')].find(n => n.textContent.trim() === 'Rescan')
  assert.ok(row.className.includes('warn'))
  assert.match(row.parentElement.textContent, /Reading the library, 412 of 2,?986\./)
  assert.ok(row.parentElement.querySelector('.meter'), 'and how far through')

  const btn = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => /Rescan/.test(b.textContent))
  assert.equal(btn.textContent.trim(), 'Rescan', 'the button is a button, not a status line')
  assert.equal(btn.disabled, true)
  assert.doesNotMatch(text(), /Rescanning…/)
})

test('the source editor is behind one button, and the news is not', async (t) => {
  const { doc, win, dom, text } = await open({ ...STATE, sourceError: 'the drive is not mounted' })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // Closed, the picker is not on the page at all.
  assert.equal(doc.querySelector('.rootlist'), null)
  assert.doesNotMatch(text(), /Add a folder/)

  // But a source that has stopped answering says so without being asked, in the banner
  // AND on the row, because a page whose editor is closed must still be able to tell
  // you that the thing behind it is broken.
  assert.match(text(), /The source is not answering/)
  const src = [...doc.querySelectorAll('.setrow .rowname')].find(n => n.textContent.trim() === 'Where the films are')
  assert.ok(src.className.includes('warn'))
  assert.match(src.parentElement.textContent, /not answering/)

  // And it opens.
  await openSourceEditor(doc, win)
  assert.ok(doc.querySelector('.rootlist'), 'the picker is one press in')
})

test('BROWSING FOR A FOLDER IS A STEP IN THE WINDOW, not a window on a window', async (t) => {
  const { doc, win, dom } = await open()
  t.after(() => dom.window.close())

  await openSourceEditor(doc, win)
  assert.equal(doc.querySelectorAll('.overlay').length, 1, 'the editor is one window')
  assert.equal(doc.querySelector('.modal-head h3').textContent.trim(), 'Where the films are')

  const add = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Add a folder'))
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // ONE WINDOW STILL. The picker used to be a second overlay on top of the first,
  // which is the thing to avoid (Tim, 2026-08-19).
  assert.equal(doc.querySelectorAll('.overlay').length, 1)
  assert.equal(doc.querySelector('.modal-head h3').textContent.trim(), 'Pick a folder')
  assert.equal(doc.querySelector('.rootlist'), null, 'the source is not underneath it, it is behind it')

  // And its way out is the step behind it rather than out of everything.
  const back = doc.querySelector('.modal-head button')
  assert.equal(back.getAttribute('aria-label'), 'Back')
  back.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.equal(doc.querySelector('.modal-head h3').textContent.trim(), 'Where the films are')
  assert.ok(doc.querySelector('.rootlist'))
})

test('WHAT WAS DETECTED IS NAMED BY WHAT IT IS, and never offers back what you already use', async (t) => {
  const { doc, win, dom, text } = await open(STATE, {
    '/api/source/detect': {
      // The first is what this library already reads. The second is not.
      folders: [
        { at: '/library', label: 'Movies and TV Shows', roots: [{ path: '/library/Movies', type: 'movies' }, { path: '/library/TV Shows', type: 'shows' }] },
        { at: '/media/usb', label: 'Films', roots: [{ path: '/media/usb/Films', type: 'movies' }] }
      ],
      servers: [
        { kind: 'jellyfin', server: 'Jellyfin', name: 'umbrel', url: 'http://localhost:8096', usable: true },
        { kind: 'plex', server: 'Plex', name: 'Plex Media Server', url: 'http://localhost:32400', usable: false, reason: 'Cannot be read yet. Point PearCinema at the folders your films are in instead.' }
      ]
    }
  })
  t.after(() => dom.window.close())

  await openSourceEditor(doc, win)

  const names = [...doc.querySelectorAll('.overlay .setrow .rowname')].map(n => n.textContent.trim())
  // Named by KIND. It used to be "Movies and TV Shows" and "umbrel" - the names of the
  // things - leaving the one question the row answers to be read off an icon.
  assert.deepEqual(names, ['Folders', 'Jellyfin', 'Plex'])
  // And the two folders this library is already reading are not offered back to it -
  // asserted on the detected rows themselves, since those paths are of course still in
  // the editor below, which is where they belong.
  const detected = doc.querySelector('.overlay .setrows').textContent
  assert.doesNotMatch(detected, /\/library\/TV Shows/)
  assert.match(detected, /Films · \/media\/usb\/Films/, 'what it holds first, then where')
  assert.match(detected, /umbrel · http:\/\/localhost:8096/)

  // ONE WORD, THE SAME WORD, and nothing to press on the one that cannot be read.
  const buttons = [...doc.querySelectorAll('.overlay .setrow .rowctl button')].map(b => b.textContent.trim())
  assert.deepEqual(buttons, ['Use', 'Use'])
  assert.match(text(), /Cannot be read yet/)
})

test('the titles that found nothing are shown, and fixed in the same window', async (t) => {
  const { doc, win, dom, text } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // A COUNT YOU CANNOT ACT ON IS A COUNT (Tim, 2026-08-19).
  const show = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => b.textContent.trim() === 'Show them')
  assert.ok(show, 'the row opens the list')
  show.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  assert.equal(doc.querySelector('.modal-head h3').textContent.trim(), 'Titles with no artwork')
  assert.match(text(), /K05/, 'the title itself, not just how many')

  const find = [...doc.querySelectorAll('.overlay .setrow .rowctl button')].find(b => b.textContent.trim() === 'Find it')
  find.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 80))

  // The same choices the pencil on a tile gives, as a step INSIDE this window.
  assert.equal(doc.querySelectorAll('.overlay').length, 1)
  assert.equal(doc.querySelector('.modal-head h3').textContent.trim(), 'K05')
  assert.ok(doc.querySelector('.candgrid .cand'), 'candidates to pick from')
})

test('an empty list of missing titles says two words, in the middle', async (t) => {
  const { doc, win, dom, text } = await open(STATE, { '/api/metadata/missing': { items: [] } })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const show = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => b.textContent.trim() === 'Show them')
  show.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // "That is all of them done" was awkward (Tim, 2026-08-19), and prose in a window is
  // centred like everything else in one.
  const line = doc.querySelector('.overlay p.hint')
  assert.equal(line.textContent.trim(), 'All done.')
  assert.ok(line.className.includes('center'))
  void text
})

test('artwork with no key says so, refuses to be turned on, and hides its form', async (t) => {
  // WHAT A KEY IS AND WHERE TO GET ONE moved out of the standing paragraph and into
  // the form that opens from the key row - said where it applies, not above a switch
  // somebody has already set up.
  const { doc, win, dom, text } = await open(STATE, {
    '/api/metadata': { enabled: false, hasKey: false, running: null, lastRun: null, matched: 0, uncertain: 0, missed: 0 }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const posters = [...doc.querySelectorAll('.setrow .rowname')].find(n => n.textContent.trim() === 'Posters')
  assert.ok(posters.className.includes('dim'), 'off, and the name says so')
  // COLOUR IS NEVER THE ONLY CARRIER, and the reason it cannot be turned on yet is in
  // the words rather than only in a greyed-out button.
  assert.match(posters.parentElement.textContent, /Off\. It needs a free TMDB key first\./)

  const on = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => b.textContent.trim() === 'Turn on')
  assert.equal(on.disabled, true)

  // FOLDED, NOT ABSENT (2026-08-20). It stays in the page so it can animate both
  // ways, and the CSS takes it out of the tab order and off the accessibility tree
  // while it is shut - so a key field cannot be tabbed into behind a closed fold.
  const fold = [...doc.querySelectorAll('.rowfold')].find(f => /themoviedb\.org/.test(f.textContent))
  assert.ok(fold, 'the key form is behind a fold')
  assert.equal(fold.classList.contains('on'), false, 'shut until it is asked for')
  assert.equal(fold.getAttribute('aria-hidden'), 'true')

  const add = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => b.textContent.trim() === 'Add')
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.ok(fold.classList.contains('on'))
  assert.ok(fold.querySelector('input[type=password]'))
})

test('a library with no source says so and offers to be pointed at one', async (t) => {
  // The setup story belongs in the empty state. The editor used to open itself here,
  // back when it opened inside the page; it is a window now, and a window that throws
  // itself over the page the moment you arrive is one you close before reading
  // anything (Tim, 2026-08-19, choosing the window).
  const { doc, win, dom, text } = await open({
    ...STATE,
    source: { kind: 'empty', roots: [], url: null, username: null },
    stats: { movies: 0, series: 0, seasons: 0, episodes: 0 }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const src = [...doc.querySelectorAll('.setrow .rowname')].find(n => n.textContent.trim() === 'Where the films are')
  assert.ok(src.className.includes('warn'))
  assert.match(src.parentElement.textContent, /Nothing set yet/)
  assert.equal(doc.querySelector('.overlay'), null, 'nothing has thrown itself over the page')
  const setup = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => b.textContent.trim() === 'Set up')
  assert.ok(setup, 'and it says Set up rather than Change, because there is nothing to change')
  setup.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.ok(doc.querySelector('.overlay .rootlist'), 'which opens the window')

  // And nothing offers to rescan a library that does not exist.
  const rows = [...doc.querySelectorAll('.setrow .rowname')].map(n => n.textContent.trim())
  assert.equal(rows.includes('Rescan'), false)
  assert.equal(rows.includes('Automatic rescan'), false)
  void text
})

test('THE ROUTES ARE ROWS, not a footer of mismatched buttons', async (t) => {
  // The footer had Look again on the left and Set up on the right, two buttons of
  // different widths on one line - the asymmetry Tim caught on This host, grown back
  // here. They are rows now, under a label, because a route sitting unlabelled among
  // televisions would read as one.
  const { doc, text } = await openCasting(t, {
    '/api/cast/targets': { targets: [ROKU_TARGET], needsChannel: [], mediaChannel: 'Media Assistant' },
    '/api/cast': { enabled: false, baseUrl: 'http://127.0.0.1:8123', tokenSet: false, hidden: [], problem: null }
  })

  // HOW THEY ARE FOUND COMES FIRST, and the televisions below it under a label of
  // their own - unlabelled there, they would read as part of the routes (Tim,
  // 2026-08-19).
  const groups = [...doc.querySelectorAll('.setbody .setgroup')].map(g => g.textContent.trim())
  assert.deepEqual(groups, ['How they are found', 'Where you can cast'])

  const names = [...doc.querySelectorAll('.setrow .rowname')].map(n => n.textContent.trim())
  assert.deepEqual(names, ['On your network', 'Home Assistant', 'Living Room'])

  // One worded button per row, so the right-hand column is one width.
  for (const row of doc.querySelectorAll('.setrow')) {
    assert.ok(row.querySelectorAll('.rowctl button:not(.iconbtn)').length <= 1)
  }
  assert.equal(doc.querySelector('.tvfoot'), null, 'the footer is gone, not restyled')
  void text
})

test('being hidden is not said twice', async (t) => {
  // The eye beside the row is already saying it (Tim, 2026-08-19).
  const { text } = await openCasting(t, {
    '/api/cast/targets': { targets: [{ ...ROKU_TARGET, hidden: true }], needsChannel: [], mediaChannel: 'Media Assistant' }
  })
  assert.doesNotMatch(text(), /hidden from phones/)
})

test('an empty list still offers both ways to fix itself', async (t) => {
  // The routes used to be a footer that rendered regardless; keeping that property
  // matters more now they are rows, because a page with no televisions is exactly when
  // somebody needs Look again and Set up.
  const { doc, text } = await openCasting(t, {
    '/api/cast/targets': { targets: [], needsChannel: [], mediaChannel: 'Media Assistant' }
  })

  const buttons = [...doc.querySelectorAll('.setrow .rowctl button')].map(b => b.textContent.trim())
  assert.ok(buttons.includes('Look again'))
  assert.ok(buttons.includes('Set up'))
  // And the setup story is two clauses, not the four-line paragraph it was.
  assert.match(text(), /None yet\. Your server finds televisions on its own network, and a Roku also needs the free Media Assistant channel installed on it\./)
})

test('WAITING LOOKS THE SAME AS IT DOES ON THE PHONE', async (t) => {
  // The phone answers a slow question with one spinning circle and a word, centred.
  // The dashboard answered the same question with a left-aligned "Looking…" in muted
  // type, which reads as a label rather than as something in progress (Tim, 2026-08-19,
  // with a screenshot).
  const opened = await open(STATE, { '/api/cast/targets': new Promise(() => {}) })
  t.after(() => opened.dom.window.close())
  const { doc, win } = opened

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent === 'Casting')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 80))

  const wait = doc.querySelector('.setbody .waiting')
  assert.ok(wait, 'a centred wait, not a muted label')
  assert.ok(wait.querySelector('svg.spin'), 'and it is turning')
  assert.match(wait.textContent, /Looking for televisions/)
})

test('a notification is centred all the way through', async (t) => {
  // Title and button were centred and the message between them was not, so a one-line
  // answer sat off to the left under a centred heading (Tim, 2026-08-19, screenshot).
  const { doc, win, dom } = await openCasting(t, {
    '/api/cast/rescan': { targets: [], needsChannel: [], mediaChannel: 'Media Assistant' },
    '/api/cast/targets': { targets: [ROKU_TARGET], needsChannel: [], mediaChannel: 'Media Assistant' }
  })

  const look = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => b.textContent.trim() === 'Look again')
  look.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 120))

  const alert = doc.querySelector(".modal[role='alertdialog']")
  assert.ok(alert, 'the answer arrives as a notification')
  const body = alert.querySelector('p')
  assert.ok(body, 'with a message between the heading and the button')
  assert.equal(dom.window.getComputedStyle(body).textAlign, 'center')
})

test('SHARING IS ROWS TOO, and a library says whether it is answering', async (t) => {
  // The three panels used `.rootpath` for things that are names rather than paths -
  // monospace, one line, ellipsised - which is right for a folder on disk and wrong
  // for "Ben's Cinema". Same fault Televisions had (Tim, 2026-08-19).
  const { dom, doc, win } = await open(STATE, {
    '/api/remote/list': {
      remotes: [
        { hostKey: 'k1', libraryId: 'lib-1', libraryName: "Ben's Cinema", online: true },
        { hostKey: 'k2', libraryId: 'lib-2', libraryName: 'The Loft', online: false }
      ]
    }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent === 'Sharing')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 100))

  const names = [...doc.querySelectorAll('.setrow .rowname')]
  assert.ok(names.length >= 2)
  const ben = names.find(n => /Ben's Cinema/.test(n.textContent))
  const loft = names.find(n => /The Loft/.test(n.textContent))
  assert.ok(ben.className.includes('good'), 'online reads as online')
  assert.ok(loft.className.includes('warn'), 'and offline does not')
  // Colour is never the only carrier.
  assert.match(ben.parentElement.textContent, /Online/)
  assert.match(loft.parentElement.textContent, /Offline/)

  // The four-line paragraph is gone while there is anything to look at.
  assert.doesNotMatch(doc.getElementById('root').textContent, /open a pairing window on their dashboard/)
})

test('the pairing explanation appears only when there is nothing else to read', async (t) => {
  const { dom, doc, win, text } = await open(STATE, { '/api/remote/list': { remotes: [] } })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent === 'Sharing')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 100))

  assert.match(text(), /Ask them to open a pairing window on their dashboard/)
})

test('WHAT PEOPLE ASKED THIS LIBRARY FOR HAS SOMEWHERE TO APPEAR', async (t) => {
  // The dashboard had "Your requests" - what this machine asked somebody else's
  // library for - and nothing at all for the other direction. The store and the wire
  // have both had the owner's view all along; only the dashboard never asked, so Tim
  // made requests from a paired phone and found nowhere they could show up
  // (2026-08-19).
  const { dom, doc, win, text } = await open(STATE, {
    '/api/asked': {
      items: [
        { id: 'r1', name: 'Solaris', kind: 'movie', status: 'pending', count: 2, requester: 'o1', requesterLabel: 'Ben' },
        { id: 'r2', name: 'Chernobyl', kind: 'series', status: 'added', count: 1, requester: 'o1', requesterLabel: 'Ben' }
      ]
    }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent === 'Sharing')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 120))

  assert.match(text(), /Solaris/)
  // WHO ASKED, by the name their owner chose rather than by a key - a request nobody
  // can attribute is one nobody can answer.
  assert.match(text(), /asked by Ben/)
  assert.match(text(), /asked 2 times/)

  // THE NAME COMES OFF THE FIELD THE STORE ACTUALLY USES. Every row read "Untitled"
  // because this looked for `title` and a request carries `name` (Tim, 2026-08-19).
  assert.doesNotMatch(text(), /Untitled/)

  // SENTENCE CASE. The status words came straight off the wire in the store's own
  // lowercase vocabulary and sat mid-sentence in a sub-line.
  assert.match(text(), /Waiting for you · Film/)
  assert.match(text(), /Added · Show/)

  // A TICK AND A CROSS on the one waiting, and a way to clear the one that is done.
  const labels = [...doc.querySelectorAll('.setrow .rowctl button')].map(b => b.getAttribute('aria-label'))
  assert.ok(labels.some(l => /Mark Solaris as added/.test(l)))
  assert.ok(labels.some(l => /Decline the request for Solaris/.test(l)))
  assert.ok(labels.some(l => /Clear the request for Chernobyl/.test(l)), 'an answered ask can be cleared')
  assert.equal(labels.some(l => /Clear the request for Solaris/.test(l)), false, 'but not one still waiting')
})

test('answering a request changes that row and nothing else', async (t) => {
  // It used to refetch the whole list and raise a notification, so answering one row
  // redrew the page and threw a modal over it (Tim, 2026-08-19).
  const { dom, doc, win, text } = await open(STATE, {
    '/api/asked/resolve': { request: { id: 'r1', name: 'Solaris', kind: 'movie', status: 'added', count: 1, requesterLabel: 'Ben' } },
    '/api/asked': {
      items: [{ id: 'r1', name: 'Solaris', kind: 'movie', status: 'pending', count: 1, requester: 'o1', requesterLabel: 'Ben' }]
    }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent === 'Sharing')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 120))

  const tick = [...doc.querySelectorAll('.setrow .rowctl button')].find(b => /as added/.test(b.getAttribute('aria-label') || ''))
  tick.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 120))

  assert.match(text(), /Added · Film/, 'the row it changed says so')
  assert.equal(doc.querySelector(".modal[role='alertdialog']"), null, 'and nothing is thrown over the page')
})

test('SOMEBODY WAITING FOR AN ANSWER IS VISIBLE FROM ANY PAGE', async (t) => {
  // The count is the shell's, not the panel's: the panel only exists on the Sharing
  // page, so a light that waited for it would appear only once you had already gone
  // looking (Tim, 2026-08-19, asking for the same treatment downloads get).
  const { dom, doc } = await open(STATE, {
    '/api/asked': {
      items: [{ id: 'r1', name: 'Solaris', kind: 'movie', status: 'pending', count: 1, requester: 'o1', requesterLabel: 'Ben' }]
    }
  })
  t.after(() => dom.window.close())

  // Still on the library, nowhere near Sharing.
  const light = [...doc.querySelectorAll('.barright button')]
    .find(b => /request/i.test(b.getAttribute('aria-label') || ''))
  assert.ok(light, 'the bar says somebody is waiting')
  assert.match(light.getAttribute('aria-label'), /One request waiting/)
  assert.ok(light.querySelector('.dot'), 'and it is marked the way a running download is')

  // NOT THE PEOPLE MARK, which already means "who can get in" in the same bar. Two
  // lights with the same glyph and different meanings is worse than no light at all
  // (Tim, 2026-08-19).
  const people = [...doc.querySelectorAll('.barright button')]
    .find(b => /people|devices/i.test(b.getAttribute('aria-label') || ''))
  if (people) {
    assert.notEqual(light.querySelector('svg')?.innerHTML, people.querySelector('svg')?.innerHTML)
  }
})

test('nothing waiting means nothing in the bar', async (t) => {
  const { dom, doc } = await open(STATE, { '/api/asked': { items: [] } })
  t.after(() => dom.window.close())
  const light = [...doc.querySelectorAll('.barright button')]
    .find(b => /request/i.test(b.getAttribute('aria-label') || ''))
  assert.equal(light, undefined)
})

test('AN EMPTY GROUP STILL SAYS SOMETHING, rather than a heading over nothing', async (t) => {
  // All three of these hid themselves entirely when empty, and that held while each
  // was a card that would otherwise appear out of nowhere. Under a heading that is
  // already on screen it leaves the heading standing over nothing, which reads as
  // broken (Tim, 2026-08-19) - and the merged Sharing page put the headings there.
  const { dom, doc, win, text } = await open(STATE, {
    '/api/asked': { items: [] },
    '/api/downloads': { items: [] },
    '/api/remote/list': { remotes: [] }
  })
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent === 'Sharing')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 160))

  const groups = [...doc.querySelectorAll('.setbody .setgroup')].map(g => g.textContent.trim())
  assert.deepEqual(groups, ['Downloads', 'Asked of you', 'Your requests'])

  assert.match(text(), /Nothing kept on this machine yet/)
  assert.match(text(), /Nobody has asked you for anything yet/)
  assert.match(text(), /You have not asked for anything yet/)
})

test('NOTHING PAINTS #root A COLOUR, which is how light mode stayed dark', async () => {
  // The boot <style> carried `background:#0e0f13` on `#root` under a comment saying not
  // to do exactly that. An id selector beats every rule in the stylesheet below it, so
  // the header was light and everything under it was on a dark ground with dark text on
  // it (Tim, 2026-08-19: "light mode isn't rendering properly"). No test could have seen
  // it - every assertion in this file is about text and structure - so the guard is on
  // the rule itself.
  // The FIRST style block is the boot one; the app's own stylesheet follows it and is
  // free to paint #root from a token, which is the correct way to do it.
  const boot = PAGE.slice(PAGE.indexOf('<style>') + 7, PAGE.indexOf('</style>'))
  for (const rule of boot.match(/[^{}]*\{[^{}]*\}/g) || []) {
    if (!/#root/.test(rule.split('{')[0])) continue
    assert.doesNotMatch(rule, /background/, 'a background on #root strands the page on one theme: ' + rule)
  }
})

test('THE SUPPORT PAGE COMES UP AT ALL, which it had stopped doing', async (t) => {
  // It used `copied` and `setCopied` and declared neither, so the moment the rails
  // arrived it threw "copied is not defined" and took the whole app down with it -
  // the blank-page shape of the three temporal-dead-zone crashes of 2026-08-17. Every
  // test in this file asserts on text and structure, and this page had no test of its
  // own, so nothing in the suite could see it (found 2026-08-19).
  const { doc, win, dom, errors, text } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent.trim() === 'Support development')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 120))

  assert.deepEqual(errors, [], 'no page error')
  assert.match(text(), /No accounts, no servers, no subscriptions/)
  assert.match(text(), /lnurl1example/, 'the rail itself, not a spinner')
  assert.ok(doc.querySelector('.donate-qr svg'), 'and its code to point a phone at')

  // NO CARD AROUND A PAGE - the last one still wearing one - and the page names itself
  // once, outside it.
  assert.ok(doc.querySelector('.setbody .setpage .setpagename'))
  assert.equal(doc.querySelector('.setbody > .card'), null)

  // Copy is a button that works rather than one that throws.
  const copy = [...doc.querySelectorAll('.actions button')].find(b => b.textContent.trim() === 'Copy')
  assert.ok(copy)
  copy.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.deepEqual(errors, [], 'still no page error after pressing it')

  // An arrow was doing nothing a word was not already doing.
  assert.doesNotMatch(text(), /↗/)
})

/* --------------------------------------------------- playing next -- */

// The next episode's own facts, as the host answers them for the shelf row.
const NEXT_EP = {
  type: 'episode',
  id: 'wire-s01e03',
  seriesTitle: 'The Wire',
  seasonNumber: 1,
  episodeNumber: 3,
  title: 'The Buys',
  runtime: 3600,
  overview: 'A detail is assembled and the wire goes up.',
  artId: null,
  media: { container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', size: 4096 }
}

// Open an episode, force past jsdom's decode-nothing verdict, and hand back the
// <video> element the player built. jsdom answers '' to canPlayType, so every
// file lands on the refusal and Try anyway is how a viewer gets past it.
async function playEpisode (t, routes = { '/api/siblings': { prev: null, next: NEXT_EP } }) {
  const opened = await open(STATE, routes)
  t.after(() => opened.dom.window.close())
  const { doc, win } = opened

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Detail'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const video = doc.querySelector('video')
  assert.ok(video, 'the episode is playing')
  return { ...opened, video }
}

// The clock reaching the end, which is what tells the card this really was the
// end rather than a generated stream stopping.
async function runToEnd (win, video, seconds) {
  Object.defineProperty(video, 'currentTime', { value: seconds, configurable: true })
  video.dispatchEvent(new win.Event('timeupdate'))
  await new Promise(r => setTimeout(r, 20))
  video.dispatchEvent(new win.Event('ended'))
  await new Promise(r => setTimeout(r, 40))
}

test('AN EPISODE THAT ENDS OFFERS THE NEXT ONE, and counts down to it', async (t) => {
  const { doc, win, video, errors } = await playEpisode(t)

  await runToEnd(win, video, 152)

  assert.deepEqual(errors, [], 'no page error')
  const card = doc.querySelector('.stage .nextover')
  assert.ok(card, 'the card is over the last frame')
  // WHAT IT IS, not "Next episode" - somebody has to be able to decide without
  // remembering what follows what.
  assert.match(card.textContent, /Playing next/i)
  assert.match(card.textContent, /The Wire/)
  assert.match(card.textContent, /S01E03/)
  assert.match(card.textContent, /The Buys/)
  assert.match(card.textContent, /A detail is assembled/, 'and what it is about')
  assert.match(card.textContent, /1h/, 'and how long it is')

  // THE COUNT IS VISIBLE THE WHOLE TIME IT RUNS. The one thing on this screen
  // that acts by itself must never do so silently.
  assert.match(card.querySelector('.nextdial').textContent, /^10$/)
  await new Promise(r => setTimeout(r, 2200))
  const now = Number(doc.querySelector('.nextdial').textContent)
  assert.ok(now < 10 && now > 0, 'the countdown is running: ' + now)
})

test('CANCELLING LEAVES THE FINISHED EPISODE ON SCREEN, and nothing starts', async (t) => {
  const { doc, win, video } = await playEpisode(t)
  await runToEnd(win, video, 152)

  const cancel = [...doc.querySelectorAll('.nextover button')].find(b => b.textContent.trim() === 'Cancel')
  cancel.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 1400))

  assert.equal(doc.querySelector('.nextover'), null, 'the card is gone')
  // AND THE PLAYER IS STILL THERE. Cancelling is not closing: the person may
  // want to scrub back, or leave on their own.
  assert.ok(doc.querySelector('video'), 'the episode is still on screen')
  assert.ok(doc.querySelector('.controls'), 'with its controls')
  assert.match(rootText(doc), /The Detail/, 'still the one that just finished')
})

test('turning autoplay off on the card stops the countdown, and it stays off', async (t) => {
  const { doc, win, video } = await playEpisode(t)
  await runToEnd(win, video, 152)

  const box = doc.querySelector('.nextover input[type=checkbox]')
  assert.equal(box.checked, true, 'on by default, the way a television behaves')
  box.checked = false
  box.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 1400))

  const card = doc.querySelector('.nextover')
  assert.ok(card, 'the card stays - the next one is still offered')
  assert.equal(card.querySelector('.dialfill'), null, 'but nothing is counting')
  assert.equal(win.localStorage.getItem('pearcinema.autoplaynext'), 'off', 'and it is remembered')
})

test('A GENERATED STREAM THAT DIES MID-FILM OFFERS NOTHING', async (t) => {
  // The host's ffmpeg stopping is an `ended` to the browser exactly as the end
  // of the film is. Offering the next episode forty minutes in would be worse
  // than saying nothing at all, so the clock has to agree it was the end.
  const { doc, win, video } = await playEpisode(t)

  await runToEnd(win, video, 20)

  assert.equal(doc.querySelector('.nextover'), null)
})

test('THE BROWSER PLAYS THE NEXT EPISODE, it does not just load it and sit there', async (t) => {
  // Tim, 2026-08-20: the phone played the next one and the browser moved to it
  // paused. `wantPlay` is deliberately cleared on every new item - clicking a
  // second film must not start it - and the card is the one case where the
  // person has already said play it.
  const { doc, win, video } = await playEpisode(t)
  const played = []
  win.HTMLMediaElement.prototype.play = function () { played.push(this.src); return Promise.resolve() }

  await runToEnd(win, video, 152)
  const now = [...doc.querySelectorAll('.nextover button')].find(b => /Play/.test(b.getAttribute('aria-label') || ''))
  now.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // jsdom decodes nothing, so the next one lands on the refusal like every other
  // file here. Past it, the element is the real thing.
  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const next = doc.querySelector('video')
  next.dispatchEvent(new win.Event('loadedmetadata'))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(played.length, 1, 'the next episode started on its own')
})

test('and a film opened by hand still does NOT start on its own', async (t) => {
  // The rule the one above is an exception to: opening a page must not fill a
  // room with sound, and on a repackaged film it also spends a process on the
  // host before anybody has said they want it.
  const { dom, doc, win } = await open()
  t.after(() => dom.window.close())
  const played = []
  win.HTMLMediaElement.prototype.play = function () { played.push(this.src); return Promise.resolve() }

  const poster = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Metropolis'))
  poster.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const tryAnyway = [...doc.querySelectorAll('button')].find(b => b.textContent.includes('Try anyway'))
  if (tryAnyway) tryAnyway.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  doc.querySelector('video').dispatchEvent(new win.Event('loadedmetadata'))
  await new Promise(r => setTimeout(r, 40))
  assert.deepEqual(played, [])
})

/* ------------------------------------------ the continue shelf -- */

// Fourteen half-watched films, so the cap has something to cut.
function crowdedShelf () {
  return {
    ...ROUTES['/api/watch/state'],
    continue: Array.from({ length: 14 }, (_, n) => ({
      ...FILM,
      id: 'old-' + n,
      title: 'Half watched ' + n,
      resume: { positionMs: 60_000, playedAt: Date.now() - n * 1000 }
    })),
    upNext: []
  }
}

test('THE SHELF IS CAPPED, and the rest is one press away rather than gone', async (t) => {
  // A year of half-started films used to push the one thing somebody is
  // actually part way through off the end of the row (Tim, 2026-08-19).
  const { dom, doc, win } = await open(STATE, { '/api/watch/state': crowdedShelf() })
  t.after(() => dom.window.close())

  const shelf = () => [...doc.querySelectorAll('.grid')][0].querySelectorAll('.poster')
  assert.equal(shelf().length, 12, 'twelve shown of fourteen')
  // NEWEST FIRST, which is the store's own ordering - the cap cuts the tail.
  assert.match(shelf()[0].textContent, /Half watched 0/)

  const more = [...doc.querySelectorAll('button')].find(b => /Show all 14/.test(b.textContent))
  assert.ok(more, 'and it says how many there are')
  more.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(shelf().length, 14)
  assert.ok([...doc.querySelectorAll('button')].find(b => /Show fewer/.test(b.textContent)))
})

test('a shelf that fits carries no Show all at all', async (t) => {
  const { dom, doc } = await open()
  t.after(() => dom.window.close())
  assert.equal([...doc.querySelectorAll('button')].filter(b => /Show all/.test(b.textContent)).length, 0)
})

test('ONE CARD CAN BE TAKEN OFF THE SHELF WITHOUT CLAIMING TO HAVE WATCHED IT', async (t) => {
  const asked = []
  const { dom, doc, win } = await open(STATE, {}, asked)
  t.after(() => dom.window.close())

  const card = [...doc.querySelectorAll('.grid')][0].querySelectorAll('.poster')[0]
  const forget = card.querySelector('.forget')
  assert.ok(forget, 'the card offers it')
  assert.match(forget.getAttribute('aria-label'), /Remove Metropolis from Continue watching/)
  forget.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // A ZERO POSITION IS THE DELETE, the same write a finished film makes - and
  // pointedly NOT /api/watch/watched, which would put a tick on it everywhere.
  assert.ok(asked.some(u => String(u).includes('/api/watch/position')))
  assert.ok(!asked.some(u => String(u).includes('/api/watch/watched')))
})

test('AN UP-NEXT CARD HAS NOTHING TO FORGET', async (t) => {
  // It is a suggestion, not a place somebody stopped.
  const { dom, doc } = await open()
  t.after(() => dom.window.close())
  const next = [...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Detail'))
  assert.ok(next.querySelector('.next'), 'it is the up-next card')
  assert.equal(next.querySelector('.forget'), null)
})

test('CLEARING THE SHELF ASKS FIRST, and says the places will be forgotten', async (t) => {
  const asked = []
  const { dom, doc, win } = await open(STATE, {}, asked)
  t.after(() => dom.window.close())

  const clear = [...doc.querySelectorAll('.shelfhead button')].find(b => b.textContent.trim() === 'Clear')
  assert.ok(clear, 'the shelf carries its own Clear')
  clear.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const modal = doc.querySelector('.modal')
  assert.ok(modal, 'it asks rather than doing it')
  assert.match(modal.textContent, /will be forgotten/)
  assert.match(modal.textContent, /cannot be undone/)

  // CENTRED AND EQUAL, the app's own rule for buttons in a window (Tim,
  // 2026-08-19, and again on this very dialog on 2026-08-20 - the centring had
  // been written as a class that only the ONE-button case ever asked for, so
  // every two-button window in the app was still ragged and right-aligned).
  // No assertion about text or structure could have seen that, which is why
  // this one is about the computed style.
  const acts = modal.querySelector('.confirm-actions')
  assert.equal(win.getComputedStyle(acts).justifyContent, 'center')
  const widths = [...acts.querySelectorAll('button')].map(b => win.getComputedStyle(b).minWidth)
  assert.equal(widths.length, 2)
  assert.equal(widths[0], widths[1], 'and the same width as each other')
  assert.ok(widths[0] && widths[0] !== 'auto' && widths[0] !== '0px', 'a real width: ' + widths[0])
  assert.ok(!asked.some(u => String(u).includes('/api/watch/clear')), 'and nothing has happened yet')

  const cancel = [...modal.querySelectorAll('button')].find(b => /Cancel/.test(b.textContent))
  cancel.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(doc.querySelector('.modal'), null)
  assert.ok(!asked.some(u => String(u).includes('/api/watch/clear')), 'still nothing')

  clear.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const go = [...doc.querySelectorAll('.modal button')].find(b => /Clear it/.test(b.textContent))
  go.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.ok(asked.some(u => String(u).includes('/api/watch/clear')))
})

test('AN OLD #who BOOKMARK OPENS THE PAGE IT NAMED, not the library', async (t) => {
  // It was a tab, not a settings section, so the section table alone could not
  // catch it: the tab initialiser reads the hash before Settings exists.
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', e => errors.push(e))
  const dom = new JSDOM(PAGE, {
    runScripts: 'dangerously',
    url: 'http://localhost:8751/#who',
    pretendToBeVisual: true,
    virtualConsole: vc
  })
  t.after(() => dom.window.close())
  const win = dom.window
  win.fetch = async (url) => {
    const hit = Object.keys(ROUTES).find(k => String(url).startsWith(k.split('?')[0]) && String(url).includes(k.split('?')[1] || ''))
    return { status: 200, ok: true, json: async () => (hit ? ROUTES[hit] : {}) }
  }
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 15))

  assert.deepEqual(errors, [], 'no page error')
  assert.equal(win.document.querySelector('.setpagename').textContent, 'People')
  assert.equal(win.location.hash, '#settings/people', 'and the address is rewritten to where it went')
})

test('THE PEOPLE PAGE IS ROWS NOW, and the reshape did not cost the security claim', async (t) => {
  // The last screen still wearing a card with nested lists inside it, while every
  // Settings page had moved to rows (Tim, 2026-08-20). What the move was NOT
  // allowed to cost is written into this test: Cut off stays one press from where
  // a device is named, and it still says how many live connections it cut.
  const withPeople = {
    ...STATE,
    persons: [{ id: 'p1', name: 'Tim', label: 'Tim' }],
    devices: [
      { deviceKey: 'dk1', label: 'A phone', platform: 'android', online: true, personId: 'p1', claimedUser: 'Tim', confirmed: true, lastSeenAt: Date.now(), scope: 'owner' },
      { deviceKey: 'dk2', label: 'A laptop', platform: 'linux', online: false, personId: null, claimedUser: null, lastSeenAt: Date.now(), scope: 'full' }
    ]
  }
  const { dom, doc, win, errors, text } = await open(withPeople)
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  assert.deepEqual(errors, [], 'no page error')
  // ROWS, not the old card. `.access` and `.prow` are gone with the shape.
  assert.equal(doc.querySelector('.card.access'), null)
  assert.equal(doc.querySelector('.prow'), null)
  assert.ok(doc.querySelector('.setrows .setrow'), 'and it is Settings rows like every other page')

  // A device belonging to nobody is still its own group rather than mixed in.
  assert.match(text(), /Not assigned to anybody/)
  assert.match(text(), /A laptop/)

  // ICONS, NOT WORDS (Tim, 2026-08-20). Every one of them still says what it does
  // out loud for anything that cannot see a picture, and every label names the thing
  // it acts on - a page of identical pictograms is unusable otherwise.
  const labels = [...doc.querySelectorAll('.setrow .rowctl button')]
    .map(b => b.getAttribute('aria-label')).filter(Boolean)
  assert.ok(labels.includes('Rename Tim'))
  assert.ok(labels.includes('Cut off Tim and every device they hold'))
  assert.ok(labels.includes('Cut off A laptop'))
  assert.ok(labels.includes('Add somebody'))
  assert.ok([...doc.querySelectorAll('.setrow .rowctl button')].every(b => !/^(Rename|Cut off|Delete|Add|Show)$/.test(b.textContent.trim())),
    'and none of them is a bare word button any more')

  // ADDING SOMEBODY IS A FIELD ON THE PAGE, not the browser's own prompt box -
  // which is unstyled, suppressible and looks like the page has been hijacked.
  let prompted = 0
  win.prompt = () => { prompted++; return null }
  const add = [...doc.querySelectorAll('.setrow button')].find(b => b.getAttribute('aria-label') === 'Add somebody')
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.equal(prompted, 0, 'no window.prompt')
  assert.ok(doc.querySelector('.setrow .rowctl input[type=text]'), 'a field on the page instead')
})

test('ADDING SOMEBODY SENDS ONE REQUEST, however the field is left', async (t) => {
  // Tim, 2026-08-20: adding "Asa" made two of them. A field that saves on Enter AND
  // on blur saves twice - removing the focused input fires the blur, and Preact's
  // state update has not landed yet, so the second call still sees the name. It bit
  // the add field rather than the rename one only because renaming to the same name
  // twice is invisible.
  const asked = []
  const { dom, doc, win } = await open(STATE, {}, asked)
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const add = [...doc.querySelectorAll('.setrow button')].find(b => b.getAttribute('aria-label') === 'Add somebody')
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const field = doc.querySelector('.setrow .rowctl input[type=text]')
  field.value = 'Asa'
  field.dispatchEvent(new win.Event('input', { bubbles: true }))
  // A beat, so the typed name is in state before Enter is pressed - which is what
  // typing actually looks like, and without it the Enter handler is still the one
  // from the render before the first keystroke.
  await new Promise(r => setTimeout(r, 40))
  field.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  // What the browser does next: the input goes away, and going away blurs it.
  field.dispatchEvent(new win.Event('blur', { bubbles: true }))
  await new Promise(r => setTimeout(r, 80))

  const adds = asked.filter(u => String(u) === '/api/person')
  assert.equal(adds.length, 1, 'one person asked for, not two')
})

test('A DEVICE THAT RENAMED ITSELF HAS A WAY OUT, and it is not detaching it', async (t) => {
  // Tim, 2026-08-20, on his TCL: it had renamed itself while filed under somebody,
  // so it sat in Needs confirming with nothing on the row that could settle it - the
  // confirm button was hidden the moment a device had a person, and only choosing
  // "Nobody" in Belongs to brought it back.
  const renamed = {
    ...STATE,
    persons: [{ id: 'p1', name: 'Tim Test', label: 'Tim Test' }],
    devices: [{
      deviceKey: 'dk1', label: 'TCL', platform: 'android', online: false,
      personId: 'p1', belongsTo: 'Tim Test', claimedUser: 'Tim TCL2', confirmed: false,
      lastSeenAt: Date.now(), scope: 'full'
    }]
  }
  const asked = []
  const { dom, doc, win, text } = await open(renamed, {}, asked)
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  assert.match(text(), /Needs confirming/)
  const row = [...doc.querySelectorAll('.setrow')].find(r => /TCL/.test(r.textContent))

  // ONE CONTROL ON THE ROW, and the question itself opens in a window - two long
  // word buttons on the line was the shape Tim rejected (2026-08-20).
  const ask = [...row.querySelectorAll('.rowctl button')]
    .find(b => /^Say who/.test(b.getAttribute('aria-label') || ''))
  assert.ok(ask, 'the row asks with one control')
  ask.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const modal = doc.querySelector('.modal')
  assert.ok(modal, 'the question is a window')
  assert.match(modal.textContent, /Who is TCL\?/)
  assert.match(modal.textContent, /calls itself/)
  assert.match(modal.textContent, /Tim TCL2/)
  const keep = [...modal.querySelectorAll('button')].find(b => /Still Tim Test/.test(b.textContent))
  assert.ok(keep, 'it offers to leave it where it is')
  assert.ok([...modal.querySelectorAll('button')].some(b => /It really is Tim TCL2/.test(b.textContent)),
    'and to take the new name at its word')
  // EVERY ANSWER SAYS WHAT IT DOES, which a row had no room for.
  assert.match(keep.textContent, /stays where it is/)

  keep.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.ok(asked.some(u => String(u).includes('/api/device/claim/keep')))
  assert.equal(doc.querySelector('.modal'), null, 'and the window closes behind it')

  // THE PERSON'S OWN ROW COUNTS IT. Counting only settled devices made somebody
  // whose device had renamed itself read "No devices" while it sat above them - and
  // offered Delete, which would have orphaned it.
  const person = [...doc.querySelectorAll('.setrow')].find(r => /Tim Test/.test(r.querySelector('.rowname')?.textContent || ''))
  assert.match(person.textContent, /1 device/)
  assert.match(person.textContent, /1 waiting to be confirmed/)
  assert.ok([...person.querySelectorAll('.rowctl button')].some(b => /^Cut off/.test(b.getAttribute('aria-label') || '')),
    'and they read as somebody who holds something')
})

test('CHOOSING WHO A DEVICE BELONGS TO ASKS FIRST', async (t) => {
  // A chooser that acts the instant it changes gives no way out of a mis-click, and
  // no sign that anything happened either - which is how it read (Tim, 2026-08-20).
  const asked = []
  const { dom, doc, win } = await open({
    ...STATE,
    persons: [{ id: 'p1', name: 'Jo', label: 'Jo' }],
    devices: [{
      deviceKey: 'dk1', label: 'A tablet', platform: 'android', online: false,
      personId: null, claimedUser: 'Jo', confirmed: false, lastSeenAt: Date.now(), scope: 'full'
    }]
  }, {}, asked)
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const row = [...doc.querySelectorAll('.setrow')].find(r => /A tablet/.test(r.textContent))
  const btns = row.querySelectorAll('.rowctl .iconbtn')
  btns[btns.length - 1].dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const fold = row.nextElementSibling
  assert.ok(fold.classList.contains('on'), 'the chevron opened the fold')
  const pick = fold.querySelector('select')
  assert.ok(pick, 'the chooser is behind the chevron')
  pick.value = 'p1'
  pick.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const modal = doc.querySelector('.modal')
  assert.ok(modal, 'it asks rather than moving somebody else s device on a mis-click')
  assert.match(modal.textContent, /under Jo/)
  assert.ok(!asked.some(u => String(u).includes('/api/assign')), 'and nothing has happened yet')

  const go = [...modal.querySelectorAll('button')].find(b => /File it there/.test(b.textContent))
  go.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.ok(asked.some(u => String(u).includes('/api/assign')))
})

test('CONFIRMING A NAME SOMEBODY ALREADY HAS OFFERS TO JOIN THEM, not to mint a second', async (t) => {
  // The row used to pass "make a new person" whenever exactly ONE person already
  // held the claimed name - so pressing it minted a duplicate instead of joining
  // them, which is how a household ends up with two people of one name. The window
  // asks instead, and says what joining costs: their watch history is shared.
  const asked = []
  const bodies = []
  const { dom, doc, win } = await open({
    ...STATE,
    persons: [{ id: 'p1', name: 'Jo', label: 'Jo' }],
    devices: [{
      deviceKey: 'dk1', label: 'A tablet', platform: 'android', online: false,
      personId: null, claimedUser: 'Jo', confirmed: false, lastSeenAt: Date.now(), scope: 'full'
    }]
  }, {}, asked)
  t.after(() => dom.window.close())
  const realFetch = win.fetch
  win.fetch = async (url, opts) => { if (opts?.body) bodies.push(JSON.parse(opts.body)); return realFetch(url, opts) }

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'People and devices')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const ask = [...doc.querySelectorAll('.setrow .rowctl button')]
    .find(b => /^Say who/.test(b.getAttribute('aria-label') || ''))
  ask.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const modal = doc.querySelector('.modal')
  const join = [...modal.querySelectorAll('button')].find(b => /It is Jo/.test(b.textContent))
  assert.ok(join, 'joining the Jo who is already here is offered')
  assert.match(join.textContent, /shares their watch history/)
  assert.ok([...modal.querySelectorAll('button')].some(b => /A different Jo/.test(b.textContent)),
    'and so is a genuinely different Jo')

  join.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  const sent = bodies.find(b => b && 'asNew' in b)
  assert.ok(sent, 'the claim was confirmed')
  assert.equal(sent.asNew, false, 'as a JOIN')
  assert.equal(sent.personId, 'p1', 'of the Jo who is already here')
})

test('THE FOLD ANIMATES A HEIGHT NOBODY KNOWS IN ADVANCE', async () => {
  // `height: auto` is not an animatable value, so the usual bodge is a max-height
  // guess - which either clips a person with four devices or spends the whole
  // transition on empty space. A grid row from 0fr to 1fr animates the real height
  // with nothing measured. This is a guard rather than a behaviour test: no
  // assertion about text or structure could ever see it go back.
  const css = fs.readFileSync(path.join(__dirname, '..', 'host', 'ui', 'dashboard.html'), 'utf8')
  assert.match(css, /\.rowfold\{[^}]*grid-template-rows:0fr/, 'shut is a zero-height row')
  assert.match(css, /\.rowfold\{[^}]*transition:grid-template-rows/, 'and the row itself is what moves')
  assert.match(css, /\.rowfold\.on\{[^}]*grid-template-rows:1fr/)
  assert.doesNotMatch(css, /\.rowfold\{[^}]*max-height/, 'no guessed height')
  // AND A SHUT FOLD IS NOT FOCUSABLE. It is still in the page, so without this a
  // password field sits in the tab order behind a closed panel.
  assert.match(css, /\.rowfold\{[^}]*visibility:hidden/)
  assert.match(css, /\.rowfold\.on\{[^}]*visibility:visible/)
  // AND SOMEBODY WHO ASKED FOR LESS MOVEMENT GETS NONE.
  assert.match(css, /prefers-reduced-motion:reduce\)\{[^}]*\.rowfold[^}]*transition:none/)
})

/* ------------------------------------------- three ways to look -- */

test('THE LIBRARY HAS THREE VIEWS, and the choice is remembered', async (t) => {
  // Plex's three, which Tim asked for with screenshots (2026-08-20): posters,
  // posters-with-a-summary, and a plain list. They answer different questions -
  // "what shall I watch", "what is this", "do I have it" - and the third is much the
  // fastest on a library of 240.
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const chooser = doc.querySelector('.pickrow .viewtoggle')
  assert.ok(chooser, 'the chooser sits with the library, at the far end')
  const by = (label) => [...chooser.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)
  assert.deepEqual([...chooser.querySelectorAll('button')].map(b => b.getAttribute('aria-label')),
    ['Posters', 'Details', 'A list'])
  // ICONS, NOT WORDS - three labelled buttons is a sentence in a toolbar - so every
  // one of them says its name for anything that cannot see a picture.
  assert.ok([...chooser.querySelectorAll('button')].every(b => !b.textContent.trim()))

  // POSTERS BY DEFAULT: a shelf of films is what a grid is for.
  assert.equal(by('Posters').getAttribute('aria-pressed'), 'true')
  // `.screen` is the library itself - the Continue shelf above it is a grid of
  // posters too, and it is not what this control governs.
  assert.ok(doc.querySelector('.screen .grid .poster'))

  by('Details').dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const row = [...doc.querySelectorAll('.detailrow')].find(r => /Metropolis/.test(r.textContent))
  assert.ok(row, 'a row per film')
  assert.ok(row.querySelector('.art'), 'with its poster, small')
  assert.match(row.querySelector('.dmeta').textContent, /1927/, 'the year')
  // The fixture's Metropolis is 153 SECONDS, which is the units the item model uses.
  assert.match(row.querySelector('.dmeta').textContent, /3m/, 'and how long it is')
  assert.equal(doc.querySelector('.screen .grid .poster'), null, 'and the wall of posters is gone')
  assert.ok(doc.querySelector('.grid .poster'), 'while the Continue shelf keeps its own')

  by('A list').dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const head = doc.querySelector('.tablev .thead')
  assert.ok(head, 'the columns are named rather than left to be worked out')
  assert.match(head.textContent, /Title/)
  assert.match(head.textContent, /Year/)
  const line = [...doc.querySelectorAll('.trow')].find(r => /Metropolis/.test(r.textContent))
  assert.match(line.querySelector('.ts').textContent, /1927/)
  assert.equal(doc.querySelector('.detailrow'), null)

  // REMEMBERED IN THIS BROWSER. How somebody likes a list to look is not the host's
  // business and does not belong in its data dir.
  assert.equal(win.localStorage.getItem('pearcinema.libraryview'), 'table')
  assert.notEqual(win.localStorage.getItem('pearcinema.episodeview'), 'table',
    'and a season of episodes is a separate question, answered separately')

  assert.match(text(), /Metropolis/, 'the film is on screen in every one of them')
})

test('a film opens from any of the three', async (t) => {
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const by = (label) => [...doc.querySelectorAll('.pickrow .viewtoggle button')]
    .find(b => b.getAttribute('aria-label') === label)

  by('A list').dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const line = [...doc.querySelectorAll('.trow')].find(r => /Metropolis/.test(r.textContent))
  line.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  assert.ok(doc.querySelector('.playerwrap'), 'pressing a line plays the film')
  assert.match(text(), /Metropolis/)
})

test('an episode list offers the same three, and an old choice survives the rename', async (t) => {
  // The compact one used to be called 'list'. A browser that chose it keeps what it
  // chose rather than being quietly put back on posters.
  const { dom, doc, win } = await open(STATE, {
    '/api/library/list?type=series&limit=100': { items: [{ type: 'series', id: 'show-1', title: 'The Wire', seasonCount: 1, artId: null }], total: 1, cursor: null },
    '/api/library/list?type=seasons&limit=100': { items: [{ type: 'season', id: 's1', seriesId: 'show-1', seriesTitle: 'The Wire', number: 1, title: 'Season 1', artId: null }], total: 1, cursor: null },
    '/api/library/list?type=episodes&limit=200': {
      items: [{
        type: 'episode', id: 'e1', seriesId: 'show-1', seasonId: 's1', seriesTitle: 'The Wire',
        seasonNumber: 1, episodeNumber: 1, title: 'The Target', runtime: 3600,
        overview: 'McNulty watches a case fall apart in court.', artId: null,
        media: { container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', size: 4096 }
      }],
      total: 1,
      cursor: null
    }
  })
  t.after(() => dom.window.close())
  win.localStorage.setItem('pearcinema.episodeview', 'list')

  const shows = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Shows'))
  shows.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  ;[...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('The Wire'))
    .dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))
  ;[...doc.querySelectorAll('.poster')].find(p => p.textContent.includes('Season 1'))
    .dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const chooser = [...doc.querySelectorAll('.viewtoggle')].slice(-1)[0]
  const by = (label) => [...chooser.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label)
  assert.ok(by('Details'), 'episodes get the three as well')

  by('Details').dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  const row = doc.querySelector('.detailrow')
  // AN EPISODE LEADS WITH ITS SLOT, not a year: S01E01 is how anybody refers to one.
  assert.match(row.querySelector('.dmeta').textContent, /S01E01/)
  assert.match(row.querySelector('.dsum').textContent, /falls? apart in court/)
})

function rootText (doc) { return doc.getElementById('root').textContent }
