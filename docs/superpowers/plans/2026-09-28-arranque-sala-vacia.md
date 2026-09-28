# Arranque con la sala vacía · plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que el visitante juegue en segundos aunque no haya nadie y que la portada no anuncie el vacío.

**Architecture:** el mensaje `stats` del lobby gana `played` (partidas terminadas no anuladas), calculado en el Lobby de Cloudflare (SQLite + D1 al iniciar) y en memoria en el VPS. La portada usa una sola función `createGame` para el diálogo, el botón «Jugar ya» y la oferta de jugar contra la máquina tras 12 s buscando.

**Tech Stack:** SvelteKit 2 + Svelte 5, Cloudflare Workers + Durable Objects + D1, Node + uWebSockets.js, vitest (worker), node:test (servidor).

**Spec:** `docs/superpowers/specs/2026-09-28-arranque-sala-vacia-design.md`

## Global Constraints

- Nivel por defecto de la máquina en «Jugar ya» y en la oferta: **fácil** (1).
- Ritmo de «Jugar ya»: **5+3**, color al azar.
- Espera antes de ofrecer la máquina: **12 s**.
- Pie de estadísticas: directo si `players >= 3`; si no, «{played} partidas jugadas en DameJaque» si `played >= 50`; si no, nada.
- Clave de `localStorage` del nivel recordado: `jaque:bot-level`, siempre en try/catch.
- La máquina se presenta siempre como máquina.
- Todo el texto de la interfaz en español; commits en español con la línea `Co-Authored-By`.

## Review Focus

1. Rival humano que llega justo cuando aparece la oferta: la búsqueda sigue abierta y el `start` del lobby manda (tarea 4: el temporizador se anula al cambiar `seeking`).
2. Reconexión del lobby durante la búsqueda: el cliente repite `seek`; la oferta no debe reiniciarse ni duplicarse (tarea 4: el efecto depende solo de `seeking`).
3. D1 caído al despertar el Lobby: no debe romper el lobby; `played` queda en 0 y se reintenta al siguiente despertar (tarea 2: sin fila no se guarda nada).
4. Partida anulada tras empezar: no suma a `played` (tareas 1 y 2, pruebas explícitas).
5. `localStorage` bloqueado o con basura: nivel fácil (tarea 3: `lastLevel` valida el valor).

---

### Task 1: Protocolo y contador en el VPS

**Files:**
- Modify: `packages/shared/src/index.ts` (tipo `ServerLobbyMsg`)
- Modify: `apps/server/src/store.ts`
- Modify: `apps/server/src/index.ts` (`lobbyStats`, difusión al terminar)
- Test: `apps/server/test/game.test.ts` (store), `apps/server/test/server.test.ts` (lobby, también corre contra wrangler en e2e)

**Interfaces:**
- Produces: `ServerLobbyMsg` `{ t: 'stats'; players; games; seeks; played: number }`; `GameStore.played: number`; `GameStore.onFinished: (game: Game) => void`.

- [ ] **Step 1: pruebas que fallan.** En `game.test.ts`:

```ts
import { GameStore } from '../src/store.js';

test('el almacén cuenta las partidas terminadas, no las anuladas', () => {
  const store = new GameStore();
  let finished = 0;
  store.onFinished = () => finished++;
  const g = store.pair(blitz, 'white-player-00000', 'black-player-00000')!;
  ['f2f3', 'e7e5', 'g2g4', 'd8h4'].forEach((m, i) => g.move(i % 2 ? 'black' : 'white', m, i));
  assert.equal(g.status, 'mate');
  assert.equal(store.played, 1);
  assert.equal(finished, 1);
  const a = store.pair(blitz, 'white-player-00000', 'black-player-00000')!;
  a.abort('white');
  assert.equal(a.status, 'aborted');
  assert.equal(store.played, 1);
  g.dispose();
  a.dispose();
});
```

(Comprobar el nombre real del método de anular en `apps/server/src/game.ts` y usarlo.)

En `server.test.ts`:

```ts
test('el lobby cuenta las partidas jugadas', async () => {
  const lobby = connect(`/ws/lobby?player=${P1}`);
  const { played } = await lobby.next((m) => m.t === 'stats');
  assert.equal(typeof played, 'number');
  const r = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    body: JSON.stringify({ player: P1, tc: { initial: 300, increment: 0 }, color: 'white' })
  });
  const { id } = await r.json();
  const a = connect(`/ws/game/${id}?player=${P1}`);
  await a.next((m) => m.t === 'hello');
  const b = connect(`/ws/game/${id}?player=${P2}`);
  await b.opened;
  b.send({ t: 'join' });
  await a.next((m) => m.t === 'state' && m.game.status === 'started');
  for (const [i, uci] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) {
    (i % 2 ? b : a).send({ t: 'move', uci, ply: i });
    await a.next((m) => m.t === 'state' && m.game.moves.length === i + 1);
  }
  await lobby.next((m) => m.t === 'stats' && m.played === played + 1);
  for (const c of [lobby, a, b]) c.ws.close();
});
```

- [ ] **Step 2:** `pnpm --filter @jaque/server test` → falla (`played` undefined).
- [ ] **Step 3: implementación.**

`packages/shared/src/index.ts`:
```ts
  | { t: 'stats'; players: number; games: number; seeks: Record<string, number>; played: number }
```

`apps/server/src/store.ts` (en la clase):
```ts
  /** Partidas terminadas (no anuladas) desde que arrancó el servidor. */
  played = 0;
  onFinished: (game: Game) => void = () => {};
```
y en `create`, sustituir `game.onChange = () => this.onChange(game);` por:
```ts
    let counted = false;
    game.onChange = () => {
      if (!counted && isOver(game.status) && game.status !== 'aborted') {
        counted = true;
        this.played++;
        this.onFinished(game);
      }
      this.onChange(game);
    };
```

`apps/server/src/index.ts`: `lobbyStats` devuelve `played: store.played`, y tras `store.onRedirect`:
```ts
store.onFinished = () => app.publish(LOBBY, JSON.stringify(lobbyStats()));
```
(`lobbyStats` es una declaración de función: se eleva, se puede usar antes.)

- [ ] **Step 4:** `pnpm --filter @jaque/server test` y `pnpm --filter @jaque/server check` → pasan.
- [ ] **Step 5: commit** «Lobby: cuenta las partidas jugadas (VPS)».

### Task 2: Contador en Cloudflare

**Files:**
- Modify: `apps/worker/src/lobby.ts`
- Modify: `apps/worker/src/game-room.ts:231-232`
- Test: `apps/worker/test/worker.test.ts` (describe `lobby`)

**Interfaces:**
- Consumes: `ServerLobbyMsg.stats.played` (tarea 1).
- Produces: RPC `Lobby.gameEnded(id: string, played: boolean)`.

- [ ] **Step 1: prueba que falla** en el describe `lobby`:

```ts
  it('cuenta las partidas terminadas, no las anuladas', async () => {
    const l = await connect(`/ws/lobby?player=lobby-cuatro-000000`);
    const { played } = await l.next((m) => m.t === 'stats');
    expect(typeof played).toBe('number');

    const aborted = await startedGame();
    aborted.a.send({ t: 'abort' });
    await aborted.a.next((m) => m.t === 'state' && m.game.status === 'aborted');

    const { a, b } = await startedGame();
    await play(a, b, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    await l.next((m) => m.t === 'stats' && m.played === played + 1);
    for (const c of [l, a, b, aborted.a, aborted.b]) c.ws.close();
  });
```

(Si la anulada sumara, el siguiente `stats` tras el mate llevaría `played + 2` y la espera caducaría.)

- [ ] **Step 2:** `pnpm --filter @jaque/worker test` → falla.
- [ ] **Step 3: implementación.**

`lobby.ts`, en el constructor, tras crear `playing`:
```ts
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    // La primera vez, el contador parte del historial de D1. Si D1 falla, se
    // reintenta al siguiente despertar; mientras tanto cuenta desde 0.
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.storage.sql.exec("SELECT 1 FROM counters WHERE k = 'played'").toArray().length) return;
      try {
        const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM games').first<{ n: number }>();
        ctx.storage.sql.exec("INSERT OR IGNORE INTO counters (k, v) VALUES ('played', ?)", row?.n ?? 0);
      } catch (err) {
        console.error('No se pudo contar el historial', err);
      }
    });
```
`gameEnded(id: string, played = false)`: si `played`, antes de difundir:
```ts
      this.ctx.storage.sql.exec(
        "INSERT INTO counters (k, v) VALUES ('played', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1"
      );
```
En `stats()`:
```ts
    const played =
      sql.exec<{ v: number }>("SELECT v FROM counters WHERE k = 'played'").toArray()[0]?.v ?? 0;
    return { t: 'stats', players: players.size, games, seeks, played };
```

`game-room.ts:232`:
```ts
      if (prev === 'started' && isOver(game.status)) await lobby().gameEnded(game.id, game.status !== 'aborted');
```

- [ ] **Step 4:** `pnpm --filter @jaque/worker test` y `pnpm --filter @jaque/worker check` → pasan.
- [ ] **Step 5: commit** «Lobby: cuenta las partidas jugadas (Cloudflare)».

### Task 3: Portada · `createGame`, nivel recordado y «Jugar ya»

**Files:**
- Modify: `apps/web/src/lib/bot-config.ts`
- Modify: `apps/web/src/routes/+page.svelte`

**Interfaces:**
- Produces: `lastLevel(): BotLevel`, `saveLastLevel(l: BotLevel)` en `bot-config.ts`; en la portada, `createGame(tc: TimeControl, color: Color | 'random', botLevel?: BotLevel)` y el estado `savedLevel`.

- [ ] **Step 1:** `bot-config.ts`:
```ts
const LEVEL_KEY = 'jaque:bot-level';

/** Último nivel elegido en el diálogo; fácil si no hay ninguno. */
export function lastLevel(): BotLevel {
  try {
    const l = Number(localStorage.getItem(LEVEL_KEY));
    if (l === 1 || l === 2 || l === 3) return l;
  } catch {
    /* almacenamiento bloqueado */
  }
  return 1;
}

export function saveLastLevel(level: BotLevel) {
  try {
    localStorage.setItem(LEVEL_KEY, String(level));
  } catch {
    /* sin almacenamiento: se usará el nivel fácil */
  }
}
```
- [ ] **Step 2:** en `+page.svelte`: `savedLevel = $state<BotLevel>(1)`; en `onMount`, `savedLevel = level = lastLevel()`. `createFriendGame` pasa a `createGame(tc, color, botLevel?)` (mismo cuerpo, con `botLevel` en lugar de `mode === 'bot'`), y el `onsubmit` del diálogo llama a `createGame(friendTc, color, mode === 'bot' ? level : undefined)` tras `saveLastLevel(level)` si es de máquina.
- [ ] **Step 3:** botón principal bajo el subtítulo:
```svelte
  <button class="btn primary quick" disabled={creating} onclick={() => createGame(QUICK_TC, 'random', savedLevel)}>
    <span>Jugar ya contra la máquina</span>
    <small>5+3 · nivel {BOT_LEVELS[savedLevel].toLowerCase()}</small>
  </button>
```
con `const QUICK_TC = { initial: 300, increment: 3 };`. Subtítulo: «Juega ya contra la máquina o elige un ritmo y te emparejamos con alguien.» El segundo botón de modos: «Configurar partida contra la máquina». Estilos `.quick` (ancho completo, 60px de alto, `small` en una segunda línea atenuada).
- [ ] **Step 4:** `pnpm --filter @jaque/web check` → pasa.
- [ ] **Step 5: commit** «Portada: botón Jugar ya contra la máquina».

### Task 4: Portada · oferta tras 12 s

**Files:**
- Modify: `apps/web/src/routes/+page.svelte`

**Interfaces:**
- Consumes: `createGame`, `savedLevel`, `presetById` (tarea 3 y `@jaque/shared`).

- [ ] **Step 1:**
```ts
  /** Tras esta espera sin rival se ofrece jugar contra la máquina. */
  const OFFER_BOT_MS = 12_000;
  let offerBot = $state(false);

  $effect(() => {
    offerBot = false;
    if (!seeking) return;
    const t = setTimeout(() => (offerBot = true), OFFER_BOT_MS);
    return () => clearTimeout(t);
  });
```
- [ ] **Step 2:** el bloque `{#if seeking}` pasa a:
```svelte
  {#if seeking}
    <div class="seeking" role="status">
      {#if offerBot}
        <p>No hay nadie libre ahora mismo.</p>
        <button class="btn primary" disabled={creating} onclick={() => createGame(presetById(seeking!)!, 'random', savedLevel)}>
          Jugar {seeking} contra la máquina
        </button>
        <p class="hint-small">Si prefieres esperar, seguimos buscando rival.</p>
      {:else}
        <p>Buscando rival para {seeking}. Toca la casilla de nuevo para cancelar.</p>
      {/if}
    </div>
  {/if}
```
`presetById` devuelve un `TimeControlPreset` que incluye `initial` e `increment`; pasar `{ initial, increment }` para que el cuerpo del POST no lleve `id`/`speed`. `createGame` ya cancela la búsqueda antes de navegar.
- [ ] **Step 3:** `pnpm --filter @jaque/web check` → pasa.
- [ ] **Step 4: commit** «Portada: ofrece la máquina tras 12 s sin rival».

### Task 5: Portada · pie de estadísticas

**Files:**
- Modify: `apps/web/src/lib/format.ts`
- Modify: `apps/web/src/routes/+page.svelte`

- [ ] **Step 1:** `format.ts`:
```ts
/** 1234 → «1.234» (Intl en español no agrupa números de cuatro cifras). */
export const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
```
- [ ] **Step 2:** tipo de `stats` con `played: number` y el pie:
```svelte
    {#if conn !== 'open'}
      Conectando…
    {:else if stats && stats.players >= 3}
      …(texto actual)…
    {:else if stats && stats.played >= 50}
      {thousands(stats.played)} partidas jugadas en DameJaque
    {/if}
```
Constantes `LIVE_MIN_PLAYERS = 3` y `PLAYED_MIN = 50` junto al resto.
- [ ] **Step 3:** `pnpm --filter @jaque/web check` → pasa.
- [ ] **Step 4: commit** «Portada: estadísticas sin vacío».

### Task 6: Verificación

- [ ] `pnpm check`, `pnpm test`, `pnpm build` en verde.
- [ ] `pnpm dev` y en el navegador: «Jugar ya» abre una partida 5+3 contra la máquina fácil; buscar 3+2 y a los 12 s aparece la oferta; cancelar la quita; el pie no muestra «1 jugador conectado».
- [ ] README: mencionar «Jugar ya» y la oferta en la lista de funciones.
