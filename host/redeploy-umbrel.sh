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
# is not where they live. Overridable, because drive labels change.
LIBRARY="${LIBRARY:-/home/umbrel/umbrel/external/Elements (3)/Video}"

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

if [ ! -d "$LIBRARY" ]; then
  echo "the library is not at: $LIBRARY" >&2
  echo "what this box can see:" >&2
  ls -1 /home/umbrel/umbrel/external/ 2>/dev/null | sed 's/^/  /' >&2
  echo "set LIBRARY=... and re-run" >&2
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
# network_mode host, and no app_proxy: measured twice on a real Umbrel, holepunching
# does not survive Docker's bridge NAT, and app_proxy is itself a bridged container
# so it cannot front a host-networked service.
echo "== starting =="
$SUDO docker run -d \
  --name pearcinema-host \
  --restart unless-stopped \
  --network host \
  --security-opt no-new-privileges:true \
  -e PEARCINEMA_HTTP_HOST=0.0.0.0 \
  -e PEARCINEMA_HTTP_PORT=8751 \
  ${PEARCINEMA_PASSWORD:+-e PEARCINEMA_PASSWORD="$PEARCINEMA_PASSWORD"} \
  -e PEARCINEMA_DATA=/data \
  -e PEARCINEMA_NAME="$LIBRARY_NAME" \
  -e "PEARCINEMA_FOLDERS=/library/Movies:/library/TV Shows" \
  -v "$DATA:/data" \
  --mount "type=bind,source=$LIBRARY,target=/library,readonly,bind-propagation=rslave" \
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
