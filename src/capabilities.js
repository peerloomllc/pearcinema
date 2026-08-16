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

module.exports = { fromProbe, without, STATIC, CONTAINERS }
