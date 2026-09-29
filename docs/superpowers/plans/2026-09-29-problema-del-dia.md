# Problema del día · plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un problema de mate al día en la portada, el mismo para todos, que se resuelve allí mismo sin registro.

**Architecture:** un script genera `packages/engine/src/puzzles.json` (7 grupos × 53 problemas de la base CC0 de lichess) y se sube al repo. La lógica pura (`dayKey`, `puzzleOfDay`, `PuzzleRun`) vive en `@jaque/engine/puzzle` con tests. En la web, `DailyPuzzle.svelte` se prerenderiza como un hueco y, al montarse, carga con `import()` el tablero, la lógica y el JSON: la portada no pesa más en la carga inicial.

**Tech Stack:** SvelteKit 2 + Svelte 5 (portada prerenderizada), chessground 9, chess.js 1, node:test con tsx (engine), Node 22 (`zlib.createZstdDecompress`).

**Spec:** `docs/superpowers/specs/2026-09-29-problema-del-dia-design.md`

## Global Constraints

- La página **no menciona a lichess** en ningún sitio (CC0 no exige atribución).
- Filtro: `mateIn1|mateIn2|mateIn3`, `Popularity ≥ 90`, `NbPlays ≥ 1000`, `RatingDeviation < 80`.
- Grupos (0 = lunes … 6 = domingo): mate 1 600–1000, mate 1 1000–1400, mate 2 1000–1300, mate 2 1300–1600, mate 2 1600–1900, mate 3 1400–1800, mate 3 1800–2200 (Elo en `[min, max)`); 53 por grupo.
- El día cambia a medianoche de **Europa/Madrid**. Fecha de referencia: lunes **2026-01-05**.
- Cualquier jugada que dé mate cuenta como resuelto.
- Tiempos: contestación del rival **350 ms**; cada jugada de «Ver solución» **600 ms**.
- `localStorage` clave `jaque:problema` = `{ key, result: 'solved' | 'shown' }`, siempre en try/catch.
- Textos: «Problema del día», «Juegan blancas/negras · Mate en N», «Encuentra la jugada.», «Esa no es. Prueba otra vez.», «¡Bien! Sigue.», «Mueve esta pieza.», «¡Resuelto! Vuelve mañana para otro.», «Esta era la solución. Mañana, otro.», botones «Pista» y «Ver solución».
- La columna de la portada mide 520 px: el tablero del problema es de **240 px** en escritorio (ajuste respecto a los ≈300 px del spec) y, por debajo de 520 px de ancho, ocupa todo el ancho hasta 360 px.
- Commits en español, con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Rama `feature/problema-del-dia`.

## Review Focus

1. Llega un rival mientras el rival del problema «piensa» o se reproduce la solución: se va a la partida sin errores; los temporizadores se limpian al desmontar (tarea 3, `onMount` devuelve la limpieza).
2. Jugadas fuera de turno (mientras llega la contestación) o después de resolver: se rechazan (tarea 1, test «rechaza jugadas fuera de turno o tras resolver»).
3. Mate distinto del de la solución, también coronando a torre: cuenta como resuelto (tarea 1, tests de mate alternativo y coronación).
4. `localStorage` bloqueado o con basura: el problema se puede jugar igual (tarea 3, `loadResult` valida; tarea 4 lo comprueba a mano).
5. Falla la carga del JSON o del tablero (sin red): la sección desaparece y el resto de la portada funciona (tarea 3, `failed`).

---

### Task 1: Lógica del problema en `@jaque/engine`

**Files:**
- Create: `packages/engine/src/puzzle.ts`
- Create: `packages/engine/test/puzzle.test.ts`
- Modify: `packages/engine/package.json` (exports)

**Interfaces:**
- Produces:
  - `type PuzzleEntry = [id: string, fen: string, moves: string, rating: number]`
  - `interface PuzzleData { v: 1; days: PuzzleEntry[][] }`
  - `const GROUPS: readonly { goal: 1 | 2 | 3; min: number; max: number }[]`, `const GROUP_SIZE = 53`
  - `interface DailyPuzzle { key: string; id: string; fen: string; solution: string[]; goal: number }`
  - `dayKey(now: Date): string`, `puzzleOfDay(now: Date, data: PuzzleData): DailyPuzzle`
  - `type PlayResult = 'wrong' | 'solved' | { reply: string }`
  - `class PuzzleRun { constructor(puzzle: DailyPuzzle); readonly side: Color; fen; turn: Color; check: boolean; solved: boolean; lastMove: [string, string] | undefined; dests(): Map<string, string[]>; uci(orig: string, dest: string): string; play(uci: string): PlayResult; step(): string | undefined; hint(): string | undefined }`
  - Export `@jaque/engine/puzzle`.
- Nota: `play` en acierto aplica solo la jugada de quien resuelve; la contestación la aplica quien llama con `step()` (así la web la enseña con retraso). `step()` sustituye al `rest()` del spec.

- [ ] **Step 1: Escribir los tests**

`packages/engine/test/puzzle.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, PuzzleRun, dayKey, puzzleOfDay, type DailyPuzzle, type PuzzleData, type PuzzleEntry } from '../src/puzzle.ts';

const puzzle = (fen: string, solution: string[]): DailyPuzzle => ({
  key: '2026-01-05',
  id: 'x',
  fen,
  solution,
  goal: Math.ceil(solution.length / 2)
});

// 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? — Qxf7#
const SCHOLAR = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
// Ra8# y Re8# dan mate los dos.
const BACK_RANK = '6k1/5ppp/8/8/8/8/5PPP/R3R1K1 w - - 0 1';
// Mate en 2: Re8+ Rxe8 Rxe8#.
const DOUBLED = '3r2k1/5ppp/8/8/8/8/4RPPP/4R1K1 w - - 0 1';
// h8=D# (y h8=T# también).
const PROMO = 'k7/7P/1K6/8/8/8/8/8 w - - 0 1';

test('dayKey cambia a medianoche de Madrid', () => {
  assert.equal(dayKey(new Date('2026-07-15T21:59:00Z')), '2026-07-15');
  assert.equal(dayKey(new Date('2026-07-15T22:30:00Z')), '2026-07-16'); // verano, UTC+2
  assert.equal(dayKey(new Date('2026-01-15T22:30:00Z')), '2026-01-15'); // invierno, UTC+1
  assert.equal(dayKey(new Date('2026-01-15T23:00:00Z')), '2026-01-16');
});

test('puzzleOfDay: un grupo por día de la semana y vuelta al empezar', () => {
  const data: PuzzleData = {
    v: 1,
    days: Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 2 }, (_, i): PuzzleEntry => [`d${d}-${i}`, SCHOLAR, 'h5f7', 1000])
    )
  };
  const id = (iso: string) => puzzleOfDay(new Date(iso), data).id;
  assert.equal(id('2026-01-05T10:00:00Z'), 'd0-0'); // lunes de referencia
  assert.equal(id('2026-01-11T10:00:00Z'), 'd6-0'); // domingo
  assert.equal(id('2026-01-12T10:00:00Z'), 'd0-1'); // lunes siguiente
  assert.equal(id('2026-01-19T10:00:00Z'), 'd0-0'); // vuelta al principio del grupo
  assert.equal(id('2026-01-04T10:00:00Z'), 'd6-1'); // antes de la fecha de referencia
  const p = puzzleOfDay(new Date('2026-01-05T10:00:00Z'), data);
  assert.deepEqual(p, { key: '2026-01-05', id: 'd0-0', fen: SCHOLAR, solution: ['h5f7'], goal: 1 });
});

test('GROUPS: siete grupos, mates en 1, 1, 2, 2, 2, 3, 3', () => {
  assert.deepEqual(GROUPS.map((g) => g.goal), [1, 1, 2, 2, 2, 3, 3]);
});

test('mate en 1: acierto y fallo', () => {
  const run = new PuzzleRun(puzzle(SCHOLAR, ['h5f7']));
  assert.equal(run.side, 'white');
  assert.equal(run.play('h5h6'), 'wrong');
  assert.equal(run.fen, SCHOLAR, 'el fallo no cambia la posición');
  assert.equal(run.play('a1a8'), 'wrong', 'una jugada ilegal es un fallo');
  assert.equal(run.play('h5f7'), 'solved');
  assert.ok(run.solved);
  assert.deepEqual(run.lastMove, ['h5', 'f7']);
});

test('cualquier mate vale', () => {
  const run = new PuzzleRun(puzzle(BACK_RANK, ['a1a8']));
  assert.equal(run.play('e1e8'), 'solved');
});

test('mate en 2: contestación con step()', () => {
  const run = new PuzzleRun(puzzle(DOUBLED, ['e2e8', 'd8e8', 'e1e8']));
  assert.equal(run.hint(), 'e2');
  assert.equal(run.play('g1f1'), 'wrong');
  assert.deepEqual(run.play('e2e8'), { reply: 'd8e8' });
  assert.equal(run.turn, 'black');
  assert.equal(run.step(), 'd8e8');
  assert.equal(run.turn, 'white');
  assert.equal(run.hint(), 'e1');
  assert.equal(run.play('e1e8'), 'solved');
  assert.equal(run.hint(), undefined);
});

test('rechaza jugadas fuera de turno o tras resolver', () => {
  const run = new PuzzleRun(puzzle(DOUBLED, ['e2e8', 'd8e8', 'e1e8']));
  run.play('e2e8');
  assert.equal(run.play('d8e8'), 'wrong', 'no es turno de quien resuelve');
  run.step();
  run.play('e1e8');
  assert.equal(run.play('g1f1'), 'wrong');
  assert.equal(run.dests().size, 0);
});

test('step() reproduce la solución entera', () => {
  const run = new PuzzleRun(puzzle(DOUBLED, ['e2e8', 'd8e8', 'e1e8']));
  const played: string[] = [];
  for (let m = run.step(); m; m = run.step()) played.push(m);
  assert.deepEqual(played, ['e2e8', 'd8e8', 'e1e8']);
  assert.ok(run.solved);
});

test('coronación: completa la pieza y acepta otra que dé mate', () => {
  const run = new PuzzleRun(puzzle(PROMO, ['h7h8q']));
  assert.equal(run.uci('h7', 'h8'), 'h7h8q');
  assert.equal(run.uci('b6', 'b5'), 'b6b5');
  assert.equal(run.play('h7h8r'), 'solved');
});

test('dests: solo las del bando que mueve', () => {
  const run = new PuzzleRun(puzzle(PROMO, ['h7h8q']));
  assert.deepEqual(run.dests().get('h7'), ['h8']);
});
```

- [ ] **Step 2: Ver que fallan**

Run: `pnpm --filter @jaque/engine test`
Expected: FAIL, `Cannot find module '../src/puzzle.ts'`.

- [ ] **Step 3: Implementar**

`packages/engine/src/puzzle.ts`:

```ts
import { Chess, type Square } from 'chess.js';
import type { Color } from '@jaque/shared';

/** Un problema tal y como se guarda en puzzles.json: id, posición, solución en UCI y Elo. */
export type PuzzleEntry = [id: string, fen: string, moves: string, rating: number];

/** puzzles.json: un grupo de problemas por día de la semana, empezando en lunes. */
export interface PuzzleData {
  v: 1;
  days: PuzzleEntry[][];
}

/** Qué entra en cada grupo (0 = lunes): tipo de mate y Elo en [min, max). */
export const GROUPS = [
  { goal: 1, min: 600, max: 1000 },
  { goal: 1, min: 1000, max: 1400 },
  { goal: 2, min: 1000, max: 1300 },
  { goal: 2, min: 1300, max: 1600 },
  { goal: 2, min: 1600, max: 1900 },
  { goal: 3, min: 1400, max: 1800 },
  { goal: 3, min: 1800, max: 2200 }
] as const;

/** Problemas por grupo: un año sin repetir. */
export const GROUP_SIZE = 53;

export interface DailyPuzzle {
  /** Día en Madrid, 'YYYY-MM-DD'. */
  key: string;
  id: string;
  fen: string;
  /** Jugadas en UCI, alternando quien resuelve y el rival; la última da mate. */
  solution: string[];
  /** Mate en `goal`. */
  goal: number;
}

const madrid = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** Fecha en Madrid: el problema cambia a medianoche en España. */
export function dayKey(now: Date): string {
  const p = Object.fromEntries(madrid.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Lunes de referencia para contar semanas. */
const EPOCH = Date.UTC(2026, 0, 5);
const DAY_MS = 86_400_000;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function puzzleOfDay(now: Date, data: PuzzleData): DailyPuzzle {
  const key = dayKey(now);
  const days = Math.round((Date.parse(`${key}T00:00:00Z`) - EPOCH) / DAY_MS);
  const group = data.days[mod(days, 7)];
  const [id, fen, moves] = group[mod(Math.floor(days / 7), group.length)];
  const solution = moves.split(' ');
  return { key, id, fen, solution, goal: Math.ceil(solution.length / 2) };
}

/** Acierto: `{ reply }` es la contestación del rival, que se aplica con `step()`. */
export type PlayResult = 'wrong' | 'solved' | { reply: string };

/** Un intento de resolver un problema. */
export class PuzzleRun {
  private readonly chess: Chess;
  private ply = 0;
  /** Bando de quien resuelve. */
  readonly side: Color;

  constructor(readonly puzzle: DailyPuzzle) {
    this.chess = new Chess(puzzle.fen);
    this.side = this.turn;
  }

  get fen() {
    return this.chess.fen();
  }
  get turn(): Color {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }
  get check() {
    return this.chess.inCheck();
  }
  get solved() {
    return this.chess.isCheckmate();
  }
  get lastMove(): [string, string] | undefined {
    const m = this.chess.history({ verbose: true }).at(-1);
    return m && [m.from, m.to];
  }

  dests(): Map<string, string[]> {
    const dests = new Map<string, string[]>();
    for (const m of this.chess.moves({ verbose: true })) {
      dests.set(m.from, [...(dests.get(m.from) ?? []), m.to]);
    }
    return dests;
  }

  /** UCI de una jugada del tablero: corona como pide la solución o, si no, a dama. */
  uci(orig: string, dest: string): string {
    const expected = this.puzzle.solution[this.ply];
    if (expected?.startsWith(orig + dest)) return expected;
    const piece = this.chess.get(orig as Square);
    return piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1') ? `${orig}${dest}q` : orig + dest;
  }

  play(uci: string): PlayResult {
    if (this.solved || this.turn !== this.side) return 'wrong';
    try {
      this.move(uci);
    } catch {
      return 'wrong';
    }
    if (this.chess.isCheckmate()) {
      this.ply = this.puzzle.solution.length;
      return 'solved';
    }
    if (uci !== this.puzzle.solution[this.ply]) {
      this.chess.undo();
      return 'wrong';
    }
    this.ply++;
    const reply = this.puzzle.solution[this.ply];
    return reply ? { reply } : 'solved';
  }

  /** Juega la siguiente jugada de la solución, de quien resuelve o del rival. */
  step(): string | undefined {
    const uci = this.puzzle.solution[this.ply];
    if (!uci) return undefined;
    this.move(uci);
    this.ply++;
    return uci;
  }

  /** Casilla de la pieza que hay que mover. */
  hint(): string | undefined {
    return this.solved ? undefined : this.puzzle.solution[this.ply]?.slice(0, 2);
  }

  private move(uci: string) {
    this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
}
```

En `packages/engine/package.json`, añadir a `exports`: `"./puzzle": "./src/puzzle.ts"`.

- [ ] **Step 4: Ver que pasan**

Run: `pnpm --filter @jaque/engine test && pnpm --filter @jaque/engine check`
Expected: PASS, sin errores de tipos.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/puzzle.ts packages/engine/test/puzzle.test.ts packages/engine/package.json
git commit -m "Engine: lógica del problema del día"
```

---

### Task 2: Script y lista de problemas

**Files:**
- Create: `packages/engine/scripts/build-puzzles.ts`
- Create: `packages/engine/src/puzzles.json` (generado)
- Modify: `packages/engine/package.json` (script `puzzles`, export `./puzzles.json`)
- Modify: `packages/engine/tsconfig.json` (`include` gana `"scripts"`)
- Modify: `packages/engine/test/puzzle.test.ts` (test de integridad)

**Interfaces:**
- Consumes: `GROUPS`, `GROUP_SIZE`, `PuzzleData`, `PuzzleEntry`, `PuzzleRun` (tarea 1).
- Produces: `@jaque/engine/puzzles.json` con forma `PuzzleData`.

- [ ] **Step 1: Test de integridad (falla sin el JSON)**

Añadir a `packages/engine/test/puzzle.test.ts` (import de `readFileSync` de `node:fs` y de `GROUP_SIZE`):

```ts
test('puzzles.json: 7 grupos de 53, soluciones legales que acaban en mate', () => {
  const data = JSON.parse(readFileSync(new URL('../src/puzzles.json', import.meta.url), 'utf8')) as PuzzleData;
  assert.equal(data.v, 1);
  assert.equal(data.days.length, 7);
  const ids = new Set<string>();
  data.days.forEach((group, d) => {
    assert.equal(group.length, GROUP_SIZE, `grupo ${d}`);
    for (const [id, fen, moves, rating] of group) {
      assert.ok(!ids.has(id), `repetido ${id}`);
      ids.add(id);
      assert.ok(rating >= GROUPS[d].min && rating < GROUPS[d].max, `${id}: Elo ${rating}`);
      const solution = moves.split(' ');
      assert.equal(Math.ceil(solution.length / 2), GROUPS[d].goal, `${id}: mate en ${GROUPS[d].goal}`);
      const run = new PuzzleRun({ key: '', id, fen, solution, goal: GROUPS[d].goal });
      for (let i = 0; i < solution.length; i += 2) {
        const r = run.play(solution[i]);
        if (i === solution.length - 1) assert.equal(r, 'solved', id);
        else {
          assert.deepEqual(r, { reply: solution[i + 1] }, id);
          run.step();
        }
      }
    }
  });
});
```

Run: `pnpm --filter @jaque/engine test` → FAIL, `ENOENT … puzzles.json`.

- [ ] **Step 2: Script**

`packages/engine/scripts/build-puzzles.ts`:

```ts
// Genera src/puzzles.json a partir de la base abierta (CC0) de problemas de lichess.
// Uso: pnpm --filter @jaque/engine puzzles   (descarga unos 270 MB)
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';
import { Chess } from 'chess.js';
import { GROUPS, GROUP_SIZE, type PuzzleEntry } from '../src/puzzle.ts';

const URL_DB = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';

interface Candidate {
  entry: PuzzleEntry;
  popularity: number;
  plays: number;
}

const res = await fetch(URL_DB);
if (!res.ok || !res.body) throw new Error(`Descarga fallida: ${res.status}`);
const csv = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream).pipe(createZstdDecompress());

const buckets: Candidate[][] = GROUPS.map(() => []);
let header = true;
for await (const line of createInterface({ input: csv, crlfDelay: Infinity })) {
  if (header) {
    header = false;
    continue;
  }
  // PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
  const [id, fen, moves, rating, deviation, popularity, plays, themes] = line.split(',');
  if (Number(popularity) < 90 || Number(plays) < 1000 || Number(deviation) >= 80) continue;
  const goal = Number(/\bmateIn([123])\b/.exec(themes)?.[1]);
  const r = Number(rating);
  const g = GROUPS.findIndex((x) => x.goal === goal && r >= x.min && r < x.max);
  if (g < 0) continue;

  // La primera jugada es la del rival: la posición del problema es la de después.
  const [first, ...solution] = moves.split(' ');
  const chess = new Chess(fen);
  const move = (uci: string) => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  move(first);
  const start = chess.fen();
  solution.forEach(move);
  if (!chess.isCheckmate()) continue;

  buckets[g].push({ entry: [id, start, solution.join(' '), r], popularity: Number(popularity), plays: Number(plays) });
}

const days = buckets.map((b, i) => {
  if (b.length < GROUP_SIZE) throw new Error(`Grupo ${i}: solo ${b.length} problemas`);
  return b
    .sort((a, z) => z.popularity - a.popularity || z.plays - a.plays)
    .slice(0, GROUP_SIZE)
    .map((c) => c.entry)
    .sort((a, z) => a[0].localeCompare(z[0]));
});

// Un problema por línea: diffs legibles.
const json = `{"v":1,"days":[\n${days.map((d) => `[\n${d.map((e) => JSON.stringify(e)).join(',\n')}\n]`).join(',\n')}\n]}\n`;
writeFileSync(new URL('../src/puzzles.json', import.meta.url), json);
console.log(`puzzles.json: ${days.map((d) => d.length).join(' + ')} problemas`);
```

En `packages/engine/package.json`: `"scripts"` gana `"puzzles": "tsx scripts/build-puzzles.ts"`; `"exports"` gana `"./puzzles.json": "./src/puzzles.json"`. En `packages/engine/tsconfig.json`: `"include": ["src", "test", "scripts"]`.

Si `@types/node` no declara `createZstdDecompress`, subir `@types/node` a la última 22.x (`pnpm --filter @jaque/engine add -D @types/node@^22`).

- [ ] **Step 3: Generar el JSON**

Run: `pnpm --filter @jaque/engine puzzles`
Expected: `puzzles.json: 53 + 53 + 53 + 53 + 53 + 53 + 53 problemas`. El archivo pesa unos 40 KB.

- [ ] **Step 4: Ver que pasan**

Run: `pnpm --filter @jaque/engine test && pnpm --filter @jaque/engine check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/scripts packages/engine/src/puzzles.json packages/engine/package.json packages/engine/tsconfig.json packages/engine/test/puzzle.test.ts pnpm-lock.yaml
git commit -m "Engine: lista de problemas del día"
```

---

### Task 3: Problema del día en la portada

**Files:**
- Modify: `apps/web/src/lib/Board.svelte` (prop `shapes`)
- Create: `apps/web/src/lib/DailyPuzzle.svelte`
- Modify: `apps/web/src/routes/+page.svelte` (colocar el componente; temporizador del reto)

**Interfaces:**
- Consumes: `puzzleOfDay`, `PuzzleRun`, `PuzzleData`, `DailyPuzzle` de `@jaque/engine/puzzle`; `@jaque/engine/puzzles.json`.
- Produces: `<DailyPuzzle onactivity={() => void} />`; `Board` gana `shapes?: DrawShape[]`.

- [ ] **Step 1: `Board.svelte` acepta `shapes`**

En `Props` añadir:

```ts
    /** Marcas fijas sobre el tablero (la pista del problema del día). */
    shapes?: DrawShape[];
```

con `import type { DrawShape } from 'chessground/draw';`, desestructurar `shapes = []`, y en `config()` añadir `drawable: { autoShapes: shapes }`. En `onMount`, cambiar `drawable: { enabled: true }` por `drawable: { ...config().drawable, enabled: true }` para no perderlas. (chessground sustituye `autoShapes` en cada `set`, no las mezcla.)

- [ ] **Step 2: `DailyPuzzle.svelte`**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import type { DrawShape } from 'chessground/draw';
  import type { Dests, Key } from 'chessground/types';
  import type { Color } from '@jaque/shared';
  import type { DailyPuzzle, PuzzleData, PuzzleRun } from '@jaque/engine/puzzle';
  import type BoardComponent from './Board.svelte';
  import { sound } from './sound';

  interface Props {
    /** Primera vez que el visitante toca el problema. */
    onactivity?: () => void;
  }
  let { onactivity }: Props = $props();

  const STORE_KEY = 'jaque:problema';
  const REPLY_MS = 350;
  const SOLUTION_MS = 600;

  type Result = 'solved' | 'shown';
  const MESSAGES: Record<Result, string> = {
    solved: '¡Resuelto! Vuelve mañana para otro.',
    shown: 'Esta era la solución. Mañana, otro.'
  };

  interface View {
    fen: string;
    turn: Color;
    lastMove?: [Key, Key];
    check: boolean;
    dests: Dests;
  }

  // Tablero, lógica y lista se cargan al montar: la portada prerenderizada no pesa más.
  let Board = $state.raw<typeof BoardComponent>();
  let board = $state<ReturnType<typeof BoardComponent>>();
  let run: PuzzleRun | undefined;
  let puzzle = $state.raw<DailyPuzzle>();
  let side = $state<Color>('white');
  let view = $state.raw<View>();
  let result = $state<Result | null>(null);
  let message = $state('Encuentra la jugada.');
  let busy = $state(false);
  let shapes = $state.raw<DrawShape[]>([]);
  let failed = $state(false);
  let touched = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    let alive = true;
    Promise.all([import('./Board.svelte'), import('@jaque/engine/puzzle'), import('@jaque/engine/puzzles.json')])
      .then(([boardModule, logic, list]) => {
        if (!alive) return;
        const today = logic.puzzleOfDay(new Date(), list.default as unknown as PuzzleData);
        run = new logic.PuzzleRun(today);
        side = run.side;
        const saved = loadResult(today.key);
        if (saved) {
          while (run.step());
          result = saved;
          message = MESSAGES[saved];
        }
        puzzle = today;
        sync();
        Board = boardModule.default;
      })
      .catch(() => (failed = true));
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  });

  function sync() {
    if (!run) return;
    view = {
      fen: run.fen,
      turn: run.turn,
      lastMove: run.lastMove as [Key, Key] | undefined,
      check: run.check,
      dests: run.dests() as Dests
    };
  }

  function touch() {
    if (touched) return;
    touched = true;
    onactivity?.();
  }

  function onMove(orig: Key, dest: Key) {
    if (!run || busy || result) return;
    touch();
    shapes = [];
    const outcome = run.play(run.uci(orig, dest));
    if (outcome === 'wrong') {
      board?.cancelMove();
      message = 'Esa no es. Prueba otra vez.';
      return;
    }
    sound.move();
    sync();
    if (outcome === 'solved') return finish('solved');
    message = '¡Bien! Sigue.';
    busy = true;
    timer = setTimeout(() => {
      run?.step();
      sound.move();
      sync();
      busy = false;
    }, REPLY_MS);
  }

  function showHint() {
    if (!run || busy || result) return;
    touch();
    const square = run.hint();
    if (!square) return;
    shapes = [{ orig: square as Key, brush: 'yellow' }];
    message = 'Mueve esta pieza.';
  }

  function showSolution() {
    if (!run || busy || result) return;
    touch();
    shapes = [];
    busy = true;
    const next = () => {
      if (!run?.step()) return finish('shown');
      sound.move();
      sync();
      timer = setTimeout(next, SOLUTION_MS);
    };
    next();
  }

  function finish(r: Result) {
    result = r;
    message = MESSAGES[r];
    busy = false;
    shapes = [];
    if (r === 'solved') sound.end();
    if (puzzle) saveResult(puzzle.key, r);
  }

  function loadResult(key: string): Result | null {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
      return saved?.key === key && (saved.result === 'solved' || saved.result === 'shown') ? saved.result : null;
    } catch {
      return null;
    }
  }

  function saveResult(key: string, r: Result) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ key, result: r }));
    } catch {
      /* sin almacenamiento: se olvida al recargar */
    }
  }
</script>

{#if !failed}
  <section class="puzzle" aria-labelledby="puzzle-title">
    <h2 id="puzzle-title">Problema del día</h2>
    <div class="puzzle-body">
      <div class="puzzle-board">
        {#if Board && view}
          <Board
            bind:this={board}
            fen={view.fen}
            orientation={side}
            turnColor={view.turn}
            movableColor={result || busy ? null : side}
            dests={view.dests}
            lastMove={view.lastMove}
            check={view.check}
            {shapes}
            onmove={onMove}
          />
        {:else}
          <div class="board-slot" aria-hidden="true"></div>
        {/if}
      </div>
      <div class="puzzle-text">
        {#if puzzle}
          <p class="puzzle-goal">Juegan {side === 'white' ? 'blancas' : 'negras'} · Mate en {puzzle.goal}</p>
          <p class="puzzle-msg" role="status">{message}</p>
          {#if !result}
            <div class="puzzle-actions">
              <button class="btn" disabled={busy} onclick={showHint}>Pista</button>
              <button class="btn" disabled={busy} onclick={showSolution}>Ver solución</button>
            </div>
          {/if}
        {:else}
          <p class="puzzle-goal">Cargando…</p>
        {/if}
      </div>
    </div>
  </section>
{/if}

<style>
  .puzzle {
    max-width: 520px;
    margin: 0 auto;
    padding: 0 var(--gutter) 48px;
  }
  .puzzle h2 {
    margin: 0 0 12px;
    font-size: 1.1rem;
  }
  .puzzle-body {
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 16px;
    align-items: center;
  }
  .board-slot {
    aspect-ratio: 1;
    border-radius: 3px;
    background: var(--surface-2);
  }
  .puzzle-goal {
    margin: 0 0 6px;
    font-weight: 600;
  }
  .puzzle-msg {
    margin: 0 0 12px;
    min-height: 2.9em;
    color: var(--muted);
  }
  .puzzle-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  @media (max-width: 519px) {
    .puzzle-body {
      grid-template-columns: 1fr;
    }
    .puzzle-board {
      width: 100%;
      max-width: 360px;
      justify-self: center;
    }
  }
</style>
```

- [ ] **Step 3: Colocarlo en la portada y callar el reto**

En `apps/web/src/routes/+page.svelte`:
- `import DailyPuzzle from '$lib/DailyPuzzle.svelte';`
- Junto a `let challenge = $state(false);` declarar `let challengeTimer: ReturnType<typeof setTimeout> | undefined;`; en `onMount`, `const challengeTimer = setTimeout(...)` pasa a `challengeTimer = setTimeout(...)` (la limpieza con `clearTimeout(challengeTimer)` se queda).
- Añadir:

```ts
  /** Quien ya está resolviendo el problema del día no necesita que la máquina le rete. */
  function quietChallenge() {
    clearTimeout(challengeTimer);
    challenge = false;
  }
```

- Entre `</section>` del lobby y `<section class="about" …>`: `<DailyPuzzle onactivity={quietChallenge} />`.

- [ ] **Step 4: Comprobar**

Run: `pnpm check && pnpm build`
Expected: sin errores. Si `svelte-check` protesta por el tipo del JSON o de `Dests`, ajustar solo el cast.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/Board.svelte apps/web/src/lib/DailyPuzzle.svelte apps/web/src/routes/+page.svelte
git commit -m "Portada: problema del día"
```

---

### Task 4: Verificación completa y revisión en local

**Files:** ninguno (salvo arreglos que salgan).

- [ ] **Step 1:** `pnpm check && pnpm test && pnpm build` → todo en verde.
- [ ] **Step 2:** `pnpm dev` en segundo plano; abrir `http://localhost:5173` en Chrome.
- [ ] **Step 3: Escritorio** — la sección aparece bajo los botones de modo, tablero de 240 px con el texto a la derecha, orientado al bando que mueve. Probar: jugada mala (vuelve la pieza, mensaje), Pista (círculo en la casilla), jugada buena (contesta a los 350 ms), resolver. Recargar: posición final y «¡Resuelto!…».
- [ ] **Step 4: Ver solución** — borrar `jaque:problema` de `localStorage`, recargar, «Ver solución»: reproduce las jugadas y termina con «Esta era la solución…».
- [ ] **Step 5: Móvil** — ventana de 390 px: tablero a todo el ancho (máx. 360 px), texto debajo, sin scroll horizontal; mover arrastrando y tocando.
- [ ] **Step 6: Reto** — en una pestaña nueva (sessionStorage vacío), hacer una jugada antes de 8 s: la tarjeta «La máquina te reta» no aparece.
- [ ] **Step 7: Basura en almacenamiento** — `localStorage.setItem('jaque:problema', '{no json')`, recargar: el problema se puede jugar.
- [ ] **Step 8:** dejar `pnpm dev` arrancado y pedir al usuario que lo revise antes de fusionar en `develop`.
