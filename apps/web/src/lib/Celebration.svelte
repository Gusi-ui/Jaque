<script lang="ts">
  import { onMount } from 'svelte';

  export type Tone = 'win' | 'loss' | 'draw';

  interface Props {
    tone: Tone;
    title: string;
    detail?: string;
    /** Línea destacada debajo (la racha del problema del día). */
    extra?: string;
    ondismiss: () => void;
  }
  let { tone, title, detail, extra, ondismiss }: Props = $props();

  /** Tras unos segundos se aparta sola para dejar ver la posición final. */
  const STAY_MS = { win: 4500, loss: 3000, draw: 3000 };
  const ICON = { win: '♛', loss: '♚', draw: '½' };
  const COLORS = ['var(--brass)', '#e3c46f', '#7c93b5', '#d9dee8', '#b8572f'];

  // Confeti solo al ganar: cada trozo sale del centro en una dirección y distancia al azar.
  const pieces = Array.from({ length: 36 }, (_, i) => {
    const angle = (i / 36) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 90 + Math.random() * 110;
    return {
      x: Math.round(Math.cos(angle) * dist),
      y: Math.round(Math.sin(angle) * dist - 40),
      r: Math.round(Math.random() * 540 - 270),
      delay: Math.round(Math.random() * 120),
      color: COLORS[i % COLORS.length],
      round: i % 3 === 0
    };
  });

  onMount(() => {
    const timer = setTimeout(ondismiss, STAY_MS[tone]);
    return () => clearTimeout(timer);
  });
</script>

<!-- Pulsar en cualquier parte la cierra; el resultado sigue anunciado en el panel. -->
<button class="celebration {tone}" onclick={ondismiss} aria-label="{title}. Cerrar">
  {#if tone === 'win'}
    <span class="confetti" aria-hidden="true">
      {#each pieces as p, i (i)}
        <i
          class:round={p.round}
          style="--x: {p.x}px; --y: {p.y}px; --r: {p.r}deg; --d: {p.delay}ms; background: {p.color}"
        ></i>
      {/each}
    </span>
  {/if}
  <span class="badge">
    <span class="icon" aria-hidden="true">{ICON[tone]}</span>
    <span class="title">{title}</span>
    {#if detail}<span class="detail">{detail}</span>{/if}
    {#if extra}<span class="extra">{extra}</span>{/if}
  </span>
</button>

<style>
  .celebration {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 12px;
    border: 0;
    border-radius: 3px;
    background: rgb(27 33 48 / 0.45);
    color: var(--text);
    font: inherit;
    cursor: pointer;
    overflow: hidden;
    container-type: size;
    animation: fade-in 0.25s ease-out both;
  }
  .celebration.loss,
  .celebration.draw {
    background: rgb(27 33 48 / 0.35);
  }

  .badge {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 4px;
    max-width: 100%;
    padding: clamp(14px, 4cqw, 26px) clamp(18px, 6cqw, 36px);
    border: 1px solid var(--line);
    border-radius: 16px;
    background: var(--surface);
    box-shadow: 0 24px 60px -20px rgb(0 0 0 / 0.6);
    text-align: center;
    animation: pop 0.5s cubic-bezier(0.2, 1.4, 0.4, 1) both;
  }
  .win .badge {
    border-color: var(--brass);
    box-shadow:
      0 0 0 4px var(--brass-soft),
      0 24px 60px -20px rgb(0 0 0 / 0.6);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    margin-bottom: 4px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 1.9rem;
    line-height: 1;
  }
  .win .icon {
    background: var(--brass);
    color: #fff;
    animation: shine 1.2s 0.4s ease-out both;
  }
  .title {
    font-size: clamp(1.4rem, 7cqw, 2.1rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }
  .win .title {
    color: var(--brass);
  }
  .detail {
    color: var(--muted);
    font-size: 0.95rem;
  }
  .extra {
    margin-top: 6px;
    padding: 4px 12px;
    border-radius: 99px;
    background: var(--brass-soft);
    color: var(--text);
    font-size: 0.88rem;
    font-weight: 700;
  }

  .confetti {
    position: absolute;
    top: 50%;
    left: 50%;
  }
  .confetti i {
    position: absolute;
    width: 8px;
    height: 12px;
    border-radius: 2px;
    opacity: 0;
    animation: burst 1.5s var(--d) cubic-bezier(0.15, 0.8, 0.3, 1) both;
  }
  .confetti i.round {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
  }
  @keyframes shine {
    0% {
      box-shadow: 0 0 0 0 rgb(201 162 74 / 0.7);
    }
    100% {
      box-shadow: 0 0 0 18px rgb(201 162 74 / 0);
    }
  }
  @keyframes burst {
    0% {
      opacity: 1;
      transform: translate(-50%, -50%) rotate(0);
    }
    75% {
      opacity: 1;
    }
    100% {
      opacity: 0;
      transform: translate(calc(var(--x) - 50%), calc(var(--y) + 60px - 50%)) rotate(var(--r));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .confetti {
      display: none;
    }
  }
</style>
