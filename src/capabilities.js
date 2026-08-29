// WHAT THIS DEVICE DECLARES IT CAN PLAY - the policy that turns a raw
// MediaCodecList probe into the capability declaration the host decides from.
//
// Pure and shared on purpose: the shell's native module (modules/decoder-probe)
// only REPORTS the decoder list; this file JUDGES it, in code Node can test
// against captured fixtures. The suite lesson forcing that split is measured,
// not argued: chips lie about codecs. The TCL's own decoder threw MediaCodec
// 0x80000000 on a real HEVC film (DECISIONS 2026-08-14), so a declaration is
// never read off a spec sheet - it is built from the probe under conservative
// rules, and the player-error retry in the UI is the net for whatever still
// lies through them.
//
// The rules, and why each one exists:
//
//   - VIDEO NEEDS HARDWARE. Every Android ships c2.android.* software decoders
//     that claim almost everything, including 10-bit HEVC they may not decode
//     at watchable speed. A software claim is not a capability - and DROPPED
//     FRAMES ARE THE ONE FAILURE THE RETRY NET CANNOT SEE: a hard decoder
//     error fires the net and the host rescues, silent jank just looks like a
//     bad film. Hardware is the rule precisely because its failures are the
//     LOUD kind.
//   - VIDEO NEEDS 1080p HEADROOM. A decoder capped below 1920x1080 would choke
//     on essentially the whole library, whatever codec it claims.
//   - HEVC NO LONGER NEEDS THE MAIN 10 PROFILE FLAG, and that is a measured
//     reversal (2026-08-16). Chips lie in BOTH directions: the TCL's MTK
//     hardware decoder advertises Main only, yet played real 10-bit x265
//     television flawlessly when force-declared. The profile gate was taxing
//     76% of the television with a transcode it never needed, on the phone
//     that inspired the gate. The other direction - a decoder that really
//     cannot do 10-bit - is exactly what the player-error retry net catches,
//     and the net is hardware-proven end to end (same date): one visible
//     hiccup, an honest re-description, and the host converts. A permanent
//     tax was traded for a rare one-time stumble.
//   - AUDIO NEEDS ONLY A DECODER. Software audio decode is cheap and fine, and
//     a phone that really does decode AC-3 or DTS moves hundreds of Dolby files
//     from the remux path to direct play.
//   - CONTAINERS ARE STATIC. A container is a fact about ExoPlayer's demuxers,
//     which ship in the app and are the same on every device; the probe is
//     about the chip.
//
// The host compares plain codec names (host/remux.js `codec()`), so the values
// here are the canonical spellings that normalization maps TO.

const VIDEO_MIME = {
  'video/avc': 'h264',
  'video/hevc': 'hevc',
  'video/x-vnd.on2.vp9': 'vp9',
  'video/x-vnd.on2.vp8': 'vp8',
  'video/av01': 'av1'
}

const AUDIO_MIME = {
  'audio/mp4a-latm': 'aac',
  'audio/mpeg': 'mp3',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/vorbis': 'vorbis',
  'audio/ac3': 'ac3',
  'audio/eac3': 'eac3',
  'audio/vnd.dts': 'dts'
}

// ExoPlayer's demuxers - the containers half of the declaration, identical on
// every device the app ships to.
const CONTAINERS = ['mp4', 'matroska', 'webm', 'mpegts']

// The conservative static declaration the app shipped with, kept as the floor:
// no probe (iOS today, a failed native link, a broken list) means this, and
// under-declaring costs the host some engine time rather than the viewer a
// black screen. HEVC deliberately absent, per the TCL measurement.
const STATIC = {
  containers: [...CONTAINERS],
  videoCodecs: ['h264', 'vp9', 'av1'],
  audioCodecs: ['aac', 'mp3', 'opus', 'flac', 'vorbis']
}

// AND THE OTHER PHONE, which is a different player entirely and was declaring this one's
// capabilities until 2026-08-20. The probe is Android-only, so iOS fell through to the
// "conservative" static above - and that list is not conservative on an iPhone, it is
// WRONG: it claims Matroska, which is 83% of this library and which AVPlayer will not
// open at all. Tim's first play on the iPhone SE was a black screen with the crossed-out
// play glyph, which is AVFoundation saying exactly that.
//
//   - CONTAINERS: mp4 only (the host folds mov and m4v into it). No Matroska, no WebM.
//   - VIDEO: h264 and hevc. Apple hardware has decoded HEVC since the A9 and, unlike the
//     Android chips this file's rules were written against, it does not lie about it -
//     and the player-error retry net is still the backstop if one ever does.
//     No VP9, no AV1: AVPlayer plays neither.
//   - AUDIO: the ones Apple documents, INCLUDING Dolby. ac3 and eac3 shipped cautiously
//     absent on the first iOS build (2026-08-20) - silence is the worst failure available
//     and a re-encode is the cheapest conversion there is, so they waited for an ear in
//     the room exactly as the Samsung's 5.1 did. Tim then played a Dolby film on the SE
//     and heard it. DTS stays out: Apple does not decode it, and there are no DTS films
//     in this library to be wrong about anyway.
//     The transport is what makes this safe to believe rather than a spec-sheet claim: an
//     iPhone gets HLS for anything repackaged, MPEG-TS carries AC-3 untouched
//     (host/hls.js TS_AUDIO), and AC-3 in HLS is Apple's OWN documented pairing.
const IOS_STATIC = {
  containers: ['mp4'],
  videoCodecs: ['h264', 'hevc'],
  audioCodecs: ['aac', 'mp3', 'alac', 'flac', 'ac3', 'eac3']
}

// The floor for a platform, before any probe refines it. Anything that is not iOS gets
// the Android declaration, which is also the right answer for an unknown platform: it is
// the one that was measured.
function staticFor (platform) {
  return String(platform || '').toLowerCase() === 'ios' ? { ...IOS_STATIC } : { ...STATIC }
}

// probe: Array<{ name, mime, hardware, profiles, maxWidth, maxHeight }> from
// modules/decoder-probe. Returns a declaration, or null when the probe is
// missing or too broken to trust - a list without hardware H.264 and AAC is a
// broken probe, not a phone that plays nothing.
function fromProbe (probe) {
  if (!Array.isArray(probe) || probe.length === 0) return null

  const videos = new Set()
  const audios = new Set()

  for (const d of probe) {
    if (!d || typeof d.mime !== 'string') continue

    const v = VIDEO_MIME[d.mime]
    if (v) {
      if (!d.hardware) continue
      if (!(Number(d.maxWidth) >= 1920) || !(Number(d.maxHeight) >= 1080)) continue
      videos.add(v)
      continue
    }

    const a = AUDIO_MIME[d.mime]
    if (a) audios.add(a)
  }

  if (!videos.has('h264') || !audios.has('aac')) return null

  return {
    containers: [...CONTAINERS],
    videoCodecs: [...videos].sort(),
    audioCodecs: [...audios].sort()
  }
}

// An item's media.videoCodec arrives as whatever its source spelled - ffprobe
// says `hevc`, Jellyfin can say `h265` or `hev1` - and the declared names are
// canonical. A tiny alias table rather than host/remux.js's, because that file
// requires child_process and this one runs in a Bare worklet.
const VIDEO_ALIAS = {
  avc: 'h264', avc1: 'h264', x264: 'h264',
  h265: 'hevc', hvc1: 'hevc', hev1: 'hevc',
  av01: 'av1'
}

// The sound half, the same way: ffprobe says `dca` for DTS and `mlp` for TrueHD,
// Jellyfin spells Dolby with the hyphen. Mirrors host/remux.js's ALIAS entries.
const AUDIO_ALIAS = {
  mp4a: 'aac',
  'ac-3': 'ac3',
  'ec-3': 'eac3',
  dca: 'dts',
  mlp: 'truehd'
}

// The retry declaration: this device just proved, decoder error in hand, that
// its claim to one video codec was a lie - describe it without that codec so
// the host decides again honestly. Never mutates the input.
function without (caps, videoCodec) {
  const norm = String(videoCodec || '').toLowerCase().replace(/\s+/g, '')
  const bad = VIDEO_ALIAS[norm] || norm
  return {
    ...caps,
    videoCodecs: (caps.videoCodecs || []).filter((c) => c !== bad)
  }
}

// The same correction for sound. ExoPlayer does not ERROR on a soundtrack it has no
// decoder for: it plays the picture and selects no audio track at all, so the signal
// is the shell noticing that a film with audio tracks is playing with none chosen.
// The device then describes itself without that codec and the host rebuilds the sound.
function withoutAudio (caps, audioCodec) {
  const norm = String(audioCodec || '').toLowerCase().replace(/\s+/g, '')
  const bad = AUDIO_ALIAS[norm] || norm
  return {
    ...caps,
    audioCodecs: (caps.audioCodecs || []).filter((c) => c !== bad)
  }
}

// HOW A CONVERTED FILM REACHES THIS PLAYER, which is a fact about the player and belongs
// beside what it can open.
//
// A transcode is always a playlist: it is generated, so it has no length and no byte
// offsets, and every player would rather have segments than an unbounded body.
//
// A REMUX SPLITS BY PLATFORM. On Android it collapses to direct play - ExoPlayer opens
// the containers a browser refuses, which is why the phone declared them, so the verdict
// says "repackage" and the player says "no need". AVPlayer is the opposite: it opens
// almost nothing but MP4, and it refuses a generated progressive body outright, because a
// length-less stream with no byte ranges is exactly what AVFoundation will not take. So
// on iOS the repackage travels as HLS - Apple's own format, cut by the host without
// re-encoding (`plan.engine === 'copy'`, the same path a Roku gets).
//
// EXCEPT WHEN THE REMUX REBUILDS THE SOUND. "ExoPlayer opens the container" was only
// ever true of the container: a verdict of remux with `audio` other than copy means
// the host judged the soundtrack unplayable here, and playing the raw file anyway is
// a film in silence - ExoPlayer selects no audio track and raises no error. So that
// remux is a playlist on every platform, picture copied and sound rebuilt per segment.
// Field report 2026-08-29: an x265 MKV with Dolby sound, silent on Android.
function wantsPlaylist (mode, platform, audio = null) {
  if (mode === 'transcode') return true
  if (mode !== 'remux') return false
  if (audio && String(audio).toLowerCase() !== 'copy') return true
  return String(platform || '').toLowerCase() === 'ios'
}

module.exports = { fromProbe, without, withoutAudio, STATIC, IOS_STATIC, staticFor, wantsPlaylist, CONTAINERS }
