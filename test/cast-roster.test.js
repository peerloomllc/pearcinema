// THE PICKER IS FOR TELEVISIONS. A house has far more media players than
// screens - Tim scrolled past speakers to find his one TV (2026-08-17) - so the
// roster ranks by what Home Assistant says a thing IS, and the operator can
// prune the rest by hand in the dashboard's Casting panel.
//
// These are the first tests to build a real Speakers against a temp dataDir;
// list(), save() and publicConfig() had no coverage at all before.

const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')

const { Speakers } = require('../host/speakers')
const { createMethods } = require('../host/methods')

// One HA /api/states payload, deliberately mixed: two screens, two speakers, one
// entity with no device_class at all (the Voice PE case, which is why an absent
// class must not read as "not a television"), and one non-media entity that has
// no business in a media picker.
const STATES = [
  { entity_id: 'media_player.kitchen_speaker', state: 'idle', attributes: { friendly_name: 'Kitchen', device_class: 'speaker' } },
  { entity_id: 'media_player.living_room_tv', state: 'off', attributes: { friendly_name: 'Living Room TV', device_class: 'tv' } },
  { entity_id: 'media_player.voice_pe', state: 'idle', attributes: { friendly_name: 'Voice Thing' } },
  { entity_id: 'media_player.bedroom_tv', state: 'playing', attributes: { friendly_name: 'Bedroom TV', device_class: 'tv' } },
  { entity_id: 'media_player.study_receiver', state: 'idle', attributes: { friendly_name: 'Study Amp', device_class: 'receiver' } },
  { entity_id: 'light.hallway', state: 'on', attributes: { friendly_name: 'Hallway' } }
]

async function speakers (t, { hidden = [] } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-cast-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const s = new Speakers({ dataDir: dir })
  // A configured, enabled host: loopback URL and a token, which is what the
  // enabled getter insists on.
  s.save({ enabled: true, baseUrl: 'http://127.0.0.1:8123', token: 'tok', hidden })
  s._call = async (p) => (p === '/api/states' ? STATES : null)
  return { s, dir }
}

test('the roster puts screens first and speakers last, alphabetical within each', async (t) => {
  const { s } = await speakers(t)
  const names = (await s.list()).map(x => x.name)
  assert.deepEqual(names, [
    'Bedroom TV', 'Living Room TV', // tv
    'Study Amp', //                    receiver
    'Voice Thing', //                  no class stated - between, never last
    'Kitchen' //                       speaker
  ])
})

test('the roster keeps the kind HA reports, and drops what is not a media player', async (t) => {
  const { s } = await speakers(t)
  const list = await s.list()
  assert.equal(list.length, 5, 'the hallway light is not a cast target')
  assert.equal(list.find(x => x.name === 'Bedroom TV').deviceClass, 'tv')
  assert.equal(list.find(x => x.name === 'Voice Thing').deviceClass, null)
})

test('hiding one marks it, and it survives a reload from disk', async (t) => {
  const { s, dir } = await speakers(t, { hidden: ['media_player.kitchen_speaker'] })
  const list = await s.list()
  assert.equal(list.find(x => x.name === 'Kitchen').hidden, true)
  assert.equal(list.find(x => x.name === 'Bedroom TV').hidden, false)

  const reopened = new Speakers({ dataDir: dir })
  assert.deepEqual(reopened.publicConfig().hidden, ['media_player.kitchen_speaker'])
})

test('saving only the hide list leaves the connection settings alone', async (t) => {
  const { s } = await speakers(t)
  const before = s.publicConfig()
  const after = s.save({ hidden: ['media_player.voice_pe'] })
  assert.deepEqual(after.hidden, ['media_player.voice_pe'])
  // The half of this that would be a real bug: a partial save quietly turning
  // casting off, or forgetting the token, which is the donor's own lesson.
  assert.equal(after.enabled, before.enabled)
  assert.equal(after.baseUrl, before.baseUrl)
  assert.equal(after.tokenSet, true)
})

test('a malformed hide list is ignored rather than emptying the real one', async (t) => {
  const { s } = await speakers(t, { hidden: ['media_player.kitchen_speaker'] })
  const after = s.save({ hidden: 'media_player.kitchen_speaker' })
  assert.deepEqual(after.hidden, ['media_player.kitchen_speaker'])
})

test('the hide list is deduped and cleaned on the way in', async (t) => {
  const { s } = await speakers(t)
  const after = s.save({ hidden: ['  b  ', 'a', 'b', '', 'a'] })
  assert.deepEqual(after.hidden, ['a', 'b'])
})

// --- what the phone is actually offered ------------------------------------

test('the phone is offered neither the hidden nor the unreachable', async (t) => {
  const { s } = await speakers(t, { hidden: ['media_player.kitchen_speaker'] })
  s._call = async (p) => (p === '/api/states'
    ? [...STATES, { entity_id: 'media_player.gone', state: 'unavailable', attributes: { friendly_name: 'Unplugged', device_class: 'tv' } }]
    : null)

  const m = createMethods({
    getAdapter: () => ({}),
    getLibraryName: () => 'L',
    cast: () => ({ speakers: s, active: () => null })
  })
  const out = await m['cast.list']({
    params: {},
    isOwner: true,
    deviceKey: 'phone-1',
    notFound: (x) => new Error(x),
    forbidden: (x) => new Error(x)
  })

  const names = out.targets.map(x => x.name)
  assert.equal(out.enabled, true)
  assert.ok(!names.includes('Kitchen'), 'the operator hid the kitchen speaker')
  assert.ok(!names.includes('Unplugged'), 'HA cannot reach it, so it is not a button')
  assert.deepEqual(names, ['Bedroom TV', 'Living Room TV', 'Study Amp', 'Voice Thing'])
})

test('A ROKU WAITING ON ITS CHANNEL TRAVELS TO THE PHONE BY NAME', async () => {
  // A support email, 2026-08-29: someone could not cast to their Roku and had no way to
  // learn why - the dashboard knew (one free channel, Media Assistant) but the phone's
  // picker just showed nothing. cast.list now carries the host's list, so the picker
  // can name the Roku and the step.
  const s = {
    enabled: true,
    list: async () => [],
    needsChannel: [{ host: '10.0.0.7', name: 'Living Room' }]
  }
  const m = createMethods({
    getAdapter: () => ({}),
    getLibraryName: () => 'L',
    cast: () => ({ speakers: s, active: () => [] })
  })
  const ctx = { params: {}, isOwner: true, deviceKey: 'phone-1', notFound: (x) => new Error(x), forbidden: (x) => new Error(x) }
  const out = await m['cast.list'](ctx)
  assert.deepEqual(out.targets, [])
  assert.deepEqual(out.needsChannel, [{ host: '10.0.0.7', name: 'Living Room' }])

  // And a speakers object with no such list (an older backend) reads as none, not a crash.
  const m2 = createMethods({ getAdapter: () => ({}), getLibraryName: () => 'L', cast: () => ({ speakers: { enabled: true, list: async () => [] }, active: () => [] }) })
  assert.deepEqual((await m2['cast.list'](ctx)).needsChannel, [])
})
