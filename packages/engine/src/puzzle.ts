import { Chess, type Square } from 'chess.js';
import type { Color } from '@jaque/shared';

/** Un problema tal y como se guarda en puzzles.json: id, posición, solución en UCI y Elo. */
export type PuzzleEntry = [id: string, fen: string, moves: string, rating: number];

/** puzzles.json: un grupo de problemas por día de la semana, empezando en lunes. */
export interface PuzzleData {
  v: 1;
  days: PuzzleEntry[][];
}

/** Qué entra en cada grupo (0 = lunes): tipo de mate y Elo en [min, max). */
export const GROUPS = [
  { goal: 1, min: 600, max: 1000 },
  { goal: 1, min: 1000, max: 1400 },
  { goal: 2, min: 1000, max: 1300 },
  { goal: 2, min: 1300, max: 1600 },
  { goal: 2, min: 1600, max: 1900 },
  { goal: 3, min: 1400, max: 1800 },
  { goal: 3, min: 1800, max: 2200 }
] as const;

/** Problemas por grupo: un año sin repetir. */
export const GROUP_SIZE = 53;

export interface DailyPuzzle {
  /** Día en Madrid, 'YYYY-MM-DD'. */
  key: string;
  id: string;
  fen: string;
  /** Jugadas en UCI, alternando quien resuelve y el rival; la última da mate. */
  solution: string[];
  /** Mate en `goal`. */
  goal: number;
}

const madrid = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** Fecha en Madrid: el problema cambia a medianoche en España. */
export function dayKey(now: Date): string {
  const p = Object.fromEntries(madrid.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Lunes de referencia para contar semanas. */
const EPOCH = Date.UTC(2026, 0, 5);
const DAY_MS = 86_400_000;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function puzzleOfDay(now: Date, data: PuzzleData): DailyPuzzle {
  const key = dayKey(now);
  const days = Math.round((Date.parse(`${key}T00:00:00Z`) - EPOCH) / DAY_MS);
  const group = data.days[mod(days, 7)];
  const [id, fen, moves] = group[mod(Math.floor(days / 7), group.length)];
  const solution = moves.split(' ');
  return { key, id, fen, solution, goal: Math.ceil(solution.length / 2) };
}

/** Acierto: `{ reply }` es la contestación del rival, que se aplica con `step()`. */
export type PlayResult = 'wrong' | 'solved' | { reply: string };

/** Un intento de resolver un problema. */
export class PuzzleRun {
  private readonly chess: Chess;
  private ply = 0;
  /** Bando de quien resuelve. */
  readonly side: Color;

  constructor(readonly puzzle: DailyPuzzle) {
    this.chess = new Chess(puzzle.fen);
    this.side = this.turn;
  }

  get fen() {
    return this.chess.fen();
  }
  get turn(): Color {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }
  get check() {
    return this.chess.inCheck();
  }
  get solved() {
    return this.chess.isCheckmate();
  }
  get lastMove(): [string, string] | undefined {
    const m = this.chess.history({ verbose: true }).at(-1);
    return m && [m.from, m.to];
  }

  dests(): Map<string, string[]> {
    const dests = new Map<string, string[]>();
    for (const m of this.chess.moves({ verbose: true })) {
      const list = dests.get(m.from) ?? [];
      // Las cuatro coronaciones van a la misma casilla.
      if (!list.includes(m.to)) list.push(m.to);
      dests.set(m.from, list);
    }
    return dests;
  }

  /** UCI de una jugada del tablero: corona como pide la solución o, si no, a dama. */
  uci(orig: string, dest: string): string {
    const expected = this.puzzle.solution[this.ply];
    if (expected?.startsWith(orig + dest)) return expected;
    return this.isPromotion(orig, dest) ? `${orig}${dest}q` : orig + dest;
  }

  /** Si la jugada lleva un peón a la última fila: hay que elegir pieza. */
  isPromotion(orig: string, dest: string): boolean {
    return this.chess.get(orig as Square)?.type === 'p' && (dest[1] === '8' || dest[1] === '1');
  }

  play(uci: string): PlayResult {
    if (this.solved || this.turn !== this.side) return 'wrong';
    try {
      this.move(uci);
    } catch {
      return 'wrong';
    }
    if (this.chess.isCheckmate()) {
      this.ply = this.puzzle.solution.length;
      return 'solved';
    }
    if (uci !== this.puzzle.solution[this.ply]) {
      this.chess.undo();
      return 'wrong';
    }
    this.ply++;
    const reply = this.puzzle.solution[this.ply];
    return reply ? { reply } : 'solved';
  }

  /** Juega la siguiente jugada de la solución, de quien resuelve o del rival. */
  step(): string | undefined {
    const uci = this.puzzle.solution[this.ply];
    if (!uci) return undefined;
    this.move(uci);
    this.ply++;
    return uci;
  }

  /** Casilla de la pieza que hay que mover. */
  hint(): string | undefined {
    return this.solved ? undefined : this.puzzle.solution[this.ply]?.slice(0, 2);
  }

  private move(uci: string) {
    this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  }
}
