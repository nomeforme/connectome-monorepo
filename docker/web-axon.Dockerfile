# syntax=docker/dockerfile:1
# Web Axon — WebSocket platform adapter for generic frontends
#
# Packages: web-axon, web-sdk, axon-binding, grpc-common

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
  - connectome-grpc-common
  - connectome-axon-binding
  - connectome-web-sdk
  - web-axon
EOF
RUN cat > turbo.json <<'EOF'
{"$schema":"https://turbo.build/schema.json","tasks":{"build":{"dependsOn":["^build"],"inputs":["src/**/*.ts","tsconfig.json","package.json"],"outputs":["dist/**"]}}}
EOF
RUN cat > tsconfig.base.json <<'EOF'
{"compilerOptions":{"target":"ES2022","module":"ES2022","moduleResolution":"bundler","lib":["ES2022"],"strict":true,"esModuleInterop":true,"skipLibCheck":true,"forceConsistentCasingInFileNames":true,"declaration":true,"declarationMap":true,"sourceMap":true,"resolveJsonModule":true,"isolatedModules":true}}
EOF

# --- deps ---
COPY connectome-grpc-common/package.json ./connectome-grpc-common/
COPY connectome-axon-binding/package.json ./connectome-axon-binding/
COPY connectome-web-sdk/package.json ./connectome-web-sdk/
COPY web-axon/package.json ./web-axon/

RUN --mount=type=cache,id=pnpm-store-web-axon,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile

# --- build ---
COPY connectome-grpc-common/tsconfig.json ./connectome-grpc-common/
COPY connectome-grpc-common/src/ ./connectome-grpc-common/src/
COPY connectome-grpc-common/proto/ ./connectome-grpc-common/proto/
COPY connectome-axon-binding/tsconfig.json ./connectome-axon-binding/
COPY connectome-axon-binding/src/ ./connectome-axon-binding/src/
COPY connectome-axon-binding/proto/ ./connectome-axon-binding/proto/
COPY connectome-web-sdk/tsconfig.json ./connectome-web-sdk/
COPY connectome-web-sdk/src/ ./connectome-web-sdk/src/
COPY web-axon/tsconfig.json ./web-axon/
COPY web-axon/src/ ./web-axon/src/

RUN --mount=type=cache,id=turbo-cache-web-axon,target=/workspace/node_modules/.cache/turbo \
    pnpm turbo run build --filter=@connectome/web-axon

# --- runtime ---
WORKDIR /workspace/web-axon

ENV NODE_ENV=production
EXPOSE 8080 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "process.exit(0)"

CMD ["node", "--import", "tsx", "src/grpc-main.ts"]
