// What is actually IN this library?
//
// THE REASON V1 IS DIRECT-PLAY ONLY. The expensive, uncertain part of PearCinema is
// not the peer-to-peer layer, which is inherited and proven - it is which files in a
// real collection a real phone can actually open. Building a transcode pipeline
// first means building it against a guess about which formats need one.
//
// So before there is a phone client, there is this: point the host at a real
// library and get the distribution back. Containers, video codecs, audio codecs,
// resolutions, and the combinations that appear together - because it is the
// COMBINATION that decides, and the notorious one (MKV + H.265 + TrueHD) does not
// direct-play on iOS at all.
//
// It REPORTS. It does not judge. A verdict here would answer the question this
// exists to ask, and the honest answer only arrives once a phone has tried.

const items = require('./items')

const PAGE = 200

function bump (map, key) {
  if (!key) key = '(unknown)'
  map.set(key, (map.get(key) || 0) + 1)
}

function top (map, limit = 20) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
}

function bucket (height) {
  if (!height) return '(unknown)'
  if (height >= 2000) return '4K'
  if (height >= 1000) return '1080p'
  if (height >= 700) return '720p'
  return 'SD'
}

// Walk every leaf in the library. Both roots: films are a flat list, episodes hang
// under the show tree, and the report has to cover both or it describes half a
// collection.
async function collect (adapter, { onProgress = () => {} } = {}) {
  const leaves = []

  const walk = async (query) => {
    let cursor = 0
    for (;;) {
      const res = await adapter.list({ ...query, limit: PAGE, cursor })
      for (const item of res.items) leaves.push(item)
      onProgress(leaves.length)
      if (res.cursor === null || res.cursor === undefined) break
      cursor = res.cursor
    }
  }

  await walk({ type: 'movies' })

  // Episodes, per season, per series. Scoped rather than asked for wholesale,
  // because a scoped list is what the adapter contract guarantees and an unscoped
  // episode dump is explicitly a bad request.
  let seriesCursor = 0
  for (;;) {
    const shows = await adapter.list({ type: 'series', limit: PAGE, cursor: seriesCursor })
    for (const show of shows.items) {
      const seasons = await adapter.list({ type: 'seasons', seriesId: show.id, limit: PAGE })
      for (const s of seasons.items) {
        await walk({ type: 'episodes', seasonId: s.id })
      }
    }
    if (shows.cursor === null || shows.cursor === undefined) break
    seriesCursor = shows.cursor
  }

  return leaves
}

function summarize (leaves) {
  const containers = new Map()
  const videoCodecs = new Map()
  const audioCodecs = new Map()
  const resolutions = new Map()
  const combos = new Map()

  let unknown = 0
  let bytes = 0

  for (const leaf of leaves) {
    const m = leaf.media || {}
    if (!m.container && !m.videoCodec && !m.audioCodec) unknown++
    bump(containers, m.container)
    bump(videoCodecs, m.videoCodec)
    bump(audioCodecs, m.audioCodec)
    bump(resolutions, bucket(m.height))
    bump(combos, `${m.container || '?'} / ${m.videoCodec || '?'} / ${m.audioCodec || '?'}`)
    bytes += m.size || 0
  }

  return {
    total: leaves.length,
    movies: leaves.filter(l => l.type === 'movie').length,
    episodes: leaves.filter(l => l.type === 'episode').length,
    // A library whose source reports no media facts at all cannot answer the
    // direct-play question, and saying so is more useful than a table of blanks.
    unknownMedia: unknown,
    bytes,
    containers: top(containers),
    videoCodecs: top(videoCodecs),
    audioCodecs: top(audioCodecs),
    resolutions: top(resolutions),
    combos: top(combos, 30)
  }
}

function gb (bytes) {
  if (!bytes) return '?'
  return (bytes / 1e9).toFixed(1) + ' GB'
}

function render (s) {
  const out = []
  const pct = (n) => s.total ? ` (${Math.round((n / s.total) * 100)}%)` : ''

  out.push('')
  // "items", not "playable items". In a report about codecs, the word playable
  // reads as a direct-play claim - which is the exact confusion this whole file is
  // written to avoid. These are the things you can press play on; whether the press
  // works is what the report cannot say.
  out.push(`LIBRARY: ${s.total} items - ${s.movies} films, ${s.episodes} episodes, ${gb(s.bytes)}`)

  if (s.unknownMedia) {
    out.push('')
    out.push(`  ${s.unknownMedia} of them report NO container or codec at all${pct(s.unknownMedia)}.`)
    out.push('  This source cannot answer the direct-play question for those files.')
  }

  const table = (title, rows) => {
    out.push('')
    out.push(title)
    const width = Math.max(...rows.map(([k]) => String(k).length), 10)
    for (const [k, n] of rows) {
      out.push(`  ${String(k).padEnd(width)}  ${String(n).padStart(5)}${pct(n)}`)
    }
  }

  table('CONTAINERS', s.containers)
  table('VIDEO CODECS', s.videoCodecs)
  table('AUDIO CODECS', s.audioCodecs)
  table('RESOLUTIONS', s.resolutions)
  table('COMBINATIONS (container / video / audio) - THIS is the one that decides', s.combos)

  out.push('')
  out.push('This is a description, not a verdict. Which of these a phone can actually')
  out.push('open is what the first client build finds out, and it is why v1 ships')
  out.push('direct play only rather than a transcode pipeline built against a guess.')
  out.push('')

  return out.join('\n')
}

async function codecReport (adapter, opts = {}) {
  const leaves = await collect(adapter, opts)
  const summary = summarize(leaves)
  return { summary, text: render(summary) }
}

module.exports = { codecReport, collect, summarize, render, bucket }
