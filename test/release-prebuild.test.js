'use strict'

// THE RELEASE SCRIPT MUST BE ABLE TO GENERATE THE NATIVE TREE IT THEN BUILDS.
//
// `scripts/release.sh` was inherited from PearTune, which COMMITS its android/ tree.
// PearCinema does not - `/android/` is in .gitignore and `expo prebuild` generates it
// from app.json plus plugins/, which is the suite default and what scripts/app.conf
// already says in as many words. The inherited step 2 announced "android/ and ios/ are
// checked in, no prebuild needed" and regenerated only iOS, so step 3's
// `cd android && ./gradlew assembleRelease` had nothing to cd into.
//
// IT NEVER BIT, because a development machine always has a generated android/ lying
// around from ordinary work. A clean clone - or anyone running the release after
// `expo prebuild --clean` - would have got a release that died partway through with
// nothing saying why. Found 2026-08-27 by reading the script before running it for the
// first time, not by running it.
//
// So this file holds the two halves against each other: what git ignores, and what the
// release script is prepared to regenerate. A tree that is not committed and not
// generated is a release that cannot build, and neither file alone can see that.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const release = fs.readFileSync(path.join(ROOT, 'scripts', 'release.sh'), 'utf8')
const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')

// Is this path kept out of git? Matches the anchored form .gitignore actually uses
// (`/android/`) as well as the bare name, because either spelling has the same effect
// and the test should not care which one somebody wrote.
function ignored (name) {
  return gitignore
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === name || l === `/${name}` || l === `${name}/` || l === `/${name}/`)
}

test('A NATIVE TREE THAT GIT IGNORES IS ONE THE RELEASE SCRIPT CAN REGENERATE', () => {
  // The two platforms, and the marker file whose absence means "this tree is not here".
  // Android's is checked directly by the script; iOS's is $XCODE_PROJECT from app.conf.
  const trees = [
    { name: 'android', prebuild: /expo prebuild -p android/ },
    { name: 'ios', prebuild: /expo prebuild -p ios/ }
  ]

  for (const tree of trees) {
    const committed = fs.existsSync(path.join(ROOT, tree.name)) && !ignored(tree.name)
    if (committed) continue
    assert.match(
      release,
      tree.prebuild,
      `${tree.name}/ is not committed, so scripts/release.sh must be able to prebuild it`
    )
  }
})

test('the android prebuild is a RECOVERY, so it cannot throw away a working tree', () => {
  // Guarded on the marker file being absent. An unconditional prebuild would run on
  // every release, and `--clean` would delete a tree that was already correct - which
  // for iOS also means a full CocoaPods install every time.
  assert.match(
    release,
    /\[ ! -f "\$REPO_ROOT\/android\/app\/build\.gradle" \][\s\S]{0,200}expo prebuild -p android/,
    'the android prebuild must be guarded on android/app/build.gradle being absent'
  )
  assert.ok(
    !/expo prebuild -p android --clean|expo prebuild --clean -p android/.test(release),
    'the android prebuild must not use --clean: it would discard a tree that already works'
  )
  // And it must not run at all when the Android build itself was waived, or a
  // --skip-android release spends minutes generating a tree nothing will read.
  assert.match(
    release,
    /if \$SKIP_ANDROID; then[\s\S]{0,200}expo prebuild -p android/,
    '--skip-android must short-circuit the android prebuild'
  )
})

test('the script no longer TELLS the operator the native trees are checked in', () => {
  // Only what the script SAYS while it runs, which is what the operator reads and
  // believes. The comment above step 2 quotes the old sentence to record what was wrong
  // with it, and a test that cannot tell a claim from a note about a claim would fail on
  // its own documentation - which this one did, first time it was run.
  const spoken = release
    .split('\n')
    .filter((line) => /^\s*(echo|printf)\b/.test(line))
    .join('\n')

  assert.ok(
    !/android\/ and ios\/ are checked in/.test(spoken),
    'scripts/release.sh must not tell the operator android/ and ios/ are checked in - neither is'
  )
})
