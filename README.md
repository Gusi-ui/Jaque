# jaque

Ajedrez online minimalista y rápido, al estilo de lichess. Sin registro: eliges un ritmo y juegas.

- Emparejamiento rápido por ritmo (1+0 … 15+10)
- Partidas con amigos mediante enlace, con ritmo y color a elegir
- Relojes controlados por el servidor, con incremento; arrancan tras la primera jugada de cada bando
- Premoves, coronación, ofertas de tablas, abandono, anulación y revancha
- Navegación por las jugadas (flechas del teclado) y giro del tablero (tecla F)
- Reconexión automática, modo claro/oscuro, diseño adaptado a móvil, instalable como PWA

## Stack

| Parte | Tecnología |
|---|---|
| Frontend | SvelteKit 2 + Svelte 5 (SPA estática), [chessground](https://github.com/lichess-org/chessground), chess.js |
| Servidor | Node 22 + [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js), chess.js |
| Proxy / HTTPS | Caddy 2 |
| Despliegue | Docker Compose en un VPS ARM64 (Oracle Cloud Always Free) con Cloudflare como proxy |

Las partidas viven en memoria del servidor: es muy rápido y suficiente para un único VPS. Un reinicio del servidor pierde las partidas en curso (ver [próximos pasos](#próximos-pasos)).

## Estructura

```
packages/shared/     Tipos, controles de tiempo y mensajes compartidos por cliente y servidor
packages/engine/     Lógica pura de una partida: jugadas, relojes, final, serialización (sin temporizadores)
apps/server/         Servidor de partidas (HTTP + WebSocket)
  src/game.ts        El motor con reloj de pared, un setTimeout por partida y presencia
  src/store.ts       Partidas en memoria, revanchas y limpieza
  src/index.ts       Rutas HTTP, WebSockets, emparejamiento
  test/              Pruebas unitarias y de extremo a extremo
apps/web/            Frontend SvelteKit
  src/routes/        Portada (lobby) y página de partida /[id]
  src/lib/           Tablero, partida, conexión, sonidos
deploy/              Caddyfile, Dockerfile del frontend y certificados
docker-compose.yml
```

## Desarrollo local

Requisitos: Node 22 o superior y [pnpm](https://pnpm.io) (la versión está fijada en `packageManager`; con `corepack enable` se usa la correcta automáticamente).

```bash
corepack enable      # una sola vez
pnpm install
pnpm dev             # servidor en :3001 y frontend en http://localhost:5173
```

Vite reenvía `/api` y `/ws` al servidor. Para probar una partida contigo mismo, abre el enlace en otro navegador o en una ventana privada: cada navegador es un jugador distinto.

```bash
pnpm test            # motor de partidas + servidor real con dos clientes WebSocket
pnpm check           # comprobación de tipos
pnpm build           # compila servidor y frontend
```

### Protocolo

- `POST /api/games` `{ player, tc: { initial, increment }, color }` → `{ id }` crea una partida con amigo.
- `GET /api/games/:id` devuelve el estado de una partida.
- `WS /ws/game/:id?player=…` mensajes `join`, `move` (UCI + número de jugada), `resign`, `abort`, `draw`, `rematch`. El servidor responde con `hello` (tu color), `state` (estado completo), `redirect` (revancha) y `error`.
- `WS /ws/lobby?player=…` mensajes `seek` y `cancel`; el servidor envía `stats`, `seeking` y `start`.

El `player` es un identificador anónimo que el navegador genera y guarda en `localStorage`.

## Despliegue en Oracle Cloud + Cloudflare

### 1. Oracle Cloud

1. **Pasa la cuenta a Pay As You Go** (Billing → Upgrade). Sigue sin costar nada mientras no superes los límites Always Free, y evita que Oracle recupere la instancia por considerarla inactiva.
2. Crea una instancia **VM.Standard.A1.Flex** (Ampere, ARM64) con Ubuntu 24.04. Con 1–2 OCPU y 6–12 GB de RAM sobra; puedes dejar el resto para otros proyectos.
3. Abre los puertos **80 y 443**, en dos sitios:
   - En la consola: *Networking → Virtual Cloud Networks → tu VCN → Security Lists → Default* → añade reglas de entrada TCP para 80 y 443 desde `0.0.0.0/0`.
   - En la propia máquina, porque las imágenes de Ubuntu de Oracle traen reglas de `iptables` que lo bloquean todo:
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
4. Instala Docker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER   # cierra sesión y vuelve a entrar
   ```

### 2. Cloudflare

1. En *DNS*, crea un registro **A** con tu subdominio (p. ej. `ajedrez`) apuntando a la IP pública de la instancia, con el **proxy activado** (nube naranja).
2. En *SSL/TLS → Overview*, elige **Full (strict)**.
3. En *SSL/TLS → Origin Server*, pulsa **Create Certificate** (RSA, 15 años, con tu subdominio). Guarda los dos textos en el servidor:
   ```
   deploy/certs/origin.pem   ← certificado
   deploy/certs/origin.key   ← clave privada
   ```
   ```bash
   chmod 600 deploy/certs/origin.key
   ```
4. Los WebSockets están activados por defecto en Cloudflare (*Network → WebSockets*). El servidor envía pings cada pocos segundos, así que Cloudflare no cierra las conexiones por inactividad.

### 3. Arrancar

```bash
git clone <tu-repositorio> jaque && cd jaque
cp .env.example .env            # pon tu dominio en DOMAIN
# copia los certificados en deploy/certs/
docker compose up -d --build
docker compose logs -f
```

La primera construcción tarda unos minutos en ARM. Comprueba `https://tu-dominio/api/health`.

**Actualizar:** `git pull && docker compose up -d --build`. Ten en cuenta que reiniciar el servidor termina las partidas en curso; hazlo en horas tranquilas.

### Recomendado

- **Cerrar el origen a todo lo que no sea Cloudflare**: en la Security List, limita 80 y 443 a los [rangos de IP de Cloudflare](https://www.cloudflare.com/ips/) en lugar de `0.0.0.0/0`. Así nadie puede saltarse Cloudflare atacando la IP directamente.
- **Límite de peticiones**: en Cloudflare, *Security → WAF → Rate limiting rules*, añade una regla para `POST /api/games` (p. ej. 20 por minuto e IP).
- La IP real de cada jugador llega a Caddy en la cabecera `Cf-Connecting-Ip`; el Caddyfile ya confía solo en las IP de Cloudflare.

### Probar en el VPS sin Cloudflare

Con `TLS_MODE=internal` en `.env`, Caddy usa un certificado autofirmado y puedes entrar por `https://IP-del-servidor` aceptando el aviso del navegador.

## Próximos pasos

En el orden que propondría:

1. **Guardar partidas en PostgreSQL** al terminar (PGN, jugadores, resultado) y añadir una página de historial. Añadir un servicio `postgres` a `docker-compose.yml`.
2. **Persistir partidas en curso** (en Redis o en la misma base de datos) para sobrevivir a reinicios y despliegues.
3. **Cuentas y rating Glicko-2**, como lichess. Las partidas anónimas pueden seguir siendo el modo por defecto.
4. **Análisis con Stockfish (WASM)** en el navegador al terminar la partida, sin coste de servidor.
5. **Compensación de lag**: descontar del reloj parte de la latencia medida de cada jugador.
6. Detección de desconexión prolongada con opción de reclamar la victoria.

## Licencia

GPL-3.0 o posterior (ver `LICENSE`). Es obligatorio porque chessground usa esa licencia: si publicas o distribuyes el proyecto, el código fuente debe estar disponible con la misma licencia.
