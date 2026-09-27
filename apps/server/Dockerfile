# Servidor de partidas. Se construye en el propio VPS (ARM64) o con buildx.
# Contexto: raíz del repositorio.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @jaque/server --include-workspace-root=false

COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build --workspace @jaque/server \
  # Solo hacen falta los binarios de Linux de uWebSockets.js
  && find node_modules/uWebSockets.js -name '*.node' ! -name '*linux*' -delete

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY --from=build /app/node_modules/uWebSockets.js node_modules/uWebSockets.js
COPY --from=build /app/apps/server/dist dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
