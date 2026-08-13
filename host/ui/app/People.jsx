// Who can watch, and the button that stops them.
//
// TWO RULES INHERITED FROM PEARTUNE THAT ARE SECURITY BUGS IF BROKEN, restated here
// because this is the screen that exercises them:
//
//   1. The grant store is host-local and NEVER replicated. Nothing on this page
//      travels anywhere; it is read from and written to the machine holding the
//      films. A revoked device holding a writer key into a shared ledger could
//      append itself back onto the list.
//   2. REVOKE MUST KILL LIVE CONNECTIONS, not just future ones. The host does that
//      (it reports how many it cut), and this page shows the number - because
//      "revoked" that leaves a film playing is not revoked.
//
// The subtlety worth keeping in view: a DEVICE is the thing with a key, and a
// PERSON is the thing a human recognises. Revoking a person cuts every device they
// hold at once, which is the action somebody actually wants when they say "take
// Sam off".

import { useState } from 'preact/hooks'
import { api, ago, until, shortKey, platformLabel } from './api'
import { askConfirm, notify } from './ui'

function DeviceRow ({ d, persons, reload }) {
  const [open, setOpen] = useState(false)

  const revoke = async () => {
    const ok = await askConfirm({
      title: `Cut off ${d.label || 'this device'}?`,
      message: 'It loses access immediately, mid-film if something is playing. It can be let back in later by pairing again.',
      confirmLabel: 'Cut it off',
      danger: true
    })
    if (!ok) return
    const res = await api('/api/revoke', { deviceKey: d.deviceKey })
    await reload()
    notify('Done', res.killed
      ? `Access removed, and ${res.killed} live connection${res.killed === 1 ? '' : 's'} cut.`
      : 'Access removed. It had nothing connected at the time.')
  }

  const forget = async () => {
    const ok = await askConfirm({
      title: 'Remove this row?',
      message: 'Tidying only - this device is already cut off. Removing the row just stops the list growing forever.',
      confirmLabel: 'Remove'
    })
    if (!ok) return
    const res = await api('/api/device/delete', { deviceKey: d.deviceKey })
    if (res.error) return notify('Not removed', res.error)
    reload()
  }

  const confirmPerson = async (asNew, personId) => {
    const res = await api('/api/person/confirm', { deviceKey: d.deviceKey, asNew, personId })
    if (res.error) return notify('Not confirmed', res.error)
    reload()
  }

  const assign = async (personId) => {
    const res = await api('/api/assign', { deviceKey: d.deviceKey, personId })
    if (res.error) return notify('Not changed', res.error)
    reload()
  }

  const revoked = !!d.revokedAt
  const sameName = persons.filter(p => p.name === d.claimedUser)

  return (
    <div class='dev'>
      <span class={'dot' + (d.online ? ' on' : '')} title={d.online ? 'connected now' : 'not connected'} />
      <div class='who'>
        <b>{d.label || 'A device'}</b>
        {d.scope === 'owner' && <span class='chip accent' style='margin-left:.4rem'>owner</span>}
        {revoked && <span class='chip bad' style='margin-left:.4rem'>cut off</span>}
        {!revoked && d.expiresAt && <span class='chip warn' style='margin-left:.4rem'>guest · {until(d.expiresAt) || 'expired'}</span>}
        <div>
          {[
            d.belongsTo ? `${d.belongsTo}` : (d.claimedUser ? `says it is ${d.claimedUser}` : 'nobody yet'),
            platformLabel(d.platform),
            `seen ${ago(d.lastSeen)}`
          ].filter(Boolean).join(' · ')}
        </div>
        <div class='mono' title={d.deviceKey}>{shortKey(d.deviceKey)}</div>
      </div>

      <div class='row'>
        {!revoked && !d.personId && d.claimedUser && (
          <button class='small ghost' onClick={() => confirmPerson(sameName.length === 1, sameName.length === 1 ? sameName[0].id : null)}>
            It really is {d.claimedUser}
          </button>
        )}
        {!revoked && <button class='small destructive' onClick={revoke}>Cut off</button>}
        {revoked && <button class='small ghost' onClick={forget}>Remove row</button>}
        <button class='iconbtn' onClick={() => setOpen(!open)} aria-label='More'>{open ? '▴' : '▾'}</button>
      </div>

      {open && (
        <div style='flex-basis:100%;border-top:1px solid var(--line);margin-top:.5rem;padding-top:.5rem'>
          <label>Belongs to</label>
          <select value={d.personId || ''} onChange={e => assign(e.currentTarget.value || null)} disabled={revoked}>
            <option value=''>nobody</option>
            {persons.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <p class='hint'>
            A device only becomes a person when you say so. What it calls itself is only
            what it said.
          </p>
        </div>
      )}
    </div>
  )
}

export default function People ({ state, reload }) {
  const devices = state.devices || []
  const persons = state.persons || []
  const live = devices.filter(d => !d.revokedAt)
  const gone = devices.filter(d => d.revokedAt)

  const revokePerson = async (p) => {
    const theirs = live.filter(d => d.personId === p.id).length
    const ok = await askConfirm({
      title: `Cut off ${p.label}?`,
      message: `Every device they hold loses access immediately${theirs ? ` - that is ${theirs} device${theirs === 1 ? '' : 's'}` : ''}.`,
      confirmLabel: 'Cut them off',
      danger: true
    })
    if (!ok) return
    const res = await api('/api/person/revoke', { personId: p.id })
    await reload()
    notify('Done', `${res.devices} device${res.devices === 1 ? '' : 's'} removed, ${res.killed} live connection${res.killed === 1 ? '' : 's'} cut.`)
  }

  const rename = async (p) => {
    const name = window.prompt('What should they be called?', p.name)
    if (!name || name === p.name) return
    const res = await api('/api/person/rename', { personId: p.id, name })
    if (res.error) return notify('Not renamed', res.error)
    reload()
  }

  // SOMEBODY WHO DOES NOT HAVE A DEVICE YET. A person used to appear only when a
  // paired phone claimed a name, which was fine while people were just a way to group
  // devices. It stops being fine now that what you have watched is kept per person: a
  // household that watches on one laptop otherwise has nobody but "Me", and the second
  // person in the house has nowhere to put their history.
  const addPerson = async () => {
    const name = window.prompt('What is their name?')
    if (!name) return
    const res = await api('/api/person', { name })
    if (res.error) return notify('Not added', res.error)
    reload()
  }

  return (
    <>
      <div class='card'>
        <div class='row' style='justify-content:space-between;align-items:center'>
          <h3 style='margin:0'>People</h3>
          <button class='small ghost' onClick={addPerson}>Add a person</button>
        </div>
        {!persons.length && (
          <p class='hint'>
            Nobody yet. A person appears when a paired device says who it belongs to and you
            confirm it - or add one here, so what they watch is kept separately from what you do.
          </p>
        )}
        {persons.map(p => (
          <div class='dev' key={p.id}>
            <div class='who'>
              <b>{p.label}</b>
              <div>{live.filter(d => d.personId === p.id).length} device(s)</div>
            </div>
            <div class='row'>
              <button class='small ghost' onClick={() => rename(p)}>Rename</button>
              <button class='small destructive' onClick={() => revokePerson(p)}>Cut off</button>
            </div>
          </div>
        ))}
      </div>

      <div class='card'>
        <h3>Devices with access</h3>
        {!live.length && <p class='hint'>None yet. Use Pair a device to let a phone in.</p>}
        {live.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />)}
      </div>

      {gone.length > 0 && (
        <div class='card'>
          <h3>No longer allowed</h3>
          <p class='hint'>Kept so you can see what was removed and when. They cannot get back in without pairing again.</p>
          {gone.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />)}
        </div>
      )}
    </>
  )
}
