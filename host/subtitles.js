// Subtitles: which tracks can actually be shown, and getting one out of a file.
//
// THE MEASUREMENT THAT SHAPES THIS FILE. On the real library (DECISIONS 2026-08-12):
//
//   MOVIES   232 PGS tracks across 240 films, and only 57 SubRip
//   TV     1,429 PGS against 2,715 SubRip
//
// So the two halves of a collection fail in opposite ways and neither is the edge
// case. On the films, the subtitles inside the file are mostly IMAGE tracks - a PGS
// track is a sequence of pictures, and showing one means drawing it into the video,
// which is a full re-encode this version does not have. On the television, they are
// mostly TEXT, which is a cheap extraction and worth doing.
//
// The rule that follows, and it is a UI rule as much as a host one: LIST WHAT CANNOT
// BE SHOWN, with the reason. Somebody hunting for subtitles a file demonstrably
// contains is worse served by silence than by "not yet, and here is why".

const { spawn } = require('child_process')

// What can be handed to a player as text. `mov_text` is MP4's own flavour and
// `text` is Matroska's plain one; both convert to WebVTT without a decoder.
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text'])

// Pictures pretending to be subtitles. Every one of these needs the video re-encoded
// to burn it in, which is rung three of the remux ladder and not built.
//
// TWO VOCABULARIES, AND THE ONE THIS LIST WAS MISSING IS THE COMMON ONE. Jellyfin
// reports PGS as `PGSSUB`; ffprobe calls the same track `hdmv_pgs_subtitle`. The list
// was inherited from the Jellyfin adapter, so the moment the folder adapter started
// reading real files, 53 of 58 film tracks fell through to the generic "unsupported
// subtitle format: hdmv_pgs_subtitle" - technically true, useless to read, and
// exactly the silence this feature exists to replace. Found on the real library
// 2026-08-13, minutes after it first ran there.
const IMAGE_SUBTITLE_CODECS = new Set([
  // ffprobe's spellings, which is what the folder adapter meets
  'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'dvb_teletext', 'xsub',
  // Jellyfin's, which is what the server adapter meets
  'pgssub', 'pgs', 'dvdsub', 'dvbsub'
])

// Why a track will not appear, in the words somebody reading a player would want.
// One sentence, no codec names where a plain word will do, and it always says what
// would have to happen rather than just refusing.
function reasonFor (codec) {
  const c = String(codec || '').toLowerCase()
  if (TEXT_SUBTITLE_CODECS.has(c)) return null
  if (IMAGE_SUBTITLE_CODECS.has(c)) {
    return 'These subtitles are pictures rather than text, so showing them means drawing them into the video - a re-encode on the host, which needs its video hardware.'
  }
  return `unsupported subtitle format: ${c || 'unknown'}`
}

// Can this track be BURNED into the picture? Exactly the image formats: burning
// a text track would pay a re-encode for something the client renders free, and
// an unknown format cannot be composited at all. PGS and DVD bitmaps ride
// ffmpeg's overlay identically, so one answer covers both vocabularies.
function burnable (codec) {
  return IMAGE_SUBTITLE_CODECS.has(String(codec || '').toLowerCase())
}

// A readable name for one track, from whatever the file bothered to record.
function titleFor ({ title, language, forced, sdh } = {}) {
  const base = title || (language ? String(language).toUpperCase() : 'Subtitles')
  return [base, forced && !/forced/i.test(base) ? 'forced' : null, sdh && !/sdh/i.test(base) ? 'SDH' : null]
    .filter(Boolean)
    .join(' ')
}

// ONE SUBTITLE TRACK, OUT OF THE FILE, AS WEBVTT.
//
// `index` counts within the file's SUBTITLE streams, which is what `-map 0:s:N`
// takes - see probe.js, where it is recorded that way for this reason.
//
// Nothing is written to disk and nothing is decoded: a text subtitle track is
// kilobytes of text, so this is a header read and a format conversion rather than
// anything resembling a transcode. It is safe to run on a Pi-class box in a way the
// video path deliberately is not.
function extractSubtitle ({ ffmpeg = 'ffmpeg', input, index = 0, log = () => {} } = {}) {
  if (!input) return null

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', input,
    // The track, and ONLY the track. Without `-map` ffmpeg picks its own idea of the
    // best stream of each kind and would try to write video into a WebVTT file.
    '-map', `0:s:${Math.max(0, Number(index) || 0)}`,
    '-c:s', 'webvtt',
    '-f', 'webvtt',
    'pipe:1'
  ]

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  let err = ''
  proc.stderr.on('data', (d) => { if (err.length < 2000) err += d })
  proc.on('error', (e) => log('subtitle:spawn-failed', { err: e?.message }))
  proc.on('close', (code) => {
    // A non-zero exit here is not fatal to anything - the caller gets a short or
    // empty body and the player shows no cues - but it is the only explanation
    // available when a track that was listed turns out not to arrive.
    if (code) log('subtitle:extract-failed', { code, err: err.trim().slice(0, 300) })
  })

  // THE PROCESS DIES WITH ITS READER, the same rule the remux path follows. An
  // ffmpeg that outlives its response is an orphan holding a file handle on the
  // library drive, and a few of those is the whole box.
  proc.stdout.on('close', () => { if (proc.exitCode === null) proc.kill('SIGKILL') })

  return proc.stdout
}

module.exports = {
  TEXT_SUBTITLE_CODECS,
  IMAGE_SUBTITLE_CODECS,
  reasonFor,
  burnable,
  titleFor,
  extractSubtitle
}
