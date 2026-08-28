#!/usr/bin/env bash
#
# Build the PearCinema host image.
#
# WHY THIS SCRIPT EXISTS rather than a bare `docker build`. PearCinema depends on
# `@peerloom/host` through `file:../peerloom-host`, which sits OUTSIDE this repo
# and therefore outside any build context rooted here. The alternatives were:
#
#   - Build from the suite root. The context would then be every PeerLoom repo
#     including their node_modules, and .dockerignore would have to live in a
#     directory that is not a git repo at all.
#   - Publish @peerloom/host to a registry. Correct eventually, and premature while
#     the package is one week old and has one consumer.
#
# So: stage the two directories side by side in a temp dir, build from there, throw
# it away. The context is exactly what the image needs and nothing else.
#
#   ./host/build-image.sh 0.1.0            # local, current arch
#   ./host/build-image.sh 0.1.0 --push     # multi-arch to ghcr.io
#
# Works with docker OR podman, whichever the machine has - the box holding the ghcr
# credential is not always the box holding Docker.
#
# Umbrel Home is x86_64; a Pi-class Umbrel is arm64. A single-arch image installs
# on one and fails on the other with an error that says nothing useful, so --push
# always builds both.

set -euo pipefail

VERSION="${1:-}"
PUSH="${2:-}"
IMAGE="ghcr.io/peerloomllc/pearcinema-host"

if [ -z "$VERSION" ]; then
  echo "usage: $0 <version> [--push]" >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE="$(cd "$REPO/.." && pwd)"
HOST_PKG="$SUITE/peerloom-host"
# The OUTBOUND side too: the Dockerfile has copied @peerloom/client since the
# desktop-client merge (#65), but nothing staged it - so every image build
# since then failed at COPY. Found deploying the cast host, 2026-08-17.
CLIENT_PKG="$SUITE/peerloom-client"

if [ ! -d "$HOST_PKG/src" ]; then
  echo "@peerloom/host not found at $HOST_PKG - the image cannot be built without it" >&2
  exit 1
fi
if [ ! -d "$CLIENT_PKG/src" ]; then
  echo "@peerloom/client not found at $CLIENT_PKG - the image cannot be built without it" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "staging build context in $STAGE"

# Only what the image copies. node_modules is deliberately excluded from both: the
# image runs `npm ci` itself, and a host's node_modules carries native addons built
# for the WRONG architecture on a cross-arch build - which fails at runtime, deep
# inside the hypercore stack, with an error that looks like a code bug.
mkdir -p "$STAGE/pearcinema" "$STAGE/pearcinema/src" "$STAGE/peerloom-host" "$STAGE/peerloom-client"
cp "$REPO/package.json" "$REPO/package-lock.json" "$STAGE/pearcinema/"
cp -r "$REPO/host" "$STAGE/pearcinema/host"
# The blend requires ../src/merge - the ONE file host code reaches outside
# host/ for, shared with the phone's worklet so the two cannot disagree.
# Learned the hard way: the image built clean and crash-looped at require
# (2026-08-17, the blend's first container deploy).
cp "$REPO/src/merge.js" "$STAGE/pearcinema/src/"
cp "$HOST_PKG/package.json" "$HOST_PKG/package-lock.json" "$STAGE/peerloom-host/"
cp -r "$HOST_PKG/src" "$STAGE/peerloom-host/src"
cp "$CLIENT_PKG/package.json" "$CLIENT_PKG/package-lock.json" "$STAGE/peerloom-client/"
cp -r "$CLIENT_PKG/src" "$STAGE/peerloom-client/src"

# A stray host-data/ inside host/ would ship somebody's identity seed in a public
# image. Belt and braces on top of .gitignore.
rm -rf "$STAGE/pearcinema/host/host-data" "$STAGE/pearcinema/host"/*.seed

cp "$REPO/host/Dockerfile" "$STAGE/Dockerfile"

cd "$STAGE"

# DOCKER OR PODMAN, because the machine that has the credential is not always the machine
# that has Docker. This repo's own development box runs Fedora with podman and no docker
# at all, and the Umbrel that has docker has no ghcr login - so insisting on one of them
# meant the image could not be built anywhere (2026-08-24). Both speak the same Dockerfile
# and both can push a multi-arch manifest to ghcr; only the words differ.
if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  echo "neither docker nor podman is installed - nothing can build this" >&2
  exit 1
fi
echo "building with $ENGINE"

# PODMAN MUST BE TOLD `--format docker`, and the cost of not telling it is silent.
# podman writes OCI images by default, and the OCI image spec has no HEALTHCHECK field -
# so podman drops the Dockerfile's healthcheck with a warning in the middle of a hundred
# lines of build output and produces an image that looks fine. The healthcheck is the
# thing that catches the failure mode that actually matters here: a host that is running
# and unreachable. Docker's format carries it.

# BOTH ARCHITECTURES, ALWAYS, on a push. Umbrel Home is x86_64 and a Pi-class Umbrel is
# arm64; a single-arch image installs on one and fails on the other with an error that
# says nothing useful. Cross-building needs qemu registered with binfmt_misc, which is
# what `qemu-user-static` provides - check it rather than discover it as an exec-format
# error forty layers in.
if [ "$PUSH" = "--push" ] && [ "$ENGINE" = "podman" ]; then
  if [ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]; then
    echo "no qemu-aarch64 registered with binfmt_misc, so the arm64 half cannot be built here" >&2
    echo "install qemu-user-static (Fedora: sudo dnf install qemu-user-static-aarch64)" >&2
    exit 1
  fi
fi

if [ "$PUSH" = "--push" ]; then
  if [ "$ENGINE" = "docker" ]; then
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      -t "$IMAGE:$VERSION" \
      --push .
    DIGEST="$(docker buildx imagetools inspect "$IMAGE:$VERSION" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
  else
    # podman builds each architecture into a MANIFEST LIST, which is the same thing
    # buildx's --platform produces, and pushes the list rather than one image.
    # CLEAR THE NAME FIRST, and it is not always a manifest that holds it. A plain
    # `./host/build-image.sh <version>` earlier in the day leaves an ordinary IMAGE on
    # that tag, and `manifest create` then refuses with "that name is already in use"
    # - which `manifest rm` does not fix, because there is no manifest to remove.
    if podman manifest exists "$IMAGE:$VERSION" 2>/dev/null; then
      podman manifest rm "$IMAGE:$VERSION" >/dev/null 2>&1 || true
    elif podman image exists "$IMAGE:$VERSION" 2>/dev/null; then
      podman untag "$IMAGE:$VERSION" >/dev/null 2>&1 || true
    fi
    podman manifest create "$IMAGE:$VERSION"
    podman build --format docker --platform linux/amd64,linux/arm64 --manifest "$IMAGE:$VERSION" .
    podman manifest push --all "$IMAGE:$VERSION" "docker://$IMAGE:$VERSION"
    DIGEST="$(podman manifest inspect "$IMAGE:$VERSION" | sha256sum | awk '{print "sha256:"$1}')"
    # That digest is of the local manifest bytes, which is NOT necessarily what the
    # registry stored. Ask the registry itself, which is the only answer worth pinning.
    REG="$(skopeo inspect --raw "docker://$IMAGE:$VERSION" 2>/dev/null | sha256sum | awk '{print "sha256:"$1}' || true)"
    [ -n "$REG" ] && DIGEST="$REG"
  fi
  echo
  echo "pushed $IMAGE:$VERSION"

  # ---------------------------------------------------------------------------
  # PIN THE NEW TAG AND DIGEST INTO EVERY FILE THAT NAMES THE IMAGE.
  #
  # This used to PRINT the line and leave a person to paste it, which is how
  # README.md came to tell newcomers to run 0.1.1 while the Umbrel listing was on
  # 0.1.5 - four versions of drift in a file whose whole job is to be correct for
  # somebody who has never seen this project. `scripts/release.sh` already told
  # the operator this step pins them, which was the donor's behaviour and not
  # ours; now it is true here too.
  #
  # The digest is the rollback plan: a tag can be moved, a digest cannot.
  if [ -n "${DIGEST:-}" ]; then
    sed -i -E "s|image: ${IMAGE}:[0-9]+\.[0-9]+\.[0-9]+(@sha256:[0-9a-f]+)?|image: ${IMAGE}:${VERSION}@${DIGEST}|g" umbrel/docker-compose.yml
  fi
  # The README's `docker run` one-liner takes the tag alone - a digest there would
  # be unreadable in a command somebody is meant to copy, and it is a starting
  # point rather than a pinned deployment.
  sed -i -E "s|${IMAGE}:[0-9]+\.[0-9]+\.[0-9]+|${IMAGE}:${VERSION}|g" README.md

  # AND THE OFFICIAL-STORE SUBMISSION, which is a third copy of this listing and
  # therefore a third thing that can go stale. It carries the same image and the
  # same version as umbrel/ by design - test/official-store.test.js fails when they
  # part - so a release that moved one and not the other would break the gate on
  # its next run rather than at the moment the drift happened.
  if [ -f umbrel/official/docker-compose.yml ]; then
    [ -n "${DIGEST:-}" ] && sed -i -E "s|image: ${IMAGE}:[0-9]+\.[0-9]+\.[0-9]+(@sha256:[0-9a-f]+)?|image: ${IMAGE}:${VERSION}@${DIGEST}|g" umbrel/official/docker-compose.yml
    _listing_ver="$(grep -m1 -E '^version:' umbrel/umbrel-app.yml | sed -E 's|^version: *"?([^"]*)"?|\1|')"
    [ -n "$_listing_ver" ] && sed -i -E "s|^version: \".*\"|version: \"${_listing_ver}\"|" umbrel/official/umbrel-app.yml
  fi

  # ---------------------------------------------------------------------------
  # The PeerLoom community app store (STORE_DIR), if a clone is pointed at us.
  #
  # SYNCED, NOT BUMPED, which is the donor's hard-won rule and worth keeping: a
  # builder that surgically edits `version:` and `image:` in the store copy is
  # fine while the two copies are otherwise identical, and silently wrong the
  # moment they are not. PearTune's store copy turned out to be an old SNAPSHOT
  # on 2026-07-31, and a version bump would have published it with a fresh digest
  # on top. So `umbrel/` is the source of truth and the store copy is overwritten
  # wholesale - anything stale in the store cannot survive a release.
  #
  # AND ONE THING THE DONOR DOES THAT THIS MUST NOT. PearTune rewrites the store
  # listing's `version:` from app.json, on the rule that one number moves across
  # the App Store, Play and Umbrel. That is not true here and has not been for a
  # while: the host shipped to 1.0.5 while the phone app sat at 0.1.0, because
  # this listing versions the HOST. Copying the donor would set the listing to
  # the app's number and publish a DOWNGRADE - which is the exact failure its own
  # header warns about, where umbrelOS offers an "update" that goes backwards.
  #
  # So the version comes from umbrel/umbrel-app.yml, where it is already managed,
  # and this refuses to publish one that goes backwards against what the store is
  # serving right now.
  #
  # Committing and pushing that repo stays MANUAL - it publishes to real users -
  # and release.sh's step 13c refuses to call the run clean until it is done.
  # ---------------------------------------------------------------------------
  if [ -n "${STORE_DIR:-}" ] && [ -d "${STORE_DIR}" ]; then
    DEST="${STORE_DIR}/peerloom-pearcinema"
    _ver_of () { grep -m1 -E '^version:' "$1" 2>/dev/null | sed -E 's|^version: *"?([^"]*)"?|\1|'; }
    # Read BEFORE the copy overwrites it, or there is nothing to compare against.
    PREV_STORE_VER="$(_ver_of "$DEST/umbrel-app.yml")"
    NEW_STORE_VER="$(_ver_of umbrel/umbrel-app.yml)"

    # A LOWER number than the store is serving is refused rather than warned about.
    # umbrelOS reads `version:` alone, so a backwards one is an "update" that
    # downgrades every installed user - and it is not hypothetical: the store repo
    # was found carrying exactly that for a sibling app on 2026-08-27.
    if [ -n "$PREV_STORE_VER" ] && [ -n "$NEW_STORE_VER" ] \
       && [ "$PREV_STORE_VER" != "$NEW_STORE_VER" ] \
       && [ "$(printf '%s\n%s\n' "$PREV_STORE_VER" "$NEW_STORE_VER" | sort -V | tail -1)" != "$NEW_STORE_VER" ]; then
      echo
      echo "== community store NOT synced: that would be a DOWNGRADE =="
      echo "   the store serves $PREV_STORE_VER and umbrel/umbrel-app.yml says $NEW_STORE_VER."
      echo "   umbrelOS reads version: alone, so publishing this offers every installed"
      echo "   user an update that goes backwards. Fix umbrel/umbrel-app.yml first."
    else
      mkdir -p "$DEST"
      cp umbrel/umbrel-app.yml umbrel/docker-compose.yml umbrel/icon.svg "$DEST/"
      # A HOST-ONLY FIX SHIPS TO NOBODY, said out loud rather than discovered by a
      # user who never got an update: umbrelOS keys "update available" off
      # `version:`, so a new image under an unchanged listing version reaches no
      # existing install. The host has had many image versions to the app's few.
      if [ -n "$PREV_STORE_VER" ] && [ "$PREV_STORE_VER" = "$NEW_STORE_VER" ]; then
        echo
        echo "   !! WARNING: the listing version is still $NEW_STORE_VER while the image moved to $VERSION."
        echo "      umbrelOS compares version: only, so INSTALLED USERS WILL NOT BE OFFERED THIS."
        echo "      Bump version: in umbrel/umbrel-app.yml before publishing."
      fi
      echo
      echo "== community store synced from umbrel/ =="
      echo "   $DEST  (listing $NEW_STORE_VER, image pinned to ${VERSION}@${DIGEST})"
      git -C "$STORE_DIR" status --porcelain -- '*pearcinema*' | sed 's/^/   /'
      echo "   commit + push that repo to publish - release.sh step 13c checks it"
    fi
  else
    echo
    echo "== community store NOT synced (set STORE_DIR to a local clone to auto-sync) =="
  fi

  echo
  echo "== pinned to $VERSION =="
  grep -n "${IMAGE}:" umbrel/docker-compose.yml README.md umbrel/official/docker-compose.yml 2>/dev/null
else
  FORMAT=""
  [ "$ENGINE" = "podman" ] && FORMAT="--format docker"
  $ENGINE build $FORMAT -t "$IMAGE:$VERSION" .
  echo
  echo "built $IMAGE:$VERSION (this architecture only - use --push for a release)"
fi
