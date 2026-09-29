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
  }

  let { fen, orientation, turnColor, movableColor, dests, lastMove, check, onmove, shapes = [] }: Props = $props();

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
    return () => cg?.destroy();
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
</script>

<div class="board-wrap">
  <div class="board" bind:this={el}></div>
</div>

<style>
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
