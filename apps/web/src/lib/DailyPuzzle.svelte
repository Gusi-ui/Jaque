<script lang="ts">
  import { onMount } from 'svelte';
  import type { DrawShape } from 'chessground/draw';
  import type { Dests, Key } from 'chessground/types';
  import type { Color } from '@jaque/shared';
  import type { DailyPuzzle, PuzzleData, PuzzleRun } from '@jaque/engine/puzzle';
  import type BoardComponent from './Board.svelte';
  import PromotionPicker, { type PromotionRole } from './PromotionPicker.svelte';
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
  /** Coronación pendiente de elegir pieza. */
  let promo = $state<{ orig: Key; dest: Key } | null>(null);
  let touched = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let logic: typeof import('@jaque/engine/puzzle') | undefined;
  let data: PuzzleData | undefined;

  onMount(() => {
    let alive = true;
    Promise.all([import('./Board.svelte'), import('@jaque/engine/puzzle'), import('@jaque/engine/puzzles.json')])
      .then(([boardModule, puzzleModule, list]) => {
        if (!alive) return;
        logic = puzzleModule;
        data = list.default as unknown as PuzzleData;
        load();
        Board = boardModule.default;
      })
      .catch(() => (failed = true));

    // A medianoche (en Madrid) llega otro problema sin recargar. Mientras miras la
    // pestaña solo se cambia si no lo has tocado; al volver a ella, también si ya
    // lo habías terminado. A medias, nunca.
    const everyMinute = setInterval(() => newDay(false), 60_000);
    const onVisible = () => document.visibilityState === 'visible' && newDay(true);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(everyMinute);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  /** Prepara el problema de hoy, con el resultado guardado si lo hay. */
  function load() {
    if (!logic || !data) return;
    clearTimeout(timer);
    const today = logic.puzzleOfDay(new Date(), data);
    run = new logic.PuzzleRun(today);
    side = run.side;
    touched = false;
    busy = false;
    promo = null;
    shapes = [];
    result = null;
    message = 'Encuentra la jugada.';
    const saved = loadResult(today.key);
    if (saved) {
      while (run.step());
      result = saved;
      message = MESSAGES[saved];
    }
    puzzle = today;
    sync();
  }

  function newDay(returning: boolean) {
    if (!logic || !puzzle || logic.dayKey(new Date()) === puzzle.key) return;
    if (!touched || (returning && result)) load();
  }

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
    // Al coronar se elige la pieza, como en la partida: elegirla forma parte del problema.
    if (run.isPromotion(orig, dest)) {
      promo = { orig, dest };
      return;
    }
    play(`${orig}${dest}`);
  }

  function choosePromotion(role: PromotionRole) {
    if (!promo) return;
    const { orig, dest } = promo;
    promo = null;
    play(`${orig}${dest}${role}`);
  }

  function cancelPromotion() {
    promo = null;
    board?.cancelMove();
  }

  function play(uci: string) {
    if (!run) return;
    const outcome = run.play(uci);
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
            movableColor={result || busy || promo ? null : side}
            dests={view.dests}
            lastMove={view.lastMove}
            check={view.check}
            {shapes}
            onmove={onMove}
          />
          {#if promo}
            <PromotionPicker color={side} onchoose={choosePromotion} oncancel={cancelPromotion} />
          {/if}
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
  .puzzle-board {
    position: relative;
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
