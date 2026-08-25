#!/usr/bin/env bash
#
# Move a hand-run PearCinema on an Umbrel over to the app installed from the store,
# WITHOUT anybody having to pair again.
#
# WHY THIS EXISTS. `redeploy-umbrel.sh` starts a container by hand, and nothing about
# umbrelOS knows to keep it. On 2026-08-19 the box's whole Docker stack restarted, the
# container was GONE rather than stopped despite `--restart unless-stopped`, and the
# library was off the air until somebody noticed. An app the platform installed is an
# app the platform brings back, which is the actual fix rather than a host that copes
# well with being knocked over.
#
# WHAT MUST SURVIVE, and it is all in one directory: the identity seed (lose it and every
# device must pair again), the grant store (who is allowed in) and the folder scan cache
# (re-probing a 3 TB drive with ffprobe is several minutes of USB disk).
#
# Run it ON THE UMBREL, after installing PearCinema from the PeerLoom community store:
#
#   sudo bash host/migrate-to-umbrel-app.sh
#   DRY_RUN=1 sudo bash host/migrate-to-umbrel-app.sh   # say what it would do
#
# THE ONE THING IT CANNOT DO FOR YOU is re-point the library folder, and the reason is
# worth knowing rather than surprising. The hand-run container mounted whichever external
# drive held the films straight onto `/library`. The store app cannot: a listing has no
# way to know a drive is called "Elements", so it mounts every external drive under
# `/external` and keeps `/library` for the Umbrel's own Downloads folder. So after this
# runs, open Settings and pick the library folder again under /external.
#
# THAT IS SAFE, and it is safe by design rather than by luck: a film's id is minted from
# its path RELATIVE to the library root, precisely so it survives a remount. Re-rooting
# from /library to /external/<drive>/Video mints exactly the same ids, so every resume
# position, every favourite and every watched tick is still attached to the same film.

set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
OLD_DATA="${OLD_DATA:-/home/umbrel/pearcinema-data}"
OLD_CONTAINER="${OLD_CONTAINER:-pearcinema-host}"
APP_ID="${APP_ID:-peerloom-pearcinema}"
NEW_DATA="${NEW_DATA:-/home/umbrel/umbrel/app-data/$APP_ID/data}"
APP_CLI="${APP_CLI:-/home/umbrel/umbrel/scripts/app}"

say () { echo "== $*"; }
run () {
  if [ "$DRY_RUN" = "1" ]; then echo "   would: $*"; else "$@"; fi
}

if [ "$(id -u)" != "0" ] && [ "$DRY_RUN" != "1" ]; then
  echo "run this with sudo - it stops containers and copies a root-owned data directory" >&2
  exit 1
fi

if [ ! -d "$OLD_DATA" ]; then
  echo "nothing to migrate: no hand-run data directory at $OLD_DATA" >&2
  echo "if this box never ran PearCinema by hand, just install the app and pair." >&2
  exit 1
fi

if [ ! -f "$OLD_DATA/.pearcinema.seed" ] && ! ls "$OLD_DATA"/*.seed >/dev/null 2>&1; then
  say "WARNING: no identity seed found in $OLD_DATA"
  say "         copying anyway, but devices may need to pair again"
fi

# THE APP MUST EXIST FIRST. Copying into a directory umbrelOS has not created yet gets
# the ownership wrong and the app then cannot write its own store - which presents as a
# host that starts, serves the page and forgets every pairing on restart.
if [ ! -d "$(dirname "$NEW_DATA")" ]; then
  echo "no app data directory at $(dirname "$NEW_DATA")" >&2
  echo "install PearCinema from the PeerLoom community app store FIRST, then run this." >&2
  exit 1
fi

# `umbreld client`, NOT `~/umbrel/scripts/app`, and not `umbrel` either. There is no
# `umbrel` binary on umbrelOS; the script in the umbrel tree LOOKS right and then refuses
# with "This script requires docker-compose to be installed", because the box ships the
# modern `docker compose` plugin and that script wants the retired v1 binary. The daemon's
# own RPC is the live path and needs no sudo. All three tried on the real box 2026-08-24.
say "stopping the app so nothing is written underneath the move"
run umbreld client apps.stop.mutate --appId "$APP_ID" \
  || run "$APP_CLI" stop "$APP_ID" \
  || run docker stop "${APP_ID}_app_1" \
  || true

say "stopping the hand-run container"
if docker inspect "$OLD_CONTAINER" >/dev/null 2>&1; then
  run docker stop "$OLD_CONTAINER"
else
  say "  (none running - it may already have been taken by a stack restart)"
fi

# IT MUST BE A MOVE, NOT A COPY, and this script got it wrong the first time it was run
# for real (2026-08-24). Copying looked safer - the old directory is the only copy of the
# identity seed on this machine - but the store REFUSES TO OPEN a copy, by design:
# `device-file` records its own inode number and rocksdb-native verifies it on open, so
# a `cp -a` lands with a new inode and every start dies with
#
#   host failed to start: Error: Invalid device file, was modified
#       at verifyDeviceFile (device-file/index.js:193)
#       at CorestoreStorage._migrateStore (hypercore-storage/index.js:652)
#
# in a crash loop, with the library off the air. That check is not an obstacle to work
# around: two copies of one store on a machine would corrupt each other, and refusing is
# the right answer. A move on the same filesystem keeps the inode, so it opens.
#
# THE SAFETY IS A TAR, TAKEN FIRST. It is a real backup of the seed and the grants, and
# restoring it needs this same knowledge - untar, then MOVE the result into place.
STAMP="$(date +%Y%m%d-%H%M%S)"
if [ -d "$NEW_DATA" ] && [ -n "$(ls -A "$NEW_DATA" 2>/dev/null)" ]; then
  say "the app already has data - keeping it as data.replaced-$STAMP"
  run mv "$NEW_DATA" "$NEW_DATA.replaced-$STAMP"
fi

BACKUP="$OLD_DATA.backup-$STAMP.tar"
say "backing the old data up to $BACKUP before moving it"
run tar -cf "$BACKUP" -C "$(dirname "$OLD_DATA")" "$(basename "$OLD_DATA")"

say "MOVING $OLD_DATA -> $NEW_DATA (a move, so the store's inodes survive)"
run rmdir "$NEW_DATA" 2>/dev/null || true
run mv "$OLD_DATA" "$NEW_DATA"

# OWNERSHIP IS DELIBERATELY LEFT ALONE. The container has no `user:` and the image sets
# no USER, so the host runs as root and wrote these files as root under the hand-run
# container too - there is nothing to fix. A `chown -R` was here on the first attempt on
# the reasoning that app-data should match umbrelOS's own ownership; it touches every
# file in a store whose integrity check is watching its own metadata, for no gain.

say "removing the hand-run container so it cannot come back and fight for port 8751"
if docker inspect "$OLD_CONTAINER" >/dev/null 2>&1; then
  run docker rm "$OLD_CONTAINER"
fi

say "starting the app"
run umbreld client apps.start.mutate --appId "$APP_ID" || run "$APP_CLI" start "$APP_ID"

echo
say "the old data is now IN the app; the tar at $BACKUP is the way back"
say "NOW OPEN THE DASHBOARD and pick the library folder again, under /external"
say "  every resume position and favourite survives: ids are relative to the root"
