<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { DrawShape } from 'chessground/draw';
  import type { Dests, Key } from 'chessground/types';
  import type { Color } from '@jaque/shared';
  import type { DailyPuzzle, PuzzleData, PuzzleRun } from '@jaque/engine/puzzle';
  import type BoardComponent from './Board.svelte';
  import { spanishSan } from '@jaque/engine/notation';
  import PromotionPicker, { type PromotionRole } from './PromotionPicker.svelte';
  import Celebration from './Celebration.svelte';
  import { sound } from './sound';

  interface Props {
    /** Primera vez que el visitante toca el problema. */
    onactivity?: () => void;
  }
  let { onactivity }: Props = $props();

  const STORE_KEY = 'jaque:problema';
  const STREAK_KEY = 'jaque:racha';
  const REPLY_MS = 350;
  const SOLUTION_MS = 600;

  type Result = 'solved' | 'shown';

  interface View {
    fen: string;
    turn: Color;
    lastMove?: [Key, Key];
    check: boolean;
    dests: Dests;
    sans: string[];
  }

  // Tablero, lógica y lista se cargan al montar: la portada prerenderizada no pesa más.
  let Board = $state.raw<typeof BoardComponent>();
  let board = $state<ReturnType<typeof BoardComponent>>();
  let run: PuzzleRun | undefined;
  /** Los problemas de hoy y cómo ha terminado cada uno (null: sin terminar). */
  let puzzles = $state.raw<DailyPuzzle[]>([]);
  let results = $state.raw<(Result | null)[]>([]);
  /** El que está en el tablero. */
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
  /** Recién resuelto: se celebra sobre el tablero. */
  let celebrate = $state(false);
  /** Días seguidos resueltos hasta hoy, o 0 si hoy aún no cuenta. */
  let streak = $state(0);
  const streakLabel = $derived(streak === 1 ? '1 día de racha' : `${streak} días seguidos`);
  /** Cuántos quedan por hacer hoy y si se han resuelto todos sin mirar la solución. */
  const left = $derived(results.filter((r) => !r).length);
  const allSolved = $derived(results.length > 0 && results.every((r) => r === 'solved'));
  /** Jugadas por filas, como en la partida; si empiezan las negras, la primera fila va con «…». */
  const rows = $derived.by(() => {
    const played = (view?.sans ?? []).map(spanishSan);
    const sans = side === 'black' ? ['…', ...played] : played;
    const list: { n: number; white: string; black?: string }[] = [];
    for (let i = 0; i < sans.length; i += 2) list.push({ n: i / 2 + 1, white: sans[i], black: sans[i + 1] });
    return list;
  });
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

  /** Prepara los problemas de hoy y abre el primero sin terminar (o el último, si ya están todos). */
  function load() {
    if (!logic || !data) return;
    const today = logic.puzzlesOfDay(new Date(), data);
    touched = false;
    puzzles = today;
    results = loadResults(today[0].key, today.length);
    const stored = loadStreak();
    streak = stored?.last === today[0].key ? stored.count : 0;
    const next = results.indexOf(null);
    open(next < 0 ? today.length - 1 : next);
  }

  /** Pone en el tablero el problema n.º `n` de hoy, terminado si ya lo estaba. */
  function open(n: number) {
    if (!logic) return;
    clearTimeout(timer);
    const p = puzzles[n];
    run = new logic.PuzzleRun(p);
    side = run.side;
    busy = false;
    promo = null;
    shapes = [];
    celebrate = false;
    result = results[n];
    message = result ? messageFor(result) : 'Encuentra la jugada.';
    if (result) while (run.step());
    puzzle = p;
    sync();
  }

  function openNext() {
    const next = results.indexOf(null);
    if (next >= 0) open(next);
  }

  function messageFor(r: Result) {
    const more = left === 1 ? 'Queda uno más.' : `Quedan ${left} más.`;
    if (r === 'shown') return left ? 'Esta era la solución. Prueba el siguiente.' : 'Esta era la solución. Mañana, más.';
    if (left) return `¡Resuelto! ${more}`;
    return allSolved ? '¡Los tres resueltos! Vuelve mañana.' : '¡Resuelto! Mañana, más.';
  }

  // Un solo tablero a la vez: al abrir la ventana, el pequeño deja su sitio al grande.
  async function openBig() {
    touch();
    // Desde la tarjeta, con el problema ya terminado, se sigue con el siguiente.
    if (result && left) openNext();
    promo = null;
    big = true;
    await tick();
    dialog?.showModal();
    // El foco al título: si cayera en la X, se vería marcada nada más abrir.
    dialog?.querySelector<HTMLElement>('h2')?.focus();
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
      dests: run.dests() as Dests,
      sans: run.sans
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
    if (!puzzle) return;
    result = r;
    results = results.map((x, i) => (i === puzzle?.n ? r : x));
    message = messageFor(r);
    busy = false;
    shapes = [];
    saveResults(puzzle.key, results);
    if (r === 'solved') {
      sound.end();
      if (puzzle) streak = bumpStreak(puzzle.key);
      celebrate = true;
    }
  }

  function loadResults(key: string, count: number): (Result | null)[] {
    const valid = (r: unknown): Result | null => (r === 'solved' || r === 'shown' ? r : null);
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
      if (saved?.key !== key) return Array(count).fill(null);
      // Antes había un problema al día: { key, result }.
      const list: unknown[] = Array.isArray(saved.results) ? saved.results : [saved.result];
      return Array.from({ length: count }, (_, i) => valid(list[i]));
    } catch {
      return Array(count).fill(null);
    }
  }

  function loadStreak(): { last: string; count: number } | null {
    try {
      const saved = JSON.parse(localStorage.getItem(STREAK_KEY) ?? 'null');
      return typeof saved?.last === 'string' && Number.isInteger(saved.count) ? saved : null;
    } catch {
      return null;
    }
  }

  /** Suma el día de hoy a la racha: sigue si ayer también se resolvió y si no empieza de nuevo. */
  function bumpStreak(key: string): number {
    if (!logic) return 1;
    const saved = loadStreak();
    // Mediodía en UTC cae en el mismo día en Madrid: restarle 24 h da el día anterior.
    const yesterday = logic.dayKey(new Date(Date.parse(`${key}T12:00:00Z`) - 86_400_000));
    const count = saved?.last === key ? saved.count : saved?.last === yesterday ? saved.count + 1 : 1;
    try {
      localStorage.setItem(STREAK_KEY, JSON.stringify({ last: key, count }));
    } catch {
      /* sin almacenamiento: la racha no se recuerda */
    }
    return count;
  }

  function saveResults(key: string, list: (Result | null)[]) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ key, results: list }));
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
    {#if celebrate && puzzle}
      <Celebration
        tone="win"
        title={allSolved ? '¡Día completo!' : '¡Resuelto!'}
        detail={allSolved ? 'Los tres problemas de hoy, resueltos' : `Mate en ${puzzle.goal} encontrado`}
        extra="🔥 {streakLabel}"
        ondismiss={() => (celebrate = false)}
      />
    {/if}
  {:else}
    <div class="board-slot" aria-hidden="true"></div>
  {/if}
{/snippet}

<!-- Un punto por problema de hoy: dorado resuelto, gris con la solución vista. -->
{#snippet progress()}
  {#if puzzle && puzzles.length > 1}
    <span class="progress">
      <span class="dots" aria-hidden="true">
        {#each results as r, i (i)}
          <i class:solved={r === 'solved'} class:shown={r === 'shown'} class:current={i === puzzle.n}></i>
        {/each}
      </span>
      <span class="sr-only">Problema</span>
      {puzzle.n + 1} de {puzzles.length}
    </span>
  {/if}
{/snippet}

{#snippet details(large: boolean)}
  {#if puzzle}
    <p class="puzzle-goal">
      Juegan {side === 'white' ? 'blancas' : 'negras'}<span class="goal-sep">{' · '}</span><span class="goal-n"
        >Mate en {puzzle.goal}</span
      >
    </p>
    <p class="puzzle-msg" class:solved={result === 'solved'} role={large === big ? 'status' : undefined}>
      {message}
    </p>
    {#if result === 'solved' && streak}
      <p class="puzzle-streak">🔥 Racha: {streak} {streak === 1 ? 'día' : 'días'}</p>
    {/if}
    {#if large}
      <ol class="moves" aria-label="Jugadas">
        {#each rows as row (row.n)}
          <li>
            <span class="n">{row.n}.</span>
            <span class:last={row.n === rows.length && !row.black}>{row.white}</span>
            {#if row.black}<span class:last={row.n === rows.length}>{row.black}</span>{/if}
          </li>
        {:else}
          <li class="empty">Aquí se anotan las jugadas.</li>
        {/each}
      </ol>
    {/if}
    <div class="puzzle-actions">
      {#if !result}
        <button class="btn" disabled={busy} onclick={showHint}>Pista</button>
        <button class="btn" disabled={busy} onclick={showSolution}>Ver solución</button>
      {:else if left}
        <button class="btn primary" onclick={openNext}>Siguiente problema →</button>
      {/if}
    </div>
    {#if !large && Board && view && (!result || left)}
      <span class="puzzle-cta" aria-hidden="true">{result ? 'Siguiente →' : 'Resolver →'}</span>
    {/if}
  {:else}
    <p class="puzzle-goal">Cargando…</p>
  {/if}
{/snippet}

{#if !failed}
  <section class="puzzle" aria-labelledby="puzzle-title">
    <div class="puzzle-head">
      <h2 id="puzzle-title">Problema del día</h2>
      {@render progress()}
    </div>
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
      celebrate = false;
      big = false;
    }}
    onclick={(e) => e.target === dialog && dialog.close()}
  >
    {#if big}
      <button class="close" onclick={() => dialog?.close()} aria-label="Cerrar">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
        </svg>
      </button>
      <div class="dialog-body">
        <div class="puzzle-board">{@render boardView()}</div>
        <div class="puzzle-text">
          <h2 id="puzzle-dialog-title" tabindex="-1">Problema del día</h2>
          <p class="dialog-progress">{@render progress()}</p>
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
  .puzzle-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 12px;
  }
  .puzzle h2 {
    margin: 0;
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
  /* Resuelto: el mensaje deja de ser una nota gris y se ve como un logro. */
  .puzzle-msg.solved {
    min-height: 0;
    color: var(--brass);
    font-weight: 700;
  }
  .puzzle-msg.solved::before {
    content: '✓ ';
  }
  .puzzle-streak {
    display: inline-block;
    margin: 0 0 12px;
    padding: 3px 10px;
    border-radius: 99px;
    background: var(--brass-soft);
    font-size: 0.82rem;
    font-weight: 700;
    white-space: nowrap;
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
  .close {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    transition: background-color 0.12s, border-color 0.12s;
  }
  .close:hover {
    border-color: var(--muted);
    background: var(--line);
  }
  .close:focus-visible {
    outline: 2px solid var(--brass);
  }
  .progress {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 600;
  }
  .dots {
    display: inline-flex;
    gap: 4px;
  }
  .dots i {
    width: 8px;
    height: 8px;
    border: 1.5px solid var(--line);
    border-radius: 50%;
  }
  .dots i.current {
    border-color: var(--muted);
  }
  .dots i.solved {
    border-color: var(--brass);
    background: var(--brass);
  }
  .dots i.shown {
    border-color: var(--muted);
    background: var(--muted);
  }
  .dialog-progress {
    margin: -8px 0 12px;
  }
  /* La columna mide lo que el tablero: la lista de jugadas llena el hueco y los botones van abajo. */
  .dialog-body .puzzle-text {
    display: flex;
    flex-direction: column;
    height: var(--board);
  }
  .dialog-body .puzzle-actions {
    margin-top: auto;
    padding-top: 12px;
  }
  .moves {
    flex: 1 1 0;
    min-height: 80px;
    margin: 4px 0 0;
    padding: 8px 0;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--bg);
    list-style: none;
    font-variant-numeric: tabular-nums;
  }
  .moves li {
    display: grid;
    grid-template-columns: 2.4em 1fr 1fr;
    padding: 3px 12px;
    font-weight: 600;
  }
  .moves li:nth-child(even) {
    background: var(--surface-2);
  }
  .moves .n {
    color: var(--muted);
    font-weight: 500;
  }
  .moves .last {
    color: var(--brass);
  }
  .moves .empty {
    display: block;
    color: var(--muted);
    font-weight: 400;
    font-size: 0.9rem;
  }
  .dialog-body h2:focus {
    outline: none;
  }
  .dialog-body h2 {
    margin: 0 0 14px;
    padding-right: 32px;
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
