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
  echo "PIN IT BY DIGEST in umbrel/docker-compose.yml - the digest is the rollback plan:"
  echo "  image: $IMAGE:$VERSION@$DIGEST"
else
  FORMAT=""
  [ "$ENGINE" = "podman" ] && FORMAT="--format docker"
  $ENGINE build $FORMAT -t "$IMAGE:$VERSION" .
  echo
  echo "built $IMAGE:$VERSION (this architecture only - use --push for a release)"
fi
