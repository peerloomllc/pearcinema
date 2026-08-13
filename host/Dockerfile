# The PearCinema host as a container, for Umbrel and any Docker host.
#
# Port 8742, NOT 8741: PearTune already publishes 8741 on Umbrel and PearCircle's
# seeder has 8731. Two PeerLoom apps on one box cannot share a port, and a box
# running both PearTune and PearCinema is an expected setup rather than an edge
# case.
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
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libatomic1 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The shared host package first, and INSTALLED IN PLACE, so the `file:` dependency
# below resolves to a real directory rather than a symlink into nowhere.
COPY peerloom-host/package.json peerloom-host/package-lock.json /peerloom-host/
RUN cd /peerloom-host && npm ci --omit=dev --no-audit --no-fund
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
# failure mode that matters is a host that is running and unreachable. Left out
# until the dashboard exists to answer one honestly.

ENTRYPOINT ["node", "host/index.js"]
