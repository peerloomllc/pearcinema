// FRAGMENTED MP4 SEGMENTS FOR APPLE'S PLAYER, and the one measurement that forces
// this file to exist.
//
// HEVC CANNOT TRAVEL IN MPEG-TS TO AN APPLE DEVICE. Apple's HLS authoring rules
// carry HEVC in fragmented MP4 only, and AVFoundation does not merely refuse a TS
// segment carrying HEVC - it plays the SOUND and draws nothing, with no error at
// all. Measured 2026-08-27 on the iPhone SE and reproduced on the Simulator: the
// clock advanced, readyState reached 4, `video.error` stayed null, and
// `videoWidth x videoHeight` read 0 x 0. Because nothing throws, the app's
// player-error retry net cannot see it, so the viewer just gets a black rectangle
// with dialogue coming out of it.
//
// That is 3,336 of the 5,972 films and episodes in the measured library - every
// Matroska file holding HEVC, which on iOS needs a container change and therefore
// took the segment path. Over half the library, silently pictureless.
//
// WHY THE SEGMENTS HAVE TO BE REBUILT RATHER THAN JUST RE-CONTAINERED. The host
// makes one segment per request, as its own ffmpeg run, and writes nothing to disk
// (host/hls.js says why, and the reasoning still holds). Three things follow:
//
//   1. Every run produces a WHOLE little MP4 - ftyp, moov, then moof and mdat. A
//      player handed a stream of those plays the first one and stops, because an
//      HLS fMP4 segment is moof+mdat and the header belongs to ONE init segment
//      named by `#EXT-X-MAP`. Tested on the Simulator: self-contained segments
//      with no EXT-X-MAP sit at 0:00 and never start.
//   2. So the header is split off the front and served once, and each segment is
//      shipped from its first `moof` onward.
//   3. And the timestamps have to be put back. ffmpeg's MP4 muxer rebases every
//      output to start at zero, whatever `-copyts` did to the packets - measured
//      against `-output_ts_offset`, `+cmaf` and `+dash`, all of which still wrote
//      `tfdt: 0`. Left alone, every segment claims to begin at the start of the
//      film, so the picture appears and then the clock sticks at the first join.
//
// The fix for (3) is to write each track's real start into its `tfdt`, which this
// file does from the plan the playlist was built from - so the segment and the
// playlist take the same number from the same place and cannot disagree.
//
// NONE OF THIS TOUCHES THE PICTURE. The video packets are copied bytes either way;
// what changes is the box around them and the number saying where they belong.

// An MP4 file is a flat list of boxes: a 4-byte big-endian size, a 4-byte type,
// then the payload. Size 1 means the real size is a 64-bit number after the type,
// and size 0 means "to the end of the file".
//
// Deliberately NOT a general parser. It walks the top level, and inside `moof` it
// walks far enough to find each track's `tfdt`. Anything it does not recognise it
// steps over, so a muxer that starts writing a box we have never seen is not a
// crash.
function topLevelBoxes (buf) {
  const out = []
  let at = 0
  while (at + 8 <= buf.length) {
    let size = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    let header = 8
    if (size === 1) {
      if (at + 16 > buf.length) break
      size = Number(buf.readBigUInt64BE(at + 8))
      header = 16
    } else if (size === 0) {
      size = buf.length - at
    }
    if (size < header || at + size > buf.length) {
      // A truncated final box: report what is there and stop rather than looping.
      out.push({ type, at, size: buf.length - at, header, truncated: true })
      break
    }
    out.push({ type, at, size, header })
    at += size
  }
  return out
}

// WHERE THE HEADER ENDS AND THE FIRST SEGMENT BEGINS - the byte offset of the
// first `moof`. Everything before it (ftyp, moov, and anything else a muxer put
// there) is the init segment; everything from it on is media.
//
// Returns -1 when there is no `moof` in the buffer, which is the honest answer for
// "not enough bytes yet" as well as for "this is not a fragmented MP4". The caller
// distinguishes the two, because it knows whether the stream has ended.
function firstMoofOffset (buf) {
  for (const box of topLevelBoxes(buf)) {
    if (box.truncated) return -1
    if (box.type === 'moof') return box.at
  }
  return -1
}

// The media timescale of each track, read from the init segment - the units every
// `tfdt` in that track is counted in. Keyed by track id, because a `tfdt` is found
// through its own `traf`'s `tfhd`, which names the track by id and not by order.
//
// Walks `moov > trak > (tkhd for the id, mdia > mdhd for the timescale)`. Both are
// full boxes, so a version byte decides where the numbers sit: version 1 uses
// 64-bit creation and modification times and pushes everything 8 bytes later.
function timescalesFrom (init) {
  const scales = new Map()
  const walk = (buf, base) => {
    for (const box of topLevelBoxes(buf)) {
      if (box.truncated) return
      const body = buf.slice(box.at + box.header, box.at + box.size)
      if (box.type === 'moov' || box.type === 'trak' || box.type === 'mdia') {
        walk(body, base)
      } else if (box.type === 'tkhd') {
        const version = body[0]
        base.id = version === 1 ? Number(body.readBigUInt64BE(20)) : body.readUInt32BE(12)
      } else if (box.type === 'mdhd') {
        const version = body[0]
        const timescale = version === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12)
        if (base.id != null && timescale > 0) scales.set(base.id, timescale)
      }
    }
  }
  // `trak` order gives the id before the timescale, so one shared cursor is enough.
  walk(init, {})
  return scales
}

// PUT THE SEGMENT BACK WHERE IT BELONGS. Every `traf` in the buffer has this
// segment's start time ADDED to its `tfdt`, converted into that track's own
// timescale.
//
// ADDED, NOT SET, and the difference is a real segment rather than a nicety.
// `frag_keyframe` cuts a fragment at every keyframe, and a copy plan's segment
// spans the keyframes it chose to skip - measured across two real films, a segment
// runs 4 s to 14 s against a 4 s target. So one segment holds SEVERAL `moof`
// boxes, whose `tfdt` values already say where they sit inside it. Setting them
// all to the segment's start would stack every fragment after the first on top of
// the first, which is a picture that freezes a few seconds into each segment.
// Adding shifts the whole segment onto the film's timeline and leaves its internal
// spacing alone.
//
// The write is IN PLACE and the box never changes size, so nothing downstream has
// to be re-measured: a version-0 `tfdt` holds a 32-bit number and a version-1 one
// holds 64 bits, and each is overwritten with the same width it already had. A
// version-0 box whose new value will not fit is left ALONE rather than wrapped - a
// film long enough to overflow 32 bits at its timescale would otherwise silently
// seek to the wrong place, and a fragment at the wrong time is a worse failure
// than one at time zero. ffmpeg writes version 1 here, so this is a guard rather
// than a path anything takes.
//
// Both tracks are shifted by the SAME amount, which is what keeps them in sync
// with each other. Their small offsets from the cut point were already lost when
// the muxer rebased each track to zero independently; what this restores is the
// only thing the player needs, which is where the fragment sits in the film.
function offsetFragments (buf, { startSeconds, timescales }) {
  const start = Number(startSeconds)
  if (!(start >= 0) || !(timescales instanceof Map) || timescales.size === 0) return 0
  if (start === 0) return 0

  let written = 0
  for (const box of topLevelBoxes(buf)) {
    if (box.type !== 'moof' || box.truncated) continue
    const moof = buf.slice(box.at + box.header, box.at + box.size)
    for (const inner of topLevelBoxes(moof)) {
      if (inner.type !== 'traf' || inner.truncated) continue
      const traf = moof.slice(inner.at + inner.header, inner.at + inner.size)
      let trackId = null
      for (const leaf of topLevelBoxes(traf)) {
        if (leaf.truncated) break
        const body = traf.slice(leaf.at + leaf.header, leaf.at + leaf.size)
        if (leaf.type === 'tfhd') {
          trackId = body.readUInt32BE(4)
        } else if (leaf.type === 'tfdt') {
          const timescale = timescales.get(trackId)
          if (!timescale) continue
          const shift = Math.round(start * timescale)
          const version = body[0]
          if (version === 1) {
            body.writeBigUInt64BE(body.readBigUInt64BE(4) + BigInt(shift), 4)
            written++
          } else {
            const next = body.readUInt32BE(4) + shift
            if (next <= 0xffffffff) {
              body.writeUInt32BE(next, 4)
              written++
            }
          }
        }
      }
    }
  }
  return written
}

// The movflags a segment run needs, as one string, beside the reasons.
//
//   empty_moov + delay_moov  put the samples in fragments rather than in the moov,
//                            and hold the moov back until the first fragment is
//                            known - `delay_moov`'s absence is the SILENT AC-3
//                            corruption recorded in DECISIONS 2026-08-13.
//   default_base_moof        each fragment addresses its own data, which is what
//                            makes an independently produced segment stand alone.
//   frag_keyframe            cut fragments at keyframes.
//   skip_trailer             no `mfra` index at the end. It is a seek table for a
//                            whole file, and a segment is not one - it would be
//                            appended to every segment for nothing.
//   cmaf                     ask the muxer for CMAF-shaped output, which is the
//                            shape Apple's fMP4 segments are.
const SEGMENT_MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof+delay_moov+skip_trailer+cmaf'

// The MP4 sample entry HEVC must carry to be played by Apple's stack: `hvc1`,
// which keeps the parameter sets in the sample description. ffmpeg's MP4 muxer
// writes `hev1` by default, which allows them in-band and which AVFoundation will
// not decode - the same silent no-picture failure by a second route, and the
// reason this is set on the fMP4 path as well as named here.
//
// H.264 needs no equivalent: `avc1` is what the muxer already writes.
const HVC1 = 'hvc1'

// Whether a copied stream has to leave in a fragmented MP4 rather than in MPEG-TS.
// One codec so far, and the list is the point: this is not "iOS gets fMP4", it is
// "HEVC cannot go in TS", which is true of every client and is why the answer does
// not consult the platform.
const NEEDS_FMP4 = new Set(['hevc'])

function needsFmp4 (videoCodec) {
  return NEEDS_FMP4.has(String(videoCodec || '').toLowerCase())
}

// THE SEGMENT AS IT GOES DOWN THE WIRE. ffmpeg's stdout arrives here as a whole
// little MP4 and leaves as an HLS media segment: the header dropped, every
// fragment moved onto the film's clock, and the picture bytes untouched.
//
// IT STAYS A STREAM, which is the constraint the rest of this path is built
// around - nothing is written to disk and a segment is not held in memory to be
// rewritten. Only the small boxes are buffered: `ftyp` and `moov` are a kilobyte
// or so between them and `moof` is a few kilobytes, while `mdat` - which is all of
// the megabytes - is counted past without ever being collected. So the memory this
// costs is a few kilobytes per running segment, whatever the film's bitrate.
//
// AN UNKNOWN BOX IS COPIED, NOT DROPPED. A muxer that starts emitting something we
// have not seen should produce a segment that still plays rather than one missing
// a piece, so the only boxes this treats specially are the ones it has a reason to.
// `mode` picks which half of the run is wanted, because both halves come out of
// the same ffmpeg command:
//
//   'media'   the segment. The header is dropped and every fragment is moved onto
//             the film's clock.
//   'header'  the init segment. The header is kept and the stream ends the moment
//             the first fragment starts, because nothing after it belongs to
//             `#EXT-X-MAP`.
//
// THE TIMESCALES ARE READ FROM THE HEADER THIS RUN DROPS, not passed in. Every
// segment run writes its own `moov` before its first fragment, so the numbers the
// `tfdt` values are counted in arrive in the same stream that needs them - which
// means they cannot be stale, cannot be from a different item, and need no round
// trip to fetch. A caller may still supply them, which is what the unit tests do.
class SegmentShaper extends require('stream').Transform {
  constructor ({ startSeconds = 0, timescales = null, mode = 'media' } = {}) {
    super()
    this.startSeconds = Number(startSeconds) || 0
    this.timescales = timescales instanceof Map && timescales.size ? timescales : null
    this.mode = mode === 'header' ? 'header' : 'media'
    this.seenFragment = false
    // Set once the wanted half is complete. In 'header' mode the rest of the run
    // is still arriving down the pipe and is thrown away rather than parsed.
    this._done = false
    this._buf = Buffer.alloc(0)
    // The header boxes as they go by, kept only until the first fragment tells us
    // the header is complete. A kilobyte or so, and then released.
    this._header = []
    // How much of a passthrough box (an `mdat`) is still to come. While this is
    // above zero every byte goes straight out.
    this._passthrough = 0
  }

  _transform (chunk, _enc, done) {
    if (this._done) return done()
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk
    try {
      this._drain()
    } catch (err) {
      return done(err)
    }
    done()
  }

  _drain () {
    for (;;) {
      if (this._done) { this._buf = Buffer.alloc(0); return }
      if (this._passthrough > 0) {
        const take = Math.min(this._passthrough, this._buf.length)
        if (take === 0) return
        this.push(this._buf.slice(0, take))
        this._buf = this._buf.slice(take)
        this._passthrough -= take
        continue
      }

      if (this._buf.length < 8) return
      let size = this._buf.readUInt32BE(0)
      const type = this._buf.toString('latin1', 4, 8)
      let header = 8
      if (size === 1) {
        if (this._buf.length < 16) return
        size = Number(this._buf.readBigUInt64BE(8))
        header = 16
      } else if (size === 0) {
        // "To the end of the stream" - there is nothing after it to parse, so the
        // rest is passed through as it arrives.
        this._passthrough = Infinity
        continue
      }
      if (size < header) throw new Error('fmp4: box ' + type + ' declares an impossible size')

      // THE BIG ONE IS NEVER COLLECTED. Its header goes out now and its payload
      // streams through, so a two-hour film's segment costs kilobytes here.
      if (type === 'mdat') {
        if (this.mode === 'header') { this._passthrough = size; continue }
        this.push(this._buf.slice(0, header))
        this._buf = this._buf.slice(header)
        this._passthrough = size - header
        continue
      }

      if (this._buf.length < size) return
      const box = this._buf.slice(0, size)
      this._buf = this._buf.slice(size)

      if (type === 'moof') {
        // The header is complete the moment a fragment begins.
        if (!this.seenFragment) {
          this.seenFragment = true
          if (!this.timescales && this._header.length) {
            const scales = timescalesFrom(Buffer.concat(this._header))
            if (scales.size) this.timescales = scales
          }
          this._header = []
          // The init segment is everything up to here and nothing after it.
          if (this.mode === 'header') { this._done = true; this._buf = Buffer.alloc(0); this.push(null); return }
        }
        if (this.timescales) {
          offsetFragments(box, { startSeconds: this.startSeconds, timescales: this.timescales })
        }
        this.push(box)
        continue
      }

      // Everything before the first fragment is the init segment: kept whole in
      // 'header' mode, and in 'media' mode held only long enough to read the
      // timescales out of before it is dropped. Repeating it inside a segment is
      // what `#EXT-X-MAP` exists to make unnecessary.
      if (!this.seenFragment) {
        if (this.mode === 'header') this.push(box)
        else this._header.push(box)
        continue
      }
      this.push(box)
    }
  }

  _flush (done) {
    if (this._done) return done()
    // A truncated tail means ffmpeg died mid-box. Passing the fragment on would
    // hand the player a broken segment that it cannot tell from a short one, so
    // the remainder is dropped and the stream ends - the host's own truncation
    // guard is what turns a non-zero exit into an error the phone can see.
    this._buf = Buffer.alloc(0)
    done()
  }
}

module.exports = {
  topLevelBoxes,
  firstMoofOffset,
  timescalesFrom,
  offsetFragments,
  needsFmp4,
  SegmentShaper,
  SEGMENT_MOVFLAGS,
  HVC1,
  NEEDS_FMP4
}
