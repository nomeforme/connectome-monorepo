# syntax=docker/dockerfile:1
# The being image: connectome-house's own runtime deps + src/walker.mjs as
# entrypoint. No bot-runtime, no pi. Mirrors docker/house/Dockerfile's
# base+deps recipe by hand (same fork convention as being-runtime.Dockerfile/
# bot-runtime.Dockerfile) since BuildKit has no cross-file stage reuse;
# docker/house/Dockerfile also gained an equivalent `being` target for a
# single-file build alternative.
#
# harness-port W6-B, 2026-09-19 ("the seat moves into the being",
# docs/harness-port/13-walker-port.md §4): this image now ALSO builds
# mcpl-discord and ships mcpl-signal, exactly as docker/house/Dockerfile
# does for the house, plus mcpl-web (the web-board seat, being-hosted
# only) — a being-hosted platform child (platform-runner.mjs,
# src/mcpl/child.mjs) runs IN THIS container now, not the house's.

FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
# `git` (not just a nicety): mcpl-discord-build's `npm install` resolves its
# `github:anima-research/discord-mcpl#…` dependency by shelling out to git —
# see docker/house/Dockerfile's own base stage for the exact failure this
# avoids (P-E, 2026-09-17).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y curl ca-certificates tini git \
    python3 make g++ openssh-client rsync \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /workspace

# --- pnpm workspace: what the walker needs, plus mcpl-signal and mcpl-web (being-
# hosted servers, run as stdio children of THIS container's walker now) ---
FROM base AS deps
WORKDIR /workspace
RUN cat > package.json <<'EOF'
{"private":true,"packageManager":"pnpm@9.15.4"}
EOF
RUN cat > pnpm-workspace.yaml <<'EOF'
packages:
  - connectome-house
  - connectome-seat-protocol
  - connectome-seat-client
  - mcpl-signal
  - mcpl-web
EOF

COPY connectome-house/package.json ./connectome-house/
COPY connectome-seat-protocol/package.json ./connectome-seat-protocol/
COPY connectome-seat-client/package.json ./connectome-seat-client/
COPY mcpl-signal/package.json ./mcpl-signal/
COPY mcpl-web/package.json ./mcpl-web/

# --prod: connectome-house's devDependency on ../connectome-seat-client is
# real here (unlike the house image) — the walker dynamically imports it.
RUN --mount=type=cache,id=pnpm-store-being,target=/root/.local/share/pnpm/store \
    pnpm install --prod --no-frozen-lockfile

COPY connectome-house/src/ ./connectome-house/src/
# tools/: the coherence scoreboard runs from this image (it holds the route credentials, the house does not)
COPY connectome-house/tools/ ./connectome-house/tools/
# membrane's native request builder drops `document` blocks (PDFs) — the
# walker is where membrane runs; fails the build if the anchor moves
RUN node connectome-house/tools/patch-membrane.mjs node_modules
COPY connectome-seat-protocol/src/ ./connectome-seat-protocol/src/
COPY connectome-seat-client/src/ ./connectome-seat-client/src/
COPY mcpl-signal/src/ ./mcpl-signal/src/
COPY mcpl-web/src/ ./mcpl-web/src/

# --- mcpl-discord: the pinned upstream server, installed + built fresh,
# never vendored — verbatim copy of docker/house/Dockerfile's own stage
# (mcpl-discord/README.md's own recipe; kept in sync by hand, no cross-file
# stage reuse in BuildKit) ---
# --- the CLIs a being's terminal reaches for, as the fleet bot image
# carried them: Claude Code (the agent-spawning skill) and uv ---
FROM base AS external-tools
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    cp -L /root/.local/bin/claude /usr/local/bin/claude
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

FROM base AS mcpl-discord-build
WORKDIR /workspace/mcpl-discord
COPY mcpl-discord/package.json ./
# patches/ must precede the install: package.json's postinstall applies them
COPY mcpl-discord/patches ./patches
RUN npm install --no-audit --no-fund && npm run build

# --- runtime: non-root `house` user, same convention as docker/house/Dockerfile ---
FROM deps AS runtime
COPY --from=mcpl-discord-build /workspace/mcpl-discord /workspace/mcpl-discord
COPY mcpl-discord/run.sh /workspace/mcpl-discord/run.sh
RUN chmod +x /workspace/mcpl-discord/run.sh

COPY --from=external-tools /usr/local/bin/claude /usr/local/bin/claude
COPY --from=external-tools /usr/local/bin/uv /usr/local/bin/uv
# `coder`: the agent-spawning skill runs Claude Code as this user (it
# refuses to skip permissions as root); /home/coder is a tmpfs at runtime
RUN useradd -m -s /bin/bash house \
    && useradd -m -s /bin/bash coder \
    && mkdir -p /workspace/runs /workspace/private /workspace/shared /workspace/house-seat /workspace/house-store /workspace/skills \
    && chown -R house:house /workspace
USER house
WORKDIR /workspace/connectome-house
ENV NODE_ENV=production

# HOUSE_SEAT_ADDR/HOUSE_SEAT_ROOM/HOUSE_BEING ride in as env (compose's
# x-being anchor) — read here at container start, not baked into CMD, so
# the same image serves any being/room/seat combination. HOUSE_PLATFORMS_FILE
# (this being's own servers.json, W6-B) is read the same way, by
# walk-args.mjs directly — no CMD change needed for it.
CMD ["sh", "-c", "exec node src/walker.mjs --being \"$HOUSE_BEING\" --seat \"$HOUSE_SEAT_ADDR\" ${HOUSE_SEAT_ROOM:+--room \"$HOUSE_SEAT_ROOM\"}"]
