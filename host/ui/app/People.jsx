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
import { ChevronDown, ChevronUp } from './icons'

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
            // The grant row's field is lastSeenAt; reading d.lastSeen here kept
            // every device at "never seen" no matter how much it streamed.
            `seen ${ago(d.lastSeenAt)}`
          ].filter(Boolean).join(' · ')}
        </div>
        {/* What this device is watching RIGHT NOW - the host's own certainty,
            from the bytes it is serving (Tim, 2026-08-15). */}
        {d.watching && (
          <div class='nowrow'>
            {d.watching.artId && <img src={'/api/art?id=' + encodeURIComponent(d.watching.artId)} alt='' loading='lazy' />}
            <span>Watching <b>{d.watching.title}</b></span>
          </div>
        )}
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
        <button class='iconbtn' onClick={() => setOpen(!open)} aria-label='More'>
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
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

// PEARTUNE'S SHAPE: people first, their devices nested underneath (Tim, 2026-08-13).
//
// The old page was two flat lists - every person, then every device - which makes the
// dashboard's own model invisible. A DEVICE is a key; a PERSON is the thing a human
// recognises, and revoking a person cuts off everything they hold. Nesting the devices
// under the person they belong to is what makes that legible without a paragraph
// explaining it.
//
// What that buys, in order of how often it matters:
//
//   - somebody who needs confirming is at the TOP, in their own card, because an
//     unconfirmed claim is the only thing here that is waiting on the operator
//   - a person is one row until you open them, so a household of four is four rows
//     rather than a wall
//   - devices belonging to nobody are their own section rather than mixed in
//   - devices that were cut off are hidden until asked for. They are kept, not
//     deleted: a phone that comes back finds its own history again.
export default function People ({ state, reload }) {
  const [open, setOpen] = useState({})
  const [showRevoked, setShowRevoked] = useState(false)
  const [renaming, setRenaming] = useState(null)

  const devices = state.devices || []
  const persons = (state.persons || []).filter(p => !p.revokedAt)

  const byPerson = (id) => devices.filter(d => d.personId === id)
  // A device whose claimed name is not the person it is filed under. Pulled out into
  // its own card so every ordinary row stays uniform.
  const mismatch = (d) => {
    if (d.revokedAt || !d.claimedUser) return false
    const holder = persons.find(p => p.id === d.personId)
    return !holder || holder.name.toLowerCase() !== d.claimedUser.toLowerCase()
  }
  const pending = devices.filter(mismatch)
  const unassigned = devices.filter(d => !d.personId && !d.revokedAt && !mismatch(d))
  const revoked = devices.filter(d => d.revokedAt)
  const online = devices.filter(d => d.online && !d.revokedAt).length

  // People holding nothing sink below the ones who do. They are kept rather than
  // tidied away: a device that leaves and comes back returns to the SAME person and
  // finds what they watched, so deleting eagerly would destroy the thing that makes
  // people worth having.
  const holds = (p) => byPerson(p.id).filter(d => !d.revokedAt).length
  const ordered = [...persons]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .sort((a, b) => (holds(a) ? 0 : 1) - (holds(b) ? 0 : 1))

  const revokePerson = async (p) => {
    const theirs = holds(p)
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

  const removePerson = async (p) => {
    const ok = await askConfirm({
      title: `Delete ${p.label}?`,
      message: 'They hold no devices. What they watched goes with them.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const res = await api('/api/person/delete', { personId: p.id })
    if (res.error) return notify('Not deleted', res.error)
    reload()
  }

  // Rename in place: the name becomes a field with save and cancel. A blank or
  // unchanged name just closes it; the host refuses one that collides with somebody
  // else, and that comes back as a notice rather than as silence.
  const saveRename = async () => {
    const r = renaming
    setRenaming(null)
    if (!r) return
    const name = r.draft.trim()
    const p = persons.find(x => x.id === r.id)
    if (!name || (p && name === p.name)) return
    const res = await api('/api/person/rename', { personId: r.id, name })
    if (res.error) return notify('Not renamed', res.error)
    reload()
  }

  const addPerson = async () => {
    const name = window.prompt('What is their name?')
    if (!name) return
    const res = await api('/api/person', { name })
    if (res.error) return notify('Not added', res.error)
    reload()
  }

  const nobody = !ordered.length && !unassigned.length && !pending.length

  return (
    <div class='card access'>
      <div class='access-head'>
        <h3>People &amp; devices</h3>
        <span class='hint'>{online ? `${online} online` : ''}</span>
        <div class='spacer' />
        <button class='small ghost' onClick={addPerson}>Add a person</button>
      </div>

      {nobody && (
        <p class='hint'>
          Nobody yet. Use <b>Pair a device</b> to let a phone in - or add a person here,
          so what they watch is kept separately from what you do.
        </p>
      )}

      {pending.length > 0 && (
        <>
          <div class='access-sub warn'>Needs confirming</div>
          {pending.map(d => (
            <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />
          ))}
        </>
      )}

      {ordered.map(p => {
        const theirs = byPerson(p.id).filter(d => !d.revokedAt && !mismatch(d))
        const theirGone = byPerson(p.id).filter(d => d.revokedAt)
        const on = theirs.filter(d => d.online).length
        const isOpen = !!open[p.id]
        const editing = renaming?.id === p.id

        return (
          <div class={'prow' + (isOpen ? ' open' : '')} key={p.id}>
            <div class='prow-head'>
              <span class={'dot' + (on ? ' on' : '')} title={on ? `${on} online` : 'nothing connected'} />

              {editing
                ? (
                  <input
                    type='text'
                    value={renaming.draft}
                    autofocus
                    onInput={e => setRenaming({ id: p.id, draft: e.currentTarget.value })}
                    onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setRenaming(null) }}
                    onBlur={saveRename}
                  />
                  )
                : (
                  <button class='pname' onClick={() => setOpen({ ...open, [p.id]: !isOpen })}>
                    <b>{p.label}</b>
                    <span class='hint'>
                      {theirs.length
                        ? `${theirs.length} device${theirs.length === 1 ? '' : 's'}${on ? ` · ${on} online` : ''}`
                        : 'no devices'}
                    </span>
                  </button>
                  )}

              <div class='row'>
                <button class='small ghost' onClick={() => setRenaming({ id: p.id, draft: p.name })}>Rename</button>
                {theirs.length > 0
                  ? <button class='small destructive' onClick={() => revokePerson(p)}>Cut off</button>
                  : <button class='small ghost' onClick={() => removePerson(p)}>Delete</button>}
                <button
                  class='iconbtn'
                  onClick={() => setOpen({ ...open, [p.id]: !isOpen })}
                  aria-label={isOpen ? 'Hide their devices' : 'Show their devices'}
                  aria-expanded={isOpen}
                >{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
              </div>
            </div>

            {isOpen && (
              <div class='prow-devices'>
                {theirs.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />)}
                {showRevoked && theirGone.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />)}
                {!theirs.length && !(showRevoked && theirGone.length) && (
                  <p class='hint'>Nothing of theirs has access. Pair a device to give them one.</p>
                )}
              </div>
            )}
          </div>
        )
      })}

      {unassigned.length > 0 && (
        <>
          <div class='access-sub'>Not assigned to anybody</div>
          {unassigned.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />)}
        </>
      )}

      {revoked.length > 0 && (
        <>
          <button class='small ghost showrev' onClick={() => setShowRevoked(!showRevoked)}>
            {showRevoked ? 'Hide' : 'Show'} {revoked.length} cut off
          </button>
          {showRevoked && revoked.filter(d => !d.personId).map(d => (
            <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />
          ))}
        </>
      )}
    </div>
  )
}
