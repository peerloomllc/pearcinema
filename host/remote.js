// The desktop's OUTBOUND side (proposal 2026-08-16-desktop-client): this
// machine as a device knocking on other libraries' doors, beside the host it
// may also be running. The same @peerloom/client the phone's worklet uses,
// in Node - which is why this file is mostly bookkeeping.
//
// It owns:
//   1. a CLIENT identity (remote-identity.json) - separate from the host's own
//      keys. It is this machine's device key on someone else's grant list;
//      losing it means re-pairing, exactly like a phone.
//   2. the remote host list (remote-hosts.json), @peerloom/client/hosts' pure
//      bookkeeping - the phone's exact persisted shape.
//   3. connections on demand, one per remote library, single-flight, all off
//      the HOST's shared DHT node when one is passed in.
//
// Every per-host call the dashboard fans through here races a timeout: a
// zombie host does not refuse, it black-holes (measured on the TCL with a
// paused container, 2026-08-16), and one hung branch must not hang a page.

const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const z32 = require('z32')
const hcrypto = require('hypercore-crypto')

const { Client } = require('@peerloom/client/client')
const H = require('@peerloom/client/hosts')

const CALL_TIMEOUT_MS = 8000

function raced (p, ms = CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('that library did not answer')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

class RemoteLibraries {
  constructor ({ dataDir, protocol, dht = null, log = () => {} }) {
    this.dataDir = dataDir
    this.protocol = protocol
    this.dht = dht
    this.log = log
    this.identityFile = path.join(dataDir, 'remote-identity.json')
    this.hostsFile = path.join(dataDir, 'remote-hosts.json')
    this.keyPair = this._loadIdentity()
    this.state = this._readHosts()
    this.conns = new Map() // libraryId -> { client, connecting }
    this.onchange = null // set by the wiring; fired after any list change
    this.onconnect = null // set by the wiring; fired when a member comes (back) online
    // set by the wiring; every push a paired library sends this machine. The
    // phone has always wired this (src/bare.js); here it went nowhere, so an
    // answer to one of our asks arrived and was dropped on the floor.
    this.onpush = null
  }

  _loadIdentity () {
    try {
      const raw = JSON.parse(fs.readFileSync(this.identityFile, 'utf8'))
      // An identity written before 2026-08-30 is 0664 on disk; fix it in place the
      // first time it is read rather than leaving every existing install exposed.
      this._tighten(this.identityFile)
      return {
        publicKey: b4a.from(raw.publicKey, 'hex'),
        secretKey: b4a.from(raw.secretKey, 'hex')
      }
    } catch {
      const kp = hcrypto.keyPair()
      fs.mkdirSync(this.dataDir, { recursive: true })
      // 0600, LIKE THE HOST'S OWN SEED. This file holds a secretKey in plain text and
      // was written 0664 - world-readable on a normal Linux box, while host.seed beside
      // it was 0600. Found by a user reading their own data folder (field report,
      // 2026-08-30) and reported rather than exploited. Anyone who can read this file
      // can be this client to every host it has paired with.
      fs.writeFileSync(this.identityFile, JSON.stringify({
        publicKey: b4a.toString(kp.publicKey, 'hex'),
        secretKey: b4a.toString(kp.secretKey, 'hex')
      }), { mode: 0o600 })
      this.log('remote:identity-created', {})
      return kp
    }
  }

  // AN EXISTING FILE KEEPS ITS OLD MODE: `mode` on writeFileSync only applies when the
  // file is created, so every install that already wrote 0664 would stay 0664 forever.
  // Tightened on read instead, once, in place.
  _tighten (file) {
    try {
      const mode = fs.statSync(file).mode & 0o777
      if (mode & 0o077) {
        fs.chmodSync(file, 0o600)
        this.log('remote:tightened', { file: path.basename(file), was: mode.toString(8) })
      }
    } catch {}
  }

  _readHosts () {
    try {
      const out = H.normalize(JSON.parse(fs.readFileSync(this.hostsFile, 'utf8')))
      this._tighten(this.hostsFile)
      return out
    } catch {
      return H.empty()
    }
  }

  _writeHosts () {
    fs.mkdirSync(this.dataDir, { recursive: true })
    // The host keys this client has been let into. Not secret the way a secretKey is,
    // but it is the map of somebody's private libraries and it keeps the same mode.
    fs.writeFileSync(this.hostsFile, JSON.stringify(this.state), { mode: 0o600 })
    if (this.onchange) this.onchange()
  }

  list () {
    const live = new Set()
    for (const [lib, slot] of this.conns) {
      if (slot.client && slot.client.conn && !slot.client.conn.destroyed) live.add(lib)
    }
    return this.state.hosts.map((h) => ({
      hostKey: h.hostKey,
      libraryId: h.libraryId,
      libraryName: h.libraryName,
      addedAt: h.addedAt,
      online: live.has(h.libraryId)
    }))
  }

  row (libraryId) {
    return this.state.hosts.find((h) => h.libraryId === libraryId) || null
  }

  _newClient () {
    return new Client({
      protocol: this.protocol,
      keyPair: this.keyPair,
      dht: this.dht,
      log: (m, d) => this.log('remote:' + m, d)
    })
  }

  async pair (link, { label = 'desktop' } = {}) {
    const c = this._newClient()
    try {
      const paired = await raced(c.pair(String(link || '').trim(), { label, platform: 'desktop' }), 30000)
      this.state = H.addHost(this.state, {
        hostKey: z32.encode(paired.hostKey),
        libraryId: paired.libraryId,
        libraryName: paired.libraryName
      }, Date.now())
      this._writeHosts()
      this.log('remote:paired', { library: paired.libraryName })
      return { libraryId: paired.libraryId, libraryName: paired.libraryName }
    } finally {
      await c.close().catch(() => {})
    }
  }

  // Connect (or revive) one remote library. Single-flight per entry.
  async connected (libraryId) {
    const row = this.row(libraryId)
    if (!row) throw new Error('not paired with that library')

    let slot = this.conns.get(libraryId)
    if (!slot) { slot = { client: null, connecting: null }; this.conns.set(libraryId, slot) }
    if (slot.client && slot.client.conn && !slot.client.conn.destroyed) return slot.client
    if (slot.connecting) return slot.connecting

    slot.connecting = (async () => {
      if (slot.client) { try { await slot.client.close() } catch {} }
      const c = this._newClient()
      // Set BEFORE connect, so a push that arrives on the first breath is not
      // the one that gets lost.
      c.onPush = (m) => { try { this.onpush?.(row.libraryId, m) } catch {} }
      await c.connect({ hostKey: z32.decode(row.hostKey), libraryId: row.libraryId })
      slot.client = c
      this.log('remote:connected', { library: row.libraryName })
      // A member coming back is news the blend rebuilds on.
      this.onconnect?.(libraryId)
      return c
    })()

    try {
      return await raced(slot.connecting, 15000)
    } finally {
      slot.connecting = null
    }
  }

  // A request against one remote library, connection revived if needed and the
  // whole thing raced - the dashboard page behind this must never hang.
  async call (libraryId, method, args) {
    const c = await this.connected(libraryId)
    // The remote host reports its CURRENT name in identity.get; fold renames
    // back in, the phone's lesson (PR #60).
    const out = await raced(c.request(method, args))
    if (method === 'identity.get' && out?.libraryName) {
      const row = this.row(libraryId)
      if (row && out.libraryName !== row.libraryName) {
        this.state = H.renameHost(this.state, row.hostKey, out.libraryName)
        this._writeHosts()
      }
    }
    return out
  }

  // Leave: tell the remote host to drop this machine's grant (best-effort - an
  // unreachable host still gets removed locally), then forget it here.
  async remove (hostKey) {
    const leaving = this.state.hosts.find((h) => h.hostKey === hostKey)
    if (leaving) {
      try {
        const c = await this.connected(leaving.libraryId)
        await raced(c.deviceLeave()).catch(() => {})
      } catch {}
      const slot = this.conns.get(leaving.libraryId)
      if (slot?.client) { try { slot.client.close() } catch {} }
      this.conns.delete(leaving.libraryId)
    }
    this.state = H.removeHost(this.state, hostKey).file
    this._writeHosts()
    return { ok: true }
  }

  async close () {
    for (const slot of this.conns.values()) {
      if (slot.client) { try { await slot.client.close() } catch {} }
    }
    this.conns.clear()
  }
}

module.exports = { RemoteLibraries }
