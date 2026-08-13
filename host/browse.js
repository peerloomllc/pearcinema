// Let the operator PICK a folder instead of typing one.
//
// THE BUG THIS EXISTS FOR, inherited from PearTune and worth restating because it
// cost an evening there and would cost another here. The folder path is a path
// INSIDE THE CONTAINER, and nothing said so. Tim typed the path his Jellyfin uses -
// the one he can see on the Umbrel - and got zero files. Correctly: that path does
// not exist in the container. Only what is MOUNTED exists. But "0 films" is
// indistinguishable from an empty library, so it reads as "this app is broken"
// rather than "that path is wrong".
//
// A free-text box the host cannot verify is the problem. So: the dashboard shows the
// folders the container CAN see, the operator clicks one and the box is filled in
// from something that provably exists.
//
// It is WORSE for video than for music, which is why this is not a straight copy.
// A film library is normally on an external drive, so the right answer is under
// /external or /library rather than anywhere obvious, and the probe below has to
// look deeper: `Movies/Blade Runner (1982)/Blade Runner.mkv` is three levels down
// where an album is one.
//
// This is a listing of the CONTAINER's filesystem, behind the dashboard password.
// It lists directory NAMES only - never files, never contents. The operator owns
// this box; they are allowed to see where their disks are mounted.

const fsp = require('fs/promises')
const path = require('path')

const { VIDEO_EXT, SKIP_DIRS } = require('./probe')

// Bounded, because a browse click must never turn into a walk of a 3 TB disk. Both
// caps are per DIRECTORY we report on, and hitting either just means we stop looking
// - "is there video in there" is a yes/no question and we can answer it early.
const PROBE_MAX_ENTRIES = 4000
const PROBE_MAX_DEPTH = 4

// The directories at / that are the OS rather than somebody's media. Hiding them is
// not a security control (the operator may still type any path); it is so a first
// run does not open onto forty kernel directories with the two that matter buried
// among them.
const SYSTEM_DIRS = new Set([
  'bin', 'boot', 'dev', 'etc', 'lib', 'lib32', 'lib64', 'libx32', 'proc', 'root',
  'run', 'sbin', 'sys', 'tmp', 'usr', 'var', 'opt', 'srv', 'app', 'node_modules'
])

const isVideo = (name) => VIDEO_EXT.has(path.extname(name).toLowerCase())

// What the container can actually see at its root. Named so a first-time operator,
// staring at a filesystem they did not expect, has something to click - and so a
// failed scan can say "I can see: /library, /external" instead of only "no".
async function visibleMounts () {
  try {
    const entries = await fsp.readdir('/', { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SYSTEM_DIRS.has(e.name))
      .map(e => '/' + e.name)
      .sort()
  } catch {
    return []
  }
}

// Does this directory contain video, anywhere under it? Stops at the FIRST hit.
async function hasVideo (dir, budget = { entries: PROBE_MAX_ENTRIES }, depth = 0) {
  if (depth > PROBE_MAX_DEPTH || budget.entries <= 0) return false

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }

  const subdirs = []
  for (const e of entries) {
    if (budget.entries-- <= 0) return false
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    if (e.isFile() && isVideo(e.name)) return true // early exit: that is the question
    if (e.isDirectory()) subdirs.push(path.join(dir, e.name))
  }

  for (const sub of subdirs) {
    if (await hasVideo(sub, budget, depth + 1)) return true
  }
  return false
}

// One level of the tree, with a "has video" flag on each child so the operator can
// see which branch is theirs without opening every one.
async function browse (target = '/') {
  const dir = path.resolve(target || '/')

  let st
  try {
    st = await fsp.stat(dir)
  } catch {
    const visible = await visibleMounts()
    const e = new Error(
      `${dir} does not exist inside the PearCinema container. Only folders MOUNTED into the container are visible` +
      (visible.length ? `. I can see: ${visible.join(', ')}` : '') + '.'
    )
    e.code = 'ENOENT'
    throw e
  }
  if (!st.isDirectory()) throw new Error(`${dir} is a file, not a folder.`)

  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error(`${dir} cannot be read inside the PearCinema container.`)
  }

  const kids = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))

  const dirs = []
  for (const name of kids) {
    const full = path.join(dir, name)
    dirs.push({ name, path: full, video: await hasVideo(full) })
  }

  return {
    path: dir,
    parent: dir === '/' ? null : path.dirname(dir),
    // Video sitting directly in this directory, which is what makes "Use this
    // folder" meaningful when the operator is already standing in the season.
    here: entries.filter(e => e.isFile() && isVideo(e.name)).length,
    dirs,
    mounts: dir === '/' ? await visibleMounts() : []
  }
}

module.exports = { browse, hasVideo, visibleMounts, SYSTEM_DIRS }
