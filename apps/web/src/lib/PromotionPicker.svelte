<script lang="ts">
  import type { Color } from '@jaque/shared';

  export type PromotionRole = 'q' | 'r' | 'b' | 'n';

  interface Props {
    color: Color;
    onchoose: (role: PromotionRole) => void;
    oncancel: () => void;
  }

  let { color, onchoose, oncancel }: Props = $props();

  const PIECES = [
    ['q', 'queen', 'Dama'],
    ['r', 'rook', 'Torre'],
    ['b', 'bishop', 'Alfil'],
    ['n', 'knight', 'Caballo']
  ] as const;
</script>

<!-- Se coloca encima del tablero (su contenedor debe tener position: relative). -->
<div class="promo" role="dialog" aria-label="Elige pieza para coronar">
  <div class="promo-box cg-wrap">
    {#each PIECES as [r, role, label] (r)}
      <button class="promo-piece" onclick={() => onchoose(r)} aria-label={label}>
        <piece class="{role} {color}"></piece>
      </button>
    {/each}
  </div>
  <button class="promo-cancel" onclick={oncancel}>Cancelar</button>
</div>

<style>
  .promo {
    position: absolute;
    inset: 0;
    z-index: 10;
    display: grid;
    place-content: center;
    gap: 12px;
    /* Las piezas se ajustan al tablero: sirve igual para la partida y para el problema del día. */
    container-type: inline-size;
    background: rgb(27 33 48 / 0.55);
    backdrop-filter: blur(2px);
  }
  .promo-box {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: min(8px, 2cqw);
  }
  .promo-piece {
    width: min(18vw, 88px, 20cqw);
    aspect-ratio: 1;
    border: 0;
    border-radius: 50%;
    background: var(--sq-light);
    position: relative;
    transition: transform 0.1s;
  }
  .promo-piece:hover {
    transform: scale(1.06);
    background: #fff;
  }
  .promo-piece piece {
    position: absolute;
    top: 8%;
    left: 8%;
    width: 84%;
    height: 84%;
    background-size: cover;
    transform: none;
  }
  .promo-box.cg-wrap {
    width: auto;
    height: auto;
  }
  .promo-cancel {
    border: 0;
    background: none;
    color: #fff;
    text-decoration: underline;
  }
</style>
