# Connectome Multi-Stage Dockerfile
# Uses pnpm workspaces + turborepo for efficient builds.
# Usage:
#   docker compose build                         # build all services
#   docker compose build connectome              # build just the core server
#   docker compose build signal-axon discord-axon  # build both axons
#
# Each service selects its final stage via `target:` in docker-compose.yml.

# ============================================
# Stage: base — Ubuntu 24.04 + Node 22 LTS + pnpm
# ============================================
FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    curl ca-certificates python3 make g++ git tini \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /workspace

# ============================================
# Stage: workspace-deps — Install all workspace dependencies (layer-cached)
# ============================================
FROM base AS workspace-deps

# Copy workspace config files first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json tsconfig.json ./

# Copy only package.json from each workspace member
COPY connectome-axon-interfaces/package.json ./connectome-axon-interfaces/
COPY connectome-grpc-common/package.json ./connectome-grpc-common/
COPY connectome-ts/package.json ./connectome-ts/
COPY axon-server/package.json ./axon-server/
COPY connectome-agent-core/package.json ./connectome-agent-core/
COPY bot-runtime/package.json ./bot-runtime/
COPY discord-axon/package.json ./discord-axon/
COPY signal-axon/package.json ./signal-axon/

RUN pnpm install --frozen-lockfile

# ============================================
# Stage: workspace-build — Build all workspace packages with turbo
# ============================================
FROM workspace-deps AS workspace-build

# Copy tsconfig.json for each package (needed by tsc --build)
COPY connectome-axon-interfaces/tsconfig.json ./connectome-axon-interfaces/
COPY connectome-grpc-common/tsconfig.json ./connectome-grpc-common/
COPY connectome-ts/tsconfig.json ./connectome-ts/
COPY axon-server/tsconfig.json ./axon-server/
COPY connectome-agent-core/tsconfig.json ./connectome-agent-core/
COPY bot-runtime/tsconfig.json ./bot-runtime/
COPY discord-axon/tsconfig.json ./discord-axon/
COPY signal-axon/tsconfig.json ./signal-axon/

# Copy all source
COPY connectome-axon-interfaces/src/ ./connectome-axon-interfaces/src/
COPY connectome-grpc-common/src/ ./connectome-grpc-common/src/
COPY connectome-ts/src/ ./connectome-ts/src/
COPY axon-server/src/ ./axon-server/src/
COPY connectome-agent-core/src/ ./connectome-agent-core/src/
COPY bot-runtime/src/ ./bot-runtime/src/
COPY discord-axon/src/ ./discord-axon/src/
COPY signal-axon/src/ ./signal-axon/src/

# Copy proto files needed by grpc-common
COPY connectome-grpc-common/proto/ ./connectome-grpc-common/proto/

RUN pnpm turbo run build

# ============================================
# Stage: external-deps — pi-mono, skills, ypi (for axon services)
# Cloned from GitHub at pinned commits.
# ============================================
FROM workspace-build AS external-deps

# Skills are tracked in the monorepo
COPY skills ./skills

# Clone external deps (latest)
RUN git clone --depth 1 https://github.com/badlogic/pi-mono.git pi-mono
RUN git clone --depth 1 https://github.com/badlogic/pi-skills.git pi-skills
RUN git clone --depth 1 https://github.com/rawwerks/ypi.git ypi

# Pinned commit versions (uncomment to lock to specific commits):
# RUN git clone --depth 1 https://github.com/badlogic/pi-mono.git pi-mono \
#     && cd pi-mono && git fetch --depth 1 origin 4ba3e5be229a570187d8efbef5c14c0d5ce40dcc \
#     && git checkout 4ba3e5be229a570187d8efbef5c14c0d5ce40dcc
# RUN git clone --depth 1 https://github.com/badlogic/pi-skills.git pi-skills \
#     && cd pi-skills && git fetch --depth 1 origin 75d32a382b0c8aafce356d68e17d2dc94c0c953b \
#     && git checkout 75d32a382b0c8aafce356d68e17d2dc94c0c953b
# RUN git clone --depth 1 https://github.com/rawwerks/ypi.git ypi \
#     && cd ypi && git fetch --depth 1 origin 896e1546b74b50fb18f6a5b98ec6ea77a0291e86 \
#     && git checkout 896e1546b74b50fb18f6a5b98ec6ea77a0291e86

WORKDIR /workspace/pi-mono
RUN npm install && npm run build

RUN ln -s /workspace/pi-mono/packages/coding-agent/dist/cli.js /usr/local/bin/pi \
    && chmod +x /usr/local/bin/pi

RUN ln -s /workspace/ypi/rlm_query /usr/local/bin/rlm_query && \
    ln -s /workspace/ypi/rlm_parse_json /usr/local/bin/rlm_parse_json && \
    ln -s /workspace/ypi/rlm_cost /usr/local/bin/rlm_cost && \
    chmod +x /workspace/ypi/rlm_query /workspace/ypi/rlm_parse_json /workspace/ypi/rlm_cost

WORKDIR /workspace

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

# Use node --import tsx directly so SIGTERM reaches the process for graceful shutdown
CMD ["node", "--import", "tsx", "src/grpc-main.ts"]

# ============================================
# Stage: signal-axon
# ============================================
FROM external-deps AS signal-axon
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
FROM external-deps AS discord-axon
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
FROM external-deps AS bot-runtime
WORKDIR /workspace

# Install CLI tools available to bots (binaries referenced by tool_configs)
RUN curl -sSL https://raw.githubusercontent.com/Polymarket/polymarket-cli/main/install.sh | sh
RUN curl -fsSL https://claude.ai/install.sh | bash
# Make claude accessible to all users (--dangerously-skip-permissions refuses root)
RUN cp /root/.local/bin/claude /usr/local/bin/claude

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

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["node", "--import", "tsx", "src/entry.ts"]
