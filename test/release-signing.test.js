'use strict'

// A RELEASE APK MUST NOT BE SIGNED WITH THE ANDROID DEBUG KEY, and until 2026-08-27 every
// one this repo could build was.
//
// The Expo template points buildTypes.release at signingConfigs.debug. Without a plugin
// to change that, `./gradlew assembleRelease` produces a debug-signed "release" APK which
// builds, installs and runs perfectly - and publishing it once binds the app's identity
// on Play and Zapstore to a throwaway key, permanently. PearTune carries
// plugins/with-android-release-signing.js for exactly this; PearCinema was missing it,
// and nothing said so because nothing had ever looked at a release APK's signature.
//
// WHAT FOUND IT: filling in scripts/.env, generating the pearcinema key in the suite
// keystore, building a release APK and asking apksigner what signed it. CN=Android Debug.
//
// android/ is generated and gitignored here, unlike the donor's, so there is no committed
// build.gradle to hold the plugin against. What can be checked without a prebuild is that
// the plugin exists, that app.json registers it, and that its transform actually rewrites
// the template's shape - which is the part that silently stops working when Expo changes
// its template. When a generated tree IS present, it is checked too.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const plugin = require('../plugins/with-android-release-signing')

test('app.json registers the release-signing plugin', () => {
  const plugins = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo.plugins
  assert.ok(plugins.includes('./plugins/with-android-release-signing'),
    'app.json expo.plugins is missing ./plugins/with-android-release-signing - every release APK will be debug-signed')
})

test('the signingConfig it injects reads all four credentials from the environment', () => {
  const cfg = plugin.RELEASE_SIGNING_CONFIG
  for (const key of ['KEYSTORE_FILE', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD']) {
    assert.match(cfg, new RegExp(`System\\.getenv\\("${key}"\\)`),
      `the release signingConfig does not read ${key} from the environment`)
  }
  // scripts/release.sh exports exactly these four names around its gradle call. If either
  // side is renamed the build silently falls back to the debug keystore.
  const release = fs.readFileSync(path.join(ROOT, 'scripts', 'release.sh'), 'utf8')
  assert.match(release, /export KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD KEY_PASSWORD/,
    'release.sh no longer exports the four names the signingConfig looks for')
})

// A SAMPLE OF THE TEMPLATE, not the whole file: what matters is the two anchors the
// plugin matches on. If Expo changes either, this fails here rather than in a release.
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            shrinkResources (findProperty('android.enableShrinkResourcesInReleaseBuilds')?.toBoolean() ?: false)
        }
    }
}
`

const apply = plugin.applyReleaseSigning

test('THE TRANSFORM ACTUALLY REWRITES THE TEMPLATE, both halves of it', () => {
  const out = apply(TEMPLATE)

  assert.ok(out.includes(plugin.RELEASE_SIGNING_CONFIG_SENTINEL),
    'the release signingConfig was not injected - the debug-block anchor no longer matches Expo\'s template')
  assert.match(out, /signingConfig signingConfigs\.release\.storeFile \? signingConfigs\.release : signingConfigs\.debug/,
    'buildTypes.release still points at the debug signingConfig - the "Caution!" anchor no longer matches')

  // AND THE DEBUG BUILD TYPE IS LEFT ALONE. Both build types say the same words in the
  // template, so a rewrite that is not anchored on the release one hits the wrong block.
  assert.match(out, /debug \{\n {12}signingConfig signingConfigs\.debug\n/,
    'the debug buildType was rewritten too')
})

test('it is idempotent, because prebuild runs it against an already-generated tree', () => {
  const once = apply(TEMPLATE)
  const twice = apply(once)
  assert.equal(twice, once, 'a second prebuild changed the file again')
})

test('a generated tree, if there is one, carries what the plugin puts there', () => {
  // android/ is gitignored, so this is a no-op on a fresh clone and a real check on a
  // machine that has prebuilt - which is every machine that could publish.
  const gradle = path.join(ROOT, 'android', 'app', 'build.gradle')
  if (!fs.existsSync(gradle)) return
  const src = fs.readFileSync(gradle, 'utf8')
  assert.ok(src.includes(plugin.RELEASE_SIGNING_CONFIG_SENTINEL),
    'android/app/build.gradle has no env-reading release signingConfig - run: npx expo prebuild -p android')
  assert.match(src, /signingConfig signingConfigs\.release\.storeFile \? /,
    'android/app/build.gradle still signs release with the debug key - run: npx expo prebuild -p android')
})
