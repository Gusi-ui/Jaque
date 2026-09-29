# Deshacer la jugada · plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que un jugador pueda pedir deshacer su última jugada y, si el rival acepta, se deshaga; la máquina acepta siempre.

**Architecture:** el motor (`Game`) gana el estado `takebackOffer` y el método `takeback(color, offer, now)`, con la misma forma que las tablas. El protocolo añade `GameView.takeback` y el mensaje `{ t: 'takeback', offer }`; los dos servidores solo lo reenvían al motor. `planBot` acepta; la pantalla de partida muestra el botón y el aviso.

**Tech Stack:** TypeScript, chess.js, node:test (engine, server), vitest + workers pool (worker), SvelteKit 2 + Svelte 5, chessground 9.

**Spec:** `docs/superpowers/specs/2026-09-29-deshacer-jugada-design.md`

## Global Constraints

- Pedir: partida `started`, quien pide ya ha movido (blancas `ply ≥ 1`, negras `ply ≥ 2`), sin petición pendiente y `ply !== noTakebackAt`.
- Aceptar: 1 jugada si le toca al rival de quien pidió; 2 si le toca a quien pidió.
- No se devuelve tiempo; se congela el reloj que corría; `turnStart = now`.
- Mover borra la petición; el rechazo explícito bloquea hasta la siguiente jugada; deshacer retira la oferta de tablas.
- `GameData` gana `takeback?` y `noTakebackAt?` opcionales (partidas guardadas antiguas).
- Textos: «Deshacer», «Deshacer pedido», «Tu rival pide deshacer su última jugada», «Aceptar», «Rechazar».
- Commits en español con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Rama `feature/deshacer-jugada`.

## Review Focus

1. La máquina tras deshacer: con el mismo número de jugadas en otra posición debe volver a pensar y no enviar una jugada pensada para la posición anterior (tarea 3: `bot.ts` compara las jugadas, no solo su número).
2. Petición cruzada: los dos piden a la vez → se deshace una sola vez, según quien pidió primero (tarea 1, test «pedir cuando el rival ya lo pidió acepta»).
3. Deshacer hasta `ply < 2`: relojes parados y plazo de primera jugada otra vez, sin anular la partida al instante (tarea 1, test de relojes).
4. Estar mirando jugadas antiguas o con una premove puesta cuando llega el deshacer: la vista vuelve al directo y la premove se anula (tarea 4, comprobación en navegador).
5. Partida guardada antes del cambio (sin los campos nuevos): carga sin errores (tarea 1, test `fromJSON` con datos antiguos).

---

### Task 1: Motor y protocolo

**Files:**
- Modify: `packages/shared/src/index.ts` (`GameView.takeback`, `ClientGameMsg`)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/game.test.ts`

**Interfaces:**
- Produces: `Game.takebackOffer: Color | null`; `Game.canTakeback(color): boolean`; `Game.takeback(color, offer, now): void`; `GameView.takeback: Color | null`; `ClientGameMsg` `{ t: 'takeback'; offer: boolean }`; `GameData.takeback?`, `GameData.noTakebackAt?`.

- [ ] **Step 1: Tests (añadir al final de `game.test.ts`)**

```ts
test('deshacer: si el rival aún no ha contestado, se deshace una jugada', () => {
  const g = started();
  play(g, ['e2e4', 'e7e5', 'g1f3']);
  g.takeback('white', true, T0);
  assert.equal(g.takebackOffer, 'white');
  assert.equal(g.view(T0).takeback, 'white');
  g.takeback('black', true, T0);
  assert.deepEqual(g.moves, ['e2e4', 'e7e5']);
  assert.deepEqual(g.sans, ['e4', 'e5']);
  assert.equal(g.turn, 'white');
  assert.equal(g.takebackOffer, null);
});

test('deshacer: si el rival ya contestó, se deshacen dos', () => {
  const g = started();
  play(g, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  g.takeback('white', true, T0);
  g.takeback('black', true, T0);
  assert.deepEqual(g.moves, ['e2e4', 'e7e5']);
  assert.equal(g.turn, 'white');
  assert.equal(g.move('white', 'f1c4', 2, T0), null, 'se puede seguir jugando');
});

test('deshacer: solo con la partida en curso y habiendo movido', () => {
  const g = started();
  g.takeback('white', true, T0);
  assert.equal(g.takebackOffer, null, 'blancas sin mover');
  play(g, ['e2e4']);
  g.takeback('black', true, T0);
  assert.equal(g.takebackOffer, null, 'negras sin mover');
  assert.ok(g.canTakeback('white'));
  assert.ok(!g.canTakeback('black'));
  g.resign('black', T0);
  g.takeback('white', true, T0);
  assert.equal(g.takebackOffer, null, 'partida terminada');
});

test('deshacer: pedir cuando el rival ya lo pidió acepta', () => {
  const g = started();
  play(g, ['e2e4', 'e7e5', 'g1f3']);
  g.takeback('white', true, T0);
  g.takeback('black', true, T0);
  assert.deepEqual(g.moves, ['e2e4', 'e7e5']);
  g.takeback('white', true, T0);
  assert.equal(g.takebackOffer, 'white', 'petición nueva, no un segundo deshacer');
  assert.deepEqual(g.moves, ['e2e4', 'e7e5']);
});

test('deshacer: retirar, rechazar y caducar', () => {
  const g = started();
  play(g, ['e2e4', 'e7e5', 'g1f3']);
  g.takeback('white', true, T0);
  g.takeback('white', false, T0);
  assert.equal(g.takebackOffer, null, 'retirada');
  g.takeback('white', true, T0);
  assert.equal(g.takebackOffer, 'white', 'retirar no bloquea');

  g.takeback('black', false, T0);
  assert.equal(g.takebackOffer, null, 'rechazada');
  g.takeback('white', true, T0);
  assert.equal(g.takebackOffer, null, 'bloqueada hasta la siguiente jugada');

  play(g, ['b8c6']);
  assert.ok(g.canTakeback('white'), 'con una jugada nueva se puede otra vez');
  g.takeback('white', true, T0);
  g.move('white', 'f1c4', 4, T0);
  assert.equal(g.takebackOffer, null, 'mover anula la petición');
});

test('deshacer: relojes, tablas y plazo de primera jugada', () => {
  const g = started({ initial: 60, increment: 0 });
  play(g, ['e2e4', 'e7e5'], T0);
  g.move('white', 'g1f3', 2, T0 + 10_000);
  g.draw('white', true, T0 + 10_000);
  g.takeback('white', true, T0 + 12_000);
  g.takeback('black', true, T0 + 15_000);
  assert.equal(g.drawOffer, null, 'la oferta de tablas era de otra posición');
  assert.equal(g.turn, 'white');
  assert.equal(g.remaining('white', T0 + 15_000), 50_000, 'no se devuelve el tiempo');
  assert.equal(g.remaining('black', T0 + 15_000), 55_000, 'se congela el reloj que corría');
  assert.equal(g.remaining('white', T0 + 16_000), 49_000, 'y el turno arranca al deshacer');

  const h = started();
  play(h, ['e2e4', 'e7e5']);
  h.takeback('black', true, T0 + 1_000);
  h.takeback('white', true, T0 + 2_000);
  assert.deepEqual(h.moves, ['e2e4']);
  assert.equal(h.view(T0 + 2_000).clock.running, null, 'con menos de dos jugadas el reloj se para');
  assert.equal(h.nextDeadline(), T0 + 2_000 + FIRST_MOVE_MS);
  assert.equal(h.tick(T0 + 3_000), false, 'no se anula al instante');
});

test('deshacer: toJSON / fromJSON, también con datos antiguos', () => {
  const g = started();
  play(g, ['e2e4', 'e7e5', 'g1f3']);
  g.takeback('white', true, T0);
  const copy = Game.fromJSON(JSON.parse(JSON.stringify(g)));
  assert.equal(copy.takebackOffer, 'white');
  assert.deepEqual(copy.toJSON(), g.toJSON());

  const old = g.toJSON() as Partial<ReturnType<Game['toJSON']>>;
  delete old.takeback;
  delete old.noTakebackAt;
  const legacy = Game.fromJSON(old as ReturnType<Game['toJSON']>);
  assert.equal(legacy.takebackOffer, null);
  assert.ok(legacy.canTakeback('white'));
});
```

- [ ] **Step 2:** `pnpm --filter @jaque/engine test` → FAIL (`g.takeback is not a function`).

- [ ] **Step 3: Implementación**

`packages/shared/src/index.ts`: en `GameView`, tras `drawOffer`:

```ts
  /** Quién ha pedido deshacer su última jugada, o null. */
  takeback: Color | null;
```

y en `ClientGameMsg`, tras `draw`: `| { t: 'takeback'; offer: boolean }`.

`packages/engine/src/index.ts`:

- `GameData`, tras `drawOffer`:
```ts
  /** Opcionales: las partidas guardadas antes de poder deshacer no los tienen. */
  takeback?: Color | null;
  noTakebackAt?: number | null;
```
- Campos, tras `drawOffer`:
```ts
  /** Quién ha pedido deshacer su última jugada. */
  takebackOffer: Color | null = null;
  /** Jugadas cuando se rechazó la última petición: hasta la siguiente no se puede pedir otra. */
  private noTakebackAt: number | null = null;
```
- En `move()`, tras la caducidad de tablas: `this.takebackOffer = null;`
- Métodos, tras `draw()`:
```ts
  /** Partida en curso, quien pide ya ha movido y no la acaban de rechazar. */
  canTakeback(color: Color) {
    return (
      this.status === 'started' &&
      this.ply >= (color === 'white' ? 1 : 2) &&
      this.ply !== this.noTakebackAt
    );
  }

  /** Pedir (o aceptar) deshacer la última jugada propia; `offer: false` retira o rechaza. */
  takeback(color: Color, offer: boolean, now: number) {
    if (this.status !== 'started') return;
    if (!offer) {
      if (!this.takebackOffer) return;
      // Rechazar la del rival impide pedirla otra vez hasta la siguiente jugada.
      if (this.takebackOffer !== color) this.noTakebackAt = this.ply;
      this.takebackOffer = null;
      this.changed(now);
      return;
    }
    if (this.takebackOffer === opposite(color)) return this.undo(opposite(color), now);
    if (this.takebackOffer || !this.canTakeback(color)) return;
    this.takebackOffer = color;
    this.changed(now);
  }
```
- En `// ─── Interno`:
```ts
  /** Deshace hasta que vuelva a ser el turno de quien lo pidió. No devuelve tiempo. */
  private undo(requester: Color, now: number) {
    if (this.clockRunning) this.clock[this.turn] = this.remaining(this.turn, now);
    const n = this.turn === requester ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.chess.undo();
      this.moves.pop();
      this.sans.pop();
    }
    this.turnStart = now;
    this.takebackOffer = null;
    this.drawOffer = null;
    this.changed(now);
  }
```
- `end()`: `this.takebackOffer = null;` junto a `this.drawOffer = null;`
- `view()`: `takeback: this.takebackOffer,` tras `drawOffer`.
- `toJSON()`: `takeback: this.takebackOffer, noTakebackAt: this.noTakebackAt,` tras `drawOffer`.
- `load()`: `this.takebackOffer = data.takeback ?? null; this.noTakebackAt = data.noTakebackAt ?? null;`

- [ ] **Step 4:** `pnpm --filter @jaque/engine test && pnpm --filter @jaque/engine check` → PASS.
- [ ] **Step 5:** commit «Motor: deshacer la jugada».

---

### Task 2: Servidores

**Files:** `apps/worker/src/game-room.ts`, `apps/server/src/game.ts`, `apps/server/src/index.ts`, `apps/worker/test/worker.test.ts`.

**Interfaces:** Consumes `Game.takeback(color, offer, now)` y el mensaje `{ t: 'takeback', offer }`.

- [ ] **Step 1: Test del worker** (en `describe('partidas')`):

```ts
  it('deshacer: se pide y se acepta por WebSocket', async () => {
    const { a, b } = await startedGame();
    await play(a, b, ['e2e4', 'e7e5', 'g1f3']);
    a.send({ t: 'takeback', offer: true });
    await b.next((m) => m.t === 'state' && m.game.takeback === 'white');
    b.send({ t: 'takeback', offer: true });
    const undone = await a.next((m) => m.t === 'state' && m.game.moves.length === 2);
    expect(undone.game.turn).toBe('white');
    expect(undone.game.takeback).toBe(null);
    for (const c of [a, b]) c.ws.close();
  });
```

- [ ] **Step 2:** `pnpm --filter @jaque/worker test` → FAIL (timeout esperando `takeback === 'white'`).
- [ ] **Step 3:** `game-room.ts`, tras `case 'draw'`:
```ts
      case 'takeback':
        game.takeback(color, !!msg.offer, now);
        break;
```
`apps/server/src/game.ts`, tras `draw`:
```ts
  override takeback(color: Color, offer: boolean, now = Date.now()) {
    super.takeback(color, offer, now);
  }
```
`apps/server/src/index.ts`, tras `case 'draw'`:
```ts
    case 'takeback':
      return game.takeback(color, !!msg.offer);
```
- [ ] **Step 4:** `pnpm --filter @jaque/worker test && pnpm --filter @jaque/server check && pnpm --filter @jaque/worker check` → PASS. (El test del servidor Node va en la tarea 3, con la máquina.)
- [ ] **Step 5:** commit «Servidores: mensaje para deshacer la jugada».

---

### Task 3: La máquina acepta

**Files:** `packages/engine/src/bot.ts`, `apps/web/src/lib/bot.ts`, `packages/engine/test/bot.test.ts`, `apps/server/test/server.test.ts`.

**Interfaces:** Consumes `GameView.takeback`.

- [ ] **Step 1: Tests**

`bot.test.ts`:
```ts
test('política: acepta siempre deshacer y nunca lo pide', () => {
  const g = new Game('AAAAAAAA', { initial: 60, increment: 0 }, 0);
  g.join('human-player-00000', 'white', 0);
  g.join('bot-player-0000000', 'black', 0);
  for (const [i, m] of ['e2e4', 'e7e5', 'g1f3'].entries()) g.move(i % 2 ? 'black' : 'white', m, i, 0);
  g.takeback('white', true, 0);
  assert.deepEqual(planBot(view(g), 'black'), { send: [{ t: 'takeback', offer: true }], think: false });
  g.takeback('black', true, 0);
  assert.deepEqual(planBot(view(g), 'black').send, []);
});
```
`server.test.ts`, en «contra la máquina», justo después de `assert.equal(reply.game.turn, 'white', 'la máquina ha contestado');`:
```ts
  a.send({ t: 'takeback', offer: true });
  await a.next((m) => m.t === 'state' && m.game.moves.length === 0);
  a.send({ t: 'move', uci: 'd2d4', ply: 0 });
  await a.next((m) => m.t === 'state' && m.game.moves.length === 2);
```
(y el título pasa a «contra la máquina: se sienta, juega, deja deshacer, acepta tablas y la revancha»).

- [ ] **Step 2:** `pnpm --filter @jaque/engine test` → FAIL en la política; `pnpm --filter @jaque/server test` → FAIL (timeout).
- [ ] **Step 3:** `planBot`, antes del bloque de tablas:
```ts
  // Contra la máquina se puede deshacer siempre: acepta al momento.
  if (view.takeback === rival) return { send: [{ t: 'takeback', offer: true }], think: false };
```
`apps/web/src/lib/bot.ts`:
- En `act`, al principio: si la partida tiene menos jugadas que aquella para la que pensaba, se ha deshecho:
```ts
    // Se ha deshecho una jugada: lo pensado ya no vale.
    if (v.moves.length < thinkingAt) {
      thinkingAt = -1;
      clearTimeout(moveTimer);
    }
```
- La firma incluye `v.takeback`: `JSON.stringify([v.status, v.moves.length, v.drawOffer, v.takeback, v.rematch, you, plan.send])`.
- Al enviar la jugada pensada, comparar la posición y no solo su tamaño:
```ts
        if (view?.status === 'started' && view.moves.join() === req.moves.join()) {
```
- [ ] **Step 4:** `pnpm --filter @jaque/engine test && pnpm --filter @jaque/server test && pnpm --filter @jaque/web check` → PASS.
- [ ] **Step 5:** commit «Máquina: acepta deshacer la jugada».

---

### Task 4: Pantalla de partida

**Files:** `apps/web/src/lib/Board.svelte`, `apps/web/src/lib/Game.svelte`.

**Interfaces:** Consumes `GameView.takeback`, mensaje `{ t: 'takeback', offer }`. Produces `Board.cancelPremove()`.

- [ ] **Step 1: `Board.svelte`**, tras `cancelMove`:
```ts
  export function cancelPremove() {
    cg?.cancelPremove();
  }
```
- [ ] **Step 2: `Game.svelte`**
- Derivado, junto a `canAbort`:
```ts
  /** Mismo criterio que el motor (el bloqueo tras un rechazo lo decide el servidor). */
  const canTakeback = $derived(
    !!game && !!you && game.status === 'started' && game.moves.length >= (you === 'white' ? 1 : 2)
  );
```
- `applyState`, tras el bloque de `moves.length + 1`:
```ts
    // Se ha deshecho: volver al directo y olvidar la premove.
    if (next.moves.length < prev.moves.length) {
      sound.move();
      viewPly = null;
      promo = null;
      board?.cancelPremove();
    }
```
- Aviso, justo después del de tablas:
```svelte
        {#if game.takeback && game.takeback !== you}
          <div class="offer">
            <span>Tu rival pide deshacer su última jugada</span>
            <button class="btn primary" onclick={() => send({ t: 'takeback', offer: true })}>Aceptar</button>
            <button class="btn" onclick={() => send({ t: 'takeback', offer: false })}>Rechazar</button>
          </div>
        {/if}
```
- Botón, en la fila, antes de «Ofrecer tablas» (dentro del `{:else}` de `canAbort`):
```svelte
            {#if canTakeback}
              <button
                class="btn"
                aria-pressed={game.takeback === you}
                onclick={() => send({ t: 'takeback', offer: game.takeback !== you })}
              >
                {game.takeback === you ? 'Deshacer pedido' : 'Deshacer'}
              </button>
            {/if}
```
- [ ] **Step 3:** `pnpm check && pnpm build` → sin errores.
- [ ] **Step 4: Navegador** (`pnpm dev`): dos pestañas con jugadores distintos (una en ventana de incógnito): pedir, aceptar (1 y 2 jugadas), rechazar y volver a pedir tras una jugada; mirando una jugada antigua cuando llega el deshacer; contra la máquina, deshacer mientras piensa y seguir jugando; en móvil (iframe de 390 px) que la fila de botones cabe.
- [ ] **Step 5:** commit «Partida: botón y aviso para deshacer la jugada»; dejar `pnpm dev` arrancado para la revisión del usuario.
