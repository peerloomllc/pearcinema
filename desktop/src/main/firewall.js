// Can Windows actually be reached?
//
// WHY THIS EXISTS. On a fresh Windows 11 box the platform writes two INBOUND BLOCK
// rules for pearcinema.exe by itself - measured twice, 2026-08-21: once when nobody
// was at the console to answer the prompt, and once when Tim was watching and
// dismissed it. Either way pairing then hangs with no message at either end.
// Toggling nothing but the rules, on the same machine:
//
//   Windows' own Block rules     "no answer from the host (unreachable...)"  12 s
//   an Allow beside those Blocks  same failure, still unreachable            11 s
//   Blocks cleared, Allow set     paired                                      0 s
//
// The middle row is the one worth remembering: Windows breaks a tie towards Block,
// so an Allow rule sitting beside a Block is not reachability, it is a rule that
// LOOKS like the job is done.
//
// This module only ever LOOKS. The installer is what asks for the rule (see
// installer/windows/firewall.nsh); an app that quietly rewrote the firewall on
// launch would be worse than one that tells you it cannot be reached.

const { execFile } = require('child_process')
const path = require('path')

// PowerShell costs about a second to start. Fine once, at boot, off the critical
// path - and it is the only interface that lists rules by program without parsing a
// full `netsh show rule name=all` dump.
const TIMEOUT_MS = 30000

// TWO MISTAKES ARE BAKED INTO THE SHAPE OF THIS, both made here first:
//
// 1. The path is passed in the ENVIRONMENT, not as an argument. `powershell
//    -Command <script> -args <path>` does not bind `$args` - it appends the words
//    to the command text - so the first cut compared every rule against $null,
//    matched nothing, and reported "no rule at all" on a machine carrying two
//    Block rules and completely unreachable. It looked healthy in every log.
//
// 2. The cheap filter runs BEFORE the expensive one. Piping every application
//    filter on the machine through Get-NetFirewallRule took over TWO MINUTES on
//    the bench VM, blew the timeout, and produced the same false silence by a
//    different route. Narrowing on the file name first costs 1.4 s, and the rule
//    lookup on what survives costs 1.6 s.
//
// The program is echoed back on every line so the FINAL match is done in JS, where
// it is a pure function with tests - the `-like` here is only a cheap net.
const SCRIPT = `
$leaf = $env:PEARCINEMA_EXE_LEAF
Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
  Where-Object { $_.Program -like "*\\$leaf" } |
  ForEach-Object {
    $p = $_.Program
    $_ | Get-NetFirewallRule | ForEach-Object {
      if ($_.Direction -eq 'Inbound') { "$($_.Action)|$($_.Enabled)|$p" }
    }
  }
`.trim()

function run (exePath) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PEARCINEMA_EXE_LEAF: path.win32.basename(exePath) }
    }, (err, stdout) => resolve(err ? null : String(stdout || '')))
  })
}

// Windows stores the path it was given, and what it writes for itself is LOWERCASED:
// the block rules on the bench read `c:\users\ben\...\pearcinema.exe` against an
// executable at `C:\Users\Ben\...\PearCinema.exe`. Windows paths are case-insensitive,
// so a case-sensitive compare here would miss exactly the rules that matter most.
function samePath (a, b) {
  if (!a || !b) return false
  const norm = (s) => path.win32.normalize(String(s).trim()).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// What the firewall says about us, in the three states that actually differ:
//
//   'allowed'   an enabled inbound Allow rule names this program, and nothing blocks it
//   'blocked'   an enabled inbound Block rule does - the state Windows puts itself in
//               unprompted, and the one that reads as "the app is broken"
//   'missing'   no rule at all. The default inbound action is Block, so this is
//               unreachable too, it just has not been written down yet
//
// Exported for its tests: this is where the interesting mistakes live.
function classify (out, exePath) {
  let allow = false
  let block = false
  for (const line of String(out || '').split('\n')) {
    const parts = line.trim().split('|')
    if (parts.length < 3) continue
    const [action, enabled] = parts
    // The path may legitimately contain a '|'-free but space-full path; everything
    // after the second delimiter is the program.
    const program = parts.slice(2).join('|')
    if (String(enabled) !== 'True') continue
    if (!samePath(program, exePath)) continue
    if (action === 'Allow') allow = true
    if (action === 'Block') block = true
  }
  if (block) return 'blocked'
  if (allow) return 'allowed'
  return 'missing'
}

// `null` means we could not tell (not Windows, or PowerShell would not run), and a
// caller must treat that as "no news", never as bad news.
async function inboundState (exePath = process.execPath) {
  if (process.platform !== 'win32') return null
  const out = await run(exePath)
  if (out === null) return null
  return classify(out, exePath)
}

// The sentence the dashboard shows, and the command that fixes it. One line, so it
// can be copied out of a web page and pasted into an admin PowerShell whole - the
// person reading this has already been failed once by silence.
function warningFor (state, exePath = process.execPath) {
  if (state !== 'blocked' && state !== 'missing') return null
  const verb = state === 'blocked'
    ? 'Windows is blocking PearCinema from accepting connections'
    : 'Windows has not been told to let PearCinema accept connections'
  // A block has to be REMOVED, not out-voted: an allow rule beside it changes
  // nothing, which is the trap this whole module exists because of.
  const clear = state === 'blocked'
    ? `netsh advfirewall firewall delete rule name=all dir=in program="${exePath}"; `
    : ''
  return {
    id: 'windows-firewall',
    severity: 'error',
    title: 'This machine cannot be reached',
    detail: `${verb}, so no phone can pair with it or play from it. Run this in PowerShell as an administrator:`,
    fix: `${clear}New-NetFirewallRule -DisplayName "PearCinema" -Direction Inbound -Action Allow -Program "${exePath}" -Profile Any`
  }
}

module.exports = { inboundState, warningFor, classify, samePath }
