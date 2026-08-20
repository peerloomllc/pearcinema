#!/usr/bin/env bash
# Deploy the PearCinema host on the Umbrel, against the REAL library.
#
# WHY THIS EXISTS AND WHY IT MATTERS MORE THAN PEARTUNE'S EQUIVALENT. PearCinema can
# be developed against a folder of two files on a laptop, and that tests the
# mechanism perfectly well - but every claim this project makes about compatibility
# comes from a 3 TB drive that is attached to the Umbrel and nowhere else. 83%
# Matroska, 64% HEVC television, 232 PGS subtitle tracks: none of that exists on a
# development machine. Testing remux anywhere else is testing it against a library
# that does not have the problem (Tim, 2026-08-13).
#
# Usage, ON THE UMBREL:
#   bash host/redeploy-umbrel.sh                # build and run
#   WIPE=1 bash host/redeploy-umbrel.sh         # also clear the data dir: pairings,
#                                               # grants AND the saved source. Everything
#                                               # must be re-paired afterwards.
#   SKIP_BUILD=1 bash host/redeploy-umbrel.sh   # reuse the image already built
#
#   PEARCINEMA_HLS_SLICE=1 ...                    # go back to handing a resuming
#                                                 # television a SLICED playlist. The
#                                                 # default gives it the whole film plus
#                                                 # #EXT-X-START, so its own on-screen
#                                                 # clock is the film's - measured as
#                                                 # honoured on the living room Roku,
#                                                 # 2026-08-20. The tag is optional in
#                                                 # the standard, so a receiver that
#                                                 # ignores it needs this.
#
# Non-destructive by default: /home/umbrel/pearcinema-data is reused, so paired
# devices need no re-pair and the scan cache survives - which matters here far more
# than it does for music, because re-probing 2,922 films and episodes with ffprobe is
# several minutes of a USB drive.
set -euo pipefail

WIPE="${WIPE:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
TAG="${TAG:-local}"
IMAGE="pearcinema-host:$TAG"

DATA='/home/umbrel/pearcinema-data'

# THE LIBRARY IS ON THE EXTERNAL DRIVE, and that is the normal case for video rather
# than an unusual one - films are hundreds of gigabytes and an Umbrel's internal disk
# is not where they live.
#
# FOUND, NOT NAMED. This used to default to a literal
# `/home/umbrel/umbrel/external/Elements (3)/Video`, and that `(3)` is not part of the
# drive's name - it is what udisks appends when the mountpoint it wanted was already
# taken. On 2026-08-19 the same drive came back as plain `Elements` after the box's
# stack restarted, and a deploy that knew only the old spelling refused to run against
# a library that was sitting right there.
#
# So look for it: any directory under external/ holding a Video folder with the roots
# in it. An explicit LIBRARY= still wins, for a layout this does not guess.
find_library () {
  local d
  for d in /home/umbrel/umbrel/external/*/Video; do
    [ -d "$d" ] || continue
    if [ -d "$d/Movies" ] || [ -d "$d/TV Shows" ]; then
      printf '%s' "$d"
      return 0
    fi
  done
  # Nothing with the expected roots - fall back to any Video directory at all rather
  # than to a path from last year.
  for d in /home/umbrel/umbrel/external/*/Video; do
    if [ -d "$d" ]; then
      printf '%s' "$d"
      return 0
    fi
  done
  return 1
}

LIBRARY="${LIBRARY:-$(find_library || true)}"

# ONLY sudo IF DOCKER ACTUALLY NEEDS IT. On umbrelOS the `umbrel` user is already in
# the docker group, so a blanket `sudo` turns a working deploy into a password prompt -
# and over a non-interactive ssh that is a hard failure rather than a prompt. Ask
# docker instead of assuming.
SUDO=''
if ! docker ps >/dev/null 2>&1; then
  [ "$(id -u)" -ne 0 ] && SUDO='sudo'
fi

# NO APOSTROPHES IN A ${VAR:-default}. An unbalanced single quote inside a parameter
# default shifts bash's quoting state for the REST OF THE FILE, and the error then
# surfaces forty lines later on an innocent line - which is exactly how this cost a
# deploy. Built here on its own line instead.
LIBRARY_NAME="${PEARCINEMA_NAME:-My Films}"

if [ -z "$LIBRARY" ] || [ ! -d "$LIBRARY" ]; then
  echo "No library found under /home/umbrel/umbrel/external/" >&2
  echo "what this box can see:" >&2
  ls -1 /home/umbrel/umbrel/external/ 2>/dev/null | sed 's/^/  /' >&2
  echo "set LIBRARY=... and re-run" >&2
  exit 1
fi

# A DRIVE THAT IS THERE BUT EMPTY IS NOT A LIBRARY, and starting against one would
# hand the host a source it has to call empty. Bail while the old container is still
# running rather than after replacing it - this check sits above the docker rm below,
# and it must stay above it.
if [ -z "$(ls -A "$LIBRARY" 2>/dev/null)" ]; then
  echo "The library at $LIBRARY is empty. Is the drive mounted?" >&2
  exit 1
fi

echo "== library: $LIBRARY =="
for d in Movies "TV Shows"; do
  if [ -d "$LIBRARY/$d" ]; then
    echo "   $d"
  else
    echo "   $d - NOT PRESENT (the picker in the dashboard will show what is)"
  fi
done

if [ "$SKIP_BUILD" != "1" ]; then
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  echo "== building $IMAGE from $REPO =="
  # build-image.sh stages pearcinema and peerloom-host side by side, because the
  # `file:../peerloom-host` dependency lives outside this repo and therefore outside
  # a normal build context.
  bash "$REPO/host/build-image.sh" "$TAG"
  $SUDO docker tag "ghcr.io/peerloomllc/pearcinema-host:$TAG" "$IMAGE"
fi

echo "== replacing the running pearcinema-host =="
$SUDO docker rm -f pearcinema-host >/dev/null 2>&1 || true

if [ "$WIPE" = "1" ]; then
  echo "== WIPE=1: clearing $DATA (pairings, grants, saved source AND the scan cache) =="
  $SUDO rm -rf "$DATA"
fi
$SUDO mkdir -p "$DATA"

# Did a password file exist BEFORE we started? Asked here, not after, because the
# container creates one within seconds and then the answer is always yes.
HAD_PASSWORD=0
$SUDO test -s "$DATA/dashboard-password" && HAD_PASSWORD=1

# NO PEARCINEMA_PASSWORD BAKED IN. Unset, the host generates a strong one on first
# run, prints it, and saves it 0600 - stable across redeploys, and changeable from
# the dashboard. Baking a placeholder in would make the host report passwordSource
# 'explicit', which makes the dashboard REFUSE to change it, and would silently reset
# it on every deploy. PearTune shipped that bug for a fortnight.
#
# `rslave` ON THE LIBRARY MOUNT IS LOAD-BEARING. Without it a drive plugged in after
# this container starts is invisible inside it, and the failure looks exactly like an
# empty library - which sends an operator hunting through the app instead of at the
# mount.
#
# THE LIBRARY MOUNT IS WRITABLE since sidecar writing shipped (Tim's call,
# 2026-08-15; it was `readonly` before that). The dashboard's explicit
# save-to-library action creates .nfo and poster files beside the films; it only
# ever creates, never overwrites, and nothing else in the host writes there.
#
# network_mode host, and no app_proxy: measured twice on a real Umbrel, holepunching
# does not survive Docker's bridge NAT, and app_proxy is itself a bridged container
# so it cannot front a host-networked service.
# THE VIDEO ENGINE rides along only where the box has one: a --device whose path
# does not exist makes docker refuse to create the container, which would turn a
# GPU-less box into a failed deploy rather than a host without transcode. The probe
# inside decides whether the device actually works.
DRI=""
[ -e /dev/dri ] && DRI="--device /dev/dri:/dev/dri"

# AND AN NVIDIA CARD RIDES ALONG A DIFFERENT WAY. There is no device path to bind:
# NVENC reaches the card through the NVIDIA Container Toolkit, which docker spells
# `--gpus all`. Two things can be missing independently - the driver on the box and the
# toolkit that lets a container see it - so this ASKS rather than assumes: start a
# throwaway container with the flag and keep it only if that worked. A box without the
# toolkit gets a two-second no and a deploy that still succeeds, which is the same
# fail-closed shape as /dev/dri above.
GPUS=""
if [ -e /dev/nvidiactl ]; then
  if $SUDO docker run --rm --gpus all "$IMAGE" true >/dev/null 2>&1; then
    GPUS="--gpus all"
    echo "== NVIDIA card found and reachable from a container =="
  else
    echo "== NVIDIA card found, but containers cannot see it (install the NVIDIA Container Toolkit) =="
  fi
fi

echo "== starting =="
$SUDO docker run -d \
  --name pearcinema-host \
  --restart unless-stopped \
  --network host \
  --security-opt no-new-privileges:true \
  $DRI \
  $GPUS \
  -e PEARCINEMA_HTTP_HOST=0.0.0.0 \
  -e PEARCINEMA_HTTP_PORT=8751 \
  ${PEARCINEMA_PASSWORD:+-e PEARCINEMA_PASSWORD="$PEARCINEMA_PASSWORD"} \
  -e PEARCINEMA_DATA=/data \
  -e PEARCINEMA_NAME="$LIBRARY_NAME" \
  -e "PEARCINEMA_FOLDERS=/library/Movies:/library/TV Shows" \
  ${PEARCINEMA_HLS_SLICE:+-e PEARCINEMA_HLS_SLICE="$PEARCINEMA_HLS_SLICE"} \
  -v "$DATA:/data" \
  --mount "type=bind,source=$LIBRARY,target=/library,bind-propagation=rslave" \
  "$IMAGE"

# A DEPLOY THAT DOES NOT SERVE THE PAGE HAS FAILED, and must say so rather than
# printing a cheerful "open http://..." underneath a stack trace. Checking for our own
# page rather than for any 200: something else on this box answered 8751 with a 404
# while the container was crash-looping, and a status-code-only check called that
# "not 200 yet" and then carried on regardless.
echo "== waiting for it to come up =="
ok=0
for i in $(seq 1 40); do
  if curl -s --max-time 3 http://127.0.0.1:8751/ 2>/dev/null | grep -qi pearcinema; then ok=1; break; fi
  sleep 2
done

if [ "$ok" != "1" ]; then
  echo
  echo "!! THE HOST IS NOT SERVING ITS PAGE. Deploy failed. Its last words: !!" >&2
  $SUDO docker logs --tail 30 pearcinema-host 2>&1 >&2 || true
  exit 1
fi

echo "the page is up"
$SUDO docker logs --tail 12 pearcinema-host 2>&1 || true

echo
echo "== the first scan probes every film with ffprobe and takes several minutes =="
echo "   Watch it:  sudo docker logs -f pearcinema-host"
echo "   It is cached afterwards, so a restart is instant."

# LAST, so it is what is still on screen when this ends.
if [ -z "${PEARCINEMA_PASSWORD:-}" ] && [ "$HAD_PASSWORD" = "0" ] && $SUDO test -s "$DATA/dashboard-password"; then
  echo
  echo "== THE DASHBOARD PASSWORD IS NEW =="
  echo
  echo "   $($SUDO cat "$DATA/dashboard-password")"
  echo
  echo "   Read it again any time:  sudo cat $DATA/dashboard-password"
fi

echo
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "== open http://umbrel:8751  or  http://$IP:8751 =="
