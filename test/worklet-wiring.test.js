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
})

test('the Continue shelf is folded and scoped, rather than concatenated', () => {
  // One film half-watched on two libraries used to be two cards, and the chip was
  // ignored entirely.
  const body = method('resume.list')
  assert.match(body, /merge\.collapseResume\(rows, mergedIndex, libraryFilter\(\)\)/)
  assert.match(body, /libraryId: h\.libraryId/, 'rows carry the library that answered, or nothing can be folded')
})
