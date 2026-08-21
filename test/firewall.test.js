// Whether Windows will let this machine be reached.
//
// THE MEASUREMENT THAT MAKES THIS WORTH A SUITE (four-host bench, 2026-08-21). On a
// fresh Windows 11 VM the platform writes two inbound BLOCK rules for pearcinema.exe
// by itself - once with nobody at the console, and again when Tim watched and
// dismissed the prompt. Either way pairing hangs with no message at either end.
// Toggling nothing but the rules, on the same machine:
//
//   Windows' own Blocks            unreachable, pairing timed out at 12 s
//   an Allow beside those Blocks   unreachable, pairing timed out at 11 s
//   Blocks cleared, Allow set      paired in 0 s
//
// So the state this module reports decides whether the app works at all on Windows,
// and the sentence it produces is the only thing standing between a user and silence.
//
// The PowerShell call itself is not exercised here - there is no Windows in CI and a
// mock of `execFile` would only test the mock. What IS exercised is the part that was
// easy to get wrong: how several rules collapse into one answer, and the fact that
// Windows breaks a tie towards Block.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const firewall = require('../desktop/src/main/firewall')

// Off Windows the module must say "no news" rather than "bad news". A Mac or a Linux
// box has no such rule to find, and a warning banner there would be a lie.
test('a machine that is not Windows reports nothing at all', async (t) => {
  if (process.platform === 'win32') return t.skip('this asserts the non-Windows path')
  assert.equal(await firewall.inboundState(), null, 'there is no such rule to find off Windows')
  assert.equal(firewall.warningFor(null), null, 'and an unknown state must never produce a warning')
})

test('an allowed machine says nothing, because there is nothing to say', () => {
  assert.equal(firewall.warningFor('allowed'), null)
})

// The two states that differ in cause but not in consequence: nobody can reach you.
test('both blocked and missing produce a warning, and they read differently', () => {
  const blocked = firewall.warningFor('blocked', 'C:\\PearCinema.exe')
  const missing = firewall.warningFor('missing', 'C:\\PearCinema.exe')

  for (const w of [blocked, missing]) {
    assert.ok(w, 'an unreachable machine must say so')
    assert.equal(w.id, 'windows-firewall')
    assert.equal(w.severity, 'error')
    assert.match(w.title, /cannot be reached/i)
    // The consequence, in the operator's terms, not the firewall's.
    assert.match(w.detail, /pair|play/i, 'the warning must say what it costs, not just what it is')
  }

  assert.match(blocked.detail, /blocking/i, 'a written block is not the same news as no rule at all')
  assert.match(missing.detail, /not been told/i)
})

// A command somebody has to retype by eye is a command they will get wrong, and this
// one is offered at the moment they have already been failed once by silence.
test('the warning carries a runnable one-line fix naming this exact program', () => {
  const exe = 'C:\\Users\\Ben\\AppData\\Local\\Programs\\PearCinema\\PearCinema.exe'
  const w = firewall.warningFor('missing', exe)

  assert.ok(w.fix, 'there must be a fix, not just a diagnosis')
  assert.equal(w.fix.includes('\n'), false, 'the fix must be ONE line - a wrapped command pastes broken')
  assert.match(w.fix, /New-NetFirewallRule/)
  assert.match(w.fix, /-Direction Inbound/)
  assert.match(w.fix, /-Action Allow/)
  assert.ok(w.fix.includes(exe), 'the rule must name the program that is actually installed')
  assert.ok(w.fix.includes(`"${exe}"`), 'the path has spaces in it and must stay quoted')
})

// The installer half. It cannot be run here, but the two things that would silently
// undo it can be pinned: dropping the delete-first step, and dropping the wiring that
// makes electron-builder include the file at all.
test('the installer removes any stale block before adding an allow, and is wired in', async () => {
  const fsp = require('fs/promises')
  const nsh = await fsp.readFile(path.join(__dirname, '..', 'desktop', 'installer', 'windows', 'firewall.nsh'), 'utf8')

  const del = nsh.indexOf('firewall delete rule')
  const add = nsh.indexOf('firewall add rule')
  assert.ok(del > 0 && add > 0, 'the installer must both clear and set the rule')
  assert.ok(del < add, 'the delete must come FIRST - Windows breaks an allow/block tie towards block')

  // AND THE DELETE MUST MATCH ON THE PROGRAM, not on our rule name. Windows names
  // the blocks it writes for itself after the executable, so deleting by name leaves
  // them standing - measured on the bench as one Allow beside two Blocks, which is
  // still unreachable and looks fixed. Every delete here must be `name=all`+`program=`.
  for (const line of nsh.split('\n').filter(l => l.includes('firewall delete rule'))) {
    assert.match(line, /name=all/, 'deleting by our own rule name misses the ones Windows wrote')
    assert.match(line, /program="\$INSTDIR\\PearCinema\.exe"/, 'the delete has to name the program')
  }
  assert.match(nsh, /customInstall/, 'the macro electron-builder actually calls')
  assert.match(nsh, /customUnInstall/, 'a rule left behind for a removed program is a standing permission')

  // AND THE PATH HAS TO RESOLVE, which is the part that already bit once. electron-
  // builder reads `nsis.include` relative to `directories.buildResources` (desktop/build),
  // NOT the project root - and when the file is not there it says nothing at all and
  // builds a perfectly good installer that does none of this. So assert the resolved
  // path is the file above, not merely that some string was configured.
  const pkg = require('../desktop/package.json')
  const desktopDir = path.join(__dirname, '..', 'desktop')
  const buildResources = path.join(desktopDir, pkg.build.directories.buildResources)
  const resolved = path.resolve(buildResources, pkg.build.nsis.include)

  assert.equal(resolved, path.join(desktopDir, 'installer', 'windows', 'firewall.nsh'),
    'nsis.include must resolve to the .nsh that exists')
  await fsp.access(resolved)
})


// THE MATCHING, which is where this module has already been wrong once.
//
// The first cut filtered inside PowerShell against a path passed as
// `-Command <script> -args <path>`. `-Command` does not bind `$args` - it appends
// the words to the command text - so the comparison ran against $null, matched
// nothing, and the module reported "no rule at all" on a machine that was carrying
// two Block rules and was completely unreachable. It looked right in every log.
// Matching happens in JS now, precisely so these cases can be pinned.
const EXE = 'C:\\Users\\Ben\\AppData\\Local\\Programs\\PearCinema\\PearCinema.exe'

test('an enabled block for this program is BLOCKED, even lowercased by Windows', () => {
  // Verbatim from the bench: Windows writes the path it stores in lower case, and
  // Windows paths are case-insensitive, so a case-sensitive compare would miss the
  // one rule that matters most.
  const out = [
    'Block|True|c:\\users\\ben\\appdata\\local\\programs\\pearcinema\\pearcinema.exe',
    'Block|True|c:\\users\\ben\\appdata\\local\\programs\\pearcinema\\pearcinema.exe'
  ].join('\n')
  assert.equal(firewall.classify(out, EXE), 'blocked')
})

test('an allow sitting BESIDE a block is still blocked, because Windows breaks the tie that way', () => {
  const out = [
    'Allow|True|' + EXE,
    'Block|True|c:\\users\\ben\\appdata\\local\\programs\\pearcinema\\pearcinema.exe'
  ].join('\n')
  // Measured on the bench: this exact state left the machine unreachable, pairing
  // timing out at 11 s. Reporting it as 'allowed' would hide a real failure behind
  // a rule that says Allow.
  assert.equal(firewall.classify(out, EXE), 'blocked')
})

test('an enabled allow and nothing else is allowed', () => {
  assert.equal(firewall.classify('Allow|True|' + EXE, EXE), 'allowed')
})

test('rules that are disabled, or for other programs, are not ours', () => {
  assert.equal(firewall.classify('Block|False|' + EXE, EXE), 'missing',
    'a disabled block does not block')
  assert.equal(firewall.classify('Allow|False|' + EXE, EXE), 'missing',
    'a disabled allow does not allow')
  assert.equal(firewall.classify('Block|True|C:\\Other\\App.exe', EXE), 'missing',
    "somebody else's block is not our problem")
})

test('no rules at all is missing, and so is junk', () => {
  assert.equal(firewall.classify('', EXE), 'missing')
  assert.equal(firewall.classify('\n\n  \n', EXE), 'missing')
  assert.equal(firewall.classify('nonsense without delimiters', EXE), 'missing')
})

// A blocked machine cannot be fixed by adding an allow - the block has to go first.
// The warning has to say so, or it sends the operator to do the thing that does not work.
test('the fix for a BLOCKED machine clears the block before adding the allow', () => {
  const w = firewall.warningFor('blocked', EXE)
  const del = w.fix.indexOf('delete rule')
  const add = w.fix.indexOf('New-NetFirewallRule')
  assert.ok(del >= 0, 'a blocked machine needs the block removed, not out-voted')
  assert.ok(del < add, 'and removed FIRST')
  assert.equal(w.fix.includes('\n'), false, 'still one line')

  // The missing case has nothing to delete, and must not tell somebody to delete it.
  assert.equal(firewall.warningFor('missing', EXE).fix.includes('delete rule'), false)
})


// THE QUERY ITSELF, pinned at the source because both ways it has failed produced
// SILENCE rather than an error - a module that says "nothing to report" on a machine
// nobody can reach is worse than one that crashes.
test('the PowerShell query takes its path from the environment and filters cheaply first', async () => {
  const fsp = require('fs/promises')
  const src = await fsp.readFile(path.join(__dirname, '..', 'desktop', 'src', 'main', 'firewall.js'), 'utf8')

  // `-Command <script> -args <value>` does not bind $args; it appends words to the
  // command text. Reading the path from the environment sidesteps that and the
  // quoting of a path with spaces in it.
  assert.match(src, /PEARCINEMA_EXE_LEAF/, 'the path must reach PowerShell through the environment')
  assert.doesNotMatch(src, /\$args\[/, 'never $args - -Command does not populate it')

  // Narrow BEFORE the expensive lookup. Piping every application filter on the
  // machine through Get-NetFirewallRule took over two minutes on the bench and blew
  // the timeout, which reads as "no rules" and therefore as "nothing wrong".
  //
  // Read the SCRIPT constant itself, not the file: the prose above it names these
  // same cmdlets while explaining the mistake, and matching that would pass whatever
  // the query actually does.
  const m = src.match(/const SCRIPT = `([\s\S]*?)`\.trim\(\)/)
  assert.ok(m, 'the query must still be one readable constant')
  const script = m[1]

  const where = script.indexOf('Where-Object')
  const getRule = script.indexOf('Get-NetFirewallRule')
  assert.ok(where > 0 && getRule > 0, 'the query must both narrow and look up')
  assert.ok(where < getRule, 'filter first, then look up rules - the other order times out')
  assert.match(script, /Direction -eq 'Inbound'/, 'only inbound rules decide reachability')
})
