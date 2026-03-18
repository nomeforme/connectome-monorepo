# syntax=docker/dockerfile:1
# Bot Runtime — standalone agent process (one per bot)
#
# Self-contained build — no shared files from the monorepo.
#
# Packages: bot-runtime, agent-core, grpc-common, axon-binding,
#           axon-interfaces, connectome-ts, axon-server

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
RUN cat > pnpm-workspace.yaml <<'EOF'
packages:
  - connectome-axon-interfaces
  - connectome-grpc-common
  - connectome-axon-binding
  - connectome-ts
  - axon-server
  - connectome-agent-core
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
COPY bot-runtime/tsconfig.json ./bot-runtime/
COPY bot-runtime/src/ ./bot-runtime/src/

RUN --mount=type=cache,id=turbo-cache-bot-runtime,target=/workspace/node_modules/.cache/turbo \
    pnpm turbo run build --filter=@connectome/bot-runtime

# --- runtime ---
FROM build AS runtime

COPY --from=external-tools /opt/ypi /workspace/ypi
RUN ln -s /workspace/ypi/rlm_query /usr/local/bin/rlm_query && \
    ln -s /workspace/ypi/rlm_parse_json /usr/local/bin/rlm_parse_json && \
    ln -s /workspace/ypi/rlm_cost /usr/local/bin/rlm_cost
COPY --from=external-tools /usr/local/bin/claude /usr/local/bin/claude
COPY --from=external-tools /usr/local/bin/uv /usr/local/bin/uv

COPY skills ./skills

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

CMD ["node", "--import", "tsx", "src/entry.ts"]
