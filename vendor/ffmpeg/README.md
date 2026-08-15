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
