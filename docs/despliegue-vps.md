# Despliegue en un VPS (Docker)

Segunda instancia del ajedrez en un servidor propio, detrás de Cloudflare y de un **Caddy compartido**, pensada para alojar más de un juego en la misma máquina. La producción (`damejaque.online`) corre en Cloudflare Workers y **no depende de esto**.

> Los marcadores `<…>` son los datos de tu servidor y de tu cuenta. No los escribas en el repositorio (es público).

## Cómo encaja

```
Internet → Cloudflare (proxy, TLS) → :443 → Caddy compartido ──┬─ /api/*, /ws/* → ajedrez-server:3001
                                                               └─ resto         → ajedrez-static:8080
```

- **Caddy es el único servicio que publica puertos** (solo el 443; Cloudflare conecta siempre por HTTPS, así que el 80 no se publica).
- Cada juego es un proyecto `docker compose` aparte que se une a la red externa `web` con un alias propio (`ajedrez-server`, `ajedrez-static`) y **no publica puertos**.
- Un sitio nuevo = un archivo `deploy/caddy/conf/sites/<juego>.caddy` y un `caddy reload`.

| Archivo | Para qué |
|---|---|
| `docker-compose.vps.yml` | El ajedrez: `server` (partidas) y `static` (SPA). Sin puertos, red `web`, límites de recursos |
| `deploy/caddy/` | Caddy compartido: `docker-compose.yml`, `conf/Caddyfile`, `conf/sites/*.caddy`, `certs/` |
| `deploy/static.Dockerfile`, `deploy/Caddyfile.static` | Contenedor que solo sirve el SPA |
| `docker-compose.yml`, `deploy/web.Dockerfile`, `deploy/Caddyfile` | Variante antigua «todo en uno» (Caddy propio con 80/443). Sirve para pruebas locales |

### Límites de recursos iniciales

| Contenedor | CPU | RAM |
|---|---|---|
| `caddy` | 0,25 | 256 MB |
| `ajedrez-server` | 0,4 | 1,5 GB |
| `ajedrez-static` | 0,1 | 256 MB |

`memswap_limit` es igual a `mem_limit` (sin swap). Se ajustan con `docker stats` y una prueba de carga.

### Variables del servidor de partidas

| Variable | Por defecto | Para qué |
|---|---|---|
| `MAX_GAMES` | 50000 | Tope de partidas en memoria. Al alcanzarlo, crear partida responde 503 y el emparejamiento rápido y la revancha avisan con «Servidor lleno, inténtalo en un momento». En el VPS se fija en **3000** (1 GB de RAM). |
| `KEEP_FINISHED_MIN` | 60 | Minutos que se conserva una partida terminada (para verla) antes de borrarla, siempre que no haya nadie conectado. |

Una variable que no sea un entero positivo se ignora con un aviso en el registro. Las partidas en espera caducan a las 3 h sin actividad.

## Requisitos del servidor

- Ubuntu con Docker CE y Compose, y la red externa: `docker network create web`.
- ARM64 o amd64. La imagen del servidor usa `node:22-trixie-slim`: el binario ARM64 de uWebSockets.js necesita glibc ≥ 2.38 (con `bookworm` el contenedor no arranca).
- **Cierre del origen** (importante): en el firewall del proveedor (p. ej. la *Security List* de Oracle) permite el **TCP 443 solo desde los rangos IPv4 de Cloudflare** ([cloudflare.com/ips-v4](https://www.cloudflare.com/ips-v4)), una regla por rango, y nada hacia el 80. Docker publica por `nat/FORWARD` y se salta las reglas `INPUT` de `iptables`, así que esa barrera es la que cuenta. No uses `ufw`: Docker lo ignora.
- **Revisa los rangos de vez en cuando**: Cloudflare los cambia muy poco, pero cuando lo hace hay que actualizar a la vez las reglas del firewall y `trusted_proxies` en `deploy/caddy/conf/Caddyfile`.

## Primer despliegue

```bash
# 1. Código
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/Gusi-ui/Jaque.git ajedrez

# 2. Caddy compartido (carpeta aparte, fuera del repositorio de cada juego)
mkdir -p ~/apps/caddy && cp -r ~/apps/ajedrez/deploy/caddy/. ~/apps/caddy/
cd ~/apps/caddy
echo "TLS_MODE=internal" > .env        # pruebas; luego "origin"
```

**Certificado de origen de Cloudflare** (comodín `*.<dominio>` y `<dominio>`): créalo en *SSL/TLS → Origin Server* y cópialo desde tu equipo **por `scp`** (nunca lo pegues en un chat ni lo subas a git):

```bash
scp origin.pem origin.key <usuario>@<IP_DEL_SERVIDOR>:~/apps/caddy/certs/
chmod 600 ~/apps/caddy/certs/origin.key
```

**Build del ajedrez** (en ARM tarda varios minutos; vigila la RAM con `free -h`):

```bash
cd ~/apps/ajedrez
docker compose -f docker-compose.vps.yml build
```

**Primero, en local, sin abrir nada.** Crea `~/apps/caddy/docker-compose.override.yml` (no se commitea) para publicar solo en loopback:

```yaml
services:
  caddy:
    ports: !override
      - "127.0.0.1:443:443"
```

```bash
cd ~/apps/ajedrez && docker compose -f docker-compose.vps.yml up -d
cd ~/apps/caddy   && docker compose up -d
curl -k --resolve <subdominio>:443:127.0.0.1 https://<subdominio>/api/health
ss -tlnp        # nada en 0.0.0.0 salvo el 22
```

**Publicar**, solo cuando estén hechos estos tres pasos en el panel de Cloudflare y del proveedor:

1. Reglas de ingreso del 443 solo para los rangos de Cloudflare.
2. Registro DNS `A <subdominio>` hacia `<IP_DEL_SERVIDOR>` **con proxy** (nube naranja).
3. Una *Configuration Rule* solo para ese host con SSL **Full (strict)** (sin cambiar el modo de toda la zona).

Después: `TLS_MODE=origin` en `~/apps/caddy/.env`, borra el override y `docker compose up -d` en `~/apps/caddy`. Comprueba con `docker ps` y `ss -tlnp` que solo el 443 queda publicado.

**Recomendado:** una regla de *rate limiting* en Cloudflare para `POST /api/games` (p. ej. 5 peticiones por 10 s e IP).

## Actualizar

```bash
cd ~/apps/ajedrez
git pull
docker compose -f docker-compose.vps.yml up -d --build
```

> **Reiniciar o recrear `ajedrez-server` termina las partidas en curso en la versión VPS**: viven en memoria (no hay base de datos). Hazlo en horas tranquilas. Lo mismo ocurre al reiniciar el servidor.

`ajedrez-static` se puede recrear sin afectar a las partidas.

## Caddy: cambios de configuración sin cortes

Edita `~/apps/caddy/conf/` (el Caddyfile o un archivo de `sites/`) y recarga **sin reiniciar el contenedor**:

```bash
docker exec caddy caddy validate --config /etc/caddy/conf/Caddyfile --adapter caddyfile
docker exec caddy caddy reload   --config /etc/caddy/conf/Caddyfile --adapter caddyfile
```

- `conf/` se monta **como directorio** a propósito. No montes un fichero suelto: si se edita con `sed -i` o con un editor (crean otro inode), el contenedor sigue viendo el antiguo y `reload` responde `config is unchanged`.
- Reiniciar `caddy` corta los WebSockets abiertos de **todos** los juegos. Solo hay que recrearlo si cambian puertos, volúmenes, variables o límites del compose.

### Añadir otro juego

1. Su proyecto compose se une a la red `web` con un alias propio, sin `ports`.
2. `~/apps/caddy/conf/sites/<juego>.caddy` con su dominio (puedes copiar `ajedrez.caddy`).
3. `validate` y `reload` como arriba; después el DNS y la *Configuration Rule* del nuevo host.

## Revertir

```bash
cd ~/apps/ajedrez
git log --oneline -5                      # elige la versión buena
git checkout <commit-bueno>
docker compose -f docker-compose.vps.yml up -d --build
# para volver a seguir la rama: git checkout <rama> && git pull
```

Esto también termina las partidas en curso. Los cambios en Caddy se revierten restaurando el archivo de `conf/` desde git y haciendo `reload`; si lo que falla es el propio Caddy, `docker compose up -d` en `~/apps/caddy` con la versión anterior del compose.

## Comprobaciones

```bash
docker ps                                  # los 3 en (healthy); solo caddy publica 443
docker stats --no-stream
curl https://<subdominio>/api/health       # {"ok":true,"games":N}
docker logs --since 10m caddy
```

La IP real del jugador llega en `Cf-Connecting-Ip`; Caddy solo se fía de ella si la conexión viene de un rango de Cloudflare (`trusted_proxies`), y la registra como `client_ip`. Para verla hay que subir temporalmente el `log` del snippet `seguridad` de `WARN` a `INFO` y recargar.
