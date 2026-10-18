<script lang="ts">
  import { onMount, tick } from 'svelte';
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
  /** En escritorio el problema se puede resolver en una ventana con el tablero grande. */
  let big = $state(false);
  let dialog = $state<HTMLDialogElement>();
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

  // Un solo tablero a la vez: al abrir la ventana, el pequeño deja su sitio al grande.
  async function openBig() {
    touch();
    promo = null;
    big = true;
    await tick();
    dialog?.showModal();
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

{#snippet boardView()}
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
{/snippet}

{#snippet details(large: boolean)}
  {#if puzzle}
    <p class="puzzle-goal">
      Juegan {side === 'white' ? 'blancas' : 'negras'}<span class="goal-sep"> · </span><span class="goal-n"
        >Mate en {puzzle.goal}</span
      >
    </p>
    <p class="puzzle-msg" role={large === big ? 'status' : undefined}>{message}</p>
    <div class="puzzle-actions">
      {#if !result}
        <button class="btn" disabled={busy} onclick={showHint}>Pista</button>
        <button class="btn" disabled={busy} onclick={showSolution}>Ver solución</button>
      {/if}
      {#if large}
        <button class="btn" onclick={() => dialog?.close()}>Cerrar</button>
      {/if}
    </div>
    {#if !large && Board && view && !result}
      <span class="puzzle-cta" aria-hidden="true">Resolver →</span>
    {/if}
  {:else}
    <p class="puzzle-goal">Cargando…</p>
  {/if}
{/snippet}

{#if !failed}
  <section class="puzzle" aria-labelledby="puzzle-title">
    <h2 id="puzzle-title">Problema del día</h2>
    <div class="puzzle-body">
      <div class="puzzle-board">
        {#if big}
          <div class="board-slot" aria-hidden="true"></div>
        {:else}
          {@render boardView()}
        {/if}
      </div>
      <div class="puzzle-text">
        {@render details(false)}
      </div>
    </div>
    <!-- En escritorio la tarjeta entera es una vista previa: se resuelve en grande. -->
    {#if Board && view}
      <button class="puzzle-open" onclick={openBig}>
        <span class="sr-only">{result ? 'Ver el problema del día en grande' : 'Resolver el problema del día en grande'}</span>
      </button>
    {/if}
  </section>

  <dialog
    bind:this={dialog}
    class="puzzle-dialog"
    aria-labelledby="puzzle-dialog-title"
    onclose={() => {
      if (promo) cancelPromotion();
      big = false;
    }}
    onclick={(e) => e.target === dialog && dialog.close()}
  >
    {#if big}
      <div class="dialog-body">
        <div class="puzzle-board">{@render boardView()}</div>
        <div class="puzzle-text">
          <h2 id="puzzle-dialog-title">Problema del día</h2>
          {@render details(true)}
        </div>
      </div>
    {/if}
  </dialog>
{/if}

<style>
  /* Una tarjeta: el problema acompaña a la rejilla de ritmos, no compite con ella. */
  .puzzle {
    position: relative;
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
  /* La ventana grande es solo para escritorio: en el móvil el tablero ya ocupa el ancho. */
  .puzzle-open,
  .puzzle-cta {
    display: none;
  }
  .puzzle-open {
    position: absolute;
    inset: 0;
    z-index: 3;
    padding: 0;
    border: 0;
    border-radius: inherit;
    background: none;
    cursor: pointer;
  }
  .puzzle-open:focus-visible {
    outline: 2px solid var(--brass);
    outline-offset: 2px;
  }
  .puzzle:has(.puzzle-open:hover) {
    border-color: var(--muted);
  }
  .puzzle-cta {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--brass);
  }
  .puzzle:has(.puzzle-open:hover) .puzzle-cta {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  /* Tablero lo más grande que quepa, con el texto al lado. */
  .puzzle-dialog {
    --board: min(640px, calc(100dvh - 72px), calc(100vw - 340px));
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    padding: 24px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 30px 80px -30px rgb(0 0 0 / 0.6);
  }
  .puzzle-dialog::backdrop {
    background: rgb(27 33 48 / 0.5);
  }
  .dialog-body {
    display: grid;
    grid-template-columns: var(--board) 240px;
    gap: 24px;
    align-items: start;
  }
  .dialog-body h2 {
    margin: 0 0 14px;
    font-size: 1.35rem;
    letter-spacing: -0.02em;
  }
  .dialog-body .puzzle-goal {
    font-size: 1.05rem;
  }

  /* Columna derecha de la portada en escritorio (mismo corte que `.home`): la tarjeta
     llena lo que queda junto a la rejilla de ritmos, con el tablero en vista previa. */
  @media (min-width: 960px) {
    /* Su alto lo marca la rejilla (no el contenido): el tablero crece hasta llenarlo. */
    .puzzle {
      display: flex;
      flex-direction: column;
      container-type: size;
    }
    .puzzle-open,
    .puzzle-cta {
      display: block;
    }
    /* La tarjeta solo invita a abrir la ventana: los botones viven allí. */
    .puzzle .puzzle-actions {
      display: none;
    }
    .puzzle-body {
      flex: 1;
      grid-template-columns: min(calc(100cqh - 30px), calc(100cqw - 128px)) 1fr;
      gap: 14px;
      align-items: center;
    }
    .puzzle .puzzle-goal {
      font-size: 0.92rem;
    }
    .puzzle .goal-sep {
      display: none;
    }
    .puzzle .goal-n {
      display: block;
    }
    .puzzle .puzzle-msg {
      margin-bottom: 10px;
      font-size: 0.88rem;
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
