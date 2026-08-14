# Hardware transcode - re-encoding the picture on the Intel video engine, and when that is allowed to start

**Status**: APPROVED 2026-08-13 (merged as PR #23)

**Goal**: Play the files repackaging cannot fix - the HEVC television no browser decodes
and the AVI shelf no MP4 can carry - by converting the picture on the host's own video
hardware, under rules that guarantee a transcode can never make a host unusable.

**Tier**: **T3.** Same grounds as remux, one further along: this is the first time the
host RE-ENCODES somebody's film rather than repackaging it, it extends what
`media.stream` can mean with a third mode, and its failure mode is the whole box. A
transcode that starts when it should not is not a failed playback, it is a host that
stops answering - which is why the section on when one may start is the point of this
proposal rather than a detail of it.

**Depends on**: remux (shipped 2026-08-13, PR #14). Transcode is rung three of that
proposal's ladder and reuses its machinery: the `decide()` seam, the pipe-down-the-socket
transport, the session ownership and the kill-on-revoke path. Nothing here replaces any
of that; it adds one more answer `decide()` can give.

---

## Why this is the largest remaining win

The measurements are in DECISIONS 2026-08-13 and are not to be re-derived:

- **HEVC is ~76% of the television library and no browser decodes it.** Repackaging
  cannot help, because it changes the wrapper and never the picture. An iPhone would play
  essentially all of it after remux; a desktop browser gets about a quarter of the TV,
  permanently, until something re-encodes video.
- **Plex, on the same box, in the same browser, plays those files.** It is not playing
  HEVC either - it is converting it to H.264 on the Intel N100's video engine and sending
  the browser something it can decode. That is the existence proof, and it is the answer
  to "why can Plex do this and PearCinema cannot".
- **The 218 AVI files** (7% of the library, all television) cannot be carried by MP4 at
  all and were rung three from the start.

The gap between "refuses 76% of the television" and "plays everything" was measured on
the box as: one driver package, one compose line and the transcode path itself. The first
two turned out to be even smaller than that - see the measurements below.

---

## Measured on the real Umbrel, 2026-08-13

Taken in a throwaway container built from the shipped PearCinema image with `/dev/dri`
passed in and one apt package added, against real episodes off the Elements drive, on the
loaded box with its usual two dozen containers running. Nothing was extrapolated from the
audio-era capacity doc, whose conclusions do not transfer to video and say so.

**The driver is one package, and the free one suffices.** `intel-media-va-driver` from
Debian main - not the `-non-free` variant, so the image needs no new apt component. With
it installed, VAAPI exposes full decode and encode entrypoints on the N100, including
HEVC Main 10 decode and H.264 encode. The kernel and firmware side needed nothing: the
host OS already carries it, which Plex's working transcode had already proven.

**The library's HEVC is 10-bit.** Every x265 episode sampled is Main 10 `yuv420p10le`,
so 10-bit is the common case rather than the edge, and the pipeline below handles the
10-bit-to-8-bit conversion on the engine as part of the scale.

The numbers, 1080p 10-bit HEVC in, H.264 at 6 Mbps out, full-hardware pipeline:

| Load | Result |
| --- | --- |
| 1 stream | **7.3x realtime** |
| 2 streams | all realtime, aggregate 10.4x |
| 4 streams | all realtime, aggregate 10.7x |
| 8 streams | all realtime (300s of content in 227.6s), aggregate 10.5x |
| software x264 for contrast | **1.02x realtime for ONE stream**, the whole 4-core CPU |

The engine saturates at an aggregate of roughly **10.5x realtime** and holds it flat from
2 streams to 8, so the practical ceiling is about ten concurrent 1080p transcodes. CPU
during the 8-stream run was about a third of one core - the video engine does effectively
all of the work, and the host's Node loop, the scan and the dashboard are undisturbed.

The software row is the whole argument for the hard rule below: a CPU encode of the same
file barely keeps ONE viewer at realtime with nothing left for the host itself. On the
N100 that is a degraded box; on a Pi-class box it is an unusable one.

---

## When a transcode may START, which is the actual design

Five rules, in order, and every one of them refuses rather than degrades:

1. **Never when direct play or remux would do.** The ladder order is settled and
   `decide()` already enforces it: direct play wins because it is free and is the actual
   file, remux wins next because it is I/O-bound and cheap. Transcode is the answer of
   last resort. A client cannot ask for one, only describe itself - same rule as remux,
   same reason.

2. **Only on hardware that proved itself at startup.** At boot the host runs a real
   probe: a few frames of synthetic video through the full VAAPI decode-scale-encode
   pipeline. Only a probe that produced valid bytes unlocks the mode. The presence of
   `/dev/dri` is not the test - a device node with no driver behind it initialises and
   then fails, and the probe must catch exactly that. The result is logged and shown on
   the dashboard, so "why does my box refuse to convert" has a visible answer.

3. **Software encoding NEVER starts. There is no fallback.** A host without working
   hardware refuses transcode-only files exactly as it does today, with the same honest
   reason. This is the rule that keeps a Pi-class box alive, and it is a hard rule rather
   than a default: the measured cost of breaking it is the whole box, and a silent
   fallback is precisely how it would get broken.

4. **Under a cap, or refused with BUSY.** Same shape as the Remuxer's existing cap: the
   viewer over the limit is told the host is busy and can try again, rather than every
   viewer getting a slideshow. **Recommended default: 4 concurrent transcodes.** The
   measured ceiling is ~10; 4 leaves the engine headroom for Plex or a second PeerLoom
   app sharing it, and a household with five simultaneous HEVC viewers is not the box
   this ships on. Transcode and remux caps are separate pools, because they exhaust
   different resources - the engine and the disk respectively.

5. **One transcode per viewer.** A seek restarts the session (see Mechanism); the restart
   replaces the old process rather than adding one beside it. The remux path already
   works this way and the same session ownership carries over.

---

## Mechanism

The transport is the shipped remux pipe, unchanged: ffmpeg's output goes straight down
the socket as fragmented MP4, nothing is written to disk, and a seek is the player asking
the host to start again at a new time. Everything DECISIONS 2026-08-13 records about that
design - `delay_moov`, no chapters, one video and one audio stream, argv never a shell
string - applies verbatim, because it is the same code path with different codec flags.

What changes is the codec arguments. The measured invocation, kept here so implementation
does not re-derive it:

```
ffmpeg -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi
       -i <file> -vf scale_vaapi=format=nv12 -c:v h264_vaapi -b:v <rate>
```

- **Output is H.264, always.** It is the one codec every measured client decodes, and
  the mode only runs for clients that cannot decode the source. An HEVC-capable client
  never reaches this path - its HEVC files are remux cases.
- **Decode is hardware where the engine supports the codec** (HEVC, H.264, VP9, AV1) and
  software where it does not (the AVI shelf's MPEG-4 Part 2). Software DECODE of SD
  content is cheap and is not the hazard - rule 3 is about the encode, and the encode is
  on the engine either way.
- **Bitrate by resolution**: 6 Mbps at 1080p, 3 Mbps at 720p, 1.5 Mbps below. One
  rendition, the source's own resolution, no adaptive ladder. The `scale_vaapi` stage
  exists for pixel format, not for resizing.
- **Audio follows the remux rules unchanged**: copied when the client can take it,
  rebuilt to AAC when it cannot.

## What changes on the wire

Additive, and absent means today's behaviour, same as remux:

- **`decide()` gains a third mode, `transcode`**, returned only when the host's probe
  passed, the video codec rules it in and neither cheaper mode applies. The reason string
  says the picture is being converted and why.
- **`media.capabilities` is unchanged.** The client already declares codecs; nothing new
  is needed from it.
- **The web player's refusals become plays.** "This client cannot decode HEVC video"
  stops being a dead end, and the per-list compatibility count starts counting these
  files as playable. The count is the acceptance measurement, see Verify.

## Packaging

- **One line in the Dockerfile**: `intel-media-va-driver` joins the apt install, from
  main, no new component. It is also harmless on a box with no GPU - the probe simply
  fails and the mode stays off.
- **The compose line the file already names**: `devices: - /dev/dri:/dev/dri`, exactly
  where `umbrel/docker-compose.yml` says it would go. The mount points were chosen in
  PR #9 so this is a compose edit and not a redesign, and that promise comes due here.
- **No new privilege.** The device passthrough is the whole grant; `no-new-privileges`
  stays, the library stays `:ro`, the container user is unchanged.

## Scope

**In:**

- H.264 hardware encode via VAAPI, behind the five start rules.
- Hardware decode where supported, software decode for MPEG-4 Part 2.
- The startup probe, the dashboard's report of its result and the BUSY cap.
- The web player consuming it, since that is where it is verifiable today.

**Out, deliberately:**

- **Software video encoding, permanently.** Not deferred - excluded by rule 3.
- **Burning in PGS subtitles.** It needs this encoder, so it becomes POSSIBLE for the
  first time, but it is its own piece of work with its own UI questions - see Open
  questions.
- **Adaptive bitrate, scaling and quality settings.** One rendition, resolution-matched.
- **The Mac and Start9 hosts.** VAAPI is Intel-on-Linux; the Mac path (VideoToolbox) is
  already an open question in the video-deltas proposal and stays there. The Start9's
  i5-7500T has an engine this would likely just work on, but nothing is claimed unmeasured.
- **Pre-transcoding, background conversion and scrub thumbnails.** Same exclusions as
  remux, same reasons.

## Security

Inherited from remux wholesale, because it is the same process model: argv never a shell
string, input paths only from the id-to-path chokepoint, every process owned by a session
and killed with it, `killAll` on revoke and on shutdown. Two additions:

- **The probe runs entirely on synthetic input** generated by ffmpeg itself, so no
  library file is read before a device holds a grant.
- **`/dev/dri` is shared with other containers** (Plex holds it too). That is how the
  device is designed to be used and no isolation is claimed or needed - the engine
  schedules competing work, and the cap plus the BUSY refusal are what keep PearCinema a
  good neighbour on it.

## Compat

- **Old peers**: none in the field, and the shape is additive regardless - a client that
  knows nothing of transcode keeps getting `direct`, `remux` or an honest refusal. An
  unknown mode string never reaches a client that did not declare the capabilities that
  unlock it.
- **No persisted change.** No schema, no scan-cache version, nothing to migrate. The
  probe result is computed at startup and held in memory.

## Verify

1. `npm run verify` green in both repos.
2. **The compatibility count on the real library.** Today a desktop browser reads about a
   quarter of the television as playable. After this it must read effectively all of it,
   and the residue must be explainable file by file.
3. **Play a real 10-bit HEVC episode in the browser, off the Umbrel.** Seek an hour in,
   seek back. The player must say the picture is being converted rather than pretending it
   is the file.
4. **Start one more transcode than the cap allows** and get the BUSY refusal with its
   plain-language message, not a queue and not a slideshow.
5. **Revoke mid-transcode and look at the screen.** Picture stops, process gone - the
   remux acceptance test, re-run on the new path.
6. **The box stays usable at the cap.** With 4 transcodes running, the dashboard answers,
   a direct-play stream starts and the library browses. This is the "a transcode must
   never make a host unusable" claim, tested as behaviour rather than asserted.
7. **A host with no `/dev/dri` refuses cleanly**: probe fails, mode stays off, HEVC files
   refuse with today's reason, nothing crashes. Verifiable on this laptop's Docker with no
   device passed.

## Rollback

- **A config flag, `transcode: off`**, returns the host to remux-and-direct-play, which
  is exactly today's behaviour. Feature rollback.
- **Removing the compose device line** disables the mode at the next start with no other
  effect, because the probe fails closed. Operator rollback.
- **The image digest re-pin** remains the release rollback, unchanged.
- Nothing persisted changes, so there is nothing to migrate back.

## Open questions

1. **Is the cap operator-adjustable?** Recommendation: yes, as a plain settings field
   with 4 as the default and the measured ceiling stated beside it, because a box that
   only ever serves one household member should not be stuck refusing at a limit sized
   for sharing the engine. A cap of zero is then also the `transcode: off` flag for free.

2. **PGS subtitle burn-in - when?** The films' 232 image-based subtitle tracks are
   unshowable today and the encoder this adds is the missing piece. It is deliberately
   not in this scope: it forces a transcode for a file whose PICTURE the client could
   direct-play, which cuts across the ladder and deserves its own thinking. Recommend
   revisiting once this ships and real use shows how often those films are watched with
   subtitles wanted.

3. **Does the phone ever get transcode?** Off-LAN the arithmetic is the no-relay one:
   6 Mbps sustained through a home uplink. On-LAN it is free. Recommendation: the seam
   already answers this per client and nothing phone-specific should be decided before
   there is a phone - same posture as remux took with HLS.
