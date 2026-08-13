// Find the film library that is already on this box.
//
// The single hardest thing about setting a media server up is knowing the address of
// the one you are already running. PearTune solved this for music (`host/detect.js`
// there) and the approach carries over whole: probe the addresses a co-located
// server answers on, read a PUBLIC no-auth endpoint, and match a marker specific
// enough that some unrelated service on the same port will not be mistaken for it.
//
// TWO THINGS ARE DIFFERENT HERE, and both matter more than the port numbers.
//
// FIRST, THE FOLDERS COUNT AS A FIND. For music the answer is nearly always another
// server; for video the answer is very often a drive. The measured real library on
// this project is 2,986 films and episodes on a USB disk with no server in front of
// it at all, so a detector that only looked for servers would miss the actual
// library and send somebody to the folder picker to find their own drive by hand.
//
// SECOND, PLEX IS FOUND AND CANNOT BE USED. It is the most likely thing to be
// running next to this, so saying nothing about it would look like a bug - somebody
// would reasonably assume PearCinema had failed to notice. It is reported with
// `usable: false` and a plain reason, which is the same rule the subtitle list
// follows: list what you cannot serve rather than hiding it.

const http = require('http')
const fsp = require('fs/promises')
const path = require('path')

function fetchText (url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve(null) }
    if (u.protocol !== 'http:') return resolve(null) // internal service links are http
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c; if (d.length > 20000) req.destroy() })
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// Each as { pkg (the Start9 package id, which is also the Umbrel app name), port,
// probe }. Emby rides the jellyfin kind: the APIs are the same and only the auth
// header naming drifted, which the adapter already handles.
const SERVERS = [
  { pkg: 'jellyfin', port: 8096, probe: 'jellyfin' },
  { pkg: 'emby', port: 8096, probe: 'jellyfin' },
  { pkg: 'plex', port: 32400, probe: 'plex' }
]

// Both address forms, deduped later by whichever actually answered. No platform flag
// needed: `.embassy` names do not resolve off StartOS and localhost ports refuse, so
// the wrong ones fail fast.
function urlsFor (s) {
  return [`http://${s.pkg}.embassy:${s.port}`, `http://localhost:${s.port}`]
}

async function probe (kind, base) {
  if (kind === 'jellyfin') {
    const r = await fetchText(base + '/System/Info/Public')
    if (r && r.status === 200 && /"ProductName"\s*:\s*"(Jellyfin|Emby)/i.test(r.body)) {
      const m = r.body.match(/"ServerName"\s*:\s*"([^"]+)"/i)
      const prod = /Emby/i.test(r.body) && !/Jellyfin/i.test(r.body) ? 'Emby' : 'Jellyfin'
      return {
        kind: 'jellyfin',
        url: base,
        name: (m && m[1]) ? m[1] : prod,
        server: prod,
        usable: true,
        // The one thing the operator still has to supply. Said here so the dashboard
        // does not have to know which sources need credentials.
        needs: 'a username and password'
      }
    }
  } else if (kind === 'plex') {
    // `/identity` is Plex's public, unauthenticated endpoint - it answers with the
    // machine identifier and version and nothing private.
    const r = await fetchText(base + '/identity')
    if (r && r.status === 200 && /machineIdentifier/i.test(r.body)) {
      // NOT `version="..."` on its own - the first match in that document is the XML
      // declaration, so a real Plex 1.41 was being announced as "Plex Media Server
      // 1.0". A wrong version number is worse than none: it looks like a detection
      // that half worked. The name alone is enough to recognise it by.
      return {
        kind: 'plex',
        url: base,
        name: 'Plex Media Server',
        server: 'Plex',
        // FOUND, NOT USABLE, and the difference is said out loud rather than left to
        // be discovered. Plex's API is nothing like Jellyfin's and needs its own
        // adapter plus a token from plex.tv, so this is a real piece of work rather
        // than a missing config field.
        usable: false,
        reason: 'PearCinema cannot read a Plex library yet - Plex has its own API and needs its own reader. Point PearCinema at the FOLDERS your films are in instead; it reads them directly and does not need Plex at all.'
      }
    }
  }
  return null
}

// --- folders ------------------------------------------------------------------
//
// Where a film library actually lives on the boxes this ships to. Ordered by how
// likely they are to be the real thing rather than alphabetically, because the first
// suggestion is the one most people will take.
const FOLDER_ROOTS = [
  '/external', // Umbrel's external drives - where a 3 TB film library really lives
  '/library', // our own mount of the Umbrel's Downloads
  '/media', '/mnt', // a bare Linux box
  '/Volumes' // a Mac
]

// The names that mean "films" and "television" across the scanners people already
// use. Deliberately narrow: a folder called `Video` holding somebody's phone
// recordings is not a film library, and suggesting it would poison the first scan.
// Mount points and staging directories, which name nothing about the library. A
// container sees the drive at /library and the host sees it at /external/<label>, so
// the same collection would be called two different unhelpful things.
const GENERIC_PARENTS = /^(library|external|media|mnt|volumes|data|storage|video|videos)$/i

const FILM_NAMES = /^(movies|films|cinema|movie)$/i
const SHOW_NAMES = /^(tv ?shows?|series|television|shows)$/i

// NAME IT SOMETHING THE OWNER RECOGNISES.
//
// The obvious answer - the folder holding Movies and TV Shows - is often meaningless:
// the real drive is `Elements (3)/Video/Movies`, so that answer is "Video", and inside
// the container the same drive is mounted at /library so it is "library". Neither
// tells anybody which of their disks this is.
//
// So walk up past the generic names until something has a name of its own, and if
// nothing does, describe the contents instead. On the real drive this gives
// "Elements (3)", which is exactly what is written on the thing on the desk.
function labelFor (at, roots) {
  let cur = at
  for (let i = 0; i < 3; i++) {
    const name = path.basename(cur)
    if (!name || name === path.sep) break
    if (!GENERIC_PARENTS.test(name)) return name
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  return roots.join(' and ')
}

async function dirs (at) {
  try {
    const entries = await fsp.readdir(at, { withFileTypes: true })
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name)
  } catch {
    return []
  }
}

// Walk a bounded depth looking for a Movies/TV Shows pair. Bounded because this runs
// while somebody waits: three levels covers `/external/<drive>/Video/Movies`, which
// is exactly the real case, and stops well short of walking a 3 TB disk.
async function findLibraryFolders (roots = FOLDER_ROOTS, maxDepth = 3) {
  const found = []
  const seen = new Set()

  const visit = async (at, depth) => {
    if (depth > maxDepth || found.length >= 12) return
    const names = await dirs(at)

    const films = names.filter(n => FILM_NAMES.test(n))
    const shows = names.filter(n => SHOW_NAMES.test(n))

    if (films.length || shows.length) {
      const roots = [...films, ...shows]
      const group = {
        at,
        label: labelFor(at, roots),
        roots: roots.map(n => path.join(at, n))
      }
      const key = group.roots.join('|')
      if (!seen.has(key)) { seen.add(key); found.push(group) }
      return // do not descend past a hit; the folders below are the library itself
    }

    for (const n of names) await visit(path.join(at, n), depth + 1)
  }

  for (const root of roots) await visit(root, 0)
  return found
}

// Everything worth offering, servers and folders together. One call, because the
// dashboard asks one question: "where are the films?"
async function detectSources ({ roots = FOLDER_ROOTS } = {}) {
  const jobs = []
  for (const s of SERVERS) for (const base of urlsFor(s)) jobs.push(probe(s.probe, base))

  const [servers, folders] = await Promise.all([
    Promise.all(jobs).then(r => r.filter(Boolean)),
    findLibraryFolders(roots)
  ])

  // Prefer the first hit per (kind + name); the same Jellyfin answers on both the
  // .embassy and the localhost address.
  const seen = new Set()
  const out = []
  for (const f of servers) {
    const key = f.kind + '|' + f.name
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }

  return { servers: out, folders }
}

module.exports = { detectSources, probe, findLibraryFolders, SERVERS, FOLDER_ROOTS }
