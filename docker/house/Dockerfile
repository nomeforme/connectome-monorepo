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
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y \
    curl ca-certificates tini \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /workspace

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

# --prod: connectome-house's own devDependency on ../connectome-seat-client
# (test-only) is never resolved or copied into this image.
RUN --mount=type=cache,id=pnpm-store-house,target=/root/.local/share/pnpm/store \
    pnpm install --prod --no-frozen-lockfile

COPY connectome-house/src/ ./connectome-house/src/
COPY connectome-house/README.md ./connectome-house/README.md
COPY connectome-seat-protocol/src/ ./connectome-seat-protocol/src/
COPY mcpl-signal/src/ ./mcpl-signal/src/

# --- mcpl-discord: the pinned upstream server, installed + built fresh,
# never copied from a prior stage's node_modules into the repo itself
# (this recipe's own README, "Verified on sfo") ---
FROM base AS mcpl-discord-build
WORKDIR /workspace/mcpl-discord
COPY mcpl-discord/package.json ./
RUN npm install --no-audit --no-fund && npm run build

# --- runtime ---
FROM deps AS runtime
COPY --from=mcpl-discord-build /workspace/mcpl-discord /workspace/mcpl-discord
COPY mcpl-discord/run.sh /workspace/mcpl-discord/run.sh
RUN chmod +x /workspace/mcpl-discord/run.sh

RUN useradd -m -s /bin/bash house \
    && mkdir -p /workspace/runs /workspace/private /workspace/shared /workspace/house-config \
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
