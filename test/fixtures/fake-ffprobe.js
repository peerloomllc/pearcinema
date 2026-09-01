#!/usr/bin/env node
//
// A stand-in for ffprobe, for the folder adapter's tests.
//
// Writing a real Matroska file in a unit test would be testing ffmpeg. What the
// folder adapter needs from a probe is a shape, and what a probe actually returns
// is exercised for real by probe.test.js and by the scans against Tim's library.
//
// It answers plausibly for any path, so the tree, the cache, the sidecar merge and
// the path guard can all be tested without a byte of video on disk.

const path = require('path')
const fs = require('fs')

const file = process.argv[process.argv.length - 1]

let size = 0
try {
  size = fs.statSync(file).size
} catch {
  process.exit(1)
}

const ext = path.extname(file).toLowerCase()
const container = ext === '.mkv' ? 'matroska,webm' : ext === '.avi' ? 'avi' : 'mov,mp4,m4a'

// SUBTITLE TRACKS ON DEMAND, from the filename, because a test about which tracks a
// player is offered needs a file that HAS tracks. `.subs-<codec>-<codec>` anywhere in
// the name asks for them: `Film.subs-subrip-pgssub.mkv` is one text track and one
// image one. Anything without the marker has none, which is the common case and what
// every test written before this expected.
const marker = /\.subs-([a-z0-9-]+)/i.exec(path.basename(file))
const subs = marker
  ? marker[1].split('-').map((codec, i) => ({
      codec_type: 'subtitle',
      codec_name: codec,
      tags: { language: i === 0 ? 'eng' : 'fre', title: i === 0 ? 'English' : null },
      disposition: { forced: 0, default: i === 0 ? 1 : 0, hearing_impaired: 0 }
    }))
  : []

// LENGTH ON DEMAND, the same way. `.dur-120` anywhere in the name is a two-minute
// file and `.dur-0` is a rip fragment ffprobe cannot measure, which is what the
// minimum-length rule is made of. Everything else is 90 minutes, which is what every
// test written before the marker expected.
const durMarker = /\.dur-(\d+)/.exec(path.basename(file))
const duration = durMarker ? Number(durMarker[1]) : 5400

process.stdout.write(JSON.stringify({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac', channels: 6 },
    ...subs
  ],
  format: {
    format_name: container,
    duration: duration.toFixed(6),
    size: String(size)
  }
}))
