<script lang="ts">
  import { onMount } from 'svelte';
  import { Chessground } from 'chessground';
  import type { Api } from 'chessground/api';
  import type { Config } from 'chessground/config';
  import type { DrawShape } from 'chessground/draw';
  import type { Dests, Key, MoveMetadata } from 'chessground/types';
  import 'chessground/assets/chessground.base.css';
  import 'chessground/assets/chessground.cburnett.css';
  import type { Color } from '@jaque/shared';

  interface Props {
    fen: string;
    orientation: Color;
    turnColor: Color;
    /** Color que puede mover el usuario, o null si solo mira. */
    movableColor: Color | null;
    dests: Dests;
    lastMove?: [Key, Key];
    check: boolean;
    onmove?: (orig: Key, dest: Key, meta: MoveMetadata) => void;
    /** Marcas fijas sobre el tablero (la pista del problema del día). */
    shapes?: DrawShape[];
    /** Avisar con un cartel de cada jaque nuevo (en juego, no al repasar jugadas). */
    notify?: boolean;
  }

  let { fen, orientation, turnColor, movableColor, dests, lastMove, check, onmove, shapes = [], notify = false }: Props =
    $props();

  /** Cartel de jaque: unos segundos sobre el tablero, una vez por posición. */
  const NOTICE_MS = 2000;
  let notice = $state<string | null>(null);
  let noticed = '';
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    // Sin jugadas no es jaque sino mate: eso lo cuenta la celebración.
    if (!notify || !check || !dests.size || fen === noticed) return;
    noticed = fen;
    notice = movableColor === turnColor ? '¡Jaque! Salva a tu rey' : '¡Jaque!';
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = null), NOTICE_MS);
  });
  $effect(() => {
    if (!check) notice = null;
  });

  let el: HTMLDivElement;
  let cg: Api | undefined;

  const config = (): Config => ({
    fen,
    orientation,
    turnColor,
    lastMove,
    check: check ? turnColor : false,
    viewOnly: false,
    movable: {
      free: false,
      color: movableColor ?? undefined,
      dests: movableColor === turnColor ? dests : new Map()
    },
    premovable: { enabled: !!movableColor },
    draggable: { enabled: !!movableColor },
    drawable: { autoShapes: shapes }
  });

  onMount(() => {
    cg = Chessground(el, {
      ...config(),
      coordinates: true,
      animation: { enabled: true, duration: 160 },
      highlight: { lastMove: true, check: true },
      movable: {
        ...config().movable,
        showDests: true,
        events: { after: (o, d, m) => onmove?.(o, d, m) }
      },
      premovable: { enabled: !!movableColor, showDests: true, castle: true },
      drawable: { ...config().drawable, enabled: true }
    });
    return () => {
      clearTimeout(noticeTimer);
      cg?.destroy();
    };
  });

  // Sincronizar con las props cada vez que cambian.
  $effect(() => {
    const c = config();
    if (!cg) return;
    // Si hay una premove pendiente y ya no podemos mover (fin de partida), se anula.
    if (!movableColor) cg.cancelPremove();
    cg.set(c);
  });

  /** Ejecuta la premove guardada, si la hay. Llamar tras recibir la jugada del rival. */
  export function playPremove() {
    return cg?.playPremove() ?? false;
  }

  /**
   * Deshace en el tablero una jugada que no se aceptó. Hay que restaurar todo,
   * no solo la posición: al mover, chessground cambia el turno y vacía los destinos.
   */
  export function cancelMove() {
    cg?.set(config());
  }

  export function cancelPremove() {
    cg?.cancelPremove();
  }
</script>

<div class="board-wrap">
  <div class="board" bind:this={el}></div>
  {#if notice}
    <div class="check-notice" role="status">{notice}</div>
  {/if}
</div>

<style>
  /* Encima del tablero sin tapar las jugadas: no recoge los toques. */
  .check-notice {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 5;
    transform: translate(-50%, -50%);
    padding: 10px 20px;
    border-radius: 99px;
    background: rgb(190 20 20 / 0.92);
    color: #fff;
    font-size: 1.15rem;
    font-weight: 800;
    white-space: nowrap;
    box-shadow: 0 10px 30px -10px rgb(0 0 0 / 0.6);
    pointer-events: none;
    animation: notice 2s ease-out forwards;
  }
  @keyframes notice {
    0% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.85);
    }
    10%,
    80% {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    100% {
      opacity: 0;
    }
  }
  .board-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
  }
  .board {
    position: absolute;
    inset: 0;
    border-radius: 3px;
    overflow: hidden;
    box-shadow: 0 1px 0 var(--line), 0 12px 32px -18px rgb(0 0 0 / 0.55);
  }
</style>
