<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { Chess, type Square } from 'chess.js';
  import type { Dests, Key, MoveMetadata } from 'chessground/types';
  import {
    isOver,
    opposite,
    speedOf,
    SPEED_LABEL,
    tcLabel,
    type ClientGameMsg,
    type Color,
    type GameView,
    type ServerGameMsg
  } from '@jaque/shared';
  import Board from './Board.svelte';
  import PromotionPicker, { type PromotionRole } from './PromotionPicker.svelte';
  import Icon from './Icon.svelte';
  import { connect, type SocketStatus } from './socket';
  import { playerId } from './player';
  import { sound } from './sound';
  import { colorName, formatClock, resultText, scoreText } from './format';
  import { BOT_LEVELS } from '@jaque/engine/levels';
  import { botFor, saveBot } from './bot-config';
  import { SITE, pageTitle } from './site';

  let { id }: { id: string } = $props();

  const player = playerId();
  /** Si la partida es contra la máquina (en esta pestaña), su configuración. */
  const bot = $derived(botFor(id));

  let game = $state<GameView | null>(null);
  let you = $state<Color | null>(null);
  let receivedAt = $state(0);
  let now = $state(Date.now());
  let conn = $state<SocketStatus>('connecting');
  let notFound = $state(false);
  let viewPly = $state<number | null>(null);
  let flipped = $state(false);
  let promo = $state<{ orig: Key; dest: Key } | null>(null);
  let confirmResign = $state(false);
  /** No se pudo descargar el motor de la máquina (p. ej., pestaña abierta antes de un despliegue). */
  let botFailed = $state(false);
  let copied = $state(false);
  let toast = $state('');
  let board = $state<ReturnType<typeof Board>>();
  let movesEl = $state<HTMLElement>();

  let socket: ReturnType<typeof connect<ServerGameMsg, ClientGameMsg>> | undefined;

  // ─── Posiciones de la partida, para navegar por las jugadas ──────────

  interface Position {
    fen: string;
    lastMove?: [Key, Key];
    check: boolean;
  }

  const replay = $derived.by(() => {
    if (!game) return null;
    const chess = new Chess(game.initialFen);
    const positions: Position[] = [{ fen: chess.fen(), check: false }];
    for (const uci of game.moves) {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      positions.push({
        fen: chess.fen(),
        lastMove: [uci.slice(0, 2) as Key, uci.slice(2, 4) as Key],
        check: chess.inCheck()
      });
    }
    const dests: Dests = new Map();
    for (const m of chess.moves({ verbose: true })) {
      const list = dests.get(m.from as Key) ?? [];
      list.push(m.to as Key);
      dests.set(m.from as Key, list);
    }
    return { chess, positions, dests };
  });

  const lastPly = $derived(game?.moves.length ?? 0);
  const shownPly = $derived(viewPly ?? lastPly);
  const live = $derived(shownPly === lastPly);
  const shown = $derived(replay?.positions[shownPly]);
  /** Quien aún no está sentado ve el tablero desde el lado que le tocaría. */
  const seatColor = $derived<Color>(
    you ?? (game?.status === 'waiting' && game.seats.white.taken ? 'black' : 'white')
  );
  const orientation = $derived<Color>(flipped ? opposite(seatColor) : seatColor);
  const botColor = $derived<Color | null>(bot && you ? opposite(you) : null);
  const playing = $derived(!!game && !!you && game.status === 'started');
  const over = $derived(!!game && isOver(game.status));
  const shownTurn = $derived<Color>(shownPly % 2 === 0 ? 'white' : 'black');

  /** Segundos que le quedan al jugador con el turno para su primera jugada, o null. */
  const firstMoveSec = $derived(
    game?.status === 'started' && game.firstMoveDeadline !== null
      ? Math.max(0, Math.ceil((game.firstMoveDeadline - (now - receivedAt)) / 1000))
      : null
  );
  /** Mismo criterio que el motor (el bloqueo tras un rechazo lo decide el servidor). */
  const canTakeback = $derived(
    !!game &&
      !!you &&
      game.status === 'started' &&
      lastPly >= (you === 'white' ? 1 : 2) &&
      // Con la petición del rival pendiente, se responde en su aviso: pedir aquí la aceptaría.
      game.takeback !== opposite(you)
  );
  const canAbort = $derived(
    !!game &&
      !!you &&
      (game.status === 'waiting' ||
        (game.status === 'started' && (you === 'white' ? lastPly === 0 : lastPly <= 1)))
  );

  function clockOf(c: Color) {
    if (!game) return 0;
    const base = game.clock[c];
    return game.clock.running === c ? base - (now - receivedAt) : base;
  }

  // ─── Conexión ────────────────────────────────────────────────────────

  function onMessage(msg: ServerGameMsg) {
    switch (msg.t) {
      case 'hello':
        you = msg.you;
        break;
      case 'state':
        applyState(msg.game);
        break;
      case 'redirect':
        // La máquina también juega la revancha.
        if (bot) saveBot(msg.id, bot);
        goto(`/${msg.id}`);
        break;
      case 'error':
        showToast(msg.msg);
        break;
    }
  }

  async function applyState(next: GameView) {
    const prev = game;
    game = next;
    receivedAt = Date.now();
    now = receivedAt;
    if (!prev) return;

    if (prev.status === 'waiting' && next.status === 'started') sound.start();
    if (next.moves.length === prev.moves.length + 1) {
      const san = next.sans.at(-1) ?? '';
      if (san.includes('+') || san.includes('#')) sound.check();
      else if (san.includes('x')) sound.capture();
      else sound.move();
      // Seguir en directo si el usuario miraba la última posición.
      if (viewPly === prev.moves.length) viewPly = null;
      const moverWasRival = next.moves.length % 2 === (you === 'white' ? 0 : 1);
      if (you && moverWasRival && next.status === 'started') {
        await tick();
        board?.playPremove();
      }
    }
    // Se ha deshecho: volver al directo y olvidar la premove.
    if (next.moves.length < prev.moves.length) {
      sound.move();
      viewPly = null;
      promo = null;
      board?.cancelPremove();
    }
    if (!isOver(prev.status) && isOver(next.status)) {
      sound.end();
      confirmResign = false;
      promo = null;
    }
  }

  function send(msg: ClientGameMsg) {
    if (!socket?.send(msg)) showToast('Sin conexión. Reintentando…');
  }

  let toastTimer: ReturnType<typeof setTimeout>;
  function showToast(text: string) {
    toast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 2600);
  }

  onMount(() => {
    let cancelled = false;
    let botHandle: { stop(): void } | undefined;
    fetch(`/api/games/${id}`).then((r) => {
      if (cancelled) return;
      if (r.status === 404) {
        notFound = true;
        return;
      }
      socket = connect<ServerGameMsg, ClientGameMsg>(`/ws/game/${id}?player=${player}`, {
        onMessage,
        onStatus: (s) => (conn = s)
      });
      // El motor de la máquina solo se descarga en las partidas contra ella.
      if (bot) {
        const cfg = bot;
        import('./bot')
          .then(({ startBot }) => {
            if (!cancelled) botHandle = startBot(id, cfg);
          })
          // Sin esto la partida se quedaba esperando a la máquina para siempre.
          .catch(() => (botFailed = true));
      }
    });

    const interval = setInterval(() => {
      if (game?.clock.running || game?.firstMoveDeadline) now = Date.now();
    }, 100);

    return () => {
      cancelled = true;
      clearInterval(interval);
      socket?.close();
      botHandle?.stop();
    };
  });

  // ─── Jugadas ─────────────────────────────────────────────────────────

  function onMove(orig: Key, dest: Key, meta: MoveMetadata) {
    if (!game || !replay || !you) return;
    const piece = replay.chess.get(orig as Square);
    const lastRank = dest[1] === '8' || dest[1] === '1';
    if (piece?.type === 'p' && lastRank) {
      // Las premoves coronan en dama automáticamente, como en lichess.
      if (meta.premove) return sendMove(`${orig}${dest}q`);
      promo = { orig, dest };
      return;
    }
    sendMove(`${orig}${dest}`);
  }

  function sendMove(uci: string) {
    if (!game) return;
    const ok = socket?.send({ t: 'move', uci, ply: game.moves.length });
    if (!ok) {
      board?.cancelMove();
      showToast('Sin conexión. La jugada no se ha enviado');
    }
  }

  function choosePromotion(role: PromotionRole) {
    if (!promo) return;
    sendMove(`${promo.orig}${promo.dest}${role}`);
    promo = null;
  }

  function cancelPromotion() {
    promo = null;
    board?.cancelMove();
  }

  // ─── Navegación ──────────────────────────────────────────────────────

  function goTo(ply: number) {
    const p = Math.max(0, Math.min(lastPly, ply));
    viewPly = p === lastPly ? null : p;
  }

  function onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => goTo(shownPly - 1),
      ArrowRight: () => goTo(shownPly + 1),
      ArrowUp: () => goTo(0),
      ArrowDown: () => goTo(lastPly),
      Home: () => goTo(0),
      End: () => goTo(lastPly),
      f: () => (flipped = !flipped)
    };
    const act = actions[e.key];
    if (act) {
      e.preventDefault();
      act();
    }
  }

  $effect(() => {
    // Mantener visible la jugada activa en la lista.
    void shownPly;
    tick().then(() => {
      const list = movesEl;
      const el = list?.querySelector<HTMLElement>('.active');
      if (!list || !el) return;
      // Solo se desplaza la lista: scrollIntoView movería también la página en el móvil,
      // donde la lista queda por debajo de la pantalla.
      const box = list.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.left < box.left) list.scrollLeft -= box.left - r.left;
      else if (r.right > box.right) list.scrollLeft += r.right - box.right;
      if (r.top < box.top) list.scrollTop -= box.top - r.top;
      else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
    });
  });

  const movePairs = $derived.by(() => {
    const sans = game?.sans ?? [];
    const rows: { n: number; white?: string; black?: string }[] = [];
    for (let i = 0; i < sans.length; i += 2) rows.push({ n: i / 2 + 1, white: sans[i], black: sans[i + 1] });
    return rows;
  });

  // ─── Enlace para invitar ─────────────────────────────────────────────

  const shareUrl = $derived(typeof location !== 'undefined' ? `${location.origin}/${id}` : '');

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      copied = true;
      setTimeout(() => (copied = false), 1800);
    } catch {
      showToast('No se pudo copiar; selecciona el enlace a mano');
    }
  }

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Partida de ajedrez', url: shareUrl });
        return;
      } catch {
        /* cancelado */
      }
    }
    copyLink();
  }

  const top = $derived<Color>(opposite(orientation));
  const bottom = $derived<Color>(orientation);
</script>

<svelte:window onkeydown={onKey} />
<svelte:head>
  <title>
    {game
      ? pageTitle(`${tcLabel(game.tc)} ${SPEED_LABEL[speedOf(game.tc)]}${game.status === 'started' ? (game.turn === you ? ' · Tu turno' : '') : ''}`)
      : pageTitle('Partida')}
  </title>
  <!-- Las partidas son efímeras: no deben aparecer en los buscadores. -->
  <meta name="robots" content="noindex" />
</svelte:head>

{#snippet playerBar(c: Color, pos: 'top' | 'bottom')}
  {@const ms = clockOf(c)}
  {@const running = game?.clock.running === c}
  <div class="player {pos}" class:running class:low={running && ms < 20_000}>
    <div class="who">
      <span class="piece-dot {c}" aria-hidden="true"></span>
      <span class="name">
        <span class="first-line">
          {colorName(c)}{#if you === c}<span class="you">tú</span>{/if}
          <!-- Junto al nombre, para que la etiqueta de la máquina tenga todo el ancho. -->
          {#if game?.seats[c].taken}
            <span class="presence" class:on={game.seats[c].online} title={game.seats[c].online ? 'Conectado' : 'Desconectado'}>
              <span class="sr-only">{game.seats[c].online ? 'Conectado' : 'Desconectado'}</span>
            </span>
          {:else}
            <span class="waiting-seat">libre</span>
          {/if}
        </span>
        <!-- En su propia línea, para que el reloj no la tape. -->
        {#if botColor === c && bot}<span class="you bot">máquina · {BOT_LEVELS[bot.level].toLowerCase()}</span>{/if}
      </span>
    </div>
    <div class="clock" aria-label="Reloj de {colorName(c).toLowerCase()}">{formatClock(ms)}</div>
  </div>
{/snippet}

{#if notFound}
  <section class="empty">
    <h1>Esta partida no existe</h1>
    <p>Puede que el enlace esté mal copiado o que la partida haya caducado.</p>
    <a class="btn primary" href="/">Buscar otra partida</a>
  </section>
{:else if !game || !replay || !shown}
  <section class="empty"><p class="loading">Cargando partida…</p></section>
{:else}
  <div class="game">
    <div class="area-top">{@render playerBar(top, 'top')}</div>

    <div class="area-board">
      <Board
        bind:this={board}
        fen={shown.fen}
        {orientation}
        turnColor={shownTurn}
        movableColor={playing && live ? you : null}
        dests={replay.dests}
        lastMove={shown.lastMove}
        check={shown.check}
        onmove={onMove}
      />
      {#if promo}
        <PromotionPicker color={you ?? 'white'} onchoose={choosePromotion} oncancel={cancelPromotion} />
      {/if}
      {#if conn !== 'open'}
        <div class="reconnecting" role="status">Reconectando…</div>
      {/if}
    </div>

    <div class="area-bottom">{@render playerBar(bottom, 'bottom')}</div>

    <div class="area-moves">
      <div class="nav">
        <button onclick={() => goTo(0)} disabled={shownPly === 0} aria-label="Inicio"><Icon name="first" /></button>
        <button onclick={() => goTo(shownPly - 1)} disabled={shownPly === 0} aria-label="Anterior"><Icon name="prev" /></button>
        <button onclick={() => goTo(shownPly + 1)} disabled={live} aria-label="Siguiente"><Icon name="next" /></button>
        <button onclick={() => goTo(lastPly)} disabled={live} aria-label="Última jugada"><Icon name="last" /></button>
        <button onclick={() => (flipped = !flipped)} aria-label="Girar tablero" title="Girar tablero (F)"><Icon name="flip" /></button>
      </div>
      <ol class="moves" bind:this={movesEl}>
        {#each movePairs as row (row.n)}
          <li>
            <span class="n">{row.n}</span>
            <button class="san" class:active={shownPly === row.n * 2 - 1} onclick={() => goTo(row.n * 2 - 1)}>{row.white}</button>
            {#if row.black}
              <button class="san" class:active={shownPly === row.n * 2} onclick={() => goTo(row.n * 2)}>{row.black}</button>
            {/if}
          </li>
        {:else}
          <li class="no-moves">{tcLabel(game.tc)} · {SPEED_LABEL[speedOf(game.tc)]}</li>
        {/each}
        {#if over && game.status !== 'aborted'}
          <li class="score">{scoreText(game.winner, game.status)}</li>
        {/if}
      </ol>
    </div>

    <div class="area-controls">
      {#if game.status === 'waiting'}
        {#if bot && you}
          <div class="invite">
            {#if botFailed}
              <p class="headline">No se ha podido cargar la máquina</p>
              <p class="hint">Puede que haya una versión nueva de {SITE.name}. Recarga la página para jugar.</p>
              <button class="btn primary" onclick={() => location.reload()}>Recargar</button>
            {:else}
              <p class="headline">La máquina se está sentando…</p>
              <button class="btn" onclick={() => send({ t: 'abort' })}>Cancelar partida</button>
            {/if}
          </div>
        {:else if you}
          <div class="invite">
            <p class="headline">Invita a alguien a jugar</p>
            <p class="hint">La primera persona que abra este enlace jugará contra ti.</p>
            <div class="link-row">
              <input readonly value={shareUrl} aria-label="Enlace de la partida" onfocus={(e) => e.currentTarget.select()} />
              <button class="btn" onclick={copyLink}>{copied ? 'Copiado' : 'Copiar'}</button>
            </div>
            <div class="row">
              <button class="btn primary" onclick={share}><Icon name="share" /> Compartir</button>
              <button class="btn" onclick={() => send({ t: 'abort' })}>Cancelar partida</button>
            </div>
          </div>
        {:else}
          <div class="invite">
            <p class="headline">Te han desafiado a una partida {tcLabel(game.tc)}</p>
            <p class="hint">
              Jugarás con {colorName(game.seats.white.taken ? 'black' : 'white').toLowerCase()} ·
              {SPEED_LABEL[speedOf(game.tc)]}
            </p>
            <button class="btn primary wide" onclick={() => send({ t: 'join' })}>Aceptar desafío</button>
          </div>
        {/if}
      {:else if game.status === 'started' && you}
        <!-- Aquí y no en la barra del jugador: al aparecer y desaparecer, movía el tablero. -->
        {#if firstMoveSec !== null}
          <p class="deadline" role="status">
            {game.turn === you
              ? `Tienes ${firstMoveSec} s para tu primera jugada`
              : `Tu rival tiene ${firstMoveSec} s para su primera jugada`}
          </p>
        {/if}
        {#if game.drawOffer && game.drawOffer !== you}
          <div class="offer">
            <span>Tu rival ofrece tablas</span>
            <button class="btn primary" onclick={() => send({ t: 'draw', offer: true })}>Aceptar</button>
            <button class="btn" onclick={() => send({ t: 'draw', offer: false })}>Rechazar</button>
          </div>
        {/if}
        {#if game.takeback && game.takeback !== you}
          <div class="offer">
            <span>Tu rival pide deshacer su última jugada</span>
            <button class="btn primary" onclick={() => send({ t: 'takeback', offer: true, ply: lastPly })}>Aceptar</button>
            <button class="btn" onclick={() => send({ t: 'takeback', offer: false, ply: lastPly })}>Rechazar</button>
          </div>
        {/if}
        <div class="row">
          {#if canAbort}
            <button class="btn" onclick={() => send({ t: 'abort' })}>Anular partida</button>
          {:else}
            {#if canTakeback}
              <button
                class="btn"
                aria-pressed={game.takeback === you}
                onclick={() => send({ t: 'takeback', offer: game?.takeback !== you, ply: lastPly })}
              >
                {game.takeback === you ? 'Deshacer pedido' : 'Deshacer'}
              </button>
            {/if}
            <button
              class="btn"
              disabled={game.drawOffer === you}
              aria-label={game.drawOffer === you ? 'Tablas ofrecidas' : 'Ofrecer tablas'}
              onclick={() => send({ t: 'draw', offer: true })}
            >
              <!-- En móviles estrechos, la etiqueta corta, para que los tres botones quepan en una fila. -->
              <span class="label-long">{game.drawOffer === you ? 'Tablas ofrecidas' : 'Ofrecer tablas'}</span>
              <span class="label-short">{game.drawOffer === you ? 'Ofrecidas' : 'Tablas'}</span>
            </button>
            {#if confirmResign}
              <button class="btn danger" onclick={() => send({ t: 'resign' })}>Confirmar abandono</button>
              <button class="btn" onclick={() => (confirmResign = false)}>No</button>
            {:else}
              <button class="btn" onclick={() => (confirmResign = true)}>Abandonar</button>
            {/if}
          {/if}
        </div>
      {:else if over}
        <div class="result" role="status">
          {#if game.status !== 'aborted'}<p class="score-big">{scoreText(game.winner, game.status)}</p>{/if}
          <p class="headline">{resultText(game.status, game.winner)}</p>
          {#if you && game.winner === you}<p class="hint">Bien jugado.</p>{/if}
        </div>
        <div class="row">
          {#if you && game.status !== 'aborted'}
            {@const mine = game.rematch.includes(you)}
            {@const theirs = game.rematch.includes(opposite(you))}
            <button
              class="btn"
              class:primary={theirs}
              onclick={() => send({ t: 'rematch', offer: !mine })}
            >
              {mine ? 'Cancelar revancha' : theirs ? 'Aceptar revancha' : 'Revancha'}
            </button>
          {/if}
          <a class="btn" class:primary={!you || game.status === 'aborted'} href="/">Nueva partida</a>
        </div>
        {#if you && game.rematch.includes(opposite(you)) && !game.rematch.includes(you)}
          <p class="hint">Tu rival quiere la revancha.</p>
        {/if}
      {:else}
        <p class="hint">Estás viendo esta partida.</p>
      {/if}
    </div>
  </div>
{/if}

{#if toast}
  <div class="toast" role="alert">{toast}</div>
{/if}

<style>
  .empty {
    display: grid;
    place-items: center;
    gap: 12px;
    text-align: center;
    padding: 18vh var(--gutter);
  }
  .empty h1 {
    margin: 0;
    font-size: 1.6rem;
  }
  .empty p {
    margin: 0 0 8px;
    color: var(--muted);
  }

  /* ─── Rejilla: móvil primero ─────────────────────────────── */
  .game {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'top' 'board' 'bottom' 'controls' 'moves';
    gap: 8px;
    max-width: 1100px;
    margin: 0 auto;
    padding: 8px 0 32px;
  }
  .area-top {
    grid-area: top;
  }
  .area-board {
    grid-area: board;
    position: relative;
    /*
     * En el móvil, el tablero mide lo que quepa para que las dos barras, el tablero
     * y la fila de botones se vean sin scroll (240 px ≈ cabecera, barras, botones y
     * huecos). dvh descuenta las barras del navegador; vh es la alternativa.
     */
    width: min(100%, max(260px, calc(100vh - 240px)));
    width: min(100%, max(260px, calc(100dvh - 240px)));
    justify-self: center;
  }
  .area-bottom {
    grid-area: bottom;
  }
  .area-moves {
    grid-area: moves;
  }
  .area-controls {
    grid-area: controls;
    padding: 4px var(--gutter);
  }

  @media (min-width: 800px) {
    .game {
      /* El tablero manda: todo el alto disponible y una columna lateral estrecha. */
      grid-template-columns: minmax(0, min(calc(100vh - 96px), 840px)) minmax(220px, 260px);
      grid-template-rows: auto 1fr auto auto;
      grid-template-areas:
        'board top'
        'board moves'
        'board controls'
        'board bottom';
      column-gap: 24px;
      row-gap: 12px;
      padding: 16px var(--gutter) 32px;
      justify-content: center;
      align-items: start;
    }
    .area-board {
      align-self: start;
      width: auto;
      justify-self: stretch;
    }
    .area-moves {
      align-self: stretch;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius-m);
      overflow: hidden;
    }
    .area-controls {
      padding: 0;
    }
  }

  /* ─── Jugadores y relojes ────────────────────────────────── */
  .player {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    column-gap: 12px;
    padding: 0 var(--gutter);
  }
  .who {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    font-weight: 600;
  }
  .piece-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid var(--text);
    flex: none;
  }
  .piece-dot.white {
    background: #fff;
  }
  .piece-dot.black {
    background: #000;
  }
  .you {
    margin-left: 6px;
    padding: 1px 7px;
    border-radius: 99px;
    background: var(--brass-soft);
    color: var(--brass);
    font-size: 0.78rem;
    font-weight: 700;
  }
  .name {
    display: grid;
    justify-items: start;
    min-width: 0;
  }
  .you.bot {
    max-width: 100%;
    margin: 2px 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: var(--surface-2);
    color: var(--muted);
  }
  .first-line {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .first-line .you {
    margin-left: -2px;
  }
  .presence {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--line);
  }
  .presence.on {
    background: var(--online);
  }
  .waiting-seat {
    color: var(--muted);
    font-weight: 400;
    font-size: 0.9rem;
  }
  .clock {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: 1.6rem;
    letter-spacing: -0.02em;
    line-height: 1;
    padding: 8px 12px;
    min-width: 5.2ch;
    text-align: right;
    border-radius: var(--radius-s);
    color: var(--muted);
    background: var(--surface-2);
  }
  .running .clock {
    color: var(--text);
    background: var(--surface);
    box-shadow: inset 0 -3px 0 var(--brass);
  }
  .low .clock {
    color: #fff;
    background: var(--danger);
    box-shadow: none;
  }
  .deadline {
    margin: 0 0 8px;
    font-size: 0.9rem;
    color: var(--brass);
    font-weight: 600;
  }

  @media (min-width: 800px) {
    .player {
      padding: 4px 0;
    }
    .clock {
      font-size: 1.9rem;
      padding: 8px 12px;
    }
  }

  /* ─── Jugadas ────────────────────────────────────────────── */
  .nav {
    display: flex;
    gap: 2px;
    padding: 0 var(--gutter);
  }
  .nav button {
    flex: 1;
    display: grid;
    place-items: center;
    height: 40px;
    border: 0;
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--muted);
  }
  .nav button:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--text);
  }
  .nav button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .moves {
    list-style: none;
    margin: 0;
    padding: 4px var(--gutter);
    display: flex;
    gap: 4px 10px;
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .moves li {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .n {
    color: var(--muted);
    font-size: 0.85rem;
    margin-right: 2px;
  }
  .san {
    border: 0;
    background: none;
    padding: 4px 6px;
    border-radius: 4px;
    font-weight: 500;
  }
  .san:hover {
    background: var(--surface-2);
  }
  .san.active {
    background: var(--brass-soft);
    color: var(--brass);
    font-weight: 700;
  }
  .no-moves {
    color: var(--muted);
  }
  .score {
    font-weight: 800;
    padding: 0 6px;
  }

  @media (min-width: 800px) {
    .nav {
      padding: 6px;
      border-bottom: 1px solid var(--line);
    }
    .moves {
      flex-direction: column;
      flex-wrap: nowrap;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 6px 0;
      gap: 0;
      flex: 1;
      max-height: calc(100vh - 460px);
      min-height: 120px;
    }
    .moves li {
      display: grid;
      grid-template-columns: 3rem 1fr 1fr;
      gap: 0;
      padding: 0 8px 0 0;
    }
    .moves li:nth-child(even) {
      background: color-mix(in srgb, var(--surface-2) 45%, transparent);
    }
    .n {
      text-align: center;
      font-size: 0.85rem;
    }
    .san {
      text-align: left;
      padding: 5px 8px;
    }
    .no-moves,
    .score {
      display: block !important;
      padding: 10px 16px;
    }
    .score {
      text-align: center;
    }
  }

  /* ─── Controles ──────────────────────────────────────────── */
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .row > :global(*) {
    flex: 1 1 auto;
  }
  .label-short {
    display: none;
  }
  /* Móviles estrechos: los tres botones de la partida caben en una fila. */
  @media (max-width: 400px) {
    .row > :global(.btn) {
      padding: 0 10px;
      font-size: 0.9rem;
      white-space: nowrap;
    }
    .label-long {
      display: none;
    }
    .label-short {
      display: inline;
    }
  }
  .wide {
    width: 100%;
  }
  .headline {
    margin: 0;
    font-weight: 700;
    font-size: 1.05rem;
  }
  .hint {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 0.92rem;
  }
  .invite {
    display: grid;
    gap: 10px;
  }
  .invite .hint {
    margin: -6px 0 0;
  }
  .link-row {
    display: flex;
    gap: 8px;
  }
  .link-row input {
    flex: 1;
    min-width: 0;
    height: 44px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.92rem;
  }
  .offer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    padding: 10px 12px;
    border-radius: var(--radius-m);
    background: var(--brass-soft);
    font-weight: 600;
  }
  .offer span {
    flex: 1 0 100%;
  }
  .result {
    margin-bottom: 12px;
  }
  .score-big {
    margin: 0 0 2px;
    font-size: 2rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }

  /* ─── Coronación y avisos ────────────────────────────────── */
  .reconnecting {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    padding: 6px 14px;
    border-radius: 99px;
    background: var(--danger);
    color: #fff;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(20px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    z-index: 50;
    padding: 10px 18px;
    border-radius: var(--radius-m);
    background: var(--text);
    color: var(--bg);
    font-weight: 600;
    box-shadow: 0 10px 30px -10px rgb(0 0 0 / 0.5);
  }
  .loading {
    color: var(--muted);
  }
  /*
   * Móvil en horizontal (también los grandes, de más de 800 px de ancho): tablero a la
   * izquierda con todo el alto; lo demás, a su derecha. Va al final para ganar a las
   * reglas de escritorio.
   */
  @media (orientation: landscape) and (max-height: 500px) {
    .game {
      grid-template-columns: minmax(0, calc(100vh - 56px)) minmax(0, 1fr);
      grid-template-columns: minmax(0, calc(100dvh - 56px)) minmax(0, 1fr);
      grid-template-rows: auto auto auto 1fr;
      grid-template-areas:
        'board top'
        'board bottom'
        'board controls'
        'board moves';
      column-gap: 12px;
      row-gap: 8px;
      padding: 4px 8px;
      align-items: start;
    }
    .area-board {
      width: auto;
      justify-self: stretch;
    }
    .area-controls {
      padding: 0;
    }
    /* La lista, en una línea como en el móvil, aunque la pantalla pase de 800 px. */
    .area-moves {
      display: block;
      background: none;
      border: 0;
    }
    .nav {
      padding: 0;
      border: 0;
    }
    .moves {
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
      max-height: none;
      min-height: 0;
      padding: 4px 0;
      gap: 4px 10px;
    }
    .moves li,
    .moves li:nth-child(even) {
      display: flex;
      padding: 0;
      background: none;
    }
  }

</style>
