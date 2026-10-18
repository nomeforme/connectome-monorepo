# syntax=docker/dockerfile:1
# web-board — the standalone Commons Board service (web-board/README.md).
# Self-contained: only web-board/ from the monorepo, its two runtime deps
# (ws, @modelcontextprotocol/sdk), nothing from the house.
#
# Data (board.config.json, tokens.json, board.sqlite) lives in /data, a
# named volume in docker-compose.yml; nothing secret is baked in.

FROM node:24-slim AS deps
RUN npm install -g pnpm@9
WORKDIR /app
RUN cat > package.json <<'EOF'
{"private":true,"packageManager":"pnpm@9.15.4"}
EOF
RUN cat > pnpm-workspace.yaml <<'EOF'
packages:
  - web-board
EOF
COPY web-board/package.json ./web-board/
RUN --mount=type=cache,id=pnpm-store-web-board,target=/root/.local/share/pnpm/store \
    pnpm install --prod --no-frozen-lockfile

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    WEB_BOARD_DATA=/data \
    WEB_BOARD_PORT=8090
WORKDIR /app
COPY --from=deps /app /app
COPY web-board/src/ ./web-board/src/
COPY web-board/assets/ ./web-board/assets/
COPY web-board/scripts/ ./web-board/scripts/
COPY web-board/README.md ./web-board/README.md
# /data pre-created and owned by the non-root user so a fresh named volume
# mounted there copies up that ownership on first `up`
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/web-board
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_BOARD_PORT||8090)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
