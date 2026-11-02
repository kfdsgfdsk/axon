# AXON all-in-one: EVERYTHING in ONE container.
# Postgres + Redis + signer + API + worker (+ approval/agent) + nginx serving
# the React terminal SPA with a same-origin /api proxy — all under supervisord.
#
# Build:  docker build -t exchange-allinone:local .
# Run:    ./docker-start.sh   (or: docker run -d -p 3000:3000 -p 8080:80 -v exchange-data:/data exchange-allinone:local)
#
# NOT for production: single container, dev secrets, no TLS, localhost-only
# signer/approval/agent listeners.

# ---- frontend builder: compile the terminal SPA ----
FROM docker.io/library/node:22-bookworm-slim AS frontend-builder

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/tsconfig.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/public ./public
COPY frontend/src ./src

# '' = same-origin via the in-container nginx proxy (recommended). Only set
# this when the SPA is served from a different host than the API.
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ---- backend builder: install deps + compile the API ----
FROM docker.io/library/node:22-bookworm-slim AS backend-builder

# openssl MUST be present before `prisma generate`: without it, Prisma
# misdetects the platform and bakes the wrong query-engine binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first (better layer caching)
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# Prisma client (needs schema only, no DB connection)
COPY backend/prisma ./prisma
RUN npx prisma generate

# App sources + compile
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

# ---- runtime: infra + backend + SPA + supervision ----
FROM docker.io/library/node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      postgresql \
      redis-server \
      supervisor \
      nginx \
      curl \
      openssl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

WORKDIR /app

# Full backend tree (node_modules with ts-node + prisma CLI included) so the
# entrypoint can run `npx prisma` / `npm run tokens:seed` / `npm run wallet:init`.
COPY --from=backend-builder /app /app

# Terminal SPA + all-in-one nginx liaison (proxies to 127.0.0.1:3000).
COPY --from=frontend-builder /build/dist /usr/share/nginx/html
COPY docker/nginx-allinone.conf /etc/nginx/sites-enabled/axon.conf
RUN nginx -t

# Process supervision + boot/init script
COPY docker/supervisord-base.conf /etc/supervisor/conf.d/base.conf
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data /var/log/supervisor /app/logs

# ---- Container defaults (override with `docker run -e KEY=val`) ----
ENV NODE_ENV=development \
    ALLOW_INSECURE_DEV_SECRETS=true \
    PORT=3000 \
    RUN_JOBS_IN_API=false \
    RUN_TRADE_MONITOR_IN_API=false \
    SIGNER_MODE=isolated \
    SIGNER_URL=http://127.0.0.1:3100 \
    SIGNER_HOST=127.0.0.1 \
    SIGNER_PORT=3100 \
    APPROVAL_URL=http://127.0.0.1:3200 \
    POSTGRES_USER=exchange \
    POSTGRES_DB=exchange \
    ENABLE_APPROVAL=true \
    ENABLE_AGENT=true

EXPOSE 3000 80

VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/ready || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
