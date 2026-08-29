// WHOSE GRAPHICS CARD IS DOING THE CONVERTING.
//
// Everything about converting was written against an Intel N100, and therefore against
// VAAPI. That is Intel and AMD, which between them are most media servers, and it is
// not NVIDIA at all: measured on Tim's own desktop 2026-08-20, an RTX 4070 Ti answers
// `-vaapi_device /dev/dri/renderD128` with "Failed to initialise VAAPI connection", so
// the startup probe failed, converting was switched off, and PearCinema served
// direct-play only on a card that encodes H.264 in its sleep.

const test = require('node:test')
const assert = require('node:assert/strict')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')

const engines = require('../host/engines')
const transcode = require('../host/transcode')
const hls = require('../host/hls')

async function fakeFfmpeg (script) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pearcinema-engine-'))
  const bin = path.join(dir, 'ffmpeg')
  await fsp.writeFile(bin, '#!/bin/sh\n' + script)
  await fsp.chmod(bin, 0o755)
  return bin
}

const at = (args, flag) => args[args.indexOf(flag) + 1]

/* ------------------------------------------------------------ the argv -- */

test('AN NVIDIA MACHINE GETS NVIDIA ARGV, and an Intel or AMD one is untouched', () => {
  const media = { videoCodec: 'hevc', width: 1920 }

  // The VAAPI argv is the one every install already runs, byte for byte. This is the
  // regression that matters most: adding a vendor must not move the proven one.
  const vaapi = transcode.transcodeArgs({ input: '/x.mkv', media })
  assert.equal(at(vaapi, '-hwaccel'), 'vaapi')
  assert.equal(at(vaapi, '-hwaccel_output_format'), 'vaapi')
  assert.equal(at(vaapi, '-vf'), 'scale_vaapi=format=nv12')
  assert.equal(at(vaapi, '-c:v'), 'h264_vaapi')

  const nvenc = transcode.transcodeArgs({ input: '/x.mkv', media, engine: 'nvenc' })
  assert.equal(at(nvenc, '-hwaccel'), 'cuda')
  assert.equal(at(nvenc, '-c:v'), 'h264_nvenc')
  // NO `-hwaccel_output_format cuda`, deliberately: the frames come back to system
  // memory so every filter after the decoder is an ordinary one, which is the half of
  // NVENC that works on both ffmpeg builds in this house. See engines.js.
  assert.equal(nvenc.includes('-hwaccel_output_format'), false)
  assert.equal(at(nvenc, '-vf'), 'format=nv12')
  assert.equal(nvenc.includes('hwupload'), false, 'nothing is uploaded: it never left')
  assert.equal(nvenc.includes('-vaapi_device'), false)

  // And everything that is NOT about the vendor is the same conversion either way.
  for (const flag of ['-map_chapters', '-b:v', '-movflags', '-f']) {
    assert.equal(at(vaapi, flag), at(nvenc, flag), `${flag} is not a vendor question`)
  }
})

test('a film the card cannot decode is still ENCODED on the card, on either vendor', () => {
  // MPEG-4 Part 2 off the AVI shelf: software decode, hardware encode. On VAAPI that
  // means uploading the frames; on NVENC they are already where they need to be.
  const media = { videoCodec: 'mpeg4', width: 640 }
  const vaapi = transcode.transcodeArgs({ input: '/x.avi', media })
  assert.equal(at(vaapi, '-vf'), 'format=nv12,hwupload')
  assert.equal(at(vaapi, '-vaapi_device'), '/dev/dri/renderD128')

  const nvenc = transcode.transcodeArgs({ input: '/x.avi', media, engine: 'nvenc' })
  assert.equal(at(nvenc, '-vf'), 'format=nv12')
  assert.equal(nvenc.includes('-hwaccel'), false, 'nothing to accelerate on the way in')
  assert.equal(at(nvenc, '-c:v'), 'h264_nvenc')
})

test('the segment path follows the same vendor, including burn-in and tone', () => {
  const base = { input: '/x.mkv', seq: 0, media: { videoCodec: 'hevc', width: 1920 }, device: '/dev/dri/renderD128', hwDecode: true, bitrate: '6M' }

  const nvenc = hls.segmentArgs({ ...base, engine: 'nvenc' })
  assert.equal(at(nvenc, '-c:v'), 'h264_nvenc')
  assert.equal(at(nvenc, '-vf'), 'format=nv12')

  // A tone takes the software-decode lane on every vendor - it is a CPU filter - so the
  // only vendor question left is what the encoder is handed at the end of it.
  const toned = hls.segmentArgs({ ...base, engine: 'nvenc', tone: 'bw' })
  assert.equal(at(toned, '-vf'), 'hue=s=0,format=nv12')
  assert.equal(toned.includes('-hwaccel'), false)

  const burned = hls.segmentArgs({ ...base, engine: 'nvenc', burn: { index: 2 } })
  assert.match(at(burned, '-filter_complex'), /\[0:s:2\]overlay\[ov\];\[ov\]format=nv12\[out\]$/)
  assert.equal(at(burned, '-c:v'), 'h264_nvenc')

  // And VAAPI's graphs are exactly what they were.
  assert.match(at(hls.segmentArgs({ ...base, burn: { index: 2 } }), '-filter_complex'), /format=nv12,hwupload\[out\]$/)
})

test('a card is named by number on NVENC and by path on VAAPI', () => {
  // A render node IS the card and lives at a path; NVENC counts its own and takes an
  // index. The same field carries both, so it must not be handed to the wrong one.
  const nv = transcode.transcodeArgs({ input: '/x.mkv', media: { videoCodec: 'h264' }, engine: 'nvenc', device: '1' })
  assert.equal(at(nv, '-hwaccel_device'), '1')
  assert.equal(at(nv, '-gpu'), '1')

  // The default path is not a card number, so it is not passed as one.
  const nvDefault = transcode.transcodeArgs({ input: '/x.mkv', media: { videoCodec: 'h264' }, engine: 'nvenc' })
  assert.equal(nvDefault.includes('-gpu'), false)
  assert.equal(nvDefault.includes('-hwaccel_device'), false)
})

/* ----------------------------------------------------------- the choice -- */

test('THE ENGINE IS CHOSEN BY RUNNING IT, and NVIDIA is reached when VAAPI genuinely fails', async () => {
  // The exact failure off Tim's desktop: the card is there, the driver interface is
  // not, and every install before this read that as "no video engine".
  const bin = await fakeFfmpeg(`
    case "$*" in
      *h264_vaapi*) echo "Failed to initialise VAAPI connection: -1 (unknown libva error)." >&2; exit 1 ;;
      *h264_nvenc*) printf "mp4bytes"; exit 0 ;;
    esac
    exit 1
  `)
  const out = await transcode.chooseEngine({ ffmpeg: bin })
  assert.equal(out.available, true)
  assert.equal(out.engine, 'nvenc-cuda', 'the all-on-the-card lane is the one tried first')
  assert.equal(out.label, 'NVIDIA graphics')
  // What was tried and what each said, because an operator whose card was skipped
  // deserves to see why rather than a shrug.
  assert.match(out.tried.find((t) => t.engine === 'vaapi').reason, /libva/)
})

test('an Intel or AMD box never reaches the second candidate', async () => {
  const bin = await fakeFfmpeg('printf "mp4bytes"; exit 0')
  const out = await transcode.chooseEngine({ ffmpeg: bin })
  assert.equal(out.engine, 'vaapi')
  assert.equal(out.label, 'Intel or AMD graphics')
  assert.equal(out.tried.length, 1, 'the proven path is tried first and stops there')
})

test('a machine with no working card is told what the FIRST candidate said', async () => {
  // Not the last thing tried, which on a machine with no NVIDIA card at all is an
  // unhelpful complaint about a vendor the operator does not own.
  const bin = await fakeFfmpeg('echo "No VA display found for device /dev/dri/renderD128" >&2; exit 1')
  const out = await engines.pickEngine({
    ffmpeg: bin,
    candidates: [
      { engine: engines.VAAPI, device: '/dev/dri/renderD128' },
      { engine: engines.NVENC, device: null }
    ]
  })
  assert.equal(out.available, false)
  assert.equal(out.engine, null)
  assert.match(out.reason, /No VA display/)
  assert.equal(out.tried.length, 2, 'both were asked before giving up')
})

test('PEARCINEMA_ENGINE pins one vendor, and a nonsense one is a reason rather than a crash', async () => {
  const bin = await fakeFfmpeg('printf "mp4bytes"; exit 0')
  const pinned = await transcode.chooseEngine({ ffmpeg: bin, only: 'nvenc' })
  assert.equal(pinned.engine, 'nvenc')
  assert.equal(pinned.tried.every((t) => t.engine === 'nvenc'), true, 'VAAPI is not even asked')

  const nonsense = await transcode.chooseEngine({ ffmpeg: bin, only: 'quicksilver' })
  assert.equal(nonsense.available, false)
  assert.match(nonsense.reason, /no video engine called/)
})

test('a probe that hangs on one vendor does not cost the machine the other', async () => {
  const bin = await fakeFfmpeg(`
    case "$*" in
      *h264_vaapi*) sleep 60 ;;
      *h264_nvenc*) printf "mp4bytes"; exit 0 ;;
    esac
  `)
  const out = await transcode.chooseEngine({ ffmpeg: bin, timeoutMs: 300 })
  assert.equal(out.available, true)
  assert.equal(out.engine, 'nvenc-cuda')
})

/* --------------------------------------------- an engine belongs to a platform -- */

test('A MAC IS NEVER ASKED FOR A RENDER NODE IT CANNOT HAVE', () => {
  // FOUND ON THE MAC MINI (Tim, 2026-08-21). chooseEngine put /dev/dri/renderD128 at the
  // head of the candidate list on every platform, so a Mac ffmpeg was asked for
  // `-vaapi_device` - an option it does not have - and the dashboard published the parse
  // error as its answer: "Error splitting the argument list: Option not found". A machine
  // with a hardware H.264 encoder read as a broken one.
  const mac = transcode.engineCandidates({ platform: 'darwin', nodes: [] })
  assert.deepEqual(mac.map((c) => c.engine.id), ['videotoolbox'], 'the Mac is offered its own engine and nothing else')
  assert.equal(mac[0].device, null, 'and nothing that looks like a Linux device path')
})

test('VAAPI IS NOT OFFERED WITHOUT A RENDER NODE TO OFFER IT', () => {
  // The configured device is not evidence. DEVICE_DEFAULT is a constant, so trusting it
  // is what sent /dev/dri/renderD128 to a machine that has no /dev/dri at all.
  const win = transcode.engineCandidates({ platform: 'win32', nodes: [] })
  assert.equal(win.some((c) => c.engine.id === 'vaapi'), false, 'Windows has no render nodes to offer')

  const linuxBare = transcode.engineCandidates({ platform: 'linux', nodes: [] })
  assert.deepEqual(linuxBare.map((c) => c.engine.id), ['nvenc-cuda', 'nvenc'],
    'a Linux box with no card still has both NVENC lanes to try')
})

test('A LINUX BOX WITH CARDS TRIES THE CONFIGURED ONE FIRST, THEN THE REST', () => {
  const c = transcode.engineCandidates({
    platform: 'linux',
    device: '/dev/dri/renderD129',
    nodes: ['/dev/dri/renderD128', '/dev/dri/renderD129']
  })
  assert.deepEqual(c.map((x) => `${x.engine.id}:${x.device}`), [
    'vaapi:/dev/dri/renderD129',
    'vaapi:/dev/dri/renderD128',
    'nvenc-cuda:null',
    'nvenc:null'
  ])
})

test('THE MAC ENGINE BUILDS THE ARGV THAT WAS MEASURED ON THE MAC', () => {
  // Written from a run on the mac-mini rather than from a spec sheet, which is this
  // file's own rule: the probe returned 73,042 bytes of MP4, and a real HEVC film
  // converted at about 4x realtime with these exact input args.
  const vt = engines.engineFor('videotoolbox')
  assert.deepEqual(vt.inputArgs({ device: null, software: false }), ['-hwaccel', 'videotoolbox'])
  assert.deepEqual(vt.inputArgs({ device: null, software: true }), [], 'burn-in and software decode add nothing')
  assert.equal(vt.encoder, 'h264_videotoolbox')
  assert.deepEqual(vt.encoderArgs(null), [], 'there is no card to choose on a Mac')
  // Both lanes are the same CPU conversion: -hwaccel videotoolbox without an output
  // format hands frames back in system memory, exactly like the NVENC lane.
  assert.equal(vt.fromHwDecode, 'format=nv12')
  assert.equal(vt.toEngine, 'format=nv12')
})

/* ------------------------------------------- the two vendors Windows could not reach -- */

test('WINDOWS IS OFFERED ALL THREE VENDORS, BUILT-IN FIRST', () => {
  // An Intel or AMD Windows box was offered NVENC and nothing else, so it reported no
  // video engine while holding hardware that encodes H.264 - the same shape as the NVIDIA
  // gap (2026-08-20) and the Mac gap (2026-08-21). Quick Sync leads for the reason VAAPI
  // leads on Linux: the built-in chip converts and the discrete card stays free.
  const win = transcode.engineCandidates({ platform: 'win32', nodes: [] })
  assert.deepEqual(win.map((c) => c.engine.id), ['qsv', 'nvenc-cuda', 'nvenc', 'amf'])
  assert.deepEqual(win.map((c) => c.device), [null, null, null, null], 'none of them takes a path')
})

test('QUICK SYNC AND AMF ARE WINDOWS-ONLY', () => {
  // On Linux the same Intel and AMD silicon is served by VAAPI, which is what every
  // existing install already proved. Offering a second path to the same chip would be a
  // spawn spent asking a question that has already been answered.
  for (const platform of ['linux', 'darwin']) {
    const ids = transcode.engineCandidates({ platform, nodes: ['/dev/dri/renderD128'] }).map((c) => c.engine.id)
    assert.equal(ids.includes('qsv'), false, `no qsv on ${platform}`)
    assert.equal(ids.includes('amf'), false, `no amf on ${platform}`)
  }
})

test('THE WINDOWS ENGINES ARE THE ONLY ONES IN HERE NOBODY HAS RUN', () => {
  // Said out loud in a test, because it is the thing most likely to be forgotten. The
  // measurement was ATTEMPTED and could not be made: the Windows VM has a virtio display
  // and no graphics chip, and the Umbrel has h264_qsv compiled in with no Intel runtime
  // behind it ("Error initializing an internal MFX session: unsupported"). What IS known
  // is that the bundled Windows ffmpeg carries all three encoders, checked on the box.
  //
  // Safe to ship unproven because tryEngine runs the real pipeline and demands bytes: a
  // wrong argument shape fails the probe and leaves that machine exactly where it already
  // is, direct play only. It is not the AV1 mistake, which was a DECODER promised to a
  // viewer and then stalling mid-film.
  for (const id of ['qsv', 'amf']) {
    const e = engines.engineFor(id)
    assert.ok(e, `${id} exists`)
    assert.equal(e.deviceKind, null, 'Windows binds these itself, so there is no path to hand over')
    assert.equal(e.fromHwDecode, 'format=nv12')
    assert.equal(e.toEngine, 'format=nv12')
    assert.deepEqual(e.inputArgs({ device: null, software: true }), [], 'burn-in decodes in software')
    assert.ok(e.probeArgs(null).includes(e.encoder), 'the probe runs the encoder it claims')
  }
  assert.deepEqual(engines.engineFor('qsv').inputArgs({ device: null, software: false }), ['-hwaccel', 'qsv'])
  assert.deepEqual(engines.engineFor('amf').inputArgs({ device: null, software: false }), ['-hwaccel', 'd3d11va'])
})

/* ------------------------------------- the NVIDIA lane where nothing leaves the card -- */

test('THE ALL-ON-THE-CARD LANE KEEPS THE FRAMES THERE, and the compatible one is untouched', () => {
  // MEASURED ON THE RTX 4070 Ti, 2026-08-24, 60 seconds of output per run. The clock
  // barely moves at 1080p (3.21s -> 3.10s) and the CPU cost collapses (8.13s -> 0.74s of
  // CPU); at 4K both move (18.15s -> 11.02s wall, 55.96s -> 1.25s of CPU). The CPU number
  // is the one that decides how many streams a host serves at once.
  const media = { videoCodec: 'hevc', width: 1920 }
  const cuda = transcode.transcodeArgs({ input: '/x.mkv', media, engine: 'nvenc-cuda' })
  assert.equal(at(cuda, '-hwaccel'), 'cuda')
  assert.equal(at(cuda, '-hwaccel_output_format'), 'cuda', 'the decoded frames stay in card memory')
  assert.equal(at(cuda, '-vf'), 'scale_cuda=format=nv12', 'and the 10-bit conversion happens there too')
  assert.equal(at(cuda, '-c:v'), 'h264_nvenc')
  assert.equal(cuda.includes('hwupload_cuda'), false, 'nothing is uploaded: it never came down')

  // The compatible lane is still exactly what it was, which is the regression that
  // matters: a machine whose ffmpeg has no scale_cuda lands here and builds the argv it
  // built yesterday.
  const nvenc = transcode.transcodeArgs({ input: '/x.mkv', media, engine: 'nvenc' })
  assert.equal(nvenc.includes('-hwaccel_output_format'), false)
  assert.equal(at(nvenc, '-vf'), 'format=nv12')

  // Nothing else about the conversion is a lane question.
  for (const flag of ['-map_chapters', '-b:v', '-movflags', '-f', '-c:v']) {
    assert.equal(at(cuda, flag), at(nvenc, flag), `${flag} is not a lane question`)
  }
})

test('SOFTWARE FRAMES TAKE THE SAME ANSWER ON BOTH NVIDIA LANES', () => {
  // Burning in a subtitle and tone mapping are CPU filters, so the frames are in system
  // memory already and there is nothing to save by uploading them by hand - the encoder
  // uploads them itself. Deliberately identical, so a burn-in is one graph and not two.
  const cuda = engines.engineFor('nvenc-cuda')
  const nvenc = engines.engineFor('nvenc')
  assert.deepEqual(cuda.inputArgs({ device: null, software: true }), [])
  assert.equal(cuda.toEngine, nvenc.toEngine)

  const media = { videoCodec: 'mpeg4', width: 720 }
  const sw = transcode.transcodeArgs({ input: '/x.avi', media, engine: 'nvenc-cuda' })
  assert.equal(sw.includes('-hwaccel'), false, 'nothing to accelerate on the way in')
  assert.equal(at(sw, '-vf'), 'format=nv12')
  assert.equal(at(sw, '-c:v'), 'h264_nvenc', 'and the encode is still on the card')

  const burned = hls.segmentArgs({
    input: '/x.mkv', seq: 0, media: { videoCodec: 'hevc', width: 1920 },
    device: null, hwDecode: true, bitrate: '6M', engine: 'nvenc-cuda', burn: { index: 2 }
  })
  assert.equal(burned.includes('-hwaccel'), false, 'burn-in decodes in software, on either lane')
  assert.match(burned[burned.indexOf('-filter_complex') + 1], /overlay\[ov\];\[ov\]format=nv12\[out\]$/)
  assert.equal(burned.includes('scale_cuda'), false, 'a CUDA filter has no CUDA frames to work on here')
})

test('THE HLS PATH TAKES THE CARD LANE TOO', () => {
  const base = {
    input: '/x.mkv', seq: 0, media: { videoCodec: 'hevc', width: 3840 },
    device: null, hwDecode: true, bitrate: '6M'
  }
  const seg = hls.segmentArgs({ ...base, engine: 'nvenc-cuda' })
  assert.equal(at(seg, '-hwaccel_output_format'), 'cuda')
  assert.equal(at(seg, '-vf'), 'scale_cuda=format=nv12')
  assert.equal(at(seg, '-c:v'), 'h264_nvenc')

  // A tone is a software filter, so it takes the other lane, prefix and all.
  const toned = hls.segmentArgs({ ...base, engine: 'nvenc-cuda', tone: 'bw' })
  assert.equal(toned.includes('-hwaccel'), false)
  assert.match(at(toned, '-vf'), /,format=nv12$/)
  assert.equal(toned.includes('scale_cuda'), false)
})

test('AN ffmpeg WITHOUT scale_cuda FALLS BACK TO THE COMPATIBLE LANE', () => {
  // `scale_cuda` is a BUILD option rather than a card feature: the vendored ffmpeg the
  // desktop ships carries it and Fedora's own ffmpeg 8.1 does not (checked 2026-08-24,
  // "No such filter: 'scale_cuda'", exit 8, no bytes). So the probe has to ask for the
  // filter by name, or the engine would be chosen off a build's reputation - which is the
  // AV1 mistake exactly.
  const cuda = engines.engineFor('nvenc-cuda')
  const probe = cuda.probeArgs(null).join(' ')
  assert.match(probe, /scale_cuda/, 'the probe asks for the filter that distinguishes this lane')
  assert.match(probe, /hwupload_cuda/, 'having put a software test frame on the card to run it on')
  assert.match(probe, /h264_nvenc/, 'and it runs the encoder it claims')
})

test('a build with no scale_cuda lands on the compatible NVIDIA lane, not on nothing', async () => {
  // The whole point of two candidates. The fake refuses the filter the way Fedora's
  // ffmpeg does and accepts the plain encode, so the machine still converts.
  const bin = await fakeFfmpeg(`
    case "$*" in
      *h264_vaapi*) echo "Failed to initialise VAAPI connection: -1 (unknown libva error)." >&2; exit 1 ;;
      *scale_cuda*) echo "[AVFilterGraph @ 0x1] No such filter: 'scale_cuda'" >&2; exit 8 ;;
      *h264_nvenc*) printf "mp4bytes"; exit 0 ;;
    esac
    exit 1
  `)
  const out = await transcode.chooseEngine({ ffmpeg: bin, platform: 'linux' })
  assert.equal(out.available, true)
  assert.equal(out.engine, 'nvenc', 'the card still converts, on the lane the build can run')
  assert.equal(out.label, 'NVIDIA graphics')
  assert.match(out.tried.find((t) => t.engine === 'nvenc-cuda').reason, /No such filter/)
})

test('PEARCINEMA_ENGINE can pin either NVIDIA lane', async () => {
  // Which is the rollback if the card lane ever misbehaves on somebody's driver.
  const bin = await fakeFfmpeg('printf "mp4bytes"; exit 0')
  for (const id of ['nvenc', 'nvenc-cuda']) {
    const pinned = await transcode.chooseEngine({ ffmpeg: bin, only: id })
    assert.equal(pinned.engine, id)
    assert.equal(pinned.tried.every((t) => t.engine === id), true, 'nothing else is even asked')
  }
})

// THE FIELD REPORT OF 2026-08-29, verbatim: a Ryzen 5900X with a 4080 on Linux Mint,
// NVIDIA driver 580, and the engine test saying "did not pass" with VAAPI's error as the
// only explanation. The real reason was four lines into NVENC's stderr.
const MINT_4080_STDERR = `[h264_nvenc @ 0x628e690c4cc0] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0
[h264_nvenc @ 0x628e690c4cc0] The minimum required Nvidia driver for nvenc is 610.00 or newer
[vost#0:0/h264_nvenc @ 0x628e690c47c0] [enc:h264_nvenc @ 0x628e690c4c00] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.
[vf#0:0 @ 0x628e690e0200] Error sending frames to consumers: Function not implemented
[out#0/null @ 0x628e690c4400] Nothing was written into output file, because at least one of its streams received no packets.`

test('THE REASON IS THE CAUSE, NOT THE LAST LINE, and the NVIDIA driver case gets a sentence', () => {
  const out = engines.explain(MINT_4080_STDERR)
  assert.match(out.reason, /minimum required Nvidia driver for nvenc is 610\.00/)
  assert.match(out.plain, /driver is older than this build of the converter needs/)
  assert.match(out.plain, /driver 610 or newer/)
  assert.match(out.plain, /encoding interface 13\.0, the converter was built for 13\.1/)
  // The symptom line never wins on its own.
  assert.equal(engines.explain('a\nNothing was written into output file').reason, 'Nothing was written into output file')
  assert.equal(engines.explain('a\nNothing was written into output file').plain, null)
  assert.match(engines.explain('').reason, /no output/)
  // VAAPI's own words keep their meaning.
  assert.match(engines.explain('[AVHWDeviceContext @ 0x1] Failed to initialise VAAPI connection: -1 (unknown libva error).\nDevice creation failed: -5.\nError parsing global options: Input/output error').reason, /VAAPI connection/)
})

test('EVERY ENGINE TRIED IS NAMED WITH ITS OWN REASON, so the second one is not hidden behind the first', async () => {
  // VAAPI fails as it does on every NVIDIA-only Linux box, then NVENC fails for the
  // driver. The summary keeps VAAPI's line (the first candidate), and `tried` carries
  // NVENC's plain sentence and label for the dashboard to show.
  const bin = await fakeFfmpeg(`#!/bin/sh
case "$*" in
  *h264_nvenc*) cat >&2 <<'ERR'
${MINT_4080_STDERR}
ERR
    exit 1 ;;
  *) echo "Error parsing global options: Input/output error" >&2; exit 1 ;;
esac`)
  const out = await engines.pickEngine({
    ffmpeg: bin,
    candidates: [
      { engine: engines.engineFor('vaapi'), device: '/dev/dri/renderD128' },
      { engine: engines.engineFor('nvenc-cuda'), device: null },
      { engine: engines.engineFor('nvenc'), device: null }
    ]
  })
  assert.equal(out.available, false)
  assert.match(out.reason, /Error parsing global options/)
  const nv = out.tried.find((t) => t.engine === 'nvenc')
  assert.equal(nv.label, 'NVIDIA graphics')
  assert.match(nv.plain, /driver 610 or newer/)
  assert.match(nv.reason, /minimum required Nvidia driver/)
  assert.equal(out.tried[0].plain, null, 'a cause with no plain sentence carries none')
})

test('THE SHIPPED FFMPEG IS THE 8.1 RELEASE LINE, which NVIDIA driver 570 satisfies', () => {
  // BtbN builds master against encoding interface 13.1 (driver 610+) and the release
  // lines up to 8.1 against 13.0 (driver 570+). Mint and Ubuntu offer 580 today.
  const fs = require('fs')
  const script = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'fetch-ffmpeg.sh'), 'utf8')
  assert.ok(!script.includes('ffmpeg-master-latest'), 'never the development tip')
  assert.match(script, /FF_LINE="\$\{FF_LINE:-8\.1\}"/)
  assert.match(script, /ffmpeg-n\$\{FF_LINE\}-latest-linux64-lgpl-\$\{FF_LINE\}\.tar\.xz/)
  assert.match(script, /ffmpeg-n\$\{FF_LINE\}-latest-win64-lgpl-\$\{FF_LINE\}\.zip/)
})
