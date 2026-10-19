// Web Worker: la búsqueda de la máquina, fuera del hilo de la interfaz.
import { bestMove, type SearchLevel } from '@jaque/engine/bot';

export interface BotRequest {
  id: number;
  moves: string[];
  /** Posición de partida, si no es la inicial (seguir la línea de un problema). */
  fen?: string;
  level: SearchLevel;
  budget?: number;
}

export interface BotReply {
  id: number;
  uci: string | null;
}

self.onmessage = (e: MessageEvent<BotRequest>) => {
  const { id, moves, fen, level, budget } = e.data;
  const reply: BotReply = { id, uci: bestMove(moves, { fen, level, budget }) };
  self.postMessage(reply);
};
