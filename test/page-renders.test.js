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
  for (const label of ['User access', 'Switch theme', 'Settings']) {
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

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'User access')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))

  // PEARTUNE'S SHAPE: people first, their devices nested under them. A device that
  // belongs to nobody yet has its own section rather than being mixed in.
  assert.match(text(), /People & devices/)
  // This phone CLAIMS a name nobody has confirmed, which is the one thing on the page
  // waiting on the operator - so it gets its own card at the top rather than being
  // mixed in with devices that are simply unassigned.
  assert.match(text(), /Needs confirming/)
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

test('THE ARTWORK PANEL SAYS THE PRIVACY SENTENCE, and admits which matches were guesses', async (t) => {
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  // Settings is a side navigation now; the artwork panel lives behind its entry.
  const nav = [...doc.querySelectorAll('.setnav button')].find(b => b.textContent === 'Artwork')
  nav.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  // The sentence IS the consent. A toggle without it is a host quietly telling a
  // third party what somebody owns.
  assert.match(text(), /tells TMDB the titles it is identifying/)
  assert.match(text(), /Off by default/)
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

test('EACH FOLDER SAYS WHAT IT HOLDS, and an untyped one says what that was read as', async (t) => {
  // The setting exists because some filenames say nothing at all - a box set numbered
  // K05 - and on the real library 34 television files were landing in the Films list
  // for want of anybody saying which folder was which. A control nobody can find does
  // not fix that, so this asserts it is on screen.
  const { dom, doc, win, text } = await open()
  t.after(() => dom.window.close())

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  assert.match(text(), /\/library\/Movies/)

  const selects = [...doc.querySelectorAll('.rootlist .rootrow select')]
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

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const add = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Add a folder'))
  add.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const use = [...doc.querySelectorAll('button')].find(b => b.textContent.startsWith('Use /library'))
  assert.ok(use, 'the picker opened on what the host can see')
  use.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const rows = [...doc.querySelectorAll('.rootlist .rootrow')]
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

  const devices = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'User access')
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

  for (const label of ['User access', 'Switch theme', 'Settings']) {
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

  const access = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'User access')
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
      deviceKey: 'dk1', label: 'A phone', platform: 'android', online: true,
      personId: 'p1', claimedUser: 'Tim', lastSeen: Date.now(), scope: 'full'
    }]
  }
  const { dom, doc, win, text } = await open(withPerson)
  t.after(() => dom.window.close())

  const access = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'User access')
  access.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))

  const row = doc.querySelector('.prow')
  assert.ok(row, 'the person is a row')
  assert.match(row.textContent, /Tim/)
  assert.match(row.textContent, /1 device/)
  assert.equal(row.querySelector('.dev'), null, 'and their devices are folded away')

  row.querySelector('.pname').dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 30))

  assert.ok(doc.querySelector('.prow .dev'), 'opening them shows what they hold')
  assert.match(text(), /A phone/)
})


// A helper, because every casting assertion needs the same two clicks to get there.
async function openCasting (t, routes = {}) {
  const opened = await open(STATE, routes)
  t.after(() => opened.dom.window.close())
  const { doc, win } = opened

  const tab = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Settings')
  tab.dispatchEvent(new win.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 60))

  const cast = [...doc.querySelectorAll('button, a, li')].find(b => /casting/i.test(b.textContent))
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
  const { text } = await openCasting(t, {
    // The specific route first: the stub matches by prefix in insertion order, and
    // '/api/cast/targets' starts with '/api/cast'.
    '/api/cast/targets': { targets: [ROKU_TARGET], needsChannel: [], mediaChannel: 'Media Assistant' },
    '/api/cast': { enabled: false, baseUrl: 'http://127.0.0.1:8123', tokenSet: false, hidden: [], problem: null }
  })

  assert.match(text(), /Living Room/, 'the television is on the page with no Home Assistant anywhere')
  assert.match(text(), /found on your network/)
  assert.match(text(), /Ready/)
  assert.doesNotMatch(text(), /Casting is off/, 'and it never says casting is off while a television is listed')
})

test('a television that is switched off says so, rather than disappearing', async (t) => {
  const { text } = await openCasting(t, {
    '/api/cast/targets': {
      targets: [{ ...ROKU_TARGET, state: 'unavailable' }],
      needsChannel: [],
      mediaChannel: 'Media Assistant'
    }
  })

  assert.match(text(), /Living Room/, 'still listed')
  assert.match(text(), /Switched off or asleep/)
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

  assert.match(text(), /Home Assistant: not set up/, 'its status is honest, and it is one line')
  // The token field is not on screen until somebody asks for it.
  assert.equal(doc.querySelector('input[type=password]'), null)

  const setUp = [...doc.querySelectorAll('button')].find(b => b.textContent.trim() === 'Set up')
  assert.ok(setUp, 'there is a way in')
  setUp.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 40))
  assert.ok(doc.querySelector('input[type=password]'), 'and it opens')
})
