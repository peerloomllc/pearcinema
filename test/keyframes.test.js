// Reading a film's cut points out of the container's own index.
//
// The whole value of host/keyframes.js is that it is a seek and a small read where
// the obvious answer is a full-file scan - measured 3 ms against 4.1 s on a 282 MB
// episode, and 348 ms against 2m07s on a 13.6 GB Blu-ray remux, for byte-identical
// timestamps both times. What is pinned here is the parse: the shapes a real
// Matroska file takes, and the answers that must be null rather than wrong.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const keyframes = require('../host/keyframes')

// --- a Matroska file, built by hand ------------------------------------------

// An element id is written as-is: the constants already carry the length marker
// that makes them readable against the spec.
function idBytes (id) {
  const out = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256)
  return Buffer.from(out)
}

// A four-byte size, which is legal for every length this fixture needs and keeps
// the builder from having to choose a width.
function sizeBytes (n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  b[0] |= 0x10
  return b
}

function el (id, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.concat(body)
  return Buffer.concat([idBytes(id), sizeBytes(b.length), b])
}

function uint (id, value) {
  const out = []
  let v = Math.round(value)
  do {
    out.unshift(v % 256)
    v = Math.floor(v / 256)
  } while (v > 0)
  return el(id, Buffer.from(out))
}

const EL = keyframes.EL

function cuePoint (timeMs, track) {
  return el(EL.CUE_POINT, [
    uint(EL.CUE_TIME, timeMs),
    el(EL.CUE_TRACK_POSITIONS, [uint(EL.CUE_TRACK, track)])
  ])
}

function tracks ({ videoTrack = 1, audioTrack = 2 } = {}) {
  return el(EL.TRACKS, [
    el(EL.TRACK_ENTRY, [uint(EL.TRACK_NUMBER, audioTrack), uint(EL.TRACK_TYPE, 2)]),
    el(EL.TRACK_ENTRY, [uint(EL.TRACK_NUMBER, videoTrack), uint(EL.TRACK_TYPE, 1)])
  ])
}

// `points` is [timeMs, track] pairs, in the interleaved order a real Cues element
// has them.
function mkv (points, { videoTrack = 1, scaleNs = 1_000_000, filler = 0, extra = [] } = {}) {
  const body = [
    el(EL.INFO, [uint(EL.TIMESTAMP_SCALE, scaleNs)]),
    tracks({ videoTrack }),
    ...extra,
    // A Cluster standing between Tracks and Cues, which is where every real file
    // keeps its picture. The walk has to step over it by its declared size rather
    // than reading it.
    ...(filler ? [el(0x1F43B675, Buffer.alloc(filler, 0x42))] : []),
    el(EL.CUES, points.map(([t, track]) => cuePoint(t, track)))
  ]
  return Buffer.concat([
    el(0x1A45DFA3, Buffer.alloc(4)),   // the EBML header, contents irrelevant here
    el(EL.SEGMENT, body)
  ])
}

function write (t, buf, name = 'film.mkv') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcinema-kf-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, buf)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return file
}

test.beforeEach(() => keyframes._clearCache())

test('THE CUT POINTS ARE THE VIDEO TRACK\'S, and the track filter is not optional', async (t) => {
  // A real Cues element holds points for every seekable track interleaved. Read
  // unfiltered, the audio track's points land between the video's and the list
  // stops being a list of places the PICTURE can be cut - which is the only thing
  // it is for. Measured on the test episode: 469 video points and 263 audio ones
  // in one element.
  const file = write(t, mkv([
    [0, 1], [2438, 2], [2106, 1], [4859, 1], [6985, 2], [6569, 1]
  ]))

  const times = await keyframes.matroskaKeyframes(file)
  assert.deepEqual(times, [0, 2.106, 4.859, 6.569])
})

test('the video track is found by TYPE, never by being track one', async (t) => {
  const file = write(t, mkv([[0, 3], [1000, 1], [4000, 3]], { videoTrack: 3 }))
  assert.deepEqual(await keyframes.matroskaKeyframes(file), [0, 4])
})

test('the file\'s own clock scale is honoured', async (t) => {
  // The default is a millisecond per tick and almost every file uses it. A file
  // that says otherwise and is read as if it had not would place every cut point
  // in the wrong minute of the film.
  const file = write(t, mkv([[0, 1], [1_000_000, 1]], { scaleNs: 1000 }))
  assert.deepEqual(await keyframes.matroskaKeyframes(file), [0, 1])
})

test('Cues found past a Cluster, and Cues found through the SeekHead', async (t) => {
  // The walk steps over a Cluster by its declared size. A film's Clusters are the
  // whole film, so reading one to get past it would be the scan this avoids.
  const walked = write(t, mkv([[0, 1], [5000, 1]], { filler: 65_536 }))
  assert.deepEqual(await keyframes.matroskaKeyframes(walked), [0, 5])

  // And the fast path: a SeekHead at the front pointing straight at both elements,
  // which is what a muxer writes and what makes a 25 GB film answer in 144 ms.
  const inner = [
    el(EL.INFO, [uint(EL.TIMESTAMP_SCALE, 1_000_000)]),
    tracks(),
    el(0x1F43B675, Buffer.alloc(4096, 0x42)),
    el(EL.CUES, [cuePoint(0, 1), cuePoint(7000, 1)])
  ]
  // A SeekHead's positions point at elements that come after it, so its own size
  // has to stop mattering: eight fixed bytes per offset, which is what a real
  // muxer does for the same reason.
  const fixed = (id, value) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(value))
    return el(id, b)
  }
  const seek = (id, at) => el(EL.SEEK, [el(EL.SEEK_ID, idBytes(id)), fixed(EL.SEEK_POSITION, at)])
  const head = el(EL.SEEKHEAD, [seek(EL.TRACKS, 0), seek(EL.CUES, 0)])

  let pos = head.length
  let tracksAt = 0
  let cuesAt = 0
  for (const part of inner) {
    if (part.subarray(0, 4).equals(idBytes(EL.TRACKS))) tracksAt = pos
    if (part.subarray(0, 4).equals(idBytes(EL.CUES))) cuesAt = pos
    pos += part.length
  }
  const realHead = el(EL.SEEKHEAD, [seek(EL.TRACKS, tracksAt), seek(EL.CUES, cuesAt)])
  assert.equal(realHead.length, head.length, 'the fixture\'s offsets must not shift the head')
  const indexed = write(t, Buffer.concat([
    el(0x1A45DFA3, Buffer.alloc(4)),
    el(EL.SEGMENT, [realHead, ...inner])
  ]), 'indexed.mkv')
  assert.deepEqual(await keyframes.matroskaKeyframes(indexed), [0, 7])
})

test('NULL IS THE HONEST ANSWER, and the caller\'s fallback is the old path', async (t) => {
  // Every one of these means "no cheap cut points here", which is a normal answer
  // and not an error. A wrong cut point is a broken film; an absent one is only
  // the cost this host paid before the copy engine existed.
  assert.equal(await keyframes.read(null), null)
  assert.equal(await keyframes.read('/no/such/file.mkv'), null)
  assert.equal(await keyframes.read(os.tmpdir()), null, 'a directory is not a film')

  // Not Matroska at all - an MP4, which this does not read yet.
  assert.equal(await keyframes.matroskaKeyframes(write(t, Buffer.alloc(4096), 'x.mp4')), null)

  // Matroska with no Cues: legal, and unusable for cutting.
  const noCues = Buffer.concat([
    el(0x1A45DFA3, Buffer.alloc(4)),
    el(EL.SEGMENT, [el(EL.INFO, [uint(EL.TIMESTAMP_SCALE, 1_000_000)]), tracks()])
  ])
  assert.equal(await keyframes.matroskaKeyframes(write(t, noCues, 'nocues.mkv')), null)

  // Cues that name only tracks this file does not have as video.
  const wrongTrack = mkv([[0, 2], [4000, 2]])
  assert.equal(await keyframes.matroskaKeyframes(write(t, wrongTrack, 'audio.mkv')), null)

  // Truncated mid-element, which is what a copy still in flight looks like.
  assert.equal(await keyframes.matroskaKeyframes(write(t, mkv([[0, 1], [4000, 1]]).subarray(0, 20), 'part.mkv')), null)
})

test('the answer is cached against the file\'s identity, not its name', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearcinema-kf-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'film.mkv')
  fs.writeFileSync(file, mkv([[0, 1], [5000, 1], [11000, 1]]))

  // No ffprobe on this machine's PATH in a test run, so the reorder delay reads as
  // zero - which is the right degradation: segments cut one keyframe's decode
  // delay late rather than not at all.
  const first = await keyframes.read(file, { ffprobe: '/nonexistent/ffprobe' })
  assert.deepEqual(first.times, [0, 5, 11])
  assert.equal(first.reorderDelay, 0)
  assert.equal(await keyframes.read(file, { ffprobe: '/nonexistent/ffprobe' }), first, 'the same object, not a re-read')

  // A REPLACED FILE RE-READS. Cutting a new film on the old one's keyframes would
  // be the worst failure this module has, because every segment would look fine
  // and none of them would be.
  await new Promise(resolve => setTimeout(resolve, 10))
  fs.writeFileSync(file, mkv([[0, 1], [6000, 1], [13000, 1]]))
  const second = await keyframes.read(file, { ffprobe: '/nonexistent/ffprobe' })
  assert.deepEqual(second.times, [0, 6, 13])
})
