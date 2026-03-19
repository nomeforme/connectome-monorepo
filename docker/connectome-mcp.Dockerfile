# syntax=docker/dockerfile:1
# Connectome MCP — Streamable HTTP MCP server exposing VEIL state and Docker management

FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y \
    curl ca-certificates tini docker.io \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@9 \
    && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/usr/bin/tini", "--"]
WORKDIR /workspace

# tsconfig.base.json for standalone builds
RUN cat > tsconfig.base.json <<'EOF'
{"compilerOptions":{"target":"ES2022","module":"ES2022","moduleResolution":"bundler","lib":["ES2022"],"strict":true,"esModuleInterop":true,"skipLibCheck":true,"forceConsistentCasingInFileNames":true,"declaration":true,"declarationMap":true,"sourceMap":true,"resolveJsonModule":true,"isolatedModules":true}}
EOF

# Proto file needed at runtime (backend.ts resolves relative to __dirname)
COPY connectome-grpc-common/proto/ ./connectome-grpc-common/proto/

# Install dependencies
COPY connectome-mcp/package.json connectome-mcp/tsconfig.json ./connectome-mcp/
WORKDIR /workspace/connectome-mcp
RUN --mount=type=cache,id=pnpm-store-connectome-mcp,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile

# Build
COPY connectome-mcp/src/ ./src/
RUN pnpm build

ENV NODE_ENV=production
ENV MCP_PORT=3100
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3100/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http-server.js"]
