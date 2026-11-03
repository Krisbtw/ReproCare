# syntax=docker/dockerfile:1
# =============================================================================
# Stage 1: Builder — deterministic dependency install and production Vite/Nitro build
# =============================================================================
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ENV NODE_ENV=production
ENV VITE_AUTH_ENABLED=true
ENV NITRO_PRESET=node-server

# Pure build step (database migrations are decoupled and run at release/startup time)
RUN npm run build

# =============================================================================
# Stage 2: Production Runner — minimal runtime with Tesseract OCR, non-root user,
# PID 1 signal forwarding (tini), and HTTP healthcheck
# =============================================================================
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/reprocare/imaging /var/lib/reprocare/backups \
  && chown -R node:node /var/lib/reprocare /app

COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.output ./.output
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/public ./public

USER node

EXPOSE 8080
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV REPROCARE_IMAGING_STORAGE_DIR=/var/lib/reprocare/imaging
ENV REPROCARE_IMAGING_BACKUP_DIR=/var/lib/reprocare/backups

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/ >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]
