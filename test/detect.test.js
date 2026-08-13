// Finding the library that is already on the box.
//
// The hardest part of setting a media server up is knowing the address of the one
// you already run. PearTune solved that for music and the approach carries over -
// but two of the rules here are PearCinema's own and are the ones worth pinning.
//
// A FOLDER COUNTS AS A FIND. For music the answer is nearly always another server;
// for video it is very often a drive. The measured real library on this project is
// 2,986 films and episodes on a USB disk with no server in front of it, so a
// detector that only looked for servers would miss the actual library.
//
// PLEX IS FOUND AND REFUSED, out loud. It is the likeliest thing to be running next
// to this, so saying nothing would look like PearCinema had failed to notice it.

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const os = require('os')
const path = require('path')
const fsp = require('fs/promises')

const { probe, findLibraryFolders, SERVERS } = require('../host/detect')

// A stand-in server that answers one route the way the real thing does.
async function serve (t, routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url.split('?')[0]]
    if (body === undefined) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise(r => server.close(r)))
  return `http://127.0.0.1:${server.address().port}`
}

/* --------------------------------------------------------------- the servers -- */

test('a Jellyfin is recognised and its NAME is read, so the offer is specific', async (t) => {
  const base = await serve(t, {
    '/System/Info/Public': JSON.stringify({ ServerName: 'The Cinema', ProductName: 'Jellyfin Server', Version: '10.11.11' })
  })

  const hit = await probe('jellyfin', base)
  assert.equal(hit.kind, 'jellyfin')
  assert.equal(hit.url, base)
  assert.equal(hit.name, 'The Cinema', 'the server name, not the product - somebody may run two')
  assert.equal(hit.usable, true)
  assert.match(hit.needs, /username and password/)
})

test('an Emby is recognised as Emby and still handed to the Jellyfin reader', async (t) => {
  // The APIs are the same and only the auth header naming drifted, which the adapter
  // already handles - so this is one kind with two names rather than two adapters.
  const base = await serve(t, {
    '/System/Info/Public': JSON.stringify({ ServerName: 'Front room', ProductName: 'Emby Server' })
  })

  const hit = await probe('jellyfin', base)
  assert.equal(hit.kind, 'jellyfin')
  assert.equal(hit.server, 'Emby')
})

test('PLEX IS FOUND AND REFUSED, with the reason and the thing to do instead', async (t) => {
  const base = await serve(t, {
    '/identity': '<MediaContainer size="0" machineIdentifier="abc123" version="1.41.0.8992"/>'
  })

  const hit = await probe('plex', base)
  assert.equal(hit.kind, 'plex')
  assert.equal(hit.usable, false, 'PearCinema cannot read a Plex library')
  assert.match(hit.reason, /its own API/)
  // The useful half: what to do about it. Plex's films are on a disk, and this reads
  // disks - so the answer is not "wait for a Plex adapter".
  assert.match(hit.reason, /FOLDERS/)
})

test('something unrelated on the same port is not mistaken for a media server', async (t) => {
  // A false positive here pre-fills a wrong address and sends somebody debugging
  // credentials against a machine that was never a media server.
  const base = await serve(t, {
    '/System/Info/Public': JSON.stringify({ hello: 'not a media server' }),
    '/identity': 'nothing to see'
  })

  assert.equal(await probe('jellyfin', base), null)
  assert.equal(await probe('plex', base), null)
})

test('a port with nothing on it answers null rather than hanging', async () => {
  // The wrong addresses are the common case - `.embassy` names do not resolve off
  // StartOS and most localhost ports refuse - so failing fast IS the feature.
  const t0 = Date.now()
  assert.equal(await probe('jellyfin', 'http://127.0.0.1:1'), null)
  assert.ok(Date.now() - t0 < 3000)
})

test('the servers it looks for are the ones that hold video', async () => {
  const ports = SERVERS.map(s => `${s.pkg}:${s.port}`)
  assert.deepEqual(ports, ['jellyfin:8096', 'emby:8096', 'plex:32400'])
})

/* --------------------------------------------------------------- the folders -- */

async function tree (t, layout) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-detect-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  for (const rel of layout) await fsp.mkdir(path.join(root, rel), { recursive: true })
  return root
}

test('A DRIVE WITH MOVIES AND TV SHOWS ON IT IS A FIND', async (t) => {
  // Tim's real drive, in shape: /external/Elements (3)/Video/{Movies,TV Shows}. Three
  // levels down, which is why the walk goes that deep and no deeper.
  const root = await tree(t, [
    'Elements (3)/Video/Movies',
    'Elements (3)/Video/TV Shows',
    'Elements (3)/Video/Home Videos',
    'Elements (3)/Documents',
    'Seagate/Backups'
  ])

  const found = await findLibraryFolders([root])
  assert.equal(found.length, 1)
  // NAMED BY THE DRIVE, not by the folder immediately above them. "Video" is what
  // holds them and it means nothing; "Elements (3)" is what is written on the thing
  // on the desk. The walk skips generic names until it finds one of its own.
  assert.equal(found[0].label, 'Elements (3)')
  assert.deepEqual(
    found[0].roots.map(r => path.basename(r)).sort(),
    ['Movies', 'TV Shows']
  )
  // Home Videos is NOT offered. On the real drive it is 9,211 phone recordings that
  // drown the actual library three to one, and it is not a film collection.
  assert.ok(!found[0].roots.some(r => /Home Videos/.test(r)))
})

test('it takes a films folder on its own, because plenty of people have only that', async (t) => {
  const root = await tree(t, ['media/Films', 'media/Photos'])
  const found = await findLibraryFolders([root])
  assert.equal(found.length, 1)
  assert.deepEqual(found[0].roots.map(r => path.basename(r)), ['Films'])
})

test('a folder merely called Video is NOT offered', async (t) => {
  // Deliberately narrow. A `Video` folder holding somebody's phone recordings is not
  // a film library, and offering it would poison the very first scan they ever run.
  const root = await tree(t, ['drive/Video', 'drive/Music', 'drive/Stuff'])
  assert.deepEqual(await findLibraryFolders([root]), [])
})

test('it stops AT the library rather than walking into it', async (t) => {
  // A 3 TB disk is not something to walk while somebody waits on a page.
  const root = await tree(t, [
    'Video/Movies/Blade Runner (1982)/Extras',
    'Video/TV Shows/The Wire/Season 01'
  ])
  const found = await findLibraryFolders([root])
  assert.equal(found.length, 1)
  assert.equal(found[0].roots.length, 2, 'the two roots, not every folder underneath them')
})

test('a root that does not exist is silence, not an error', async () => {
  // Most of the roots it looks in are absent on any given box - /Volumes on Linux,
  // /external on a Mac - and that is the normal case rather than a fault.
  assert.deepEqual(await findLibraryFolders(['/definitely-not-here']), [])
})

test('a mount point is not a name, so it is labelled by what is in it', async (t) => {
  // Inside the container the real drive is mounted at /library, so the honest label
  // was "library" - which tells somebody nothing about their own collection. The
  // same folder is /external/Elements (3)/Video on the host, so the parent name is
  // not even stable between the two views.
  const root = await tree(t, ['library/Movies', 'library/TV Shows'])
  // The temp dir above it has a random name, which IS a name of its own - so point
  // the walk at a tree where everything above is generic.
  const found = await findLibraryFolders([path.join(root, 'library')], 1)
  assert.equal(found.length, 1)
  assert.ok(found[0].label === 'Movies and TV Shows' || found[0].label.startsWith('pearcinema-detect-'),
    'either the contents, or the first non-generic name above them: never "library"')
  assert.notEqual(found[0].label, 'library')
})

test('a real drive name IS used, because it is the thing somebody recognises', async (t) => {
  const root = await tree(t, ['Elements (3)/Movies', 'Elements (3)/TV Shows'])
  const found = await findLibraryFolders([root])
  assert.equal(found[0].label, 'Elements (3)')
})

test('a wrong version number is worse than none', async (t) => {
  // `version="..."` matched the XML DECLARATION first, so a real Plex 1.41 announced
  // itself as "Plex Media Server 1.0" - a detection that looks half broken.
  const base = await serve(t, {
    '/identity': '<?xml version="1.0" encoding="UTF-8"?><MediaContainer machineIdentifier="abc" version="1.41.0.8992"/>'
  })
  const hit = await probe('plex', base)
  assert.equal(hit.name, 'Plex Media Server')
})
