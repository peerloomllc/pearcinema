#!/usr/bin/env bash
# Build LGPL ffmpeg/ffprobe for macOS on the mac-mini and pull the binaries back
# into ../vendor/ffmpeg/darwin-arm64/ and darwin-x64/, the drop point the desktop
# packaging ships (see fetch-ffmpeg.sh for why darwin cannot just be downloaded:
# the popular prebuilts are GPL, and PearCinema is MIT).
#
# WHY BUILDING FROM SOURCE IS ENOUGH: ffmpeg's default configure is LGPL - the
# GPL components only enter with an explicit --enable-gpl, which this never
# passes. And the transcode design never invokes a software video encoder, so
# nothing GPL-shaped (libx264 and friends) is even wanted. VideoToolbox hardware
# encode/decode is part of ffmpeg proper and uses OS frameworks, so the binaries
# link nothing but system libraries and run on any Mac of the same architecture.
#
# The x64 slice is CROSS-COMPILED on the arm64 mini (clang -arch x86_64), which
# is supported and quick; nasm from Homebrew provides the x86 asm assembler.
#
# Usage: bash scripts/build-ffmpeg-mac.sh
# Requires: SSH access to the mac-mini with Xcode CLT and Homebrew.

set -euo pipefail
cd "$(dirname "$0")/../.."

MAC_HOST="${MAC_MINI_HOST:-Tims-Mac-mini.local}"
# Pinned so two runs a month apart do not silently ship different ffmpeg.
FF_VER="7.1"

ssh "$MAC_HOST" 'FF_VER='"$FF_VER"' bash -s' <<'REMOTE'
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
command -v nasm >/dev/null || brew install nasm

WORK="$HOME/pearcinema-ffmpeg-build"
mkdir -p "$WORK"
cd "$WORK"
if [ ! -d "ffmpeg-$FF_VER" ]; then
  curl -fL --retry 3 -o "ffmpeg-$FF_VER.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FF_VER.tar.xz"
  tar -xJf "ffmpeg-$FF_VER.tar.xz"
fi

build () {
  local arch="$1"; shift
  local out="$WORK/out-$arch"
  rm -rf "build-$arch" "$out"
  mkdir -p "build-$arch" "$out"
  cd "build-$arch"
  # NO --enable-gpl and NO external libraries: that is the LGPL guarantee.
  # ffplay/docs skipped (not shipped); videotoolbox is on by default on darwin
  # but named explicitly so a regression fails loudly at configure time.
  ../ffmpeg-$FF_VER/configure \
    --prefix="$out" \
    --enable-videotoolbox \
    --disable-ffplay --disable-doc --disable-debug \
    "$@" >/dev/null
  make -j"$(sysctl -n hw.ncpu)" >/dev/null 2>&1
  cp ffmpeg ffprobe "$out/"
  cd ..
  # Refuse to ship a binary whose own banner claims GPL.
  if "$out/ffmpeg" -version 2>/dev/null | head -3 | grep -qi "enable-gpl"; then
    echo "ERROR: $arch build reports --enable-gpl - refusing"; exit 1
  fi
}

echo ">> arm64 (native)"
build arm64

echo ">> x64 (cross via clang -arch x86_64)"
build x64 \
  --arch=x86_64 --enable-cross-compile --target-os=darwin \
  --cc="clang -arch x86_64"

echo ">> license banners:"
"$WORK/out-arm64/ffmpeg" -version | sed -n '1,2p'
# The x64 slice runs under Rosetta on this arm64 box, which doubles as its test.
"$WORK/out-x64/ffmpeg" -version | sed -n '1p'
lipo -archs "$WORK/out-arm64/ffmpeg" "$WORK/out-x64/ffmpeg" 2>/dev/null || true
REMOTE

echo ">> Pulling binaries back into vendor/ffmpeg/"
mkdir -p vendor/ffmpeg/darwin-arm64 vendor/ffmpeg/darwin-x64
rsync -az "$MAC_HOST:pearcinema-ffmpeg-build/out-arm64/"{ffmpeg,ffprobe} vendor/ffmpeg/darwin-arm64/
rsync -az "$MAC_HOST:pearcinema-ffmpeg-build/out-x64/"{ffmpeg,ffprobe} vendor/ffmpeg/darwin-x64/
chmod +x vendor/ffmpeg/darwin-*/{ffmpeg,ffprobe}
ls -lh vendor/ffmpeg/darwin-arm64/ vendor/ffmpeg/darwin-x64/
