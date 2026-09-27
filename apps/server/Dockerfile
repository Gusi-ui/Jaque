# Servidor de partidas. Se construye en el propio VPS (ARM64) o con buildx.
# Contexto: raíz del repositorio.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# pnpm, en la versión fijada en packageManager (package.json raíz)
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @jaque/server...

COPY packages/shared packages/shared
COPY packages/engine packages/engine
COPY apps/server apps/server
RUN pnpm --filter @jaque/server build \
  # node_modules solo con las dependencias de producción
  && pnpm --filter @jaque/server deploy --prod /prod \
  # Solo hacen falta los binarios de Linux de uWebSockets.js
  && find /prod/node_modules/.pnpm -name '*.node' ! -name '*linux*' -delete

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY --from=build /prod/node_modules node_modules
COPY --from=build /app/apps/server/dist dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
