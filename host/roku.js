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

// WHICH CHANNEL ACTUALLY PLAYS A URL, measured rather than read. This took four rounds on
// Tim's Roku Streaming Stick Plus (firmware 14.10.5) on 2026-08-18, and every step of it
// contradicted the documentation:
//
//   - `/launch/2213` (Roku Media Player, the documented answer): 404 - not installed.
//   - Installed it, then tried every documented parameter form - `t=v&u=`, `contentID=`,
//     raw url, double-encoded url, with and without videoFormat. Every one answered 200,
//     the channel OPENED on the television, and it never fetched a single byte. Roku
//     Media Player 5.5.19 accepts the launch and discards the URL.
//   - `/launch/15985` and `/input/15985` (Play on Roku): 404, and it cannot be installed -
//     it is not a store channel.
//   - Watching a WORKING cast through Home Assistant answered it: the channel that plays
//     is `782875`, a third-party one called **Media Assistant**, which is exactly what
//     Home Assistant's own Roku documentation tells people to install. Handed the same
//     `t=v&u=` parameters, it fetched the file immediately and reported `state="play"`.
//
// So this list is Media Assistant and nothing else. Roku Media Player is deliberately NOT
// in it: a device that has RMP and not MA would be offered as a television and then do
// nothing at all when pressed, which is worse than not offering it.
const MEDIA_CHANNELS = ['782875']
const MEDIA_CHANNEL_NAME = 'Media Assistant'

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
// it - host/cast.js reads 'playing', 'paused' and 'idle' BY NAME, and a word it does not
// know is a cast that never ends.
//
// `none` is what a real Roku Streaming Stick Plus answers while it sits on its home
// screen, found by pointing this at Tim's own device on 2026-08-18. The first cut passed
// unknown states through unchanged, so 'none' would have reached the session poll as
// 'none', never matched the ended test, and left a finished cast on the books forever.
// Hence the default: anything not playing or paused is idle, because for this path the
// only question is "are the bytes flowing".
function stateFrom (xml) {
  const s = (attr(xml, 'state') || '').toLowerCase()
  if (s === 'play') return 'playing'
  if (s === 'pause') return 'paused'
  if (s === 'buffer' || s === 'startup') return 'buffering'
  return 'idle'
}

// The same surface Speakers exposes, so CastSessions never learns which one it is holding:
// enabled, list, getState, play, stop, isHidden.
class RokuSpeakers {
  // `televisions` is the remembered roster (host/televisions.js). Without one this
  // still works and simply forgets everything between scans, which is what it did
  // before there was a store - useful in tests, wrong in a house.
  constructor ({ log = () => {}, discoverFn = discover, request = ecp, televisions = null } = {}) {
    this.log = log
    this._discover = discoverFn
    this._ecp = request
    this.televisions = televisions
    // id -> { entityId, name, host, ... } for the devices that answered the LAST scan.
    // Rediscovery is not free (it is two and a half seconds of waiting), so this is
    // refreshed rather than rebuilt per call.
    this.devices = new Map()
    this.lastScan = 0
    // Rokus that answered and are NOT offered, because they have no channel that can
    // play a film. The dashboard says so; see the scan.
    this.needsChannel = []
  }

  // Always on. There is nothing to configure: a Roku either answers on the network or it
  // does not, which is the entire point of this backend existing.
  get enabled () { return true }

  isHidden (entityId) {
    return !!this.televisions?.isHidden(entityId)
  }

  setHidden (entityId, hidden) {
    if (!this.televisions) throw new Error('this host does not remember televisions')
    return this.televisions.setHidden(entityId, hidden)
  }

  // THE SERIAL NUMBER, NOT THE ADDRESS. A television used to be called
  // `roku:192.168.50.13`, which is a lease rather than a name: on DHCP it moves, and
  // a remembered row would then point at whatever took it. On this very network a
  // Philips Hue bridge answers the same search a Roku does, so "whatever took it" is
  // not hypothetical. The UDN is the fallback and the address the last resort.
  entityIdFor ({ serial, udn, host }) {
    return `roku:${serial || udn || host}`
  }

  // Where to send the next request. A remembered television answers from the store
  // even when it has not been seen this session; one nobody has ever met answers
  // null, and every caller turns that into a refusal rather than a request to
  // nowhere.
  hostFor (entityId) {
    const id = String(entityId || '')
    if (!id.startsWith('roku:')) return null
    return this.devices.get(id)?.host || this.televisions?.get(id)?.host || null
  }

  // Refresh the roster. `maxAgeMs` lets a caller that just scanned skip the two seconds.
  async scan ({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs && this.lastScan && Date.now() - this.lastScan < maxAgeMs) return [...this.devices.values()]

    const found = await this._discover({ log: this.log })
    this.lastScan = Date.now()

    // ANSWERING THE SEARCH IS NOT ENOUGH; IT HAS TO IDENTIFY ITSELF. Measured on Tim's own
    // network, 2026-08-18: two devices answered an `ST: roku:ecp` M-SEARCH and only one was
    // a Roku. The other had nothing listening on 8060 at all - plenty of SSDP
    // implementations answer every search regardless of the target, so trusting the answer
    // would have put a printer in the television picker under a name that was just its IP
    // address. A device that cannot say what it is does not get offered.
    const identified = []
    const missingChannel = []
    for (const { host } of found) {
      let info = null
      try {
        info = await this._ecp(host, '/query/device-info')
      } catch (e) {
        this.log('roku:not-a-roku', { host, err: e.message })
        continue
      }
      // user-device-name is what the owner called it; the model is the fallback, because
      // "Roku Streaming Stick Plus" beats an IP address in a picker. A device-info with
      // neither is still a real ECP device, so it keeps its address as a last resort.
      const name = tag(info, 'user-device-name') || tag(info, 'friendly-device-name')
      const model = tag(info, 'model-name') || tag(info, 'friendly-model-name')
      // What this device will still be called after its address changes.
      const serial = tag(info, 'serial-number')
      const udn = tag(info, 'udn')

      // Can it play something we hand it? A Roku with no media channel installed answers
      // every query happily and 404s the launch, so the roster would otherwise be full of
      // televisions that error the moment somebody presses one.
      let channel = null
      try {
        const apps = await this._ecp(host, '/query/apps')
        channel = MEDIA_CHANNELS.find((id) => new RegExp(`app id="${id}"`).test(apps)) || null
      } catch (e) {
        this.log('roku:apps-failed', { host, err: e.message })
      }
      if (!channel) {
        // Named in the log because the fix is one the OWNER can apply in a minute: install
        // Media Assistant from the channel store. Silence here would read as "PearCinema
        // cannot see my television" when it plainly can.
        this.log('roku:no-media-channel', { host, name: name || model || host, fix: `install ${MEDIA_CHANNEL_NAME}` })
        // AND KEPT, so the dashboard can say it out loud. A log is where this used to
        // end, and a log is a thing nobody reads: the person sees a television missing
        // from a picker and has no way to guess that one free channel is the whole
        // difference. This is the list that page renders.
        missingChannel.push({ host, name: name || model || `Roku (${host})` })
        continue
      }

      const device = {
        id: this.entityIdFor({ serial, udn, host }),
        via: 'roku',
        host,
        name: name || model || `Roku (${host})`,
        model: model || null,
        serial: serial || null,
        udn: udn || null,
        channel
      }
      device.entityId = device.id
      identified.push(device.id)
      this.devices.set(device.id, device)
      // REMEMBERED, so that switching the television off does not delete it. Measured
      // on Tim's own stick 2026-08-19: with the television off it answers no search
      // and nothing on its control port, because the stick is powered by the
      // television. Deleting it made a working television VANISH from the phone's
      // picker with nothing said, which is the complaint this store exists for.
      this.televisions?.remember(device)
    }

    // Present means "answered this scan", and it is the only thing that is forgotten
    // between scans. What the device IS lives in the store.
    for (const id of [...this.devices.keys()]) {
      if (!identified.includes(id)) this.devices.delete(id)
    }

    this.needsChannel = missingChannel
    this.log('roku:scanned', {
      answering: this.devices.size,
      known: this.televisions?.all().length ?? this.devices.size,
      needsChannel: missingChannel.length
    })
    return [...this.devices.values()]
  }

  // THE FIRST CALL WAITS, THE REST DO NOT. Discovery is two and a half seconds of
  // listening, and cast.list runs when the phone opens - so the very first call pays for
  // it (or the button would be missing on the one screen where somebody is looking for
  // it), and every later call answers from the roster while a refresh runs behind it.
  async list () {
    if (!this.lastScan) await this.scan()
    else if (Date.now() - this.lastScan > 30000) this.scan().catch(() => {})

    // EVERY TELEVISION THIS LIBRARY HAS MET, not only the ones answering right now.
    // One that is not answering is listed as `unavailable`, which is the same word
    // Home Assistant uses for a television that is switched off - so the phone and
    // the dashboard treat both kinds the same way, which they could not do while a
    // found television simply disappeared.
    const known = this.televisions?.all().filter(d => d.via === 'roku') || [...this.devices.values()]
    return known.map((d) => ({
      entityId: d.entityId || d.id,
      name: d.name,
      state: this.devices.has(d.entityId || d.id) ? 'idle' : 'unavailable',
      // NO SEEK, and this is the honest answer rather than a limitation of this file: a
      // Roku's media player does not accept a seek command over ECP any more than it
      // declares one through Home Assistant, so the cast path's restart-at-offset is what
      // moves a film - which it already implements for exactly this device.
      supportedFeatures: 0,
      deviceClass: 'tv',
      hidden: !!d.hidden,
      // The last address it answered on, which the target router needs to tell this
      // television apart from the same one seen through Home Assistant.
      host: d.host || null,
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
      // THE SHAPE IS HOME ASSISTANT'S, not a shape of our own, because host/cast.js reads
      // these field names directly: `position` and `duration` in SECONDS, and
      // `positionUpdatedAt` as a parseable date. The first cut answered positionMs and
      // positionAt, which every consumer would have read as null - a cast that never
      // reported progress and never resumed where it was left.
      return {
        entityId,
        state: stateFrom(xml),
        duration: durationMs === null ? null : durationMs / 1000,
        position: positionMs === null ? null : positionMs / 1000,
        // ECP answers with the position as of NOW, so the stamp is now. cast.js adds the
        // elapsed time since while playing, which for a fresh read is nothing.
        positionUpdatedAt: new Date().toISOString(),
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
    // A REMEMBERED TELEVISION IS NOT A REACHABLE ONE. Since televisions are kept
    // between sightings, a switched-off one is still on the picker - which is the
    // point - so the refusal has to say what is actually wrong. Without this the
    // person waits four seconds for a socket timeout and is told "roku timed out".
    if (!this.devices.has(String(entityId))) {
      const known = this.televisions?.get(entityId)
      throw new Error(`${known?.name || 'that television'} is not answering - switch it on and try again`)
    }
    // The channel this device actually has, learned at scan time. A device that reached
    // the roster has one by construction; a stale id is still worth a clear failure over
    // a 404 nobody can read.
    const channel = this.devices.get(String(entityId))?.channel
    if (!channel) throw new Error(`that Roku cannot be handed a film - install ${MEDIA_CHANNEL_NAME} on it`)
    const q = new URLSearchParams({ u: url, t: 'v', videoFormat: format === 'mkv' ? 'mkv' : format })
    if (title) q.set('videoName', title)
    await this._ecp(host, `/launch/${channel}?${q.toString()}`, { method: 'POST' })
    this.log('roku:playing', { entityId, format })
    return { ok: true }
  }

  // Pause and resume are the SAME key on a Roku: `Play` toggles. Sent blind rather than
  // read-then-decide, because ECP has no separate pause command and a state read between
  // the press and the effect is a race the person would feel.
  async pause (entityId) {
    const host = this.hostFor(entityId)
    if (!host) throw new Error('not a Roku target')
    const state = await this.getState(entityId).catch(() => null)
    // Only if it is actually playing: pressing Play on a paused film would resume it, so
    // an unconditional press turns "pause" into a coin toss.
    if (state?.state !== 'playing') return { ok: true, already: true }
    await this._ecp(host, '/keypress/Play', { method: 'POST' })
    return { ok: true }
  }

  async resume (entityId) {
    const host = this.hostFor(entityId)
    if (!host) throw new Error('not a Roku target')
    const state = await this.getState(entityId).catch(() => null)
    if (state?.state === 'playing') return { ok: true, already: true }
    await this._ecp(host, '/keypress/Play', { method: 'POST' })
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

module.exports = { RokuSpeakers, discover, ecp, tag, attr, millis, stateFrom, MEDIA_CHANNELS, MEDIA_CHANNEL_NAME }
