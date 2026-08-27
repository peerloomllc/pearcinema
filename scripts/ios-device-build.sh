#!/usr/bin/env bash
# Build a SIGNED PearCinema for the physical iPhone and install it over USB.
#
# Run from the repo root on the dev box (passwordless ssh to the Mac):
#   bash scripts/ios-device-build.sh                # sync, build, install
#   SKIP_SYNC=1 bash scripts/ios-device-build.sh    # reuse the tree already on the Mac
#   SKIP_INSTALL=1 bash scripts/ios-device-build.sh # reuse node_modules on the Mac
#
# THE SIMULATOR COMES FIRST (scripts/ios-sim-build.sh, company rule 7). This script is
# for the things a Simulator answers vacuously or not at all:
#
#   - iOS Local Network permission and Bonjour, and anything gated on them. A Simulator
#     inherits the Mac's network stack and never shows the prompt, so it passes without
#     proving anything.
#   - Genuine multi-peer over the LAN. A Simulator is not a separate host, so it is not
#     a second peer for holepunching purposes.
#   - Background execution and worklet lifetime, push, camera.
#
# The signing half is peartune/scripts/ios-device-build.sh's, which paid for it. The
# build half is shared in spirit with ios-sim-build.sh, deliberately not factored into a
# common file: the two differ in destination, configuration and signing, which is most
# of what either of them says.
set -euo pipefail

MAC="${MAC:-Tims-Mac-mini.local}"
SUITE="${SUITE:-peerloomllc}"
DEST="$SUITE/pearcinema"
TEAM="${TEAM:-G79ALD29NA}"          # Apple Distribution: Timothy Hudgins
CONFIG="${CONFIG:-Release}"
SCHEME="${SCHEME:-PearCinema}"
BUNDLE_ID="${BUNDLE_ID:-com.pearcinema}"

# Node is a HOMEBREW install and a non-interactive ssh shell does not get it on PATH,
# so every remote command that touches npm has to prepend this. LANG matters too:
# CocoaPods dies with "Unicode Normalization not appropriate for ASCII-8BIT" when the
# ssh session has no UTF-8 locale, which is the default over ssh.
REMOTE_ENV='export PATH=/opt/homebrew/bin:$PATH LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8;'
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"

say () { printf '\n== %s ==\n' "$1"; }
mac () { ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV $*"; }

# THE DEMO FILMS ARE NOT IN THE REPO, AND THE iOS BUNDLE REQUIRES THEM BY NAME.
# shell/demo-assets.ios.ts requires each one statically, so a missing file is an
# "Unable to resolve module" from Metro halfway through a build that has already
# spent several minutes. Checked here instead, where the fix is one line.
missing=0
while IFS= read -r f; do
  [ -f "$REPO_ROOT/assets/demo-library/$f" ] || { echo "  missing: $f" >&2; missing=1; }
done < <(python3 -c "
import json
m = json.load(open('$REPO_ROOT/assets/demo-library/manifest.json'))
for f in m['films']:
    print(f['file']);  print(f['poster'])
for s in m['shows']:
    print(s['poster'])
    for e in s['episodes']: print(e['file'])
")
[ "$missing" = 0 ] || { echo "the demo library is not built - run: bash scripts/fetch-demo-films.sh" >&2; exit 1; }

# THE ONE THAT COSTS AN AFTERNOON, inherited whole from PearTune rather than rediscovered.
#
# codesign over ssh dies with `errSecInternalComponent` at the embed-frameworks phase -
# AFTER all of arm64 has compiled, ~10 minutes in - unless the keychain holding the
# private key is unlocked AND that key's ACL grants codesign non-interactive use.
#
# It is NOT the login keychain. This Mac has a dedicated `buildkey.keychain-db` that comes
# FIRST in the search list, and that is the one codesign resolves the identity from, so
# unlocking login.keychain-db changes nothing and fails identically every time.
#
# It has an EMPTY password by convention, shared with peartune / pearguard / pearcal /
# pearcircle. No secret is needed and nothing here should ever ask Tim for one.
#
# AND the unlock must run in THE SAME ssh invocation as xcodebuild: unlocking is
# session-scoped, so doing it by hand in another terminal does nothing for this script.
KEYCHAIN="${KEYCHAIN:-~/Library/Keychains/buildkey.keychain-db}"
UNLOCK="security unlock-keychain -p '' $KEYCHAIN; security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k '' $KEYCHAIN >/dev/null 2>&1 || true;"

say "checking codesign can actually USE the signing key over ssh"
# The only honest test is to SIGN something. `security show-keychain-info` reports "User
# interaction is not allowed" over ssh whether or not the key is reachable, and
# `find-identity` lists certificates, which is public data - both say "fine" right up
# until the build dies.
if ! ssh -o BatchMode=yes "$MAC" "$UNLOCK T=\$(mktemp -d); cp /bin/echo \"\$T/probe\"; codesign -f -s 'Apple Development: Timothy Hudgins' \"\$T/probe\" >/dev/null 2>&1; rc=\$?; rm -rf \"\$T\"; exit \$rc"; then
  cat >&2 <<EOF
codesign still cannot use the signing key, so this build would fail at the
embed-frameworks phase after all of arm64 has compiled. Check, in this order:

  1. Does $KEYCHAIN exist, and is the identity in it?
       security find-identity -v -p codesigning $KEYCHAIN
  2. Is it still first in the search list? codesign uses the FIRST match.
       security list-keychains
  3. Has its password stopped being empty? If so, pass KEYCHAIN= or fix the convention
     the sibling apps' scripts share.
EOF
  exit 1
fi

if [ -z "${SKIP_SYNC:-}" ]; then
  say "syncing the app and its two sibling packages to $MAC:~/$SUITE/"
  # @peerloom/client and @peerloom/host are `file:../` dependencies, so the Mac needs the
  # same three-directories-side-by-side shape this box has or npm install resolves nothing.
  for dir in pearcinema peerloom-client peerloom-host; do
    [ -d "$SUITE_ROOT/$dir" ] || { echo "missing $SUITE_ROOT/$dir" >&2; exit 1; }
    rsync -az --delete \
      --exclude '.git' --exclude 'node_modules' --exclude 'android' \
      --exclude 'ios/build' --exclude 'ios/Pods' --exclude 'desktop/dist' \
      --exclude 'desktop/node_modules' --exclude 'host/node_modules' \
      "$SUITE_ROOT/$dir/" "$MAC:$SUITE/$dir/"
    echo "  $dir"
  done
fi

[ -n "${SKIP_INSTALL:-}" ] || { say "npm install on the Mac"; mac "cd ~/$DEST && npm install --no-audit --no-fund"; }

say "prebuild: generating ios/ from app.json"
mac "cd ~/$DEST && npx expo prebuild -p ios --no-install"

# build:bare MUST run on macOS. `bare-pack --linked` bakes the host addon suffix into the
# bundle (.so on Linux, .dylib on macOS/iOS), so the committed bundle built on the dev box
# is Android-flavoured and an iOS build using it would not resolve its addons - which
# presents as ADDON_NOT_FOUND at launch, not as a build error.
say "building the UI and the macOS-flavoured bare bundle ON the Mac"
mac "cd ~/$DEST && npm run build:ui && npm run build:bare"

say "pod install"
mac "cd ~/$DEST/ios && pod install"

# Automatic signing + -allowProvisioningUpdates lets Xcode mint the App ID and profile for
# com.pearcinema on demand, so there is no profile to check in or keep fresh.
# NOTE the $UNLOCK prefix: it must run in THIS ssh invocation. See the long comment above.
say "xcodebuild ($CONFIG, device arm64) - this takes a while"
ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV $UNLOCK cd ~/$DEST/ios && xcodebuild -workspace $SCHEME.xcworkspace -scheme $SCHEME -configuration $CONFIG -destination 'generic/platform=iOS' -derivedDataPath build/dd -allowProvisioningUpdates DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Automatic" \
  > /tmp/pearcinema-ios-device.log 2>&1 || {
    echo "BUILD FAILED. Errors:" >&2
    grep -oE "error: .{0,160}" /tmp/pearcinema-ios-device.log | sort -u | head -12 >&2
    echo "(full log: /tmp/pearcinema-ios-device.log)" >&2
    exit 1
  }
echo "build ok"

# devicectl, not ideviceinstaller: libimobiledevice is not installed on this Mac and
# devicectl ships with Xcode. The device has to be paired and unlocked.
say "installing to the iPhone"
# Match the UUID by SHAPE, not by column position: the table is space-aligned with no
# delimiter, so a column index depends on how many words the device name happens to be.
UDID=$(mac "xcrun devicectl list devices 2>/dev/null | grep -i iPhone | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' | head -1")
[ -n "$UDID" ] || { echo "no iPhone found by devicectl - is it plugged in, unlocked and trusted?" >&2; exit 1; }
mac "xcrun devicectl device install app --device $UDID ~/$DEST/ios/build/dd/Build/Products/$CONFIG-iphoneos/$SCHEME.app"

say "done - PearCinema is on the iPhone"
printf 'Launch it from the home screen. To watch its console:\n'
printf '  ssh %s "xcrun devicectl device process launch --device %s --console %s"\n' "$MAC" "$UDID" "$BUNDLE_ID"
