// WHERE A FILM CAN BE CUT WITHOUT RE-ENCODING IT.
//
// A copied picture can only be cut on a keyframe. Ask ffmpeg for any other time
// and it hands back the keyframe before it anyway, so a segment plan built on an
// even four-second grid produces segments that overlap each other by seconds -
// the film repeats a moment at every join and the clock stops matching the
// picture. To segment with `-c:v copy` the cut points have to be known BEFORE the
// playlist is written, and they have to be real keyframes.
//
// THE OBVIOUS WAY IS TOO SLOW. `ffprobe -show_entries packet=flags` over the whole
// file finds every keyframe exactly, and it is demuxer-CPU-bound at about 84 MB/s:
// measured 2026-08-19 on the Umbrel, 4.1 s for a 282 MB episode and 2m07s for a
// 13.6 GB Blu-ray remux. Nobody waits two minutes for a television to start.
//
// THE FILE ALREADY KNOWS. Matroska carries a Cues element, which is precisely the
// list of seek points for each track, and reading it is a seek and a small read.
// Measured against the full scan on the same two films: byte-identical timestamps,
// all 469 and all 2,559 of them, in 3 ms and 348 ms. Three hundred times faster
// for exactly the same answer.
//
// TWO CONTAINERS, AND A SOURCE THAT NEED NOT BE A FILE.
//
// Matroska is where this started and is 83% of a real rip library. ISO-BMFF (mp4,
// mov, m4v) keeps the same index in a different shape: `stss` is the list of sync
// samples and `stts` says what each sample's decode time is, so the same answer is
// a moov read and some arithmetic. It matters less often - an mp4 is usually
// playable as it stands - and it bites exactly when the SOUND has to be rebuilt on
// one, which was a full hardware transcode where a copy would have done.
//
// And the source is anything a few ranges can be read out of. A Jellyfin library
// hands out an HTTP URL rather than a path, and every one of those was falling back
// too - yet the index sits in a known place and an HTTP server that serves a film
// serves Range requests by definition. It is two or three requests, not a download.
//
// NEVER GUESS: a wrong cut point is a broken film, an absent one is merely the old
// cost. Anything unparseable answers null and the caller falls back to a re-encode,
// which can cut anywhere. The ISO path goes further and CHECKS ITSELF against
// ffmpeg's own view of the head of the file before its answer is used - see
// `agreesWithProbe`. That check is free: the probe it reads was already being run
// for the reorder delay.

const fsp = require('fs/promises')
const { execFile } = require('child_process')

const EL = {
  SEGMENT: 0x18538067,
  SEEKHEAD: 0x114D9B74,
  SEEK: 0x4DBB,
  SEEK_ID: 0x53AB,
  SEEK_POSITION: 0x53AC,
  INFO: 0x1549A966,
  TIMESTAMP_SCALE: 0x2AD7B1,
  TRACKS: 0x1654AE6B,
  TRACK_ENTRY: 0xAE,
  TRACK_NUMBER: 0xD7,
  TRACK_TYPE: 0x83,
  CUES: 0x1C53BB6B,
  CUE_POINT: 0xBB,
  CUE_TIME: 0xB3,
  CUE_TRACK_POSITIONS: 0xB7,
  CUE_TRACK: 0xF7
}

const TRACK_TYPE_VIDEO = 1

// A Segment whose children are all Clusters and whose Cues sit at the very end is
// legal and rare. Walking it costs one small read per Cluster, so the walk is
// bounded rather than unbounded - a pathological file falls back instead of
// stalling a play request.
const MAX_TOP_LEVEL_WALK = 20_000

// Cues and Tracks are small - a few hundred KB on a long film. A file claiming
// more than this is not one we are going to trust into memory.
const MAX_ELEMENT_BYTES = 64 * 1024 * 1024

// How far two readings of the same cut point may sit apart and still be the same
// cut point. Two milliseconds is a fifth of a frame at 25 fps - far inside any real
// difference and far outside floating-point noise.
const PROBE_EPSILON = 0.002

// --- EBML primitives ---------------------------------------------------------
//
// Both an id and a size are variable-length integers whose first set bit says how
// many bytes they occupy. An id keeps its length marker (that is what makes the
// constants above readable against the spec); a size has it stripped.

function idLength (first) {
  for (let i = 0; i < 4; i++) if (first & (0x80 >> i)) return i + 1
  return 0
}

function sizeLength (first) {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1
  return 0
}

// Read one element header at `pos`. Returns { id, size, dataStart } or null when
// the header is malformed or the element declares an unknown size, which only
// happens in a live stream and is not a thing a library file does.
function headerAt (buf, pos) {
  if (pos >= buf.length) return null
  const idLen = idLength(buf[pos])
  if (!idLen || pos + idLen >= buf.length) return null
  let id = 0
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i]

  const sizePos = pos + idLen
  const sizeLen = sizeLength(buf[sizePos])
  if (!sizeLen || sizePos + sizeLen > buf.length) return null
  let size = buf[sizePos] & (0xFF >> sizeLen)
  let unknown = size === (0xFF >> sizeLen)
  for (let i = 1; i < sizeLen; i++) {
    size = size * 256 + buf[sizePos + i]
    if (buf[sizePos + i] !== 0xFF) unknown = false
  }
  if (unknown) return null

  return { id, size, dataStart: sizePos + sizeLen }
}

function uintAt (buf, start, length) {
  let v = 0
  for (let i = 0; i < length; i++) v = v * 256 + buf[start + i]
  return v
}

// Every direct child of an element whose body is already in memory.
function * children (buf, from = 0, to = buf.length) {
  let pos = from
  while (pos < to) {
    const h = headerAt(buf, pos)
    if (!h || h.dataStart + h.size > to) return
    yield h
    pos = h.dataStart + h.size
  }
}

function childValue (buf, h, id) {
  for (const c of children(buf, h.dataStart, h.dataStart + h.size)) {
    if (c.id === id) return uintAt(buf, c.dataStart, c.size)
  }
  return null
}

// The same lookup against a whole element body that is already the buffer.
function valueIn (buf, id) {
  for (const c of children(buf)) {
    if (c.id === id) return uintAt(buf, c.dataStart, c.size)
  }
  return null
}

// --- the source --------------------------------------------------------------
//
// Everything below reads through `{ size, read(position, length) }` and nothing
// below knows whether that is a file or a web server. `read` may answer SHORT at
// the end of the source; it must never answer more than it was asked for.

// How many reads one source will serve before the parse is abandoned. A local file
// can afford the Cluster walk (a header read each, and a film has thousands); a
// remote one cannot, and a walk that turned into ten thousand HTTP requests would
// be far worse than the fallback it is trying to avoid.
const MAX_READS = { file: 40_000, http: 24 }

const HTTP_TIMEOUT_MS = 10_000

function budgeted (source, limit) {
  let used = 0
  const read = source.read
  source.read = (position, length) => {
    if (++used > limit) throw new Error('read budget exhausted')
    return read(position, length)
  }
  return source
}

async function fileSource (file) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  const fd = await fsp.open(file, 'r').catch(() => null)
  if (!fd) return null
  return budgeted({
    size: stat.size,
    // Keyed by the file's identity rather than its name, so a replaced file
    // re-reads rather than being cut on the previous one's keyframes.
    identity: `${file}:${stat.size}:${Math.round(stat.mtimeMs)}`,
    read: async (position, length) => {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fd.read(buf, 0, length, position)
      return bytesRead === length ? buf : buf.subarray(0, bytesRead)
    },
    close: () => fd.close().catch(() => {})
  }, MAX_READS.file)
}

// A URL that answers Range requests. The FIRST range doubles as the handshake: a
// 206 with a `content-range` proves ranges work and says how long the film is, so
// there is no separate HEAD - one round trip rather than two, and a server that
// answers 200 with the whole film is refused rather than downloaded.
async function httpSource (url, headers = null) {
  const get = async (position, length) => {
    const res = await fetch(url, {
      headers: { ...(headers || {}), range: `bytes=${position}-${position + length - 1}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    })
    if (res.status !== 206) {
      // Drain rather than leave the socket holding a film.
      res.body?.cancel?.().catch(() => {})
      throw new Error(`range request answered ${res.status}`)
    }
    return res
  }

  let first
  try {
    first = await get(0, 16)
  } catch {
    return null
  }
  const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(first.headers.get('content-range') || '')
  if (!m) return null
  const size = Number(m[1])
  if (!Number.isFinite(size) || size <= 0) return null
  const head = Buffer.from(await first.arrayBuffer())

  // The film's identity as the server states it. Without an etag or a date the
  // length alone stands in - two different films of exactly the same length behind
  // one URL is not a thing a library does.
  const tag = first.headers.get('etag') || first.headers.get('last-modified') || ''

  return budgeted({
    size,
    identity: `${url}:${size}:${tag}`,
    read: async (position, length) => {
      if (position === 0 && length <= head.length) return head.subarray(0, length)
      const want = Math.min(length, Math.max(0, size - position))
      if (!want) return Buffer.alloc(0)
      const res = await get(position, want)
      return Buffer.from(await res.arrayBuffer())
    }
  }, MAX_READS.http)
}

async function openSource (input, headers = null) {
  if (!input || typeof input !== 'string') return null
  return /^https?:\/\//i.test(input) ? httpSource(input, headers) : fileSource(input)
}

// --- reading the container ---------------------------------------------------

// An element header living at an arbitrary offset. 12 bytes covers the longest
// legal id-plus-size pair.
async function headerIn (src, position) {
  const head = await src.read(position, 12)
  if (head.length < 2) return null
  const h = headerAt(head, 0)
  if (!h) return null
  return { id: h.id, size: h.size, dataStart: position + h.dataStart }
}

async function elementBody (src, h) {
  if (h.size > MAX_ELEMENT_BYTES) return null
  return src.read(h.dataStart, h.size)
}

// Which track number carries the picture, and what a tick of the file's clock is
// worth in nanoseconds. Both come from small elements near the front.
function videoTrackFrom (tracksBody) {
  for (const entry of children(tracksBody)) {
    if (entry.id !== EL.TRACK_ENTRY) continue
    if (childValue(tracksBody, entry, EL.TRACK_TYPE) === TRACK_TYPE_VIDEO) {
      const number = childValue(tracksBody, entry, EL.TRACK_NUMBER)
      if (number !== null) return number
    }
  }
  return null
}

// Cue points for one track, in seconds, in order. A Cues element holds points for
// every seekable track interleaved, so the track filter is not optional - unfiltered
// the audio track's points land between the video's and the list stops being a list
// of places the picture can be cut.
function cueTimesFor (cuesBody, track, scaleNs) {
  const times = []
  for (const point of children(cuesBody)) {
    if (point.id !== EL.CUE_POINT) continue
    let time = null
    let matches = false
    for (const c of children(cuesBody, point.dataStart, point.dataStart + point.size)) {
      if (c.id === EL.CUE_TIME) time = uintAt(cuesBody, c.dataStart, c.size)
      else if (c.id === EL.CUE_TRACK_POSITIONS) {
        if (childValue(cuesBody, c, EL.CUE_TRACK) === track) matches = true
      }
    }
    if (time !== null && matches) times.push(time * scaleNs / 1e9)
  }
  times.sort((a, b) => a - b)
  return times
}

// Where the Cues live, from the SeekHead index at the front of the Segment. Falls
// back to walking the Segment's top-level children, which is correct but reads one
// header per Cluster.
async function findElements (src, segment, fileSize) {
  const found = { cues: null, tracks: null, info: null }
  const wanted = new Map([[EL.CUES, 'cues'], [EL.TRACKS, 'tracks'], [EL.INFO, 'info']])

  let pos = segment.dataStart
  const end = Math.min(fileSize, segment.dataStart + segment.size)

  for (let n = 0; n < MAX_TOP_LEVEL_WALK && pos < end; n++) {
    const h = await headerIn(src, pos)
    if (!h) break

    const key = wanted.get(h.id)
    if (key) found[key] = h

    if (h.id === EL.SEEKHEAD && (!found.cues || !found.tracks)) {
      // The SeekHead's positions are relative to the start of the Segment's data.
      const body = await elementBody(src, h)
      if (body) {
        for (const seek of children(body)) {
          if (seek.id !== EL.SEEK) continue
          let id = null
          let at = null
          for (const c of children(body, seek.dataStart, seek.dataStart + seek.size)) {
            if (c.id === EL.SEEK_ID) id = uintAt(body, c.dataStart, c.size)
            else if (c.id === EL.SEEK_POSITION) at = uintAt(body, c.dataStart, c.size)
          }
          const target = id === null ? null : wanted.get(id)
          if (!target || at === null || found[target]) continue
          const pointed = await headerIn(src, segment.dataStart + at)
          if (pointed && pointed.id === id) found[target] = pointed
        }
      }
    }

    if (found.cues && found.tracks && found.info) break
    pos = h.dataStart + h.size
  }

  return found
}

// The keyframe times of a Matroska source's video track, in seconds. Null when it
// is not Matroska, carries no Cues, or is malformed in any way at all - a caller
// must be able to treat null as "no cheap answer" and take its own path.
async function matroskaFrom (src) {
  try {
    // The EBML header, then the Segment.
    const header = await headerIn(src, 0)
    if (!header) return null
    const segment = await headerIn(src, header.dataStart + header.size)
    if (!segment || segment.id !== EL.SEGMENT) return null

    const found = await findElements(src, segment, src.size)
    if (!found.cues || !found.tracks) return null

    const tracksBody = await elementBody(src, found.tracks)
    if (!tracksBody) return null
    const track = videoTrackFrom(tracksBody)
    if (track === null) return null

    let scaleNs = 1_000_000 // the Matroska default, one millisecond
    if (found.info) {
      const infoBody = await elementBody(src, found.info)
      const declared = infoBody && valueIn(infoBody, EL.TIMESTAMP_SCALE)
      if (declared) scaleNs = declared
    }

    const cuesBody = await elementBody(src, found.cues)
    if (!cuesBody) return null

    const times = cueTimesFor(cuesBody, track, scaleNs)
    return times.length ? times : null
  } catch {
    return null
  }
}

// The same answer for one local path, which is what the tests and any other caller
// hold. Opens a source, reads, closes.
async function matroskaKeyframes (file) {
  const src = await openSource(file)
  if (!src) return null
  try {
    return await matroskaFrom(src)
  } finally {
    await src.close?.()
  }
}

// --- ISO-BMFF (mp4, mov, m4v) ------------------------------------------------
//
// The same index in a different shape. `stss` lists the SAMPLE NUMBERS that are
// sync samples; `stts` says how long each sample lasts, which is what turns a
// sample number into a decode time; `ctts` carries the offset from decode time to
// PRESENTATION time, and presentation is what a cut point has to be in, because
// that is what Matroska's Cues are and what `-ss` takes.
//
// A file with no `stss` at all is one where every sample is a sync sample. That is
// legal and it is what an all-intra master looks like; it is not a film in a
// library, and offering two hundred thousand cut points would be worse than
// offering none. Null.
//
// EDIT LISTS ARE THE NORM, NOT AN ODDITY, and finding that out is what the probe
// check is for. The first version of this parse skipped them on the theory that
// they were rare; both test files ffmpeg produced came out exactly two frames late,
// and the check refused the answer rather than cutting every film 80 ms wrong. An
// h.264 encode with B-frames gives every sample a composition offset, and the muxer
// writes an `elst` whose media_time cancels it so that presentation still begins at
// zero. ffmpeg honours it; so does this.

// A film's moov is a few MB at most; MAX_ELEMENT_BYTES already draws the line.
const ISO_BOX_HEADER = 8

function boxType (buf, at) {
  return buf.toString('latin1', at + 4, at + 8)
}

// Every direct child box of a body already in memory: { type, start, end }.
function * boxes (buf, from = 0, to = buf.length) {
  let pos = from
  while (pos + ISO_BOX_HEADER <= to) {
    let size = buf.readUInt32BE(pos)
    const type = boxType(buf, pos)
    let head = ISO_BOX_HEADER
    if (size === 1) {
      if (pos + 16 > to) return
      // A 64-bit length, read as two halves because a Number holds 53 bits and
      // readBigUInt64BE would hand back a BigInt the arithmetic below cannot use.
      size = buf.readUInt32BE(pos + 8) * 4294967296 + buf.readUInt32BE(pos + 12)
      head = 16
    } else if (size === 0) {
      size = to - pos
    }
    if (size < head || pos + size > to) return
    yield { type, start: pos + head, end: pos + size }
    pos += size
  }
}

function findBox (buf, path, from = 0, to = buf.length) {
  let scope = { start: from, end: to }
  for (const want of path) {
    let hit = null
    for (const b of boxes(buf, scope.start, scope.end)) {
      if (b.type === want) { hit = b; break }
    }
    if (!hit) return null
    scope = hit
  }
  return scope
}

// version and flags, then the entry count: the shape every table box shares.
function tableEntries (buf, box, entryBytes) {
  const at = box.start
  if (at + 8 > box.end) return null
  const version = buf[at]
  const count = buf.readUInt32BE(at + 4)
  const first = at + 8
  if (count < 0 || first + count * entryBytes > box.end) return null
  return { version, count, first }
}

// Which trak carries the picture. `hdlr` says so in four characters, and asking it
// is the only honest way - a video track is not reliably the first one, exactly as
// it is not reliably track one in Matroska.
function videoTrak (moov) {
  for (const trak of boxes(moov)) {
    if (trak.type !== 'trak') continue
    const hdlr = findBox(moov, ['mdia', 'hdlr'], trak.start, trak.end)
    if (!hdlr || hdlr.start + 12 > hdlr.end) continue
    if (moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) === 'vide') return trak
  }
  return null
}

function movieTimescale (moov) {
  const mvhd = findBox(moov, ['mvhd'])
  if (!mvhd) return null
  const v = moov[mvhd.start]
  const at = mvhd.start + 4 + (v === 1 ? 16 : 8)
  if (at + 4 > mvhd.end) return null
  const scale = moov.readUInt32BE(at)
  return scale > 0 ? scale : null
}

// WHERE THE PRESENTATION BEGINS. An edit list maps the media timeline onto the
// presentation one, and the two shapes that matter are the ones muxers actually
// write: one plain edit starting at `media_time` (which cancels the composition
// offset of a B-frame encode), optionally preceded by an EMPTY edit, which is a gap
// that pushes everything later. Anything more elaborate - several real edits, a
// rate other than 1 - is a film assembled rather than ripped, and this refuses it
// rather than getting it subtly wrong.
//
// Answers seconds to ADD to a media timestamp already divided by the media
// timescale, or null for "this file's edit list is not one of the shapes above".
function editShift (moov, trak, timescale) {
  const elst = findBox(moov, ['edts', 'elst'], trak.start, trak.end)
  if (!elst) return 0

  const version = moov[elst.start]
  const wide = version === 1
  const entryBytes = wide ? 20 : 12
  const t = tableEntries(moov, elst, entryBytes)
  if (!t) return null

  const entries = []
  for (let i = 0; i < t.count; i++) {
    const at = t.first + i * entryBytes
    const duration = wide
      ? moov.readUInt32BE(at) * 4294967296 + moov.readUInt32BE(at + 4)
      : moov.readUInt32BE(at)
    // media_time is signed, and -1 is the empty edit - which read as unsigned is a
    // gap of half a million hours.
    const mediaTime = wide
      ? Number(moov.readBigInt64BE(at + 8))
      : moov.readInt32BE(at + 4)
    const rate = wide ? moov.readUInt32BE(at + 16) : moov.readUInt32BE(at + 8)
    entries.push({ duration, mediaTime, rate })
  }
  if (!entries.length) return 0

  let shift = 0
  let seenReal = false
  for (const e of entries) {
    if (e.mediaTime === -1) {
      if (seenReal) return null // a gap in the middle: not a shape this reads
      const movie = movieTimescale(moov)
      if (!movie) return null
      shift += e.duration / movie
      continue
    }
    if (seenReal) return null // a second real edit: the film is a cut of something
    if (e.rate !== 0x00010000) return null // played at another speed
    shift -= e.mediaTime / timescale
    seenReal = true
  }
  return shift
}

function mediaTimescale (moov, trak) {
  const mdhd = findBox(moov, ['mdia', 'mdhd'], trak.start, trak.end)
  if (!mdhd) return null
  const v = moov[mdhd.start]
  // v0 puts two 32-bit dates before the timescale; v1 puts two 64-bit ones.
  const at = mdhd.start + 4 + (v === 1 ? 16 : 8)
  if (at + 4 > mdhd.end) return null
  const scale = moov.readUInt32BE(at)
  return scale > 0 ? scale : null
}

function readRuns (moov, box, { signed = false } = {}) {
  const t = tableEntries(moov, box, 8)
  if (!t) return null
  const runs = []
  for (let i = 0; i < t.count; i++) {
    const at = t.first + i * 8
    const count = moov.readUInt32BE(at)
    // A version 1 ctts holds SIGNED offsets, and a negative one read as unsigned
    // is a cut point four thousand million ticks into the film.
    const value = signed && t.version === 1 ? moov.readInt32BE(at + 4) : moov.readUInt32BE(at + 4)
    runs.push({ count, value })
  }
  return runs
}

// Sync sample numbers turned into presentation times, in seconds and in order.
// Both tables are walked ONCE with a cursor rather than searched per sample: a
// two-hour film is a quarter of a million samples and this runs per play request.
function isoTimes ({ stss, stts, ctts, timescale, shift = 0 }) {
  const out = []
  let ri = 0
  let runFirst = 0        // sample index the current stts run starts at
  let runDts = 0          // decode time at that sample
  let ci = 0
  let cttsFirst = 0

  let previous = 0
  for (const number of stss) {
    if (number < previous) return null // stss is ascending by definition; this is not that file
    previous = number
    const idx = number - 1
    if (idx < 0) return null

    while (ri < stts.length && idx >= runFirst + stts[ri].count) {
      runDts += stts[ri].count * stts[ri].value
      runFirst += stts[ri].count
      ri++
    }
    if (ri >= stts.length) return null // a sync sample the time table does not reach

    let time = runDts + (idx - runFirst) * stts[ri].value
    if (ctts) {
      while (ci < ctts.length && idx >= cttsFirst + ctts[ci].count) {
        cttsFirst += ctts[ci].count
        ci++
      }
      if (ci < ctts.length) time += ctts[ci].value
    }
    // A composition offset in a version 1 table is legitimately negative, so a
    // negative time here is not malformed - it is a sample the presentation
    // timeline starts after, and the shift below is what decides.
    const at = time / timescale + shift
    // A sample the edit list trims off the front has no presentation time of its
    // own. Dropped rather than clamped to zero: two cut points at zero is a plan
    // with a zero-length segment in it.
    if (at < -PROBE_EPSILON) continue
    out.push(at < 0 ? 0 : at)
  }
  return out.length ? out : null
}

// Where the moov lives. It is usually at the front (that is what "faststart"
// means) and legitimately at the end otherwise, so the top-level boxes are walked
// by their declared size - which steps over the mdat, the film itself, in one hop.
async function findMoov (src) {
  let pos = 0
  for (let n = 0; n < 64 && pos < src.size; n++) {
    const head = await src.read(pos, 16)
    if (head.length < 8) return null
    let size = head.readUInt32BE(0)
    const type = boxType(head, 0)
    let headLen = ISO_BOX_HEADER
    if (size === 1) {
      if (head.length < 16) return null
      size = head.readUInt32BE(8) * 4294967296 + head.readUInt32BE(12)
      headLen = 16
    } else if (size === 0) {
      size = src.size - pos
    }
    if (size < headLen) return null
    if (type === 'moov') {
      const bodyLen = size - headLen
      if (bodyLen > MAX_ELEMENT_BYTES) return null
      return src.read(pos + headLen, bodyLen)
    }
    pos += size
  }
  return null
}

async function isoFrom (src) {
  try {
    const moov = await findMoov(src)
    if (!moov) return null

    const trak = videoTrak(moov)
    if (!trak) return null
    const timescale = mediaTimescale(moov, trak)
    if (!timescale) return null

    const shift = editShift(moov, trak, timescale)
    if (shift === null) return null

    const stbl = findBox(moov, ['mdia', 'minf', 'stbl'], trak.start, trak.end)
    if (!stbl) return null
    const stssBox = findBox(moov, ['stss'], stbl.start, stbl.end)
    const sttsBox = findBox(moov, ['stts'], stbl.start, stbl.end)
    if (!stssBox || !sttsBox) return null

    const table = tableEntries(moov, stssBox, 4)
    if (!table) return null
    const stss = []
    for (let i = 0; i < table.count; i++) stss.push(moov.readUInt32BE(table.first + i * 4))

    const stts = readRuns(moov, sttsBox)
    if (!stts) return null
    const cttsBox = findBox(moov, ['ctts'], stbl.start, stbl.end)
    const ctts = cttsBox ? readRuns(moov, cttsBox, { signed: true }) : null

    return isoTimes({ stss, stts, ctts, timescale, shift })
  } catch {
    return null
  }
}

async function isoKeyframes (file) {
  const src = await openSource(file)
  if (!src) return null
  try {
    return await isoFrom(src)
  } finally {
    await src.close?.()
  }
}

// --- which container is this -------------------------------------------------

async function sniff (src) {
  const head = await src.read(0, 12)
  if (head.length < 8) return null
  if (head.readUInt32BE(0) === 0x1A45DFA3) return 'matroska'
  // 'ftyp' is the first box of any ISO-BMFF file, and a QuickTime .mov that
  // predates it opens on 'moov', 'mdat' or 'wide' instead.
  const type = boxType(head, 0)
  if (type === 'ftyp' || type === 'moov' || type === 'mdat' || type === 'wide' || type === 'free') return 'iso'
  return null
}

// --- the reorder delay -------------------------------------------------------
//
// A segment's END is cut in DECODE order, so the time to hand `-to` is the next
// keyframe's DTS rather than its PTS. B-frames hold those a fixed distance apart -
// measured at exactly two frames on 468 of the 469 keyframes in the test episode -
// and the head of the file is enough to learn it. Without this correction the tail
// of every segment carries two frames that also open the next one, which is a
// duplicated moment at every join.
// The head of the file as ffmpeg sees it: [{ pts, dts, key }]. One call, two
// readers - the delay below and the ISO parse's self-check.
async function headPackets (input, { ffprobe = 'ffprobe', timeoutMs = 15_000, headers = null } = {}) {
  let out
  try {
    out = await new Promise((resolve, reject) => {
      const args = ['-v', 'error']
      // A remote input needs its credentials, and they go BEFORE the input the
      // same way ffmpeg takes them everywhere else in this host.
      if (headers) args.push('-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join(''))
      args.push(
        // Only the first packets, so this is a seek and a small read rather than
        // the whole-file scan this module exists to avoid.
        '-read_intervals', '%+#400',
        '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,dts_time,flags',
        '-of', 'csv=p=0',
        input
      )
      execFile(ffprobe, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })
  } catch {
    return []
  }

  const packets = []
  for (const line of String(out).trim().split('\n')) {
    const [pts, dts, flags] = line.split(',')
    if (!flags) continue
    packets.push({ pts: Number(pts), dts: Number(dts), key: flags.includes('K') })
  }
  return packets
}

function delayFrom (packets) {
  // The modal gap across keyframes, not the mean: one odd packet at the head of a
  // file must not shift the cut for the whole film.
  const seen = new Map()
  for (const p of packets) {
    if (!p.key) continue
    const d = p.pts - p.dts
    if (!Number.isFinite(d) || d < 0) continue
    const key = Math.round(d * 1000)
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  if (!seen.size) return 0

  let best = 0
  let bestCount = 0
  for (const [key, count] of seen) {
    if (count > bestCount) { best = key; bestCount = count }
  }
  return best / 1000
}

async function reorderDelay (input, opts = {}) {
  return delayFrom(await headPackets(input, opts))
}

// --- the ISO parse, checked against ffmpeg -----------------------------------
//
// The Matroska path was measured against a full packet scan on two real films and
// came back byte-identical, twice. The ISO path has no such measurement behind it
// and a wrong cut point is a broken film, so it earns its answer instead: inside
// the window the probe covers, every cut point this module claims must be a
// keyframe ffmpeg also reports, and every keyframe ffmpeg reports must be one this
// module claims. An edit list, an unusual sample table, a container this parse has
// simply misread - all of them show up here as a disagreement at the head of the
// file, and a disagreement means no answer at all.

function agreesWithProbe (times, packets) {
  if (!times?.length || !packets.length) return false
  // A KEYFRAME BEFORE THE FILM STARTS is not a disagreement. An edit list trims the
  // head off the presentation timeline and ffmpeg still reports the trimmed frames,
  // at negative times - Blade's first one is at -0.083 s, and the other 1,944 agree
  // to the microsecond. Nothing can be cut there, so neither side counts it.
  const theirs = packets
    .filter(p => p.key && Number.isFinite(p.pts) && p.pts >= -PROBE_EPSILON)
    .map(p => p.pts)
    .sort((a, b) => a - b)
  if (!theirs.length) return false

  // Only as far as BOTH have seen. The probe stops after 400 packets and our list
  // runs to the end of the film, so beyond that window neither can contradict the
  // other and pretending otherwise would fail every long file.
  const window = Math.min(theirs[theirs.length - 1], times[times.length - 1])
  const mine = times.filter(t => t <= window + PROBE_EPSILON)
  const yours = theirs.filter(t => t <= window + PROBE_EPSILON)
  if (mine.length !== yours.length) return false
  return mine.every((t, i) => Math.abs(t - yours[i]) <= PROBE_EPSILON)
}

// --- the cache ---------------------------------------------------------------
//
// Keyed by the source's identity rather than its name, so a replaced file re-reads
// rather than being cut on the previous one's keyframes. Small, because the
// entries are: a long film's list is a few thousand numbers.

const CACHE_LIMIT = 64
const cache = new Map()

function remember (key, value) {
  cache.set(key, value)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return value
}

// The whole answer for one input: { times, reorderDelay } or null. `input` is a
// path or an http(s) URL; `headers` are the credentials a remote one needs, as
// the adapter's ffmpegInput hands them over.
//
// `null` is not an error and must not be logged as one. It means this film has no
// cheap cut points, and the caller's fallback is a re-encode, which can cut
// anywhere.
async function read (input, { ffprobe = 'ffprobe', headers = null } = {}) {
  const src = await openSource(input, headers)
  if (!src) return null

  try {
    const key = src.identity
    if (cache.has(key)) return cache.get(key)

    const kind = await sniff(src).catch(() => null)
    if (!kind) return remember(key, null)

    if (kind === 'matroska') {
      const times = await matroskaFrom(src)
      if (!times) return remember(key, null)
      const delay = await reorderDelay(input, { ffprobe, headers })
      return remember(key, { times, reorderDelay: delay })
    }

    const times = await isoFrom(src)
    if (!times) return remember(key, null)
    // ONE PROBE, TWO USES: the check and the delay come out of the same call, so
    // the ISO path's extra safety costs nothing over the Matroska one.
    const packets = await headPackets(input, { ffprobe, headers })
    if (!agreesWithProbe(times, packets)) return remember(key, null)
    return remember(key, { times, reorderDelay: delayFrom(packets) })
  } catch {
    return null
  } finally {
    await src.close?.()
  }
}

function _clearCache () { cache.clear() }

module.exports = {
  read,
  matroskaKeyframes,
  isoKeyframes,
  reorderDelay,
  headPackets,
  agreesWithProbe,
  openSource,
  _clearCache,
  EL
}
