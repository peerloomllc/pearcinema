// The PearCinema worklet: the P2P backend that runs inside the phone.
//
// It holds:
//   1. the device identity (a keypair, persisted; it IS this device's grant)
//   2. the paired-host list (hosts.json, via @peerloom/client's pure bookkeeping)
//   3. the live connection to the active host (@peerloom/client Client)
//   4. the localhost streaming shim, which is how a video player ever sees bytes
//
// The shell talks to it over BareKit IPC with { id, method, args }; replies are
// { id, result } or { id, error }; pushes are { event, data }. That envelope is
// the suite convention documented in @peerloom/client's index.
//
// Composition, not implementation: everything below the method table lives in
// @peerloom/client, extracted from PearTune precisely so this file could be
// short. What is PearCinema's here is the vocabulary (itemId/artId), the video
// method surface, and nothing else.

/* global Bare, BareKit */

const b4a = require('b4a')
const z32 = require('z32')
const hcrypto = require('hypercore-crypto')
const fs = require('bare-fs')
const path = require('bare-path')

const { createProtocol } = require('@peerloom/host/protocol')
const { Client } = require('@peerloom/client/client')
const H = require('@peerloom/client/hosts')
const { createAudioShim } = require('@peerloom/client/shim')
const { AudioCache } = require('@peerloom/client/cache')
const { ArtStore } = require('@peerloom/client/art-cache')

const DATA_DIR = Bare.argv[0] || '/tmp/pearcinema'
const PLATFORM = Bare.argv[1] || 'android'

const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

// Title, year, part and runtime per downloaded item, written at download time. The
// cache index only knows bytes, so without this an offline Downloads list can
// name a film nothing better than 'A removed title'.
const DL_META_FILE = path.join(DATA_DIR, 'download-meta.json')

function readDlMeta () {
  try { return JSON.parse(fs.readFileSync(DL_META_FILE, 'utf8')) || {} } catch { return {} }
}
function writeDlMeta (m) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(DL_META_FILE, JSON.stringify(m))
}

// Small device-local preferences (theme and friends), beside the identity the
// same way the donor keeps them - so the shell could one day read the theme
// before the WebView paints.
function readSettings () {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {} } catch { return {} }
}
function writeSettings (s) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s))
}

const protocol = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })

const caps = require('./capabilities')
const relay = require('./relay')
const revoke = require('./revoked')
const demo = require('./demo')

// --- the demo library -------------------------------------------------------
//
// A few public-domain films shipped inside the app, played with no host, no pairing and
// no network at all (proposal 2026-08-26-app-review-demo). It exists because an App
// Store reviewer - and anyone who installs before setting up a server - otherwise opens
// PearCinema to a wall with nothing to press.
//
// Demo mode is a THIRD branch taken first, ahead of the merged branch and the host
// branch every browse method already has. Nothing about it touches the identity
// keypair, hosts.json, a grant or a pairing window: a demo library is not a pairing,
// and a host never learns it exists.
//
// The catalog lives in RAM and the local paths with it, because only the SHELL can
// resolve a bundled asset to a path and it does so afresh on each launch - an app
// update moves the bundle, so a path persisted today is a dead path tomorrow. What IS
// persisted is one flag: whether the demo is on.
const DEMO_FILE = path.join(DATA_DIR, 'demo.json')
let demoCatalog = null
let demoFilms = new Map() // itemId -> the local path of that film
let demoArt = new Map() // artId -> the local path of that poster
let demoSubs = new Map() // subtitleId -> the local path of that caption file
// Where you got to, what you finished and what you saved, for a library with no host to
// keep it for you. Retired with the demo, and never merged into a real library's.
let demoState = demo.emptyDemoState()

function demoMode () { return !!demoCatalog }
function isDemoId (id) { return !!demoCatalog && demoCatalog.ids.has(String(id)) }

function readDemoRecord () {
  try { return JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8')) || null } catch { return null }
}
function writeDemoRecord (r) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(DEMO_FILE, JSON.stringify(r))
}
function saveDemoState () {
  writeDemoRecord({ on: true, state: demoState })
}

// The synthetic host row the demo renders as. Deliberately NOT written to hosts.json:
// it is not a pairing and must never outlive an uninstall of the demo or be counted as
// a library by anything that counts libraries. It carries the same fields a real row
// does so the library menu, the browse screens and the player render unchanged, plus
// `demo: true` so the UI can say what this is.
function demoHostRow () {
  return {
    hostKey: null,
    libraryId: demoCatalog.libraryId,
    libraryName: demoCatalog.name,
    demo: true,
    active: true,
    online: true,
    absent: false,
    revoked: false,
    inMerge: false
  }
}

// Leave the demo. Called by hand from Settings and - the important one - by a
// successful pair: the moment a real library exists the demo has done its job, and
// leaving it in the library menu is exactly the "must never look like a paired library"
// the proposal forbids. Safe to call when the demo is already off.
function retireDemo (why) {
  const was = demoMode()
  demoCatalog = null
  demoFilms = new Map()
  demoArt = new Map()
  demoSubs = new Map()
  // The watch state goes with it, in RAM as well as on disk: starting the demo again
  // should be a fresh look around rather than a shelf of places somebody left before
  // they decided against it.
  demoState = demo.emptyDemoState()
  try { fs.unlinkSync(DEMO_FILE) } catch {}
  // Nothing else to reclaim: the films and posters were never copied out of the app
  // bundle, so retiring the demo frees no space and cannot delete anything of anyone's.
  if (was) log('demo:retired', { why: why || null })
  return { ok: true, was }
}

// The relay policy, handed to every Client we build. The client owns the gate - direct
// first, a key only after a punch has actually failed - and asks this for the key.
// Read fresh on each dial rather than captured at boot, so turning the toggle off in
// Settings takes effect on the next reconnect instead of the next app launch.
function relayPolicy ({ force, randomized }) {
  const s = readSettings()
  return relay.relayThroughFor({
    force,
    randomized,
    useRelay: s.useRelay !== false,
    ownKeyZ: s.ownRelayKey || null
  })
}

// Which libraries we OFFERED the relay for, on the connection we currently hold. Offered,
// not used - see relayOffered in @peerloom/client. Cleared on disconnect, so a library
// that reconnects on wifi stops being labelled and stops being throttled.
// WHICH LIBRARIES WE TRIED AND COULD NOT REACH. Absence used to be invisible: the merged
// build simply left an unreachable host's catalog out, library.list answered with an empty
// page and no error, and the shelf drew an empty library - which reads as "there is nothing
// in here" rather than "this machine is not answering". Tim hit it on the TCL pointing at a
// switched-off Windows VM (2026-08-21): the titles were there on the first paint, from the
// catalog cache, and vanished on the rebuild without a word.
const absentLibs = new Map() // libraryId -> the message the failed attempt carried

// LIBRARIES THAT TOLD US WE ARE NO LONGER WELCOME, libraryId -> reason.
//
// A host whose grant for this device is gone now says so, once, instead of leaving the
// phone to guess (`access:revoked`, proposal 2026-08-22-say-goodbye-to-a-revoked-device).
// Before that, being removed looked exactly like a server that was switched off: "could
// not reach the host", a library stuck on "connecting…", and a dial every few seconds for
// as long as the app was open - watched on the TCL, 2026-08-22.
//
// IN MEMORY ONLY, and that is a deliberate simplification rather than an oversight. A
// restart forgets, dials once, and hears the same goodbye - which costs one connection and
// keeps the phone from carrying a permanent verdict about somebody else's library. If they
// let this device back in, the next dial simply works.
const revokedLibs = new Map()

// AND IT IS WRITTEN DOWN, since 2026-08-27. In memory was enough while a revoke only
// stopped the phone from dialling: a restart forgot, dialled once and heard the same
// goodbye. It is not enough now that the verdict also stops films the phone already
// holds - forgetting it means relaunching in airplane mode plays a revoked library's
// cache back. Cleared the moment that library lets this device in again (see
// connectedLib), so it is a note about right now rather than a permanent judgement.
const REVOKED_FILE = path.join(DATA_DIR, 'revoked.json')

function readRevoked () {
  try {
    const raw = JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8'))
    return new Map(Object.entries(raw && typeof raw === 'object' ? raw : {}))
  } catch { return new Map() }
}
function writeRevoked () {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(REVOKED_FILE, JSON.stringify(Object.fromEntries(revokedLibs)))
  } catch (e) { log('revoke:save-failed', { err: e.message }) }
}

// Filled at boot from the file above, before the first dial or the first stream URL.
for (const [lib, reason] of readRevoked()) revokedLibs.set(lib, reason)

function markRevoked (libraryId, reason = 'device-revoked') {
  if (revokedLibs.has(libraryId)) return
  revokedLibs.set(libraryId, reason)
  writeRevoked()
  log('host:access-revoked', { libraryId, reason })
  // Hang up rather than sit on a socket that can do nothing, and stop the merged index
  // counting on a library that is not ours any more.
  const slot = hostConns.get(libraryId)
  if (slot?.client) { try { slot.client.close() } catch {} }
  hostConns.delete(libraryId)
  contributedLibs.delete(libraryId)
  // STOP THE FILM, which is the half hanging up cannot do. On a home network the player
  // has been handed the whole file long before this arrives, so nothing about closing a
  // socket reaches the picture - the UI has to be told (Tim, 2026-08-27, filming exactly
  // this for App Review and watching the film play on).
  emit('access:revoked', { libraryId, reason, libraryName: hostRow(libraryId)?.libraryName || null })
  emit('hosts:changed', {})
  if (mergedOn()) buildSoon('access-revoked')
}

// They let us back in. The next successful dial is the proof, and it is the only thing
// that clears the verdict - so a library that changes its mind needs no action here.
function clearRevoked (libraryId) {
  if (!revokedLibs.has(libraryId)) return
  revokedLibs.delete(libraryId)
  writeRevoked()
  log('host:access-restored', { libraryId })
  // The shelves were emptied by the revoke and nothing else makes them ask again: the
  // active library has not changed, so every list effect keyed on it stays put. Watched
  // on the Simulator, 2026-08-27 - the library came back with its own name in the header
  // and no films under it until the chip was tapped.
  emit('access:restored', { libraryId, libraryName: hostRow(libraryId)?.libraryName || null })
  emit('hosts:changed', {})
}

const relayedLibs = new Set()

function libraryForId (id) {
  return owners.get(String(id)) || H.activeHost(hostsState)?.libraryId || null
}

function relayedForId (id) {
  const lib = libraryForId(id)
  return lib ? relayedLibs.has(lib) : false
}

// The person's standing answer per library: 'ask' (never answered), 'allow' or 'deny'.
// Kept in settings beside the toggle, because it is a preference about this phone rather
// than anything the host knows or should know.
function relayConsentFor (libraryId) {
  const all = readSettings().relayConsent || {}
  const v = all[String(libraryId)]
  return ['allow', 'deny'].includes(v) ? v : 'ask'
}

// --- what the relay is carrying, counted on the phone ------------------------
//
// Sampled off each relayed connection's UDX byte counter rather than tallied per chunk:
// one read covers playback, artwork, browse and the HLS segments at once, and no hot path
// grows a counter. The last reading per library is kept so only the DELTA is added.
const RELAY_USAGE_FILE = path.join(DATA_DIR, 'relay-usage.json')
const relayBytesSeen = new Map() // libraryId -> the last counter reading we folded in

// Where each relayed connection's udx stream pointed when we first sampled it. The moment
// it points somewhere else, hyperdht has moved this stream onto a direct path and the
// bytes stop being relayed - see relayStillOn.
const relayAddr = new Map() // libraryId -> 'host:port' as the relay left it

function readRelayUsage () {
  try {
    const u = JSON.parse(fs.readFileSync(RELAY_USAGE_FILE, 'utf8')) || null
    // A total written by an older counter is discarded rather than migrated: version 1
    // kept counting after a connection went direct, so its figure is wrong by an order of
    // magnitude and showing it would be worse than showing nothing.
    return u?.v === relay.USAGE_VERSION ? u : null
  } catch { return null }
}
function writeRelayUsage (u) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(RELAY_USAGE_FILE, JSON.stringify(u))
}

// Read every relayed connection's counter and fold in what is new. Called on a timer
// while the app runs, and once more as a connection closes so its last stretch is not
// lost - a film ending is exactly when the largest unfolded delta exists.
function sampleRelayUsage () {
  let usage = readRelayUsage()
  let changed = false
  for (const libraryId of [...relayedLibs]) {
    const slot = hostConns.get(libraryId)
    const raw = slot?.client?.conn?.rawStream
    const now = Number(raw?.bytesReceived)
    if (!Number.isFinite(now)) continue

    const before = relayBytesSeen.get(libraryId) || 0
    // A reconnect starts a fresh stream at zero. Treat that as a new baseline rather
    // than as a negative delta, which would erase real usage.
    const delta = now >= before ? now - before : now
    relayBytesSeen.set(libraryId, now)
    if (delta > 0) { usage = relay.addUsage(usage, { bytes: delta, libraryId }); changed = true }

    // Then ask whether this connection is STILL relayed. After the fold, not before: the
    // bytes since the last sample were mostly relayed even if the punch has just landed,
    // and a sample every 30s is fine granularity for a monthly figure.
    const addr = raw.remoteHost ? `${raw.remoteHost}:${raw.remotePort}` : null
    const first = relayAddr.get(libraryId) || null
    // The connect-time check again, because a stream may have had no address yet when it
    // ran - and a first sample that recorded a PRIVATE address as "where the relay put it"
    // would then compare equal to itself forever and never clear.
    if (relay.directByAddress(raw.remoteHost)) {
      log('relay:offered-but-direct', { libraryId, host: raw.remoteHost })
      relayedLibs.delete(libraryId)
      relayBytesSeen.delete(libraryId)
      relayAddr.delete(libraryId)
      emit('relay:changed', { libraryId, relayed: false })
    } else if (!first && addr) relayAddr.set(libraryId, addr)
    else if (!relay.relayStillOn(first, addr)) {
      // The punch landed late and hyperdht moved the live stream across. This connection
      // is direct now, so the ceiling lifts, the marker goes and nothing more is counted.
      log('relay:upgraded-to-direct', { libraryId })
      relayedLibs.delete(libraryId)
      relayBytesSeen.delete(libraryId)
      relayAddr.delete(libraryId)
      emit('relay:changed', { libraryId, relayed: false })
    }
  }
  if (changed) writeRelayUsage(usage)
  return usage
}

function setRelayConsent (libraryId, decision) {
  const s = readSettings()
  const all = { ...(s.relayConsent || {}) }
  if (decision === 'ask') delete all[String(libraryId)]
  else all[String(libraryId)] = decision === 'allow' ? 'allow' : 'deny'
  writeSettings({ ...s, relayConsent: all })
  log('relay:consent', { libraryId, decision })
  return all
}

// WHAT THIS DEVICE DECLARES IT CAN PLAY. Starts as the conservative static
// floor; the shell probes the device's REAL decoder list (MediaCodecList lives
// RN-side) and hands it over via capabilities.declare moments after boot, and
// src/capabilities.js turns it into the declaration under its measured-lesson
// rules. A device that under-declares costs the host some engine time; one
// that over-declares costs the viewer a black screen - which is why video
// needs hardware, HEVC needs Main 10, and the player-error retry below exists
// for whatever lies through both.
let capabilities = caps.staticFor(PLATFORM)

// Video codecs this device claimed and its decoder then refused at runtime,
// per item - the honest correction for a lying chip. Consulted by every path
// that describes the device to the host, so the retry's HLS playlist and
// segment calls describe it the same way stream.url did. RAM-only: a fresh
// process retries direct play once and re-learns in one failed attempt.
const refusedVideo = new Map()

// The image subtitle track the viewer chose for an item, to be BURNED into the
// picture by the host - per item, set and cleared by stream.url. Rides the
// capability declaration for the same reason data saver does: one seam covers
// decide, the playlist and every segment, and the host still decides. RAM-only
// on purpose - a fresh process starts unburned, like a fresh playback.
const burnSub = new Map()

const DATA_SAVER_KBPS = 2500

function capsFor (itemId) {
  const bad = refusedVideo.get(itemId)
  const base = bad ? caps.without(capabilities, bad) : capabilities
  const settings = readSettings()
  let out = settings.dataSaver ? { ...base, maxKbps: DATA_SAVER_KBPS } : base
  // The 35mm skin's tone rides the declaration like data saver does: a fact
  // about how this viewer wants to watch, and the host still decides - no
  // engine means the film arrives untinted under the skin's overlay.
  if (settings.playerSkin === 'film' && ['bw', 'sepia'].includes(settings.playerTone)) {
    out = { ...out, tone: settings.playerTone }
  }
  const burn = burnSub.get(itemId)
  out = burn ? { ...out, burnSubtitleId: burn } : out
  // The relay ceiling goes on LAST and is not a preference: the person choosing the
  // quality is not the person paying for the transfer. Data Saver already on means the
  // stricter of the two wins, never the looser.
  return relay.capsWithRelayCeiling(out, relayedForId(itemId))
}

// Downloads describe the device without the viewing session: a subtitle choice
// or a skin's tone made in the player must not bake itself into the copy the
// phone keeps, nor steer the download's decide toward a conversion it does
// not need.
//
// The relay ceiling is inherited here and never actually applies, which is deliberate
// rather than dead code: startDownload REFUSES a relayed download outright (Tim,
// 2026-08-18) because a download is a lasting copy rather than a session, so nothing
// reaches this function over a relay. The inheritance stays so that if the refusal is
// ever relaxed, a relayed download is capped rather than silently uncapped - the safe
// direction for a rule about somebody else's bandwidth.
function capsForDownload (itemId) {
  const { burnSubtitleId, tone, ...rest } = capsFor(itemId)
  return rest
}

// --- IPC --------------------------------------------------------------------

function send (msg) {
  BareKit.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))
}

function emit (name, data) {
  send({ event: name, data })
}

function log (msg, data) {
  console.warn('[worklet]', msg, data ? JSON.stringify(data) : '')
  emit('log', { msg, data })
}

// --- identity ---------------------------------------------------------------

// The device keypair is not a convenience, it is the account. The host's grant is
// keyed to this public key, so losing this file means the phone is a stranger
// again and must re-pair.

function loadIdentity () {
  try {
    const raw = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'))
    return {
      publicKey: b4a.from(raw.publicKey, 'hex'),
      secretKey: b4a.from(raw.secretKey, 'hex')
    }
  } catch {
    const kp = hcrypto.keyPair()
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify({
      publicKey: b4a.toString(kp.publicKey, 'hex'),
      secretKey: b4a.toString(kp.secretKey, 'hex')
    }))
    log('identity:created', {})
    return kp
  }
}

// --- hosts ------------------------------------------------------------------

// The pure bookkeeping lives in the package; this file owns only the disk.

function readHosts () {
  try {
    return H.normalize(JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')))
  } catch {
    return H.empty()
  }
}

function writeHosts (state) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(state))
}

// --- the live client --------------------------------------------------------

const keyPair = loadIdentity()
let hostsState = readHosts()

// N clients, one per paired host (proposal 2026-08-16-merged-libraries §1).
// Each entry is single-flight; all connections come off the one shared DHT.
// An offline host is a caught error at its call site, never a poisoned pool.
const merge = require('./merge')
const hostConns = new Map() // libraryId -> { client, connecting }

function hostRow (libraryId) {
  return hostsState.hosts.find((h) => h.libraryId === libraryId) || null
}

async function connectedLib (libraryId) {
  const row = hostRow(libraryId)
  if (!row) throw new Error('not paired with that library')
  // Said once by the host, remembered here, so the phone stops knocking on a door that
  // has been closed - and so every screen that surfaces this error says the true thing
  // rather than blaming the network.
  if (revokedLibs.has(libraryId)) throw new Error('this library is no longer shared with you')

  let slot = hostConns.get(libraryId)
  if (!slot) { slot = { client: null, connecting: null }; hostConns.set(libraryId, slot) }
  if (slot.client && slot.client.conn && !slot.client.conn.destroyed) return slot.client
  if (slot.connecting) return slot.connecting

  slot.connecting = (async () => {
    if (slot.client) { try { await slot.client.close() } catch {} }
    const c = new Client({ protocol, keyPair, log: (m, d) => log(m, d), relayThrough: relayPolicy })
    await c.connect({ hostKey: z32.decode(row.hostKey), libraryId: row.libraryId })
    // A dial that lands is a grant that exists: whatever this library said last time, it
    // is taking us now. Nothing else clears a revoke, and nothing else should.
    clearRevoked(libraryId)
    // Recorded per library the moment the dial lands, because everything that has to
    // behave differently on a relayed link - the ceiling, the marker, the byte count -
    // asks by library rather than by connection.
    // OFFERED IS NOT USED. peerloom-client raises relayOffered while it builds the dial
    // options, so it says only that the relay was on the table for this attempt - and one
    // aborted hole-punch is enough to put it there. A stream pointing at a private address
    // is a direct connection whatever was offered, and that is the case a phone at home
    // hits: all three libraries on Tim's LAN were marked relayed and capped at 2.5 Mbps
    // over a link that never touched a relay (TCL, 2026-08-21).
    const dialedDirect = relay.directByAddress(c.conn?.rawStream?.remoteHost)
    if (c.relayOffered && dialedDirect) log('relay:offered-but-direct', { libraryId, host: c.conn?.rawStream?.remoteHost || null })
    if (c.relayOffered && !dialedDirect) {
      relayedLibs.add(libraryId)
      // A fresh UDX stream counts from zero, so the baseline is zero. Set explicitly
      // rather than left over from the previous connection, which would swallow this
      // one's first few hundred megabytes.
      relayBytesSeen.set(libraryId, 0)
      // And forget where the last connection pointed, or this one would be judged to have
      // gone direct the moment it is first sampled.
      relayAddr.delete(libraryId)
    } else {
      relayedLibs.delete(libraryId)
      relayBytesSeen.delete(libraryId)
      relayAddr.delete(libraryId)
    }
    // Pushes from EVERY connected host flow to the one UI handler, tagged with
    // their library so a shelf can scope its refetch.
    c.onPush = (m) => {
      emit('host:push', { ...(m && typeof m === 'object' ? m : { value: m }), libraryId })
      // The answer that just arrived is the moment the other copies became stale.
      // Done here rather than in the UI because the screen showing requests is
      // usually not the screen somebody is on.
      if (m?.kind === 'request:resolved' && m.data?.status === 'added') reconcileRequests().catch(() => {})
      // The last frame this library will ever send us.
      if (m?.kind === 'access:revoked') markRevoked(libraryId, m.data?.reason)
    }
    c.conn.once('close', () => {
      // Fold in this connection's last stretch BEFORE forgetting it was relayed - a film
      // ending is exactly when the biggest uncounted delta exists.
      try { sampleRelayUsage() } catch {}
      relayedLibs.delete(libraryId)
      relayBytesSeen.delete(libraryId)
      relayAddr.delete(libraryId)
      emit('host:disconnected', { hostKey: row.hostKey, libraryId })
    })
    slot.client = c
    absentLibs.delete(libraryId)
    emit('host:connected', { hostKey: row.hostKey, libraryId, libraryName: row.libraryName, relayed: relayedLibs.has(libraryId) })
    // A host coming online that the merged index has not heard from yet is
    // catalog we are not showing - rebuild (debounced, and a no-op single-host).
    if (mergedOn() && !contributedLibs.has(libraryId)) buildSoon('host-online')
    return c
  })()

  try {
    return await slot.connecting
  } catch (e) {
    // Recorded rather than only thrown: the shelf has to be able to SAY which library it
    // could not reach, and by the time an empty page reaches it the throw is long gone.
    absentLibs.set(libraryId, e.message)
    throw e
  } finally {
    slot.connecting = null
  }
}

// WHO THIS DEVICE ALREADY GOES BY, asked of a library that already knows.
//
// The name lives on each host, not here - it is what the person claimed and what the
// operator confirmed - so a phone that has never edited its name has nothing of its
// own to introduce. Rather than let a new library file it as "device", ask a library
// that has been answering that question for months. Cached by the identity.get above,
// so this runs once.
//
// Best effort and quiet: if no library answers, the pairing still succeeds and the
// name arrives with the next rename.
async function borrowIdentity () {
  for (const h of hostsState.hosts) {
    try {
      const out = await raced((async () => (await connectedLib(h.libraryId)).request('identity.get', {}))())
      if (out?.userName || out?.deviceName) {
        const name = { userName: out.userName || null, deviceName: out.deviceName || null }
        writeSettings({ ...readSettings(), identity: name })
        return name
      }
    } catch {}
  }
  return null
}

// The active host, for everything that is per-device or per-dashboard rather
// than per-item: identity, devices, pairing, requests.
async function connected () {
  const active = H.activeHost(hostsState)
  if (!active) throw new Error('not paired with any library')
  return connectedLib(active.libraryId)
}

// The host that OWNS an id (item, season, series or art), for everything that
// is per-item: streams, art, watch-state writes. Falls back to the active host
// when ownership is unknown - which is exactly the single-host case.
async function clientForId (id) {
  const lib = owners.get(String(id))
  if (lib && hostRow(lib)) return connectedLib(lib)
  return connected()
}

function closeAllConns () {
  for (const slot of hostConns.values()) {
    if (slot.client) { try { slot.client.close() } catch {} }
    slot.client = null
  }
  hostConns.clear()
}

function connectedLibs () {
  const out = new Set()
  for (const [lib, slot] of hostConns) {
    if (slot.client && slot.client.conn && !slot.client.conn.destroyed) out.add(lib)
  }
  return out
}

// --- the merged library (proposal 2026-08-16-merged-libraries) ---------------
//
// With more than one paired host the browse surface is the MERGED index: every
// reachable host's full catalog, deduped in memory, served without touching
// the wire. One host keeps today's exact pass-through behavior.

const MERGED_DIR = path.join(DATA_DIR, '_merged')
const CATALOGS_FILE = path.join(MERGED_DIR, 'catalogs.json')

let mergedIndex = null
let owners = new Map() // any id (item/season/series) -> owning libraryId
let artOwners = new Map() // artId -> owning libraryId
let contributedLibs = new Set() // libraryIds inside the current index
let buildFlight = null
let buildTimer = null

function mergedOn () { return hostsState.hosts.length > 1 }
function libraryFilter () { return readSettings().libraryFilter || '_all' }

function adoptCatalogs (catalogs) {
  mergedIndex = merge.buildIndex(catalogs)
  owners = new Map()
  artOwners = new Map()
  contributedLibs = new Set()
  for (const c of catalogs) {
    contributedLibs.add(c.libraryId)
    for (const list of [c.movies, c.series, c.episodes]) {
      for (const x of list || []) {
        owners.set(String(x.id), c.libraryId)
        if (x.artId) artOwners.set(String(x.artId), c.libraryId)
        // Season and series ids ride on episodes, so the real-id tree paths
        // route without a separate seasons fetch.
        if (x.seasonId) owners.set(String(x.seasonId), c.libraryId)
        if (x.seriesId) owners.set(String(x.seriesId), c.libraryId)
      }
    }
  }
}

// The cold cache: last run's catalogs, so a launch renders the blend instantly
// and refreshes behind it. Stale is fine - it is the same staleness a single
// host's first paint always had.
try { adoptCatalogs(JSON.parse(fs.readFileSync(CATALOGS_FILE, 'utf8'))) } catch {}

// One host's ENTIRE catalog: movies and series paged to exhaustion, episodes
// walked per series. Personal scale - the Umbrel's 2,746 episodes arrive in a
// handful of pages.
async function fetchCatalog (c, libraryId) {
  const drain = async (params) => {
    const out = []
    let cursor = 0
    for (;;) {
      const page = await c.list({ ...params, limit: 500, cursor })
      out.push(...(page.items || []))
      if (!page.cursor || !(page.items || []).length) break
      cursor = page.cursor
    }
    return out
  }
  const movies = await drain({ type: 'movies' })
  const series = await drain({ type: 'series' })
  const episodes = []
  for (const s of series) {
    episodes.push(...await drain({ type: 'episodes', seriesId: s.id }))
  }
  return { libraryId, movies, series, episodes }
}

async function buildMerged (reason) {
  if (!mergedOn()) return
  if (buildFlight) return buildFlight
  buildFlight = (async () => {
    const cats = []
    await Promise.all(hostsState.hosts.map(async (h) => {
      try {
        cats.push(await raced((async () => {
          const c = await connectedLib(h.libraryId)
          return fetchCatalog(c, h.libraryId)
        })(), 30000))
      } catch (e) {
        // Offline is absence, not failure: the host's items simply are not in
        // this build, and its next connect triggers another one.
        log('merged:host-absent', { library: h.libraryName, err: e.message })
      }
    }))
    if (!cats.length) return
    adoptCatalogs(cats)
    try {
      fs.mkdirSync(MERGED_DIR, { recursive: true })
      fs.writeFileSync(CATALOGS_FILE, JSON.stringify(cats))
    } catch {}
    log('merged:built', { reason, hosts: cats.length, movies: mergedIndex.movies.length, series: mergedIndex.series.length, episodes: mergedIndex.episodes.length })
    emit('merged:changed', { reason })
  })().finally(() => { buildFlight = null })
  return buildFlight
}

function buildSoon (reason) {
  if (!mergedOn()) return
  clearTimeout(buildTimer)
  buildTimer = setTimeout(() => buildMerged(reason).catch((e) => log('merged:build-failed', { err: e.message })), 800)
}

// A fan-out branch must not wait forever. A host that is DOWN fails its
// connect quickly, but a ZOMBIE - a paused container, a machine mid-sleep -
// black-holes the wire and a request to it simply never answers (found on the
// TCL with the Umbrel container paused: the resume offer never appeared,
// because one branch of the fan-out hung the whole Promise.all). Every
// per-host branch races this; the healthy hosts' answers are what the person
// gets.
const FAN_TIMEOUT_MS = 6000
function raced (p, ms = FAN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('host timed out')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

// Ask every paired host the same question, tolerating the offline ones.
// Answers come back in host-list order so unions are stable across calls.
async function fanOut (fn) {
  const rs = await Promise.all(hostsState.hosts.map(async (h) => {
    try { return await raced((async () => fn(await connectedLib(h.libraryId)))()) } catch { return null }
  }))
  return rs.filter(Boolean)
}

// --- an answered ask closes on the other libraries ---------------------------
//
// A request is filed with EVERY reachable host, because none of them has the film
// and any of their owners might add it. Only the host that ANSWERS writes anything
// down, and hosts do not talk to each other by design, so the sibling copies would
// sit in their owners' queues as pending for good - and somebody adds a film
// somebody else already added.
//
// THIS DEVICE IS THE ONLY PARTY THAT KNOWS THE OTHER COPIES EXIST (Tim's call,
// 2026-08-22, proposal 2026-08-22-the-requester-closes-the-ask). It filed them, and
// collapseRequests hands back every per-host (libraryId, id, status) on the row as
// `refs`. So it closes them, which the host now allows because the person who filed
// a row may resolve that row.
//
// ONLY `added` TRAVELS. A decline is one owner's answer about their own library and
// another owner may still want to add the film, so a declined copy is left alone -
// the same rule requestTargets already applies from the other end.
//
// MERGED MODE ONLY, which is where the fan-out happened. Reconciling with merging
// off would dial every paired host to fix an ask that was only ever filed with one.
async function requestRows (args = {}) {
  const rows = []
  await Promise.all(hostsState.hosts.map(async (h) => {
    try {
      const r = await raced((async () => (await connectedLib(h.libraryId)).request('request.list', args))())
      for (const row of r?.items || []) rows.push({ ...row, libraryId: h.libraryId, libraryName: h.libraryName })
    } catch {}
  }))
  return rows
}

async function closeAnsweredElsewhere (items) {
  const targets = merge.answeredElsewhere(items)
  if (!targets.length) return 0
  let ok = 0
  await Promise.all(targets.map(async (t) => {
    try {
      await raced((async () => (await connectedLib(t.libraryId)).request('request.resolve', { id: t.id, status: 'added' }))())
      ok++
    } catch {}
  }))
  // A host that refuses (an older one, still owner-only) or is offline simply stays
  // pending, which is where it was - so a mixed fleet degrades to today's behaviour
  // rather than to an error. Nothing here is retried; the next list tries again.
  if (ok) emit('requests:reconciled', { closed: ok })
  return ok
}

async function reconcileRequests () {
  if (!mergedOn()) return 0
  return closeAnsweredElsewhere(merge.collapseRequests(await requestRows({})))
}

// The merged series row a UI-held seriesId belongs to - the UI navigates with
// real host ids (the primary's), so the tree handlers translate.
function findMergedSeries (seriesId) {
  if (!mergedIndex) return null
  const id = String(seriesId || '')
  return mergedIndex.series.find((s) => s.copies.some((c) => c.id === id)) || null
}

// The device-aware copy rank (proposal §5): a copy this chip direct-plays
// outranks one that would need the host's engine. The declaration is the same
// one capsFor sends; refusals are per-item so a lying chip's correction rides
// along.
function copyRank () {
  return (copy) => {
    const codec = String(copy.videoCodec || '').toLowerCase()
    if (!codec) return 0
    const declared = (capabilities.videoCodecs || []).includes(codec)
    const refused = [...refusedVideo.values()].includes(codec)
    return declared && !refused ? 1 : 0
  }
}

// The merged movie or episode an id belongs to, by any of its copies.
function mergedEntityFor (id) {
  if (!mergedIndex) return null
  const key = String(id || '')
  return mergedIndex.movies.find((m) => m.copies.some((c) => c.id === key)) ||
    mergedIndex.episodes.find((e) => e.copies.some((c) => c.id === key)) || null
}

// Every host holding a copy of an id, each with ITS OWN id for it - the write
// fan-out's address book (phase 2). Series included: a heart on a show must
// land on both hosts that carry it. An id the index does not know falls back
// to its owner alone.
function copyRefs (id) {
  const key = String(id || '')
  const e = mergedEntityFor(key) ||
    (mergedIndex ? mergedIndex.series.find((s) => s.copies.some((c) => c.id === key)) : null)
  if (!e) {
    const lib = owners.get(key)
    return lib ? [{ libraryId: lib, id: key }] : []
  }
  return e.copies.map((c) => ({ libraryId: c.libraryId, id: c.id }))
}

// A write that must land on EVERY copy - a position or a watched mark saved to
// one host of two is a shelf that disagrees with itself depending on which
// server answers first. Best-effort per host; ok when ANY landed, because an
// offline host misses presence pushes exactly the same way and catches up the
// next time the state is written.
async function writeToCopies (id, fn) {
  const refs = copyRefs(id)
  if (refs.length < 2) return fn(await clientForId(id), String(id))
  let ok = 0
  let out = null
  await Promise.all(refs.map(async (ref) => {
    try { out = await raced((async () => fn(await connectedLib(ref.libraryId), ref.id))()); ok++ } catch {}
  }))
  if (!ok) throw new Error('no library reachable for that')
  return out
}

// Which copy of a merged item should actually stream (proposal §5): the filter
// chip's library if reachable, else the best copy for THIS device among the
// reachable ones. Returns the copy's own id - the caller streams THAT. When
// the pick diverges from the asked-for id, resume still records against the
// asked-for id; a cross-host position merge is phase 2.
// LIBRARIES THAT ARE CONNECTED AND STILL CANNOT SERVE A FILM, because the disk their
// films live on has gone. Kept here rather than asked for, because pickCopyId below is
// synchronous and runs on the way into every playback.
//
// Refreshed by library.sources, which the shelf asks on every load. Stale in exactly
// one direction that matters and it is the safe one: a library that has come BACK is
// briefly still avoided, which costs a copy pick and nothing else.
let lostSources = new Set()

function pickCopyId (itemId) {
  if (!mergedOn() || !mergedIndex) return String(itemId)
  const entity = mergedEntityFor(itemId)
  if (!entity || entity.copies.length < 2) return String(itemId)
  // CONNECTED IS NOT THE SAME AS ABLE. A host whose drive has been unplugged answers
  // every request cheerfully and cannot read a single film, so preferring it because
  // it is online picks the one copy that will never play - which is exactly what
  // happened to Tim's Arrival on the Pixel, while the TCL played it only because a
  // download short-circuits above this (2026-08-19).
  const live = new Set([...connectedLibs()].filter((l) => !lostSources.has(l)))
  const prefer = libraryFilter() === '_all' ? null : libraryFilter()
  const pick = merge.bestCopy(entity, live.size ? live : null, prefer, copyRank())
  if (pick && pick.id && pick.id !== String(itemId)) {
    log('merged:copy-pick', { asked: String(itemId).slice(0, 8), picked: String(pick.id).slice(0, 8), library: pick.libraryId })
    return String(pick.id)
  }
  return String(itemId)
}

// --- the shim ---------------------------------------------------------------

// The player and the <img> tags see http://127.0.0.1:<port>/...; the bytes ride
// the P2P connection. PearCinema's vocabulary rides in via the two mappers - the
// host answers { itemId } and { artId }, not the donor's trackId/coverId.
// The UI PAGE IS SERVED FROM THE SHIM, and that is a bug fix rather than a
// nicety: a WebView document injected as a string with a faked base URL loads
// <img> from the shim and then refuses <video> and fetch() against the very same
// URLs (measured on the TCL, 2026-08-14 - instant MediaError code 4, zero
// requests). Served from http://127.0.0.1:<port>/ the page IS the shim's origin
// and everything is same-origin plain http. The shell hands the HTML over IPC at
// boot, because only the shell can read the app's assets.
let uiPage = null

// The film store: write-through for whole plays (LRU, capped) and the home of
// pinned DOWNLOADS, which the store exempts from the cap by design. The shim
// serves a cache hit straight off disk with full Range support - which is the
// entire offline story: no connection needed once a film is here.
// The film cache's ceiling is the person's to set (Settings -> Streaming and downloads),
// so it is read from settings rather than fixed. 2 GB by default: a film is a thousand
// times a song, so PearTune's 512 MB would hold about one and evict it on the next play.
const FILM_CACHE_DEFAULT = 2 * 1024 * 1024 * 1024
const cache = new AudioCache({
  dir: path.join(DATA_DIR, 'films'),
  cap: (() => {
    const v = Number(readSettings().filmCacheCap)
    return Number.isFinite(v) && v >= 0 ? v : FILM_CACHE_DEFAULT
  })(),
  log: (m, d) => log(m, d)
})

// POSTERS ARE KEPT (Tim, 2026-08-18, watching a library load over the relay: "so the
// artwork doesn't have to be downloaded every single time"). It did not have to be built -
// @peerloom/client has carried ArtStore since PearTune's 2026-07-29 work and this app
// simply never passed one, so every cold start re-fetched every visible poster. The
// shim's own cache is 120 entries and dies with the process, which is why restarting
// always looked like a fresh download: it was one.
//
// Keyed by art id AND size, because the grid asks for 120, 350 or 500 depending on
// density - one stored image cannot answer for another size. Tagged with the owning
// library, which is what makes removing a library able to reclaim its art; art ids are
// namespaced per library, so without that tag there is no way back from a file on disk to
// where it came from.
//
// A poster is a few kilobytes and never changes, so this is the cheapest bandwidth saving
// available - and on a relayed connection those are bytes PeerLoom pays for, spent again
// and again on bytes nobody asked to see twice.
// 2500 entries rather than the package's 4000 default, because a film poster is bigger
// than a record sleeve: a 239-film library holding two sizes each is ~500 entries, so this
// covers several libraries with headroom while the worst case stays around a hundred-odd
// megabytes. The store is LRU, so the cap is what bounds it, not a sweep anyone has to run.
const artStore = new ArtStore({ dir: path.join(DATA_DIR, 'art'), maxEntries: 2500 })

const CONTAINER_MIME = {
  matroska: 'video/x-matroska', mkv: 'video/x-matroska', mov: 'video/mp4',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', mpegts: 'video/mp2t'
}

// Live downloads, itemId -> { cancel, got, size }. RAM-only: a killed app
// leaves an uncommitted sink, which the store never marks complete - restart
// and download again.
const downloads = new Map()

async function startDownload (itemId) {
  // A demo film is already on this phone, inside the app. Downloading it would copy
  // 60 MB out of the bundle to sit beside itself - and the UI hides the button in demo
  // mode anyway, so this is the seam that keeps the rule true if it ever forgets to.
  if (isDemoId(itemId)) return { ok: true, already: true }
  if (cache.has(itemId)) {
    cache.setPinned(itemId, true)
    emit('download:done', { itemId })
    return { ok: true, already: true }
  }
  if (downloads.has(itemId)) return { ok: true, running: true }
  // Downloads pick a copy the way play does (phase 3): the bytes come from the
  // best copy for this device, but they are STORED under the id the UI asked
  // for - the download list, the cache check in stream.url and the pin all
  // speak that id, and the shim serves a cache hit by id alone.
  const srcId = pickCopyId(itemId)
  const c = await clientForId(srcId)

  // A download over a relay is refused rather than degraded or waved through - the rule
  // and its wording live in src/relay.js. The check is here rather than in the UI because
  // every path into a download (the button, a retry, a queued item that resumes on
  // reconnect) has to hit the same rule, and only the worklet knows how this library's
  // connection was made.
  const dl = relay.relayDownloadDecision({ relayed: relayedForId(srcId) })
  if (dl.action === 'refuse') {
    log('download:refused-relayed', { itemId, srcId })
    const e = new Error(dl.message)
    e.code = 'ERELAYED'
    throw e
  }

  const item = await c.get({ id: srcId })
  const size = item?.media?.size
  if (!size) throw new Error('this one cannot be downloaded')
  const dlMeta = readDlMeta()
  dlMeta[itemId] = { title: item.title || '', year: item.year || null, part: item.part || null, runtime: item.runtime || null }
  writeDlMeta(dlMeta)
  const mime = CONTAINER_MIME[String(item?.media?.container || '').toLowerCase()] || 'video/mp4'
  // The cache tags the film with the library the bytes CAME from, which in
  // merged mode is the picked copy's host, not whichever library is active.
  const active = { libraryId: owners.get(srcId) || H.activeHost(hostsState)?.libraryId || null }

  // THE HOST DECIDES for downloads exactly as for playback: the same declared
  // capabilities, the same decide(). A transcode verdict - the file busts the
  // data-saver budget, or this device cannot decode it at all - means the
  // download is the CONVERTED film, which is also the only version the phone
  // could have played offline.
  const verdict = await c.request('media.decide', { itemId: srcId, capabilities: capsForDownload(srcId) }).catch(() => null)
  if (verdict?.mode === 'transcode') return startExportDownload({ c, itemId, srcId, item, active })
  const sink = cache.createSink(itemId, { mime, size, library: active?.libraryId || null, pinned: true })
  let got = 0
  let lastEmit = 0
  const p = c.streamTo({ itemId: srcId, offset: 0, length: size }, (chunk) => {
    got += chunk.length
    sink.write(chunk)
    if (got - lastEmit > 16 * 1024 * 1024 || got === size) {
      lastEmit = got
      emit('download:progress', { itemId, got, size })
    }
  })
  downloads.set(itemId, { cancel: () => p.cancel?.(), got: () => got, size })
  p.then(async (out) => {
    downloads.delete(itemId)
    if (out?.cancelled) {
      sink.abort()
      emit('download:failed', { itemId, reason: 'cancelled' })
      return
    }
    const stored = await sink.commit()
    emit(stored ? 'download:done' : 'download:failed', { itemId, reason: stored ? undefined : 'incomplete' })
  }).catch((e) => {
    downloads.delete(itemId)
    sink.abort()
    emit('download:failed', { itemId, reason: e.message })
  })
  emit('download:progress', { itemId, got: 0, size })
  return { ok: true }
}

// The converted-download path: one media.export call streamed whole into the
// cache. No known final size - the host is encoding as it sends - so progress
// runs against an estimate from the encoder's own bitrate ladder, and the sink
// commits whatever cleanly ended. Truncation is the HOST's job to catch: its
// export stream only ends cleanly when ffmpeg exited 0, anything else arrives
// here as a wire error and aborts the sink.
function startExportDownload ({ c, itemId, srcId = itemId, item, active }) {
  // The ladder the host encodes with, capped at the declared budget - the same
  // arithmetic as host/transcode.js bitrateFor/capBitrate, plus audio headroom.
  const w = Number(item?.media?.width) || 0
  const ladder = w >= 1600 ? 6000 : w >= 1000 ? 3000 : 1500
  const budget = Number(capsForDownload(srcId).maxKbps) || 0
  const kbps = (budget ? Math.min(ladder, budget) : ladder) + 200
  const est = Math.max(1, Math.round((kbps * 1000 / 8) * (Number(item?.runtime) || 0)))

  const sink = cache.createSink(itemId, { mime: 'video/mp4', size: null, library: active?.libraryId || null, pinned: true })
  let got = 0
  let lastEmit = 0
  const p = c.request('media.export', { itemId: srcId, capabilities: capsForDownload(srcId) }, {
    stream: true,
    buffer: false,
    onchunk: (chunk) => {
      got += chunk.length
      sink.write(chunk)
      if (got - lastEmit > 16 * 1024 * 1024) {
        lastEmit = got
        // The estimate can undershoot; hold the bar at 99% rather than lie past it.
        emit('download:progress', { itemId, got: Math.min(got, Math.round(est * 0.99)), size: est, approx: true })
      }
    }
  })
  downloads.set(itemId, { cancel: () => p.cancel?.(), got: () => Math.min(got, Math.round(est * 0.99)), size: est, approx: true })
  p.then(async (out) => {
    downloads.delete(itemId)
    if (out?.cancelled) {
      sink.abort()
      emit('download:failed', { itemId, reason: 'cancelled' })
      return
    }
    // The saver was toggled between decide and export - the host refused to
    // convert what needs no converting. Nothing was streamed; take the bytes.
    if (out?.direct) {
      sink.abort()
      startDownload(itemId).catch((e) => emit('download:failed', { itemId, reason: e.message }))
      return
    }
    const stored = await sink.commit()
    emit(stored ? 'download:done' : 'download:failed', { itemId, reason: stored ? undefined : 'incomplete' })
  }).catch((e) => {
    downloads.delete(itemId)
    sink.abort()
    emit('download:failed', { itemId, reason: e.message })
  })
  emit('download:progress', { itemId, got: 0, size: est, approx: true })
  return { ok: true, converting: true }
}

const shim = createAudioShim({
  log: (m, d) => log(m, d),
  cache,
  defaultClient: () => connected(),
  // Multi-host routing (proposal 2026-08-16 §5): the shim resolves each
  // request's OWNING host through the merged index's ownership maps. URLs stay
  // id-only - ids are namespaced by library, so a lookup is enough - and a
  // cache hit never gets this far.
  hostClient: (lib) => connectedLib(lib),
  libForTrack: (id) => owners.get(String(id)) || null,
  libForCover: (id) => artOwners.get(String(id)) || null,
  // Where a poster is kept between runs, and how a stored one is attributed when the URL
  // did not name a library.
  artStore,
  artLibrary: (id) => artOwners.get(String(id)) || null,
  streamParams: (id, extra) => ({ itemId: id, ...extra }),
  artParams: (id, size) => ({ artId: id, size }),
  // THE HLS ROUTES: the playlist is fetched from the host and served with its
  // segment lines rewritten to this shim's own /hlsseg/ path; each segment pull
  // becomes one media.segment call whose bytes stream straight through. The
  // capabilities ride every call because the host is stateless about them.
  extra: async (req, res) => {
    const url = req.url || ''

    // THE DEMO LIBRARY'S OWN ROUTES, ahead of everything else, because every route
    // below this point resolves a host for the id it is given and a demo film has
    // none. Both serve straight out of the app bundle - see src/demo.js for why the
    // films are not copied into the cache the way PearTune's demo tracks are.
    if (demoMode()) {
      const filmId = demo.demoRoute(url)
      if (filmId && demoFilms.has(filmId)) {
        return demo.serveDemoFile({ file: demoFilms.get(filmId), req, res, log: (m, d) => log(m, d) })
      }
      const artId = demo.demoArtRoute(url)
      if (artId && demoArt.has(artId)) {
        return demo.serveDemoFile({ file: demoArt.get(artId), req, res, mime: 'image/jpeg', log: (m, d) => log(m, d) })
      }
    }

    // A REVOKED LIBRARY IS SERVED NOTHING, and this is the only place that can enforce it
    // for bytes the phone already holds: the cache path answers off disk with no host in
    // the way, which is the whole point of a cache and exactly wrong here. Ahead of the
    // built-in routes, so a cache hit never gets the chance.
    if (revokedLibs.size) {
      const stop = revoke.blocked(url, {
        revoked: new Set(revokedLibs.keys()),
        ownerOf: (id) => owners.get(String(id)) || null,
        cacheLibraryOf: (id) => cache.get(String(id))?.library || null
      })
      if (stop) {
        log('revoke:refused', { itemId: stop.id, libraryId: stop.libraryId })
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('this library is no longer shared with you')
        return true
      }
    }

    let m = /^\/hls\/([a-z0-9]+)\.m3u8/i.exec(url)
    if (m) {
      const itemId = m[1]
      try {
        const c = await clientForId(itemId)
        const out = await c.request('media.playlist', { itemId, capabilities: capsFor(itemId) })
        if (!out?.playlist) {
          res.writeHead(409, { 'content-type': 'text/plain' })
          res.end(out?.reason || 'no playlist for this item')
          return true
        }
        const body = out.playlist.replace(/^(\d+)\.ts$/gm, `/hlsseg/${itemId}/$1.ts`)
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' })
        res.end(body)
      } catch (e) {
        log('hls:playlist-failed', { err: e.message })
        try { res.writeHead(502); res.end() } catch {}
      }
      return true
    }

    m = /^\/hlsseg\/([a-z0-9]+)\/(\d+)\.ts/i.exec(url)
    if (m) {
      const itemId = m[1]
      const seq = Number(m[2])
      let dead = false
      let cancelSeg = null
      // A scrub away from a transcoding segment cancels it on the wire, which
      // EPIPEs the host's per-segment ffmpeg and frees the engine slot at the
      // scrub instead of four seconds later (stream-cancel proposal).
      res.on('close', () => { dead = true; try { cancelSeg?.() } catch {} })
      try {
        const c = await clientForId(itemId)
        res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' })
        const p = c.request('media.segment', { itemId, seq, capabilities: capsFor(itemId) }, {
          stream: true,
          buffer: false,
          onchunk: (chunk) => {
            if (dead) return
            try { res.write(chunk) } catch { dead = true }
          }
        })
        cancelSeg = p.cancel || null
        await p
        cancelSeg = null
        if (!dead) { try { res.end() } catch {} }
      } catch (e) {
        log('hls:segment-failed', { seq, err: e.message })
        try { res.destroy() } catch {}
      }
      return true
    }

    return false
  },
  // PearCinema's items carry their facts under `media`, and the MIME comes from
  // the CONTAINER the probe recorded rather than a filename we do not have.
  itemMeta: (t) => ({
    size: t?.media?.size,
    mime: {
      matroska: 'video/x-matroska',
      mkv: 'video/x-matroska',
      mov: 'video/mp4',
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      avi: 'video/x-msvideo',
      mpegts: 'video/mp2t'
    }[String(t?.media?.container || '').toLowerCase()] || 'video/mp4'
  }),
  page: () => uiPage || '<!doctype html><title>PearCinema</title>starting…'
})
let shimPort = null

// --- the method table -------------------------------------------------------

// Invoked UNBOUND by the IPC loop - nothing here may use `this`.
const methods = {
  // The shell hands the WebView's HTML over at boot; the shim serves it at /.
  'ui.page': async ({ html }) => {
    uiPage = String(html || '')
    return { ok: true, port: shimPort }
  },

  'getSettings': async () => readSettings(),
  'setSettings': async (patch) => {
    const next = { ...readSettings(), ...patch }
    writeSettings(next)
    return next
  },

  // The answer to the relay prompt, remembered per library. 'ask' clears it back to
  // never-answered, which is how a sticky deny gets reversed.
  'relay.consent.set': async ({ libraryId, decision }) => ({
    consent: setRelayConsent(libraryId, decision)
  }),

  // Which libraries this phone is currently talking to through a relay, for the marker
  // and for the settings rows that reverse a deny. `relayed` used to mean OFFERED, which
  // read as honest and was not: it flagged every library on a LAN whose first punch
  // aborted. It now means offered AND not provably direct by the stream's own address.
  'relay.status': async () => ({
    useRelay: readSettings().useRelay !== false,
    ownRelayKey: readSettings().ownRelayKey || '',
    // The ceiling IN FORCE for the active library right now, so the phone can be ASKED
    // what it is doing rather than have it inferred from a settings screen that shows a
    // preference the relay overrides. Deliberately routed through the same capsFor an
    // actual stream goes through - a separate calculation here could agree with the
    // screen and disagree with the film. 0 means no ceiling at all.
    maxKbps: Number(capsFor('_status').maxKbps) || 0,
    // Sampled on the way out so the figure a person reads is current rather than up to
    // half a minute stale, which matters most while they are watching something.
    usage: (() => {
      const u = relayedLibs.size ? sampleRelayUsage() : readRelayUsage()
      const month = relay.monthKey()
      const cur = u?.month === month ? u : { month, bytes: 0, byLibrary: {} }
      return { month: cur.month, bytes: cur.bytes || 0, warning: relay.usageWarning(cur) }
    })(),
    libraries: hostsState.hosts.map((h) => ({
      libraryId: h.libraryId,
      libraryName: h.libraryName || null,
      relayed: relayedLibs.has(h.libraryId),
      // WHERE THIS LINK ACTUALLY POINTS, so the claim above can be CHECKED rather than
      // believed. A private address here is a direct connection; the relay is a machine on
      // the public internet. Not drawn anywhere - it exists because "is this relayed?" was
      // unanswerable from outside the phone, and a marker nobody can check is how three
      // libraries on a LAN came to be labelled relayed for a week.
      remote: hostConns.get(h.libraryId)?.client?.conn?.rawStream?.remoteHost || null,
      consent: relayConsentFor(h.libraryId)
    }))
  }),

  // Everything the UI needs to draw its first screen, in one call.
  'app.state': async () => {
    // THE DEMO IS ONE LIBRARY AND IT IS THE ONLY ONE. It is never merged with a real
    // library, because pairing one retires it - so there is nothing here to blend.
    if (demoMode()) {
      return {
        platform: PLATFORM,
        deviceKey: z32.encode(keyPair.publicKey),
        demo: true,
        hosts: [demoHostRow()],
        active: { hostKey: null, libraryName: demoCatalog.name, demo: true },
        merged: { on: false, ready: false, filter: '_all' },
        shimPort
      }
    }
    const active = H.activeHost(hostsState)
    const live = connectedLibs()
    return {
      platform: PLATFORM,
      deviceKey: z32.encode(keyPair.publicKey),
      hosts: hostsState.hosts.map((h) => ({
        ...h,
        active: h.hostKey === hostsState.activeHostKey,
        online: live.has(h.libraryId),
        // Tried and failed, as opposed to merely not connected yet - which is what every
        // host looks like for the first few seconds after a cold start.
        absent: absentLibs.has(h.libraryId),
        // Told to us by the host itself, rather than inferred from a failure to
        // connect - which is what makes it safe to say out loud on screen.
        revoked: revokedLibs.has(h.libraryId),
        inMerge: contributedLibs.has(h.libraryId)
      })),
      active: active ? { hostKey: active.hostKey, libraryName: active.libraryName } : null,
      // The merged view: on with more than one library, filtered by the chip.
      merged: { on: mergedOn(), ready: !!mergedIndex, filter: libraryFilter() },
      shimPort
    }
  },

  // The filter chip (proposal §6): '_all' is the blend, a libraryId narrows to
  // one host. A preference, persisted like the theme.
  'merged.filter': async ({ libraryId }) => {
    const next = { ...readSettings(), libraryFilter: String(libraryId || '_all') }
    writeSettings(next)
    return { filter: next.libraryFilter }
  },

  // A pull-to-refresh for the blend, and the boot hook the UI calls once its
  // first screen is up.
  'merged.refresh': async () => {
    await buildMerged('refresh')
    return { ok: true, ready: !!mergedIndex }
  },

  // --- the demo library ------------------------------------------------------

  // Is the demo on, and does this build even have one? The shell asks at boot: if the
  // answer is on, it resolves the bundled assets and calls demo.start to put the paths
  // back, because an app update moves them and nothing here may hold a stale one.
  'demo.state': async () => ({ on: demoMode(), was: !!readDemoRecord()?.on }),

  // Turn the demo library on, or put it back after a relaunch.
  //
  // Only the SHELL can do the resolving half: the films and posters are bundled assets
  // and turning one into a path a filesystem call can open is native-side work. It
  // hands over `files` and `posters` as { manifest name -> local path }; anything it
  // could not resolve is simply absent, and the catalog leaves that film out rather
  // than listing something that will not play.
  //
  // Idempotent, and it touches NOTHING of a real library: not hosts.json, not the
  // identity keypair, not a grant and not a pairing window.
  'demo.start': async ({ manifest, files = {}, posters = {}, subtitles = {}, restore = false } = {}) => {
    const rec = readDemoRecord()
    // A restore is the shell putting back what was already on. It must not be able to
    // turn the demo on by itself, or a phone that retired the demo when it paired
    // would grow it again at the next launch.
    if (restore && !rec?.on) return { ok: true, on: false }
    if (!manifest || (!Array.isArray(manifest.films) && !Array.isArray(manifest.shows))) {
      throw new Error('The demo library is missing from this build.')
    }
    const stats = demo.statDemoFiles(files)
    const built = demo.buildDemoCatalog(manifest, { ids: protocol.ids, files, stats })
    if (!built.movies.length && !built.episodes.length) {
      throw new Error('The demo library is missing from this build.')
    }
    demoCatalog = built
    demoFilms = new Map([...built.paths].map(([id, name]) => [id, files[name]]).filter(([, p]) => p))
    demoArt = new Map([...built.art].map(([id, name]) => [id, posters[name]]).filter(([, p]) => p))
    demoSubs = new Map([...built.subFiles].map(([id, name]) => [id, subtitles[name]]).filter(([, p]) => p))
    demoState = rec?.state || demo.emptyDemoState()
    saveDemoState()
    log('demo:on', {
      films: built.movies.length,
      episodes: built.episodes.length,
      posters: demoArt.size,
      subtitles: demoSubs.size,
      restore: !!restore
    })
    emit('hosts:changed', {})
    return { ok: true, on: true, films: built.movies.length, episodes: built.episodes.length }
  },

  // Leave the demo by hand, from Settings. Pairing a real library does the same thing
  // without being asked - see `pair`.
  'demo.stop': async () => {
    const r = retireDemo('asked')
    emit('hosts:changed', {})
    return r
  },

  // Pair by the link a QR or a paste carries. On success the host joins the list
  // and becomes active.
  'pair': async ({ link, label = '' }) => {
    const c = new Client({ protocol, keyPair, log: (m, d) => log(m, d) })
    try {
      const paired = await c.pair(link, { label, platform: PLATFORM })
      hostsState = H.addHost(hostsState, {
        hostKey: z32.encode(paired.hostKey),
        libraryId: paired.libraryId,
        libraryName: paired.libraryName
      }, Date.now())
      writeHosts(hostsState)
      // A PAIRING IS A GRANT, so it clears any revoke standing against this library -
      // and it has to be cleared HERE rather than by the next dial, because connectedLib
      // refuses to dial a revoked library at all. Without this a phone that was ever
      // revoked could pair again, be granted by the host, and still be told by itself
      // that the library is not shared with it. Found re-pairing after a revoke on the
      // Simulator, 2026-08-27, and it was a bug before the verdict was ever persisted -
      // persisting it only made it survive a restart.
      clearRevoked(paired.libraryId)
      // TELL IT WHO WE ARE, at once, so the person on the other end sees a name in
      // People rather than "device". Best effort: a library that will not take it is
      // still paired, and the name arrives with the next rename.
      const known = readSettings().identity || await borrowIdentity()
      if (known?.userName || known?.deviceName) {
        try {
          await raced((async () => (await connectedLib(paired.libraryId)).request('identity.set', known))())
        } catch (e) { log('identity:introduce-failed', { libraryId: paired.libraryId, err: e.message }) }
      }
      // THE DEMO HAS DONE ITS JOB. A real library exists now, so the bundled one goes
      // - leaving it in the library menu beside a paired library is exactly what the
      // proposal forbids, and it would show up in the merged view as a fifth "host"
      // nobody paired with.
      retireDemo('paired')
      // A second library just arrived - the merged view wants its catalog.
      buildSoon('paired')
      emit('hosts:changed', {})
      return { libraryId: paired.libraryId, libraryName: paired.libraryName }
    } finally {
      await c.close().catch(() => {})
    }
  },

  'hosts.setActive': async ({ hostKey }) => {
    hostsState = H.setActive(hostsState, hostKey)
    writeHosts(hostsState)
    return { ok: true }
  },

  // Leave: tell the host to drop this device's own grant (best-effort - an
  // unreachable host still gets removed locally; its grant dies of expiry or the
  // operator's hand), then forget it here.
  'hosts.remove': async ({ hostKey }) => {
    const leaving = hostsState.hosts.find((h) => h.hostKey === hostKey)
    if (leaving) {
      try {
        const c = await connected()
        if (z32.encode(c.hostKey) === hostKey || b4a.equals(c.hostKey, z32.decode(hostKey))) {
          await c.deviceLeave().catch(() => {})
        }
      } catch {}
    }
    // removeHost returns { file, removed } - the file is the new state, and
    // assigning the wrapper instead would silently eat the whole host list on
    // the next write. Caught the first time a UI actually called this.
    hostsState = H.removeHost(hostsState, hostKey).file
    writeHosts(hostsState)
    // Its posters go with it. Art ids are namespaced per library, so a file on disk
    // cannot say where it came from - the store's own tag is the only way back, which is
    // exactly why art is tagged when it is written. `untagged` is reported rather than
    // guessed at: art stored before this shipped has no library and stays until the LRU
    // reaches it.
    if (leaving?.libraryId) {
      try {
        const { removed, bytes, untagged } = artStore.removeLibrary(leaving.libraryId)
        log('art:reclaimed', { libraryId: leaving.libraryId, removed, bytes, untagged })
      } catch (e) { log('art:reclaim-failed', { err: e.message }) }
      // And the note that this library revoked us, which is about a row that no longer
      // exists. Pairing clears it too; this stops a verdict outliving the thing it judged.
      clearRevoked(leaving.libraryId)
    }
    // The removed host's connection dies with its row, and the merged index
    // must stop offering its items.
    closeAllConns()
    buildSoon('removed')
    emit('hosts:changed', {})
    return { ok: true }
  },

  // The library. One host: proxied straight through, the UI's vocabulary IS
  // the host's. More than one: served from the merged index (proposal
  // 2026-08-16), which speaks the same vocabulary - the UI cannot tell.
  'library.stats': async () => (demoMode() ? demo.demoStats(demoCatalog) : (await connected()).stats()),

  // WHICH LIBRARIES CANNOT REACH THEIR OWN FILMS, asked of every connected host
  // rather than only the active one.
  //
  // `library.stats` answers for the ACTIVE host, and that is the wrong question the
  // moment a phone has more than one library: the merged shelf shows films from all
  // of them, so the host that lost its drive is very often not the one being asked.
  // Found on Tim's Pixel 2026-08-19 - the dashboard said the drive was gone, the
  // phone said nothing, and the same build on the TCL showed the message correctly
  // because there the affected library happened to be the active one.
  //
  // Named, because "a library cannot reach its films" is not useful when you have
  // three and the shelf is showing all of them at once.
  'library.sources': async () => {
    // Nothing to lose: the demo's films are inside the app, so there is no drive that
    // could go missing and no host that could fail to answer.
    if (demoMode()) return { items: [] }
    const out = []
    const lost = new Set()
    for (const libraryId of connectedLibs()) {
      try {
        const stats = await (await connectedLib(libraryId)).stats()
        if (!stats?.sourceError) continue
        lost.add(libraryId)
        out.push({
          libraryId,
          libraryName: hostRow(libraryId)?.libraryName || 'A library',
          sourceError: stats.sourceError
        })
      } catch {
        // A host that will not answer at all is a DIFFERENT fault, and one the app
        // already shows as a library that is offline. Saying its drive is missing
        // would be inventing a reason.
      }
    }
    // The copy picker reads this on the way into every playback, so the answer is
    // recorded rather than only reported.
    lostSources = lost
    return { items: out }
  },
  // THE DEMO IS THE THIRD BRANCH AND IT IS TAKEN FIRST, in every browse method
  // below: the merged branch needs an index built from hosts and the host branch
  // needs a host, and demo mode has neither.
  'library.list': async (args) => {
    if (demoMode()) return demo.demoList(demoCatalog, args)
    if (!mergedOn() || !mergedIndex) return (await connected()).list(args)
    const type = String(args.type || 'movies')
    if (type === 'movies' || type === 'series') {
      const src = type === 'movies' ? mergedIndex.movies : mergedIndex.series
      const sorted = merge.sortItems(merge.filterByLibrary(src, libraryFilter()), args.sort || 'title', args.order || 'asc')
      const start = Math.max(0, Math.floor(Number(args.cursor) || 0))
      const size = Math.min(500, Math.max(1, Math.floor(Number(args.limit) || 100)))
      const items = sorted.slice(start, start + size)
      return { items, cursor: start + size < sorted.length ? start + size : null, total: sorted.length }
    }
    if (type === 'seasons') {
      const s = findMergedSeries(args.seriesId)
      if (s) return { items: merge.seasonsFor(mergedIndex, s.key, libraryFilter()), cursor: null }
      return (await clientForId(args.seriesId)).list(args)
    }
    if (type === 'episodes') {
      const parsed = merge.parseMergedSeasonId(args.seasonId)
      if (parsed) {
        return { items: merge.episodesFor(mergedIndex, parsed.seriesKey, parsed.seasonNumber, parsed.seasonTitle, libraryFilter()), cursor: null }
      }
      return (await clientForId(args.seasonId || args.seriesId)).list(args)
    }
    return (await connected()).list(args)
  },
  'library.get': async (args) => {
    if (demoMode()) return demo.demoGet(demoCatalog, args.id)
    return (await clientForId(args.id)).get(args)
  },
  'library.search': async (args) => {
    if (demoMode()) return demo.demoSearch(demoCatalog, args.q, Number(args.limit) || 60)
    if (!mergedOn() || !mergedIndex) return (await connected()).search(args)
    const r = merge.searchIndex(mergedIndex, args.q, Number(args.limit) || 60, libraryFilter())
    const items = [...r.movies, ...r.series, ...r.episodes].slice(0, Number(args.limit) || 60)
    return { items }
  },
  // The player's next and previous episode. One host answers structurally; the
  // merged view answers from its own interleaved run, because a series can
  // SPAN hosts and the season-boundary neighbour may live on the other one.
  'library.siblings': async (args) => {
    if (demoMode()) return demo.demoSiblings(demoCatalog, args.id)
    if (!mergedOn() || !mergedIndex) return (await connected()).request('library.siblings', args)
    const id = String(args.id || '')
    const ep = mergedIndex.episodes.find((e) => e.copies.some((c) => c.id === id))
    if (!ep) return (await clientForId(id)).request('library.siblings', args)
    // Scoped by the chip like every other list: with a library picked, the next
    // episode comes from THAT library. On '_all' the run still spans hosts, which is
    // the season-boundary case the merged view exists for.
    const run = merge.seriesRun(mergedIndex, ep.seriesKey, libraryFilter())
    const at = run.findIndex((e) => e.key === ep.key)
    if (at < 0) return { prev: null, next: null }
    return { prev: run[at - 1] || null, next: run[at + 1] || null }
  },

  // Watch state - the same per-person store the dashboard writes. A position
  // lands on EVERY host holding a copy (phase 2), so either server resumes the
  // same film at the same minute; a read takes the freshest answer across
  // them. The Continue shelf is every host's answer concatenated newest-first.
  // In demo mode all of this is kept on the phone: there is no host to keep it, and a
  // demo whose Continue shelf never fills is a demo of a feature the app has. It is
  // written to demo.json and goes when the demo does.
  'resume.set': async (args) => {
    if (demoMode()) {
      const item = demo.demoGet(demoCatalog, args.itemId)
      demoState = demo.setDemoResume(demoState, {
        id: args.itemId,
        positionMs: args.positionMs,
        runtime: item?.runtime,
        ended: !!args.ended
      })
      saveDemoState()
      return { ok: true }
    }
    return writeToCopies(args.itemId, (c, id) => c.request('resume.set', { ...args, itemId: id }))
  },
  'resume.get': async (args) => {
    if (demoMode()) return demo.demoResume(demoState, args.itemId)
    const refs = copyRefs(args.itemId)
    if (refs.length < 2) return (await clientForId(args.itemId)).request('resume.get', args)
    let best = { resume: null }
    await Promise.all(refs.map(async (ref) => {
      try {
        const r = await raced((async () => (await connectedLib(ref.libraryId)).request('resume.get', { ...args, itemId: ref.id }))())
        if (r?.resume && (!best.resume || (r.resume.playedAt || 0) > (best.resume.playedAt || 0))) best = r
      } catch {}
    }))
    return best
  },
  'resume.list': async (args) => {
    if (demoMode()) return demo.demoResumeShelf(demoCatalog, demoState, Number(args.limit) || 20)
    if (!mergedOn()) return (await connected()).request('resume.list', args)
    // Tagged with the library that answered, because collapsing needs to know where a
    // row came from - both to honour the chip and to fold the same film watched on two
    // libraries into the one card it is everywhere else.
    const rows = []
    await Promise.all(hostsState.hosts.map(async (h) => {
      try {
        const r = await raced((async () => (await connectedLib(h.libraryId)).request('resume.list', args))())
        for (const it of r?.items || []) rows.push({ ...it, libraryId: h.libraryId })
      } catch {}
    }))
    const items = merge.collapseResume(rows, mergedIndex, libraryFilter())
    return { items: items.slice(0, Number(args.limit) || 20) }
  },
  // Emptying the shelf empties EVERY library's, because the shelf it empties is
  // every library's answers put together - clearing one and leaving the other
  // would refill the row the moment it reloaded.
  'resume.clear': async (args) => {
    if (demoMode()) {
      const cleared = Object.keys(demoState.resume || {}).length
      demoState = { ...demoState, resume: {} }
      saveDemoState()
      return { ok: true, cleared }
    }
    if (!mergedOn()) return (await connected()).request('resume.clear', args)
    const rows = await fanOut((c) => c.request('resume.clear', args))
    if (!rows.length) throw new Error('no library reachable to clear')
    return { ok: true, cleared: rows.reduce((n, r) => n + (Number(r?.cleared) || 0), 0) }
  },
  'watched.set': async (args) => {
    if (demoMode()) {
      demoState = demo.setDemoWatched(demoState, args.itemId, args.watched !== false)
      saveDemoState()
      return { ok: true }
    }
    return writeToCopies(args.itemId, (c, id) => c.request('watched.set', { ...args, itemId: id }))
  },
  'watched.list': async (args) => {
    if (demoMode()) return { items: [...(demoState.watched || [])] }
    if (!mergedOn()) return (await connected()).request('watched.list', args)
    const rows = await fanOut((c) => c.request('watched.list', args))
    return { items: [...new Set(rows.flatMap((r) => r?.items || []))] }
  },

  // The watchlist: a heart lands on every host holding a copy (phase 2), the
  // list is the union.
  'fav.set': async (args) => {
    if (demoMode()) {
      demoState = demo.setDemoFav(demoState, args.id, args.on !== false)
      saveDemoState()
      return { ok: true }
    }
    return writeToCopies(args.id, (c, id) => c.request('fav.set', { ...args, id }))
  },
  'fav.list': async (args) => {
    if (demoMode()) return demo.demoFavShelf(demoCatalog, demoState)
    if (!mergedOn()) return (await connected()).request('fav.list', args)
    const rows = await fanOut((c) => c.request('fav.list', args))
    const seen = new Set()
    const items = []
    for (const r of rows) {
      for (const i of r?.items || []) {
        const k = String(i.id)
        if (seen.has(k)) continue
        seen.add(k)
        items.push(i)
      }
    }
    return { items }
  },
  // Requests across the blend (phase 2, PearTune's shipped shape): an ask is
  // filed with EVERY reachable host - none of them has the film, so any of
  // their owners might add it - and the lists collapse the per-host rows to
  // one ask carrying the best status. The owner's queue folds the same rows
  // pending-first, because that view is a to-do list and one library resolved
  // must not hide the copies that are not.
  // ASKING FOR A FILM NEEDS SOMEBODY TO ASK. A demo library has no owner, so the
  // request screens are empty and the ask is refused in a sentence rather than
  // failing at a connection that was never going to exist.
  'request.add': async (args) => {
    if (demoMode()) throw new Error('There is nobody to ask yet. Connect a library first.')
    if (!mergedOn()) return (await connected()).request('request.add', args)
    const rs = await fanOut((c) => c.request('request.add', args))
    if (!rs.length) throw new Error('no library reachable to ask')
    return rs[0]
  },
  'request.list': async (args) => {
    if (demoMode()) return { items: [] }
    if (!mergedOn()) return (await connected()).request('request.list', args)
    const items = merge.collapseRequests(await requestRows(args))
    // FIRE AND FORGET, and after the answer rather than before it: the collapsed
    // row already reads `added` here, so nobody is waiting on this. It is the
    // OTHER libraries' owners who are still looking at a pending ask, and this is
    // what heals them on a device that was asleep when the answer arrived.
    closeAnsweredElsewhere(items).catch(() => {})
    return { items }
  },
  'request.remove': async ({ id, refs }) => {
    if (!mergedOn()) return (await connected()).request('request.remove', { id })
    const targets = merge.requestTargets({ refs, id }, { pendingOnly: false, fallbackLibraryId: owners.get(String(id)) })
    let ok = 0
    await Promise.all(targets.map(async (t) => {
      try { await raced((async () => (await connectedLib(t.libraryId)).request('request.remove', { id: t.id }))()); ok++ } catch {}
    }))
    if (!ok) throw new Error('no library reachable for that')
    return { ok: true }
  },
  'request.all': async (args) => {
    if (demoMode()) return { items: [] }
    if (!mergedOn()) return (await connected()).request('request.all', args)
    const rows = []
    await Promise.all(hostsState.hosts.map(async (h) => {
      try {
        const r = await raced((async () => (await connectedLib(h.libraryId)).request('request.all', args))())
        for (const row of r?.items || []) rows.push({ ...row, libraryId: h.libraryId, libraryName: h.libraryName })
      } catch {}
    }))
    return { items: merge.collapseRequests(rows, { pendingWins: true }) }
  },
  'request.resolve': async ({ id, status, refs }) => {
    if (!mergedOn()) return (await connected()).request('request.resolve', { id, status })
    // Only the copies still PENDING: an added fan-out must never rewrite a
    // copy another owner already declined.
    const targets = merge.requestTargets({ refs, id }, { fallbackLibraryId: owners.get(String(id)) })
    let ok = 0
    await Promise.all(targets.map(async (t) => {
      try { await raced((async () => (await connectedLib(t.libraryId)).request('request.resolve', { id: t.id, status }))()); ok++ } catch {}
    }))
    if (!ok) throw new Error('no library reachable for that')
    return { ok: true }
  },
  // --- casting to a television (video-deltas §5) ---------------------------
  //
  // The HOST does the casting - the phone only says which film on which TV.
  // Every target carries the library whose Home Assistant reported it, because
  // the film must stream FROM that host: a cast URL minted by one server
  // cannot serve another server's file. That is also the merged-mode copy-pick
  // rule in cast.play below.
  'cast.list': async (args) => {
    const out = { enabled: false, targets: [], active: [] }
    // Asked FOR a film, only libraries holding a copy answer - a television
    // whose host cannot serve the film is a button that ends in an error.
    let libsWithCopy = null
    if (args?.itemId && mergedOn() && mergedIndex) {
      const entity = mergedEntityFor(String(args.itemId))
      if (entity) libsWithCopy = new Set(entity.copies.map((c) => c.libraryId))
    }
    const hosts = hostsState.hosts.filter((h) => !libsWithCopy || libsWithCopy.has(h.libraryId))
    await Promise.all(hosts.map(async (h) => {
      try {
        const r = await raced((async () => (await connectedLib(h.libraryId)).request('cast.list', {}))())
        if (r?.enabled) out.enabled = true
        for (const t of r?.targets || []) out.targets.push({ ...t, libraryId: h.libraryId, libraryName: h.libraryName })
        for (const a of r?.active || []) out.active.push({ ...a, libraryId: h.libraryId, libraryName: h.libraryName })
      } catch {}
    }))
    return out
  },
  'cast.play': async (args) => {
    const lib = args.libraryId || null
    // THE COPY PICK, merged phase 3's last sliver: the television belongs to
    // one host's Home Assistant, so the copy that streams must be THAT host's
    // own - the blend offers only televisions from libraries holding a copy,
    // and this resolves the blended id to that library's file.
    let id = String(args.itemId)
    if (mergedOn() && mergedIndex && lib) {
      const entity = mergedEntityFor(id)
      if (entity) {
        const copy = entity.copies.find((c) => c.libraryId === lib)
        if (!copy) throw new Error('that library does not hold this film')
        id = String(copy.id)
      }
    }
    const c = lib ? await connectedLib(lib) : await connected()
    return c.request('cast.play', { entityId: args.entityId, itemId: id, at: Number(args.at) || 0 })
  },
  'cast.stop': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.stop', { entityId: args.entityId })
  },
  'cast.pause': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.pause', { entityId: args.entityId })
  },
  'cast.resume': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.resume', { entityId: args.entityId })
  },
  'cast.seek': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.seek', { entityId: args.entityId, deltaMs: args.deltaMs })
  },
  'cast.state': async (args) => {
    const c = args.libraryId ? await connectedLib(args.libraryId) : await connected()
    return c.request('cast.state', { entityId: args.entityId })
  },
  // Nobody else is in a demo library, and nothing in it could be revoked - the films
  // are inside the app. Empty rather than an error, so the People screen renders.
  'device.list': async (args) => (demoMode() ? { items: [] } : (await connected()).request('device.list', args)),
  'device.revoke': async (args) => (await connected()).request('device.revoke', args),
  'identity.get': async (args) => {
    // There is nobody to be, in a library with no server. The names typed at
    // onboarding are still held locally and still shown, but nothing has confirmed
    // them and nothing here is an owner - a demo must not hand out owner-only screens.
    if (demoMode()) {
      const held = readSettings().identity || {}
      return {
        userName: held.userName || null,
        deviceName: held.deviceName || null,
        belongsTo: null,
        confirmed: false,
        owner: false,
        libraryName: demoCatalog.name,
        demo: true
      }
    }
    const out = await (await connected()).request('identity.get', args)
    // The host reports its CURRENT library name here - that is how a dashboard
    // rename reaches an already-paired phone. Fold it back into the stored host
    // row, which was captured at pair time and is never otherwise refreshed
    // (renameHost is idempotent, so the steady state costs nothing). Without
    // this, two libraries both showing "My Library" is the norm, not the edge.
    // SEED THE LOCAL COPY from whatever a library already calls us. Without this the
    // introduction below has nothing to say until the person happens to edit their
    // name, which for an existing phone is never - the fix would ship and change
    // nothing (caught pairing a guest on the TCL right after building it, 2026-08-22).
    if (out?.userName || out?.deviceName) {
      const held = readSettings().identity
      if (held?.userName !== out.userName || held?.deviceName !== out.deviceName) {
        writeSettings({ ...readSettings(), identity: { userName: out.userName || null, deviceName: out.deviceName || null } })
      }
    }
    const active = H.activeHost(hostsState)
    if (active && out?.libraryName && out.libraryName !== active.libraryName) {
      hostsState = H.renameHost(hostsState, active.hostKey, out.libraryName)
      writeHosts(hostsState)
      emit('hosts:changed', {})
    }
    return out
  },
  // WHO YOU ARE IS NOT PER LIBRARY, and it used to be sent to the active one only.
  //
  // So a friend who pairs with somebody else's library arrives as `label: "device"`,
  // `claimedUser: null` - the owner sees an anonymous device in People and an
  // unattributed ask in their queue, and cannot tell who they just let in (found
  // walking the app as a guest, 2026-08-22). A name set on one library never reached
  // any other either.
  //
  // Kept locally as well as sent, because a library paired LATER has to be told too -
  // see `pair` below. It is the same two strings the person typed; nothing else about
  // them is stored here.
  'identity.set': async (args) => {
    const name = { userName: args?.userName ?? null, deviceName: args?.deviceName ?? null }
    writeSettings({ ...readSettings(), identity: name })
    // In the demo there is nobody to tell. The name is still kept, and it is the one a
    // later pairing introduces this phone with - which is the whole reason onboarding
    // asks before the demo starts rather than after.
    if (demoMode()) return { ...name, belongsTo: null, confirmed: false, owner: false, demo: true }
    const out = await (await connected()).request('identity.set', args)
    // Best effort to the rest: a library that is off hears it on the next rename, and
    // the local copy is what a fresh pairing carries.
    if (mergedOn()) {
      await Promise.all(hostsState.hosts.map(async (h) => {
        if (h.libraryId === H.activeHost(hostsState)?.libraryId) return
        try { await raced((async () => (await connectedLib(h.libraryId)).request('identity.set', args))()) } catch {}
      }))
    }
    return out
  },
  // A picture is kept by the library, so in the demo there is nowhere to put one. Said
  // in a sentence rather than left to fail as "not paired with any library".
  'avatar.set': async (args) => {
    if (demoMode()) throw new Error('Your picture is kept by the library you are in. Connect one first.')
    return (await connected()).request('avatar.set', args)
  },

  // Downloads: pin a film for offline. The bytes ride the same media.stream
  // chokepoint as playback; the shim then serves the finished file off disk,
  // connection or none.
  'download.start': async ({ itemId }) => startDownload(String(itemId || '')),
  'download.cancel': async ({ itemId }) => {
    downloads.get(String(itemId || ''))?.cancel()
    return { ok: true }
  },
  'download.remove': async ({ itemId }) => {
    const id = String(itemId || '')
    cache.remove(id)
    cache.save()
    const dlMeta = readDlMeta()
    if (dlMeta[id]) { delete dlMeta[id]; writeDlMeta(dlMeta) }
    emit('download:removed', { itemId: id })
    return { ok: true }
  },
  'download.list': async () => {
    const dlMeta = readDlMeta()
    const items = Object.entries(cache.index || {})
      .filter(([, e]) => e.pinned)
      .map(([id, e]) => ({ itemId: id, size: e.size || 0, mime: e.mime || null, ...(dlMeta[id] || {}) }))
    const running = [...downloads.entries()].map(([id, d]) => ({ itemId: id, got: d.got(), size: d.size, approx: !!d.approx }))
    return { items, running }
  },

  // --- storage (PearTune's shape, ported 2026-08-18 at Tim's ask) -----------
  //
  // What this phone is holding and what it is allowed to hold. Films and artwork are
  // counted separately because they behave differently: films are big, deliberate and
  // pinned by the person, artwork is small, automatic and only ever a re-download.
  'storage.stats': async () => ({
    films: { bytes: cache.totalBytes(), count: cache.count(), cap: cache.cap || 0 },
    art: { bytes: artStore.totalBytes(), count: artStore.count() }
  }),

  // The cap is persisted so it survives a restart, and applied immediately - AudioCache
  // evicts on setCap, so lowering it takes effect now rather than at the next download.
  'storage.setCap': async ({ bytes }) => {
    const cap = Math.max(0, Number(bytes) || 0)
    writeSettings({ ...readSettings(), filmCacheCap: cap })
    cache.setCap(cap)
    log('storage:cap', { cap })
    return { cap, films: { bytes: cache.totalBytes(), count: cache.count() } }
  },

  // Everything not pinned. A DOWNLOAD is pinned, so this reclaims what playback left
  // behind without touching a film somebody deliberately keeps for a flight.
  'storage.clearFilms': async () => {
    let removed = 0
    for (const [id, e] of Object.entries(cache.index || {})) {
      if (e.pinned) continue
      cache.remove(id)
      removed++
    }
    cache.save()
    log('storage:cleared-films', { removed })
    return { removed, films: { bytes: cache.totalBytes(), count: cache.count() } }
  },

  // Artwork is kept until its library goes, which is predictable and never re-downloads
  // on a timer. But a source CAN change a film's poster without changing its art id, and
  // then the old picture would be right forever - so this is the escape hatch. The whole
  // store rather than one film, because "which poster is wrong" is not something the app
  // can know. Costs a re-download, not anything anybody chose to keep.
  'storage.refreshArt': async () => {
    artStore.clear()
    // The store is only one of TWO caches in front of a poster: the shim's own map dies
    // with the process, and the WebView's HTTP cache answers max-age hits without the
    // request ever reaching the shim. refreshArt bumps the generation in the art path,
    // which is the only thing that makes the WebView miss - so the UI must take the new
    // base back or nothing visible happens.
    const base = shim.refreshArt()
    log('storage:refreshed-art', {})
    return { base, art: { bytes: artStore.totalBytes(), count: artStore.count() } }
  },

  // WHAT SUBTITLES THE FILE CARRIES, which only the host holding that file can
  // answer. `clientForId` rather than `connected()` for the same reason
  // `library.get` uses it: in the merged view the item on screen belongs to
  // whichever library holds it, and that is not necessarily the host this phone
  // happens to have a connection to. Asked of the wrong host it answers an empty
  // list rather than an error, so the bug reads as "this film has no subtitles"
  // (found 2026-08-21 on a four-host bench: a Mac film opened while the phone was
  // connected to the Windows host said None, and the Mac's own dashboard said
  // three).
  // The demo's own caption file, listed the way a folder library lists a sidecar .srt.
  // Only the one film has one, and the rest answer with an empty list rather than an
  // error - the demo has no host that could extract an embedded track.
  'subtitle.list': async (args) => (
    demoMode() ? demo.demoSubtitles(demoCatalog, args.itemId) : (await clientForId(args.itemId)).request('subtitle.list', args)
  ),

  // The track's text, as WebVTT. The host STREAMS it (subtitle bytes ride the
  // same chokepoint as film bytes); buffered here because a subtitle file is
  // tens of kilobytes and the shell wants one string, not a byte feed.
  'subtitle.get': async (args) => {
    // The demo's caption file, read straight off the bundle. Handed over AS IT IS, the
    // same as a folder library hands over a sidecar .srt - the shell's parser takes
    // either a comma or a full stop before the milliseconds, so SubRip needs no
    // conversion and there is no second format-handling path to keep honest.
    if (demoMode()) {
      // The track has to belong to the item that asked for it, which is what
      // demoSubtitleFile answers; the local path then comes from the shell's map.
      const owned = demo.demoSubtitleFile(demoCatalog, args.itemId, args.subtitleId)
      const file = owned ? demoSubs.get(String(args.subtitleId)) : null
      if (!file) {
        log('demo:subtitle-unknown', { itemId: args.itemId, subtitleId: args.subtitleId, owned: owned || null })
        throw new Error('no such subtitle')
      }
      // Logged because a caption track that silently fails to load looks exactly like a
      // film with no captions: the picker offers the track, the choice is accepted and
      // nothing is ever drawn. One line here is the difference between a bug report and
      // a shrug.
      const text = fs.readFileSync(file, 'utf8')
      log('demo:subtitle', { file, bytes: text.length })
      return { vtt: text }
    }
    const buf = await (await clientForId(args.itemId)).request('subtitle.get', args, { stream: true })
    return { vtt: b4a.toString(buf) }
  },

  // The shell hands over the raw MediaCodecList probe at boot; the mapper's
  // policy turns it into this device's declaration. A missing or broken probe
  // changes nothing - the static floor stands, and under-declaring only costs
  // the host some engine time.
  'capabilities.declare': async ({ probe }) => {
    const mapped = caps.fromProbe(probe)
    if (mapped) capabilities = mapped
    log('capabilities:declared', { fromProbe: !!mapped, ...capabilities })
    return { ok: true, fromProbe: !!mapped, capabilities }
  },

  // Where the player should point - and WHICH KIND of stream that is. The host
  // decides from this device's declared capabilities: direct play gets the
  // byte-range shim URL; a codec this device does not declare gets the HLS
  // playlist whose segments the host transcodes on demand. The player cannot
  // tell it is being helped.
  //
  // `deviceRefusedVideo` is the UI's retry after the native player errored on
  // a direct-played file: the decoder just proved the declaration wrong for
  // this item's video codec, so the device re-describes itself without it and
  // the host decides again - usually landing on transcode. The client still
  // never ASKS for a mode; it only tells the truth about itself.
  'stream.url': async ({ itemId, deviceRefusedVideo = false, burnSubtitleId = null }) => {
    // A DEMO FILM NEEDS NOTHING: no host, no capability negotiation, no relay consent
    // and no network of any kind. It is H.264 in MP4 already - which is a constraint on
    // what may ship in the demo rather than a lucky fact - so it plays directly, from
    // the app's own bundle, in airplane mode. That is the honest test of this feature.
    if (demoMode() && demoFilms.has(String(itemId))) {
      return { url: `http://127.0.0.1:${shimPort}/demo/${itemId}`, mode: 'direct' }
    }
    // A downloaded film needs no host at all - the shim serves it off disk
    // with full Range support. Checked BEFORE connecting, or offline playback
    // would die asking a host it does not need. A burn request skips the disk
    // copy on purpose: the download has no subtitles pressed in, so the burned
    // stream must come from the host. Checked against the id the UI asked for,
    // BEFORE any copy pick - the download lives under that id.
    // BEFORE THE CACHE, or a revoked library's downloads would open with no host asked
    // and no error shown. The shim refuses the bytes too; this is what makes the refusal
    // a sentence rather than a player that stalls.
    const owner = libraryForId(itemId)
    if (owner && revokedLibs.has(owner)) {
      throw new Error('this library is no longer shared with you')
    }

    if (!deviceRefusedVideo && !burnSubtitleId && cache.has(String(itemId))) {
      burnSub.delete(itemId)
      return { url: shim.urlFor(itemId), mode: 'download' }
    }

    // The merged copy pick (proposal §5): a film held by two hosts plays from
    // the one that suits this device. A burn request stays on the asked-for
    // copy - the subtitle id the person chose belongs to THAT file.
    if (!burnSubtitleId) itemId = pickCopyId(itemId)

    // The burn choice is per playback, so EVERY stream.url settles it: a call
    // that asks for a track sets it, any other call clears it - starting a
    // film fresh must never inherit the last session's burned subtitles.
    if (burnSubtitleId) burnSub.set(itemId, String(burnSubtitleId))
    else burnSub.delete(itemId)
    const c = await clientForId(itemId)

    // THE CONSENT GATE, and it sits here rather than in the UI for the same reason the
    // download refusal does: every way into playback comes through stream.url, and only
    // the worklet knows how this library's connection was made. Browsing got the person
    // this far unprompted by design - kilobytes cross the relay freely, a film asks once.
    const lib = libraryForId(itemId)
    const verdictRelay = relay.relayVideoDecision({
      relayed: relayedForId(itemId),
      consent: relayConsentFor(lib)
    })
    if (verdictRelay === 'refuse') throw new Error(relay.RELAY_PLAY_REFUSAL)
    if (verdictRelay === 'ask') {
      // No url comes back with this: a caller that ignored the flag would otherwise play
      // the film anyway, which is the whole thing the gate exists to prevent.
      log('relay:consent-needed', { itemId, libraryId: lib })
      return {
        needsRelayConsent: true,
        libraryId: lib,
        libraryName: hostRow(lib)?.libraryName || null
      }
    }

    if (deviceRefusedVideo) {
      const item = await c.get({ id: itemId }).catch(() => null)
      const bad = item?.media?.videoCodec
      if (bad) {
        refusedVideo.set(itemId, bad)
        log('stream:device-refused', { itemId, videoCodec: bad })
      }
    }
    // Logged at the moment it is DECIDED, not asserted from settings: this is the line a
    // field report needs to answer "was the film actually capped", and the phone's own
    // Settings screen cannot answer it because the ceiling is forced past a preference.
    const sending = capsFor(itemId)
    if (sending.maxKbps) log('stream:capped', { itemId, maxKbps: sending.maxKbps, relayed: relayedForId(itemId), dataSaver: !!readSettings().dataSaver })
    const verdict = await c.request('media.decide', { itemId, capabilities: sending }).catch(() => null)
    // WHICH TRANSPORT THIS PLAYER TAKES, decided in src/capabilities.js beside what it can
    // open, because it is the same kind of fact and the two have to agree. A transcode is
    // always a playlist; a remux is one on iOS and direct play on Android.
    if (caps.wantsPlaylist(verdict?.mode, PLATFORM)) {
      return { url: `http://127.0.0.1:${shimPort}/hls/${itemId}.m3u8`, mode: verdict.mode }
    }
    return { url: shim.urlFor(itemId), mode: verdict?.mode || 'direct' }
  },
  'art.base': async () => ({ base: shim.artBase() }),

  'ping': async () => (await connected()).ping()
}

// --- IPC loop ---------------------------------------------------------------

let buf = ''
BareKit.IPC.on('data', async (data) => {
  buf += b4a.toString(data)
  const lines = buf.split('\n')
  buf = lines.pop()

  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    const fn = methods[msg.method]
    if (!fn) {
      send({ id: msg.id, error: `unknown method: ${msg.method}` })
      continue
    }

    try {
      const result = await fn(msg.args || {})
      send({ id: msg.id, result })
    } catch (e) {
      log('method:failed', { method: msg.method, err: e.message })
      send({ id: msg.id, error: e.message })
    }
  }
})

// The shim listens at boot so the UI can compose URLs from its very first state
// read. Port 0: the OS picks, and the URLs are only valid for this process's
// life - which is exactly the lifetime of the WebView that holds them.
shim.listen().then((port) => {
  shimPort = port
  emit('shim:ready', { port })
}).catch((e) => log('shim:failed', { err: e.message }))

// The blend refreshes itself at boot: the cold cache above painted instantly,
// this fetches what changed overnight. A single-host install no-ops.
buildSoon('boot')

// The relay meter. Half a minute is fine granularity for a monthly figure and costs a
// property read per relayed connection - the loop does nothing at all when none are.
// Unref'd: a counter must never be the reason a phone stays awake.
const relayMeter = setInterval(() => {
  if (relayedLibs.size === 0) return
  try { sampleRelayUsage() } catch (e) { log('relay:usage-failed', { err: e.message }) }
}, 30000)
if (relayMeter.unref) relayMeter.unref()

log('worklet:loaded', { platform: PLATFORM })
emit('ready', {})
