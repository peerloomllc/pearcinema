# Host capacity: VIDEO transcode and remux

**Status:** measured 2026-08-13 on the real Umbrel (Intel N100), against real files off
the real 3 TB library, with the box's usual two dozen containers running.
**Question this answers:** "How many devices can watch transcoded or remuxed video from
a PearCinema host at once, and what is the limit?"

**Read this instead of `peartune/docs/transcode-capacity.md` for anything video.**
That doc measured AUDIO and its own caveats say its conclusions do not transfer. They
do not: its headline is that transcode CPU is almost never the bottleneck, and for
video the CPU is not merely a bottleneck - it is a wall.

## TL;DR

- **The video ENGINE is the answer and the CPU is not, categorically.** The N100's
  engine converts a 1080p 10-bit HEVC stream to H.264 at 7.3x realtime and holds
  **~10.5x realtime aggregate flat from 2 to 8 concurrent streams**, using about a
  third of one CPU core in total. The same conversion in software held **1.02x
  realtime for ONE stream on the whole 4-core chip** - a degraded box serving one
  viewer, with nothing left for the host itself.
- So the ceiling is the engine's: **~10 concurrent 1080p transcodes** on an N100.
  PearCinema caps at 4 by default (`PEARCINEMA_MAX_TRANSCODE`), leaving engine
  headroom for Plex or anything else sharing `/dev/dri`, and refuses the fifth
  viewer with a BUSY rather than degrading all five.
- **Remux is nearly free and is not this doc's problem.** Repackaging is I/O bound:
  the real 2.5 GB copy of 2001 rewrapped 1.3 GB in about twenty seconds with no
  encoder involved. The cap (3, `PEARCINEMA_MAX_REMUX`) exists for disk I/O, not CPU.
- **Off the LAN, the uplink bites long before the engine does.** A transcoded stream
  is ~6 Mbps at 1080p; the engine's ten-stream ceiling needs a 60 Mbps uplink before
  it is even reachable. Most home uplinks are the limit at one to four remote
  viewers, which is the same order as the no-relay arithmetic already assumed.

## Measured results

1080p 10-bit HEVC in (the real library's common case - every x265 episode sampled is
Main 10), H.264 at 6 Mbps out, full-hardware VAAPI pipeline, free
`intel-media-va-driver` from Debian main:

| Load | Result |
| --- | --- |
| 1 stream | 7.3x realtime |
| 2 streams | all realtime, aggregate 10.4x |
| 4 streams | all realtime, aggregate 10.7x |
| 8 streams | all realtime (300s of content in 227.6s), aggregate 10.5x |
| software x264 (veryfast) | 1.02x realtime, ONE stream, the whole CPU |

CPU during the 8-stream run: ~0.4 cores across everything, the host's Node loop
undisturbed. The flat aggregate from 2 to 8 says the engine is the resource and it
schedules fairly; the ceiling is where aggregate/N drops under 1x, at about ten.

This is why the transcode proposal's rule 3 - **software encoding never starts, on
any box, ever** - is a hard rule rather than a preference. The measured cost of
breaking it is the whole machine.

## The uplink table, at video rates

Transcoded output is ~6 Mbps at 1080p, ~3 Mbps at 720p. Direct-played and remuxed
files stream at the SOURCE's bitrate, commonly 4-15 Mbps for the real library.

| Home upload | Concurrent 6 Mbps streams |
| --- | --- |
| 10 Mbps | 1 |
| 25 Mbps | 4 |
| 40 Mbps | 6 |
| 100 Mbps (fiber) | 16 |

Compare audio's table, where a 10 Mbps uplink carried ~75 streams. Video moves the
bottleneck: on the LAN the engine is the limit, off the LAN the uplink almost always
is. The audio doc's "the box is never the problem" holds only in its own domain.

## Platform notes

- **Intel N100 (Umbrel Home): measured, above.** The one box these numbers are FROM;
  everything else here is inference, flagged as such.
- **Intel with Quick Sync generally** (the Start9's i5-7500T included): the same
  VAAPI path should work and older engines are slower - unmeasured, so nothing is
  promised. The startup probe decides per box, which is the point of having it.
- **Raspberry Pi class: no.** No usable H.264 encode engine at these rates; the
  probe fails closed and those hosts refuse transcode-only files honestly.
- **Software fallback: does not exist**, see above.

## Caveats

- One box, one encoder generation, single-session measurements with headroom. Treat
  as order-of-magnitude, like the audio doc before it.
- The bitrate ladder (6M/3M/1.5M by width) is a starting point, not a measurement of
  perceived quality.
- Encode quality of `h264_vaapi` at 6 Mbps was eyeballed, not scored. Nobody has
  compared it against x264 output at the same rate; if that ever matters, measure it
  rather than arguing about it.

## Reproduce it

On the box, in a throwaway container built from the shipped image with `/dev/dri`
passed in (`docker run --device /dev/dri:/dev/dri ...`) and the driver installed
(`apt-get install intel-media-va-driver`):

```bash
# single-stream speed against a real episode
time ffmpeg -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -i EPISODE.mkv -vf scale_vaapi=format=nv12 -c:v h264_vaapi -b:v 6M -an -t 300 -f null -

# N concurrent: run N of those in parallel on N different files; all keeping
# realtime = the batch of 300s clips finishes in under 300s. The 2026-08-13 run
# used 8 distinct 1080p 10-bit HEVC episodes off the real drive.
```
