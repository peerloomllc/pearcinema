// THE WORKLET'S WIRING, pinned at the source.
//
// `src/bare.js` is a top-level script with side effects and `Bare` globals: it cannot
// be required outside the Bare runtime, so nothing in it can be called from a test.
// Every rule worth testing therefore lives beside it - `merge.js`, `capabilities.js`,
// `relay.js` - and what is left here is the WIRING: which rule is called where.
//
// That is exactly where two of this repo's bugs have been. The library chip was never
// wrong, it was three lists that were never given it; the person's name was never
// wrong, it was sent to one library out of five. Both read as logic bugs and were
// neither. So these assertions are deliberately about CALL SITES, and each one names
// the failure it would have caught.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'bare.js'), 'utf8')

// The body of one method on the worklet's table, from its key to the next one.
function method (name) {
  const at = src.indexOf(`'${name}':`)
  assert.ok(at > 0, `${name} is gone from the worklet's method table`)
  const rest = src.slice(at + name.length)
  const end = rest.search(/\n {2}'[a-z][a-zA-Z.]*':/)
  return rest.slice(0, end === -1 ? 2000 : end)
}

test('YOUR NAME REACHES EVERY LIBRARY, not just the active one', () => {
  // A friend paired with somebody else's library arrived as `label: "device"` with no
  // claimed name, so the owner could not tell who they had let in (2026-08-22).
  const body = method('identity.set')
  assert.match(body, /writeSettings\(/, 'the name is kept locally, or a later pairing has nothing to introduce')
  assert.match(body, /hostsState\.hosts\.map/, 'and it is offered to every paired library')
})

test('AND A LIBRARY PAIRED LATER IS TOLD TOO', () => {
  const body = method('pair')
  assert.match(body, /readSettings\(\)\.identity/, 'pairing reads the name this device already goes by')
  assert.match(body, /identity\.set/, 'and introduces itself with it')

  // WITH A FALLBACK, because otherwise this shipped and changed nothing: the name
  // lives on each HOST, so a phone that has never edited its own has nothing to
  // introduce, and every phone in the field is in that state. Caught by pairing a
  // guest on the TCL minutes after building it - the friend's library still filed it
  // as "device".
  assert.match(body, /borrowIdentity\(\)/, 'a phone with no name of its own asks a library that knows')
  assert.match(src, /async function borrowIdentity/, 'and the helper is real')
  assert.match(method('identity.get'), /writeSettings\(/, 'and identity.get caches it, so the ask happens once')
})

test('the Continue shelf is folded and scoped, rather than concatenated', () => {
  // One film half-watched on two libraries used to be two cards, and the chip was
  // ignored entirely.
  const body = method('resume.list')
  assert.match(body, /merge\.collapseResume\(rows, mergedIndex, libraryFilter\(\)\)/)
  assert.match(body, /libraryId: h\.libraryId/, 'rows carry the library that answered, or nothing can be folded')
})

test('A RE-PAIR CLEARS A REVOKE, or the phone refuses a library that just took it back', () => {
  // connectedLib throws for a revoked library BEFORE it dials, so nothing that happens on
  // a connection can ever clear the verdict - the dial does not happen. Pairing is the
  // way back in, so pairing is what has to clear it. Without this a phone that was once
  // revoked pairs again, is granted by the host, and still tells itself the library is
  // not shared with it (found on the Simulator against a real host, 2026-08-27).
  const pair = src.slice(src.indexOf("'pair': async"), src.indexOf("'hosts.setActive'"))
  assert.match(pair, /clearRevoked\(paired\.libraryId\)/,
    'pair must clear any revoke standing against the library it just joined')
  // The CALL, not the word: the comment above it names connectedLib too.
  assert.ok(
    pair.indexOf('clearRevoked(paired.libraryId)') < pair.indexOf('connectedLib(paired.libraryId)'),
    'and clear it BEFORE the identity introduction, which goes through connectedLib and would throw'
  )
})

test('THE REVOKE GATE SITS IN FRONT OF THE CACHE, not behind it', () => {
  // A cached film is served off disk with no host in the path, which is the point of a
  // cache and exactly wrong for a library that has said no. Both seams matter: the shim
  // route (what the player asks for) and stream.url (what the app asks for).
  const extra = src.slice(src.indexOf('extra: async (req, res)'), src.indexOf('itemMeta:'))
  assert.match(extra, /revoke\.blocked\(/, 'the shim must refuse a revoked library its bytes')

  const stream = src.slice(src.indexOf("'stream.url': async"), src.indexOf("'art.base'"))
  const gate = stream.indexOf('revokedLibs.has(owner)')
  const cacheHit = stream.indexOf('cache.has(String(itemId))')
  assert.ok(gate > 0, 'stream.url must refuse a revoked library')
  assert.ok(gate < cacheHit, 'and refuse it BEFORE answering from the cache')
})

test('A SILENT FILM IS RETRIED WITHOUT ITS SOUND CODEC, and the whole session describes the device that way', () => {
  // Field report 2026-08-29: an x265 MKV on Android, picture and no sound. ExoPlayer
  // raises no error for a soundtrack it cannot decode, so the shell's player:silent is
  // the signal and stream.url takes deviceRefusedAudio the way it took the video one.
  const body = method('stream.url')
  assert.match(body, /deviceRefusedAudio = false/, 'stream.url takes the audio refusal')
  assert.match(body, /refusedAudio\.set\(itemId, badAudio\)/, 'and remembers the codec per item')
  assert.match(body, /!deviceRefusedAudio && !burnSubtitleId && cache\.has/, 'a downloaded copy does not swallow the retry')
  assert.match(body, /wantsPlaylist\(verdict\?\.mode, PLATFORM, verdict\?\.audio\)/, 'the transport sees the audio verdict')
  const at = src.indexOf('function capsFor (itemId)')
  assert.ok(at > 0)
  const capsFor = src.slice(at, at + 900)
  assert.match(capsFor, /refusedAudio\.get\(itemId\)/, 'the playlist and segment calls describe the device the same way')
  assert.match(capsFor, /caps\.withoutAudio\(/)
})
