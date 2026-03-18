# syntax=docker/dockerfile:1
# Connectome gRPC Server
#
# Self-contained build — no shared files from the monorepo.
# Can be built from any machine with access to the package source dirs.
#
# Packages: connectome-ts, grpc-common, axon-interfaces

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
  - connectome-ts
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
COPY connectome-ts/package.json ./connectome-ts/

RUN --mount=type=cache,id=pnpm-store-connectome,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile

# --- build ---
COPY connectome-axon-interfaces/tsconfig.json ./connectome-axon-interfaces/
COPY connectome-axon-interfaces/src/ ./connectome-axon-interfaces/src/
COPY connectome-grpc-common/tsconfig.json ./connectome-grpc-common/
COPY connectome-grpc-common/src/ ./connectome-grpc-common/src/
COPY connectome-grpc-common/proto/ ./connectome-grpc-common/proto/
COPY connectome-ts/tsconfig.json ./connectome-ts/
COPY connectome-ts/src/ ./connectome-ts/src/

RUN --mount=type=cache,id=turbo-cache-connectome,target=/workspace/node_modules/.cache/turbo \
    pnpm turbo run build --filter=@connectome/connectome-ts

# --- runtime ---
RUN mkdir -p /workspace/connectome-ts/state
WORKDIR /workspace/connectome-ts

ENV NODE_ENV=production
ENV GRPC_PORT=50051
ENV GRPC_HOST=0.0.0.0
ENV PERSISTENCE_ENABLED=true
ENV PERSISTENCE_DIR=/workspace/connectome-ts/state

EXPOSE 50051

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD node -e "require('net').connect(process.env.GRPC_PORT || 50051).on('error', () => process.exit(1)).on('connect', () => process.exit(0))"

CMD ["node", "--import", "tsx", "src/grpc-main.ts"]
