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

import { useRef, useState } from 'preact/hooks'
import { api, ago, until, shortKey, platformLabel } from './api'
import { Modal, askConfirm, notify } from './ui'
import { Blocked, Check, ChevronDown, Pencil, Plus, Trash } from './icons'

// One device, as a row. `nested` is a device sitting under the person who holds it,
// where the name is already known and the row is one step in.
function DeviceRow ({ d, persons, reload, nested = false }) {
  const [open, setOpen] = useState(false)
  // The claim question, asked in a window rather than as two long word buttons on
  // the row (Tim, 2026-08-20: "a modal pop-up is cleaner than those two text buttons
  // in the line"). It also has room to say what each answer MEANS, which the row
  // never did - and joining somebody inherits their watch history, so that is worth
  // a sentence.
  const [claimOpen, setClaimOpen] = useState(false)

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

  // ASK BEFORE MOVING SOMEBODY ELSE'S DEVICE (Tim, 2026-08-20). A chooser that acts
  // the instant it changes gives no way to back out of a mis-click, and no sign that
  // anything happened either - which is how it read.
  const assign = async (personId) => {
    const to = personId ? persons.find(p => p.id === personId) : null
    const ok = await askConfirm({
      title: to ? `File ${d.label || 'this device'} under ${to.label}?` : `Take ${d.label || 'this device'} off ${d.belongsTo || 'its person'}?`,
      message: to
        ? `Whoever holds it shares ${to.label}'s watch history from now on, and cutting ${to.label} off cuts this device with it.`
        : 'It keeps its access and stops belonging to anybody, so what it watches is its own again.',
      confirmLabel: to ? 'File it there' : 'Take it off'
    })
    if (!ok) return
    const res = await api('/api/assign', { deviceKey: d.deviceKey, personId })
    if (res.error) return notify('Not changed', res.error)
    reload()
  }

  // "I have seen the new name, and it is still theirs." The way out of Needs
  // confirming for a device that renamed ITSELF while already assigned - which had
  // none: it could be moved to a person of the new name, or detached and started
  // again, and those are the two things somebody may well not want.
  const keepWhereItIs = async () => {
    const res = await api('/api/device/claim/keep', { deviceKey: d.deviceKey })
    if (res.error) return notify('Not changed', res.error)
    reload()
  }

  const revoked = !!d.revokedAt
  const guest = !revoked && d.expiresAt
  // Everybody who ALREADY holds the claimed name. Joining one of them is a real
  // choice with a consequence; minting another of the same name is a different one.
  const holders = persons.filter(p => p.name.toLowerCase() === String(d.claimedUser || '').toLowerCase())

  const claimAnswers = [
    ...(d.personId && d.belongsTo
      ? [{
          label: `Still ${d.belongsTo}`,
          hint: 'It stays where it is and stops asking. Nothing about it changes.',
          run: keepWhereItIs
        }]
      : []),
    ...holders.filter(p => p.id !== d.personId).map(p => ({
      label: `It is ${p.label}`,
      hint: `It joins ${p.label} and shares their watch history from now on.`,
      run: () => confirmPerson(false, p.id)
    })),
    holders.length
      ? {
          label: `A different ${d.claimedUser}`,
          hint: 'Somebody who happens to have the same name. They get a history of their own.',
          run: () => confirmPerson(true, null)
        }
      : {
          label: `It really is ${d.claimedUser}`,
          hint: 'Nobody here has that name, so it becomes a person of their own.',
          run: () => confirmPerson(false, null)
        }
  ]

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
    // WHAT IS INTERESTING ABOUT THIS ROW. Filed under somebody, that is who; but a
    // claim nobody has agreed to yet is the reason the row is being looked at, so it
    // is said out loud - and said BESIDE the person when there is one, because "the
    // TCL says it is Tim TCL2 and is filed under Tim" is the whole situation.
    !d.revokedAt && d.claimedUser && !d.confirmed ? `Says it is ${d.claimedUser}` : null,
    nested ? null : (d.belongsTo
      ? (d.claimedUser && !d.confirmed ? `filed under ${d.belongsTo}` : d.belongsTo)
      : (d.claimedUser ? null : 'Nobody yet')),
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
          {/* ONE CONTROL, and the question itself opens in a window. Offered
              whenever the claim is unsettled - assigned or not. It used to be
              hidden the moment a device had a person, so a device that renamed
              itself was stuck in Needs confirming with nothing on the row that
              could get it out (Tim, 2026-08-20). */}
          {!revoked && d.claimedUser && !d.confirmed && (
            <button
              class='iconbtn pending'
              onClick={() => setClaimOpen(true)}
              title={`Say who ${d.label || 'this device'} is`}
              aria-label={`Say who ${d.label || 'this device'} is`}
            ><Check size={17} /></button>
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
          ><span class={'turn' + (open ? ' on' : '')}><ChevronDown size={15} /></span></button>
        </span>
      </div>

      {claimOpen && (
        <Modal title={`Who is ${d.label || 'this device'}?`} onClose={() => setClaimOpen(false)}>
          <p class='hint'>
            It calls itself <b>{d.claimedUser}</b>
            {d.belongsTo ? <> and is filed under <b>{d.belongsTo}</b></> : <> and does not belong to anybody yet</>}.
          </p>
          {/* EVERY ANSWER SAYS WHAT IT DOES. Joining somebody inherits their watch
              history, which is the whole reason this is an operator's decision and
              never the device's (proposal 2026-07-14) - so it is stated rather than
              implied by a button's name.
              This also retires a guess that was plainly wrong: the row used to pass
              "make a new person" whenever exactly ONE person already held the
              claimed name, which minted a duplicate instead of joining them. The
              window asks instead. */}
          <div class='claimopts'>
            {claimAnswers.map((a, i) => (
              <button
                key={a.label}
                // THE FIRST ANSWER IS THE FILLED ONE, and only the first. Two solid
                // amber blocks are not a recommendation, they are a pair of shouts -
                // the same thing the video engine row was pulled up for.
                class={i === 0 ? '' : 'ghost'}
                onClick={() => { setClaimOpen(false); a.run() }}
              >
                <span>{a.label}</span>
                <span class='hint'>{a.hint}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {/* FOLDED RATHER THAN SWITCHED (Tim, 2026-08-20). The panel stays in the page
          and the fold animates its height, which is the only way to animate a height
          nobody knows in advance - a grid row from 0fr to 1fr. It is marked hidden
          from assistive technology while it is shut, because it is still there. */}
      <div class={'rowfold' + (open ? ' on' : '')} aria-hidden={!open}>
       <div class='rowfold-in'>
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
       </div>
      </div>
    </>
  )
}

// WHAT ONE PERSON MAY SEE, chosen here. proposals/2026-08-30-per-person-folders.md,
// approved 2026-08-30 with any folder depth from v1.
//
// The tree is read one level at a time, on demand: a 16,000-file library cannot be
// sent as one payload, and most narrowings open one branch. Everything is the default
// and the state of every grant until now, so the sheet opens on "Everything" with
// nothing ticked and saving nothing keeps it that way.
// THE FOLDER TREE, shared by the People page and the pairing dialog. Read one level at
// a time, on demand: a 16,000-file library cannot be sent as one payload, and most
// narrowings open one branch. Ticking nothing means everything, which is the default
// and the state of every grant until now.
export function FolderPicker ({ picked, onChange, who, prompt = null }) {
  const [roots, setRoots] = useState(null)
  const [supported, setSupported] = useState(true)
  const [kids, setKids] = useState({})
  const [openDirs, setOpenDirs] = useState({})

  const keyOf = (root, rel) => root + '\u0000' + (rel || '')
  const load = async (root = null, rel = '') => {
    const res = await api('/api/sharing/folders', { root, rel })
    if (res?.error) return notify('Not read', res.error)
    if (res.supported === false) setSupported(false)
    setRoots(res.roots || [])
    if (root) setKids(k => ({ ...k, [keyOf(root, rel)]: res.folders || [] }))
  }
  if (roots === null && supported) load()

  const isPicked = (root, rel) => picked.some(p => p.root === root && (p.rel || '') === (rel || ''))
  // A ticked ancestor already covers this folder, so its own tick is implied and its box
  // is shown ticked and disabled - ticking it again would store a redundant prefix.
  const coveredBy = (root, rel) => picked.find(p => p.root === root && (p.rel || '') !== (rel || '') &&
    ((p.rel || '') === '' || String(rel || '').startsWith(p.rel + '/')))
  const toggle = (root, rel) => {
    if (coveredBy(root, rel)) return
    onChange(isPicked(root, rel)
      ? picked.filter(p => !(p.root === root && (p.rel || '') === (rel || '')))
      // Ticking a folder drops anything beneath it: the shorter prefix says the same
      // thing, and a stored list of overlapping prefixes is one nobody can read back.
      : [...picked.filter(p => !(p.root === root && (p.rel || '') !== '' && String(p.rel).startsWith((rel || '') + '/'))), { root, rel: rel || '' }])
  }
  const openFolder = async (root, rel) => {
    const k = keyOf(root, rel)
    setOpenDirs(o => ({ ...o, [k]: !o[k] }))
    if (!kids[k]) await load(root, rel)
  }

  const Row = ({ root, rel, name, depth }) => {
    const k = keyOf(root, rel)
    const covered = coveredBy(root, rel)
    return (
      <>
        <div class='setrow' style={{ paddingLeft: (0.6 + depth * 1.1) + 'rem' }}>
          <span class='rowmain'>
            <label class='rowname'>
              <input type='checkbox' checked={!!covered || isPicked(root, rel)} disabled={!!covered} onChange={() => toggle(root, rel)} />
              {' '}{name}
            </label>
            {covered && <span class='rowsub dim'>Included already</span>}
          </span>
          <span class='rowctl'>
            <button
              class='iconbtn'
              onClick={() => openFolder(root, rel)}
              aria-label={openDirs[k] ? `Hide what is inside ${name}` : `Show what is inside ${name}`}
              aria-expanded={!!openDirs[k]}
            ><span class={'turn' + (openDirs[k] ? ' on' : '')}><ChevronDown size={16} /></span></button>
          </span>
        </div>
        {openDirs[k] && (kids[k] || []).map(f => (
          <Row key={f.root + f.rel} root={f.root} rel={f.rel} name={f.name} depth={depth + 1} />
        ))}
        {openDirs[k] && kids[k] && kids[k].length === 0 && (
          <div class='setrow' style={{ paddingLeft: (1.7 + depth * 1.1) + 'rem' }}>
            <span class='rowsub dim'>No folders inside this one.</span>
          </div>
        )}
      </>
    )
  }

  if (!supported) return <p class='hint'>This library's source cannot list folders, so sharing stays all or nothing here.</p>
  // THE WRAPPER IS NOT DECORATION. This tree is rendered in two places, and the pairing
  // panel centres its text - so the same rows came out centred there and left-aligned on
  // the People page (Tim, 2026-08-30, looking at both). The class pins the alignment to
  // the picker rather than to wherever it happens to be standing.
  return (
    <div class='folderpick'>
      {prompt && <p class='hint'>{prompt}</p>}
      {roots === null && <p class='hint'>Reading the library…</p>}
      {(roots || []).map(r => <Row key={r.root} root={r.root} rel='' name={r.label} depth={0} />)}
    </div>
  )
}

function SharingSheet ({ person, devices, onClose, onSaved }) {
  const [picked, setPicked] = useState(() => {
    const held = devices.find(d => Array.isArray(d.paths) && d.paths.length)
    return held ? held.paths.map(p => ({ root: p.root, rel: p.rel || '' })) : []
  })
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    const res = await api('/api/sharing/set', { personId: person.id, paths: picked.length ? picked : null })
    setBusy(false)
    if (res?.error) return notify('Not saved', res.error)
    notify(picked.length ? `${person.label} sees ${picked.length} folder${picked.length === 1 ? '' : 's'}` : `${person.label} sees everything`,
      picked.length
        ? 'Films they have already downloaded stay on their phone.'
        : 'The whole library, as before.')
    onSaved()
  }

  return (
    <Modal title={`What ${person.label} can see`} onClose={onClose}>
      <FolderPicker
        picked={picked}
        onChange={setPicked}
        who={person.label}
        prompt={`Tick the drives or folders ${person.label} may watch. Tick nothing and they see everything, which is how it has always been.`}
      />
      <p class='hint'>Films they have already downloaded stay on their phone.</p>
      {/* THE HOUSE SHAPE FOR A WINDOW'S BUTTONS: centred, one width, no inline style.
          Every other window in this dashboard uses it (`.confirm-actions`), and these
          two were shipped right-aligned with a hand-written margin (Tim, 2026-08-30). */}
      <div class='confirm-actions'>
        <button class='ghost' onClick={onClose}>Cancel</button>
        {/* One word, so both buttons are the width `.confirm-actions` gives them. What
            saving nothing means is the sentence at the top of the window, not a label. */}
        <button disabled={busy} onClick={save}>Save</button>
      </div>
    </Modal>
  )
}


export default function People ({ state, reload }) {
  const [open, setOpen] = useState({})
  const [showRevoked, setShowRevoked] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [adding, setAdding] = useState(null)
  const [sharing, setSharing] = useState(null)
  // ONE SUBMIT PER FIELD, and this is a real bug Tim found by using it (2026-08-20:
  // adding "Asa" made two of them). A field that saves on Enter AND on blur saves
  // twice, because removing the focused input fires the blur - and Preact's state
  // update has not landed yet, so the second call still sees the name. It bit the
  // add field rather than the rename one only because renaming to the same name
  // twice is invisible.
  const sent = useRef(false)

  const devices = state.devices || []
  const persons = (state.persons || []).filter(p => !p.revokedAt)

  const byPerson = (id) => devices.filter(d => d.personId === id)
  // How many folders a person is narrowed to, or 0 for everything. Read off their
  // devices, which all carry the same value (the host writes them together).
  const narrowedTo = (theirs) => {
    const held = theirs.find(d => !d.revokedAt && Array.isArray(d.paths) && d.paths.length)
    return held ? held.paths.length : 0
  }
  // A device whose claim nobody has agreed to yet. Pulled out into its own group so
  // every ordinary row stays uniform.
  //
  // THE HOST ANSWERS THIS, the page no longer works it out. It used to compare the
  // person's name with what the device claimed, which is the same comparison that
  // forced a rename to overwrite the name on somebody's own phone - one rule, one
  // place (Tim, 2026-08-20).
  const mismatch = (d) => !d.revokedAt && !!d.claimedUser && !d.confirmed
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
    if (sent.current) return
    sent.current = true
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
    if (sent.current) return
    sent.current = true
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
          // EVERY LIVE DEVICE FILED UNDER THEM, whether its claim is settled or not.
          // Counting only the settled ones made a person whose device had renamed
          // itself read "No devices" while that device sat in Needs confirming above
          // - and, worse, offered Delete, which would have orphaned it (Tim,
          // 2026-08-20). The pending one is still shown in its own group, because
          // that is the thing waiting on the operator; it is only the COUNT and the
          // choice of button that have to know about it.
          const mine = byPerson(p.id).filter(d => !d.revokedAt)
          const theirs = mine.filter(d => !mismatch(d))
          const waiting = mine.length - theirs.length
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
                    {[
                      mine.length ? `${mine.length} device${mine.length === 1 ? '' : 's'}` : 'No devices',
                      on ? `${on} connected now` : null,
                      waiting ? `${waiting} waiting to be confirmed` : null
                    ].filter(Boolean).join(', ')}
                  </span>
                  {/* WHAT THEY CAN SEE, ON ITS OWN LINE AND TAPPABLE, which is what the
                      proposal asked for and what the first build got wrong: the control
                      was an unlabelled eye among three other icons and Tim could not find
                      it on his own dashboard (2026-08-30). A sentence that says the
                      current answer and opens the chooser is a control somebody can see. */}
                  <button class='seeline' onClick={() => setSharing(p)}>
                    Can see: {narrowedTo(mine)
                      ? `${narrowedTo(mine)} folder${narrowedTo(mine) === 1 ? '' : 's'}`
                      : 'everything'}
                    <span class='seechev'><ChevronDown size={13} /></span>
                  </button>
                </span>
                <span class='rowctl'>
                  <button
                    class='iconbtn'
                    onClick={() => { sent.current = false; setRenaming({ id: p.id, draft: p.name }) }}
                    title={`Rename ${p.label}`}
                    aria-label={`Rename ${p.label}`}
                  ><Pencil size={16} /></button>
                  {/* CUT OFF CUTS EVERY DEVICE THEY HOLD, which is the action somebody
                      means when they say take Sam off. Somebody holding nothing has
                      nothing to cut, so that row offers Delete instead - a different
                      act and therefore a different picture. */}
                  {mine.length > 0
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
                  ><span class={'turn' + (isOpen ? ' on' : '')}><ChevronDown size={16} /></span></button>
                </span>
              </div>

              {/* NESTED, AND IT HAS TO LOOK NESTED. Without the indent and the
                  rule down the left, a person's devices read as more people -
                  which is the exact thing the nesting exists to prevent. */}
              <div class={'rowfold' + (isOpen ? ' on' : '')} aria-hidden={!isOpen}>
               <div class='rowfold-in'>
                <div class='rowopen nested'>
                  <div class='setrows'>
                    {theirs.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} nested />)}
                    {showRevoked && theirGone.map(d => <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} nested />)}
                    {!theirs.length && !(showRevoked && theirGone.length) && (
                      <p class='hint'>Nothing of theirs has access. Pair a device to give them one.</p>
                    )}
                  </div>
                </div>
               </div>
              </div>
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
                  onClick={() => { sent.current = false; setAdding('') }}
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
                ><span class={'turn' + (showRevoked ? ' on' : '')}><ChevronDown size={16} /></span></button>
              </span>
            </div>
            {showRevoked && revoked.filter(d => !d.personId).map(d => (
              <DeviceRow key={d.deviceKey} d={d} persons={persons} reload={reload} />
            ))}
          </div>
        </>
      )}
      {sharing && (
        <SharingSheet
          person={sharing}
          devices={byPerson(sharing.id)}
          onClose={() => setSharing(null)}
          onSaved={() => { setSharing(null); reload() }}
        />
      )}

    </>
  )
}
