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

const { RokuSpeakers, tag, attr, millis, stateFrom, MEDIA_PLAYER_CHANNEL } = require('../host/roku')
const { CastTargets, isDiscovered } = require('../host/cast-targets')

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
async function fakeRoku (t, { info = DEVICE_INFO, media = PLAYING } = {}) {
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

function speakersFor (t, roku, hosts = ['10.0.0.7']) {
  return new RokuSpeakers({
    discoverFn: async () => hosts.map((host) => ({ host })),
    request: roku.request
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
  // host/cast.js reads 'playing' and 'paused' by name, so a backend that answered Roku's
  // own words would be silently invisible to every session rule.
  assert.equal(stateFrom('<player state="play">'), 'playing')
  assert.equal(stateFrom('<player state="pause">'), 'paused')
  assert.equal(stateFrom('<player state="close">'), 'idle')
  assert.equal(stateFrom('<player>'), 'idle')
})

// --- the backend against a stand-in Roku ------------------------------------

test('a discovered Roku is named by what its owner called it', async (t) => {
  const roku = await fakeRoku(t)
  const s = speakersFor(t, roku)

  const list = await s.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'Living Room', 'the owner\'s own name beats the model')
  assert.equal(list[0].entityId, 'roku:10.0.0.7')
  assert.equal(list[0].deviceClass, 'tv')
  assert.equal(list[0].via, 'roku', 'and it says it was found rather than configured')
})

test('a Roku with no name of its own falls back to its model, never to an IP', async (t) => {
  const roku = await fakeRoku(t, { info: '<device-info><model-name>Roku Ultra</model-name></device-info>' })
  const s = speakersFor(t, roku)
  const list = await s.list()
  assert.equal(list[0].name, 'Roku Ultra')
})

test('a Roku that will not answer at all is still listed, by address', async (t) => {
  // A device that answers SSDP but not the info query is on the network and probably
  // castable. Dropping it would mean a television the person can see is missing from the
  // list with no explanation.
  const roku = await fakeRoku(t)
  const s = new RokuSpeakers({
    discoverFn: async () => [{ host: '10.0.0.9' }],
    request: async () => { throw new Error('refused') }
  })
  const list = await s.list()
  assert.equal(list.length, 1)
  assert.match(list[0].name, /10\.0\.0\.9/)
  assert.ok(roku)
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

  await s.play('roku:10.0.0.7', 'http://10.0.0.2:8752/v/tok123', { title: 'Nosferatu', format: 'mkv' })

  const launch = roku.seen.find((r) => r.url.startsWith(`/launch/${MEDIA_PLAYER_CHANNEL}`))
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

  await s.stop('roku:10.0.0.7')
  const stop = roku.seen.find((r) => r.url === '/keypress/Home')
  assert.ok(stop, 'nothing else ends a film on a Roku')
  assert.equal(stop.method, 'POST')
})

test('state comes back as position, duration and a stamp', async (t) => {
  const roku = await fakeRoku(t)
  const s = speakersFor(t, roku)
  await s.list()

  const state = await s.getState('roku:10.0.0.7')
  assert.equal(state.state, 'playing')
  assert.equal(state.positionMs, 63000)
  assert.equal(state.durationMs, 5820000)
  assert.ok(state.positionAt > 0, 'the cast session needs to know WHEN that position was true')
})

test('a television that has gone is dropped from the roster, not left as a dead button', async (t) => {
  const roku = await fakeRoku(t)
  let hosts = ['10.0.0.7', '10.0.0.8']
  const s = new RokuSpeakers({ discoverFn: async () => hosts.map((host) => ({ host })), request: roku.request })

  assert.equal((await s.list()).length, 2)

  hosts = ['10.0.0.7']
  await s.scan()
  const list = await s.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].entityId, 'roku:10.0.0.7')
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

test('both rosters arrive, and an id decides who is asked', async (t) => {
  const roku = await fakeRoku(t)
  const targets = new CastTargets({ configured: fakeHa(), discovered: speakersFor(t, roku) })

  const list = await targets.list()
  assert.equal(list.length, 2)
  assert.ok(list.some((x) => x.entityId === 'media_player.living_room'))
  assert.ok(list.some((x) => x.entityId === 'roku:10.0.0.7'))

  assert.equal(isDiscovered('roku:10.0.0.7'), true)
  assert.equal(isDiscovered('media_player.living_room'), false)

  await targets.play('roku:10.0.0.7', 'http://x/v/t', {})
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
  assert.equal(list[0].entityId, 'roku:10.0.0.7')
})

test('casting is available when either half can look', async (t) => {
  const roku = await fakeRoku(t)
  const discovered = speakersFor(t, roku)

  assert.equal(new CastTargets({ configured: fakeHa({ enabled: false }), discovered }).enabled, true)
  assert.equal(new CastTargets({ configured: fakeHa(), discovered: null }).enabled, true)
  assert.equal(new CastTargets({ configured: fakeHa({ enabled: false }), discovered: null }).enabled, false)
})

test('a television that is both configured and discovered is one television', async (t) => {
  // Otherwise an owner who runs Home Assistant AND owns a Roku sees it twice, and the
  // duplicate is the one they cannot hide.
  const roku = await fakeRoku(t)
  const ha = fakeHa({ list: async () => [{ ...HA_TARGET, entityId: 'media_player.roku_10_0_0_7', name: 'Roku 10.0.0.7' }] })
  const targets = new CastTargets({ configured: ha, discovered: speakersFor(t, roku) })

  const list = await targets.list()
  assert.equal(list.length, 1, 'the configured entry wins - it is the one that can be hidden and renamed')
  assert.equal(list[0].entityId, 'media_player.roku_10_0_0_7')
})
