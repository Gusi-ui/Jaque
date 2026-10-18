# Reglas del proyecto

## Ramas

- `main` es **producción** (lo público). `develop` es **desarrollo**.
- Todo el trabajo se sube a `develop`. Nunca se hace commit ni push directo a `main`.
- Para publicar: pull request de `develop` → `main`, solo cuando el CI (`pnpm check`, `pnpm test`, `pnpm build`, e2e) está en verde en `develop` y la funcionalidad está comprobada.
- Las dos ramas están protegidas en GitHub: no se pueden borrar ni reescribir (sin force push). `main` solo acepta PR con el CI aprobado.

## Gestor de paquetes

pnpm (versión fijada en `packageManager`). Ojo: `pnpm --filter @jaque/worker run deploy`, con `run`.

## Despliegue en el VPS (Docker)

Segunda instancia del ajedrez en un VPS con Caddy compartido; no afecta a la producción de Cloudflare (`damejaque.online`). Guía completa: [`docs/despliegue-vps.md`](docs/despliegue-vps.md).

- Ajedrez: `docker-compose.vps.yml` (sin puertos, red externa `web`). Caddy compartido: `deploy/caddy/` (único con puertos, solo el 443; un archivo por juego en `conf/sites/`).
- Actualizar: `git pull && docker compose -f docker-compose.vps.yml up -d --build`. Revertir: `git checkout <commit> && docker compose -f docker-compose.vps.yml up -d --build`.
- **Reiniciar o recrear `ajedrez-server` (o el servidor) termina las partidas en curso**: viven en memoria.
- Cambios en Caddy: `docker exec caddy caddy reload --config /etc/caddy/conf/Caddyfile --adapter caddyfile`; nunca reiniciar el contenedor. `conf/` se monta como directorio: no montar ficheros sueltos (`sed -i` los desincroniza).
- El repo es público: nada de IPs del servidor, usuarios, rutas de claves, certificados, `.env` ni identificadores de la cuenta; usar `<IP_DEL_SERVIDOR>`, `<dominio>`.
- Revisar de vez en cuando los [rangos IPv4 de Cloudflare](https://www.cloudflare.com/ips-v4): firewall del origen y `trusted_proxies` del Caddyfile.
- La imagen del servidor usa `node:22-trixie-slim` (uWebSockets.js en ARM64 necesita glibc ≥ 2.38).

