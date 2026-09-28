<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import {
    PRESETS,
    presetById,
    SPEED_LABEL,
    speedOf,
    tcLabel,
    type ClientLobbyMsg,
    type Color,
    type CreateGameBody,
    type ServerLobbyMsg,
    type TimeControl
  } from '@jaque/shared';
  import { connect, type SocketStatus } from '$lib/socket';
  import { playerId } from '$lib/player';
  import { lastLevel, newBot, saveBot, saveLastLevel } from '$lib/bot-config';
  import { BOT_LEVELS, type BotLevel } from '@jaque/engine/levels';
  import { SITE } from '$lib/site';
  import { thousands } from '$lib/format';

  // La portada se prerenderiza: el id del jugador solo existe en el navegador.
  const player = browser ? playerId() : '';

  /** Datos estructurados para Google (schema.org). */
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: SITE.name, url: `${SITE.url}/`, inLanguage: 'es' },
      {
        '@type': 'WebApplication',
        name: SITE.name,
        url: `${SITE.url}/`,
        description: SITE.description,
        applicationCategory: 'GameApplication',
        genre: 'Ajedrez',
        operatingSystem: 'Web',
        browserRequirements: 'Requiere JavaScript',
        inLanguage: 'es',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' }
      }
    ]
  });

  let stats = $state<Extract<ServerLobbyMsg, { t: 'stats' }> | null>(null);
  let seeking = $state<string | null>(null);
  let conn = $state<SocketStatus>('connecting');
  let error = $state('');
  let dialog = $state<HTMLDialogElement>();
  let creating = $state(false);

  // Partida con amigo
  const MINUTES = [0.5, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90];
  const INCREMENTS = [0, 1, 2, 3, 5, 10, 15, 20, 30];
  let minutes = $state(5);
  let increment = $state(3);
  let color = $state<Color | 'random'>('random');
  /** El mismo diálogo sirve para jugar con un amigo o contra la máquina. */
  let mode = $state<'friend' | 'bot'>('friend');
  let level = $state<BotLevel>(1);
  /** Nivel de «Jugar ya» y de la oferta tras esperar: el último elegido, o fácil. */
  let savedLevel = $state<BotLevel>(1);

  /** El reto de la máquina: aparece solo, una vez por visita, si el visitante no hace nada. */
  const CHALLENGE_TC: TimeControl = { initial: 300, increment: 3 };
  const CHALLENGE_MS = 8_000;
  const CHALLENGE_KEY = 'jaque:reto-visto';
  let challenge = $state(false);

  // Buscar rival manda sobre el reto.
  $effect(() => {
    if (seeking) challenge = false;
  });
  /** Tras esta espera sin rival se ofrece jugar contra la máquina. */
  const OFFER_BOT_MS = 12_000;
  let offerBot = $state(false);

  $effect(() => {
    offerBot = false;
    if (!seeking) return;
    const t = setTimeout(() => (offerBot = true), OFFER_BOT_MS);
    return () => clearTimeout(t);
  });

  /** Con poca gente conectada, el directo solo dice que está vacío: se muestra el historial. */
  const LIVE_MIN_PLAYERS = 3;
  const PLAYED_MIN = 50;

  function openDialog(m: 'friend' | 'bot') {
    mode = m;
    dialog?.showModal();
  }
  const friendTc = $derived({ initial: Math.round(minutes * 60), increment });

  let socket: ReturnType<typeof connect<ServerLobbyMsg, ClientLobbyMsg>> | undefined;

  onMount(() => {
    savedLevel = level = lastLevel();
    const challengeTimer = setTimeout(showChallenge, CHALLENGE_MS);
    socket = connect<ServerLobbyMsg, ClientLobbyMsg>(`/ws/lobby?player=${player}`, {
      onMessage(msg) {
        if (msg.t === 'stats') stats = msg;
        else if (msg.t === 'seeking') seeking = msg.tc;
        else if (msg.t === 'start') goto(`/${msg.id}`);
        else if (msg.t === 'error') error = msg.msg;
      },
      onStatus(s) {
        conn = s;
        // El servidor olvida la búsqueda al perder la conexión: la repetimos.
        if (s === 'open' && seeking) socket?.send({ t: 'seek', tc: seeking });
      }
    });
    return () => {
      clearTimeout(challengeTimer);
      socket?.close();
    };
  });

  function showChallenge() {
    if (seeking || creating || dialog?.open) return;
    try {
      if (sessionStorage.getItem(CHALLENGE_KEY)) return;
      sessionStorage.setItem(CHALLENGE_KEY, '1');
    } catch {
      /* sin almacenamiento: se muestra igual */
    }
    challenge = true;
  }

  function toggleSeek(id: string) {
    error = '';
    if (seeking === id) {
      socket?.send({ t: 'cancel' });
      seeking = null;
      return;
    }
    if (!socket?.send({ t: 'seek', tc: id })) error = 'Sin conexión con el servidor. Reintentando…';
    else seeking = id;
  }

  /** Crea la partida (con amigo o contra la máquina, si hay nivel) y entra en ella. */
  async function createGame(tc: TimeControl, color: Color | 'random', botLevel?: BotLevel) {
    creating = true;
    error = '';
    try {
      const body: CreateGameBody = { player, tc, color };
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      const { id } = await res.json();
      if (botLevel) saveBot(id, newBot(botLevel));
      if (seeking) socket?.send({ t: 'cancel' });
      goto(`/${id}`);
    } catch (err) {
      error = `No se pudo crear la partida: ${(err as Error).message}`;
      creating = false;
    }
  }

  function submitDialog(e: SubmitEvent) {
    e.preventDefault();
    if (mode === 'bot') {
      saveLastLevel(level);
      savedLevel = level;
    }
    createGame(friendTc, color, mode === 'bot' ? level : undefined);
  }

  function playBotNow(tc: TimeControl) {
    createGame({ initial: tc.initial, increment: tc.increment }, 'random', savedLevel);
  }

  const minuteLabel = (m: number) => (m === 0.5 ? '½' : String(m));
</script>

<svelte:head>
  <title>{SITE.title}</title>
  <meta name="description" content={SITE.description} />
  <link rel="canonical" href="{SITE.url}/" />
  <meta property="og:url" content="{SITE.url}/" />
  {@html `<script type="application/ld+json">${jsonLd}</script>`}
</svelte:head>

<section class="lobby">
  <h1 class="title">Ajedrez online, gratis y sin registro</h1>
  <p class="lead">Elige un ritmo y te emparejamos con alguien.</p>

  <div class="grid" role="group" aria-label="Ritmos de juego">
    {#each PRESETS as p, i (p.id)}
      {@const waiting = stats?.seeks[p.id] ?? 0}
      <button
        class="tc"
        class:dark={(Math.floor(i / 3) + (i % 3)) % 2 === 1}
        class:active={seeking === p.id}
        aria-pressed={seeking === p.id}
        onclick={() => toggleSeek(p.id)}
      >
        <span class="tc-time">{p.id}</span>
        <span class="tc-speed">
          {#if seeking === p.id}
            Buscando rival…
          {:else if waiting > 0}
            {waiting} {waiting === 1 ? 'persona espera' : 'personas esperan'}
          {:else}
            {SPEED_LABEL[p.speed]}
          {/if}
        </span>
      </button>
    {/each}
  </div>

  {#if seeking}
    {@const tc = presetById(seeking)}
    <div class="seeking" role="status">
      {#if offerBot && tc}
        <p>No hay nadie libre ahora mismo.</p>
        <button class="btn primary" disabled={creating} onclick={() => playBotNow(tc)}>
          Jugar {seeking} contra la máquina
        </button>
        <p class="wait">Si prefieres esperar, seguimos buscando rival.</p>
      {:else}
        <p>Buscando rival para {seeking}. Toca la casilla de nuevo para cancelar.</p>
      {/if}
    </div>
  {/if}

  <div class="modes">
    <button class="btn friend" onclick={() => openDialog('friend')}>Jugar con un amigo</button>
    <button class="btn friend" onclick={() => openDialog('bot')}>Jugar contra la máquina</button>
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <p class="stats" aria-live="polite">
    {#if conn !== 'open'}
      Conectando…
    {:else if stats && stats.players >= LIVE_MIN_PLAYERS}
      {stats.players} jugadores conectados,
      {stats.games} {stats.games === 1 ? 'partida en juego' : 'partidas en juego'}
    {:else if stats && stats.played >= PLAYED_MIN}
      {thousands(stats.played)} partidas jugadas en DameJaque
    {/if}
  </p>
</section>

<section class="about" aria-labelledby="about-title">
  <h2 id="about-title">Juega al ajedrez en segundos</h2>
  <ul>
    <li>
      <strong>Partidas rápidas.</strong> Elige un ritmo, de bullet 1+0 a rápidas 15+10, y te
      emparejamos con otra persona.
    </li>
    <li>
      <strong>Reta a un amigo.</strong> Crea una partida con el ritmo y el color que quieras y
      comparte el enlace.
    </li>
    <li>
      <strong>Contra la máquina.</strong> Tres niveles, de fácil a difícil, para practicar cuando
      quieras.
    </li>
    <li>
      <strong>Sin registro ni anuncios.</strong> Funciona en el móvil y en el ordenador, y se puede
      instalar como aplicación.
    </li>
  </ul>
</section>

{#if challenge}
  <aside class="challenge" aria-labelledby="challenge-title" aria-live="polite">
    <p class="challenge-title" id="challenge-title"><span aria-hidden="true">♞&#xFE0E;</span> La máquina te reta</p>
    <p class="challenge-text">
      Una partida rápida {tcLabel(CHALLENGE_TC)}, nivel {BOT_LEVELS[savedLevel].toLowerCase()}. ¿Aceptas?
    </p>
    <div class="challenge-actions">
      <button class="btn" onclick={() => (challenge = false)}>Ahora no</button>
      <button class="btn primary" disabled={creating} onclick={() => playBotNow(CHALLENGE_TC)}>
        Acepto el reto
      </button>
    </div>
  </aside>
{/if}

<footer class="foot">
  <p class="foot-brand">
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="0" y="0" width="8" height="8" fill="var(--brass)" />
      <rect x="8" y="8" width="8" height="8" fill="var(--brass)" />
      <rect x="8" y="0" width="8" height="8" fill="var(--line)" />
      <rect x="0" y="8" width="8" height="8" fill="var(--line)" />
    </svg>
    {SITE.name}
  </p>
  <p>Ajedrez online gratis, sin registro y sin anuncios.</p>
  <p>Hecho con muchísimo <span class="heart" role="img" aria-label="cariño">♥</span></p>
</footer>

<dialog bind:this={dialog} class="friend-dialog" onclick={(e) => e.target === dialog && dialog.close()}>
  <form onsubmit={submitDialog}>
    {#if mode === 'bot'}
      <h2>Jugar contra la máquina</h2>
      <p class="hint">Una partida normal, con reloj, contra el ordenador.</p>

      <fieldset>
        <legend>Nivel</legend>
        <div class="chips">
          {#each [1, 2, 3] as const as l (l)}
            <label class="chip">
              <input type="radio" name="level" value={l} bind:group={level} />
              <span>{BOT_LEVELS[l]}</span>
            </label>
          {/each}
        </div>
      </fieldset>
    {:else}
      <h2>Jugar con un amigo</h2>
      <p class="hint">Crearemos un enlace. Quien lo abra primero jugará contra ti.</p>
    {/if}

    <fieldset>
      <legend>Minutos por jugador</legend>
      <div class="chips">
        {#each MINUTES as m (m)}
          <label class="chip">
            <input type="radio" name="minutes" value={m} bind:group={minutes} />
            <span>{minuteLabel(m)}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend>Incremento en segundos</legend>
      <div class="chips">
        {#each INCREMENTS as inc (inc)}
          <label class="chip">
            <input type="radio" name="increment" value={inc} bind:group={increment} />
            <span>{inc}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    <fieldset>
      <legend>Juegas con</legend>
      <div class="colors">
        {#each [['white', 'Blancas'], ['random', 'Al azar'], ['black', 'Negras']] as const as [c, label] (c)}
          <label class="color-opt">
            <input type="radio" name="color" value={c} bind:group={color} />
            <span class="swatch {c}" aria-hidden="true"></span>
            <span>{label}</span>
          </label>
        {/each}
      </div>
    </fieldset>

    <p class="summary">
      {tcLabel(friendTc)} · {SPEED_LABEL[speedOf(friendTc)]}
    </p>

    <div class="actions">
      <button type="button" class="btn" onclick={() => dialog?.close()}>Cancelar</button>
      <button type="submit" class="btn primary" disabled={creating}>
        {creating ? 'Creando…' : 'Crear partida'}
      </button>
    </div>
  </form>
</dialog>

<style>
  .lobby {
    max-width: 520px;
    margin: 0 auto;
    padding: 6vh var(--gutter) 48px;
    display: grid;
    gap: 16px;
  }
  .title {
    margin: 0;
    font-size: clamp(1.5rem, 5vw, 2rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.15;
  }
  .lead {
    margin: 0 0 4px;
    font-size: 1.15rem;
    font-weight: 500;
    color: var(--muted);
  }

  /* La parrilla de ritmos es un trozo de tablero de 3×3. */
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    container-type: inline-size;
    border-radius: var(--radius-m);
    overflow: hidden;
    box-shadow: 0 1px 0 var(--line), 0 18px 40px -24px rgb(0 0 0 / 0.6);
  }
  .tc {
    aspect-ratio: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 0;
    padding: 8px;
    background: var(--sq-light);
    color: #1b2130;
    transition: background-color 0.15s;
  }
  .tc.dark {
    background: var(--sq-dark);
    color: #fff;
  }
  .tc:hover {
    background: color-mix(in srgb, var(--sq-light) 70%, var(--brass));
  }
  .tc.dark:hover {
    background: color-mix(in srgb, var(--sq-dark) 70%, var(--brass));
  }
  .tc.active.active {
    background: var(--brass);
    color: #fff;
    animation: pulse 1.6s ease-in-out infinite;
  }
  .tc:focus-visible {
    outline-offset: -4px;
    outline-color: #1b2130;
  }
  @keyframes pulse {
    50% {
      filter: brightness(1.12);
    }
  }
  .tc-time {
    font-size: min(8cqi, 2.6rem);
    font-weight: 800;
    letter-spacing: -0.04em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .tc-speed {
    font-size: 0.88rem;
    font-weight: 500;
    opacity: 0.85;
    text-align: center;
  }

  .seeking {
    display: grid;
    gap: 8px;
    color: var(--brass);
    font-weight: 600;
  }
  .seeking p {
    margin: 0;
  }
  .seeking .wait {
    color: var(--muted);
    font-weight: 500;
    font-size: 0.92rem;
  }
  .modes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 8px;
  }
  .friend {
    width: 100%;
    min-height: 52px;
    font-size: 1.05rem;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-weight: 600;
  }
  .stats {
    margin: 0;
    color: var(--muted);
    font-size: 0.92rem;
    text-align: center;
    min-height: 1.4em;
  }

  .about {
    max-width: 520px;
    margin: 0 auto;
    padding: 0 var(--gutter) 56px;
    color: var(--muted);
  }
  .about h2 {
    margin: 0 0 10px;
    font-size: 1.1rem;
    color: var(--text);
  }
  .about ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 8px;
    font-size: 0.95rem;
    line-height: 1.45;
  }
  .about strong {
    color: var(--text);
  }

  .foot {
    /* Mismo ancho que el texto de arriba, para que la línea no sobresalga. */
    margin-inline: max(var(--gutter), calc((100% - 520px) / 2 + var(--gutter)));
    padding: 24px 0 calc(32px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
    display: grid;
    gap: 4px;
    justify-items: center;
    text-align: center;
    color: var(--muted);
    font-size: 0.88rem;
  }
  .foot p {
    margin: 0;
  }
  .foot .foot-brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-weight: 800;
    font-size: 1rem;
    letter-spacing: -0.03em;
    color: var(--text);
  }
  .foot-brand svg {
    border-radius: 3px;
  }
  .heart {
    color: var(--danger);
  }

  /* ─── Reto de la máquina ─────────────────────────────────── */
  .challenge {
    position: fixed;
    z-index: 10;
    left: 12px;
    right: 12px;
    bottom: calc(12px + env(safe-area-inset-bottom));
    display: grid;
    gap: 6px;
    padding: 18px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 24px 60px -20px rgb(0 0 0 / 0.55);
    animation: rise 0.35s ease-out;
  }
  @media (min-width: 600px) {
    .challenge {
      left: auto;
      right: 24px;
      bottom: 24px;
      width: 340px;
    }
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .challenge {
      animation: none;
    }
  }
  .challenge p {
    margin: 0;
  }
  .challenge-title {
    font-weight: 800;
    font-size: 1.15rem;
    letter-spacing: -0.02em;
  }
  .challenge-title span {
    font-size: 1.3em;
    line-height: 1;
    color: var(--brass);
  }
  .challenge-text {
    color: var(--muted);
  }
  .challenge-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }

  /* ─── Diálogo ───────────────────────────────────────────── */
  .friend-dialog {
    width: min(460px, calc(100vw - 24px));
    max-height: calc(100dvh - 24px);
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 30px 80px -30px rgb(0 0 0 / 0.6);
  }
  .friend-dialog::backdrop {
    background: rgb(27 33 48 / 0.5);
  }
  form {
    display: grid;
    gap: 18px;
    padding: 22px;
  }
  h2 {
    margin: 0;
    font-size: 1.35rem;
    letter-spacing: -0.02em;
  }
  .hint {
    margin: -12px 0 0;
    color: var(--muted);
    font-size: 0.92rem;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    display: grid;
    gap: 8px;
  }
  legend {
    padding: 0 0 8px;
    font-weight: 600;
    font-size: 0.95rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip input,
  .color-opt input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .chip span {
    display: grid;
    place-items: center;
    min-width: 44px;
    height: 40px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .chip input:checked + span,
  .color-opt:has(input:checked) {
    border-color: var(--brass);
    background: var(--brass-soft);
    color: var(--brass);
  }
  .chip input:focus-visible + span,
  .color-opt:has(input:focus-visible) {
    outline: 2px solid var(--brass);
    outline-offset: 2px;
  }
  .colors {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .color-opt {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius-s);
    font-weight: 600;
    font-size: 0.92rem;
    cursor: pointer;
  }
  .swatch {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 1.5px solid var(--text);
  }
  .swatch.white {
    background: #fff;
  }
  .swatch.black {
    background: #1b2130;
  }
  .swatch.random {
    background: linear-gradient(90deg, #fff 50%, #1b2130 50%);
  }
  .summary {
    margin: 0;
    font-weight: 700;
    font-size: 1.1rem;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
