// Films kept on THIS machine from somebody else's library (desktop-client
// proposal, phase 2) - the phone's download shape in Node, with a directory of
// plain files where the phone has its cache.
//
// The friend's host decides what gets stored, exactly as it decides playback:
// the same declared capabilities, the same decide(). A transcode verdict means
// the download is the CONVERTED film off media.export - the friend's hardware
// does the work and this machine stores what arrives. Anything else is the
// original bytes, byte-exact off the wire; a container this browser refuses
// still repackages locally at play time, which is a stream copy and keeps the
// one hard rule: this machine never re-encodes someone else's stream.
//
// Live progress is RAM-only, the phone's rule: a killed process leaves a .part
// file the meta never marked done, swept on the next start - restart and
// download again.

const fs = require('fs')
const path = require('path')

const EXT = {
  matroska: 'mkv', mkv: 'mkv', mov: 'mp4', mp4: 'mp4', m4v: 'mp4',
  webm: 'webm', avi: 'avi', mpegts: 'ts'
}

class RemoteDownloads {
  constructor ({ dataDir, remote, log = () => {} }) {
    this.dir = path.join(dataDir, 'downloads')
    this.metaFile = path.join(this.dir, 'downloads.json')
    this.remote = remote
    this.log = log
    this.live = new Map() // itemId -> { lib, title, cancel, got: () => n, size, approx }
    this.meta = this._read()
    this._sweep()
  }

  _read () {
    try { return JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) } catch { return {} }
  }

  _write () {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.metaFile, JSON.stringify(this.meta))
  }

  _sweep () {
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f.endsWith('.part')) fs.rmSync(path.join(this.dir, f), { force: true })
      }
    } catch {}
  }

  row (itemId) { return this.meta[String(itemId)] || null }

  fileFor (itemId) {
    const r = this.meta[String(itemId)]
    return r ? path.join(this.dir, r.file) : null
  }

  // Finished rows and running ones in one list, finished newest first with the
  // running ones on top - the shape the dashboard's card draws directly.
  list () {
    const out = []
    for (const [itemId, l] of this.live) {
      out.push({
        itemId,
        lib: l.lib,
        title: l.title,
        downloading: true,
        got: l.got(),
        size: l.size,
        converting: !!l.approx
      })
    }
    const done = Object.entries(this.meta)
      .map(([itemId, r]) => ({ itemId, ...r, downloading: false }))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    return out.concat(done)
  }

  async start (lib, itemId, capabilities = {}) {
    itemId = String(itemId)
    if (this.meta[itemId]) return { ok: true, already: true }
    if (this.live.has(itemId)) return { ok: true, running: true }

    const item = await this.remote.call(lib, 'library.get', { id: itemId })
    if (!item) throw new Error('no such item on that library')

    // A download is the film, not the viewing session - a subtitle burn or a
    // skin's tone chosen in the player must not bake itself into the kept copy.
    const { burnSubtitleId, tone, ...caps } = capabilities || {}

    // THE FRIEND DECIDES, same as playback. Unreachable decide falls back to
    // the raw bytes: a wrong guess here costs a local repackage at play time,
    // never a re-encode.
    const verdict = await this.remote.call(lib, 'media.decide', { itemId, capabilities: caps }).catch(() => null)
    const c = await this.remote.connected(lib)
    if (verdict?.mode === 'transcode') return this._startExport({ c, lib, itemId, item, caps, verdict })
    return this._startRaw({ c, lib, itemId, item })
  }

  _baseRow (lib, item) {
    return {
      lib,
      type: item.type,
      title: item.title || '',
      year: item.year || null,
      runtime: item.runtime || null,
      seriesTitle: item.seriesTitle || null,
      seasonNumber: item.seasonNumber ?? null,
      episodeNumber: item.episodeNumber ?? null
    }
  }

  // The original bytes, byte-exact, with the size known up front.
  _startRaw ({ c, lib, itemId, item }) {
    const size = item.media?.size
    if (!size) throw new Error('this one cannot be downloaded')

    const ext = EXT[String(item.media?.container || '').toLowerCase()] || 'mp4'
    const file = itemId.replace(/[^a-z0-9]/gi, '') + '.' + ext
    fs.mkdirSync(this.dir, { recursive: true })
    const part = path.join(this.dir, file + '.part')
    const ws = fs.createWriteStream(part)

    let got = 0
    const p = c.streamTo({ itemId, offset: 0, length: size }, (chunk) => {
      got += chunk.length
      ws.write(chunk)
    })
    this.live.set(itemId, { lib, title: item.title || '', cancel: () => p.cancel?.(), got: () => got, size })
    p.then((out) => {
      this.live.delete(itemId)
      ws.end(() => {
        if (out?.cancelled || got !== size) {
          fs.rmSync(part, { force: true })
          this.log('downloads:failed', { itemId, reason: out?.cancelled ? 'cancelled' : 'incomplete' })
          return
        }
        fs.renameSync(part, path.join(this.dir, file))
        this.meta[itemId] = { ...this._baseRow(lib, item), file, size, media: item.media, savedAt: Date.now() }
        this._write()
        this.log('downloads:done', { itemId, size })
      })
    }).catch((e) => {
      this.live.delete(itemId)
      ws.destroy()
      fs.rmSync(part, { force: true })
      this.log('downloads:failed', { itemId, reason: e.message })
    })
    return { ok: true }
  }

  // The converted film off media.export. No known final size - the friend is
  // encoding as it sends - so progress runs against the encoder's own bitrate
  // ladder, the phone's arithmetic. The wire stream only ends cleanly when the
  // friend's ffmpeg exited 0 (the host's truncation guard), so anything else
  // arrives here as an error and the .part is dropped.
  _startExport ({ c, lib, itemId, item, caps, verdict }) {
    const w = Number(item.media?.width) || 0
    const ladder = w >= 1600 ? 6000 : w >= 1000 ? 3000 : 1500
    const budget = Number(caps.maxKbps) || 0
    const kbps = (budget ? Math.min(ladder, budget) : ladder) + 200
    const est = Math.max(1, Math.round((kbps * 1000 / 8) * (Number(item.runtime) || 0)))

    const file = itemId.replace(/[^a-z0-9]/gi, '') + '.mp4'
    fs.mkdirSync(this.dir, { recursive: true })
    const part = path.join(this.dir, file + '.part')
    const ws = fs.createWriteStream(part)

    let got = 0
    const p = c.request('media.export', { itemId, capabilities: caps }, {
      stream: true,
      buffer: false,
      onchunk: (chunk) => {
        got += chunk.length
        ws.write(chunk)
      }
    })
    this.live.set(itemId, { lib, title: item.title || '', cancel: () => p.cancel?.(), got: () => Math.min(got, Math.round(est * 0.99)), size: est, approx: true })
    p.then((out) => {
      this.live.delete(itemId)
      ws.end(() => {
        if (out?.cancelled) {
          fs.rmSync(part, { force: true })
          this.log('downloads:failed', { itemId, reason: 'cancelled' })
          return
        }
        // The engine was freed between decide and export - the friend refused
        // to convert what needs no converting. Nothing streamed; take the bytes.
        if (out?.direct) {
          fs.rmSync(part, { force: true })
          this.start(lib, itemId, caps).catch((e) => this.log('downloads:failed', { itemId, reason: e.message }))
          return
        }
        fs.renameSync(part, path.join(this.dir, file))
        const size = fs.statSync(path.join(this.dir, file)).size
        this.meta[itemId] = {
          ...this._baseRow(lib, item),
          file,
          size,
          converted: true,
          // What is IN the kept file, which is what a play-time verdict needs -
          // the library's own facts describe the file on the FRIEND's disk.
          media: {
            ...item.media,
            container: 'mp4',
            videoCodec: 'h264',
            audioCodec: verdict?.audio && verdict.audio !== 'copy' ? verdict.audio : (item.media?.audioCodec || null),
            size
          },
          savedAt: Date.now()
        }
        this._write()
        this.log('downloads:done', { itemId, size, converted: true })
      })
    }).catch((e) => {
      this.live.delete(itemId)
      ws.destroy()
      fs.rmSync(part, { force: true })
      this.log('downloads:failed', { itemId, reason: e.message })
    })
    return { ok: true, converting: true }
  }

  cancel (itemId) {
    const l = this.live.get(String(itemId))
    if (l) l.cancel()
    return { ok: true }
  }

  remove (itemId) {
    itemId = String(itemId)
    const l = this.live.get(itemId)
    if (l) l.cancel()
    const r = this.meta[itemId]
    if (r) {
      fs.rmSync(path.join(this.dir, r.file), { force: true })
      delete this.meta[itemId]
      this._write()
    }
    return { ok: true }
  }

  // Leaving a library takes its kept copies with it - a download that can
  // never be routed again is disk spent on a film with no way to play it.
  removeLib (lib) {
    for (const l of this.live.values()) { if (l.lib === lib) l.cancel() }
    for (const [itemId, r] of Object.entries(this.meta)) {
      if (r.lib === lib) this.remove(itemId)
    }
    return { ok: true }
  }

  close () {
    for (const l of this.live.values()) { try { l.cancel() } catch {} }
    this.live.clear()
  }
}

module.exports = { RemoteDownloads }
