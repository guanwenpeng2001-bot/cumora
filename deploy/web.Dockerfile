# cumora-web — static SPA bundle served by nginx, with /api, /ws and /uploads
# reverse-proxied to the server container. Build from the repo root:
#   docker build -f deploy/web.Dockerfile -t cumora-web .

# ─── stage 1: build the SPA bundle ──────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: same rationale as the spa-build stage in
# server/docker/cumora-server.Dockerfile — electron-icon-builder transitively
# pulls phantomjs-prebuilt, whose postinstall needs bzip2 (absent in slim).
RUN npm ci --no-audit --no-fund --prefer-offline --ignore-scripts
COPY src ./src
COPY public ./public
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json postcss.config.js tailwind.config.ts ./
# VITE_CUMORA_API_BASE is intentionally NOT set: the SPA is served same-origin
# with the API behind nginx, so src/api/client.ts falls back to relative URLs.
RUN npm run build

# ─── stage 2: nginx runtime ─────────────────────────────────────────
FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
