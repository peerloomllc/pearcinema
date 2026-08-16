#!/usr/bin/env bash
# Fetch LGPL ffmpeg/ffprobe builds into ../vendor/ffmpeg/<platform>-<arch>/, the
# drop point host/ffmpeg-bin.js resolves and desktop packaging ships.
#
# LGPL, NOT GPL, and that is a licensing requirement, not a preference: PearCinema
# is MIT and the transcode design never invokes a software video encoder (VAAPI /
# VideoToolbox / MediaFoundation only), so the GPL-triggering components (libx264
# and friends) are never needed. See vendor/ffmpeg/README.md.
#
# Sources:
#   linux-x64, win32-x64  BtbN/FFmpeg-Builds "latest" release, the -lgpl variants.
#   darwin-*              NO reliable prebuilt LGPL source (evermeet and most
#                         others ship GPL). scripts/build-ffmpeg-mac.sh compiles
#                         LGPL-clean binaries on the mac-mini instead. This
#                         script says so and skips rather than quietly shipping
#                         a GPL binary into an MIT app.
#
# Usage: bash scripts/fetch-ffmpeg.sh [linux|windows|all]   (default: all)

set -euo pipefail
cd "$(dirname "$0")/../.."
DEST="vendor/ffmpeg"
PICK="${1:-all}"
BASE="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"

fetch_linux () {
  echo ">> linux-x64 (BtbN lgpl tar.xz)"
  local tmp; tmp=$(mktemp -d)
  curl -fL --retry 3 -o "$tmp/ff.tar.xz" "$BASE/ffmpeg-master-latest-linux64-lgpl.tar.xz"
  tar -xJf "$tmp/ff.tar.xz" -C "$tmp"
  mkdir -p "$DEST/linux-x64"
  cp "$tmp"/ffmpeg-*/bin/ffmpeg "$tmp"/ffmpeg-*/bin/ffprobe "$DEST/linux-x64/"
  chmod +x "$DEST/linux-x64/ffmpeg" "$DEST/linux-x64/ffprobe"
  rm -rf "$tmp"
  "$DEST/linux-x64/ffmpeg" -version | head -1
}

fetch_windows () {
  echo ">> win32-x64 (BtbN lgpl zip)"
  local tmp; tmp=$(mktemp -d)
  curl -fL --retry 3 -o "$tmp/ff.zip" "$BASE/ffmpeg-master-latest-win64-lgpl.zip"
  unzip -q "$tmp/ff.zip" -d "$tmp"
  mkdir -p "$DEST/win32-x64"
  cp "$tmp"/ffmpeg-*/bin/ffmpeg.exe "$tmp"/ffmpeg-*/bin/ffprobe.exe "$DEST/win32-x64/"
  rm -rf "$tmp"
  ls -lh "$DEST/win32-x64/"
}

case "$PICK" in
  linux)   fetch_linux ;;
  windows) fetch_windows ;;
  all)     fetch_linux; fetch_windows ;;
  *) echo "usage: fetch-ffmpeg.sh [linux|windows|all]" >&2; exit 1 ;;
esac

echo
echo "NOTE: darwin binaries are NOT fetched - no trustworthy prebuilt LGPL source."
echo "      Run scripts/build-ffmpeg-mac.sh instead - it compiles LGPL-clean binaries"
echo "      on the mac-mini for both arches and pulls them into vendor/ffmpeg/."
