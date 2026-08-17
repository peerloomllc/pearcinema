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
mkdir -p "$STAGE/pearcinema" "$STAGE/peerloom-host" "$STAGE/peerloom-client"
cp "$REPO/package.json" "$REPO/package-lock.json" "$STAGE/pearcinema/"
cp -r "$REPO/host" "$STAGE/pearcinema/host"
cp "$HOST_PKG/package.json" "$HOST_PKG/package-lock.json" "$STAGE/peerloom-host/"
cp -r "$HOST_PKG/src" "$STAGE/peerloom-host/src"
cp "$CLIENT_PKG/package.json" "$CLIENT_PKG/package-lock.json" "$STAGE/peerloom-client/"
cp -r "$CLIENT_PKG/src" "$STAGE/peerloom-client/src"

# A stray host-data/ inside host/ would ship somebody's identity seed in a public
# image. Belt and braces on top of .gitignore.
rm -rf "$STAGE/pearcinema/host/host-data" "$STAGE/pearcinema/host"/*.seed

cp "$REPO/host/Dockerfile" "$STAGE/Dockerfile"

cd "$STAGE"

if [ "$PUSH" = "--push" ]; then
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    -t "$IMAGE:$VERSION" \
    --push .
  echo
  echo "pushed $IMAGE:$VERSION"
  echo "PIN IT BY DIGEST in umbrel/docker-compose.yml - the digest is the rollback plan:"
  docker buildx imagetools inspect "$IMAGE:$VERSION" --format '{{.Manifest.Digest}}' || true
else
  docker build -t "$IMAGE:$VERSION" .
  echo
  echo "built $IMAGE:$VERSION (this architecture only - use --push for a release)"
fi
