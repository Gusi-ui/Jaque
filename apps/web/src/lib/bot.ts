import { planBot, type BotLevel } from '@jaque/engine/bot';
import {
  PLAYER_ID_RE,
  type ClientGameMsg,
  type Color,
  type GameView,
  type ServerGameMsg
} from '@jaque/shared';
import { connect } from './socket';
import type { BotReply, BotRequest } from './bot.worker';

/**
 * La máquina se conecta a la partida como un jugador más, con su propio id y
 * su propio WebSocket. El servidor no sabe que es un bot: la partida sigue el
 * flujo real (relojes, tablas, abandono, revancha, historial).
 */
export interface BotConfig {
  player: string;
  level: BotLevel;
}

const key = (gameId: string) => `jaque:bot:${gameId}`;

/** Máquina asociada a una partida en esta pestaña, si la hay. */
export function botFor(gameId: string): BotConfig | null {
  try {
    const cfg = JSON.parse(sessionStorage.getItem(key(gameId)) ?? 'null') as BotConfig | null;
    if (cfg && PLAYER_ID_RE.test(cfg.player) && [1, 2, 3].includes(cfg.level)) return cfg;
  } catch {
    /* almacenamiento bloqueado o dato corrupto */
  }
  return null;
}

export function saveBot(gameId: string, cfg: BotConfig) {
  try {
    sessionStorage.setItem(key(gameId), JSON.stringify(cfg));
  } catch {
    /* sin almacenamiento: la máquina no sobrevivirá a una recarga */
  }
}

export function newBot(level: BotLevel): BotConfig {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const rand = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  return { player: `bot-${rand}`, level };
}

/** Tiempo de «reflexión» mínimo, para que no conteste al instante. */
const MIN_DELAY_MS = 400;
const EXTRA_DELAY_MS = 600;

export function startBot(gameId: string, cfg: BotConfig) {
  const worker = new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' });
  let you: Color | null = null;
  let view: GameView | null = null;
  /** Número de jugadas de la posición para la que ya se está pensando. */
  let thinkingAt = -1;
  let request = 0;
  let lastSent = '';
  let moveTimer: ReturnType<typeof setTimeout> | undefined;

  const socket = connect<ServerGameMsg, ClientGameMsg>(`/ws/game/${gameId}?player=${cfg.player}`, {
    onMessage(msg) {
      if (msg.t === 'hello') you = msg.you;
      else if (msg.t === 'state') view = msg.game;
      // Si el servidor rechaza la jugada, reenvía el estado: volver a pensar.
      else if (msg.t === 'error') thinkingAt = -1;
      else return;
      if (view) act(view);
    },
    onStatus(s) {
      // Tras reconectar, el servidor manda el estado completo: se decide de nuevo.
      if (s !== 'open') {
        thinkingAt = -1;
        lastSent = '';
      }
    }
  });

  function act(v: GameView) {
    const plan = planBot(v, you);
    // Cada decisión se envía una sola vez por estado de la partida.
    const sig = JSON.stringify([v.status, v.moves.length, v.drawOffer, v.rematch, you, plan.send]);
    if (plan.send.length && sig !== lastSent) {
      lastSent = sig;
      for (const m of plan.send) socket.send(m);
    }
    if (!plan.think || thinkingAt === v.moves.length) return;

    thinkingAt = v.moves.length;
    const myClock = you ? v.clock[you] : Infinity;
    const hurry = v.clock.running === you && myClock < 15_000;
    const req: BotRequest = {
      id: ++request,
      moves: v.moves,
      level: cfg.level,
      budget: hurry ? Math.min(150, myClock / 20) : undefined
    };
    const started = Date.now();
    const delay = hurry ? 0 : MIN_DELAY_MS + Math.random() * EXTRA_DELAY_MS;
    worker.onmessage = (e: MessageEvent<BotReply>) => {
      const { id, uci } = e.data;
      if (id !== request || !uci) return;
      const wait = Math.max(0, delay - (Date.now() - started));
      moveTimer = setTimeout(() => {
        // Solo si la partida sigue en la misma posición.
        if (view?.status === 'started' && view.moves.length === req.moves.length) {
          socket.send({ t: 'move', uci, ply: req.moves.length });
        }
      }, wait);
    };
    worker.postMessage(req);
  }

  return {
    stop() {
      clearTimeout(moveTimer);
      socket.close();
      worker.terminate();
    }
  };
}
