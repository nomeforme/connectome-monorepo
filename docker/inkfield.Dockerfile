# syntax=docker/dockerfile:1
# inkfield-bridge — headless-render + human-inbox glue service for InkField
# (https://github.com/ileivoivm/inkField). Does NOT bundle, vendor, or serve
# any InkField source — rendering drives the real published app over the
# network (see server.js / README.md for the license reasoning). This image
# is just Chromium + our own small Express service.
#
# Base image ships Chromium + every shared-lib dependency headless Chrome
# needs, which is far less failure-prone than hand-rolling the apt list.
FROM ghcr.io/puppeteer/puppeteer:23.11.1

# The base image drops privileges to `pptruser`; we need to run as root like
# the rest of this stack's services so writes into the shared-workspace
# volume (root:root 0755, same as every other service using it) succeed.
# Chrome itself already launches with --no-sandbox (see render.js), which is
# what makes running as root safe here.
#
# Puppeteer's bundled Chrome is cached at $HOME/.cache/puppeteer (baked in
# at $HOME=/home/pptruser during the base image's own build). Switching to
# root changes os.homedir() to /root, which breaks puppeteer's normal
# cache-based executable lookup — so keep HOME pointed at pptruser's cache
# rather than hardcoding a versioned Chrome binary path (which would go
# stale the moment the base image bumps its bundled Chrome version).
USER root
ENV HOME=/home/pptruser
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

WORKDIR /app
COPY inkfield-bridge/package.json ./
RUN npm install --omit=dev
COPY inkfield-bridge/server.js inkfield-bridge/render.js ./
COPY inkfield-bridge/lib/ ./lib/
COPY inkfield-bridge/public/ ./public/

ENV PORT=8099
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:8099/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
