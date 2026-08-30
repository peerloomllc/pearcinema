// Reading files off a disk.
//
// The first half of the folder adapter. A server source hands us container and
// codec facts for free; a folder has no index, no database and nobody who has
// already looked, so the only way to know what is in a file is to open it.
//
// The walk is what these mostly pin, because the walk is where a scan quietly goes
// wrong: it double-counts a Synology thumbnail mirror, or it files a trailer as a
// feature, and the resulting format distribution describes something that is not
// the library. ffprobe itself is exercised against real files by the scan runs, not
// here.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')

const { walkVideos, probeFile, probeAll, VIDEO_EXT } = require('../host/probe')

async function tree (t, spec) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-walk-'))
  for (const [rel, body] of Object.entries(spec)) {
    const full = path.join(root, rel)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, body || '')
  }
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

async function found (root, opts) {
  const out = []
  for await (const f of walkVideos(root, opts)) out.push(path.relative(root, f))
  return out.sort()
}

test('finds video files at any depth and ignores everything else', async (t) => {
  const root = await tree(t, {
    'Movies/Metropolis (1927)/Metropolis.mkv': '',
    'Movies/Metropolis (1927)/poster.jpg': '',
    'Movies/Metropolis (1927)/Metropolis.nfo': '',
    'Movies/Metropolis (1927)/Metropolis.en.srt': '',
    'TV/The Wire/Season 01/The Wire - S01E01.mp4': '',
    'notes.txt': ''
  })

  assert.deepEqual(await found(root), [
    'Movies/Metropolis (1927)/Metropolis.mkv',
    'TV/The Wire/Season 01/The Wire - S01E01.mp4'
  ])
})

test('SKIPS @eaDir, which MIRRORS THE TREE and would double every count', async (t) => {
  // Synology's thumbnail store shadows the library. A walk that descends into it
  // reports every film twice, and the format distribution is unaffected - so it
  // looks completely plausible while describing a library that does not exist.
  const root = await tree(t, {
    'Movies/Alien.mkv': '',
    'Movies/@eaDir/Alien.mkv/SYNOPHOTO_THUMB_L.mkv': '',
    '#recycle/Deleted.mp4': '',
    'lost+found/orphan.mp4': '',
    '$RECYCLE.BIN/gone.avi': ''
  })
  assert.deepEqual(await found(root), ['Movies/Alien.mkv'])
})

test('extras and samples are not features, and counting them skews the answer', async (t) => {
  // A trailer is H.264/AAC almost regardless of what the film beside it is, so
  // counting extras drags the distribution toward "everything direct-plays".
  const root = await tree(t, {
    'Movies/Dune/Dune.mkv': '',
    'Movies/Dune/Extras/Behind the Scenes.mp4': '',
    'Movies/Dune/Featurettes/Making Of.mp4': '',
    'Movies/Dune/Trailers/teaser.mp4': '',
    'Movies/Dune/Dune-sample.mkv': '',
    'Movies/Dune/sample.mp4': ''
  })

  assert.deepEqual(await found(root), ['Movies/Dune/Dune.mkv'])

  // They are findable when actually wanted.
  const all = await found(root, { includeExtras: true })
  assert.equal(all.length, 6)
})

test('a TV "Specials" folder is NOT an extras folder', async (t) => {
  // Season 0 is content. An earlier cut of the skip list would have eaten it, which
  // is the same class of mistake as a falsy check on season number.
  const root = await tree(t, {
    'TV/The Wire/Specials/The Wire - S00E01.mp4': '',
    'TV/The Wire/Season 01/The Wire - S01E01.mp4': ''
  })
  assert.deepEqual(await found(root), [
    'TV/The Wire/Season 01/The Wire - S01E01.mp4',
    'TV/The Wire/Specials/The Wire - S00E01.mp4'
  ])
})

test('hidden files and dotfiles are skipped', async (t) => {
  const root = await tree(t, {
    'Movies/Alien.mkv': '',
    'Movies/._Alien.mkv': '',
    '.hidden/thing.mp4': ''
  })
  assert.deepEqual(await found(root), ['Movies/Alien.mkv'])
})

test('an unreadable directory does not abandon the scan', async (t) => {
  const root = await tree(t, {
    'Good/Alien.mkv': '',
    'Locked/Hidden.mkv': ''
  })
  const locked = path.join(root, 'Locked')
  await fsp.chmod(locked, 0o000)

  // The readable half still comes back. A 4 TB drive with one bad directory on it
  // must still produce a report.
  const out = await found(root)
  assert.ok(out.includes('Good/Alien.mkv'))
  assert.ok(!out.some(f => f.startsWith('Locked/')))

  // Restored INLINE, not in a t.after hook. node:test runs after-hooks in
  // registration order, so tree()'s rm - registered first - would run before a
  // restore registered here and fail on the unreadable directory.
  await fsp.chmod(locked, 0o755)
})

test('the extension list covers what a real library actually holds', () => {
  // Measured against Tim's drive, 2026-08-12: 9433 mp4, 2482 mkv, 218 avi, 64 m4v.
  for (const ext of ['.mp4', '.mkv', '.avi', '.m4v', '.mov', '.m2ts', '.ts', '.webm']) {
    assert.ok(VIDEO_EXT.has(ext), `${ext} must be scanned`)
  }
  // And not the things sitting beside them.
  for (const ext of ['.srt', '.nfo', '.jpg', '.pdf', '.rar', '.flac']) {
    assert.ok(!VIDEO_EXT.has(ext), `${ext} must not be probed`)
  }
})

// --- probing ----------------------------------------------------------------

test('a file ffprobe cannot read is COUNTED, not swallowed', async (t) => {
  // On a real drive this is not rare - a truncated download, a half-copied file, a
  // rip that failed. "How much of this library is broken" is worth knowing.
  const root = await tree(t, { 'broken.mkv': 'this is not a video' })
  const file = path.join(root, 'broken.mkv')

  assert.equal(await probeFile(file), null)

  const { results, failed } = await probeAll([file])
  assert.deepEqual(results, [])
  assert.deepEqual(failed, [file])
})

test('probeAll runs a bounded number at once and reports progress for all of them', async (t) => {
  const root = await tree(t, Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`f${i}.mkv`, 'junk'])
  ))
  const files = Array.from({ length: 9 }, (_, i) => path.join(root, `f${i}.mkv`))

  const seen = []
  const { failed } = await probeAll(files, { concurrency: 3, onProgress: (n, total) => seen.push([n, total]) })

  assert.equal(failed.length, 9)
  assert.equal(seen.length, 9, 'progress fires once per file')
  assert.deepEqual(seen[8], [9, 9])
})

test('a missing ffprobe fails the file rather than the run', async (t) => {
  const root = await tree(t, { 'a.mkv': '' })
  const file = path.join(root, 'a.mkv')
  assert.equal(await probeFile(file, { ffprobe: 'definitely-not-a-real-binary' }), null)
})

test('CREDITLESS OPENINGS, ENDINGS AND DISC MENUS ARE EXTRAS, even when they are files', () => {
  // The extras rule was folder-based; anime releases put these beside the episodes, so
  // 41 of one user's files were indexed as episodes with no number - which is how a disc
  // menu reaches somebody's Continue Watching (field report 2026-08-30).
  const { EXTRA_FILE_RE } = require('../host/probe')
  for (const f of ['[DBD-Raws][Show][NCED1][1080P][BDRip].mkv', '[DBD-Raws][Show][menu][1080P].mkv', 'S01OP-Daten [Creepy Nuts].mkv', 'Show NCOP.mkv', 'Creditless Opening.mkv']) {
    assert.ok(EXTRA_FILE_RE.test(f), f + ' is an extra')
  }
  // AND THE TITLES THESE WORDS ALSO BELONG TO. `The Menu` is a film; `menu` counts only
  // inside brackets, which is the fansub convention and not something a title does.
  for (const f of ['The Menu (2022).mkv', 'Menu Rouge (1998).mkv', 'The Preview Man (2011).mkv', 'Show - Operation Overlord.mkv', 'Show S01E01.mkv']) {
    assert.ok(!EXTRA_FILE_RE.test(f), f + ' is not an extra')
  }
})
