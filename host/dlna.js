// Casting to a television that speaks DLNA, with no Home Assistant in the way.
//
// WHY THIS EXISTS. Tim's Samsung was discovered by Home Assistant, offered in the picker,
// and did nothing at all when a film was sent to it: HA's samsungtv integration can turn
// a set on and change its source, and `play_media` on it answered 500 (measured on his own
// box, 2026-08-20). The television was never told anything. Meanwhile the set itself
// advertises a UPnP MediaRenderer on port 9197 and takes the film directly.
//
// WHAT WAS MEASURED, on a Samsung TU7000 (UN65TU7000FXZA), 2026-08-20 - every line here
// comes off that session rather than off a specification:
//
//   - SetAVTransportURI + Play: 200, film on screen.
//   - GetTransportInfo and GetPositionInfo: real state, position AND duration.
//   - Pause and Seek: **701 Transition not available** - refused while genuinely playing.
//   - The same Pause and Seek, after the media URL started answering a HEAD with
//     `contentFeatures.dlna.org: ...DLNA.ORG_OP=01...`: 200, and the set jumped to 0:42.9.
//
// THAT LAST LINE IS THE WHOLE FILE'S REASON. A Samsung asks the SERVER what the file
// supports before deciding which buttons to allow - it sends a HEAD with
// `getcontentFeatures.dlna.org: 1` and reads the answer. Answer nothing and the television
// is not being stubborn: it has been told the file cannot be seeked. host/cast.js sends
// that header on the direct route, and the set then seeks by asking for a byte range,
// which is a real seek in the file rather than a re-cut stream - so a DLNA television's
// own clock is right by construction, where a Roku's has to be reasoned about.
//
// THE ENTITY ID IS `dlna:<udn>`. The UDN is stable across leases; the address is not.

const dgram = require('dgram')
const http = require('http')
const { URL } = require('url')

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
// The renderers, not everything: `ssdp:all` wakes every device on the network to answer.
const SSDP_ST = 'urn:schemas-upnp-org:device:MediaRenderer:1'
const DISCOVER_MS = 2500
const HTTP_TIMEOUT_MS = 6000

// What we tell a television about the file. `DLNA.ORG_OP=01` is the byte-seek flag, and it
// is the difference between a set that offers a scrubber and one that answers 701 to every
// Seek. The FLAGS word is the standard streaming set (byte-based seek, background transfer
// mode, connection stalling allowed, DLNA v1.5).
const FEATURES = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'

const AV = 'urn:schemas-upnp-org:service:AVTransport:1'
// The service that answers what a renderer will actually accept. AVTransport is how a
// film is put on; this is how the television is ASKED first.
const CM = 'urn:schemas-upnp-org:service:ConnectionManager:1'

// SEEK, in Home Assistant's own vocabulary, because host/cast.js asks `canSeek` about every
// television in the same words whichever backend found it.
const FEATURE_SEEK = 2

function xmlEscape (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function tag (xml, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(String(xml || ''))
  return m ? m[1].trim() : null
}

// `0:01:23.500` and `00:01:23` both mean the same eighty-three seconds and a half.
function seconds (clock) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(String(clock || '').trim())
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

function clockOf (sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// A renderer's own words for what it is doing, in ours - the same four states every other
// backend answers, so nothing downstream learns there is a third kind of television.
function stateFrom (transport) {
  const s = String(transport || '').toUpperCase()
  if (s === 'PLAYING') return 'playing'
  if (s === 'PAUSED_PLAYBACK' || s === 'PAUSED_RECORDING') return 'paused'
  if (s === 'TRANSITIONING') return 'buffering'
  return 'idle'
}

// A small HTTP helper rather than fetch: this talks to appliances on a LAN, where a set
// that is asleep answers nothing at all and a hung socket would stall the cast poll.
function request (url, { method = 'GET', body = null, headers = {}, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch { return reject(new Error('bad url')) }
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers }
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// One SOAP action. A UPnP fault comes back as a 500 with an errorCode inside it, and the
// code is the useful half - 701 means "not in a state where that makes sense", which is a
// different thing from a television that cannot do it at all.
async function soap (controlUrl, action, args, { request: send = request, service = AV } = {}) {
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${service}">${args}</u:${action}></s:Body></s:Envelope>`

  const res = await send(controlUrl, {
    method: 'POST',
    body,
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${service}#${action}"` }
  })
  if (res.status !== 200) {
    const code = tag(res.body, 'errorCode')
    const why = tag(res.body, 'errorDescription')
    const e = new Error(why ? `${why}${code ? ` (${code})` : ''}` : `that television refused ${action}`)
    e.upnpCode = code ? Number(code) : null
    throw e
  }
  return res.body
}

// Who is out there. Answers arrive as unicast replies to a multicast question, so this
// listens for a fixed window rather than waiting for a count it cannot know.
function discover ({ log = () => {}, ms = DISCOVER_MS } = {}) {
  return new Promise((resolve) => {
    const found = new Map()
    let socket
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    } catch (e) {
      log('dlna:discover-failed', { err: e.message })
      return resolve([])
    }

    const done = () => {
      try { socket.close() } catch {}
      resolve([...found.values()])
    }

    socket.on('error', (e) => { log('dlna:discover-failed', { err: e.message }); done() })
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8')
      const location = /^location:\s*(\S+)/im.exec(text)?.[1]
      if (!location) return
      found.set(location, { location, address: rinfo.address, server: /^server:\s*(.+)$/im.exec(text)?.[1]?.trim() || null })
    })

    socket.bind(() => {
      const query = [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        'MX: 2',
        `ST: ${SSDP_ST}`,
        '', ''
      ].join('\r\n')
      // SENT TWICE, half a second apart, the same as the Roku search: UDP multicast
      // drops, and one lost packet would otherwise read as "you own no televisions".
      const q = Buffer.from(query)
      const send = () => { try { socket.send(q, 0, q.length, SSDP_PORT, SSDP_ADDR) } catch {} }
      send()
      const again = setTimeout(send, 500)
      if (again.unref) again.unref()
      const timer = setTimeout(done, ms)
      if (timer.unref) timer.unref()
    })
  })
}

// What a renderer says it is. The control URL is the only thing here that MUST be found:
// a device with no AVTransport is a renderer that cannot be handed a film - a photo frame,
// a speaker's control endpoint - and it is dropped rather than offered.
// One service's control URL out of a device description. Not the first controlURL in
// the file, which belongs to whichever service happened to be listed first.
function controlFor (xml, location, service) {
  const wanted = new RegExp(service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const block = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)]
    .map((m) => m[1])
    .find((b) => wanted.test(b))
  const control = block ? tag(block, 'controlURL') : null
  return control ? new URL(control, location).toString() : null
}

async function describe (location, { request: send = request } = {}) {
  const res = await send(location)
  if (res.status !== 200 || !res.body) return null
  const xml = res.body
  const controlUrl = controlFor(xml, location, AV)
  if (!controlUrl) return null

  return {
    udn: (tag(xml, 'UDN') || '').replace(/^uuid:/i, '') || null,
    name: tag(xml, 'friendlyName') || null,
    model: tag(xml, 'modelName') || null,
    manufacturer: tag(xml, 'manufacturer') || null,
    controlUrl,
    // Optional: a renderer that publishes no ConnectionManager simply cannot be
    // asked what it accepts, and falls back to the conservative profile.
    connectionUrl: controlFor(xml, location, CM)
  }
}

// --- what this television says it accepts ------------------------------------
//
// THE ONE QUESTION WE WERE NOT ASKING (Tim, 2026-08-20: "would these changes to Roku
// and Samsung casting work for anyone else who installs PearCinema and discovers
// those devices on their network or is this custom to our setup?"). The mechanism was
// always generic; the CAPABILITY PROFILE was one Samsung's, inherited by every DLNA
// television in the world. A renderer publishes exactly this - `GetProtocolInfo` on
// ConnectionManager returns a `Sink` list of every protocol, container and profile it
// will take - and it was never being read.
//
// WHAT THE ANSWER IS GOOD FOR, and it is narrower than it looks. Read from the real
// TU7000 (292 entries, 264 DLNA profiles, 2026-08-20) it is exact about CONTAINERS and
// CODECS - `video/x-mkv`, `video/quicktime`, `video/hevc` and a hundred AVC profiles
// are the set saying in its own words what it opens.
//
// AND IT IS USELESS ABOUT TRANSPORT, which is the thing it would have been most
// convenient for. The same Samsung advertises no playlist mime type at all and
// demonstrably plays an HLS playlist (measured before this, and the whole reason the
// DLNA profile allows one). So an absent playlist type means "did not say", never
// "cannot" - and the shape of a stream stays a thing to be tried rather than derived.
// The one thing an ADVERTISED playlist type buys is certainty in the other direction.
//
// So this only ever WIDENS, and a device that answers nothing useful keeps exactly the
// profile it had before this existed.

const MIME_CONTAINERS = {
  'video/mp4': ['mp4'],
  'video/quicktime': ['mov'],
  'video/x-matroska': ['matroska', 'mkv'],
  // Samsung's own spelling of the same thing.
  'video/x-mkv': ['matroska', 'mkv'],
  'video/webm': ['webm']
}

const PLAYLIST_MIMES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl'
]

async function protocolInfo (connectionUrl, { soap: call = soap, request: send = request } = {}) {
  const xml = await call(connectionUrl, 'GetProtocolInfo', '', { request: send, service: CM })
  return tag(xml, 'Sink') || ''
}

// A Sink list turned into the half of a capability profile it can honestly answer.
// Null when there is nothing usable in it, which is the caller's signal to keep the
// conservative profile whole rather than merge an empty one over it.
function sinkProfile (sink) {
  const entries = String(sink || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!entries.length) return null

  const containers = new Set()
  const videoCodecs = new Set()
  let playlist = false

  for (const entry of entries) {
    // `http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_HD_720p_AAC`
    const parts = entry.split(':')
    if (parts.length < 3) continue
    if (!/^http-get$/i.test(parts[0])) continue // an internal or RTP protocol is not ours to use
    const mime = String(parts[2] || '').toLowerCase()
    const profile = (/DLNA\.ORG_PN=([^;:]+)/i.exec(entry) || [])[1] || ''

    for (const c of MIME_CONTAINERS[mime] || []) containers.add(c)
    if (PLAYLIST_MIMES.includes(mime)) playlist = true

    // A raw elementary-stream mime type is the set naming a DECODER rather than a
    // container, which is the most direct statement it makes about codecs.
    if (mime === 'video/hevc' || mime === 'video/h265' || mime === 'video/x-h265') videoCodecs.add('hevc')
    if (mime === 'video/h264' || mime === 'video/x-h264' || mime === 'video/avc') videoCodecs.add('h264')

    // And the DLNA profile names say it again, in the vocabulary a certified device
    // uses: AVC_MP4_MP_HD_AAC is h.264 in mp4, HEVC_TS_MAIN is HEVC.
    if (/^AVC[_-]/i.test(profile)) videoCodecs.add('h264')
    if (/HEVC|H265/i.test(profile)) videoCodecs.add('hevc')
  }

  if (!containers.size && !videoCodecs.size && !playlist) return null
  return {
    containers: [...containers],
    videoCodecs: [...videoCodecs],
    // TRUE means the device said so; false means it did not say, which is not the
    // same as "cannot" - see the note above. Never used to take a playlist away.
    playlist
  }
}

class DlnaSpeakers {
  constructor ({ log = () => {}, discoverFn = discover, describeFn = describe, soapFn = soap, protocolInfoFn = protocolInfo, televisions = null } = {}) {
    this.log = log
    this._discover = discoverFn
    this._describe = describeFn
    this._soap = soapFn
    this._protocolInfo = protocolInfoFn
    this.televisions = televisions
    this.devices = new Map()
    this.lastScan = 0
  }

  // Nothing to configure: a television either answers a multicast question or it does not.
  get enabled () { return true }

  // The ids this backend mints, so the router can hand a target back to it without
  // knowing what it is.
  get prefix () { return 'dlna:' }

  isHidden (entityId) { return !!this.televisions?.isHidden(entityId) }

  setHidden (entityId, hidden) {
    if (!this.televisions) throw new Error('this host does not remember televisions')
    return this.televisions.setHidden(entityId, hidden)
  }

  entityIdFor ({ udn, address }) { return `dlna:${udn || address}` }

  // Where to send the next command. A remembered television answers from the store even
  // when it has not been seen this session - but only if we know its control URL, which is
  // the address plus a path and therefore moves with the lease.
  controlFor (entityId) {
    const id = String(entityId || '')
    if (!id.startsWith('dlna:')) return null
    return this.devices.get(id)?.controlUrl || this.televisions?.get(id)?.control || null
  }

  // WHAT THIS TELEVISION SAID IT ACCEPTS, or null for one that never said. Read from
  // the live row first and the store second, so a set that is switched off right now
  // still casts with the profile it published when it was last awake.
  accepts (entityId) {
    const id = String(entityId || '')
    if (!id.startsWith('dlna:')) return null
    return this.devices.get(id)?.accepts || this.televisions?.get(id)?.accepts || null
  }

  async scan ({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs && this.lastScan && Date.now() - this.lastScan < maxAgeMs) return [...this.devices.values()]

    const answers = await this._discover({ log: this.log })
    this.lastScan = Date.now()

    const next = new Map()
    await Promise.all(answers.map(async (a) => {
      const info = await this._describe(a.location).catch(() => null)
      // ANSWERING THE SEARCH IS NOT ENOUGH. A Hue bridge answers this same question on
      // Tim's network and is not a television; a device with no AVTransport is dropped by
      // describe(), which is the test that actually means something.
      if (!info) return
      const entityId = this.entityIdFor({ udn: info.udn, address: a.address })

      // ASK IT WHAT IT TAKES, once per sighting and never fatally: a television that
      // does not answer this is a television we know nothing extra about, which is
      // exactly where we were before. Kept beside the row so the cast path can widen
      // the conservative profile with the set's own words.
      let accepts = this.televisions?.get(entityId)?.accepts || null
      if (info.connectionUrl) {
        try {
          const derived = sinkProfile(await this._protocolInfo(info.connectionUrl))
          if (derived) accepts = derived
        } catch (e) {
          this.log('dlna:protocol-info-failed', { entityId, err: e?.message })
        }
      }

      const row = {
        entityId,
        name: info.name || info.model || a.address,
        model: info.model,
        udn: info.udn,
        host: a.address,
        controlUrl: info.controlUrl,
        accepts
      }
      next.set(entityId, row)
      // The control URL is what a backend needs to reach this television again, and the
      // store keeps one field per backend for exactly that.
      this.televisions?.remember({
        id: entityId, via: 'dlna', name: row.name, model: row.model, udn: row.udn,
        host: row.host, control: row.controlUrl, accepts
      })
    }))

    this.devices = next
    this.log('dlna:scanned', { found: next.size })
    return [...next.values()]
  }

  async list () {
    if (!this.lastScan) await this.scan()
    else if (Date.now() - this.lastScan > 30000) this.scan().catch(() => {})

    const known = this.televisions?.all().filter((d) => d.via === 'dlna') || [...this.devices.values()]
    return known.map((d) => {
      const id = d.entityId || d.id
      return {
        entityId: id,
        name: d.name,
        state: this.devices.has(id) ? 'idle' : 'unavailable',
        // SEEK, and unlike a Roku this is not wishful: measured on the TU7000, a Seek
        // lands and the set fetches the new byte range. It only holds while the film is
        // served with the DLNA feature header - which host/cast.js sends on the direct
        // route and cannot on a generated one, where the cast path restarts at the offset
        // exactly as it does for a Roku.
        supportedFeatures: FEATURE_SEEK,
        deviceClass: 'tv',
        hidden: !!d.hidden,
        host: d.host || null,
        via: 'dlna',
        // What it said it accepts, for the settings page - so "will this work with my
        // television" is answered by the television rather than by us.
        accepts: this.accepts(id)
      }
    })
  }

  async getState (entityId) {
    const control = this.controlFor(entityId)
    if (!control) return null
    try {
      const [info, pos] = await Promise.all([
        this._soap(control, 'GetTransportInfo', '<InstanceID>0</InstanceID>'),
        this._soap(control, 'GetPositionInfo', '<InstanceID>0</InstanceID>')
      ])
      const position = seconds(tag(pos, 'RelTime'))
      const duration = seconds(tag(pos, 'TrackDuration'))
      return {
        entityId,
        state: stateFrom(tag(info, 'CurrentTransportState')),
        duration: duration || null,
        position: position === null ? null : position,
        // The answer is as of now, so the stamp is now - the same contract the Roku
        // backend keeps, and what lets cast.js add the elapsed time while playing.
        positionUpdatedAt: new Date().toISOString(),
        supportedFeatures: FEATURE_SEEK
      }
    } catch (e) {
      this.log('dlna:state-failed', { entityId, err: e.message })
      return null
    }
  }

  async play (entityId, url, { title = null, format = 'mp4' } = {}) {
    const control = this.controlFor(entityId)
    if (!control) throw new Error('not a DLNA target')
    if (!this.devices.has(String(entityId))) {
      const known = this.televisions?.get(entityId)
      throw new Error(`${known?.name || 'That television'} is not answering. Switch it on and try again.`)
    }
    // A PLAYLIST IS A THING THIS CAN BE HANDED. The specification says a renderer plays a
    // file; the television says otherwise - handed an HLS VOD playlist it played it and
    // reported its position throughout (measured, 2026-08-20). Everything converted
    // arrives this way, because the same set refuses a live progressive stream.
    const mime = format === 'hls'
      ? 'application/vnd.apple.mpegurl'
      : format === 'mkv' ? 'video/x-matroska' : 'video/mp4'
    const didl =
      '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
      '<item id="1" parentID="0" restricted="1">' +
      `<dc:title>${xmlEscape(title || 'PearCinema')}</dc:title>` +
      '<upnp:class>object.item.videoItem</upnp:class>' +
      `<res protocolInfo="http-get:*:${mime}:${FEATURES}">${xmlEscape(url)}</res>` +
      '</item></DIDL-Lite>'

    // STOP FIRST, because a renderer already showing something answers 701 to
    // SetAVTransportURI on some firmwares. A television that was idle refuses the Stop
    // harmlessly, which is why the failure is swallowed rather than reported.
    await this._soap(control, 'Stop', '<InstanceID>0</InstanceID>').catch(() => {})
    await this._soap(control, 'SetAVTransportURI',
      `<InstanceID>0</InstanceID><CurrentURI>${xmlEscape(url)}</CurrentURI>` +
      `<CurrentURIMetaData>${xmlEscape(didl)}</CurrentURIMetaData>`)
    await this._soap(control, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>')
    this.log('dlna:playing', { entityId, format })
    return { ok: true }
  }

  async pause (entityId) {
    const control = this.controlFor(entityId)
    if (!control) throw new Error('not a DLNA target')
    await this._soap(control, 'Pause', '<InstanceID>0</InstanceID>')
    return { ok: true }
  }

  async resume (entityId) {
    const control = this.controlFor(entityId)
    if (!control) throw new Error('not a DLNA target')
    await this._soap(control, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>')
    return { ok: true }
  }

  // A REAL SEEK, in the file. The television asks the host for a different byte range and
  // carries on - no stream is re-cut, nothing restarts, and its own clock stays the film's.
  // Refused with 701 when the film is being converted, because a generated stream cannot
  // answer a range; the cast path treats that the way it treats a Roku.
  async seek (entityId, secs) {
    const control = this.controlFor(entityId)
    if (!control) throw new Error('not a DLNA target')
    await this._soap(control, 'Seek', `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${clockOf(secs)}</Target>`)
    return { ok: true }
  }

  async stop (entityId) {
    const control = this.controlFor(entityId)
    if (!control) throw new Error('not a DLNA target')
    await this._soap(control, 'Stop', '<InstanceID>0</InstanceID>')
    this.log('dlna:stopped', { entityId })
    return { ok: true }
  }
}

module.exports = {
  DlnaSpeakers, discover, describe, soap, request, stateFrom, seconds, clockOf, tag,
  protocolInfo, sinkProfile, controlFor,
  FEATURES, FEATURE_SEEK, SSDP_ST, CM
}
