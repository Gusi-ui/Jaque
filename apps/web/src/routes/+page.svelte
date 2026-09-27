<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    PRESETS,
    SPEED_LABEL,
    speedOf,
    tcLabel,
    type ClientLobbyMsg,
    type Color,
    type CreateGameBody,
    type ServerLobbyMsg
  } from '@jaque/shared';
  import { connect, type SocketStatus } from '$lib/socket';
  import { playerId } from '$lib/player';
  import { newBot, saveBot } from '$lib/bot';
  import { BOT_LEVELS, type BotLevel } from '@jaque/engine/bot';

  const player = playerId();

  let stats = $state<{ players: number; games: number; seeks: Record<string, number> } | null>(null);
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
  let level = $state<BotLevel>(2);

  function openDialog(m: 'friend' | 'bot') {
    mode = m;
    dialog?.showModal();
  }
  const friendTc = $derived({ initial: Math.round(minutes * 60), increment });

  let socket: ReturnType<typeof connect<ServerLobbyMsg, ClientLobbyMsg>> | undefined;

  onMount(() => {
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
    return () => socket?.close();
  });

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

  async function createFriendGame(e: SubmitEvent) {
    e.preventDefault();
    creating = true;
    error = '';
    try {
      const body: CreateGameBody = { player, tc: friendTc, color };
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      const { id } = await res.json();
      if (mode === 'bot') saveBot(id, newBot(level));
      if (seeking) socket?.send({ t: 'cancel' });
      goto(`/${id}`);
    } catch (err) {
      error = `No se pudo crear la partida: ${(err as Error).message}`;
      creating = false;
    }
  }

  const minuteLabel = (m: number) => (m === 0.5 ? '½' : String(m));
</script>

<svelte:head><title>jaque · ajedrez online</title></svelte:head>

<section class="lobby">
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
    <p class="seeking" role="status">
      Buscando rival para {seeking}. Toca la casilla de nuevo para cancelar.
    </p>
  {/if}

  <div class="modes">
    <button class="btn friend" onclick={() => openDialog('friend')}>Jugar con un amigo</button>
    <button class="btn friend" onclick={() => openDialog('bot')}>Jugar contra la máquina</button>
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <p class="stats" aria-live="polite">
    {#if conn !== 'open'}
      Conectando…
    {:else if stats}
      {stats.players} {stats.players === 1 ? 'jugador conectado' : 'jugadores conectados'},
      {stats.games} {stats.games === 1 ? 'partida en juego' : 'partidas en juego'}
    {/if}
  </p>
</section>

<dialog bind:this={dialog} class="friend-dialog" onclick={(e) => e.target === dialog && dialog.close()}>
  <form onsubmit={createFriendGame}>
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
    margin: 0;
    color: var(--brass);
    font-weight: 600;
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
