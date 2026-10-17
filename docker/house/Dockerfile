# syntax=docker/dockerfile:1
# House — the house process (docs/harness-port/03-house-design.md): one
# process per box, owner of rooms, the record, per-being lives, and the
# MCPL platform seats. Self-contained build — no shared files from the
# rest of the monorepo beyond the three workspace packages it actually
# needs (matches every other service Dockerfile's own docstring).
#
# Packages baked in:
#   - connectome-house       the house process itself (plain .mjs, no build step)
#   - connectome-seat-protocol  its file: workspace dependency (the being's-turn wire)
#   - mcpl-signal             a Signal MCPL server, spawned as a stdio child
#   - mcpl-discord            an INSTALL RECIPE for the pinned, unlicensed
#                             upstream Discord MCPL server — installed fresh
#                             and built at image-build time, never vendored
#                             into this repo (mcpl-discord/README.md).

FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
# `git` is required here (not just a nicety): mcpl-discord-build (below)
# extends this `base` stage and runs `npm install` against
# mcpl-discord/package.json's own `github:anima-research/discord-mcpl#…`
# dependency — npm shells out to `git` to fetch it. Missing before
# docs/harness-port/09-container-proof.md (builder P-E, 2026-09-17): the
# build failed with `npm error enoent … spawn git` on the very first
# `house` image build attempt.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y \
    curl ca-certificates tini git \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /workspace

# --- external CLIs a being's tools shell out to ---
# polymarket: the upstream installer drops a checksummed release binary in
# /usr/local/bin. Copied into the runtime stage explicitly (an install in a
# side stage that never reaches the runtime image is a silent miss).
FROM base AS external-tools
RUN curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh \
    && /usr/local/bin/polymarket --version

# --- pnpm workspace scaffold: only the packages the house needs ---
FROM base AS deps
WORKDIR /workspace
RUN cat > package.json <<'EOF'
{"private":true,"packageManager":"pnpm@9.15.4"}
EOF
RUN cat > pnpm-workspace.yaml <<'EOF'
packages:
  - connectome-house
  - connectome-seat-protocol
  - mcpl-signal
EOF

COPY connectome-house/package.json ./connectome-house/
COPY connectome-seat-protocol/package.json ./connectome-seat-protocol/
COPY mcpl-signal/package.json ./mcpl-signal/

# connectome-house's own devDependency on "@connectome/seat-client":
# "file:../connectome-seat-client" (test-only — connectome-seat-client is
# NOT a pnpm-workspace.yaml member above, and --prod below never installs
# a devDependency's actual contents) still needs the file: PATH to exist:
# pnpm's own resolution phase stats every file:-protocol dependency before
# --prod filters it out, --prod or not, and refuses with
# ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND otherwise (hit on the first `house`
# image build, docs/harness-port/09-container-proof.md, builder P-E,
# 2026-09-17). A bare manifest is enough to satisfy that stat — no src/
# copied, nothing from the package actually installed or used.
COPY connectome-seat-client/package.json ./connectome-seat-client/package.json

# --prod: connectome-house's own devDependency on ../connectome-seat-client
# (test-only) is never resolved or copied into this image.
RUN --mount=type=cache,id=pnpm-store-house,target=/root/.local/share/pnpm/store \
    pnpm install --prod --no-frozen-lockfile

COPY connectome-house/src/ ./connectome-house/src/
COPY connectome-house/tools/ ./connectome-house/tools/
# membrane's native request builder drops `document` blocks (PDFs); the
# patch adds that branch and fails the build if its anchor ever moves
RUN node connectome-house/tools/patch-membrane.mjs node_modules
COPY connectome-house/README.md ./connectome-house/README.md
COPY connectome-seat-protocol/src/ ./connectome-seat-protocol/src/
COPY mcpl-signal/src/ ./mcpl-signal/src/

# --- being (harness-port W2-prep): the walker-only runtime reusing `deps`
# unchanged, plus the one file `deps` doesn't install for real —
# connectome-seat-client's src — since the house server never needs it,
# only a walker does. Alternative to docker/house/being.Dockerfile's own
# standalone fork for a single-Dockerfile build: `--target being`.
FROM deps AS being
COPY connectome-seat-client/src/ ./connectome-seat-client/src/
RUN useradd -m -s /bin/bash house \
    && mkdir -p /workspace/runs /workspace/private /workspace/shared /workspace/house-seat \
    && chown -R house:house /workspace
USER house
WORKDIR /workspace/connectome-house
ENV NODE_ENV=production
CMD ["sh", "-c", "exec node src/walker.mjs --being \"$HOUSE_BEING\" --seat \"$HOUSE_SEAT_ADDR\" ${HOUSE_SEAT_ROOM:+--room \"$HOUSE_SEAT_ROOM\"}"]

# --- mcpl-discord: the pinned upstream server, installed + built fresh,
# never copied from a prior stage's node_modules into the repo itself
# (this recipe's own README, "Verified on sfo") ---
FROM base AS mcpl-discord-build
WORKDIR /workspace/mcpl-discord
COPY mcpl-discord/package.json ./
# patches/ must precede the install: package.json's postinstall applies them
COPY mcpl-discord/patches ./patches
RUN npm install --no-audit --no-fund && npm run build

# --- runtime ---
FROM deps AS runtime
COPY --from=mcpl-discord-build /workspace/mcpl-discord /workspace/mcpl-discord
COPY mcpl-discord/run.sh /workspace/mcpl-discord/run.sh
RUN chmod +x /workspace/mcpl-discord/run.sh
COPY --from=external-tools /usr/local/bin/polymarket /usr/local/bin/polymarket
# ffmpeg/ffprobe: media-normalize.mjs probes and re-encodes every inbound
# image before it enters the blob store. Without them every image a human
# sent was dropped as "decode-failed" before it was ever recorded.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# /workspace/house-seat is pre-created (and chown'd below) so a FRESH
# named volume mounted there on first `up` gets Docker's own "copy up"
# ownership from this image (house:house) instead of landing root:root —
# the house-runs/private/shared/house-config dirs already got this right;
# house-seat didn't, and a non-root `serve.mjs` got `EACCES` trying to
# listen on a unix socket under a root-owned mount point (this round's
# first `house` boot, docs/harness-port/09-container-proof.md, builder
# P-E, 2026-09-17) — worked around live via `docker compose exec -u root
# house chown house:house /workspace/house-seat` for THAT already-created
# volume (a fresh one on a clean box needs no such workaround).
RUN useradd -m -s /bin/bash house \
    && mkdir -p /workspace/runs /workspace/private /workspace/shared /workspace/house-config /workspace/house-seat \
    && chown -R house:house /workspace
USER house

WORKDIR /workspace/connectome-house
ENV NODE_ENV=production
EXPOSE 8787

# GET /api/mcpl: absent auth headers resolve to the loopback "Keeper"
# identity (serve-identity.mjs), so an unauthenticated in-container probe
# gets a real 200, not a 403 — a non-2xx or a refused connection is the
# unhealthy case.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:8787/api/mcpl').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/serve.mjs"]
