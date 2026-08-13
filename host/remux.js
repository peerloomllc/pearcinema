// REMUX: repackaging a film so the client will open it, without touching the picture.
//
// Approved as a T3 in proposals/2026-08-13-remux.md. Read that before changing
// anything here - particularly the two constraints that shaped it, because both are
// counter-intuitive and both are easy to undo by accident:
//
//   1. A REMUXED FILE IS THE SAME SIZE AS ITS SOURCE. Nothing is re-encoded, so a
//      4 GB film remuxes to about 4 GB. Any design that writes the output down
//      before serving it needs 4 GB of the host's INTERNAL disk per film watched, on
//      a box whose library is on an external drive for exactly that reason.
//   2. AN ORPHANED FFMPEG IS THE WHOLE BOX. Every process here belongs to one
//      response and dies with it.
//
// Constraint 1 is why this writes NOTHING TO DISK. ffmpeg's output goes straight
// down the socket, so the disk cap the proposal spends a section on is satisfied by
// there being no cache to cap. That is a deviation from the proposal's HLS design
// and it is recorded in DECISIONS 2026-08-13 rather than made quietly: HLS is still
// the right answer for the phone, whose native players seek by byte range and cannot
// be driven. The browser's player is ours and can be, so the browser gets the
// simpler mechanism first and the phone gets HLS when there is a phone.
//
// WHAT IT DOES NOT DO. No video re-encoding, ever - that is rung three, the 218 AVI
// files, and it needs hardware acceleration and its own proposal. If the video codec
// is not something the client can decode, this refuses rather than quietly becoming
// a transcoder that melts a Raspberry Pi.

const { spawn } = require('child_process')

// Containers we can produce. Fragmented MP4, because a plain MP4 puts its index at
// the END of the file and therefore cannot be written to a pipe - ffmpeg would have
// to seek back to the start to finish it, and a socket does not seek.
//
// `delay_moov` IS LOAD-BEARING AND ITS ABSENCE IS SILENT. Without it, `empty_moov`
// writes the header before a single packet has been read - and an AC-3 track's
// `stsd` entry needs a `dac3` box whose contents come from the first audio frame's
// bitstream. With nothing read yet, ffmpeg writes that box with SIZE ZERO. ffmpeg
// exits 0, the bytes stream happily, and the file is unopenable: "invalid size 0 in
// stsd, error reading header".
//
// Measured 2026-08-13, and it very nearly cost the whole Dolby win: AC-3 and E-AC-3
// are ~620 files of the real library and the entire reason rung two shrank to 19.
// Copying them into a STREAMED fragmented MP4 was producing a corrupt file, while
// copying them into a normal seekable MP4 worked - which is why the earlier
// measurement, done with a file on disk, could not have caught it.
const FMP4_FLAGS = 'frag_keyframe+empty_moov+default_base_moof+delay_moov'

// Video codecs an MP4 can legally carry AND a modern client can decode. Rung one is
// a container rewrite, so the streams have to already be acceptable - this list is
// the definition of "already acceptable".
const MP4_VIDEO = new Set(['h264', 'hevc', 'av1'])

// Audio the same. AC-3 and E-AC-3 are in this list because of a measurement rather
// than an assumption: DECISIONS 2026-08-13 remuxed real files and watched iOS play
// them, which moved ~620 television files out of the re-encode bucket and into this
// one. DTS and TrueHD are NOT here - iOS drops DTS audio silently and ffmpeg refuses
// to mux TrueHD into MP4 at all.
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'flac', 'alac', 'opus'])

// The audio we can cheaply re-encode when the client cannot take the original.
// Rung two, and per the same measurement it is 19 files out of 2,986 - so this path
// exists for completeness rather than for volume.
const AUDIO_FALLBACK = { codec: 'aac', bitrate: '192k' }

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

// Container names as the two sources write them, mapped onto one vocabulary.
// ffprobe says `matroska`, Jellyfin says `mkv`, and ffprobe collapses the whole ISO
// base media family to `mov` so an ordinary .mp4 arrives named that. A client
// declaring one spelling must match a file carrying the other, or a host remuxes
// files for a client that could already open them.
const CONTAINER_ALIAS = {
  matroska: 'matroska', mkv: 'matroska', 'matroska,webm': 'matroska',
  mov: 'mp4', mp4: 'mp4', m4v: 'mp4', 'mov,mp4,m4a,3gp,3g2,mj2': 'mp4',
  avi: 'avi', divx: 'avi', 'avi,divx': 'avi',
  mpegts: 'mpegts', ts: 'mpegts', m2ts: 'mpegts',
  webm: 'webm', asf: 'wmv', wmv: 'wmv'
}

const container = (c) => CONTAINER_ALIAS[norm(c)] || norm(c)

// Codec names as ffprobe and Jellyfin write them, mapped onto one vocabulary. Kept
// deliberately separate from the browser's table in host/ui/app/playback.js: that
// one answers "will this client play it", this one answers "can we put it in an
// MP4", and conflating the two questions is how a host starts re-encoding files
// that would have played.
const ALIAS = {
  avc: 'h264', avc1: 'h264', x264: 'h264', h264: 'h264',
  h265: 'hevc', hvc1: 'hevc', hev1: 'hevc', hevc: 'hevc',
  av01: 'av1', av1: 'av1',
  'mpeg4': 'mpeg4', msmpeg4v3: 'mpeg4', divx: 'mpeg4', xvid: 'mpeg4',
  mp4a: 'aac', aac: 'aac',
  'ac-3': 'ac3', ac3: 'ac3',
  'ec-3': 'eac3', eac3: 'eac3',
  dca: 'dts', dts: 'dts',
  truehd: 'truehd', mlp: 'truehd',
  pcm_s16le: 'pcm', pcm_s24le: 'pcm'
}

const codec = (c) => ALIAS[norm(c)] || norm(c)

// WHAT SHOULD THIS CLIENT BE SENT?
//
// THE HOST DECIDES, and direct play always wins when it will work - it is free and
// it is exactly the original file. A client that could demand remux is a client that
// makes a box remux files that would have played.
//
// `client` is what the client says it can open, which is the only honest source for
// that: a browser knows its own canPlayType answers and a phone knows its own
// decoder. Absent, we assume MP4-and-H.264, the universal floor.
//
// Returns { mode, reason, audio } where mode is 'direct' | 'remux' | 'refuse'.
function decide (media, client = {}) {
  const box = container(media?.container)
  const v = codec(media?.videoCodec)
  const a = codec(media?.audioCodec)

  const containers = new Set((client.containers || ['mp4']).map(container))
  const videos = new Set((client.videoCodecs || ['h264']).map(codec))
  const audios = new Set((client.audioCodecs || ['aac']).map(codec))

  // Nothing is known about the file. Direct play and let the client find out - a
  // guess that sends it down the expensive path would be worse than a failed play.
  if (!box && !v) return { mode: 'direct', reason: 'nothing is known about this file' }

  const containerOk = containers.has(box)

  if (containerOk && (!v || videos.has(v)) && (!a || audios.has(a))) {
    return { mode: 'direct', reason: 'the client can open this file as it is' }
  }

  // THE VIDEO DECIDES WHETHER REMUX IS EVEN POSSIBLE. A container rewrite cannot
  // change the picture, so if the client cannot decode this video codec, or MP4
  // cannot carry it, no amount of repackaging helps. Refuse and say so rather than
  // starting an encoder we do not have.
  if (v && !videos.has(v)) {
    return { mode: 'refuse', reason: `this client cannot decode ${v.toUpperCase()} video, and repackaging cannot change the picture` }
  }
  if (v && !MP4_VIDEO.has(v)) {
    return { mode: 'refuse', reason: `${v.toUpperCase()} video cannot be carried in an MP4 without re-encoding it` }
  }

  // The audio may need rebuilding, which is cheap - and per the 2026-08-13
  // measurement this is 19 files out of 2,986, because Dolby Digital passes straight
  // through.
  const audioOk = !a || (audios.has(a) && MP4_AUDIO.has(a))
  return {
    mode: 'remux',
    reason: audioOk
      ? 'the picture and sound are already right; only the container has to change'
      : `the container has to change and the ${a.toUpperCase()} soundtrack has to be rebuilt, which is quick`,
    audio: audioOk ? 'copy' : AUDIO_FALLBACK.codec
  }
}

// The ffmpeg argv for one remux, starting at `at` seconds.
//
// AN ARGV ARRAY, NEVER A SHELL STRING. A real library is full of filenames with
// quotes, brackets and semicolons in them, and this input path comes from the disk
// rather than from us.
//
// `-ss` BEFORE `-i` is the input seek: it jumps in the file rather than decoding to
// the seek point and throwing it away, which is the difference between a seek
// landing in under a second and taking a minute on a two-hour film. With `-c copy`
// it lands on the nearest keyframe at or before the requested time, which is why the
// player is told the offset it actually got rather than the one it asked for.
function argsFor ({ input, at = 0, audio = 'copy', headers = null }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']

  // Only for a network input (the Jellyfin adapter). ffmpeg wants one blob with CRLF
  // between headers.
  if (headers) args.push('-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join(''))

  if (at > 0) args.push('-ss', String(at))

  args.push('-i', input)

  // ONE video and ONE audio stream. A film with six audio tracks and twelve subtitle
  // tracks would otherwise have all of them mapped, and MP4 cannot carry the PGS
  // ones at all - the mux fails on a file that was about to work. `?` makes each
  // optional, so a film with no audio still remuxes.
  args.push('-map', '0:v:0', '-map', '0:a:0?')

  // NO CHAPTERS. ffmpeg copies them by default, and the MP4 muxer writes them as a
  // `bin_data` track - so a ripped Blu-ray with 34 chapter marks comes out with a
  // THIRD stream nobody asked for, in a fragmented MP4 where a strict player has
  // every right to object.
  //
  // Found on a real film and invisible to every synthetic clip, because a clip built
  // by ffmpeg has no chapters. Nothing in PearCinema exposes chapters, so dropping
  // them costs nothing and removes a whole class of "why does this one not play".
  args.push('-map_chapters', '-1')

  args.push('-c:v', 'copy')
  if (audio === 'copy') args.push('-c:a', 'copy')
  else args.push('-c:a', AUDIO_FALLBACK.codec, '-b:a', AUDIO_FALLBACK.bitrate, '-ac', '2')

  // Subtitles are dropped, deliberately. Text tracks are served separately through
  // subtitle.get, and image-based ones cannot go in an MP4 - carrying them here would
  // fail the mux for the sake of something the client already gets another way.
  args.push('-sn', '-dn')

  args.push('-movflags', FMP4_FLAGS, '-f', 'mp4', 'pipe:1')
  return args
}

// A running remux. One process, one output stream, and a kill that is idempotent
// because it will be called from both the response closing and the session being
// reaped.
class RemuxProcess {
  constructor ({ proc, at, audio, log }) {
    this.proc = proc
    this.at = at
    this.audio = audio
    this.log = log
    this.stdout = proc.stdout
    this.killed = false
    this.stderr = ''

    // Kept, but bounded. ffmpeg's diagnostics are the only explanation available when
    // a remux fails, and an unbounded buffer on a process that can run for two hours
    // is its own bug.
    proc.stderr.on('data', (c) => {
      if (this.stderr.length < 8192) this.stderr += c.toString()
    })
  }

  kill () {
    if (this.killed) return
    this.killed = true
    try { this.proc.kill('SIGKILL') } catch {}
  }
}

// The engine. Holds no state beyond the live processes, because there is no cache -
// see the header.
class Remuxer {
  constructor ({ ffmpeg = 'ffmpeg', maxConcurrent = 3, log = () => {} } = {}) {
    this.ffmpeg = ffmpeg
    this.maxConcurrent = maxConcurrent
    this.log = log
    this.live = new Set()
  }

  get running () { return this.live.size }

  // Start one. Throws rather than queueing when the box is already busy: a viewer
  // told "the server is busy" can try again, where a viewer watching a spinner for
  // four minutes assumes it is broken.
  start ({ input, at = 0, audio = 'copy', headers = null }) {
    if (this.live.size >= this.maxConcurrent) {
      const e = new Error(`this host is already repackaging ${this.live.size} films, which is as many as it will do at once`)
      e.code = 'BUSY'
      throw e
    }

    const args = argsFor({ input, at, audio, headers })
    const proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const session = new RemuxProcess({ proc, at, audio, log: this.log })
    this.live.add(session)

    const done = (why) => {
      if (!this.live.has(session)) return
      this.live.delete(session)
      session.kill()
      this.log('remux:ended', { why, at, remaining: this.live.size, err: session.stderr.slice(0, 200) || undefined })
    }

    proc.on('close', (code) => done(code === 0 ? 'finished' : `exit ${code}`))
    proc.on('error', (err) => {
      this.log('remux:spawn-failed', { err: err.message })
      done('spawn failed')
    })

    this.log('remux:started', { at, audio, running: this.live.size })
    return session
  }

  // Every process, gone. Called on shutdown and when a device is revoked - a remux
  // running for somebody who has just lost access is exactly the "revoke did not
  // reach it" failure `cast.js` taught us to look for.
  killAll () {
    for (const s of this.live) s.kill()
    this.live.clear()
  }
}

module.exports = {
  Remuxer, decide, argsFor, codec, container,
  MP4_VIDEO, MP4_AUDIO, AUDIO_FALLBACK, FMP4_FLAGS
}
