// First run.
//
// A freshly installed host has no source and no paired device, and the two things
// an operator has to do - point it at their films, and let a phone in - are the two
// things they will not find on their own in a page full of panels. So this walks
// them, once.
//
// It is DISMISSABLE and re-runnable, and the dismissal lives in this browser rather
// than on the host. "I looked at the wizard and closed it" is a per-browser
// preference; adding a persisted flag to the host's data dir for something the
// existing data already implies would be a new field with a migration attached.

import { useState } from 'preact/hooks'
import { api } from './api'
import { setupSteps, dismissSetup, DEFAULT_LIBRARY_NAME } from './setup'
import SourcePanel from './SourcePanel'
import Metadata from './Metadata'
import Pair from './Pair'

export default function Wizard ({ state, reload, onDone, onRemotePaired = null }) {
  const steps = setupSteps(state)
  const [i, setI] = useState(0)
  const [name, setName] = useState(state.library || DEFAULT_LIBRARY_NAME)
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [pwErr, setPwErr] = useState('')
  // The My server / A friend's server fork (proposal 2026-08-16-desktop-client).
  // Only a truly blank install sees it: a machine with a source is already a
  // server, one with a remote library is already a client.
  const [friend, setFriend] = useState(false)
  const [friendLink, setFriendLink] = useState('')
  const [friendBusy, setFriendBusy] = useState(false)
  const [friendErr, setFriendErr] = useState('')
  const step = steps[i]

  const pairFriend = async () => {
    setFriendBusy(true); setFriendErr('')
    const r = await api('/api/remote/pair', { link: friendLink.trim() })
    setFriendBusy(false)
    if (r?.error) return setFriendErr(r.error)
    dismissSetup()
    if (onRemotePaired) onRemotePaired(r.libraryId)
  }

  const finish = () => { dismissSetup(); onDone() }
  const advance = () => (i + 1 < steps.length ? setI(i + 1) : finish())

  const saveName = async () => {
    if (name.trim() && name.trim() !== state.library) {
      await api('/api/library', { name: name.trim() })
      await reload()
    }
    advance()
  }

  const savePassword = async () => {
    setPwErr('')
    if (!next) return advance()
    const res = await api('/api/password', { current: cur, next })
    if (res.error) return setPwErr(res.error)
    advance()
  }

  return (
    <div class='card wizard'>
      <div class='steps'>{steps.map((s, n) => <i key={s} class={n <= i ? 'on' : ''} />)}</div>

      {step === 'welcome' && (
        <>
          <h2>Welcome to PearCinema</h2>
          <p class='hint'>
            Your own film and TV collection, playable on your phone anywhere, without
            opening a single port on your router and without an account anywhere.
          </p>
          {!friend && (
            <>
              <p class='hint'>
                First question: whose films will this machine play?
              </p>
              <div class='confirm-actions'>
                <button class='ghost' onClick={finish}>Skip</button>
                <button class='ghost' onClick={() => setFriend(true)}>A friend's server</button>
                <button onClick={advance}>My server - set it up</button>
              </div>
            </>
          )}
          {friend && onRemotePaired && (
            <>
              <p class='hint'>
                On your friend's PearCinema dashboard, open a pairing window and have
                them send you the link under the code. Paste it here - their films
                play right in this page, and they can cut this machine off any time.
              </p>
              <div class='field'>
                <input
                  type='text' value={friendLink} placeholder='pear://pearcinema/pair?...'
                  onInput={e => setFriendLink(e.currentTarget.value)}
                />
              </div>
              {friendErr && <p class='error'>{friendErr}</p>}
              <div class='confirm-actions'>
                <button class='ghost' onClick={() => setFriend(false)}>Back</button>
                <button onClick={pairFriend} disabled={friendBusy || !friendLink.trim()}>
                  {friendBusy ? 'Pairing...' : 'Pair'}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {step === 'name' && (
        <>
          <h2>What should this library be called?</h2>
          <p class='hint'>This is the name a phone shows when it is paired with you.</p>
          <div class='field'>
            <input type='text' value={name} onInput={e => setName(e.currentTarget.value)} maxLength={64} />
          </div>
          <div class='confirm-actions'>
            <button class='ghost' onClick={advance}>Skip</button>
            <button onClick={saveName}>Next</button>
          </div>
        </>
      )}

      {step === 'source' && (
        <>
          <h2>Where are your films?</h2>
          <SourcePanel state={state} reload={reload} embedded />
          <div class='confirm-actions'>
            <button class='ghost' onClick={advance}>Do this later</button>
            <button onClick={advance} disabled={state.source?.kind === 'empty'}>Next</button>
          </div>
        </>
      )}

      {step === 'artwork' && (
        <>
          <h2>Posters for your films</h2>
          {/* Turning it on advances on its own - the enable IS the step. The
              buttons below are for everybody else: no key yet, or no thanks. */}
          <Metadata embedded onEnabled={advance} />
          <div class='confirm-actions'>
            <button class='ghost' onClick={advance}>Skip - artwork beside my files is enough</button>
            <button onClick={advance}>Next</button>
          </div>
        </>
      )}

      {step === 'password' && (
        <>
          <h2>Set a password for this page</h2>
          <p class='hint'>
            This page can play your library and hand out access to it, so it is worth a
            password you chose. One was generated for you; you can keep it.
          </p>
          <div class='field'>
            <label>The current one</label>
            <input type='password' value={cur} onInput={e => setCur(e.currentTarget.value)} />
          </div>
          <div class='field'>
            <label>A new one (at least 8 characters)</label>
            <input type='password' value={next} onInput={e => setNext(e.currentTarget.value)} />
          </div>
          {pwErr && <div class='banner bad'>{pwErr}</div>}
          <div class='confirm-actions'>
            <button class='ghost' onClick={advance}>Keep the generated one</button>
            <button onClick={savePassword}>Next</button>
          </div>
        </>
      )}

      {step === 'pair' && (
        <>
          <h2>Let your phone in</h2>
          <Pair state={state} reload={reload} onClose={advance} />
          <div class='confirm-actions'>
            <button class='ghost' onClick={advance}>Do this later</button>
          </div>
        </>
      )}

      {step === 'done' && (
        <>
          <h2>That is it</h2>
          <p class='hint'>
            You can watch right here in this browser, and on any phone you pair. Bear in
            mind a browser refuses some kinds of video file that a phone plays perfectly
            well - PearCinema will say so plainly rather than showing you a black screen.
          </p>
          <div class='confirm-actions'>
            <button onClick={finish}>Open the library</button>
          </div>
        </>
      )}
    </div>
  )
}
