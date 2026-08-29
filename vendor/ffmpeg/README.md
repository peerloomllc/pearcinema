# Bundled ffmpeg and ffprobe

This directory is the drop point for per-platform ffmpeg builds, resolved by
`host/ffmpeg-bin.js` when no explicit setting names a binary and before the
system PATH is consulted. The layout:

```
vendor/ffmpeg/linux-x64/ffmpeg
vendor/ffmpeg/linux-x64/ffprobe
vendor/ffmpeg/darwin-arm64/ffmpeg
vendor/ffmpeg/darwin-arm64/ffprobe
vendor/ffmpeg/win32-x64/ffmpeg.exe
vendor/ffmpeg/win32-x64/ffprobe.exe
```

The directory names are `process.platform`-`process.arch`, verbatim.

Nothing here is committed - the binaries arrive with desktop packaging, which
is the artifact consumers touch. A git checkout is an operator's machine and an
operator can install ffmpeg; the Docker image carries the distro's.

**Use LGPL builds.** They suffice by design: the transcode proposal forbids
software video encoding outright, so the GPL-triggering encoders (libx264 and
friends) are never invoked - remux is stream copy plus the built-in AAC
encoder, and transcode is hardware only (VAAPI, VideoToolbox). Shipping LGPL
builds keeps the app's MIT licensing posture clean instead of leaning on the
separate-process argument. Decided 2026-08-14, recorded in DECISIONS.md.

## Which build, and the NVIDIA driver it needs

`desktop/scripts/fetch-ffmpeg.sh` takes BtbN's build of the ffmpeg **8.1 release line**,
not the master development build. Both are LGPL and both carry every engine PearCinema
uses (VAAPI, NVENC with `scale_cuda`, Quick Sync, AMF). The one difference that matters
is the NVIDIA header they are compiled against: master uses encoding interface 13.1,
which needs NVIDIA driver 610 or newer, and 8.1 uses 13.0, which driver 570 satisfies.
Linux Mint and Ubuntu install 580 through their driver managers, so a master build
fails the engine test on all of them with "The minimum required Nvidia driver for
nvenc is 610.00 or newer" (field report 2026-08-29). The requirement is fixed at build
time and cannot be relaxed at run time.
