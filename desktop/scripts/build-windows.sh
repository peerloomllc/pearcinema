#!/usr/bin/env bash
# Build PearCinema Desktop for Windows (.exe NSIS installer) on this Linux box - no
# Windows VM. electron-builder downloads the win32-x64 Electron dist, packs the app
# (the holepunch native deps ship cross-platform prebuilds, so no win32 compile),
# and builds the NSIS installer with its bundled makensis; rcedit runs under wine.
# The installer is UNSIGNED (v1). Install-test on a real Windows box.
#
# Bundled ffmpeg: fetch-ffmpeg.sh must have populated vendor/ffmpeg/win32-x64/
# BEFORE this runs, or the Windows app will hunt the PATH for an ffmpeg that no
# consumer Windows machine has.
#   Requires: electron-builder (dev dep) and wine.  Usage: npm run build:windows
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/prepack.js
if [ ! -f ffmpeg-staging/win32-x64/ffmpeg.exe ]; then
  echo "WARNING: no win32-x64 ffmpeg staged - run scripts/fetch-ffmpeg.sh first for a self-contained build" >&2
fi
./node_modules/.bin/electron-builder --win --x64 --publish never
if ! ls dist/*Setup*.exe >/dev/null 2>&1 && ! ls dist/*.exe >/dev/null 2>&1; then
  echo "ERROR: no NSIS installer was produced - Windows build failed" >&2; exit 1
fi
echo; echo "Built artifacts in desktop/dist/:"; ls -lh dist/ | grep -E '\.exe$' || true
