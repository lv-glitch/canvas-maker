# Canvas Buddy backend — FFmpeg + Node Express server.
# Built for Fly.io's `fly deploy`. Runs on port 3737 to match local dev.

FROM node:20-slim AS base

# FFmpeg system packages — we use ffmpeg-static (npm) at dev time so node_modules
# already ships an arm64/x64 binary, but deploying the static binary into Linux
# containers can be flaky across architectures. Installing ffmpeg via apt gives
# us a known-good Linux build the runtime can always count on.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy source.
COPY src/ ./src/
COPY public/ ./public/
COPY patches/ ./patches/

# Override ffmpeg-static's bundled binary with the system FFmpeg installed
# above. Ensures cross-arch builds always get a working binary.
RUN ln -sf /usr/bin/ffmpeg /app/node_modules/ffmpeg-static/ffmpeg

ENV NODE_ENV=production
ENV PORT=3737
EXPOSE 3737

# server.js auto-starts when invoked directly.
CMD ["node", "src/server.js"]
