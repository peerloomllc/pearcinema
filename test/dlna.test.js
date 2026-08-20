// CASTING TO A TELEVISION THAT SPEAKS DLNA, tested against what a real one did.
//
// Every fixture in this file is a transcript. Tim's Samsung TU7000 was offered by Home
// Assistant, did nothing when a film was sent to it (HA's own play_media answered 500),
// and took the same film directly the moment it was asked in its own language - measured
// on his network 2026-08-20, including the two refusals that turned out to be the whole
// design.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DlnaSpeakers, describe: describeDevice, soap, stateFrom, seconds, clockOf
} = require('../host/dlna')

const CONTROL = 'http://192.168.50.216:9197/upnp/control/AVTransport1'

// The Samsung's own device description, trimmed to the shape that matters.
const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
  <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
  <friendlyName>Samsung TU7000 65 TV</friendlyName>
  <manufacturer>Samsung Electronics</manufacturer>
  <modelName>UN65TU7000FXZA</modelName>
  <UDN>uuid:0d1d1a70-1dd2-11b2-8f4a-9c8c6e0f0f0f</UDN>
  <serviceList>
    <service>
      <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
      <controlURL>/upnp/control/RenderingControl1</controlURL>
    </service>
    <service>
      <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
      <controlURL>/upnp/control/AVTransport1</controlURL>
    </service>
  </serviceList>
</device></root>`

// A Hue bridge answers the same multicast question on the same network. It is not a
// television and has no AVTransport.
const HUE = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
  <friendlyName>Philips hue</friendlyName><UDN>uuid:2f402f80-da50-11e1-9b23-0017880abcde</UDN>
  <serviceList><service><serviceType>urn:schemas-upnp-org:service:Dummy:1</serviceType>
  <controlURL>/dummy</controlURL></service></serviceList></device></root>`

const ok = (body) => ({ status: 200, body })
const fault = (code, why) => ({
  status: 500,
  body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>` +
    `<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>` +
    `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode>` +
    `<errorDescription>${why}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`
})

const transportInfo = (state) => ok(`<s:Envelope><s:Body><u:GetTransportInfoResponse>` +
  `<CurrentTransportState>${state}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>` +
  `</u:GetTransportInfoResponse></s:Body></s:Envelope>`)

const positionInfo = (rel, dur) => ok(`<s:Envelope><s:Body><u:GetPositionInfoResponse>` +
  `<Track>1</Track><TrackDuration>${dur}</TrackDuration><RelTime>${rel}</RelTime><AbsTime>${rel}</AbsTime>` +
  `</u:GetPositionInfoResponse></s:Body></s:Envelope>`)

// A television made of the answers above. `sent` is every action it was asked to perform,
// which is how a test asserts that pressing pause reached the set rather than only
// changing a colour.
function fakeTv ({ state = 'PLAYING', rel = '0:01:02', dur = '1:35:00', refuse = [] } = {}) {
  const sent = []
  const soapFn = async (control, action, args) => {
    sent.push({ control, action, args })
    if (refuse.includes(action)) {
      const e = new Error('Transition not available (701)')
      e.upnpCode = 701
      throw e
    }
    if (action === 'GetTransportInfo') return transportInfo(state).body
    if (action === 'GetPositionInfo') return positionInfo(rel, dur).body
    return ok('<s:Envelope><s:Body/></s:Envelope>').body
  }
  return { sent, soapFn }
}

function speakers ({ tv = fakeTv(), found = [{ location: 'http://192.168.50.216:9197/dmr', address: '192.168.50.216' }], describeFn = null } = {}) {
  return new DlnaSpeakers({
    discoverFn: async () => found,
    describeFn: describeFn || (async () => ({
      udn: '0d1d1a70-1dd2-11b2-8f4a-9c8c6e0f0f0f',
      name: 'Samsung TU7000 65 TV',
      model: 'UN65TU7000FXZA',
      controlUrl: CONTROL
    })),
    soapFn: tv.soapFn
  })
}

test('a renderer description yields a name and the AVTransport control url', async () => {
  const info = await describeDevice('http://192.168.50.216:9197/dmr', {
    request: async () => ok(DESCRIPTION)
  })
  assert.equal(info.name, 'Samsung TU7000 65 TV')
  assert.equal(info.udn, '0d1d1a70-1dd2-11b2-8f4a-9c8c6e0f0f0f', 'the uuid: prefix is not part of the id')
  // NOT THE FIRST controlURL IN THE FILE. RenderingControl is listed first and controls
  // the volume; sending SetAVTransportURI there is a command to the wrong service.
  assert.equal(info.controlUrl, CONTROL)
})

test('something that is not a television is not offered as one', async () => {
  // A Philips Hue bridge answers the same multicast question on Tim's network. It has no
  // AVTransport, which is the test that means something - a name-based one would be a
  // guess about every appliance ever made.
  const info = await describeDevice('http://192.168.50.185:80/description.xml', {
    request: async () => ok(HUE)
  })
  assert.equal(info, null)
})

test('a SOAP fault comes back as its reason, with the UPnP code kept', async () => {
  // 701 is "not in a state where that makes sense" and is a different thing from a
  // television that cannot do it at all - the distinction that cost an hour on the real
  // set, where pause was refused while it was plainly playing.
  await assert.rejects(
    () => soap(CONTROL, 'Pause', '<InstanceID>0</InstanceID>', { request: async () => fault(701, 'Transition not available') }),
    (e) => {
      assert.match(e.message, /Transition not available/)
      assert.equal(e.upnpCode, 701)
      return true
    })
})

test('THE FILM IS HANDED OVER IN ONE PIECE: set the uri, then play', async (t) => {
  const tv = fakeTv()
  const s = speakers({ tv })
  await s.scan()

  await s.play('dlna:0d1d1a70-1dd2-11b2-8f4a-9c8c6e0f0f0f', 'http://192.168.50.139:8752/v/tok', { title: 'Metropolis' })
  const actions = tv.sent.map((c) => c.action)
  // Stop first, because a renderer already showing something refuses a new URI on some
  // firmwares - and it is swallowed when there was nothing to stop.
  assert.deepEqual(actions, ['Stop', 'SetAVTransportURI', 'Play'])

  const set = tv.sent.find((c) => c.action === 'SetAVTransportURI')
  assert.match(set.args, /<CurrentURI>http:\/\/192\.168\.50\.139:8752\/v\/tok<\/CurrentURI>/)
  // THE FEATURE WORD RIDES WITH IT. `DLNA.ORG_OP=01` is the byte-seek flag, and without
  // it the same television answers 701 to every Seek.
  assert.match(set.args, /DLNA\.ORG_OP=01/)
  assert.match(set.args, /Metropolis/, 'the set shows the title while it loads')
  void t
})

test('A PLAYLIST IS HANDED OVER AS A PLAYLIST, which the specification says cannot work', async () => {
  // It does. The Samsung played an HLS VOD playlist and reported its position throughout
  // (2026-08-20) - and it has to, because the same set refuses a live progressive stream,
  // so segments are the only way a converted film reaches it.
  const tv = fakeTv()
  const s = speakers({ tv })
  await s.scan()
  await s.play('dlna:0d1d1a70-1dd2-11b2-8f4a-9c8c6e0f0f0f', 'http://x/index.m3u8', { format: 'hls' })
  const set = tv.sent.find((c) => c.action === 'SetAVTransportURI')
  assert.match(set.args, /application\/vnd\.apple\.mpegurl/, 'labelled for what it is')
})

test('where the film is, and how long it is, off the television itself', async () => {
  const tv = fakeTv({ state: 'PLAYING', rel: '0:01:02.500', dur: '1:35:00' })
  const s = speakers({ tv })
  await s.scan()

  const state = await s.getState('dlna:0d1d1a70-1dd2-11b2-8f4a-9c8c6e0f0f0f')
  assert.equal(state.state, 'playing')
  assert.equal(state.position, 62.5)
  assert.equal(state.duration, 5700)
  // The shape is Home Assistant's, because host/cast.js reads these field names directly
  // whichever backend answered.
  assert.ok(Date.parse(state.positionUpdatedAt) > 0)
  assert.equal(state.supportedFeatures, 2, 'SEEK, which a Roku cannot answer')
})

test('pause, resume, seek and stop each reach the television', async () => {
  const tv = fakeTv()
  const s = speakers({ tv })
  await s.scan()
  const id = 'dlna:0d1d1a70-1dd2-11b2-8f4a-9c8c6e0f0f0f'

  await s.pause(id)
  await s.resume(id)
  await s.seek(id, 2725)
  await s.stop(id)

  const actions = tv.sent.map((c) => c.action)
  assert.deepEqual(actions, ['Pause', 'Play', 'Seek', 'Stop'])
  // A SEEK IS A TIME, IN THE TELEVISION'S OWN NOTATION. It answers by fetching a different
  // byte range of the same file, which is why a DLNA set's own clock stays the film's
  // where a Roku's has to be reasoned about.
  assert.match(tv.sent[2].args, /<Unit>REL_TIME<\/Unit><Target>0:45:25<\/Target>/)
})

test('a television nobody has seen this session is refused with something readable', async () => {
  const s = speakers({ found: [] })
  await s.scan()
  await assert.rejects(
    () => s.play('dlna:never-met', 'http://x/y.mp4'),
    /not a DLNA target/)
})

test('the clock in both directions', () => {
  assert.equal(seconds('0:01:02.500'), 62.5)
  assert.equal(seconds('00:00:00'), 0)
  assert.equal(seconds('NOT_IMPLEMENTED'), null, 'renderers answer this for a track with no duration')
  assert.equal(clockOf(2725), '0:45:25')
  assert.equal(clockOf(-5), '0:00:00')
})

test('the four states, in our words', () => {
  assert.equal(stateFrom('PLAYING'), 'playing')
  assert.equal(stateFrom('PAUSED_PLAYBACK'), 'paused')
  assert.equal(stateFrom('TRANSITIONING'), 'buffering')
  assert.equal(stateFrom('STOPPED'), 'idle')
  assert.equal(stateFrom('NO_MEDIA_PRESENT'), 'idle')
})
