# syntax=docker/dockerfile:1
# being-example's own build recipe (docs/harness-port/09-container-proof.md,
# builder P-E, 2026-09-17) — a FORK of docker/bot-runtime.Dockerfile, not an
# edit to it: that file builds every fleet bot-* service's image
# (docker-compose.yml's `x-bot-runtime` anchor), out of this task's owned
# scope (docker-compose.yml house-profile services + docker/house/** only —
# see the task brief's OWNED FILES / NO-TOUCH). The one substantive
# difference from the original, below, is two added workspace packages
# (connectome-seat-protocol, connectome-seat-client) that bot-runtime's own
# package.json (a separate submodule, already on this branch) now depends
# on for seat mode — bot-runtime.Dockerfile's own embedded pnpm-workspace.yaml
# was never updated for that dependency, so `pnpm install` in the ORIGINAL
# file fails with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND
# ("@connectome/seat-protocol@workspace:*" ... "no package ... present in
# the workspace") the first time anything actually builds it — hit on this
# round's first `being-example` build attempt. That is a real, pre-existing
# gap in the shared Dockerfile (it would break the NEXT fleet-bot rebuild
# too, independent of this task), reported upstream in
# docs/harness-port/09-container-proof.md rather than fixed in place there.
#
# Everything else below is copied verbatim from docker/bot-runtime.Dockerfile
# (same base image, same tool installs, same runtime user/paths) so
# being-example stays "the same image the fleet's bot-* services use" in
# every respect this round didn't have to change.
#
# Packages: bot-runtime, agent-core, grpc-common, axon-binding,
#           axon-interfaces, connectome-ts, axon-server,
#           connectome-seat-protocol, connectome-seat-client (added)

FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y \
    curl ca-certificates python3 make g++ git tini openssh-client rsync \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /workspace

# --- security tools (parallel) ---
FROM base AS security-tools
COPY docker/landlock-exec.c /tmp/landlock-exec.c
RUN gcc -O2 -static -o /usr/local/bin/landlock-exec /tmp/landlock-exec.c && \
    rm /tmp/landlock-exec.c

# --- external tools (parallel) ---
FROM base AS external-tools
RUN git clone --depth 1 https://github.com/rawwerks/ypi.git /opt/ypi && \
    chmod +x /opt/ypi/rlm_query /opt/ypi/rlm_parse_json /opt/ypi/rlm_cost
RUN curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    cp /root/.local/bin/claude /usr/local/bin/claude
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# --- workspace scaffold ---
FROM base AS deps
WORKDIR /workspace

RUN cat > package.json <<'EOF'
{"private":true,"packageManager":"pnpm@9.15.4","devDependencies":{"turbo":"^2.8.0"}}
EOF
# connectome-seat-protocol + connectome-seat-client added (see header) —
# seat-client is bot-runtime's own real `dependencies` entry (seat-mode.ts's
# SeatClient); seat-protocol is seat-client's own `dependencies` entry in
# turn (connectome-seat-client/package.json), so both are needed whether or
# not bot-runtime's own reference to seat-protocol is dev-only.
RUN cat > pnpm-workspace.yaml <<'EOF'
packages:
  - connectome-axon-interfaces
  - connectome-grpc-common
  - connectome-axon-binding
  - connectome-ts
  - axon-server
  - connectome-agent-core
  - connectome-seat-protocol
  - connectome-seat-client
  - bot-runtime
EOF
RUN cat > turbo.json <<'EOF'
{"$schema":"https://turbo.build/schema.json","tasks":{"build":{"dependsOn":["^build"],"inputs":["src/**/*.ts","tsconfig.json","package.json"],"outputs":["dist/**"]}}}
EOF
RUN cat > tsconfig.base.json <<'EOF'
{"compilerOptions":{"target":"ES2022","module":"ES2022","moduleResolution":"bundler","lib":["ES2022"],"strict":true,"esModuleInterop":true,"skipLibCheck":true,"forceConsistentCasingInFileNames":true,"declaration":true,"declarationMap":true,"sourceMap":true,"resolveJsonModule":true,"isolatedModules":true}}
EOF

# --- deps ---
COPY connectome-axon-interfaces/package.json ./connectome-axon-interfaces/
COPY connectome-grpc-common/package.json ./connectome-grpc-common/
COPY connectome-axon-binding/package.json ./connectome-axon-binding/
COPY connectome-ts/package.json ./connectome-ts/
COPY axon-server/package.json ./axon-server/
COPY connectome-agent-core/package.json ./connectome-agent-core/
COPY connectome-seat-protocol/package.json ./connectome-seat-protocol/
COPY connectome-seat-client/package.json ./connectome-seat-client/
COPY bot-runtime/package.json ./bot-runtime/

RUN --mount=type=cache,id=pnpm-store-bot-runtime,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile

# --- build ---
FROM deps AS build

COPY connectome-axon-interfaces/tsconfig.json ./connectome-axon-interfaces/
COPY connectome-axon-interfaces/src/ ./connectome-axon-interfaces/src/
COPY connectome-grpc-common/tsconfig.json ./connectome-grpc-common/
COPY connectome-grpc-common/src/ ./connectome-grpc-common/src/
COPY connectome-grpc-common/proto/ ./connectome-grpc-common/proto/
COPY connectome-axon-binding/tsconfig.json ./connectome-axon-binding/
COPY connectome-axon-binding/src/ ./connectome-axon-binding/src/
COPY connectome-axon-binding/proto/ ./connectome-axon-binding/proto/
COPY connectome-ts/tsconfig.json ./connectome-ts/
COPY connectome-ts/src/ ./connectome-ts/src/
COPY axon-server/tsconfig.json ./axon-server/
COPY axon-server/src/ ./axon-server/src/
COPY connectome-agent-core/tsconfig.json ./connectome-agent-core/
COPY connectome-agent-core/src/ ./connectome-agent-core/src/
COPY connectome-seat-protocol/src/ ./connectome-seat-protocol/src/
COPY connectome-seat-client/src/ ./connectome-seat-client/src/
COPY bot-runtime/tsconfig.json ./bot-runtime/
COPY bot-runtime/src/ ./bot-runtime/src/

RUN --mount=type=cache,id=turbo-cache-bot-runtime,target=/workspace/node_modules/.cache/turbo \
    pnpm turbo run build --filter=@connectome/bot-runtime

# --- runtime ---
FROM build AS runtime

COPY --from=security-tools /usr/local/bin/landlock-exec /usr/local/bin/landlock-exec
COPY --from=external-tools /opt/ypi /workspace/ypi
RUN ln -s /workspace/ypi/rlm_query /usr/local/bin/rlm_query && \
    ln -s /workspace/ypi/rlm_parse_json /usr/local/bin/rlm_parse_json && \
    ln -s /workspace/ypi/rlm_cost /usr/local/bin/rlm_cost
COPY --from=external-tools /usr/local/bin/claude /usr/local/bin/claude
COPY --from=external-tools /usr/local/bin/uv /usr/local/bin/uv

COPY skills ./skills
COPY docker/bot-entrypoint.sh /usr/local/bin/bot-entrypoint.sh

RUN useradd -m -s /bin/bash coder && \
    mkdir -p /workspace/shared && chown coder:coder /workspace/shared
RUN mkdir -p /home/coder/.claude && \
    echo '{"theme":"dark","hasCompletedOnboarding":true,"preferredNotifChannel":"terminal"}' > /home/coder/.claude/settings.json && \
    touch /home/coder/.claude/.setupCompleted && \
    chown -R coder:coder /home/coder/.claude

WORKDIR /workspace/bot-runtime

ENV NODE_ENV=production
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["bot-entrypoint.sh"]
