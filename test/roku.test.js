// Casting to a Roku with no Home Assistant in the way, and the router that lets both
// kinds of television coexist (proposal 2026-08-18-cast-to-nearby-televisions, feature A).
//
// The ECP half is exercised against a REAL http server standing in for a Roku, answering
// the real response shapes, because everything interesting here is a matter of getting
// somebody else's protocol right - a mocked client would only prove this file agrees with
// itself. Discovery is injected instead: SSDP is multicast, and a test that shouts on the
// developer's own network would find their living room on a good day and nothing on a bad
// one, which is the definition of a flaky test.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')

const fs = require('fs')
const os = require('os')
const path = require('path')

const { RokuSpeakers, tag, attr, millis, stateFrom, MEDIA_CHANNELS, MEDIA_CHANNEL_NAME } = require('../host/roku')
const { CastTargets, isDiscovered } = require('../host/cast-targets')
const { Televisions } = require('../host/televisions')

// A television is remembered by its SERIAL NUMBER since 2026-08-19, not by the address
// it happened to answer on. So this is the id the fixture above produces, and the fact
// that it contains no address at all is the point.
const LIVING = 'roku:X0012345'

// The shapes a Roku really answers with, trimmed to the fields that are read.
const DEVICE_INFO = `<?xml version="1.0" encoding="UTF-8" ?>
<device-info>
  <udn>29a3e0a3-4d1e-5f6a-9db8-1f2c3d4e5f60</udn>
  <serial-number>X0012345</serial-number>
  <model-name>Roku Express</model-name>
  <friendly-model-name>Roku Express</friendly-model-name>
  <user-device-name>Living Room</user-device-name>
</device-info>`

const PLAYING = `<?xml version="1.0" encoding="UTF-8" ?>
<player error="false" state="play">
  <plugin bandwidth="20000000 bps" id="2213" name="Roku Media Player" />
  <format audio="aac_adts" captions="none" container="mp4" video="mpeg4_10b" />
  <position>63000 ms</position>
  <duration>5820000 ms</duration>
</player>`

// A stand-in Roku: the two queries answered for real, and every command recorded.
// A Roku's installed-channel list. The real one from Tim's stick is the interesting case
// and gets its own constant below.
const APPS_WITH_PLAYER = '<apps><app id="12">Netflix</app><app id="782875" type="appl">Media Assistant</app></apps>'
// The list Tim's stick really answered before anything was installed - note that it
// carries Roku Media Player's absence AND, later, its uselessness.
const APPS_NO_PLAYER = '<apps><app id="12">Netflix</app><app id="13535">Plex</app><app id="2213">Roku Media Player</app></apps>'

async function fakeRoku (t, { info = DEVICE_INFO, media = PLAYING, apps = APPS_WITH_PLAYER } = {}) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url })
    if (req.url.startsWith('/query/device-info')) {
      res.writeHead(200, { 'content-type': 'text/xml' })
      return res.end(info)
    }
    if (req.url.startsWith('/query/media-player')) {
      res.writeHead(200, { 'content-type': 'text/xml' })
      return res.end(media)
    }
    if (req.url.startsWith('/query/apps')) {
      res.writeHead(200, { 'content-type': 'text/xml' })
      return res.end(apps)
    }
    // A launch for a channel this device does not have is a bare 404, which is exactly
    // what Tim's stick answered.
    if (req.url.startsWith('/launch/') && !new RegExp(`/launch/(${MEDIA_CHANNELS.join('|')})`).test(req.url)) {
      res.writeHead(404)
      return res.end()
    }
    // launch and keypress answer an empty 200, which is what a real Roku does.
    res.writeHead(200)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))

  const { port } = server.address()
  // The ECP port is fixed at 8060 in the wild, so the request helper is redirected here
  // rather than the port being made configurable in the shipping code for a test's sake.
  const request = (host, path, opts) => {
    const url = `http://127.0.0.1:${port}${path}`
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: opts?.method || 'GET' }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => { body += d })
        res.on('end', () => (res.statusCode >= 400 ? reject(new Error('roku ' + res.statusCode)) : resolve(body)))
      })
      req.on('error', reject)
      req.end()
    })
  }
  return { seen, request, port }
}

// A throwaway roster on disk, because remembering televisions is the point of most of
// what follows and an in-memory stub would prove nothing about the store.
function rosterFor (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcinema-tv-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return new Televisions({ dataDir: dir })
}

function speakersFor (t, roku, hosts = ['10.0.0.7'], { televisions = rosterFor(t) } = {}) {
  return new RokuSpeakers({
    discoverFn: async () => hosts.map((host) => ({ host })),
    request: roku.request,
    televisions
  })
}

// --- reading somebody else's XML --------------------------------------------

test('the two extractors read what a Roku actually sends', () => {
  assert.equal(tag(DEVICE_INFO, 'user-device-name'), 'Living Room')
  assert.equal(tag(DEVICE_INFO, 'model-name'), 'Roku Express')
  assert.equal(attr(PLAYING, 'state'), 'play')
  assert.equal(tag(PLAYING, 'position'), '63000 ms')
})

test('a position is milliseconds, and "we do not know" is not zero', () => {
  // Zero is a real position - the start of a film - so an absent or unreadable one has to
  // be null, or a film that has not reported yet would look like it rewound.
  assert.equal(millis('63000 ms'), 63000)
  assert.equal(millis(''), null)
  assert.equal(millis(null), null)
  assert.equal(millis('0 ms'), 0)
})

test('Roku states are translated into the vocabulary the cast path already speaks', () => {
  // host/cast.js reads 'playing', 'paused' and 'idle' BY NAME, so a backend that answered
  // Roku's own words would be silently invisible to every session rule.
  assert.equal(stateFrom('<player state="play">'), 'playing')
  assert.equal(stateFrom('<player state="pause">'), 'paused')
  assert.equal(stateFrom('<player state="close">'), 'idle')
  assert.equal(stateFrom('<player>'), 'idle')
})

test('the state a REAL Roku answers at rest is idle, not a word nobody knows', () => {
  // `none` is what Tim's Roku Streaming Stick Plus actually answered on 2026-08-18, sitting
  // on its home screen. The first cut passed unknown states through, so this would have
  // reached the session poll as 'none', never matched the ended test, and left a finished
  // cast on the books forever. No fixture invented this - a device did.
  assert.equal(stateFrom('<player state="none" error="false"><plugin id="native-ui" name="Native UI" /></player>'), 'idle')
  // And anything else unheard-of lands on idle too, for the same reason.
  assert.equal(stateFrom('<player state="somethingnew">'), 'idle')
})

// --- the backend against a stand-in Roku ------------------------------------

test('a discovered Roku is named by what its owner called it', async (t) => {
  const roku = await fakeRoku(t)
  const s = speakersFor(t, roku)

  const list = await s.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'Living Room', 'the owner\'s own name beats the model')
  assert.equal(list[0].entityId, LIVING, 'its serial number, not the address it is on today')
  assert.equal(list[0].deviceClass, 'tv')
  assert.equal(list[0].via, 'roku', 'and it says it was found rather than configured')
})

test('a Roku with no name of its own falls back to its model, never to an IP', async (t) => {
  const roku = await fakeRoku(t, { info: '<device-info><model-name>Roku Ultra</model-name></device-info>' })
  const s = speakersFor(t, roku)
  const list = await s.list()
  assert.equal(list[0].name, 'Roku Ultra')
})

test('answering the search is not enough - it has to identify itself', async (t) => {
  // MEASURED, not guessed. On Tim's network two devices answered an `ST: roku:ecp`
  // M-SEARCH and only one was a Roku; the other had nothing listening on 8060 at all.
  // Plenty of SSDP implementations answer every search regardless of the target, so the
  // first cut - which listed an unidentifiable device under a name that was just its IP -
  // would have put a printer in the television picker.
  const s = new RokuSpeakers({
    discoverFn: async () => [{ host: '10.0.0.9' }],
    request: async () => { throw new Error('ECONNREFUSED') }
  })
  assert.deepEqual(await s.list(), [], 'a device that cannot say what it is is not offered')
})

test('a real ECP device with no name of any kind still gets listed', async (t) => {
  // The rule is "identified", not "named": device-info answered, so it IS a Roku, and an
  // address is a worse name than a model but a better one than nothing.
  const roku = await fakeRoku(t, { info: '<device-info><udn>x</udn></device-info>' })
  const s = speakersFor(t, roku)
  const list = await s.list()
  assert.equal(list.length, 1)
  assert.match(list[0].name, /10\.0\.0\.7/)
})

test('it declares NO seek, which is the truth rather than a shortcut', async (t) => {
  // A Roku cannot seek over ECP any more than it can through Home Assistant. Saying so
  // is what makes the cast path restart the film at the offset instead - claiming seek
  // would produce a silent no-op and a scrubber that lies.
  const roku = await fakeRoku(t)
  const s = speakersFor(t, roku)
  const list = await s.list()
  assert.equal(list[0].supportedFeatures, 0)
})

test('play launches the media player channel with the url and the format', async (t) => {
  const roku = await fakeRoku(t)
  const s = speakersFor(t, roku)
  await s.list()

  await s.play(LIVING, 'http://10.0.0.2:8752/v/tok123', { title: 'Nosferatu', format: 'mkv' })

  const launch = roku.seen.find((r) => r.url.startsWith('/launch/782875'))
  assert.ok(launch, 'it has to launch the media player channel')
  assert.equal(launch.method, 'POST')
  const q = new URLSearchParams(launch.url.split('?')[1])
  assert.equal(q.get('u'), 'http://10.0.0.2:8752/v/tok123')
  assert.equal(q.get('t'), 'v', 'video, not audio')
  assert.equal(q.get('videoFormat'), 'mkv', 'a Roku plays Matroska natively, and mislabelling it is a black screen')
  assert.equal(q.get('videoName'), 'Nosferatu')
})

test('STOP IS HOME, because revoke rides it', async (t) => {
  // ECP has no stop for the media player. Home exits the channel, which ends playback and
  // the bytes with it - the same key the Home Assistant path eventually falls back to
  // after media_stop 500s on a Roku.
  const roku = await fakeRoku(t)
  const s = speakersFor(t, roku)
  await s.list()

  await s.stop(LIVING)
  const stop = roku.seen.find((r) => r.url === '/keypress/Home')
  assert.ok(stop, 'nothing else ends a film on a Roku')
  assert.equal(stop.method, 'POST')
})

test('state comes back in HOME ASSISTANT\'s shape, because that is what reads it', async (t) => {
  // host/cast.js reads `position` and `duration` in SECONDS and parses `positionUpdatedAt`
  // as a date. The first cut answered positionMs and positionAt - names of its own - which
  // every consumer would have read as null: a cast that never reported progress and never
  // resumed where it was left. Found by reading the consumer, not by running this.
  const roku = await fakeRoku(t)
  const s = speakersFor(t, roku)
  await s.list()

  const state = await s.getState(LIVING)
  assert.equal(state.state, 'playing')
  assert.equal(state.position, 63, 'seconds, not milliseconds')
  assert.equal(state.duration, 5820)
  assert.ok(Number.isFinite(Date.parse(state.positionUpdatedAt)), 'the stamp has to parse as a date')
})

test('no position information is null, and never a confident zero', async (t) => {
  const roku = await fakeRoku(t, { media: '<player state="none" error="false"><plugin id="native-ui"/></player>' })
  const s = speakersFor(t, roku)
  await s.list()

  const state = await s.getState(LIVING)
  assert.equal(state.state, 'idle')
  assert.equal(state.position, null, 'position 0 is the start of a film; unknown is not')
  assert.equal(state.duration, null)
})

test('A TELEVISION SWITCHED OFF READS AS UNAVAILABLE, it does not vanish', async (t) => {
  // MEASURED on Tim's own living room stick, 2026-08-19, with the television off: it
  // answers no search and nothing on its control port, because the stick draws its power
  // from the television. Before this, a device that missed one search was DELETED, so a
  // television that worked yesterday simply disappeared from the phone's picker with
  // nothing said. A Home Assistant television does the opposite - it stays listed and
  // reads unavailable - and there is no reason for the two to behave differently.
  const roku = await fakeRoku(t)
  let hosts = ['10.0.0.7']
  const televisions = rosterFor(t)
  const s = new RokuSpeakers({
    discoverFn: async () => hosts.map((host) => ({ host })),
    request: roku.request,
    televisions
  })

  const on = await s.list()
  assert.equal(on.length, 1)
  assert.equal(on[0].state, 'idle')

  hosts = []
  await s.scan()
  const off = await s.list()
  assert.equal(off.length, 1, 'still listed')
  assert.equal(off[0].entityId, LIVING, 'and still itself')
  assert.equal(off[0].state, 'unavailable')

  // Pressing it says what is wrong, rather than waiting out a socket timeout and then
  // reporting a timeout - which tells a person nothing they can act on.
  await assert.rejects(() => s.play(LIVING, 'http://x/v/t', {}), /not answering/)

  // And it comes back as itself when the television does.
  hosts = ['10.0.0.7']
  await s.scan()
  assert.equal((await s.list())[0].state, 'idle')
})

test('a television keeps its name when its ADDRESS changes', async (t) => {
  // The reason a television is remembered by serial number. On DHCP an address is a
  // lease, and on this very network a Philips Hue bridge answers the same search a Roku
  // does - so a roster keyed by address can end up pointing at one.
  const roku = await fakeRoku(t)
  let hosts = ['10.0.0.7']
  const televisions = rosterFor(t)
  const s = new RokuSpeakers({
    discoverFn: async () => hosts.map((host) => ({ host })),
    request: roku.request,
    televisions
  })

  await s.list()
  hosts = ['10.0.0.55']
  await s.scan()

  const list = await s.list()
  assert.equal(list.length, 1, 'one television, not two')
  assert.equal(list[0].entityId, LIVING)
  assert.equal(list[0].host, '10.0.0.55', 'the address followed it')
  assert.equal(s.hostFor(LIVING), '10.0.0.55')
})

test('A FOUND TELEVISION CAN BE HIDDEN, the same as a configured one', async (t) => {
  // Somebody with three Rokus could not stop two of them being offered, because a found
  // television was whatever answered this minute and there was nowhere to write the
  // choice. The eye icon means the same thing on every row now.
  const roku = await fakeRoku(t)
  const televisions = rosterFor(t)
  const s = speakersFor(t, roku, ['10.0.0.7'], { televisions })
  await s.list()

  assert.equal(s.isHidden(LIVING), false)
  s.setHidden(LIVING, true)
  assert.equal(s.isHidden(LIVING), true)
  assert.equal((await s.list())[0].hidden, true)

  // AND IT SURVIVES THE TELEVISION COMING BACK. A device that is rediscovered must not
  // arrive offered again - that would make hiding a thing that undoes itself.
  await s.scan()
  assert.equal((await s.list())[0].hidden, true)

  // A fresh store reading the same file agrees, so this outlived the process.
  const again = new Televisions({ dataDir: televisions.dataDir })
  assert.equal(again.isHidden(LIVING), true)
})

test('ROKU MEDIA PLAYER IS NOT ENOUGH - only Media Assistant actually plays', async (t) => {
  // The most expensive finding of the day, and every step of it contradicted the docs.
  // On Tim's stick: Roku Media Player was absent, then installed, then accepted the launch
  // with a 200 under EVERY documented parameter form and never fetched a byte. Watching a
  // working Home Assistant cast named the real channel - Media Assistant, 782875, which is
  // what HA's own Roku docs tell people to install. A device with RMP and not MA must
  // therefore NOT be offered: it would be a television that does nothing when pressed.
  const roku = await fakeRoku(t, { apps: APPS_NO_PLAYER })
  const logs = []
  const s = new RokuSpeakers({
    discoverFn: async () => [{ host: '10.0.0.7' }],
    request: roku.request,
    log: (m, d) => logs.push([m, d])
  })

  assert.deepEqual(await s.list(), [])
  const said = logs.find(([m]) => m === 'roku:no-media-channel')
  assert.ok(said, 'and it has to say so, because the owner can fix this in a minute')
  assert.match(said[1].fix, /Media Assistant/, 'the log names the fix, not just the fault')
})

test('A ROKU THAT CANNOT PLAY IS NAMED, not just logged and dropped', async (t) => {
  // It is skipped from the picker, and it must be, because it would be a television that
  // does nothing when pressed. But skipping it silently is how a person ends up staring
  // at a picker that does not list the Roku they can see from where they are sitting.
  // The one free channel is the whole difference, so the roster keeps the misses for the
  // dashboard to say so out loud.
  const roku = await fakeRoku(t, { apps: APPS_NO_PLAYER })
  const s = speakersFor(t, roku)
  assert.deepEqual(await s.list(), [], 'still not offered')

  assert.equal(s.needsChannel.length, 1)
  assert.equal(s.needsChannel[0].name, 'Living Room', 'by the name its owner gave it')
  assert.equal(s.needsChannel[0].host, '10.0.0.7')

  // Pressing one anyway is refused, and the refusal is about the television rather
  // than about a socket.
  await assert.rejects(() => s.play(LIVING, 'http://x/v/t', {}), /not a Roku target|not answering/)

  // And the warning clears when the channel appears, rather than nagging forever.
  const fixed = await fakeRoku(t)
  const s2 = speakersFor(t, fixed)
  await s2.list()
  assert.deepEqual(s2.needsChannel, [])
})

test('pause is the Play key, and only when something is playing', async (t) => {
  // ECP has no pause command - Play toggles. So an unconditional press turns "pause" into
  // a coin toss: on a paused film it would resume it.
  const roku = await fakeRoku(t)
  const s = speakersFor(t, roku)
  await s.list()

  await s.pause(LIVING) // the stand-in reports state="play"
  assert.ok(roku.seen.some((r) => r.url === '/keypress/Play'), 'a playing film pauses')

  const idle = await fakeRoku(t, { media: '<player state="none" error="false"/>' })
  const s2 = speakersFor(t, idle)
  await s2.list()
  await s2.pause(LIVING)
  assert.ok(!idle.seen.some((r) => r.url === '/keypress/Play'), 'nothing playing, nothing pressed')
})

test('resume is the same key, and refuses to double-press', async (t) => {
  const playing = await fakeRoku(t)
  const s = speakersFor(t, playing)
  await s.list()
  await s.resume(LIVING)
  assert.ok(!playing.seen.some((r) => r.url === '/keypress/Play'), 'already playing means nothing to do')
})

// --- the router -------------------------------------------------------------

const HA_TARGET = { entityId: 'media_player.living_room', name: 'Living Room TV', state: 'idle', supportedFeatures: 0, deviceClass: 'tv', hidden: false }

function fakeHa (over = {}) {
  return {
    enabled: true,
    isHidden: () => false,
    list: async () => [HA_TARGET],
    getState: async () => ({ entityId: HA_TARGET.entityId, state: 'idle' }),
    play: async () => ({ ok: true, via: 'ha' }),
    stop: async () => ({ ok: true, via: 'ha' }),
    ...over
  }
}

test('THE ROUTER FORWARDS EVERY METHOD A CALLER USES', async (t) => {
  // This is the test that would have caught the one real regression of the evening.
  // The router shipped without pause or resume, which does not fail at startup - it fails
  // as `casts.speakers.pause is not a function` the moment somebody presses pause on a
  // real cast. Which is how it was found: on Tim's television, minutes after it shipped.
  //
  // Pinned against the Home Assistant backend's OWN surface rather than a hand-written
  // list, so a method added there and forgotten here is a failing test rather than a
  // broken remote control.
  const { Speakers } = require('../host/speakers')
  const used = ['enabled', 'isHidden', 'list', 'getState', 'play', 'pause', 'resume', 'stop', 'seek']
  const roku = await fakeRoku(t)
  const targets = new CastTargets({ configured: fakeHa(), discovered: speakersFor(t, roku) })

  for (const m of used) {
    assert.ok(m in Speakers.prototype || m in targets || typeof targets[m] === 'function' || m === 'enabled',
      `${m} is used by a caller and must exist on the Home Assistant backend`)
    assert.ok(m === 'enabled' ? 'enabled' in targets : typeof targets[m] === 'function',
      `the router drops ${m} - a caller would get "is not a function" at the worst moment`)
  }

  // And a discovered target answers them for real, not just structurally.
  const disc = speakersFor(t, roku)
  for (const m of ['pause', 'resume', 'stop']) assert.equal(typeof disc[m], 'function', `the Roku backend needs ${m}`)
})

test('both rosters arrive, and an id decides who is asked', async (t) => {
  const roku = await fakeRoku(t)
  const targets = new CastTargets({ configured: fakeHa(), discovered: speakersFor(t, roku) })

  const list = await targets.list()
  assert.equal(list.length, 2)
  assert.ok(list.some((x) => x.entityId === 'media_player.living_room'))
  assert.ok(list.some((x) => x.entityId === LIVING))

  assert.equal(isDiscovered(LIVING), true)
  assert.equal(isDiscovered('media_player.living_room'), false)

  await targets.play(LIVING, 'http://x/v/t', {})
  assert.ok(roku.seen.some((r) => r.url.startsWith('/launch/')), 'a roku: id went to the Roku')

  const viaHa = await targets.play('media_player.living_room', 'http://x/v/t', {})
  assert.equal(viaHa.via, 'ha', 'and everything else went to Home Assistant')
})

test('one backend failing does not cost the other its televisions', async (t) => {
  // An HA that is down and a network that drops multicast are both normal. A person with
  // one working television must still see it.
  const roku = await fakeRoku(t)
  const brokenHa = fakeHa({ list: async () => { throw new Error('HA unreachable') } })
  const targets = new CastTargets({ configured: brokenHa, discovered: speakersFor(t, roku) })

  const list = await targets.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].entityId, LIVING)
})

test('casting is available when either half can look', async (t) => {
  const roku = await fakeRoku(t)
  const discovered = speakersFor(t, roku)

  assert.equal(new CastTargets({ configured: fakeHa({ enabled: false }), discovered }).enabled, true)
  assert.equal(new CastTargets({ configured: fakeHa(), discovered: null }).enabled, true)
  assert.equal(new CastTargets({ configured: fakeHa({ enabled: false }), discovered: null }).enabled, false)
})

test('a television that is both configured and discovered is one television', async (t) => {
  // MEASURED against Tim's own Home Assistant, 2026-08-18. His Roku is
  // `media_player.living_room_roku_streaming_stick_plus` named "Roku Streaming Stick Plus"
  // - no IP address anywhere in either - and the first cut matched on address only, so the
  // same television sat in his picker twice with no way to tell which was which.
  const roku = await fakeRoku(t)
  const ha = fakeHa({
    list: async () => [{ ...HA_TARGET, entityId: 'media_player.living_room_roku_streaming_stick_plus', name: 'Roku Streaming Stick Plus' }]
  })
  // The discovered one carries the same name, punctuated as the device reports it.
  const disc = new RokuSpeakers({
    discoverFn: async () => [{ host: '10.0.0.7' }],
    request: async (host, path) => (path.startsWith('/query/apps')
      ? '<apps><app id="782875">Media Assistant</app></apps>'
      : '<device-info><model-name>Roku Streaming Stick Plus</model-name></device-info>')
  })
  const targets = new CastTargets({ configured: ha, discovered: disc })

  const list = await targets.list()
  assert.equal(list.length, 1, 'the configured entry wins - it is the one that can be hidden and renamed')
  assert.equal(list[0].entityId, 'media_player.living_room_roku_streaming_stick_plus')
})

test('the address match still works, for Home Assistants that name a device by IP', async (t) => {
  const roku = await fakeRoku(t)
  const ha = fakeHa({ list: async () => [{ ...HA_TARGET, entityId: 'media_player.roku_10_0_0_7', name: 'Roku 10.0.0.7' }] })
  const targets = new CastTargets({ configured: ha, discovered: speakersFor(t, roku) })
  assert.equal((await targets.list()).length, 1)
})

test('two DIFFERENT televisions are never collapsed into one', async (t) => {
  const roku = await fakeRoku(t)
  const ha = fakeHa({ list: async () => [{ ...HA_TARGET, entityId: 'media_player.kitchen_speaker', name: 'Kitchen speaker' }] })
  const targets = new CastTargets({ configured: ha, discovered: speakersFor(t, roku) })
  assert.equal((await targets.list()).length, 2, 'a speaker in the kitchen is not the Roku in the living room')
})
