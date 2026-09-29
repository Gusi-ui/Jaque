# Deshacer la jugada

## Problema

En una partida real es normal equivocarse al mover una pieza (un clic desviado, un
arrastre mal soltado). Hoy no hay forma de rectificar: el error decide la partida.

## Objetivo

Que un jugador pueda pedir deshacer su última jugada y que, si el rival acepta, se
deshaga. Como en lichess («takeback»). Contra la máquina, la máquina acepta siempre.

Fuera de alcance: devolver el tiempo gastado, deshacer más de una jugada propia de
golpe, límites por partida.

## Reglas

- Solo con la partida en curso (`status === 'started'`).
- Solo puede pedirlo quien ya ha movido al menos una vez (blancas: `ply ≥ 1`;
  negras: `ply ≥ 2`).
- Una sola petición pendiente a la vez (`takeback: Color | null`). Pedir cuando el
  rival ya lo ha pedido equivale a aceptar.
- Al aceptar, con `R` = quien pidió:
  - le toca al rival de `R` (aún no ha contestado): se deshace **1** jugada;
  - le toca a `R` (el rival ya contestó): se deshacen **2** jugadas.
  - En ambos casos vuelve a ser el turno de `R`.
- `offer: false` retira la propia petición o rechaza la del rival.
- Cualquier jugada anula la petición pendiente (si el rival mueve en lugar de
  aceptar, es un rechazo).
- Tras un rechazo explícito, nadie puede volver a pedirlo hasta la siguiente jugada
  (`noTakebackAt = ply` del rechazo; se puede pedir si `ply !== noTakebackAt`). Si el
  rival rechaza moviendo, el `ply` ya cambia, así que no hace falta bloquear nada.
- Al deshacer se retira también la oferta de tablas pendiente.

## Relojes

- No se devuelve el tiempo gastado. Antes de deshacer se congela el reloj que corre
  (`clock[turn] = remaining(turn, now)`) y `turnStart = now`.
- Si tras deshacer `ply < 2`, los relojes se paran y vuelve a contar el plazo de
  30 s para la primera jugada (`FIRST_MOVE_MS`) desde `now`, como al empezar.

## Diseño

### 1. Motor — `packages/engine/src/index.ts`

- `Game.takeback: Color | null` y `private noTakebackAt: number | null`.
- `takeback(color, offer, now)`: aplica las reglas de arriba; `changed(now)` solo si
  algo cambió.
- `move()`: borra la petición pendiente, si la hay.
- `view()`: `takeback`.
- `GameData`: `takeback?: Color | null` y `noTakebackAt?: number | null`, opcionales
  para cargar partidas guardadas antes del cambio.

### 2. Protocolo — `packages/shared/src/index.ts`

- `GameView.takeback: Color | null`.
- `ClientGameMsg` gana `{ t: 'takeback'; offer: boolean }`.

### 3. Servidores

- Cloudflare, `apps/worker/src/game-room.ts`: `case 'takeback': game.takeback(color, !!msg.offer, now)`.
- Node, `apps/server/src/game.ts`: `override takeback(color, offer, now = Date.now())`;
  `apps/server/src/index.ts`: `case 'takeback'` como `draw`.

### 4. Máquina — `packages/engine/src/bot.ts` y `apps/web/src/lib/bot.ts`

- `planBot`: si `view.takeback === rival`, envía `{ t: 'takeback', offer: true }` y
  no piensa. Nunca la pide.
- `bot.ts`: la firma que evita reenviar decisiones incluye `v.takeback`. La jugada
  que estaba pensando se descarta sola: ya comprueba que `moves.length` no cambió.

### 5. Pantalla de partida — `apps/web/src/lib/Game.svelte`

- Botón «Deshacer» junto a «Ofrecer tablas», visible cuando ya has movido. Si la
  acabas de pedir, pasa a «Deshacer pedido» y pulsarlo la retira. El bloqueo tras un
  rechazo no se ve en el cliente: si se pide igual, el motor lo ignora.
- Si la pide el rival: aviso «Tu rival pide deshacer su última jugada» con
  [Aceptar] [Rechazar], con el mismo estilo que el de tablas.
- Al recibir un estado con menos jugadas: la vista vuelve a la posición actual y se
  cancela la premove pendiente.

## Comprobación

- `packages/engine/test/game.test.ts`: deshacer 1 jugada; deshacer 2; no se puede
  sin haber movido; ni con la partida terminada; pedir con petición del rival = aceptar;
  retirar; rechazar bloquea hasta la siguiente jugada; mover anula la petición;
  relojes (no devuelve tiempo, congela el que corría, vuelve el plazo de primera
  jugada con `ply < 2`); retira la oferta de tablas; `toJSON`/`fromJSON`, también
  con datos antiguos sin los campos nuevos.
- `packages/engine/test/bot.test.ts`: `planBot` acepta la petición del rival.
- `apps/server/test/server.test.ts` y `apps/worker/test/worker.test.ts`: flujo de
  petición y aceptación por WebSocket.
- En el navegador: partida entre dos pestañas (pedir, aceptar, rechazar) y contra la
  máquina.
