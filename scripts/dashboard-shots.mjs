// Capture PearCinema dashboard screenshots for the Umbrel store gallery.
//
// Why this exists rather than `firefox --headless --screenshot`: the dashboard is a Preact
// SPA that renders "Connecting to the host..." until /api/state comes back, and Firefox's
// --screenshot fires on the `load` event, so the plain flag captures the placeholder every
// time. This drives Firefox over WebDriver BiDi instead, so it can wait for real content and
// click into a tab before shooting.
//
// Usage (needs a reachable dashboard - an ssh tunnel is fine):
//   node scripts/dashboard-shots.mjs http://127.0.0.1:18751 docs/img
//
// Firefox is the only browser on the dev box; there is no Chrome, so no --virtual-time-budget.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const BASE = process.argv[2] || 'http://127.0.0.1:18751'
const OUTDIR = process.argv[3] || 'docs/img'
const PORT = 9333
// Docs shots are 1280x900 at 1x. The Umbrel store gallery wants 16:10 at 2x (the
// official-store images are 2880x1800), so both are env-driven rather than forked into
// a second script: SHOT_W=1440 SHOT_H=900 SHOT_DPR=2.
const VIEWPORT = {
  width: Number(process.env.SHOT_W) || 1280,
  height: Number(process.env.SHOT_H) || 900,
}
// devicePixelRatio is a SIBLING of `viewport` in browsingContext.setViewport, not a field
// inside it. Nesting it is accepted silently and does nothing, which shows up as a 1x
// screenshot from a run that looked like it worked.
const DPR = Number(process.env.SHOT_DPR) || 1
// A host with a password shows the login page instead of the dashboard, and every wait
// below would then time out looking for content that is one form away. SHOT_PW fills it.
const PASSWORD = process.env.SHOT_PW || ''

mkdirSync(OUTDIR, { recursive: true })

const profile = mkdtempSync(join(tmpdir(), 'pearcinema-shots-'))
const firefox = spawn('firefox', [
  '--headless', '--no-remote', '--profile', profile,
  '--remote-debugging-port', String(PORT), BASE,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Firefox speaks WebDriver BiDi ONLY - it has no CDP endpoint, so there is no
// /json/version to discover a socket URL from (asking for one gets a 404 page, which
// looks exactly like "the agent never started"). Two further traps, both of which
// present as "the agent never came up" when it is in fact running fine:
//   * The URL Firefox PRINTS at startup ("listening on ws://127.0.0.1:PORT") is not an
//     upgrade endpoint - connecting there answers HTTP 200 and the handshake fails. The
//     session endpoint is /session.
//   * The agent needs a moment to bind, so the socket must be polled, not assumed.
const BIDI_URL = `ws://127.0.0.1:${PORT}/session`
async function waitForAgent () {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(BIDI_URL)
      const done = (v) => { try { probe.close() } catch {} ; resolve(v) }
      probe.once('open', () => done(true))
      probe.once('error', () => done(false))
    })
    if (ok) return BIDI_URL
    await sleep(500)
  }
  throw new Error('the Firefox remote agent never came up')
}

let ws, nextId = 1
const pending = new Map()

function send (method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function connect (url) {
  ws = new WebSocket(url)
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error || msg.type === 'error') slot.reject(new Error(JSON.stringify(msg.error ?? msg)))
    else slot.resolve(msg.result)
  })
}

// Evaluate in the page and return the deserialised primitive.
async function evaluate (ctx, expression) {
  const r = await send('script.evaluate', {
    expression, target: { context: ctx }, awaitPromise: true, resultOwnership: 'none',
  })
  if (r.type === 'exception') throw new Error(r.exceptionDetails?.text || 'page threw')
  return r.result?.value
}

// Poll the page until `expression` is truthy. A fixed sleep would either be flaky or slow.
async function waitFor (ctx, expression, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(ctx, expression)) return
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function shoot (ctx, name) {
  const r = await send('browsingContext.captureScreenshot', { context: ctx })
  const path = join(OUTDIR, `${name}.png`)
  writeFileSync(path, Buffer.from(r.data, 'base64'))
  console.log(`  wrote ${path}`)
}

// The views worth showing, in the order a visitor should meet them. Label first (matched
// against the visible text), output name second.
const SHOTS = JSON.parse(process.env.SHOT_PLAN || '[]')

try {
  await connect(await waitForAgent())
  await send('session.new', { capabilities: {} })

  const { contexts } = await send('browsingContext.getTree', {})
  const ctx = contexts[0].context
  await send('browsingContext.setViewport', { context: ctx, viewport: VIEWPORT, devicePixelRatio: DPR })

  console.log(`navigating to ${BASE}`)
  await send('browsingContext.navigate', { context: ctx, url: BASE, wait: 'complete' })

  // The placeholder is literally the string below, so waiting for its absence is the
  // honest check that real host data arrived - not a guess at a settle time.
  // Log in first if this host has a password. The login page is a single input plus a
  // button (host/ui/login.js), and it REPLACES the dashboard, so this has to happen
  // before any wait for dashboard content.
  const onLogin = await evaluate(ctx, '!!document.querySelector("input[type=password]") && !document.querySelector(".prow")')
  if (onLogin) {
    if (!PASSWORD) throw new Error('the host asked for a password - set SHOT_PW')
    await evaluate(ctx, `
      (() => {
        const input = document.querySelector('input[type=password]')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(PASSWORD)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('button').click()
        return true
      })()
    `)
    await sleep(1200)
  }

  await waitFor(ctx, '!document.body.innerText.includes("Connecting to the host")', 'host data')
  await sleep(600) // let art and avatars paint

  // Buttons and tabs are plain elements; find one by its visible label rather than a
  // brittle selector, so a restyle does not silently produce blank screenshots.
  const clickText = (label) => evaluate(ctx, `
    (() => {
      const want = ${JSON.stringify(label.toLowerCase())}
      // Text OR aria-label: this dashboard's People and Settings controls are
      // icon-only buttons, so matching on textContent alone silently finds nothing
      // and produces a gallery of three identical library shots.
      const label = (n) => (n.textContent.trim() || n.getAttribute('aria-label') || '').toLowerCase()
      const el = [...document.querySelectorAll('button,a,[role="tab"]')]
        .find(n => label(n).startsWith(want))
      if (!el) return false
      el.click()
      return true
    })()
  `)

  // A host with no source and no devices opens on the first-run wizard, not the
  // dashboard. That is the operator's genuine first screen, so shoot it, then skip
  // past it to reach everything else.
  const onWizard = await evaluate(ctx, 'document.body.innerText.includes("Skip setup")')
  if (onWizard) {
    await shoot(ctx, 'dashboard-first-run')
    if (await clickText('skip setup')) await sleep(900)
  }

  // WHAT THE UMBREL LISTING IS ACTUALLY ADVERTISING is the dashboard, not the phone
  // app - somebody browsing the store is deciding whether to run this on their box.
  // PearTune's gallery images are its dashboard for the same reason, and these are
  // shot to match: same 16:10 at 2x, same order of ideas.
  //
  // DISCOVERY FIRST. The tab labels are read off the live page rather than hardcoded,
  // so a renamed tab produces a visible skip in the log instead of three screenshots
  // of the same view.
  const tabs = await evaluate(ctx, `
    JSON.stringify([...document.querySelectorAll('button,a,[role="tab"]')]
      .map(n => (n.textContent.trim() || n.getAttribute('aria-label') || n.getAttribute('title') || '')
        + (n.className ? ' {' + n.className + '}' : ''))
      .filter(t => t.trim() && t.length < 60))
  `)
  console.log('  clickable labels: ' + tabs)

  // A one-off DOM probe, so working out what to click does not mean editing this
  // file and re-running a five-minute capture each time.
  if (process.env.SHOT_PROBE) {
    for (const [label] of SHOTS) await clickText(label).then(() => sleep(900))
    console.log('  probe: ' + await evaluate(ctx, process.env.SHOT_PROBE))
  }

  if (process.env.SHOT_LIST_ONLY) {
    console.log('  SHOT_LIST_ONLY set - stopping before capture')
  } else {
    // 1. The library itself, which is the thing the app is for.
    await shoot(ctx, 'gallery-pearcinema-1')

    for (const [label, name, prep] of SHOTS) {
      if (await clickText(label)) {
        await sleep(1100)
        // Optional third element: JS run in the page before the shutter. The People
        // view needs it - collapsed rows hide the devices, which is most of what the
        // view is for, and a shot of two folded rows sells nothing.
        if (prep) {
          await evaluate(ctx, prep)
          await sleep(900)
        }
        await shoot(ctx, name)
      } else {
        console.log(`  no "${label}" control found - skipped`)
      }
    }
  }
} finally {
  try { ws?.close() } catch {}
  firefox.kill()
}
