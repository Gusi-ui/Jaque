# Frontend estático servido por Caddy, que además hace de proxy hacia el servidor.
# Contexto: raíz del repositorio.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @jaque/web...

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @jaque/web build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/build /srv
