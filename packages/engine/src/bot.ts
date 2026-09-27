// La máquina: un motor sencillo (negamax con poda alfa-beta) y la política de un
// jugador automático. No depende del servidor: el navegador la ejecuta y se conecta
// como un jugador más, así que la partida sigue el flujo real.
// La búsqueda usa chessops (el generador de jugadas de lichess), mucho más rápido
// que chess.js para esto; las reglas de la partida siguen en chess.js.
import { Chess, normalizeMove, type Position } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import type { NormalMove, Role } from 'chessops/types';
import { makeUci, parseUci, squareFile, squareRank } from 'chessops/util';
import {
  isOver,
  opposite,
  type ClientGameMsg,
  type Color,
  type GameView
} from '@jaque/shared';

export type BotLevel = 1 | 2 | 3;

export const BOT_LEVELS: Record<BotLevel, string> = { 1: 'Fácil', 2: 'Medio', 3: 'Difícil' };

interface LevelConfig {
  /** Profundidad máxima (en medias jugadas). */
  depth: number;
  /** Capturas extra al final de la búsqueda, para no dejarse piezas colgando. */
  quiescence: boolean;
  /** Ruido en centipeones que se suma a cada jugada candidata. */
  noise: number;
  /** Probabilidad de jugar una jugada legal cualquiera. */
  blunder: number;
  /** Tiempo máximo de búsqueda, en ms. */
  budget: number;
}

const LEVELS: Record<BotLevel, LevelConfig> = {
  1: { depth: 1, quiescence: false, noise: 250, blunder: 0.2, budget: 200 },
  2: { depth: 2, quiescence: true, noise: 60, blunder: 0, budget: 800 },
  3: { depth: 4, quiescence: true, noise: 10, blunder: 0, budget: 1500 }
};

// ─── Evaluación ──────────────────────────────────────────────────────

const VALUE: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Tablas de posición (Tomasz Michniewski, «Simplified Evaluation Function»),
// desde el punto de vista de las blancas: la fila 0 es la octava.
const PST: Record<string, number[]> = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5,
    10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20,
    -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10,
    0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10,
    5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0,
    -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10,
    -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0,
    0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0,
    5, 5, 0, 0, 0
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0,
    0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40,
    -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30,
    -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0,
    10, 30, 20
  ]
};

const ROLE: Record<Role, string> = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };

/** Evaluación estática en centipeones, desde el punto de vista de las blancas. */
export function evaluate(pos: Position): number {
  let score = 0;
  for (const [sq, piece] of pos.board) {
    const role = ROLE[piece.role];
    // Casillas de chessops: 0 = a1 … 63 = h8. Las tablas empiezan por la octava.
    const rank = squareRank(sq);
    const i = (piece.color === 'white' ? 7 - rank : rank) * 8 + squareFile(sq);
    const v = VALUE[role] + PST[role][i];
    score += piece.color === 'white' ? v : -v;
  }
  return score;
}

// ─── Búsqueda ────────────────────────────────────────────────────────

const MATE = 100_000;

class Timeout extends Error {}

interface Candidate {
  move: NormalMove;
  /** Para ordenar: capturas valiosas con atacantes baratos y coronaciones primero. */
  order: number;
  capture: boolean;
}

/** Jugadas legales; las coronaciones, solo a dama y a caballo. */
function legalMoves(pos: Position, capturesOnly = false): Candidate[] {
  const out: Candidate[] = [];
  const ctx = pos.ctx();
  for (const [from, dests] of pos.allDests(ctx)) {
    const piece = pos.board.get(from)!;
    for (const to of dests) {
      const target = pos.board.get(to);
      // En chessops el enroque es «rey captura su torre»: no es una captura.
      const castle = piece.role === 'king' && target?.color === piece.color;
      const ep = piece.role === 'pawn' && to === pos.epSquare && squareFile(from) !== squareFile(to);
      const capture = (!!target && !castle) || ep;
      const promo = piece.role === 'pawn' && (squareRank(to) === 7 || squareRank(to) === 0);
      if (capturesOnly && !capture && !promo) continue;
      const victim = capture ? VALUE[target ? ROLE[target.role] : 'p'] : 0;
      const base = capture ? 10 * victim - VALUE[ROLE[piece.role]] : 0;
      if (promo) {
        for (const p of ['queen', 'knight'] as const) {
          out.push({ move: { from, to, promotion: p }, order: base + VALUE[ROLE[p]], capture });
        }
      } else {
        out.push({ move: { from, to }, order: base, capture });
      }
    }
  }
  return out.sort((a, b) => b.order - a.order);
}

/** UCI estándar (e1g1 para el enroque, no e1h1 como usa chessops). */
function toUci(pos: Position, move: NormalMove): string {
  const piece = pos.board.get(move.from);
  const target = pos.board.get(move.to);
  if (piece?.role === 'king' && target?.role === 'rook' && target.color === piece.color) {
    const to = move.to > move.from ? move.from + 2 : move.from - 2;
    return makeUci({ from: move.from, to });
  }
  return makeUci(move);
}

interface SearchOptions {
  level?: BotLevel;
  /** Fuente de aleatoriedad (inyectable en las pruebas). */
  random?: () => number;
  /** Reloj en ms (inyectable en las pruebas). */
  now?: () => number;
  /** Tiempo máximo de búsqueda; por defecto, el del nivel. */
  budget?: number;
}

/** Posición tras las jugadas (UCI estándar) desde la posición inicial. */
export function positionAfter(moves: string[]): Chess {
  const pos = Chess.default();
  for (const uci of moves) pos.play(normalizeMove(pos, parseUci(uci)!));
  return pos;
}

/**
 * Mejor jugada para el bando que mueve, en UCI. Busca por profundización
 * iterativa hasta la profundidad del nivel o hasta agotar el tiempo.
 */
export function bestMove(moves: string[], opts: SearchOptions = {}): string | null {
  const cfg = LEVELS[opts.level ?? 2];
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budget ?? cfg.budget);

  const rootPos = positionAfter(moves);
  const root = legalMoves(rootPos);
  if (!root.length) return null;
  if (random() < cfg.blunder) return toUci(rootPos, root[Math.floor(random() * root.length)].move);

  let nodes = 0;
  const side = (pos: Position) => (pos.turn === 'white' ? 1 : -1);
  const child = (pos: Position, move: NormalMove) => {
    const next = pos.clone();
    next.play(move);
    return next;
  };

  const qsearch = (pos: Position, alpha: number, beta: number, depth: number): number => {
    if (++nodes % 512 === 0 && now() > deadline) throw new Timeout();
    const stand = side(pos) * evaluate(pos);
    if (stand >= beta || depth === 0) return stand;
    if (stand > alpha) alpha = stand;
    for (const { move } of legalMoves(pos, true)) {
      const score = -qsearch(child(pos, move), -beta, -alpha, depth - 1);
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  };

  const search = (pos: Position, depth: number, alpha: number, beta: number, ply: number): number => {
    if (++nodes % 512 === 0 && now() > deadline) throw new Timeout();
    const list = legalMoves(pos);
    if (!list.length) return pos.isCheck() ? -MATE + ply : 0;
    if (pos.halfmoves >= 100 || pos.isInsufficientMaterial()) return 0;
    if (depth === 0) return cfg.quiescence ? qsearch(pos, alpha, beta, 4) : side(pos) * evaluate(pos);
    let best = -Infinity;
    for (const { move } of list) {
      const score = -search(child(pos, move), depth - 1, -beta, -alpha, ply + 1);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  };

  // Cada iteración completa ordena las jugadas de la raíz para la siguiente.
  let scored = root.map((c) => ({ move: c.move, score: 0 }));
  for (let depth = 1; depth <= cfg.depth; depth++) {
    try {
      const next = scored.map(({ move }) => ({
        move,
        score: -search(child(rootPos, move), depth - 1, -MATE - 1, MATE + 1, 1)
      }));
      scored = next.sort((a, b) => b.score - a.score);
      if (scored[0].score >= MATE - 100) break; // mate encontrado
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
      break; // quedarse con la última iteración completa
    }
  }

  // Ruido para variar las partidas, sin tocar los mates.
  const pick = scored
    .map(({ move, score }) => ({
      move,
      score: Math.abs(score) >= MATE - 100 ? score : score + (random() - 0.5) * cfg.noise
    }))
    .sort((a, b) => b.score - a.score)[0];
  return toUci(rootPos, pick.move);
}

// ─── Política del jugador automático ─────────────────────────────────

/** Qué hace la máquina ante un estado: mensajes inmediatos y si le toca pensar una jugada. */
export interface BotPlan {
  send: ClientGameMsg[];
  think: boolean;
}

/**
 * Decisiones que no requieren buscar: sentarse, responder a una oferta de
 * tablas, abandonar una posición perdida y aceptar la revancha.
 */
export function planBot(view: GameView, me: Color | null): BotPlan {
  if (view.status === 'waiting') return { send: me ? [] : [{ t: 'join' }], think: false };
  if (!me) return { send: [], think: false };
  const rival = opposite(me);

  if (isOver(view.status)) {
    const accept = view.status !== 'aborted' && view.rematch.includes(rival) && !view.rematch.includes(me);
    return { send: accept ? [{ t: 'rematch', offer: true }] : [], think: false };
  }
  if (view.status !== 'started') return { send: [], think: false };

  const pos = Chess.fromSetup(parseFen(view.fen).unwrap()).unwrap();
  const myScore = (me === 'white' ? 1 : -1) * evaluate(pos);
  const send: ClientGameMsg[] = [];
  if (view.drawOffer === rival) {
    // Acepta tablas si no va ganando; si va ganando, las rechaza.
    send.push({ t: 'draw', offer: myScore <= 50 });
    if (myScore <= 50) return { send, think: false };
  }
  // Con una dama o más de desventaja y la partida avanzada, abandona.
  if (view.turn === me && myScore <= -800 && view.moves.length >= 30) {
    return { send: [...send, { t: 'resign' }], think: false };
  }
  return { send, think: view.turn === me };
}
