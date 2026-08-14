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

const DATA_DIR = Bare.argv[0] || '/tmp/pearcinema'
const PLATFORM = Bare.argv[1] || 'android'

const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')

const protocol = createProtocol({ app: 'pearcinema', displayName: 'PearCinema' })

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

// ONE client at a time for the milestone: the active host. The multi-host merged
// pool is PearTune's later shape and arrives when the app has more than one
// screen to show it on.
let client = null
let connecting = null

async function connected () {
  const active = H.activeHost(hostsState)
  if (!active) throw new Error('not paired with any library')

  if (client && client.conn && !client.conn.destroyed) return client
  if (connecting) return connecting

  connecting = (async () => {
    if (client) { try { await client.close() } catch {} }
    client = new Client({ protocol, keyPair, log: (m, d) => log(m, d) })
    await client.connect({ hostKey: z32.decode(active.hostKey), libraryId: active.libraryId })
    client.onPush = (m) => emit('host:push', m)
    client.conn.once('close', () => emit('host:disconnected', { hostKey: active.hostKey }))
    emit('host:connected', { hostKey: active.hostKey, libraryName: active.libraryName })
    return client
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
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

const shim = createAudioShim({
  log: (m, d) => log(m, d),
  defaultClient: () => connected(),
  streamParams: (id, extra) => ({ itemId: id, ...extra }),
  artParams: (id, size) => ({ artId: id, size }),
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

  // Everything the UI needs to draw its first screen, in one call.
  'app.state': async () => {
    const active = H.activeHost(hostsState)
    return {
      platform: PLATFORM,
      deviceKey: z32.encode(keyPair.publicKey),
      hosts: hostsState.hosts.map((h) => ({ ...h, active: h.hostKey === hostsState.activeHostKey })),
      active: active ? { hostKey: active.hostKey, libraryName: active.libraryName } : null,
      shimPort
    }
  },

  // Pair by the link a QR or a paste carries. On success the host joins the list
  // and becomes active.
  'pair': async ({ link, label = 'phone' }) => {
    const c = new Client({ protocol, keyPair, log: (m, d) => log(m, d) })
    try {
      const paired = await c.pair(link, { label, platform: PLATFORM })
      hostsState = H.addHost(hostsState, {
        hostKey: z32.encode(paired.hostKey),
        libraryId: paired.libraryId,
        libraryName: paired.libraryName
      }, Date.now())
      writeHosts(hostsState)
      emit('hosts:changed', {})
      return { libraryId: paired.libraryId, libraryName: paired.libraryName }
    } finally {
      await c.close().catch(() => {})
    }
  },

  'hosts.setActive': async ({ hostKey }) => {
    hostsState = H.setActive(hostsState, hostKey)
    writeHosts(hostsState)
    if (client) { try { await client.close() } catch {} ; client = null }
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
    hostsState = H.removeHost(hostsState, hostKey)
    writeHosts(hostsState)
    if (client) { try { await client.close() } catch {} ; client = null }
    emit('hosts:changed', {})
    return { ok: true }
  },

  // The library, proxied. The UI's vocabulary IS the host's - no translation
  // layer to drift.
  'library.stats': async () => (await connected()).stats(),
  'library.list': async (args) => (await connected()).list(args),
  'library.get': async (args) => (await connected()).get(args),
  'library.search': async (args) => (await connected()).search(args),

  // Watch state - the same per-person store the dashboard writes, which is the
  // claim this app exists to prove: a laptop and a phone sharing one position.
  'resume.set': async (args) => (await connected()).request('resume.set', args),
  'resume.get': async (args) => (await connected()).request('resume.get', args),
  'resume.list': async (args) => (await connected()).request('resume.list', args),
  'watched.set': async (args) => (await connected()).request('watched.set', args),
  'watched.list': async (args) => (await connected()).request('watched.list', args),

  'subtitle.list': async (args) => (await connected()).request('subtitle.list', args),

  // Where the player should point. The shim answers Range requests by pulling
  // the same ranges over P2P - the player never knows.
  'stream.url': async ({ itemId }) => ({ url: shim.urlFor(itemId) }),
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

log('worklet:loaded', { platform: PLATFORM })
emit('ready', {})
