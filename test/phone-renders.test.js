// THE PHONE'S SCREENS, IN A REAL DOM. The counterpart to page-renders.test.js, which has
// covered the dashboard since July while the phone had nothing.
//
// WHY IT EXISTS (Tim, 2026-08-18, after a day of shipping phone UI). Four changes in one
// day - the relay consent sheet, the first-screenful loading wait, the relayed marker and
// the storage controls - could each only be proven not to CRASH, on an emulator with no
// library paired to it. Every interesting state of this app needs a library: a shelf
// loading, a poster arriving, a prompt before a relayed film, a sticky deny. An emulator
// cannot reach any of them, and unit tests do not touch the DOM at all.
//
// So: the real built page, in JSDOM, with the WORKLET stubbed at the bridge rather than
// the app stubbed anywhere. `window.ReactNativeWebView.postMessage` is where the app's
// world ends, so answering there means everything above it - the components, the effects,
// the state - is the shipping code.
//
// The one thing JSDOM cannot do is load an image, which is load-bearing here rather than
// incidental: the first-screenful wait keys off posters settling, so under JSDOM it is
// always the timeout that ends the wait. That is asserted as itself, not worked around.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'assets', 'index.html'), 'utf8')

const LIBRARY = [
  { id: 'metropolis', type: 'movie', title: 'Metropolis', year: 1927, runtime: 9180, artId: 'art-metro' },
  { id: 'nosferatu', type: 'movie', title: 'Nosferatu', year: 1922, runtime: 5820, artId: 'art-nos' },
  { id: 'thirdman', type: 'movie', title: 'The Third Man', year: 1949, runtime: 6240, artId: 'art-third' }
]

// What the worklet would answer. Every method the phone calls on a first paint has to be
// here, or an effect rejects and the screen it feeds never arrives - which looks exactly
// like a rendering bug and is not one.
function defaultAnswers () {
  return {
    'app.state': {
      platform: 'android',
      deviceKey: 'dev-key',
      paired: true,
      active: { hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'The Cinema' },
      hosts: [{ hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'The Cinema', online: true }],
      merged: { on: false, filter: '_all' },
      live: ['lib-1']
    },
    getSettings: { dataSaver: false, useRelay: true, cols: 2, showRecent: false },
    setSettings: {},
    'art.base': { base: 'http://127.0.0.1:1234/art/' },
    'identity.get': { userName: 'Tim', deviceName: 'Pixel', libraryName: 'The Cinema', owner: true },
    'fav.list': { items: [] },
    'watched.list': { items: [] },
    'download.list': { items: [], running: [] },
    'cast.list': { enabled: false, targets: [], active: [] },
    'relay.status': { useRelay: true, ownRelayKey: '', maxKbps: 0, usage: { month: '2026-08', bytes: 0, warning: null }, libraries: [{ libraryId: 'lib-1', libraryName: 'The Cinema', relayed: false, consent: 'ask' }] },
    'storage.stats': { films: { bytes: 1.4e9, count: 3, cap: 2 * 1024 * 1024 * 1024 }, art: { bytes: 8.3e6, count: 99 } },
    'library.list': { items: LIBRARY, total: LIBRARY.length, cursor: null },
    'library.recent': { items: [] },
    'library.search': { items: [] },
    'resume.get': { resume: null },
    'library.siblings': { prev: null, next: null },
    'shell.pendingLink': null,
    'shell.navSet': { ok: true },
    'shell.haptic': { ok: true },
    'requests.list': { items: [] },
    ping: { ok: true }
  }
}

// Open the built page with the bridge answered. `answers` overrides any method; `calls`
// collects everything the page asked for, which is how a test asserts that pressing a
// button actually reached the worklet rather than only changing a colour.
async function open (answers = {}, { settleMs = 260 } = {}) {
  const errors = []
  const calls = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => errors.push(e))

  const table = { ...defaultAnswers(), ...answers }

  const dom = new JSDOM(PAGE, {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:1234/',
    pretendToBeVisual: true,
    virtualConsole: vc,
    // BEFORE the bundle runs, not after: the app posts its first messages inside its
    // very first effects, and a bridge installed a tick later would miss them.
    beforeParse (win) {
      win.ReactNativeWebView = {
        postMessage (raw) {
          let msg
          try { msg = JSON.parse(raw) } catch { return }
          calls.push({ method: msg.method, args: msg.args })
          const hit = table[msg.method]
          const value = typeof hit === 'function' ? hit(msg.args) : hit
          Promise.resolve(value).then((result) => {
            // An unknown method answers {} rather than hanging. A hang here shows up as a
            // screen that never arrives, which is a much worse thing to debug than a
            // screen that renders with a piece missing.
            win.__pearResponse?.(msg.id, { result: result === undefined ? {} : result })
          })
        }
      }
    }
  })

  const win = dom.window
  // Several turns: state, then the calls it triggers, then the ones those trigger.
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, settleMs / 12))

  return {
    dom,
    win,
    doc: win.document,
    errors,
    calls,
    called: (method) => calls.filter((c) => c.method === method),
    // The RENDERED page, never document.textContent - the bundle is inlined in this file,
    // so asserting that something is absent from the whole document would match the app's
    // own source and could never fail. The dashboard harness learned this the hard way.
    text: () => win.document.getElementById('root').textContent,
    click: (el) => el.dispatchEvent(new win.Event('click', { bubbles: true })),
    // A TILE IS NOT A BUTTON. Posters and rows are driven by usePress - pointerdown then
    // pointerup - so a synthetic click sails straight past them and the test watches a
    // screen that was never touched. This is the single most likely reason a phone-UI
    // test fails while the app works.
    // AND THE EVENT NAME IS CASED, which is a Preact-in-JSDOM trap rather than an app
    // one. Preact lowercases an `onFoo` prop only when `onfoo` exists on the element;
    // JSDOM does not implement pointer events, so `onpointerdown` is absent and the
    // listener is registered as 'PointerDown' with its capitals intact. Firing both
    // spellings costs nothing and works in either world.
    press: (el) => {
      for (const name of ['pointerdown', 'PointerDown']) el.dispatchEvent(new win.Event(name, { bubbles: true }))
      for (const name of ['pointerup', 'PointerUp']) el.dispatchEvent(new win.Event(name, { bubbles: true }))
    },
    settle: (ms = 60) => new Promise((r) => setTimeout(r, ms)),
    // The pressable part of a poster tile is an inner div, not the .album card - the card
    // also holds the bookmark, which deliberately swallows its own pointer events so
    // saving never also opens. Pressing the card itself therefore does nothing at all.
    tile: (re) => [...win.document.querySelectorAll('.album')]
      .filter((a) => re.test(a.textContent))
      .map((a) => [...a.querySelectorAll('div')].find((d) => /^(t|sub)$/.test(d.firstElementChild?.className || '')) || a.querySelector('.cover')?.parentElement || a)[0],
    button: (re) => [...win.document.querySelectorAll('button')].find((b) => re.test(b.textContent)),
    labelled: (label) => [...win.document.querySelectorAll('[aria-label]')].find((b) => b.getAttribute('aria-label') === label)
  }
}

// PRESSING A FILM IS TWO STEPS NOW, and it is deliberate (2026-08-20): a tile opens
// the page ABOUT a film - how long it is, what it is about, whether it is already
// half watched - and Watch on that page starts it. Every test below that wants a
// film actually playing goes through here rather than repeating the two presses.
async function pressWatch (h) {
  const watch = h.button(/^\s*(Watch|Resume at)/)
  assert.ok(watch, 'the film has a page, and the page has a Watch')
  h.click(watch)
  await h.settle(140)
}

test('the phone mounts and shows the library rather than a blank screen', async (t) => {
  const h = await open()
  t.after(() => h.dom.window.close())

  assert.deepEqual(h.errors, [], 'the page threw while starting up')
  assert.ok(h.doc.getElementById('root').childNodes.length > 0, 'nothing rendered - the app is blank')
  assert.ok(h.called('app.state').length >= 1, 'the app never asked the worklet for its state')
})

test('a shelf waits for its first posters, then shows itself', async (t) => {
  // Under JSDOM no image ever loads or errors, so the wait can only end on its timer -
  // which is the half that matters. A poster that 404s or a host that stalls must not be
  // able to hold the library hostage, and this is the only place that is provable.
  const h = await open()
  t.after(() => h.dom.window.close())

  const held = h.doc.querySelector('.artwait')
  assert.ok(held, 'the shelf should start held back while its posters arrive')
  assert.match(h.text(), /Loading|Connecting/, 'and say so rather than showing nothing')

  await h.settle(6500)
  assert.equal(h.doc.querySelector('.artwait'), null, 'the timer must release the shelf whatever the network did')
  assert.match(h.text(), /Metropolis/, 'and the films are there')
})

test('TWO HALVES OF A FILM SAY WHICH HALF THEY ARE', async (t) => {
  // What PR #156 left open: both halves are reachable, and the shelf drew the same
  // title twice with only their length telling them apart. The marker is in the
  // filename, which never leaves the host, so the host carries the number and the
  // phone is where somebody finally reads it.
  const h = await open({
    'library.list': {
      items: [
        { id: 'tt1', type: 'movie', title: 'The Two Towers', year: 2002, part: 1, runtime: 7732, artId: 'a1' },
        { id: 'tt2', type: 'movie', title: 'The Two Towers', year: 2002, part: 2, runtime: 6400, artId: 'a2' }
      ],
      total: 2,
      cursor: null
    }
  })
  t.after(() => h.dom.window.close())
  await h.settle(6500)

  assert.match(h.text(), /Part 1/, 'the first half says so')
  assert.match(h.text(), /Part 2/, 'and so does the second')

  // And a film that is whole says nothing at all - an empty slot on every other
  // poster in the library would be the worse bug.
  const plain = await open()
  t.after(() => plain.dom.window.close())
  await plain.settle(6500)
  assert.doesNotMatch(plain.text(), /Part \d/, 'a whole film has no half to name')
})

test('A LIBRARY THAT REMOVED YOU SAYS SO, rather than connecting for ever', async (t) => {
  // Watched on the TCL, 2026-08-22: revoked mid-film, the phone said "could not reach
  // the host" and Settings said "Active, connecting…" for good, so the person blames
  // their wifi. The host says which it is now (proposal
  // 2026-08-22-say-goodbye-to-a-revoked-device); this is the screen saying it back.
  const h = await open({
    'app.state': {
      platform: 'android',
      deviceKey: 'dev-key',
      paired: true,
      active: { hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'Ada s Films' },
      hosts: [{ hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'Ada s Films', online: false, revoked: true }],
      merged: { on: false, filter: '_all' },
      live: []
    }
  })
  t.after(() => h.dom.window.close())

  const settings = h.button(/Settings/)
  h.click(settings)
  await h.settle(400)

  assert.match(h.text(), /No longer shared with you/, 'the row says what happened')
  assert.doesNotMatch(h.text(), /Active, connecting/, 'and stops pretending it is on its way')
  assert.ok(h.labelled('Remove Ada s Films'), 'with the way out right there')
})

test('THE ASK SHEET SAYS WHO IS BEING ASKED', async (t) => {
  // An ask goes to EVERY paired library on purpose - none of them has the film, so any
  // owner might add it - but somebody looking at one friend's shelf has no reason to
  // guess that, and "I asked Ada" quietly telling four other people is not a surprise
  // to spring (found walking the app as a guest, 2026-08-22).
  const many = await open({
    'app.state': {
      platform: 'android',
      deviceKey: 'dev-key',
      paired: true,
      active: { hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'The Cinema' },
      hosts: [
        { hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'The Cinema', online: true },
        { hostKey: 'host-2', libraryId: 'lib-2', libraryName: 'Ada s Films', online: true }
      ],
      merged: { on: true, ready: true, filter: '_all' },
      live: ['lib-1', 'lib-2']
    }
  })
  t.after(() => many.dom.window.close())
  await many.settle(6500)

  await h_openAsk(many)
  assert.match(many.text(), /This goes to all 2 of your libraries/)

  // WITH ONE LIBRARY THERE IS NOTHING TO WARN ABOUT, and a sentence about "all 1 of
  // your libraries" would be worse than silence.
  const one = await open()
  t.after(() => one.dom.window.close())
  await one.settle(6500)
  await h_openAsk(one)
  assert.doesNotMatch(one.text(), /goes to all/)
})

// The You tab's Requests view, then its Ask button - two presses that several tests
// would otherwise repeat.
async function h_openAsk (h) {
  h.click(h.button(/^You$/))
  await h.settle(300)
  // The sub-tabs are icons until they are selected, so they are found by their label
  // rather than their text - the same trap a person driving this on a device hits.
  const tab = h.labelled('Requests')
  assert.ok(tab, 'the You tab has a Requests view')
  h.click(tab)
  await h.settle(300)
  const ask = [...h.doc.querySelectorAll('button')].find((b) => /Ask for a film/.test(b.textContent))
  assert.ok(ask, 'and a way to ask for something')
  h.click(ask)
  await h.settle(300)
}

test('the relay marker appears only while a library is actually relayed', async (t) => {
  const direct = await open()
  t.after(() => direct.dom.window.close())
  await direct.settle(6500)
  assert.doesNotMatch(direct.text(), /through a relay/, 'a direct library must claim nothing')

  const relayed = await open({
    'relay.status': {
      useRelay: true,
      ownRelayKey: '',
      maxKbps: 2500,
      usage: { month: '2026-08', bytes: 0, warning: null },
      libraries: [{ libraryId: 'lib-1', libraryName: 'The Cinema', relayed: true, consent: 'allow' }]
    }
  })
  t.after(() => relayed.dom.window.close())
  await relayed.settle(6500)

  const bar = relayed.doc.querySelector('.relaybar')
  assert.ok(bar, 'a relayed library has to say so')
  assert.match(bar.textContent, /The Cinema/, 'and name which one')
  assert.match(bar.textContent, /2\.5 Mbps/, 'and say what it costs the picture')
})

test('a relayed film asks before it plays, and remembers the answer', async (t) => {
  // The whole point of the gate: no url comes back until the person has answered, so a
  // bug that ignored the flag could not play the film anyway.
  let asked = 0
  const h = await open({
    'stream.url': ({ itemId }) => {
      asked++
      return asked === 1
        ? { needsRelayConsent: true, libraryId: 'lib-1', libraryName: 'The Cinema' }
        : { url: 'http://127.0.0.1:1234/s/' + itemId, mode: 'direct' }
    },
    'relay.consent.set': { consent: { 'lib-1': 'allow' } }
  })
  t.after(() => h.dom.window.close())
  await h.settle(6500)

  const tile = h.tile(/Metropolis/)
  assert.ok(tile, 'the film has to be on screen before it can be pressed')
  h.press(tile)
  await h.settle(120)
  await pressWatch(h)

  assert.match(h.text(), /Play over a relay/, 'the prompt must appear')
  assert.equal(h.called('shell.play').length, 0, 'and nothing may play while it is unanswered')

  h.click(h.button(/Play it/))
  await h.settle(160)

  const consent = h.called('relay.consent.set')
  assert.equal(consent.length, 1, 'the answer must be remembered')
  assert.equal(consent[0].args.decision, 'allow')
  assert.ok(h.called('stream.url').length >= 2, 'and the film asked for again, now that it may play')
})

test('saying no to the relay is a decision, not a dialog that returns', async (t) => {
  const h = await open({
    'stream.url': { needsRelayConsent: true, libraryId: 'lib-1', libraryName: 'The Cinema' },
    'relay.consent.set': { consent: { 'lib-1': 'deny' } }
  })
  t.after(() => h.dom.window.close())
  await h.settle(6500)

  h.press(h.tile(/Metropolis/))
  await h.settle(120)
  await pressWatch(h)
  h.click(h.button(/Not over a relay/))
  await h.settle(120)

  const consent = h.called('relay.consent.set')
  assert.equal(consent[0].args.decision, 'deny')
  assert.doesNotMatch(h.text(), /Play over a relay/, 'the sheet must close on an answer')
})

test('the storage controls show what is actually being held', async (t) => {
  const h = await open()
  t.after(() => h.dom.window.close())
  await h.settle(6500)

  h.click(h.labelled('Settings'))
  await h.settle(120)
  h.click(h.button(/Streaming and downloads/))
  await h.settle(120)

  const text = h.text()
  assert.match(text, /1\.4 GB/, 'the films figure comes from the worklet, not a guess')
  assert.match(text, /3 films/)
  assert.match(text, /99 posters/)
  assert.ok(h.doc.querySelector('.stepslider input[type=range]'), 'the cap is a slider')
})

test('the relay switch reflects the setting and writes it back', async (t) => {
  const h = await open()
  t.after(() => h.dom.window.close())
  await h.settle(6500)

  h.click(h.labelled('Settings'))
  await h.settle(120)
  h.click(h.button(/Connection/))
  await h.settle(120)

  const sw = h.labelled('Connect through a relay when needed')
  assert.ok(sw, 'the switch has to be findable by its label, which is also how a screen reader finds it')
  assert.equal(sw.getAttribute('aria-checked'), 'true', 'it starts on, as the default does')

  h.click(sw)
  await h.settle(120)
  assert.equal(sw.getAttribute('aria-checked'), 'false')
  const wrote = h.called('setSettings').filter((c) => 'useRelay' in (c.args || {}))
  assert.equal(wrote.at(-1).args.useRelay, false, 'and the worklet was told, not just the screen')
})

test('A LIBRARY THAT CANNOT REACH ITS FILMS SAYS SO, rather than looking empty', async (t) => {
  // The two are identical from the phone's side, and the wrong one is the default: an
  // empty shelf reads as "there is nothing in this library", which is a lie about
  // somebody's films. The host has always answered this on library.stats and nothing
  // here ever asked, so when Tim's Umbrel lost its drive on 2026-08-19 the phone said
  // nothing at all.
  const { text, dom } = await open({
    'library.sources': {
      items: [{
        libraryId: 'lib-a',
        libraryName: 'The Cinema',
        sourceError: 'None of this library\'s files are in /library/Movies. Is the drive still mounted?'
      }]
    },
    'library.list': { items: [], cursor: null }
  })
  t.after(() => dom.window.close())

  assert.match(text(), /cannot reach its films/)
  assert.match(text(), /Is the drive still mounted/)
})

test('IT ASKS EVERY LIBRARY, not just the active one', async (t) => {
  // The bug that made this read as working on one phone and silent on another, on the
  // same build. library.stats answers for the ACTIVE host, and a merged shelf shows
  // films from all of them - so the host that lost its drive is very often not the one
  // being asked (Tim's Pixel, 2026-08-19).
  const { text, dom, called } = await open({
    'library.sources': {
      items: [
        { libraryId: 'lib-b', libraryName: 'The Study', sourceError: 'None of this library\'s files are in /library/Movies. Is the drive still mounted?' },
        { libraryId: 'lib-c', libraryName: 'The Loft', sourceError: 'No configured folder is readable.' }
      ]
    }
  })
  t.after(() => dom.window.close())

  assert.equal(called('library.sources').length > 0, true, 'it asks the question at all')
  // NAMED, ALWAYS. "This library cannot reach its films" is no use on a merged shelf
  // showing three of them at once, and naming it is never worse on a single one
  // (Tim, 2026-08-19, with All libraries selected).
  assert.match(text(), /The Study cannot reach its films/)
  assert.match(text(), /The Loft cannot reach its films/)
  assert.doesNotMatch(text(), /This library cannot reach/)
})

test('ONLY THE FILMS THAT CANNOT BE REACHED GO DIM', async (t) => {
  // A merged shelf mixes libraries. Greying the whole grid would be a lie about the
  // ones that still have their disks, and they are perfectly playable.
  const { dom, doc } = await open({
    'library.sources': { items: [{ libraryId: 'lib-gone', libraryName: 'The Loft', sourceError: 'No configured folder is readable.' }] },
    'library.list': {
      items: [
        { id: 'a', type: 'movie', title: 'Metropolis', year: 1927, runtime: 9180, libraryId: 'lib-gone' },
        { id: 'b', type: 'movie', title: 'Nosferatu', year: 1922, runtime: 5820, libraryId: 'lib-here' }
      ],
      cursor: null
    }
  })
  t.after(() => dom.window.close())

  const tiles = [...doc.querySelectorAll('.album')]
  const dim = tiles.filter((el) => el.className.includes('unreachable'))
  assert.equal(dim.length, 1, 'one library is out, not the shelf')
  assert.match(dim[0].textContent, /Metropolis/)
})

test('A FILM IN TWO LIBRARIES IS NOT LOST WHEN ONE OF THEM IS', async (t) => {
  // The merged primary is chosen for completeness, not for being reachable - so the
  // copy that wins can be the one on the library that has gone, while another library
  // has had it all along. Tim's Arrival, greyed out on the TCL with a perfectly good
  // second copy behind it (2026-08-19).
  const { dom, doc } = await open({
    'library.sources': { items: [{ libraryId: 'lib-gone', libraryName: 'The Loft', sourceError: 'No configured folder is readable.' }] },
    'library.list': {
      items: [
        {
          id: 'arrival-gone',
          type: 'movie',
          title: 'Arrival',
          year: 2016,
          runtime: 6960,
          libraryId: 'lib-gone',
          copies: [
            { libraryId: 'lib-gone', id: 'arrival-gone' },
            { libraryId: 'lib-here', id: 'arrival-here' }
          ]
        }
      ],
      cursor: null
    }
  })
  t.after(() => dom.window.close())

  const tiles = [...doc.querySelectorAll('.album')]
  assert.equal(tiles.length, 1)
  assert.equal(tiles[0].className.includes('unreachable'), false, 'the other library still has it')
})

test('A FILM NOBODY CAN REACH REFUSES BEFORE THE RESUME PROMPT', async (t) => {
  // Keeping the tile pressable was right for downloads and wrong for everything else.
  // On the TCL, 2001 had watch state, so the tap offered to resume it - and Resume
  // opened a player that could never start (Tim, 2026-08-19). Asking "carry on from
  // 41 minutes?" about a film that cannot start is worse than refusing plainly.
  const { dom, doc, press, tile, settle, called, text, button, click } = await open({
    'library.sources': { items: [{ libraryId: 'lib-gone', libraryName: 'The Loft', sourceError: 'No configured folder is readable.' }] },
    'library.list': {
      items: [{ id: '2001', type: 'movie', title: '2001 A Space Odyssey', year: 1968, runtime: 8880, libraryId: 'lib-gone' }],
      cursor: null
    },
    'resume.get': { resume: { positionMs: 2460000 } }
  })
  t.after(() => dom.window.close())

  press(tile(/2001/))
  await settle(120)
  // The page opens for free - the item is already on screen - and it is Watch that
  // meets the refusal, before any prompt about where the film was left.
  assert.equal(called('stream.url').length, 0, 'nothing is asked for merely by looking')
  const watch = button(/^\s*(Watch|Resume at)/)
  assert.ok(watch)
  click(watch)
  await settle(140)

  assert.equal(called('stream.url').length, 0, 'and never asks for a stream it cannot have')
  assert.match(text(), /The Loft cannot reach this film/)
  assert.match(text(), /not downloaded to this phone/)
  void doc
})

test('A BUTTON INSIDE A ROW IS NOT THE ROW', async (t) => {
  // Pressing the delete on a download OPENED the film and removed it on the way out
  // (Tim, 2026-08-19). The row is driven by pointerdown and pointerup; the button
  // stopped the CLICK, which happens afterwards - so both fired, in that order.
  //
  // Fixed in usePress rather than on each button: one rule, in one place, that a new
  // row-button cannot forget to apply. The Unmark button on the Watched list had the
  // same fault and never showed it.
  const { dom, doc, press, click, settle, called } = await open({
    'download.list': { items: [{ itemId: 'metropolis', size: 1024 }], running: [] },
    'library.get': { id: 'metropolis', type: 'movie', title: 'Metropolis', year: 1927, runtime: 9180 }
  })
  t.after(() => dom.window.close())

  // The nav and the sub-tabs are plain buttons; only rows and tiles are pressed.
  click([...doc.querySelectorAll('nav button')].find(b => b.getAttribute('aria-label') === 'You'))
  await settle(200)
  const dl = [...doc.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Downloads')
  assert.ok(dl, 'the You tab opened')
  click(dl)
  await settle(320)

  const row = doc.querySelector('li.track')
  assert.ok(row, 'the download is listed')
  const trash = row.querySelector('button')
  assert.ok(trash, 'with something to remove it')

  // A FINGER FIRES BOTH: pointerdown, pointerup, then click. The row listens to the
  // first two and the button to the last, which is exactly how one press did both.
  press(trash)
  click(trash)
  await settle(200)

  assert.equal(called('stream.url').length, 0, 'pressing remove does not start the film')
  assert.equal(called('resume.get').length, 0, 'and does not ask where it was left')
  assert.ok(called('download.remove').length > 0, 'but it does remove it')

  // The rest of the row is still the row - it opens the film's page now rather than
  // playing it outright, so Watch is what asks the host for a stream.
  press(row.querySelector('.meta') || row)
  await settle(200)
  const watch = [...doc.querySelectorAll('button')].find(b => /^\s*(Watch|Resume at)/.test(b.textContent))
  assert.ok(watch, 'the rest of the row is still the row')
  click(watch)
  await settle(200)
  assert.ok(called('stream.url').length > 0, 'and Watch is what starts it')
})

test('the phone boot style paints no #root either', async () => {
  // Same fault, same shape, one file over: `background:#0f0d0a` on `#root` in the boot
  // style. It never showed on the phone because the app is dark by default - it would
  // have shown the day anybody chose light (2026-08-19).
  // The FIRST style block is the boot one; the app's own stylesheet follows it and is
  // free to paint #root from a token, which is the correct way to do it.
  const boot = PAGE.slice(PAGE.indexOf('<style>') + 7, PAGE.indexOf('</style>'))
  for (const rule of boot.match(/[^{}]*\{[^{}]*\}/g) || []) {
    if (!/#root/.test(rule.split('{')[0])) continue
    assert.doesNotMatch(rule, /background/, 'a background on #root strands the page on one theme: ' + rule)
  }
})

test('CASTING PUTS A REMOTE ON THE LOCK SCREEN, and its buttons reach the television', async (t) => {
  // Tim, 2026-08-19: answering a message while a film played on the TV meant unlocking,
  // finding the app and waiting for it to come back before the room could be paused.
  // The shell draws the remote; this asserts the two halves that make it work - the app
  // says what is playing, and a button pressed out there lands on the right television.
  const h = await open({
    'library.get': LIBRARY[0],
    'cast.list': { enabled: true, targets: [{ entityId: 'tv-1', libraryId: 'lib-1', name: 'Living Room' }], active: [] },
    'cast.play': { ok: true },
    'cast.pause': { ok: true },
    'cast.resume': { ok: true },
    'cast.seek': { ok: true },
    'cast.stop': { ok: true },
    'cast.state': { positionMs: 61000, durationMs: 9180000 }
  })
  t.after(() => h.dom.window.close())

  // The player's own cast button is the shortest way in: it hands the film back to the
  // UI, which opens the picker on it.
  h.win.__pearEvent('player:cast', { itemId: 'metropolis', title: 'Metropolis', positionMs: 0 })
  await h.settle(160)

  const target = h.button(/Living Room/)
  assert.ok(target, 'the picker offers the television')
  h.click(target)
  await h.settle(200)

  assert.equal(h.called('cast.play').length, 1, 'the television was told to play')

  const shown = h.called('shell.castRemote').filter((c) => c.args?.show)
  assert.ok(shown.length >= 1, 'the shell was asked to draw a remote')
  const last = shown[shown.length - 1].args
  assert.equal(last.title, 'Metropolis')
  assert.equal(last.subtitle, 'on Living Room')
  assert.match(last.artUrl || '', /art-metro/, 'with the poster, so the lock screen is not a grey box')
  assert.equal(last.paused, false)

  // WHAT THE SHELL NEEDS TO ACT ALONE rides with it. The controls were on the lock
  // screen and did nothing until the app was reopened, because Android freezes a
  // backgrounded WebView (Tim, 2026-08-19, on the Pixel) - so the shell talks to the
  // television itself and needs to know which one.
  assert.equal(last.entityId, 'tv-1')
  assert.equal(last.libraryId, 'lib-1')
  assert.equal(last.skipMs, 30000)

  // A press comes back as NEWS, and the app must not act on it a second time: the
  // television has already been told. Twice would be sixty seconds when somebody asked
  // for thirty.
  h.win.__pearEvent('cast:control', { action: 'pause' })
  await h.settle(140)
  assert.equal(h.called('cast.pause').length, 0, 'the shell sent it, not this')
  assert.equal(h.called('cast.resume').length, 0)
  const afterPause = h.called('shell.castRemote').filter((c) => c.args?.show)
  assert.equal(afterPause[afterPause.length - 1].args.paused, true, 'but the bar agrees with the room')

  h.win.__pearEvent('cast:control', { action: 'back' })
  await h.settle(140)
  assert.equal(h.called('cast.seek').length, 0, 'a skip is the shell\'s too')

  // Stopping takes the remote down with it - a notification whose buttons answer to
  // nothing is worse than no notification.
  h.win.__pearEvent('cast:control', { action: 'stop' })
  await h.settle(160)
  const hidden = h.called('shell.castRemote').filter((c) => c.args?.show === false)
  assert.ok(hidden.length >= 1, 'the remote was taken down')

  // AND THE TELEVISION IS ASKED, rather than believed about. Somebody pausing with the
  // TV's own remote, or from a lock screen while this was frozen, leaves the bar showing
  // the wrong button until it asks - so the readout adopts what the television says.
  const paused = await open({
    'library.get': LIBRARY[0],
    'cast.list': { enabled: true, targets: [{ entityId: 'tv-1', libraryId: 'lib-1', name: 'Living Room' }], active: [] },
    'cast.play': { ok: true },
    'cast.state': { positionMs: 61000, durationMs: 9180000, state: 'paused' }
  })
  t.after(() => paused.dom.window.close())
  paused.win.__pearEvent('player:cast', { itemId: 'metropolis', title: 'Metropolis', positionMs: 0 })
  await paused.settle(160)
  paused.click(paused.button(/Living Room/))
  await paused.settle(400)
  const drawn = paused.called('shell.castRemote').filter((c) => c.args?.show)
  assert.equal(drawn[drawn.length - 1].args.paused, true, 'the television said paused, so the remote says paused')
})

test('THE BAR COUNTS BETWEEN READINGS, so it agrees with the lock screen', async (t) => {
  // Tim, 2026-08-19: "is there no way to get the onscreen timestamp and app timestamp to
  // match?" They could not. The notification advances itself at playing speed from the
  // last reading; this bar showed the reading itself, so it sat still for five seconds
  // and then jumped, always behind by however long ago it had been asked for.
  const h = await open({
    'library.get': LIBRARY[0],
    'cast.list': { enabled: true, targets: [{ entityId: 'tv-1', libraryId: 'lib-1', name: 'Living Room' }], active: [] },
    'cast.play': { ok: true },
    'cast.state': { positionMs: 61000, durationMs: 9180000, state: 'playing' }
  })
  t.after(() => h.dom.window.close())

  h.win.__pearEvent('player:cast', { itemId: 'metropolis', title: 'Metropolis', positionMs: 0 })
  await h.settle(160)
  h.click(h.button(/Living Room/))
  await h.settle(300)

  const clock = () => (h.doc.querySelector('.castbar .at')?.textContent || '').trim()
  const first = clock()
  assert.match(first, /1:0[01]/, 'the reading itself, at a minute in')

  // Two seconds later the bar has moved on its own, without asking the television
  // again - the same thing the lock screen does with the same anchor.
  await h.settle(2200)
  const later = clock()
  assert.notEqual(later, first, 'the minute is still where it was two seconds ago')
})

test('A POSTER CANNOT SWALLOW A LONG PRESS', async (t) => {
  // Tim, 2026-08-20: "I couldn't get the long press menu to appear on Blade. some titles
  // it works fine, others not." The inconsistency was the artwork - Android's WebView
  // treats a held image as an image, starts a drag, and the cancelled pointer sequence
  // clears the long-press timer a beat before it would have opened the menu. A tile with
  // no poster has no image to hold, which is why some titles behaved.
  //
  // JSDOM cannot reproduce a native drag, so this pins the two things that stop it: the
  // picture is not a pointer target, and it is not draggable.
  const h = await open()
  t.after(() => h.dom.window.close())

  const img = h.doc.querySelector('.cover img.poster')
  assert.ok(img, 'a tile with artwork')
  assert.equal(img.getAttribute('draggable'), 'false')

  const rules = PAGE.match(/\.cover img\{[^}]*\}/g) || []
  assert.ok(rules.some((r) => /pointer-events:\s*none/.test(r)), 'the press lands on the tile, not the picture')
})

/* ------------------------------------------------ playing next -- */

test('THE NEXT EPISODE IS HANDED TO THE SHELL WITH ITS WORDS, not just a flag', async (t) => {
  // The card is drawn by the shell, because the film is a native view covering
  // this page. A card that had to fetch its own words would be blank at the
  // exact moment somebody is looking at it, so they ride shell.navSet.
  const EP = { id: 'wire-s01e02', type: 'episode', title: 'The Detail', seriesTitle: 'The Wire', runtime: 3600, artId: 'art-wire' }
  const NEXT = {
    id: 'wire-s01e03',
    type: 'episode',
    title: 'The Buys',
    seriesTitle: 'The Wire',
    seasonNumber: 1,
    episodeNumber: 3,
    runtime: 3600,
    overview: 'The detail goes up on the wire.',
    artId: 'art-buys'
  }
  const h = await open({
    'library.list': { items: [EP], total: 1, cursor: null },
    'stream.url': ({ itemId }) => ({ url: 'http://127.0.0.1:1234/s/' + itemId, mode: 'direct' }),
    'library.siblings': { prev: null, next: NEXT }
  })
  t.after(() => h.dom.window.close())
  await h.settle(400)

  h.press(h.tile(/The Detail/))
  await h.settle(200)

  const set = h.called('shell.navSet')
  assert.equal(set.length, 1, 'the neighbours reached the shell')
  assert.equal(set[0].args.hasNext, true)
  assert.equal(set[0].args.autoplayNext, true, 'on by default, the way a television behaves')
  assert.equal(set[0].args.next.seriesTitle, 'The Wire')
  assert.equal(set[0].args.next.title, 'The Buys')
  assert.equal(set[0].args.next.label, 'Episode 3')
  assert.match(set[0].args.next.overview, /goes up on the wire/)
  // The picture comes as a finished url off this phone's own shim, because the
  // shell has no idea where art lives.
  assert.match(set[0].args.next.artUrl, /^http:\/\/127\.0\.0\.1:1234\/art\/art-buys/)
})

test('the autoplay switch on the card is the same one in Settings', async (t) => {
  // Two places to throw it and one preference behind them: the card saves
  // through the page, so the Settings switch cannot disagree with it.
  const h = await open({ getSettings: { dataSaver: false, useRelay: true, cols: 2, showRecent: false, autoplayNext: false } })
  t.after(() => h.dom.window.close())
  await h.settle(300)

  h.click(h.labelled('Settings'))
  await h.settle(160)
  const sw = h.labelled('Play the next episode')
  assert.ok(sw, 'the setting is on the Settings page')
  assert.equal(sw.getAttribute('aria-checked'), 'false', 'and it reads what was saved')

  // The card's own checkbox, thrown inside the native player.
  h.win.__pearEvent('player:autoplay', { on: true })
  await h.settle(120)

  const wrote = h.called('setSettings').filter((c) => 'autoplayNext' in (c.args || {}))
  assert.equal(wrote.length, 1)
  assert.equal(wrote[0].args.autoplayNext, true)
  assert.equal(h.labelled('Play the next episode').getAttribute('aria-checked'), 'true', 'and the page agrees')
})

/* --------------------------------------- the continue list -- */

const HALF = (n) => ({
  id: 'old-' + n,
  type: 'movie',
  title: 'Half watched ' + n,
  year: 1960 + n,
  runtime: 5400,
  resume: { positionMs: 900_000, playedAt: Date.now() - n * 1000 }
})

test('THE CONTINUE LIST IS CAPPED, with the rest one press away', async (t) => {
  const h = await open({ 'resume.list': { items: Array.from({ length: 14 }, (_, n) => HALF(n)) } })
  t.after(() => h.dom.window.close())
  await h.settle(300)

  h.click(h.labelled('You'))
  await h.settle(220)

  assert.match(h.text(), /Half watched 0/)
  assert.doesNotMatch(h.text(), /Half watched 12/, 'the tail is behind Show all')
  const more = h.button(/Show all 14/)
  assert.ok(more, 'and it says how many there are')
  h.click(more)
  await h.settle(80)
  assert.match(h.text(), /Half watched 13/)
})

test('A PLACE CAN BE REMOVED WITHOUT CLAIMING TO HAVE WATCHED IT', async (t) => {
  // Marking it watched already takes it off this list, and for something
  // abandoned rather than finished that is a lie which shows up as a tick
  // everywhere else.
  const h = await open({ 'resume.list': { items: [HALF(0), HALF(1)] } })
  t.after(() => h.dom.window.close())
  await h.settle(300)
  h.click(h.labelled('You'))
  await h.settle(220)

  // The button is a mark rather than a word now (2026-08-20), so it is found the way a
  // screen reader finds it - which is also the assertion that it still says what it does.
  h.click(h.labelled('Remove from Continue watching'))
  await h.settle(120)

  const zeroed = h.called('resume.set')
  assert.equal(zeroed.length, 1)
  assert.equal(zeroed[0].args.positionMs, 0, 'a zero position IS the delete')
  assert.equal(h.called('watched.set').length, 0, 'and nothing was marked watched')
  assert.doesNotMatch(h.text(), /Half watched 0/, 'the row goes at once')
})

test('CLEARING THE LIST ASKS FIRST, and says the places will be forgotten', async (t) => {
  const h = await open({ 'resume.list': { items: [HALF(0), HALF(1)] }, 'resume.clear': { ok: true, cleared: 2 } })
  t.after(() => h.dom.window.close())
  await h.settle(300)
  h.click(h.labelled('You'))
  await h.settle(220)

  h.click(h.button(/Clear list/))
  await h.settle(100)
  assert.match(h.text(), /will be forgotten/)
  assert.match(h.text(), /cannot be undone/)
  assert.equal(h.called('resume.clear').length, 0, 'nothing has happened yet')

  h.click(h.button(/^Cancel$/))
  await h.settle(80)
  assert.equal(h.called('resume.clear').length, 0, 'still nothing')

  h.click(h.button(/Clear list/))
  await h.settle(80)
  h.click(h.button(/Clear it/))
  await h.settle(150)
  assert.equal(h.called('resume.clear').length, 1)
  assert.match(h.text(), /Nothing in progress/)
})

/* --------------------------------------- the page about one film -- */

test('TAPPING A FILM OPENS ITS PAGE, and nothing is fetched to do it', async (t) => {
  // Tim, 2026-08-20, with Plex's phone screen. Tapping a film used to start it,
  // which is the phone's oldest shortcut and its worst: the only chance anybody gets
  // to read what a film is, see how long it is, or notice they are already part way
  // through it.
  const FILM = {
    id: 'spider', type: 'movie', title: 'The Amazing Spider-Man', year: 2012, runtime: 8160,
    overview: 'After Peter Parker is bitten by a genetically altered spider, he gains newfound powers.',
    genres: ['Action', 'Adventure'], artId: 'art-spider',
    media: { container: 'matroska', videoCodec: 'h264', audioCodec: 'dts', audioChannels: 6, height: 1080, size: 12_800_000_000 }
  }
  const h = await open({
    'library.list': { items: [FILM], total: 1, cursor: null },
    'subtitle.list': { items: [{ id: 's1', title: 'English', playable: true }] },
    'resume.get': { resume: null }
  })
  t.after(() => h.dom.window.close())
  await h.settle(400)

  h.press(h.tile(/Spider-Man/))
  await h.settle(200)

  assert.equal(h.called('stream.url').length, 0, 'nothing is asked for merely by looking')
  assert.equal(h.called('shell.play').length, 0, 'and nothing is playing')

  assert.match(h.text(), /The Amazing Spider-Man/)
  assert.match(h.text(), /2012/)
  assert.match(h.text(), /2h 16m/, 'how long it is')
  assert.match(h.text(), /genetically altered spider/, 'what it is about')

  // WHAT IS ACTUALLY IN THE FILE, which is the part nobody else can answer as well:
  // it is this operator's own file rather than a database entry about the film.
  assert.match(h.text(), /1080p/)
  assert.match(h.text(), /DTS/)
  assert.match(h.text(), /6 channels/)
  assert.match(h.text(), /1 available/, 'the subtitles are asked for and counted')
  assert.match(h.text(), /12.8 GB/)

  // AND WATCH IS WHAT STARTS IT.
  h.click(h.button(/^\s*Watch/))
  await h.settle(200)
  assert.equal(h.called('stream.url').length, 1)
})

test('a film you are part way through offers the minute, not just Resume', async (t) => {
  const h = await open({
    'library.list': { items: [{ id: 'm', type: 'movie', title: 'Metropolis', year: 1927, runtime: 9180 }], total: 1, cursor: null },
    'resume.get': { resume: { positionMs: 2_460_000 } },
    'subtitle.list': { items: [] }
  })
  t.after(() => h.dom.window.close())
  await h.settle(400)

  h.press(h.tile(/Metropolis/))
  await h.settle(220)
  // "Resume" with no number is a promise nobody can check.
  assert.ok(h.button(/Resume at 41:00/), 'the exact moment: ' + h.text().slice(0, 200))
})

test('an EPISODE still plays from its season, because the list already says what it is', async (t) => {
  // The page exists for the thing a grid cannot say. An episode is reached from its
  // season, where the rows around it carry the number, the length and the summary.
  const EP = { id: 'e1', type: 'episode', title: 'The Target', seriesTitle: 'The Wire', seasonNumber: 1, episodeNumber: 1, runtime: 3600 }
  const h = await open({
    'library.list': { items: [EP], total: 1, cursor: null },
    'stream.url': { url: 'http://127.0.0.1:1234/s/e1', mode: 'direct' }
  })
  t.after(() => h.dom.window.close())
  await h.settle(400)

  h.press(h.tile(/The Target/))
  await h.settle(220)
  assert.equal(h.called('stream.url').length, 1, 'it plays rather than opening a page')
})

test('A CACHED POSTER STILL SHOWS, even when it finished before anyone was listening', async (t) => {
  // Tim, 2026-08-20: 300 had its poster in the library grid and a placeholder on its
  // title page. The first request for a cover crosses P2P and takes long enough that
  // the element is listening by the time it lands; the shim then holds it in RAM, on
  // disk and behind a day of cache-control, so every later request is answered
  // instantly - and instantly beats the listener, so `load` never fires and the
  // poster sat at opacity 0 over its own initials.
  //
  // The grid is almost always somebody's FIRST sight of a poster and the title page
  // almost always their second, which is why it read as the page being broken.
  const FILM = { id: 'f300', type: 'movie', title: '300', year: 2007, runtime: 7020, artId: 'art-300' }
  const h = await open({ 'library.list': { items: [FILM], total: 1, cursor: null }, 'subtitle.list': { items: [] } })
  t.after(() => h.dom.window.close())

  // JSDOM loads no images, so this is what "already complete" looks like to the
  // component: the browser answering yes before a handler could ever run.
  const proto = h.win.HTMLImageElement.prototype
  Object.defineProperty(proto, 'complete', { configurable: true, get () { return true } })
  Object.defineProperty(proto, 'naturalWidth', { configurable: true, get () { return 600 } })

  await h.settle(400)
  h.press(h.tile(/300/))
  await h.settle(220)

  const poster = h.doc.querySelector('.tposter img.poster')
  assert.ok(poster, 'the page put the poster in the page')
  assert.match(poster.getAttribute('src'), /art-300/, 'and pointed it at the right cover')
  // `in` is what takes it from invisible to visible.
  assert.ok(poster.classList.contains('in'), 'and it is actually showing')
})

test('A CODE THAT IS NOT A PAIRING CODE SAYS WHAT TO DO INSTEAD', async (t) => {
  // FOUND BY SCANNING ONE (2026-08-20, on the TCL with a camera frame fed into the
  // scanner's own video element): the parser is deliberately strict - a PearTune link, a
  // PearCal join URL and a wifi QR all have to fail to parse as a PearCinema pairing link
  // - and it throws in the vocabulary of a parser. "invalid PearCinema pairing link",
  // lower case, no advice, was what somebody saw after pointing a camera at the wrong
  // square. That is right for a log and wrong on a phone.
  const { text, doc, click, win } = await open({
    'app.state': { ...defaultAnswers()['app.state'], active: null, hosts: [], paired: false },
    pair: () => { throw new Error('invalid PearCinema pairing link') }
  })
  t.after(() => win.close())

  const byText = (re) => [...doc.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()))
  const step = async (re) => {
    const b = byText(re)
    assert.ok(b, `a button matching ${re}`)
    click(b)
    await new Promise((r) => setTimeout(r, 80))
  }

  // The paste path, which is the same pairWith the scanner feeds and needs no camera.
  await step(/^Get started$/)
  const name = doc.querySelector('input')
  name.value = 'Tim'
  name.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))
  await step(/^Continue$/)
  await step(/^It's mine$/)
  await step(/^Continue$/)

  const box = doc.querySelector('input[placeholder^="pear://"]')
  assert.ok(box, 'the paste box is there for anybody without a camera')
  box.value = 'https://example.com/not-a-pairing-link'
  box.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))
  await step(/^Pair$/)

  // A full sentence, and the next thing to do - naming the button that shows the code.
  assert.match(text(), /That is not a PearCinema pairing code\./)
  assert.match(text(), /Pair a device/)
  assert.doesNotMatch(text(), /invalid PearCinema pairing link/, "the parser's words stay in the log")
})

test('A HOST THAT NEVER ANSWERS SAYS SO, WITHOUT PRETENDING TO KNOW WHY', async (t) => {
  // THE OTHER HALF OF THE WINDOWS FIREWALL BUG (PR #152). The host end learned to say it
  // cannot accept connections; the phone end still said nothing, so pointing a phone at a
  // blocked machine looked identical to a tap that did nothing, and the real cause took a
  // firewall audit to find rather than a glance.
  //
  // The message must NOT diagnose. peerloom-client cannot tell a firewall deny from a
  // machine that is switched off from a code that ran out - all three are a dial that
  // never opens - so the assertions below check that all three are named and none is
  // claimed.
  const { text, doc, click, win } = await open({
    'app.state': { ...defaultAnswers()['app.state'], active: null, hosts: [], paired: false },
    pair: () => { throw new Error('no answer from the host (unreachable, or not accepting pair requests)') }
  })
  t.after(() => win.close())

  const byText = (re) => [...doc.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()))
  const step = async (re) => {
    const b = byText(re)
    assert.ok(b, `a button matching ${re}`)
    click(b)
    await new Promise((r) => setTimeout(r, 80))
  }

  await step(/^Get started$/)
  const name = doc.querySelector('input')
  name.value = 'Tim'
  name.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))
  await step(/^Continue$/)
  await step(/^It's mine$/)
  await step(/^Continue$/)

  const box = doc.querySelector('input[placeholder^="pear://"]')
  box.value = 'pear://pearcinema/pair?k=whatever'
  box.dispatchEvent(new win.Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 40))
  await step(/^Pair$/)

  const said = text()
  assert.match(said, /No answer from that computer/, 'it says nobody picked up')
  assert.match(said, /asleep or switched off/, 'and names the machine being off')
  assert.match(said, /run out/, 'and names the code expiring')
  assert.match(said, /refusing connections/, 'and names the firewall case')
  assert.match(said, /Windows/, 'and points at where Windows explains itself')
  assert.doesNotMatch(said, /unreachable, or not accepting pair requests/, "the client's words stay in the log")
})

test('A LIBRARY THAT IS NOT ANSWERING SAYS SO, INSTEAD OF LOOKING EMPTY', async (t) => {
  // FOUND ON THE TCL (2026-08-21) pointing at a switched-off Windows VM. The merged shelf
  // leaves an unreachable host's films out, library.list answers with an empty page and no
  // error, so the screen drew a library with nothing in it - which reads as "this library
  // is empty", a lie about somebody's films. The titles were even there on the first paint
  // from the catalog cache, and vanished on the rebuild without a word.
  const state = {
    platform: 'android',
    deviceKey: 'dev-key',
    paired: true,
    active: { hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'The Cinema' },
    hosts: [
      { hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'The Cinema', online: true },
      { hostKey: 'host-2', libraryId: 'lib-2', libraryName: 'Windows VM', online: false, absent: true }
    ],
    merged: { on: true, ready: true, filter: '_all' },
    live: ['lib-1']
  }
  const { text, win } = await open({
    'app.state': state,
    'library.list': { items: [], total: 0, cursor: null }
  })
  t.after(() => win.close())

  const said = text()
  assert.match(said, /Windows VM cannot be reached right now/, 'it names the library')
  assert.match(said, /films are\s+not showing/, 'and says why the shelf is bare')
  assert.doesNotMatch(said, /The Cinema cannot be reached/, 'the library that IS answering is not accused')
})

test('AN UNREACHABLE LIBRARY IS ONLY MENTIONED WHILE IT IS BEING LOOKED AT', async (t) => {
  // The chip picks one library. Naming a DIFFERENT one that happens to be asleep is noise
  // on a screen that is showing exactly what it was asked for.
  const state = {
    platform: 'android',
    deviceKey: 'dev-key',
    paired: true,
    active: { hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'The Cinema' },
    hosts: [
      { hostKey: 'host-key', libraryId: 'lib-1', libraryName: 'The Cinema', online: true },
      { hostKey: 'host-2', libraryId: 'lib-2', libraryName: 'Windows VM', online: false, absent: true }
    ],
    merged: { on: true, ready: true, filter: 'lib-1' },
    live: ['lib-1']
  }
  const { text, win } = await open({ 'app.state': state })
  t.after(() => win.close())

  assert.doesNotMatch(text(), /Windows VM cannot be reached/, 'not while the chip is on the other library')
})

// --- the You tab, which had no coverage at all until its buttons changed ------

// What the worklet answers for a You tab with something in every list.
const YOU_ANSWERS = {
  'resume.list': {
    items: [
      { id: 'metropolis', type: 'movie', title: 'Metropolis', year: 1927, runtime: 9180, resume: { positionMs: 2820000 } },
      { id: 'nosferatu', type: 'movie', title: 'Nosferatu', year: 1922, runtime: 5820, resume: { positionMs: 600000 } }
    ]
  },
  'watched.list': { items: ['thirdman'] },
  'library.get': { id: 'thirdman', type: 'movie', title: 'The Third Man', year: 1949, runtime: 6240 },
  'request.list': { items: [] }
}

const VIEW_LABEL = { watched: 'Watched', requests: 'Requests', downloads: 'Downloads', manage: 'Manage library' }

async function openYou (t, view = 'continue', answers = {}) {
  const h = await open({ ...YOU_ANSWERS, ...answers })
  t.after(() => h.win.close())
  h.click(h.button(/^You$/))
  await h.settle(160)
  if (view !== 'continue') {
    h.click(h.labelled(VIEW_LABEL[view] || view))
    await h.settle(200)
  }
  return h
}

test('THE ROW BUTTONS IN You ARE MARKS, NOT SENTENCES', async (t) => {
  // Tim, 2026-08-20: use icons instead of text for the buttons in these lists. A row is
  // read at a glance and the same five words in every row is five words of noise per row;
  // the wordy version of each action is still one long-press away on the film itself.
  const h = await openYou(t, 'continue')
  assert.match(h.text(), /Metropolis/, 'the Continue list is on screen')

  // One mark for taking something off a list, and it says so to a screen reader.
  const off = h.labelled('Remove from Continue watching')
  assert.ok(off, 'every icon button here carries the words it replaced')
  assert.equal(off.textContent.trim(), '', 'the mark alone')
  assert.ok(off.querySelector('svg'), 'and it is a real icon rather than an empty button')

  // EMPTYING THE WHOLE LIST KEEPS ITS WORDS, and ONLY its words. It is not in a row and
  // it is the heavier act, so it is plain text with no mark beside it - the same bin
  // meaning two different sizes of act on one screen is what that would be (Tim,
  // 2026-08-21).
  const clear = h.button(/^Clear list$/)
  assert.ok(clear, 'the list-level action still says what it does')
  assert.equal(clear.querySelector('svg'), null, 'and says it without a mark')
})

test('answering somebody else\'s request is a tick and a cross', async (t) => {
  // The owner's view of the same tab. Two marks rather than "Added" and "Decline",
  // because they are a pair and the row above them already says what is being answered.
  const h = await openYou(t, 'manage', {
    'identity.get': { userName: 'Tim', deviceName: 'Pixel', libraryName: 'The Cinema', owner: true, belongsTo: 'Tim' },
    'request.all': { items: [{ id: 'r1', name: 'The Thing', kind: 'movie', status: 'pending', count: 1, refs: [] }] },
    'device.list': { items: [] }
  })
  assert.match(h.text(), /The Thing/)
  const yes = h.labelled('Mark "The Thing" as added')
  const no = h.labelled('Decline "The Thing"')
  assert.ok(yes && no, 'both answers say what they do, whatever they look like')
  assert.equal(yes.textContent.trim(), '')
  assert.equal(no.textContent.trim(), '')
  assert.ok(yes.querySelector('svg') && no.querySelector('svg'))
  // And pressing one answers with what it says.
  h.click(no)
  await h.settle(120)
  const resolved = h.called('request.resolve')
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].args.status, 'declined')
})

test('the same mark means the same thing in the Watched list', async (t) => {
  const h = await openYou(t, 'watched')
  assert.match(h.text(), /The Third Man/)
  const unmark = h.labelled('Mark as not watched')
  assert.ok(unmark, 'labelled for what it does, not for what it looks like')
  assert.equal(unmark.textContent.trim(), '')
  assert.ok(unmark.querySelector('svg'))
})

test('THE VERSION IN THE APP IS app.json\'s, not a literal somebody has to remember', () => {
  // PearTune nearly shipped an App Store build whose About screen said 0.1.0 for ever
  // (peartune DONE 2026-07-31): `APP_VERSION` was a literal in App.jsx and release.sh
  // rewrites app.json without touching the UI. PearCinema had the identical literal.
  //
  // It matters beyond About: the phone stamps its version into a bug report precisely so
  // the report says which build produced it, and a report that names the wrong build is
  // worse than one that names none.
  //
  // This reads the BUILT page, which is the thing the APK actually ships.
  const version = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')
  ).expo.version

  assert.ok(version, 'app.json declares a version')
  assert.ok(
    PAGE.includes(version),
    `the built phone UI does not carry app.json's version (${version}) - rebuild with npm run build:ui`
  )
  assert.ok(
    !PAGE.includes('0.0.0-dev'),
    'the built page fell back to the dev version, so the bundler never defined __APP_VERSION__'
  )
})

test('THE SHELL NOTICES A FILM PLAYING WITH NO SOUND TRACK, and the page retries it', () => {
  // Field report 2026-08-29. ExoPlayer plays the picture and selects no audio track for
  // a soundtrack it cannot decode, with no error to catch, so the shell asks the native
  // side what was selected and the page re-asks the host without that codec.
  const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')
  assert.match(shell, /audioSelection\(player\)/, 'the shell reads what ExoPlayer chose')
  assert.match(shell, /sel\.tracks === 0 \|\| sel\.selected/, 'a film with no audio track at all is not silent, it is silent by design')
  assert.match(shell, /addListener\('availableAudioTracksChange'/, 'and looks again when the track list changes')
  assert.match(shell, /__pearEvent\('player:silent'/, 'the page hears it as player:silent')
  assert.ok(PAGE.includes('player:silent'), 'the built page listens for it')
  assert.ok(PAGE.includes('deviceRefusedAudio'), 'and asks stream.url again with the audio refusal')
  assert.ok(PAGE.includes('This one plays without sound on this device, and the host cannot convert it.'))
})

test('THE TELEVISION PICKER NAMES A ROKU WAITING ON ITS CHANNEL, and says which channel', async (t) => {
  // A support email, 2026-08-29: a Roku on the network, nothing in the picker, no clue.
  // The dashboard had always said "install Media Assistant"; the phone now does too.
  const h = await open({
    'library.get': LIBRARY[0],
    'cast.list': { enabled: true, targets: [], active: [], needsChannel: [{ host: '10.0.0.7', name: 'Living Room', libraryId: 'lib-1' }] }
  })
  t.after(() => h.dom.window.close())
  h.win.__pearEvent('player:cast', { itemId: 'metropolis', title: 'Metropolis', positionMs: 0 })
  await h.settle(200)
  const text = h.text()
  assert.ok(text.includes('Found Living Room, but it has no Media Assistant channel yet.'), 'names the Roku and the channel')
  assert.ok(text.includes('Install the free Media Assistant channel from the Roku channel store'), 'and says where to get it')
  assert.ok(!text.includes('No TVs were found'), 'which is not the same as finding nothing')
})

test('THE APP TURNS SIDEWAYS, and a wide screen gets a wider page rather than a narrow column', () => {
  // Tim, 2026-08-30: landscape everywhere, not only in the player, and tablets. The
  // shell no longer locks portrait between films, the manifest says so, and the page
  // grows past 560px while keeping the tile size the person chose.
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'))
  assert.equal(app.expo.orientation, 'default', 'the manifest allows every orientation')
  assert.equal(app.expo.ios?.supportsTablet, true)
  const shell = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.tsx'), 'utf8')
  assert.ok(!shell.includes('OrientationLock.PORTRAIT_UP'), 'nothing locks portrait back')
  assert.match(shell, /paddingLeft: insets\.left, paddingRight: insets\.right/, 'the side insets keep the page out from under a sideways cutout')
  // The page is minified, so the rules are matched loosely on whitespace.
  assert.match(PAGE, /@media ?\(min-width: ?720px\)/, 'the built page carries the wide-screen rule')
  assert.match(PAGE, /\.app, ?\.dock, ?\.sheet ?\{ ?max-width: ?960px/, 'the column grows to 960px')
  assert.match(PAGE, /repeat\(auto-fill, ?minmax\(calc\(560px ?\/ ?var\(--cols, ?2\) ?- ?\.9rem\), ?1fr\)\)/, 'and the grid keeps the tile size, fitting as many as the width takes')
})
