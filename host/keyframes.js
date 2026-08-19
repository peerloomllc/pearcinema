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
// WHAT THIS DOES NOT DO. Only Matroska for now, because that is what a real rip
// library is and because the ISO-BMFF sample tables are a much larger parse for a
// container that is usually already playable as it is. Anything else answers null,
// and the caller's honest fallback is the path it took before this file existed -
// a hardware transcode, which needs no cut points because a re-encode can cut
// anywhere. Never guess: a wrong cut point is a broken film, an absent one is
// merely the old cost.

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

// --- reading the file --------------------------------------------------------

async function readAt (fd, position, length) {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fd.read(buf, 0, length, position)
  return bytesRead === length ? buf : buf.subarray(0, bytesRead)
}

// An element header living at an arbitrary file offset. 12 bytes covers the
// longest legal id-plus-size pair.
async function headerInFile (fd, position) {
  const head = await readAt(fd, position, 12)
  if (head.length < 2) return null
  const h = headerAt(head, 0)
  if (!h) return null
  return { id: h.id, size: h.size, dataStart: position + h.dataStart }
}

async function elementBody (fd, h) {
  if (h.size > MAX_ELEMENT_BYTES) return null
  return readAt(fd, h.dataStart, h.size)
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
async function findElements (fd, segment, fileSize) {
  const found = { cues: null, tracks: null, info: null }
  const wanted = new Map([[EL.CUES, 'cues'], [EL.TRACKS, 'tracks'], [EL.INFO, 'info']])

  let pos = segment.dataStart
  const end = Math.min(fileSize, segment.dataStart + segment.size)

  for (let n = 0; n < MAX_TOP_LEVEL_WALK && pos < end; n++) {
    const h = await headerInFile(fd, pos)
    if (!h) break

    const key = wanted.get(h.id)
    if (key) found[key] = h

    if (h.id === EL.SEEKHEAD && (!found.cues || !found.tracks)) {
      // The SeekHead's positions are relative to the start of the Segment's data.
      const body = await elementBody(fd, h)
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
          const pointed = await headerInFile(fd, segment.dataStart + at)
          if (pointed && pointed.id === id) found[target] = pointed
        }
      }
    }

    if (found.cues && found.tracks && found.info) break
    pos = h.dataStart + h.size
  }

  return found
}

// The keyframe times of a Matroska file's video track, in seconds. Null when the
// file is not Matroska, carries no Cues, or is malformed in any way at all - a
// caller must be able to treat null as "no cheap answer" and take its own path.
async function matroskaKeyframes (file) {
  let fd = null
  try {
    fd = await fsp.open(file, 'r')
    const { size: fileSize } = await fd.stat()

    // The EBML header, then the Segment.
    const header = await headerInFile(fd, 0)
    if (!header) return null
    const segment = await headerInFile(fd, header.dataStart + header.size)
    if (!segment || segment.id !== EL.SEGMENT) return null

    const found = await findElements(fd, segment, fileSize)
    if (!found.cues || !found.tracks) return null

    const tracksBody = await elementBody(fd, found.tracks)
    if (!tracksBody) return null
    const track = videoTrackFrom(tracksBody)
    if (track === null) return null

    let scaleNs = 1_000_000 // the Matroska default, one millisecond
    if (found.info) {
      const infoBody = await elementBody(fd, found.info)
      const declared = infoBody && valueIn(infoBody, EL.TIMESTAMP_SCALE)
      if (declared) scaleNs = declared
    }

    const cuesBody = await elementBody(fd, found.cues)
    if (!cuesBody) return null

    const times = cueTimesFor(cuesBody, track, scaleNs)
    return times.length ? times : null
  } catch {
    return null
  } finally {
    await fd?.close().catch(() => {})
  }
}

// --- the reorder delay -------------------------------------------------------
//
// A segment's END is cut in DECODE order, so the time to hand `-to` is the next
// keyframe's DTS rather than its PTS. B-frames hold those a fixed distance apart -
// measured at exactly two frames on 468 of the 469 keyframes in the test episode -
// and the head of the file is enough to learn it. Without this correction the tail
// of every segment carries two frames that also open the next one, which is a
// duplicated moment at every join.
async function reorderDelay (file, { ffprobe = 'ffprobe', timeoutMs = 15_000 } = {}) {
  let out
  try {
    out = await new Promise((resolve, reject) => {
      execFile(ffprobe, [
        '-v', 'error',
        // Only the first packets, so this is a seek and a small read rather than
        // the whole-file scan this module exists to avoid.
        '-read_intervals', '%+#400',
        '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,dts_time,flags',
        '-of', 'csv=p=0',
        file
      ], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      })
    })
  } catch {
    return 0
  }

  // The modal gap across keyframes, not the mean: one odd packet at the head of a
  // file must not shift the cut for the whole film.
  const seen = new Map()
  for (const line of String(out).trim().split('\n')) {
    const [pts, dts, flags] = line.split(',')
    if (!flags || !flags.includes('K')) continue
    const d = Number(pts) - Number(dts)
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

// --- the cache ---------------------------------------------------------------
//
// Keyed by the file's identity rather than its name, so a replaced file re-reads
// rather than being cut on the previous one's keyframes. Small, because the
// entries are: a long film's list is a few thousand numbers.

const CACHE_LIMIT = 64
const cache = new Map()

function cacheKey (file, stat) {
  return `${file}:${stat.size}:${Math.round(stat.mtimeMs)}`
}

function remember (key, value) {
  cache.set(key, value)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return value
}

// The whole answer for one local file: { times, reorderDelay } or null.
//
// `null` is not an error and must not be logged as one. It means this file has no
// cheap cut points, which is the normal answer for a source that is not a local
// Matroska - a Jellyfin library hands out an HTTP URL, and an HTTP URL is not a
// file this can open.
async function read (file, { ffprobe = 'ffprobe' } = {}) {
  if (!file || typeof file !== 'string') return null

  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return null
  }
  if (!stat.isFile()) return null

  const key = cacheKey(file, stat)
  if (cache.has(key)) return cache.get(key)

  const times = await matroskaKeyframes(file)
  if (!times) return remember(key, null)

  return remember(key, { times, reorderDelay: await reorderDelay(file, { ffprobe }) })
}

function _clearCache () { cache.clear() }

module.exports = { read, matroskaKeyframes, reorderDelay, _clearCache, EL }
