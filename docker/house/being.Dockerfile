# syntax=docker/dockerfile:1
# The being image: connectome-house's own runtime deps + src/walker.mjs as
# entrypoint. No bot-runtime, no pi, no mcpl-discord/mcpl-signal (house-side
# only). Mirrors docker/house/Dockerfile's base+deps recipe by hand (same
# fork convention as being-runtime.Dockerfile/bot-runtime.Dockerfile) since
# BuildKit has no cross-file stage reuse; docker/house/Dockerfile also
# gained an equivalent `being` target for a single-file build alternative.

FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y curl ca-certificates tini \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /workspace

# --- pnpm workspace: only what the walker needs (no mcpl-*, no bot-runtime) ---
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
EOF

COPY connectome-house/package.json ./connectome-house/
COPY connectome-seat-protocol/package.json ./connectome-seat-protocol/
COPY connectome-seat-client/package.json ./connectome-seat-client/

# --prod: connectome-house's devDependency on ../connectome-seat-client is
# real here (unlike the house image) — the walker dynamically imports it.
RUN --mount=type=cache,id=pnpm-store-being,target=/root/.local/share/pnpm/store \
    pnpm install --prod --no-frozen-lockfile

COPY connectome-house/src/ ./connectome-house/src/
# tools/: the coherence scoreboard runs from this image (it holds the route credentials, the house does not)
COPY connectome-house/tools/ ./connectome-house/tools/
COPY connectome-seat-protocol/src/ ./connectome-seat-protocol/src/
COPY connectome-seat-client/src/ ./connectome-seat-client/src/

# --- runtime: non-root `house` user, same convention as docker/house/Dockerfile ---
FROM deps AS runtime
RUN useradd -m -s /bin/bash house \
    && mkdir -p /workspace/runs /workspace/private /workspace/shared /workspace/house-seat \
    && chown -R house:house /workspace
USER house
WORKDIR /workspace/connectome-house
ENV NODE_ENV=production

# HOUSE_SEAT_ADDR/HOUSE_SEAT_ROOM/HOUSE_BEING ride in as env (compose's
# x-being anchor) — read here at container start, not baked into CMD, so
# the same image serves any being/room/seat combination.
CMD ["sh", "-c", "exec node src/walker.mjs --being \"$HOUSE_BEING\" --seat \"$HOUSE_SEAT_ADDR\" ${HOUSE_SEAT_ROOM:+--room \"$HOUSE_SEAT_ROOM\"}"]
