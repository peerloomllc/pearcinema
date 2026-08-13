// WHAT THIS BROWSER WILL ACTUALLY PLAY.
//
// This file is the reason a web player earns its place beyond "you can watch a
// film now". A browser is a SECOND compatibility engine with published rules, run
// against the same library the phone reads - so "which of my files actually play"
// stops being an opinion and becomes an answer.
//
// AND BROWSERS DISAGREE WITH EACH OTHER, which is exactly why this file ASKS rather
// than assumes. Measured 2026-08-13 against a real browser: Chromium-based ones
// (Chrome, Brave, Edge) answer `maybe` for `video/x-matroska` and genuinely play an
// MKV holding H.264 and AAC. Safari and iOS do not. So "no browser opens Matroska"
// was too strong a claim, and a hard-coded refusal would have made PearCinema
// repackage films that were already playing perfectly.
//
// What every browser measured DOES refuse is HEVC and Dolby audio - and HEVC is 64%
// of the real television library. So the remux case is not smaller than it looked,
// it is differently shaped: fewer container refusals, and the codec ones are what
// remain.
//
// So the rule everywhere below: SAY WHY, and never hide an item we cannot play.
// A film that silently fails to start sends someone hunting through their router
// settings. A film that says "your browser will not open MKV files" sends them to
// the right place.

// Containers a browser demuxer will even look at. Everything else - matroska, avi,
// mpegts, wmv, flv - is refused at the box, before a codec is ever considered.
export const BROWSER_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg'])

// What an MP4 can legally carry. Mirrors host/remux.js deliberately rather than
// sharing a module: this file is bundled into a browser and that one runs in Node,
// and the two answer different questions - "will this browser play it" against "can
// we put it in an MP4". A test pins them together so the copies cannot drift.
export const MP4_VIDEO = new Set(['h264', 'hevc', 'av1'])
export const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'flac', 'alac', 'opus'])

// What this browser tells the host it can open, as a query string. The host decides
// the mode from it; the client never asks to be repackaged.
export function capabilityQuery (caps) {
  const video = ['h264', 'hevc', 'av1', 'vp9', 'vp8'].filter(c => caps[c])
  const audio = ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'vorbis'].filter(c => caps[c])
  return new URLSearchParams({
    containers: 'mp4' + (caps.matroska ? ',matroska' : ''),
    video: video.join(',') || 'h264',
    audio: audio.join(',') || 'aac'
  }).toString()
}

// A short, human name for a container, for the sentence we show. ffprobe's
// `matroska` and Jellyfin's `mkv` are the same thing to a person.
const CONTAINER_NAME = {
  matroska: 'MKV', mkv: 'MKV', 'matroska,webm': 'MKV',
  avi: 'AVI', divx: 'AVI',
  mpegts: 'MPEG-TS', ts: 'MPEG-TS', m2ts: 'MPEG-TS',
  wmv: 'WMV', asf: 'WMV', flv: 'FLV',
  mpg: 'MPEG', mpeg: 'MPEG',
  mov: 'MP4', mp4: 'MP4', m4v: 'MP4', webm: 'WebM', ogv: 'Ogg', ogg: 'Ogg'
}

export const containerName = (c) => CONTAINER_NAME[String(c || '').toLowerCase()] || String(c || '').toUpperCase()

// The codec strings we ask the browser about. Representative profiles, not exact
// ones: canPlayType answers about a FAMILY, and asking for the exact level of every
// file would need the full codec string, which no source gives us.
const PROBES = {
  h264: 'video/mp4; codecs="avc1.42E01E"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
  vp8: 'video/webm; codecs="vp8"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
  mpeg4: 'video/mp4; codecs="mp4v.20.8"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  mp3: 'audio/mpeg',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  opus: 'audio/webm; codecs="opus"',
  vorbis: 'audio/webm; codecs="vorbis"',
  flac: 'audio/mp4; codecs="flac"',
  // Asked as a container rather than a codec. Edge answers 'maybe' here where
  // Chrome and Safari answer '' - which is the whole reason MKV support is probed
  // rather than assumed absent.
  matroska: 'video/x-matroska'
}

// ffprobe and Jellyfin do not agree on codec names, so normalize before asking.
const CODEC_ALIAS = {
  avc: 'h264', avc1: 'h264', h264: 'h264', x264: 'h264',
  hevc: 'hevc', h265: 'hevc', hvc1: 'hevc', hev1: 'hevc',
  vp8: 'vp8', vp9: 'vp9', 'vp09': 'vp9',
  av1: 'av1', av01: 'av1',
  mpeg4: 'mpeg4', msmpeg4v3: 'mpeg4', divx: 'mpeg4', xvid: 'mpeg4',
  aac: 'aac', 'mp4a': 'aac',
  mp3: 'mp3', mp2: 'mp3',
  ac3: 'ac3', 'ac-3': 'ac3',
  eac3: 'eac3', 'ec-3': 'eac3',
  opus: 'opus', vorbis: 'vorbis', flac: 'flac',
  dts: 'dts', truehd: 'truehd', pcm_s16le: 'pcm'
}

export const normalizeCodec = (c) => CODEC_ALIAS[String(c || '').toLowerCase().replace(/\s+/g, '')] || String(c || '').toLowerCase()

// Ask the browser once, at startup. `canPlayType` is cheap but not free, and the
// answer cannot change while the page is open.
//
// Injectable so this file is testable in Node, where there is no <video> at all.
export function probeCapabilities (canPlayType) {
  const ask = canPlayType || defaultCanPlayType()
  const caps = {}
  for (const [name, type] of Object.entries(PROBES)) {
    const answer = ask(type)
    // '' means no. 'maybe' and 'probably' both mean try it - a browser says 'maybe'
    // when it cannot be certain without the bytes, and refusing on 'maybe' would
    // hide files that play perfectly well.
    caps[name] = answer === 'probably' || answer === 'maybe'
  }
  return caps
}

function defaultCanPlayType () {
  try {
    const el = document.createElement('video')
    return (t) => el.canPlayType(t)
  } catch {
    return () => ''
  }
}

// THE VERDICT for one item, in this browser.
//
//   play    - it should just work
//   nosound - the picture will play and there will be silence (a DTS or TrueHD
//             track in a container the browser accepts). Worth playing, worth
//             warning about, and NOT the same as a refusal.
//   refuse  - the browser will show nothing. Always carries a reason.
//   unknown - the source told us nothing about the file. Let the user try; a
//             guess dressed as a verdict is worse than no verdict.
export function verdictFor (item, caps) {
  const m = item?.media
  if (!m || (!m.container && !m.videoCodec)) {
    return { status: 'unknown', reason: 'This source did not say what is inside the file. It may play.' }
  }

  const container = String(m.container || '').toLowerCase()
  const video = normalizeCodec(m.videoCodec)
  const audio = normalizeCodec(m.audioCodec)
  const name = containerName(container)

  if (!BROWSER_CONTAINERS.has(container)) {
    // Edge does open Matroska. Ask before refusing, rather than assuming the
    // Chrome answer is every browser's answer.
    const mkv = container === 'matroska' || container === 'mkv' || container === 'matroska,webm'
    if (!(mkv && caps.matroska)) {
      // IS THIS FIXABLE BY REPACKAGING? Only if the streams inside are ones this
      // browser can already decode AND an MP4 can carry them. That is the whole of
      // rung one, and on the measured library it is true of nearly everything - which
      // is why this flag turns most of a collection from a refusal into a film.
      const remuxable = (!video || (caps[video] && MP4_VIDEO.has(video))) &&
                        (!audio || MP4_AUDIO.has(audio))
      return {
        status: 'refuse',
        remuxable,
        reason: remuxable
          ? `Your browser will not open ${name} files - the same refusal an iPhone gives. The picture and sound inside are fine, so PearCinema repackages them into a container it will open, without re-encoding anything.`
          : `Your browser will not open ${name} files, and what is inside cannot simply be repackaged either: ${!video || caps[video] ? `an MP4 cannot carry ${String(m.audioCodec || '').toUpperCase()} audio` : `your browser cannot decode ${String(m.videoCodec || '').toUpperCase()} video`}. Playing this one needs re-encoding, which this version does not do.`
      }
    }
  }

  // A codec we never probed for (ProRes, MPEG-2, something exotic) lands here as
  // undefined and is refused, same as a probed-and-rejected one. That is the safe
  // direction: the player always offers Play anyway, so a false refusal costs one
  // click, where a false promise costs a black screen with no explanation.
  if (video && !caps[video]) {
    // Repackaging cannot change the picture, so this one is not fixable by it.
    return {
      status: 'refuse',
      remuxable: false,
      reason: `Your browser cannot decode ${String(m.videoCodec).toUpperCase()} video. Repackaging cannot change the picture, so this needs re-encoding, which this version does not do.`
    }
  }

  if (audio && !caps[audio]) {
    // FIXABLE, and cheaply. Rebuilding a soundtrack is rung two and per the
    // 2026-08-13 measurement it is a rounding error of the library - so a browser
    // that cannot decode this audio should be given sound rather than told to
    // accept a silent film. The picture is still never touched.
    return {
      status: 'nosound',
      remuxable: MP4_VIDEO.has(video) || !video,
      reason: `Your browser cannot decode ${String(m.audioCodec).toUpperCase()} sound. The picture is untouched; only the soundtrack is rebuilt, which is quick.`
    }
  }

  return { status: 'play', reason: null }
}

// How much of a LIST this browser can play, for the honest line above a library.
// Counted rather than estimated, and unknowns counted separately so the number is
// never quietly inflated by files we simply know nothing about.
export function tally (list, caps) {
  const out = { total: 0, play: 0, nosound: 0, refuse: 0, unknown: 0 }
  for (const item of list || []) {
    if (!item?.media) continue
    out.total++
    out[verdictFor(item, caps).status]++
  }
  return out
}
