#!/usr/bin/env bash
#
# Copy this repo's `umbrel/` listing into the PeerLoom community app store.
#
# WHY A SCRIPT RATHER THAN THREE `cp`s. PearTune hand-synced its listing for months and
# the two copies drifted: a store entry with an abandoned work-in-progress version in it,
# and a release whose store `version:` went BACKWARDS so umbrelOS offered a "update" that
# was a downgrade. The rule that came out of that is `umbrel/` is the source of truth and
# the store copy is overwritten WHOLESALE, never edited in place. This is that rule, run
# rather than remembered.
#
#   ./scripts/sync-umbrel-store.sh                    # copy, then show what changed
#   STORE=/path/to/store ./scripts/sync-umbrel-store.sh
#
# It does NOT commit. The store repo is published, so what lands there is a person's call
# and goes through its own PR.
#
# THE CHECK THAT EARNS ITS PLACE: it refuses to sync a compose whose image is not pinned
# by digest. A floating tag means an install cannot be reproduced and a bad release cannot
# be rolled back by re-pinning the previous one, which is the whole rollback plan.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE="$(cd "$REPO/.." && pwd)"
STORE="${STORE:-$SUITE/peerloom-umbrel-app-store}"

SRC="$REPO/umbrel"
# The directory name MUST equal the `id:` in umbrel-app.yml or umbrelOS ignores the entry.
APP_ID="$(sed -n 's/^id:[[:space:]]*//p' "$SRC/umbrel-app.yml" | head -1)"
DEST="$STORE/$APP_ID"

if [ -z "$APP_ID" ]; then
  echo "no id: in $SRC/umbrel-app.yml - cannot tell which store directory this is" >&2
  exit 1
fi

if [ ! -d "$STORE" ]; then
  echo "no app store checkout at $STORE" >&2
  echo "clone git@github.com:peerloomllc/peerloom-umbrel-app-store.git there, or set STORE=" >&2
  exit 1
fi

IMAGE_LINE="$(grep -E '^\s*image:' "$SRC/docker-compose.yml" | head -1)"
if ! printf '%s' "$IMAGE_LINE" | grep -q '@sha256:'; then
  echo "the image is not pinned by digest, so this listing is not releasable:" >&2
  echo "  $IMAGE_LINE" >&2
  echo >&2
  echo "push the image and pin what it prints:" >&2
  echo "  ./host/build-image.sh <version> --push" >&2
  exit 1
fi

VERSION="$(sed -n 's/^version:[[:space:]]*//p' "$SRC/umbrel-app.yml" | head -1 | tr -d '"')"
# A LISTING VERSION THAT GOES BACKWARDS IS AN UPDATE THAT IS A DOWNGRADE, and umbrelOS
# offers it cheerfully. PearTune shipped exactly that (DONE 2026-08-17). Compare against
# whatever is already published rather than trusting the number to have been bumped.
if [ -f "$DEST/umbrel-app.yml" ]; then
  OLD="$(sed -n 's/^version:[[:space:]]*//p' "$DEST/umbrel-app.yml" | head -1 | tr -d '"')"
  NEWEST="$(printf '%s\n%s\n' "$OLD" "$VERSION" | sort -V | tail -1)"
  if [ "$OLD" != "$VERSION" ] && [ "$NEWEST" != "$VERSION" ]; then
    echo "version $VERSION is OLDER than the published $OLD - umbrelOS would offer a downgrade as an update" >&2
    exit 1
  fi
fi

mkdir -p "$DEST"
for f in umbrel-app.yml docker-compose.yml icon.svg; do
  cp "$SRC/$f" "$DEST/$f"
done

echo "synced $APP_ID $VERSION into $DEST"
echo "  $IMAGE_LINE"
echo
git -C "$STORE" status --short -- "$APP_ID" || true
echo
echo "nothing is committed. Open a PR on the store repo when this is right."
