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

process.stdout.write(JSON.stringify({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac', channels: 6 }
  ],
  format: {
    format_name: container,
    duration: '5400.000000',
    size: String(size)
  }
}))
