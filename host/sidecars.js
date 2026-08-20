// Writing fetched metadata INTO the library, as the standard sidecar files
// every other scanner reads - the separate, explicit action the TMDB module
// promised (host/tmdb.js: "sidecar-writing would be a separate, explicit
// action and is deliberately not built here". This is it, built).
//
// Why it exists at all: everything the enricher fetched lives in the DATA dir,
// which is disposable by design. Deleting it costs a re-fetch - unless TMDB is
// gone, or the key is, or the operator moves the drive to another machine.
// Writing the answers beside the films makes them permanent and portable, in
// the same dialect Kodi, Jellyfin and this host's own scanner already read, so
// the fetch happens once per library rather than once per install.
//
// THE RULES, and each is load-bearing:
//
//   - CREATE ONLY. Every write uses an exclusive flag; a file that exists is
//     skipped, never replaced. Sidecar-always-wins means what is on disk was
//     somebody's answer, and this action must never beat it.
//   - UNCERTAIN GUESSES STAY OUT OF THE LIBRARY. A match the enricher was not
//     sure of shows as a poster the operator can fix in one click - but written
//     to disk it becomes the permanent answer every future scan trusts. Only
//     sure and operator-fixed matches are written; the report says how many
//     were held back and where to confirm them.
//   - ONLY WHAT THE SCANNER ITSELF RE-READS. The .nfo carries the fields our
//     reader parses, the artwork lands under the exact names _pickArt and
//     _pickSeasonArt look for - so a rescan replaces the fetched decoration
//     with the same pictures read off disk, and nothing visibly changes.
//   - A READ-ONLY LIBRARY IS SAID PLAINLY. Docker mounts were `:ro` until this
//     feature shipped, and older installs still are. Every write failing with
//     EROFS or EACCES is one sentence to the operator, not a stack of errors.

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

// Text-node escaping, the whole XML discipline this dialect needs. Titles are
// the only field that can carry these characters and they carry all five in
// the wild ("Fast & Furious", 'the film called "M"').
function esc (s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// A minimal Kodi-dialect .nfo. `<tmdbid>` is what our own reader parses
// (host/nfo.js strips <uniqueid> blocks as nested); <uniqueid> is what Kodi
// and Jellyfin prefer today. Both are written so every reader finds its own.
function nfoXml (root, { title, year, tmdbId, overview }) {
  const lines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', `<${root}>`]
  if (title) lines.push(`  <title>${esc(title)}</title>`)
  if (year) lines.push(`  <year>${Number(year)}</year>`)
  // <plot> is what our own reader takes as the summary (host/nfo.js) and what Kodi,
  // Jellyfin and Plex all read. A copy saved into the library that carried the
  // poster and not the words would be half the answer.
  if (overview) lines.push(`  <plot>${esc(overview)}</plot>`)
  if (tmdbId) {
    lines.push(`  <tmdbid>${Number(tmdbId)}</tmdbid>`)
    lines.push(`  <uniqueid type="tmdb" default="true">${Number(tmdbId)}</uniqueid>`)
  }
  lines.push(`</${root}>`, '')
  return lines.join('\n')
}

// The Kodi season-poster name, the same one _pickSeasonArt looks for in the
// show folder: season01-poster.jpg, season-specials-poster.jpg for season 0.
function seasonPosterName (number) {
  return number === 0 ? 'season-specials-poster.jpg' : `season${String(number).padStart(2, '0')}-poster.jpg`
}

const DENIED = new Set(['EROFS', 'EACCES', 'EPERM'])

// One pass over everything the enricher holds, writing what the disk lacks.
//
// `adapter` must be the INNER folder adapter - it is the only one with
// `locate`, and "already has artwork" must mean artwork on disk rather than
// artwork the enricher itself supplied.
async function write ({ adapter, enricher, log = () => {} } = {}) {
  if (typeof adapter?.locate !== 'function') {
    return { supported: false, reason: 'sidecars can only be written into a folder library' }
  }

  const out = {
    supported: true,
    wrote: 0,
    nfos: 0,
    posters: 0,
    skippedExisting: 0,
    skippedUncertain: 0,
    skippedUnplaced: 0,
    failed: 0,
    denied: 0,
    readOnly: false,
    errors: []
  }

  const fail = (file, e) => {
    out.failed++
    if (DENIED.has(e.code)) out.denied++
    // A handful of examples, not a stack: ten identical EROFS lines say less
    // than one, and a 240-film library could produce hundreds.
    if (out.errors.length < 5) out.errors.push({ file: path.basename(file), error: e.code || e.message })
  }

  const exists = async (file) => {
    try {
      await fsp.access(file)
      return true
    } catch {
      return false
    }
  }

  // wx: create or refuse. The refusal IS the skip - what exists was somebody's
  // answer and this action never replaces anything.
  const putNfo = async (target, xml) => {
    try {
      await fsp.writeFile(target, xml, { flag: 'wx' })
      out.wrote++
      out.nfos++
    } catch (e) {
      if (e.code === 'EEXIST') out.skippedExisting++
      else fail(target, e)
    }
  }

  const putPoster = async (itemId, target) => {
    const src = enricher.posterPath(itemId)
    if (!src) return
    try {
      await fsp.copyFile(src, target, fs.constants.COPYFILE_EXCL)
      out.wrote++
      out.posters++
    } catch (e) {
      if (e.code === 'EEXIST') out.skippedExisting++
      else fail(target, e)
    }
  }

  // --- films and shows: an .nfo and a poster each ---------------------------
  for (const [itemId, m] of Object.entries(enricher.matched)) {
    if (m.uncertain) {
      out.skippedUncertain++
      continue
    }

    const loc = adapter.locate(itemId)
    // The item is gone (the drive changed since the fetch) or has no folder of
    // its own to receive files - a loose episode sitting directly in a root.
    if (!loc) {
      out.skippedUnplaced++
      continue
    }

    const item = await adapter.get({ id: itemId })

    if (loc.type === 'movie') {
      const dir = path.dirname(loc.file)
      const stem = path.basename(loc.file).replace(/\.[^.]+$/, '')
      // The reader tries `${stem}.nfo` then `movie.nfo` - if EITHER exists the
      // film already has an answer, and writing the higher-priority name would
      // silently outrank it.
      if (!(await exists(path.join(dir, `${stem}.nfo`))) && !(await exists(path.join(dir, 'movie.nfo')))) {
        await putNfo(path.join(dir, `${stem}.nfo`), nfoXml('movie', m))
      } else {
        out.skippedExisting++
      }
      // `artId` on the INNER item means artwork on disk. The enricher only
      // fetched where there was none, but the disk may have gained one since.
      if (!item?.artId) await putPoster(itemId, path.join(dir, `${stem}-poster.jpg`))
    }

    if (loc.type === 'series') {
      if (!(await exists(path.join(loc.dir, 'tvshow.nfo')))) {
        await putNfo(path.join(loc.dir, 'tvshow.nfo'), nfoXml('tvshow', m))
      } else {
        out.skippedExisting++
      }
      if (!item?.artId) await putPoster(itemId, path.join(loc.dir, 'poster.jpg'))
    }
  }

  // --- season posters and episode stills, riding on the show matches --------
  for (const itemId of Object.keys(enricher.art)) {
    const loc = adapter.locate(itemId)
    if (!loc) {
      out.skippedUnplaced++
      continue
    }
    const item = await adapter.get({ id: itemId })
    if (item?.artId) continue

    if (loc.type === 'season') {
      // The Kodi name in the SHOW folder, which is where _pickSeasonArt looks
      // first after the season folder itself. A season with no number has no
      // addressable name - the enricher never fetched art for one anyway.
      if (loc.number === null || loc.number === undefined) {
        out.skippedUnplaced++
        continue
      }
      await putPoster(itemId, path.join(loc.seriesDir, seasonPosterName(loc.number)))
    }

    if (loc.type === 'episode') {
      const dir = path.dirname(loc.file)
      const stem = path.basename(loc.file).replace(/\.[^.]+$/, '')
      await putPoster(itemId, path.join(dir, `${stem}-thumb.jpg`))
    }
  }

  // Every failure a permission failure and nothing written: the library is
  // mounted read-only. One plain sentence beats a page of EROFS.
  out.readOnly = out.wrote === 0 && out.failed > 0 && out.denied === out.failed

  log('sidecars:written', {
    wrote: out.wrote,
    nfos: out.nfos,
    posters: out.posters,
    skippedExisting: out.skippedExisting,
    skippedUncertain: out.skippedUncertain,
    failed: out.failed,
    readOnly: out.readOnly
  })
  return out
}

module.exports = { write, nfoXml, seasonPosterName, esc }
