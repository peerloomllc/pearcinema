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
  const { dom, doc, press, tile, settle, called, text } = await open({
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

  assert.equal(called('resume.get').length, 0, 'it never asks where the film was left')
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

  // The rest of the row is still the row.
  press(row.querySelector('.meta') || row)
  await settle(200)
  assert.ok(called('stream.url').length > 0, 'the rest of the row is still the row')
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

  // A press out there is answered here, and explicitly: Pause pauses. A toggle would
  // pause a film that was already playing whenever the two sides disagreed.
  h.win.__pearEvent('cast:control', { action: 'pause' })
  await h.settle(140)
  assert.equal(h.called('cast.pause').length, 1)
  assert.equal(h.called('cast.resume').length, 0)

  h.win.__pearEvent('cast:control', { action: 'back' })
  await h.settle(140)
  assert.equal(h.called('cast.seek').length, 1, 'and back thirty seconds is a skip on the host')
  assert.ok(h.called('cast.seek')[0].args.deltaMs < 0)

  // Stopping takes the remote down with it - a notification whose buttons answer to
  // nothing is worse than no notification.
  h.win.__pearEvent('cast:control', { action: 'stop' })
  await h.settle(160)
  assert.equal(h.called('cast.stop').length, 1)
  const hidden = h.called('shell.castRemote').filter((c) => c.args?.show === false)
  assert.ok(hidden.length >= 1, 'the remote was taken down')
})
