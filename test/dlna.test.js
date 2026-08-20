// CASTING TO A TELEVISION THAT SPEAKS DLNA, tested against what a real one did.
//
// Every fixture in this file is a transcript. Tim's Samsung TU7000 was offered by Home
// Assistant, did nothing when a film was sent to it (HA's own play_media answered 500),
// and took the same film directly the moment it was asked in its own language - measured
// on his network 2026-08-20, including the two refusals that turned out to be the whole
// design.

const test = require('node:test')
const assert = require('node:assert/strict')

const fs = require('fs')
const path = require('path')

const {
  DlnaSpeakers, describe: describeDevice, soap, stateFrom, seconds, clockOf, sinkProfile, protocolInfo
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
    <service>
      <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
      <controlURL>/upnp/control/ConnectionManager1</controlURL>
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
  // AND THE SERVICE THAT ANSWERS WHAT IT ACCEPTS, which is a different one again.
  assert.equal(info.connectionUrl, 'http://192.168.50.216:9197/upnp/control/ConnectionManager1')
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


// --- what the television says it accepts -------------------------------------
//
// Tim, 2026-08-20, reading the DLNA work: "would these changes to Roku and Samsung
// casting work for anyone else who installs PearCinema and discovers those devices on
// their network or is this custom to our setup?" The mechanism was always generic; the
// CAPABILITY PROFILE was one Samsung's, inherited by every DLNA television in the
// world. This is the standard call that was not being made.

// The real thing: 28 KB of Sink list read off the TU7000 on Tim's network,
// 2026-08-20, by asking it GetProtocolInfo. 292 entries, 264 DLNA profiles.
const SAMSUNG_SINK = fs.readFileSync(path.join(__dirname, 'fixtures', 'samsung-tu7000-sink.txt'), 'utf8')

test('THE REAL TELEVISION\'S OWN ANSWER, parsed into what it will take', async () => {
  const profile = sinkProfile(SAMSUNG_SINK)

  // Containers: the hand-measured profile had mp4, mov and Matroska, and the set
  // itself says the same three - in its own spelling, `video/x-mkv` - plus webm.
  assert.deepEqual(profile.containers.sort(), ['matroska', 'mkv', 'mov', 'mp4', 'webm'])

  // AND HEVC, which the hand-measured profile does not offer it. That is not a
  // guess about a model number: the set publishes `video/hevc`, and 64% of this
  // library is HEVC television that has been converted for it ever since.
  assert.deepEqual(profile.videoCodecs.sort(), ['h264', 'hevc'])

  // A PLAYLIST IT NEVER MENTIONS AND DEMONSTRABLY PLAYS. This is why the answer is
  // only ever used to widen: read as a complete statement it would have taken HLS
  // away from the one television measured playing it.
  assert.equal(profile.playlist, false)

  // AND THE SOUND. It publishes AAC_MULT5 in two containers and AC3 both as a raw
  // Dolby mime type and inside its video profiles, which is the set saying in its own
  // words that it takes 5.1 - and every film in the house was being mixed down to two
  // channels for it until it was asked.
  assert.deepEqual(profile.audioCodecs.sort(), ['ac3'])
  assert.equal(profile.maxAudioChannels, 6)
})

test('the letters DTS inside AAC_ADTS are not a claim of DTS', async () => {
  // A LIVE TRAP, not a hypothetical: `AAC_ADTS` is on the TU7000's own list five times
  // over, and a bare /DTS/ reads 5.1 DTS support off a stereo AAC profile - which is a
  // silent television, the one failure this whole feature is careful about.
  const profile = sinkProfile('http-get:*:audio/vnd.dlna.adts:DLNA.ORG_PN=AAC_ADTS,http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_HD_AAC')
  assert.deepEqual(profile.audioCodecs, [])
  assert.equal(profile.maxAudioChannels, 0, 'stereo AAC says nothing about extra speakers')

  // A set that means it is believed, in either spelling.
  assert.deepEqual(sinkProfile('http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=AVC_TS_HD_DTS_T').audioCodecs, ['dts'])
  assert.deepEqual(sinkProfile('http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_HP_HD_EAC3').audioCodecs, ['eac3'])
})

test('7.1 is claimed only where a film could actually be encoded that way', async () => {
  // The TU7000 publishes MULT7 for AAC LTP and nothing else. Long Term Prediction is a
  // profile almost nothing is encoded in, so a set offering 7.1 ONLY there has said
  // nothing about the 7.1 a real film carries - and asking for eight channels it cannot
  // place is the silent-television failure again.
  const ltp = sinkProfile('http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_SD_AAC_LTP_MULT7')
  assert.equal(ltp.maxAudioChannels, 0)

  // Said plainly, it is believed.
  assert.equal(sinkProfile('http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_HD_AAC_MULT7').maxAudioChannels, 8)
  assert.equal(sinkProfile('http-get:*:audio/mp4:DLNA.ORG_PN=AAC_MULT5_ISO').maxAudioChannels, 6)

  // And Dolby is 5.1 by construction, whatever else the entry says.
  assert.equal(sinkProfile('http-get:*:audio/vnd.dolby.dd-raw:*').maxAudioChannels, 6)
})

test('a device that says nothing usable keeps the profile it had', async () => {
  assert.equal(sinkProfile(''), null)
  assert.equal(sinkProfile(null), null)
  // Every entry unusable: no http-get, and nothing we know how to open.
  assert.equal(sinkProfile('rtsp-rtp-udp:*:video/mp4:*,http-get:*:audio/mpeg:*,http-get:*:image/jpeg:*'), null)
})

test('a renderer that DOES advertise a playlist is believed', async () => {
  const profile = sinkProfile('http-get:*:video/mp4:*,http-get:*:application/vnd.apple.mpegurl:*')
  assert.equal(profile.playlist, true)
  assert.deepEqual(profile.containers, ['mp4'])
})

test('codecs are read from the profile names as well as the mime types', async () => {
  // A certified device names what it opens in DLNA's own vocabulary rather than by
  // mime type: AVC_MP4_MP_HD_AAC is h.264 in mp4, HEVC_TS_MAIN is HEVC.
  const profile = sinkProfile([
    'http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_HD_720p_AAC',
    'http-get:*:video/vnd.dlna.mpeg-tts:DLNA.ORG_PN=HEVC_TS_MAIN_AAC'
  ].join(','))
  assert.deepEqual(profile.videoCodecs.sort(), ['h264', 'hevc'])
})

test('the television is ASKED at scan time, and the answer is remembered', async (t) => {
  const asked = []
  const s = speakers({
    tv: fakeTv(),
    describeFn: async () => ({
      udn: 'udn-1', name: 'A Television', model: 'X', controlUrl: CONTROL,
      connectionUrl: 'http://192.168.50.216:9197/upnp/control/ConnectionManager1'
    })
  })
  s._protocolInfo = async (url) => { asked.push(url); return SAMSUNG_SINK }

  await s.scan()
  assert.equal(asked.length, 1, 'once, on the ConnectionManager it published')
  assert.match(asked[0], /ConnectionManager1$/)

  const accepts = s.accepts('dlna:udn-1')
  assert.deepEqual(accepts.videoCodecs.sort(), ['h264', 'hevc'])
  assert.equal(s.accepts('dlna:nobody'), null)
  assert.equal(s.accepts('media_player.something'), null, 'this backend answers for its own ids only')
})

test('a television that will not say is not a television that has changed', async (t) => {
  // Refusing GetProtocolInfo, publishing no ConnectionManager at all, or answering
  // something unparseable are all the same outcome: we know nothing extra, so the
  // conservative profile stands whole. This is the case that must never throw - a
  // renderer that cannot be asked still has to be castable.
  const noService = speakers({
    describeFn: async () => ({ udn: 'udn-2', name: 'Old Set', model: 'Y', controlUrl: CONTROL })
  })
  noService._protocolInfo = async () => { throw new Error('should not be asked') }
  await noService.scan()
  assert.equal(noService.accepts('dlna:udn-2'), null)

  const refuses = speakers({
    describeFn: async () => ({ udn: 'udn-3', name: 'Set', model: 'Z', controlUrl: CONTROL, connectionUrl: 'http://x/cm' })
  })
  refuses._protocolInfo = async () => { const e = new Error('no'); e.upnpCode = 401; throw e }
  await refuses.scan()
  assert.equal(refuses.accepts('dlna:udn-3'), null)
  assert.equal((await refuses.list()).length, 1, 'and it is still offered as a television')
})

test('GetProtocolInfo goes to ConnectionManager, not AVTransport', async () => {
  // The same SOAP envelope with the wrong namespace is a command to the wrong
  // service, which is the mistake the AVTransport control URL lookup already exists
  // to prevent one level up.
  const seen = []
  const sink = await protocolInfo('http://tv/cm', {
    soap: async (url, action, args, opts) => {
      seen.push({ url, action, service: opts.service })
      return '<s:Envelope><s:Body><u:GetProtocolInfoResponse><Source></Source>' +
        '<Sink>http-get:*:video/mp4:*</Sink></u:GetProtocolInfoResponse></s:Body></s:Envelope>'
    }
  })
  assert.equal(seen[0].action, 'GetProtocolInfo')
  assert.match(seen[0].service, /ConnectionManager:1$/)
  assert.equal(sink, 'http-get:*:video/mp4:*')
})
