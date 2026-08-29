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
#   linux-x64, win32-x64  BtbN/FFmpeg-Builds "latest" release, the -lgpl variants of
#                         the FF_LINE release line (8.1), NOT the master development
#                         build. The difference is one header: BtbN builds master
#                         against NVIDIA's 13.1 encoding interface, which needs driver
#                         610 or newer, and builds the release lines up to 8.1 against
#                         13.0, which driver 570 satisfies. Linux Mint and Ubuntu offer
#                         580 through their driver managers today, so a master build
#                         fails the engine test on every one of those machines with
#                         "The minimum required Nvidia driver for nvenc is 610.00 or
#                         newer" (a user's Ryzen 5900X + 4080 on Mint, 2026-08-29).
#                         Proven with a fake libnvidia-encode.so.1 reporting 13.0:
#                         the 8.1 build gets past the version check, 9.0 and master
#                         refuse. Move FF_LINE up only after checking BtbN's
#                         scripts.d/50-ffnvcodec.sh still pairs that line with 13.0,
#                         or after the distros ship 610.
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
FF_LINE="${FF_LINE:-8.1}"

fetch_linux () {
  echo ">> linux-x64 (BtbN lgpl tar.xz)"
  local tmp; tmp=$(mktemp -d)
  curl -fL --retry 3 -o "$tmp/ff.tar.xz" "$BASE/ffmpeg-n${FF_LINE}-latest-linux64-lgpl-${FF_LINE}.tar.xz"
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
  curl -fL --retry 3 -o "$tmp/ff.zip" "$BASE/ffmpeg-n${FF_LINE}-latest-win64-lgpl-${FF_LINE}.zip"
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
