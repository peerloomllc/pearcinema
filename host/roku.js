// Casting to a Roku with no Home Assistant in the way (proposal
// 2026-08-18-cast-to-nearby-televisions, feature A; Tim picked the Roku half first).
//
// WHY THIS EXISTS. Until now `host/speakers.js` was Home Assistant's REST API and nothing
// else, so a library owner with a television in the living room and no HA had no casting
// at all - not because anything technical was missing, but because a fairly involved piece
// of home-automation software stood in the way. HA is a reasonable thing for a NAS owner
// to run and an unreasonable thing to require.
//
// NOTHING ABOUT THE TOPOLOGY CHANGES, which is the whole reason this is the cheap half.
// The host still finds the television, still commands it, still mints its own LAN URL,
// still serves the film itself and still stops the device on revoke. Every invariant in
// CLAUDE.md survives because the host keeps holding both halves. This file replaces the
// two smallest pieces - "which televisions are there" and "play/stop/where are you" - and
// touches nothing else.
//
// WHY ROKU FIRST. ECP is plain HTTP on port 8060 and SSDP is plain UDP: no TLS, no
// protobuf, no dependency at all. The Cast protocol needs both, and its usable library was
// last published in 2022 - worth taking on deliberately, not as the first step.
//
// THE ENTITY ID IS `roku:<host>` ON PURPOSE. Everything downstream already branches on
// /roku/i (host/cast.js capsFor, speakers.play's shape pick), so a Roku found this way
// lands in the paths a Roku found through HA already lands in - including the conservative
// codec list and the HLS-rather-than-progressive choice the living room measured.

const http = require('http')
const dgram = require('dgram')

// SSDP's multicast address and port, and the search target a Roku answers to. Roku
// documents `roku:ecp`; the generic `ssdp:all` would work too and would wake every device
// on the network to answer, which is rude when we only want televisions.
const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const SSDP_ST = 'roku:ecp'

// Long enough for a device asleep on the far side of a mesh to answer, short enough that
// nobody watches a spinner. Roku's own guidance is to wait a few seconds and accept that
// discovery is best-effort rather than exhaustive.
const DISCOVER_MS = 2500

// ECP is not a slow protocol; a device that has not answered in this long is off, asleep,
// or on a network that drops us. Kept short because `getState` runs on a poll.
const ECP_TIMEOUT_MS = 4000

// The Roku Media Player channel. Launching it with a `u=` parameter is the documented way
// to play a URL on a Roku without publishing a channel of our own.
const MEDIA_PLAYER_CHANNEL = '2213'

function ecpUrl (host, path) {
  return `http://${host}:8060${path}`
}

// One ECP request. Roku answers XML for queries and an empty 200 for keypress/launch, so
// the body is returned as text and read by the small extractors below rather than by an
// XML parser - the shapes are three fields deep and stable, and a dependency to read them
// would be a bigger commitment than the protocol itself.
function ecp (host, path, { method = 'GET', timeout = ECP_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(ecpUrl(host, path), { method, timeout }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        if (res.statusCode >= 400) reject(Object.assign(new Error(`roku ${res.statusCode}`), { status: res.statusCode }))
        else resolve(body)
      })
    })
    req.on('timeout', () => { req.destroy(new Error('roku timed out')) })
    req.on('error', reject)
    req.end()
  })
}

// <tag>value</tag>, the only shape ECP's query responses use for what we read.
function tag (xml, name) {
  const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i').exec(xml || '')
  return m ? m[1].trim() : null
}

// An attribute off the root element, which is where /query/media-player keeps its state:
// <player error="false" state="play">.
function attr (xml, name) {
  const m = new RegExp(`${name}="([^"]*)"`, 'i').exec(xml || '')
  return m ? m[1] : null
}

// ECP reports positions as "1234 ms". Anything else - absent, empty, a unit we do not know
// - is null rather than 0, because 0 is a real position and "we do not know" is not.
function millis (text) {
  if (!text) return null
  const m = /(\d+)\s*ms/i.exec(text)
  return m ? Number(m[1]) : null
}

// Find Rokus by shouting on the local network and listening for the answers. Best-effort
// by construction: a device asleep or on another subnet does not answer, and that is a
// correct "not here" rather than an error.
function discover ({ ms = DISCOVER_MS, log = () => {} } = {}) {
  return new Promise((resolve) => {
    const found = new Map() // host -> { host, usn }
    let socket = null

    const done = () => {
      try { socket && socket.close() } catch {}
      resolve([...found.values()])
    }

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    } catch (e) {
      log('roku:discover-failed', { err: e.message })
      return resolve([])
    }

    // A socket error must not take the host down - a machine with no route to the
    // multicast group is a normal thing, not a crash.
    socket.on('error', (e) => { log('roku:discover-error', { err: e.message }); done() })

    socket.on('message', (msg) => {
      const text = msg.toString('utf8')
      // The LOCATION header is the device's own root URL, and its host is what every
      // later ECP call is addressed to. Taken from the answer rather than from the
      // packet's source address, because that is what Roku says to use.
      const m = /LOCATION:\s*http:\/\/([^:/\s]+)/i.exec(text)
      if (!m) return
      const host = m[1]
      if (!found.has(host)) found.set(host, { host, usn: (/USN:\s*(.+)/i.exec(text) || [])[1]?.trim() || null })
    })

    socket.bind(() => {
      const search = Buffer.from(
        'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'ST: ' + SSDP_ST + '\r\n' +
        'MX: 2\r\n\r\n'
      )
      // Sent twice, half a second apart: UDP multicast drops, and one lost packet
      // would otherwise read as "you own no televisions".
      const send = () => { try { socket.send(search, 0, search.length, SSDP_PORT, SSDP_ADDR) } catch {} }
      send()
      const again = setTimeout(send, 500)
      if (again.unref) again.unref()
      const timer = setTimeout(done, ms)
      if (timer.unref) timer.unref()
    })
  })
}

// What HA's `state` vocabulary calls these, because everything downstream already speaks
// it - host/cast.js reads 'playing' and 'paused' by name.
function stateFrom (xml) {
  const s = (attr(xml, 'state') || '').toLowerCase()
  if (s === 'play') return 'playing'
  if (s === 'pause') return 'paused'
  if (s === 'close' || s === 'stop' || s === '') return 'idle'
  return s
}

// The same surface Speakers exposes, so CastSessions never learns which one it is holding:
// enabled, list, getState, play, stop, isHidden.
class RokuSpeakers {
  constructor ({ log = () => {}, discoverFn = discover, request = ecp } = {}) {
    this.log = log
    this._discover = discoverFn
    this._ecp = request
    // host -> { entityId, name, host, at }. Rediscovery is not free (it is two seconds of
    // waiting), so the roster is remembered and refreshed rather than rebuilt per call.
    this.devices = new Map()
    this.lastScan = 0
  }

  // Always on. There is nothing to configure: a Roku either answers on the network or it
  // does not, which is the entire point of this backend existing.
  get enabled () { return true }

  isHidden () { return false }

  entityIdFor (host) { return `roku:${host}` }

  hostFor (entityId) {
    const s = String(entityId || '')
    return s.startsWith('roku:') ? s.slice(5) : null
  }

  // Refresh the roster. `maxAgeMs` lets a caller that just scanned skip the two seconds.
  async scan ({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs && this.lastScan && Date.now() - this.lastScan < maxAgeMs) return [...this.devices.values()]

    const found = await this._discover({ log: this.log })
    this.lastScan = Date.now()

    for (const { host } of found) {
      let name = null
      let model = null
      try {
        const info = await this._ecp(host, '/query/device-info')
        // user-device-name is what the owner called it; the model is the fallback,
        // because "Roku Express" beats an IP address in a picker.
        name = tag(info, 'user-device-name') || tag(info, 'friendly-device-name')
        model = tag(info, 'model-name') || tag(info, 'friendly-model-name')
      } catch (e) {
        this.log('roku:info-failed', { host, err: e.message })
      }
      this.devices.set(host, {
        host,
        entityId: this.entityIdFor(host),
        name: name || model || `Roku (${host})`,
        model: model || null
      })
    }

    // A device that stopped answering is dropped rather than kept as a dead button - the
    // roster is "what is here now", and a stale entry ends in an error the person cannot
    // act on.
    for (const host of [...this.devices.keys()]) {
      if (!found.some((f) => f.host === host)) this.devices.delete(host)
    }

    this.log('roku:scanned', { found: this.devices.size })
    return [...this.devices.values()]
  }

  // THE FIRST CALL WAITS, THE REST DO NOT. Discovery is two and a half seconds of
  // listening, and cast.list runs when the phone opens - so the very first call pays for
  // it (or the button would be missing on the one screen where somebody is looking for
  // it), and every later call answers from the roster while a refresh runs behind it.
  async list () {
    if (!this.lastScan) await this.scan()
    else if (Date.now() - this.lastScan > 30000) this.scan().catch(() => {})
    const devices = [...this.devices.values()]
    return devices.map((d) => ({
      entityId: d.entityId,
      name: d.name,
      state: 'idle',
      // NO SEEK, and this is the honest answer rather than a limitation of this file: a
      // Roku's media player does not accept a seek command over ECP any more than it
      // declares one through Home Assistant, so the cast path's restart-at-offset is what
      // moves a film - which it already implements for exactly this device.
      supportedFeatures: 0,
      deviceClass: 'tv',
      hidden: false,
      // Says where this target came from, so a dashboard can be honest that it was found
      // on the network rather than configured by anybody.
      via: 'roku'
    }))
  }

  async getState (entityId) {
    const host = this.hostFor(entityId)
    if (!host) return null
    try {
      const xml = await this._ecp(host, '/query/media-player')
      const positionMs = millis(tag(xml, 'position'))
      const durationMs = millis(tag(xml, 'duration'))
      return {
        entityId,
        state: stateFrom(xml),
        positionMs,
        durationMs,
        // The position was true when the device answered. Named the same as the HA path's
        // stamp because the cast session's drift arithmetic reads it.
        positionAt: Date.now(),
        supportedFeatures: 0
      }
    } catch (e) {
      this.log('roku:state-failed', { entityId, err: e.message })
      return null
    }
  }

  // Launch the Roku Media Player at our URL. `t=v` says video; the format hint is the same
  // one the HA path sends and matters for the same reason - a Roku plays Matroska
  // natively, and mislabelling an HLS stream as mp4 gets a black screen.
  async play (entityId, url, { title = null, format = 'mp4' } = {}) {
    const host = this.hostFor(entityId)
    if (!host) throw new Error('not a Roku target')
    const q = new URLSearchParams({ u: url, t: 'v', videoFormat: format === 'mkv' ? 'mkv' : format })
    if (title) q.set('videoName', title)
    await this._ecp(host, `/launch/${MEDIA_PLAYER_CHANNEL}?${q.toString()}`, { method: 'POST' })
    this.log('roku:playing', { entityId, format })
    return { ok: true }
  }

  // HOME, NOT STOP, and revoke is the reason. ECP has no stop command for the media
  // player; Home exits the channel, which ends playback and the bytes with it. The HA
  // backend arrives at the same key by a longer road (media_stop 500s on a Roku, so it
  // falls back to the remote's Home) - this one starts there.
  async stop (entityId) {
    const host = this.hostFor(entityId)
    if (!host) throw new Error('not a Roku target')
    await this._ecp(host, '/keypress/Home', { method: 'POST' })
    this.log('roku:stopped', { entityId })
    return { ok: true }
  }
}

module.exports = { RokuSpeakers, discover, ecp, tag, attr, millis, stateFrom, MEDIA_PLAYER_CHANNEL }
