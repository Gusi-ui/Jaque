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
  /* Una tarjeta: el problema acompaña a la rejilla de ritmos, no compite con ella. */
  .puzzle {
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-m);
    background: var(--surface);
  }
  .puzzle h2 {
    margin: 0 0 12px;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
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
  /* Columna derecha de la portada en escritorio (mismo corte que `.home`): tablero pequeño. */
  @media (min-width: 960px) {
    .puzzle-body {
      grid-template-columns: 160px 1fr;
      gap: 12px;
      align-items: start;
    }
    .puzzle-goal {
      font-size: 0.92rem;
    }
    .puzzle-msg {
      margin-bottom: 10px;
      font-size: 0.88rem;
    }
    .puzzle-actions .btn {
      min-height: 36px;
      padding: 0 12px;
      font-size: 0.85rem;
    }
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
