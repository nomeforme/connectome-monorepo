# syntax=docker/dockerfile:1
# Connectome Multi-Stage Dockerfile
#
# Optimizations:
#   1. BuildKit cache mounts (pnpm store, turbo cache, npm cache)
#   2. Parallel stages: external-tools builds alongside workspace
#   3. Production-only node_modules (dev deps stripped after build)
#   4. Compiled JS runtime (no tsx overhead)
#   5. connectome/axons skip external-tools entirely
#
# Architecture:
#   base ─── workspace-deps ─── workspace-build ─── workspace-prod ─┬─ connectome
#                                                                    ├─ signal-axon
#                                                                    ├─ discord-axon
#                                                                    └─ bot-runtime (+ external-tools)
#   base ─── external-tools (PARALLEL: ypi, skills, CLI tools)

# ============================================
# Stage: base — Ubuntu 24.04 + Node 22 LTS + pnpm
# ============================================
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

# ============================================
# Stage: workspace-deps — Install ALL dependencies (dev + prod, needed for build)
# ============================================
FROM base AS workspace-deps

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json tsconfig.json ./
COPY connectome-axon-interfaces/package.json ./connectome-axon-interfaces/
COPY connectome-grpc-common/package.json ./connectome-grpc-common/
COPY connectome-axon-binding/package.json ./connectome-axon-binding/
COPY connectome-ts/package.json ./connectome-ts/
COPY axon-server/package.json ./axon-server/
COPY connectome-agent-core/package.json ./connectome-agent-core/
COPY bot-runtime/package.json ./bot-runtime/
COPY discord-axon/package.json ./discord-axon/
COPY signal-axon/package.json ./signal-axon/

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ============================================
# Stage: workspace-build — Build all packages, then strip to prod deps
# ============================================
FROM workspace-deps AS workspace-build

# Copy tsconfigs
COPY connectome-axon-interfaces/tsconfig.json ./connectome-axon-interfaces/
COPY connectome-grpc-common/tsconfig.json ./connectome-grpc-common/
COPY connectome-axon-binding/tsconfig.json ./connectome-axon-binding/
COPY connectome-ts/tsconfig.json ./connectome-ts/
COPY axon-server/tsconfig.json ./axon-server/
COPY connectome-agent-core/tsconfig.json ./connectome-agent-core/
COPY bot-runtime/tsconfig.json ./bot-runtime/
COPY discord-axon/tsconfig.json ./discord-axon/
COPY signal-axon/tsconfig.json ./signal-axon/

# Copy source + proto
COPY connectome-axon-interfaces/src/ ./connectome-axon-interfaces/src/
COPY connectome-grpc-common/src/ ./connectome-grpc-common/src/
COPY connectome-axon-binding/src/ ./connectome-axon-binding/src/
COPY connectome-ts/src/ ./connectome-ts/src/
COPY axon-server/src/ ./axon-server/src/
COPY connectome-agent-core/src/ ./connectome-agent-core/src/
COPY bot-runtime/src/ ./bot-runtime/src/
COPY discord-axon/src/ ./discord-axon/src/
COPY signal-axon/src/ ./signal-axon/src/
COPY connectome-grpc-common/proto/ ./connectome-grpc-common/proto/
COPY connectome-axon-binding/proto/ ./connectome-axon-binding/proto/

RUN --mount=type=cache,id=turbo-cache,target=/workspace/node_modules/.cache/turbo \
    pnpm turbo run build

# Strip dev dependencies — keep only production deps for runtime
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ============================================
# Stage: external-tools — ypi, skills, CLI tools (PARALLEL with workspace)
# No pi-mono — not needed by any service at runtime.
# ============================================
FROM base AS external-tools

RUN git clone --depth 1 https://github.com/rawwerks/ypi.git /opt/ypi && \
    chmod +x /opt/ypi/rlm_query /opt/ypi/rlm_parse_json /opt/ypi/rlm_cost

# CLI tools (used by bot-runtime agent tools)
RUN curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    cp /root/.local/bin/claude /usr/local/bin/claude
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# ============================================
# Stage: connectome — Core gRPC server
# ============================================
FROM workspace-build AS connectome

RUN mkdir -p /workspace/connectome-ts/state
WORKDIR /workspace/connectome-ts

ENV NODE_ENV=production
ENV GRPC_PORT=50051
ENV GRPC_HOST=0.0.0.0
ENV PERSISTENCE_ENABLED=true
ENV PERSISTENCE_DIR=/workspace/connectome-ts/state
ENV DEBUG_ENABLED=false
ENV DEBUG_PORT=3015

EXPOSE 50051
EXPOSE 3015

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('net').connect(process.env.GRPC_PORT || 50051).on('error', () => process.exit(1)).on('connect', () => process.exit(0))"

CMD ["node", "--import", "tsx", "src/grpc-main.ts"]

# ============================================
# Stage: signal-axon
# ============================================
FROM workspace-build AS signal-axon
WORKDIR /workspace/signal-axon

ENV NODE_ENV=production
ENV CONNECTOME_GRPC_HOST=connectome:50051
ENV SIGNAL_CLI_WS_URL=ws://signal-cli:8080
ENV SIGNAL_CLI_API_URL=http://signal-cli:8080

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["node", "--import", "tsx", "src/grpc-main.ts"]

# ============================================
# Stage: discord-axon
# ============================================
FROM workspace-build AS discord-axon
WORKDIR /workspace/discord-axon

ENV NODE_ENV=production
ENV CONNECTOME_GRPC_HOST=connectome:50051

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["node", "--import", "tsx", "src/grpc-main.ts"]

# ============================================
# Stage: bot-runtime — Single bot container
# ============================================
FROM workspace-build AS bot-runtime
WORKDIR /workspace

# ypi tools (for rlm_query sub-agent spawning)
COPY --from=external-tools /opt/ypi /workspace/ypi
RUN ln -s /workspace/ypi/rlm_query /usr/local/bin/rlm_query && \
    ln -s /workspace/ypi/rlm_parse_json /usr/local/bin/rlm_parse_json && \
    ln -s /workspace/ypi/rlm_cost /usr/local/bin/rlm_cost

# Skills (text files loaded into agent prompts)
COPY skills ./skills

# CLI tools from external-tools stage
COPY --from=external-tools /usr/local/bin/claude /usr/local/bin/claude
COPY --from=external-tools /usr/local/bin/uv /usr/local/bin/uv

# Create non-root user for Claude Code (it refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash coder && \
    mkdir -p /workspace/shared && chown coder:coder /workspace/shared

# Pre-configure Claude Code for coder user: skip first-run setup
RUN mkdir -p /home/coder/.claude && \
    echo '{"theme":"dark","hasCompletedOnboarding":true,"preferredNotifChannel":"terminal"}' > /home/coder/.claude/settings.json && \
    touch /home/coder/.claude/.setupCompleted && \
    chown -R coder:coder /home/coder/.claude

WORKDIR /workspace/bot-runtime

ENV NODE_ENV=production
ENV CONNECTOME_GRPC_HOST=connectome:50051

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["node", "--import", "tsx", "src/entry.ts"]
