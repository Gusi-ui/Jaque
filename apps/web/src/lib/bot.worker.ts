// Web Worker: la búsqueda de la máquina, fuera del hilo de la interfaz.
import { bestMove, type BotLevel } from '@jaque/engine/bot';

export interface BotRequest {
  id: number;
  moves: string[];
  level: BotLevel;
  budget?: number;
}

export interface BotReply {
  id: number;
  uci: string | null;
}

self.onmessage = (e: MessageEvent<BotRequest>) => {
  const { id, moves, level, budget } = e.data;
  const reply: BotReply = { id, uci: bestMove(moves, { level, budget }) };
  self.postMessage(reply);
};
