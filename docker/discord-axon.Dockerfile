# syntax=docker/dockerfile:1
# Discord Axon — Discord platform adapter
#
# Self-contained build — no shared files from the monorepo.
#
# Packages: discord-axon, axon-interfaces, axon-server, axon-binding,
#           grpc-common, connectome-ts, agent-core

FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y \
    curl ca-certificates python3 make g++ git tini \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /workspace

# --- workspace scaffold ---
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
  - discord-axon
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
COPY discord-axon/package.json ./discord-axon/

RUN --mount=type=cache,id=pnpm-store-discord-axon,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile

# --- build ---
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
COPY discord-axon/tsconfig.json ./discord-axon/
COPY discord-axon/src/ ./discord-axon/src/

RUN --mount=type=cache,id=turbo-cache-discord-axon,target=/workspace/node_modules/.cache/turbo \
    pnpm turbo run build --filter=@connectome/discord-axon

# --- runtime ---
WORKDIR /workspace/discord-axon

ENV NODE_ENV=production
EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["node", "--import", "tsx", "src/grpc-main.ts"]
