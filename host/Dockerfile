# The PearCinema host as a container, for Umbrel and any Docker host.
#
# THE SUITE'S PORT MAP, and it is a map rather than a preference because a box
# running several of these at once is the expected setup rather than an edge case:
#
#   8731  PearCircle seeder
#   8741  PearTune dashboard
#   8742  PearTune CAST server   <- host/cast.js, and the reason 8742 is not ours
#   8751  PearCinema dashboard   <- this
#   8752  PearCinema cast, reserved for when casting lands
#
# PearCinema originally took 8742 on the reasoning that PearTune "has 8741". That was
# wrong: PearTune binds BOTH, and the second one is its Chromecast media server. The
# collision was invisible until the image was actually run on a real Umbrel alongside
# a real PearTune (2026-08-13) - the host came up, scanned the whole library, and then
# died with EADDRINUSE. Leave a gap between apps rather than taking the next number.
#
# BUILD CONTEXT IS THE SUITE ROOT'S STAGING DIR, not this repo. PearCinema depends
# on `@peerloom/host` via `file:../peerloom-host`, which is outside the repo and
# therefore outside a normal build context. `host/build-image.sh` stages the two
# directories side by side into a temp dir and builds from there - do not run
# `docker build` here by hand and wonder why the dependency cannot be found.
#
#   ./host/build-image.sh 0.1.0
#
# Simpler than PearCircle's seeder image on purpose: the seeder stages a Bare
# runtime and a bare-pack'd worklet bundle because it runs the APP's worklet. This
# host is plain Node - a server, not a peer of the app - so there is no Bare payload
# and no cross-arch prebuild dance.

FROM node:20-bookworm-slim

# Runtime libs the slim image lacks:
#
#   libatomic1      - rocksdb-native links libatomic.so.1
#   ca-certificates - TLS, for the Jellyfin adapter
#   ffmpeg          - FFPROBE, and it is NOT optional here.
#
# The ffmpeg package is the one real size cost this image carries over PearTune's,
# and it buys the thing that makes PearCinema more than a Jellyfin accessory: the
# FOLDER adapter cannot identify a single file without ffprobe. A folder source with
# no ffprobe is not a degraded library, it is no library at all.
#
# Debian ships no ffprobe-only package, so this pulls the encoders too. That is
# accepted rather than worked around: remux is already on the roadmap (83% of a
# measured real library is in a container an iPhone will not open), and it needs
# exactly this binary.
#
#   intel-media-va-driver - the VA driver hardware transcode needs, and the FREE one
#                           from main, measured sufficient on the real N100
#                           (DECISIONS 2026-08-13): full decode and encode
#                           entrypoints including HEVC Main 10 and H.264 encode. The
#                           `-non-free` variant the TODO guessed at is not needed,
#                           so neither is a non-free apt component. Harmless on a
#                           box with no GPU - the startup probe fails and the
#                           transcode mode stays off.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libatomic1 ffmpeg intel-media-va-driver \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The shared host package first, and INSTALLED IN PLACE, so the `file:` dependency
# below resolves to a real directory rather than a symlink into nowhere.
# NOT `--omit=dev` HERE, and the difference is the image starting at all.
#
# @peerloom/host declares its runtime packages (b4a, hyperdht, corestore and the
# rest) as devDependencies plus peerDependencies rather than dependencies - the
# consumer-provides model. That works in a checkout because npm links the `file:`
# dependency and Node resolves through the symlink to the REAL directory, which walks
# up into peerloom-host/node_modules where a plain `npm install` has put them.
#
# In the image `--omit=dev` installed literally nothing, and the first `require` out
# of the package died with MODULE_NOT_FOUND. The container exited at startup, every
# time - found 2026-08-13, the first time anyone actually ran the image rather than
# checking that it built.
COPY peerloom-host/package.json peerloom-host/package-lock.json /peerloom-host/
RUN cd /peerloom-host && npm ci --no-audit --no-fund
COPY peerloom-host/src/ /peerloom-host/src/

# Deps before code, so a code change does not re-resolve the tree.
COPY pearcinema/package.json pearcinema/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY pearcinema/host/ ./host/

# Containerized defaults. PEARCINEMA_DATA holds the identity seed and the grant
# store - losing it means every device must re-pair, and leaking it means somebody
# can impersonate the library.
ENV PEARCINEMA_DATA=/data \
    PEARCINEMA_NAME="My Library"

# The scan cache lives in the data dir too, which matters more here than it looks:
# re-probing a 3 TB drive is twenty minutes of disk on every restart otherwise.
VOLUME /data

# A HEALTHCHECK that only proves the process is up would be worse than none - the
# failure mode that matters is a host that is running and unreachable. Now that the
# web interface exists there is something honest to ask: it answers 200 with either
# the login page or the app, and a 401 or a refused connection means the operator
# genuinely cannot get in.
#
# 127.0.0.1 rather than the bind address, because network_mode: host means loopback
# reaches it whatever PEARCINEMA_HTTP_HOST says. start-period covers the folder scan,
# which on a 3 TB drive is minutes on a cold cache.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PEARCINEMA_HTTP_PORT||8751,path:'/'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "host/index.js"]
