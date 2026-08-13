// Reading what a video file actually IS, straight off the disk.
//
// The first half of the folder adapter, and useful on its own before the rest of
// it exists: point it at a real collection and it answers the question v1 was
// shaped around - which files can a phone open as they are.
//
// A server source hands us container and codec facts for free. A folder does not.
// There is no index, no database and nobody who has already looked; there is a tree
// of files, and the only way to know what is in one is to open it. That is what
// ffprobe is for, and it is why the folder adapter is the larger of the two.
//
// RUNNABLE ON ITS OWN: `node host/probe.js <dir>` prints the report. Deliberately
// dependency-free apart from ./items and ./codec-report, both of which are also
// dependency-free, so all three can be copied to a box that holds the drive and run
// there. Probing 12,000 files across a USB disk from another machine is a different
// and much worse proposition than probing them locally.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { execFile } = require('child_process')

// What we will even look at. Deliberately not "every file": a media tree holds
// artwork, subtitles, sample clips and somebody's tax return, and ffprobe will
// happily spend a second failing on each one.
const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.wmv', '.webm',
  '.mpg', '.mpeg', '.m2ts', '.ts', '.flv', '.ogv', '.divx', '.asf', '.vob'
])

// Directories that are never part of a library. `@eaDir` is Synology's thumbnail
// store and it MIRRORS the tree - walking it doubles a scan and reports every film
// twice. The rest are the usual metadata and trash dumps.
const SKIP_DIRS = new Set([
  '@eaDir', '.@__thumb', '#recycle', '$RECYCLE.BIN', 'System Volume Information',
  '.git', 'lost+found', '.Trash-1000', '.DS_Store'
])

// Extras are real files that are not the film: trailers, featurettes, deleted
// scenes. Counting them would inflate a library and skew the format distribution
// toward whatever the extras happen to be, which is usually not what the feature is.
const EXTRA_DIRS = new Set([
  'extras', 'featurettes', 'trailers', 'behind the scenes', 'deleted scenes',
  'interviews', 'scenes', 'shorts', 'other', 'specials.extras', 'sample', 'samples'
])

const isExtra = (name) => EXTRA_DIRS.has(name.toLowerCase())

// A sample clip sitting beside the film. Small, and named for it.
const SAMPLE_RE = /(^|[.\-_ ])sample([.\-_ ]|$)/i
const MIN_FEATURE_BYTES = 20 * 1024 * 1024 // 20 MB - below this it is a clip, not a film

async function * walkVideos (root, { includeExtras = false, depth = 0 } = {}) {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return // an unreadable directory is not a reason to abandon the scan
  }

  for (const entry of entries) {
    const full = path.join(root, entry.name)

    if (entry.isDirectory()) {
      // Hidden directories are skipped WHOLESALE, not just hidden files. Skipping
      // only the files let `.Trash-1000/`, `.@__thumb/` and every other dot-prefixed
      // shadow tree straight through - and a thumbnail mirror double-counts the
      // library while leaving the format distribution untouched, so it looks
      // completely plausible.
      if (entry.name.startsWith('.')) continue
      if (SKIP_DIRS.has(entry.name)) continue
      if (!includeExtras && isExtra(entry.name)) continue
      yield * walkVideos(full, { includeExtras, depth: depth + 1 })
      continue
    }

    if (!entry.isFile()) continue
    if (entry.name.startsWith('.')) continue
    if (!VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) continue
    if (!includeExtras && SAMPLE_RE.test(entry.name)) continue

    yield full
  }
}

function run (cmd, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout)
    })
  })
}

// One file's facts. Returns null when ffprobe cannot make sense of it, which on a
// real drive is not rare - a truncated download, a half-copied file, a rip that
// failed. Those are COUNTED rather than swallowed, because "how much of this
// library is broken" is itself worth knowing.
async function probeFile (file, { ffprobe = 'ffprobe', timeoutMs = 30_000 } = {}) {
  let out
  try {
    out = await run(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration,size',
      '-show_entries', 'stream=codec_type,codec_name,width,height,channels',
      // A NARROW `-show_entries` DROPS TAGS AND DISPOSITION ENTIRELY, and it does it
      // silently - the streams come back, just with nothing on them. Naming a
      // subtitle track needs its language and whether it is forced, so both are asked
      // for explicitly. Still narrow: a full `-show_streams` on 2,986 files hands back
      // megabytes of encoder strings nothing reads.
      '-show_entries', 'stream_tags=language,title',
      '-show_entries', 'stream_disposition=forced,default,hearing_impaired',
      '-of', 'json',
      file
    ], { timeoutMs })
  } catch {
    return null
  }

  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    return null
  }

  const streams = parsed.streams || []
  const video = streams.find(s => s.codec_type === 'video') || null
  const audio = streams.find(s => s.codec_type === 'audio') || null
  const subtitles = streams.filter(s => s.codec_type === 'subtitle')

  // A file with no video stream is not a video, whatever its extension says. An
  // .mp4 holding only audio is a real thing and counting it as a film would be a
  // lie in every table downstream.
  if (!video) return null

  return {
    file,
    // ffprobe reports a comma-separated family ("matroska,webm", "mov,mp4,m4a,3gp,3g2,mj2").
    // The FIRST is the one that matters for playback compatibility.
    container: String(parsed.format?.format_name || '').split(',')[0] || null,
    videoCodec: video.codec_name || null,
    audioCodec: audio?.codec_name || null,
    audioChannels: audio?.channels ?? null,
    width: video.width || null,
    height: video.height || null,
    size: Number(parsed.format?.size) || null,
    duration: Math.round(Number(parsed.format?.duration) || 0) || null,
    subtitleCodecs: subtitles.map(s => s.codec_name).filter(Boolean),
    // THE TRACKS THEMSELVES, not just a tally of their codecs.
    //
    // `subtitleCodecs` above answers the codec report's question - what is in a
    // library - and it is deliberately kept, because that report is cited in
    // DECISIONS. This answers the player's question: which track, in what language,
    // and can it be shown. On the real library it is 2,715 embedded text tracks
    // across the television that were invisible while only files on disk were read.
    //
    // `index` is the stream's index WITHIN the subtitle streams, not within the
    // file, because that is what ffmpeg's `-map 0:s:N` takes. Deriving it from
    // `s.index` would be off by however many video and audio streams came first.
    subtitles: subtitles.map((s, i) => ({
      index: i,
      codec: s.codec_name || null,
      language: s.tags?.language && s.tags.language !== 'und' ? String(s.tags.language).toLowerCase() : null,
      title: s.tags?.title ? String(s.tags.title).slice(0, 120) : null,
      forced: !!s.disposition?.forced,
      default: !!s.disposition?.default,
      // Kodi and Jellyfin both spell this `hearing_impaired`; a lot of files instead
      // say SDH in the title, which the folder adapter already reads off filenames.
      sdh: !!s.disposition?.hearing_impaired
    }))
  }
}

// Probe many, a few at a time. Concurrency is about the DISK, not the CPU: ffprobe
// reads a header and exits, so the limit that matters is how many seeks a spinning
// USB drive will service before it starts thrashing. Four is a reasonable default
// on a 4-core box with one external disk; more helps on an SSD and hurts on a HDD.
async function probeAll (files, { concurrency = 4, ffprobe = 'ffprobe', onProgress = () => {} } = {}) {
  const results = []
  const failed = []
  let index = 0
  let done = 0

  async function worker () {
    for (;;) {
      const i = index++
      if (i >= files.length) return
      const info = await probeFile(files[i], { ffprobe })
      if (info) results.push(info)
      else failed.push(files[i])
      onProgress(++done, files.length)
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
  return { results, failed }
}

// --- standalone CLI ---------------------------------------------------------

async function main () {
  const root = process.argv[2]
  if (!root) {
    process.stderr.write('usage: node probe.js <dir> [concurrency]\n')
    process.exit(1)
  }
  const concurrency = Number(process.argv[3]) > 0 ? Number(process.argv[3]) : 4

  if (!fs.existsSync(root)) {
    process.stderr.write(`no such directory: ${root}\n`)
    process.exit(1)
  }

  const items = require('./items')
  const { summarize, render } = require('./codec-report')

  process.stderr.write('walking...\n')
  const files = []
  for await (const f of walkVideos(root)) files.push(f)
  process.stderr.write(`${files.length} video files\n`)

  const started = Date.now()
  const { results, failed } = await probeAll(files, {
    concurrency,
    onProgress: (n, total) => {
      if (n % 250 === 0 || n === total) {
        const rate = n / ((Date.now() - started) / 1000)
        const left = Math.round((total - n) / Math.max(rate, 0.01))
        process.stderr.write(`  probed ${n}/${total}  (~${left}s left)\n`)
      }
    }
  })

  // The report only needs leaves carrying `media`, so a probe result becomes a
  // minimal item rather than a full one. Nothing here needs a title - and
  // `classified: false` is load-bearing: a flat file scan cannot tell a film from an
  // episode, and printing a film/episode split off one is a confident lie about a
  // library that is half television.
  const leaves = results.map(r => ({ media: items.media(r), subtitleCodecs: r.subtitleCodecs }))

  const summary = summarize(leaves, { classified: false })
  process.stdout.write(render(summary))

  // Keep the raw probe results when asked. A 12,000-file scan is twenty minutes of
  // a spinning disk, and every later question about the library - how the Movies
  // tree differs from the TV tree, which files hold the hard formats, what the
  // 4K one is - is a query against this rather than another scan.
  const jsonAt = process.argv.indexOf('--json')
  if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
    await fsp.writeFile(process.argv[jsonAt + 1], JSON.stringify(results, null, 1))
    process.stderr.write(`raw results written to ${process.argv[jsonAt + 1]}\n`)
  }

  // Subtitle formats across a real library. Worth its own table because the
  // proposal names image-based subtitles as the thing that forces a full transcode
  // to burn in, and nobody has ever counted how common they actually are.
  const subs = new Map()
  let withSubs = 0
  for (const r of results) {
    if (r.subtitleCodecs.length) withSubs++
    for (const c of r.subtitleCodecs) subs.set(c, (subs.get(c) || 0) + 1)
  }
  if (subs.size) {
    process.stdout.write(`EMBEDDED SUBTITLE TRACKS (${withSubs} of ${results.length} files have any)\n`)
    for (const [codec, n] of [...subs.entries()].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${codec.padEnd(14)}  ${String(n).padStart(5)}\n`)
    }
    process.stdout.write('\n')
  }

  if (failed.length) {
    process.stdout.write(`UNREADABLE: ${failed.length} files ffprobe could not make sense of\n`)
    for (const f of failed.slice(0, 10)) process.stdout.write(`  ${f}\n`)
    if (failed.length > 10) process.stdout.write(`  ... and ${failed.length - 10} more\n`)
    process.stdout.write('\n')
  }
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`scan failed: ${e.stack || e.message}\n`)
    process.exit(1)
  })
}

module.exports = { walkVideos, probeFile, probeAll, VIDEO_EXT, SKIP_DIRS, EXTRA_DIRS, MIN_FEATURE_BYTES }
