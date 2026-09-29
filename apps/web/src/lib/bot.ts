// Se carga solo en las partidas contra la máquina (import dinámico en Game.svelte).
import { planBot } from '@jaque/engine/bot';
import type { ClientGameMsg, Color, GameView, ServerGameMsg } from '@jaque/shared';
import type { BotConfig } from './bot-config';
import { connect } from './socket';
import type { BotReply, BotRequest } from './bot.worker';

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
    // Se ha deshecho una jugada: lo pensado ya no vale.
    if (v.moves.length < thinkingAt) {
      thinkingAt = -1;
      clearTimeout(moveTimer);
    }
    const plan = planBot(v, you);
    // Cada decisión se envía una sola vez por estado de la partida.
    const sig = JSON.stringify([v.status, v.moves.join(), v.drawOffer, v.takeback, v.rematch, you, plan.send]);
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
        // Solo si la partida sigue en la misma posición (tras deshacer, el número de jugadas puede coincidir).
        if (view?.status === 'started' && view.moves.join() === req.moves.join()) {
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
