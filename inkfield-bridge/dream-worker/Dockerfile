# syntax=docker/dockerfile:1
# inkfield dream-worker — same license posture and no-InkField-source-inside
# rule as ../../docker/inkfield.Dockerfile. See ../README.md.
#
# GPU-enabled variant of the base render image: ghcr.io/puppeteer/puppeteer
# ships headless Chromium but NOT the GLVND dispatch libraries Chrome/ANGLE
# needs to actually find a mounted NVIDIA driver (nvidia-container-toolkit
# mounts the raw driver .so files via --gpus all, but that alone leaves
# Chrome falling back to SwiftShader — confirmed by direct measurement, see
# README.md "Compute host migration"). libglvnd0/libegl1/libgl1 provide the
# missing libEGL.so.1/libGLX.so.0 dispatch layer; the EGL vendor manifest
# below tells GLVND which vendor library to route to (nvidia-container-
# toolkit doesn't generate this automatically for non-CUDA-base images).
FROM ghcr.io/puppeteer/puppeteer:23.11.1

# See docker/inkfield.Dockerfile for why (root + HOME=pptruser's cache path).
USER root
ENV HOME=/home/pptruser
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_ENV=production

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends libglvnd0 libegl1 libgl1 \
    && rm -rf /var/lib/apt/lists/*

# EGL vendor manifest — library_path confirmed present via nvidia-container-
# toolkit's --gpus all mount (libEGL_nvidia.so.0). __EGL_VENDOR_LIBRARY_FILENAMES
# (set below) points GLVND straight at this file, which works even though
# nvidia-container-toolkit doesn't populate the usual /usr/share/glvnd/
# egl_vendor.d/ scan directory in this image.
RUN mkdir -p /etc/glvnd/egl_vendor.d && printf '%s' '{ \
  "file_format_version": "1.0.0", \
  "ICD": { "library_path": "libEGL_nvidia.so.0" } \
}' > /etc/glvnd/egl_vendor.d/10_nvidia.json

ENV __EGL_VENDOR_LIBRARY_FILENAMES=/etc/glvnd/egl_vendor.d/10_nvidia.json
ENV INKFIELD_GPU_MODE=1

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js render.js ./

ENV PORT=8199
EXPOSE 8199

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://localhost:8199/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
