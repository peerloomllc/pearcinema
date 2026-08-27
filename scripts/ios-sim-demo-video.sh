#!/usr/bin/env bash
# Build PearCinema for the iPhone Simulator, drive the demo path with XCUITest, and record
# it. This is the PHONE half of the App Review video (proposal 2026-08-26-app-review-demo);
# the dashboard half is screen-recorded by a person, because a real pairing needs a real
# operator on the other end.
#
# Run from the repo root on the dev box:
#
#   bash scripts/ios-sim-demo-video.sh                 # sync, build, record
#   SKIP_BUILD=1 bash scripts/ios-sim-demo-video.sh    # reuse the .app already on the Mac
#   bash scripts/ios-sim-demo-video.sh --probe         # don't film: print where things are
#
# WHY IT IS A SCRIPT AND NOT A TAKE. The flow is re-shootable in one command, so a UI
# change costs a re-run rather than an afternoon. PearTune's equivalent paid for itself
# the first time its onboarding moved.
#
# WHAT IT NEEDS: the demo films (bash scripts/fetch-demo-films.sh) and the Mac, same as
# every other iOS script here.
set -euo pipefail

MAC="${MAC:-Tims-Mac-mini.local}"
SUITE="${SUITE:-peerloomllc}"
DEST="$SUITE/pearcinema"
DRIVER="${DRIVER:-pearcinema-uitest}"
SIM_NAME="${SIM_NAME:-PearCinema-Test}"
BUNDLE_ID="${BUNDLE_ID:-com.pearcinema}"
SCHEME="${SCHEME:-PearCinema}"
OUT="${OUT:-pearcinema-demo-ios.mp4}"

# The Bare worklet boots against a blank screen before the WebView paints. Trimmed off the
# front rather than filmed - it is not the app being slow, it is a cold launch nobody needs
# to watch.
TRIM="${TRIM:-17}"

REMOTE_ENV='export PATH=/opt/homebrew/bin:$PATH LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8;'
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE_ROOT="$(cd "$REPO_ROOT/.." && pwd)"
# THE SAME derivedDataPath ios-sim-build.sh USES (build/dd), so SKIP_BUILD can reuse an
# app that script already produced. A second path was a second build for no reason, and
# the first run of this script failed on exactly that.
APP="~/$DEST/ios/build/dd/Build/Products/Release-iphonesimulator/$SCHEME.app"

TEST_CASE="DemoFlow/testRecordDemoFlow"
PROBE=""
[ "${1:-}" = "--probe" ] && { PROBE=1; TEST_CASE="PlaybackProbe/testProbePlayer"; }

say () { printf '\n== %s ==\n' "$1"; }
mac () { ssh -o BatchMode=yes "$MAC" "$REMOTE_ENV $*"; }

# The films are required by name in the iOS bundle, so a missing one is a Metro resolve
# error several minutes into a build. Same pre-flight the other two iOS scripts carry.
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

if [ -z "${SKIP_BUILD:-}" ]; then
  say "syncing the app and its two sibling packages to $MAC"
  for dir in pearcinema peerloom-client peerloom-host; do
    [ -d "$SUITE_ROOT/$dir" ] || { echo "missing $SUITE_ROOT/$dir" >&2; exit 1; }
    rsync -az --delete \
      --exclude '.git' --exclude 'node_modules' --exclude 'android' \
      --exclude 'ios/build' --exclude 'ios/Pods' --exclude 'desktop/dist' \
      --exclude 'desktop/node_modules' --exclude 'host/node_modules' \
      "$SUITE_ROOT/$dir/" "$MAC:$SUITE/$dir/"
  done

  # THE ONE THAT COSTS A BUILD. The rsync above just overwrote the Mac's bare bundle with
  # the LINUX one, and `bare-pack --linked` bakes the host addon suffix into it (.so on
  # Linux, .dylib on macOS/iOS). Skipping this rebuild gets a crash-at-launch inside
  # require.addon that looks nothing like its cause.
  say "rebuilding the UI and the macOS-flavoured bare bundle on the Mac"
  mac "cd ~/$DEST && npm install --no-audit --no-fund >/dev/null && npx expo prebuild -p ios --no-install >/dev/null && npm run build:ui && npm run build:bare"
  mac "cd ~/$DEST/ios && pod install" | tail -2

  # RELEASE, not Debug: Release embeds the JS and the demo films in the .app, so nothing
  # depends on a Metro server. Simulator builds are ad-hoc signed, so no identity is needed.
  say "building for the simulator - this takes a while"
  mac "cd ~/$DEST/ios && xcodebuild -workspace $SCHEME.xcworkspace -scheme $SCHEME -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build/dd CODE_SIGNING_ALLOWED=NO" | tail -3
fi

say "syncing the UI driver"
rsync -az "$REPO_ROOT/ios-uitest/" "$MAC:$DRIVER/"

mac "test -d $APP" || { echo "no .app at $APP - drop SKIP_BUILD, or run scripts/ios-sim-build.sh first" >&2; exit 1; }

SIM=$(mac "xcrun simctl list devices | grep '$SIM_NAME (' | grep -oE '[0-9A-F-]{36}' | head -1")
[ -n "$SIM" ] || { echo "no simulator named $SIM_NAME - create one, or set SIM_NAME" >&2; exit 1; }

# A CLEAN INSTALL EVERY TIME. The flow starts at the onboarding wall, so a container that
# is already paired - or already in the demo - films the wrong thing entirely.
# RECORD is either the recorder or nothing, decided HERE rather than inside the remote
# script, because a `&` that arrives by parameter expansion is a literal ampersand and not
# a background operator - so the clever version of this ran the recorder in the foreground
# and filmed nothing at all.
RECORD="xcrun simctl io $SIM recordVideo --codec h264 --force ~/pearcinema-demo-raw.mp4"
[ -n "$PROBE" ] && RECORD="sleep 1"

say "${PROBE:+probing the layout}${PROBE:-recording}"
mac "
  set -e
  rm -f ~/pearcinema-demo-raw.mp4
  xcrun simctl bootstatus $SIM -b >/dev/null 2>&1 || true
  xcrun simctl uninstall $SIM $BUNDLE_ID >/dev/null 2>&1 || true
  xcrun simctl install $SIM $APP
  $RECORD &
  REC=\$!
  sleep 3
  cd ~/$DRIVER
  xcodebuild test -project PearCinemaUIDriver.xcodeproj -scheme PearCinemaUIDriver \
    -destination 'platform=iOS Simulator,id=$SIM' -derivedDataPath build \
    -only-testing:PearCinemaUIDriver/$TEST_CASE > /tmp/pearcinema-flow.log 2>&1 || true
  sleep 3
  kill -INT \$REC 2>/dev/null || true
  wait \$REC 2>/dev/null || true
  grep -qE 'FLOW COMPLETE|PROBE COMPLETE' /tmp/pearcinema-flow.log || {
    echo 'the flow did not finish - see /tmp/pearcinema-flow.log on the Mac'; exit 1; }
"

if [ -n "$PROBE" ]; then
  say "what the driver can see"
  mac "grep -A 200 '=== SUBTITLE PICKER ===' /tmp/pearcinema-flow.log | head -60" || true
  echo
  echo "Full dumps: ssh $MAC 'less /tmp/pearcinema-flow.log'"
  exit 0
fi

say "fetching and trimming"
scp -q "$MAC:pearcinema-demo-raw.mp4" /tmp/pearcinema-demo-raw.mp4
# Half the frame rate: 60fps of a mostly-static UI is bytes nobody watches. Scaled to a
# width that stays legible beside a landscape dashboard in the same canvas, which is the
# edit this feeds.
ffmpeg -v error -ss "$TRIM" -i /tmp/pearcinema-demo-raw.mp4 \
  -vf "scale=606:-2,fps=30" -c:v libx264 -preset slow -crf 22 -pix_fmt yuv420p \
  -movflags +faststart "$OUT" -y
rm -f /tmp/pearcinema-demo-raw.mp4

say "wrote $OUT"
ls -lh "$OUT"
echo
echo "The dashboard half is yours to record - see docs/app-review-video.md for the shot list."
