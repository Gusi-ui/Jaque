# Frontend estático servido por Caddy, que además hace de proxy hacia el servidor.
# Contexto: raíz del repositorio.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @jaque/web --include-workspace-root=false

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace @jaque/web

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/build /srv
