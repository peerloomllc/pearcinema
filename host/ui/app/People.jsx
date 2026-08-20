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
//
// THE LEDGER SHAPE (Tim, 2026-08-20). This was the last screen still wearing the
// old one - a card with a heading and nested lists inside it - while every Settings
// page had moved to rows: what it is on the left, the control on the right, a
// sub-line only where the control needs one. It is now a Settings page like the
// others, reached from the nav or straight from the topbar's people icon, which
// keeps its dot and keeps cutting a device off one press away.
//
// WHAT THE RESHAPE WAS NOT ALLOWED TO COST, and this is the whole reason to write it
// down: revoke stays one press from where a device is named, and it keeps saying how
// many live connections it cut. That sentence is the app's central security claim and
// it is displayed, not assumed.
//
// The nesting stays, because the nesting IS the model: a person is one row until you
// open them, so a household of four is four rows rather than a wall of keys.

import { useState } from 'preact/hooks'
import { api, ago, until, shortKey, platformLabel } from './api'
import { askConfirm, notify } from './ui'
import { Blocked, ChevronDown, ChevronUp, Pencil, Plus, Trash } from './icons'

// One device, as a row. `nested` is a device sitting under the person who holds it,
// where the name is already known and the row is one step in.
function DeviceRow ({ d, persons, reload, nested = false }) {
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
    // THE NUMBER, ALWAYS. "Revoked" that left a film playing would not be revoked,
    // so the count of connections actually cut is reported rather than assumed.
    notify('Done', res.killed
      ? `Access removed, and ${res.killed} live connection${res.killed === 1 ? '' : 's'} cut.`
      : 'Access removed. It had nothing connected at the time.')
  }

  const forget = async () => {
    const ok = await askConfirm({
      title: 'Remove this row?',
      message: 'Tidying only, since this device is already cut off. Removing the row just stops the list growing forever.',
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
  const guest = !revoked && d.expiresAt
  const sameName = persons.filter(p => p.name === d.claimedUser)

  // THE NAME CARRIES THE STATE and the sub-line says it in words, the rule the
  // televisions row set: colour is never the only carrier. A cut-off row is dim, a
  // guest pass about to run out is amber, a connected device is green.
  const tone = revoked ? 'dim' : guest ? 'warn' : d.online ? 'good' : ''

  // ONE LINE OF FACTS, in the order somebody reads them: what state it is in, whose
  // it is, what kind of machine, when it was last here.
  const facts = [
    revoked ? 'Cut off' : d.online ? 'Connected now' : null,
    guest ? `Guest, ${until(d.expiresAt) || 'expired'}` : null,
    d.scope === 'owner' ? 'Owner' : null,
    nested ? null : (d.belongsTo || (d.claimedUser ? `Says it is ${d.claimedUser}` : 'Nobody yet')),
    platformLabel(d.platform),
    // The grant row's field is lastSeenAt; reading d.lastSeen here kept every
    // device at "never seen" no matter how much it streamed.
    `seen ${ago(d.lastSeenAt)}`
  ].filter(Boolean).join(' · ')

  return (
    <>
      <div class='setrow'>
        <span class='rowmain'>
          <span class={'rowname ' + tone}>{d.label || 'A device'}</span>
          <span class='rowsub'>{facts}</span>
          {/* What this device is watching RIGHT NOW - the host's own certainty,
              from the bytes it is serving (Tim, 2026-08-15). */}
          {d.watching && (
            <span class='rowsub nowrow'>
              {d.watching.artId && <img src={'/api/art?id=' + encodeURIComponent(d.watching.artId)} alt='' loading='lazy' />}
              <span>Watching <b>{d.watching.title}</b></span>
            </span>
          )}
        </span>
        <span class='rowctl'>
          {!revoked && !d.personId && d.claimedUser && (
            <button class='ghost' onClick={() => confirmPerson(sameName.length === 1, sameName.length === 1 ? sameName[0].id : null)}>
              It really is {d.claimedUser}
            </button>
          )}
          {/* CUT OFF STAYS ONE PRESS FROM THE NAME. Everything else about a device
              is behind the chevron; this is not. An icon rather than a word (Tim,
              2026-08-20), and the one icon on the page that carries the danger
              colour without being hovered - the act it starts is the one act here
              that cannot be undone, so it is the one control that should be
              tellable apart at a glance. It still asks before it does anything. */}
          {!revoked && (
            <button
              class='iconbtn destructive'
              onClick={revoke}
              title={`Cut off ${d.label || 'this device'}`}
              aria-label={`Cut off ${d.label || 'this device'}`}
            ><Blocked size={17} /></button>
          )}
          {revoked && (
            <button
              class='iconbtn danger'
              onClick={forget}
              title='Remove this row'
              aria-label={`Remove the row for ${d.label || 'this device'}`}
            ><Trash size={17} /></button>
          )}
          <button
            class='iconbtn'
            onClick={() => setOpen(!open)}
            aria-label={open ? `Hide details of ${d.label || 'this device'}` : `Details of ${d.label || 'this device'}`}
            aria-expanded={open}
          >{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
        </span>
      </div>

      {open && (
        <div class='rowopen'>
          <div class='setrows'>
            <div class='setrow'>
              <span class='rowmain'>
                <span class='rowname'>Belongs to</span>
                <span class='rowsub'>
                  A device only becomes a person when you say so. What it calls itself
                  is only what it said.
                </span>
              </span>
              <span class='rowctl'>
                <select value={d.personId || ''} onChange={e => assign(e.currentTarget.value || null)} disabled={revoked}>
                  <option value=''>Nobody</option>
                  {persons.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </span>
            </div>
            <div class='setrow'>
              <span class='rowmain'>
                <span class='rowname'>Its key</span>
                <span class='rowvalue' title={d.deviceKey}>{shortKey(d.deviceKey)}</span>
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default function People ({ state, reload }) {
  const [open, setOpen] = useState({})
  const [showRevoked, setShowRevoked] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [adding, setAdding] = useState(null)

  const devices = state.devices || []
  const persons = (state.persons || []).filter(p => !p.revokedAt)

  const byPerson = (id) => devices.filter(d => d.personId === id)
  // A device whose claimed name is not the person it is filed under. Pulled out into
  // its own group so every ordinary row stays uniform.
  const mismatch = (d) => {
    if (d.revokedAt || !d.claimedUser) return false
    const holder = persons.find(p => p.id === d.personId)
    return !holder || holder.name.toLowerCase() !== d.claimedUser.toLowerCase()
  }
  const pending = devices.filter(mismatch)
  const unassigned = devices.filter(d => !d.personId && !d.revokedAt && !mismatch(d))
  const revoked = devices.filter(d => d.revokedAt)

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
      message: `Every device they hold loses access immediately${theirs ? `. That is ${theirs} device${theirs === 1 ? '' : 's'}` : ''}.`,
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

  // ADDING SOMEBODY IS A FIELD ON THE PAGE, not a window.prompt. The browser's own
  // box is unstyled, suppressible and looks like the page has been hijacked - the
  // same objection that took confirm() out of this file long ago (2026-08-20).
  const saveAdd = async () => {
    const name = String(adding || '').trim()
    setAdding(null)
    if (!name) return
    const res = await api('/api/person', { name })
    if (res.error) return notify('Not added', res.error)
    reload()
  }

  const nobody = !ordered.length && !unassigned.length && !pending.length

  return (
    <>
      <div class='setpage'><span class='setpagename'>People</span></div>

      {nobody && (
        <p class='hint'>
          Nobody yet. Use <b>Pair a device</b> to let a phone in, or add somebody here,
          so what they watch is kept separately from what you do.
        </p>
      )}

      {/* FIRST, BECAUSE IT IS THE ONLY THING WAITING ON THE OPERATOR. An unconfirmed
          claim is a device saying who it is and nobody having agreed yet. */}
      {pending.length > 0 && (
        <>
          <div class='setgroup'>Needs confirming</div>
          <div class='setrows'>
            {pending.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />)}
          </div>
        </>
      )}

      <div class='setgroup'>People</div>
      <div class='setrows'>
        {ordered.map(p => {
          const theirs = byPerson(p.id).filter(d => !d.revokedAt && !mismatch(d))
          const theirGone = byPerson(p.id).filter(d => d.revokedAt)
          const on = theirs.filter(d => d.online).length
          const isOpen = !!open[p.id]
          const editing = renaming?.id === p.id

          return (
            <>
              <div class='setrow' key={p.id}>
                <span class='rowmain'>
                  {editing
                    ? (
                      <input
                        type='text'
                        class='renamefield'
                        value={renaming.draft}
                        autofocus
                        onInput={e => setRenaming({ id: p.id, draft: e.currentTarget.value })}
                        onKeyDown={e => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setRenaming(null) }}
                        onBlur={saveRename}
                      />
                      )
                    : <span class={'rowname ' + (on ? 'good' : '')}>{p.label}</span>}
                  <span class='rowsub'>
                    {theirs.length
                      ? `${theirs.length} device${theirs.length === 1 ? '' : 's'}${on ? `, ${on} connected now` : ''}`
                      : 'No devices'}
                  </span>
                </span>
                <span class='rowctl'>
                  <button
                    class='iconbtn'
                    onClick={() => setRenaming({ id: p.id, draft: p.name })}
                    title={`Rename ${p.label}`}
                    aria-label={`Rename ${p.label}`}
                  ><Pencil size={16} /></button>
                  {/* CUT OFF CUTS EVERY DEVICE THEY HOLD, which is the action somebody
                      means when they say take Sam off. Somebody holding nothing has
                      nothing to cut, so that row offers Delete instead - a different
                      act and therefore a different picture. */}
                  {theirs.length > 0
                    ? (
                      <button
                        class='iconbtn destructive'
                        onClick={() => revokePerson(p)}
                        title={`Cut off ${p.label} and every device they hold`}
                        aria-label={`Cut off ${p.label} and every device they hold`}
                      ><Blocked size={17} /></button>
                      )
                    : (
                      <button
                        class='iconbtn danger'
                        onClick={() => removePerson(p)}
                        title={`Delete ${p.label}`}
                        aria-label={`Delete ${p.label}`}
                      ><Trash size={17} /></button>
                      )}
                  <button
                    class='iconbtn'
                    onClick={() => setOpen({ ...open, [p.id]: !isOpen })}
                    aria-label={isOpen ? `Hide ${p.label}'s devices` : `Show ${p.label}'s devices`}
                    aria-expanded={isOpen}
                  >{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
                </span>
              </div>

              {/* NESTED, AND IT HAS TO LOOK NESTED. Without the indent and the
                  rule down the left, a person's devices read as more people -
                  which is the exact thing the nesting exists to prevent. */}
              {isOpen && (
                <div class='rowopen nested'>
                  <div class='setrows'>
                    {theirs.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} nested />)}
                    {showRevoked && theirGone.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} nested />)}
                    {!theirs.length && !(showRevoked && theirGone.length) && (
                      <p class='hint'>Nothing of theirs has access. Pair a device to give them one.</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )
        })}

        <div class='setrow'>
          <span class='rowmain'>
            <span class='rowname'>Add somebody</span>
            <span class='rowsub'>
              What they watch is then kept separately from what you watch.
            </span>
          </span>
          <span class='rowctl'>
            {adding === null
              ? (
                <button
                  class='iconbtn'
                  onClick={() => setAdding('')}
                  title='Add somebody'
                  aria-label='Add somebody'
                ><Plus size={17} /></button>
                )
              : (
                <input
                  type='text'
                  autofocus
                  placeholder='Their name'
                  value={adding}
                  onInput={e => setAdding(e.currentTarget.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveAdd(); if (e.key === 'Escape') setAdding(null) }}
                  onBlur={saveAdd}
                />
                )}
          </span>
        </div>
      </div>

      {unassigned.length > 0 && (
        <>
          <div class='setgroup'>Not assigned to anybody</div>
          <div class='setrows'>
            {unassigned.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />)}
          </div>
        </>
      )}

      {/* KEPT, NOT DELETED: a phone that comes back finds its own history again. Out
          of the way until asked for, because a list of things that no longer have
          access is not what anybody opened this page to read. */}
      {revoked.length > 0 && (
        <>
          <div class='setgroup'>Cut off</div>
          <div class='setrows'>
            <div class='setrow'>
              <span class='rowmain'>
                <span class='rowname'>{revoked.length} cut off</span>
                <span class='rowsub'>
                  Kept rather than deleted, so a device let back in finds what it
                  watched before.
                </span>
              </span>
              <span class='rowctl'>
                <button
                  class='iconbtn'
                  onClick={() => setShowRevoked(!showRevoked)}
                  title={showRevoked ? 'Hide the ones cut off' : 'Show the ones cut off'}
                  aria-label={showRevoked ? 'Hide the ones cut off' : 'Show the ones cut off'}
                  aria-expanded={showRevoked}
                >{showRevoked ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</button>
              </span>
            </div>
            {showRevoked && revoked.filter(d => !d.personId).map(d => (
              <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />
            ))}
          </div>
        </>
      )}
    </>
  )
}
