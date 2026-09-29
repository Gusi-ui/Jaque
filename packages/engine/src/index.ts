import { Chess, type Square } from 'chess.js';
import {
  opposite,
  isOver,
  type Color,
  type GameStatus,
  type GameView,
  type TimeControl
} from '@jaque/shared';

/** Tiempo que tiene cada jugador para hacer su primera jugada antes de anular la partida. */
export const FIRST_MOVE_MS = 30_000;

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Aproximación de lichess: rey solo, o rey + una pieza menor, no pueden dar mate. */
export function canMate(chess: Chess, color: Color) {
  const c = color === 'white' ? 'w' : 'b';
  const pieces = chess
    .board()
    .flat()
    .filter((p) => p && p.color === c && p.type !== 'k')
    .map((p) => p!.type);
  if (pieces.length === 0) return false;
  if (pieces.length === 1 && (pieces[0] === 'n' || pieces[0] === 'b')) return false;
  return true;
}

/** Estado serializable de una partida (ver `Game.toJSON` / `Game.fromJSON`). */
export interface GameData {
  v: 1;
  id: string;
  tc: TimeControl;
  createdAt: number;
  moves: string[];
  seats: Partial<Record<Color, string>>;
  status: GameStatus;
  winner: Color | null;
  drawOffer: Color | null;
  /** Opcionales: las partidas guardadas antes de poder deshacer no los tienen. */
  takeback?: Color | null;
  noTakebackAt?: number | null;
  rematch: Color[];
  next: string | null;
  clock: Record<Color, number>;
  turnStart: number;
  lastActivity: number;
  endedAt: number | null;
}

/**
 * Una partida. Es la única fuente de verdad: valida jugadas con chess.js
 * y lleva los relojes. No tiene temporizadores ni sabe nada de WebSockets:
 * todo lo que depende del tiempo recibe `now`, y quien la aloja debe llamar a
 * `tick(now)` en el instante que indica `nextDeadline()`.
 * Avisa de los cambios con `onChange`.
 */
export class Game {
  readonly chess = new Chess();
  readonly initialFen = this.chess.fen();
  readonly moves: string[] = [];
  readonly sans: string[] = [];
  readonly seats: Partial<Record<Color, string>> = {};
  readonly rematch = new Set<Color>();

  status: GameStatus = 'waiting';
  winner: Color | null = null;
  drawOffer: Color | null = null;
  /** Quién ha pedido deshacer su última jugada. */
  takebackOffer: Color | null = null;
  /** Jugadas cuando se rechazó la última petición: hasta la siguiente no se puede pedir otra. */
  private noTakebackAt: number | null = null;
  /** Id de la revancha, cuando la hay. */
  next: string | null = null;

  /** Ms restantes de cada jugador al comienzo de su turno actual. */
  protected clock: Record<Color, number>;
  /** Momento en que empezó el turno actual. */
  protected turnStart = 0;

  lastActivity: number;
  endedAt: number | null = null;

  onChange: (game: Game) => void = () => {};

  constructor(
    readonly id: string,
    readonly tc: TimeControl,
    readonly createdAt: number
  ) {
    this.clock = { white: tc.initial * 1000, black: tc.initial * 1000 };
    this.lastActivity = createdAt;
  }

  get ply() {
    return this.moves.length;
  }

  get turn(): Color {
    return this.chess.turn() === 'w' ? 'white' : 'black';
  }

  /** Como en lichess, los relojes arrancan cuando ambos han hecho su primera jugada. */
  get clockRunning() {
    return this.status === 'started' && this.ply >= 2;
  }

  colorOf(player: string): Color | null {
    if (this.seats.white === player) return 'white';
    if (this.seats.black === player) return 'black';
    return null;
  }

  remaining(c: Color, now: number) {
    return this.clockRunning && this.turn === c
      ? Math.max(0, this.clock[c] - (now - this.turnStart))
      : this.clock[c];
  }

  // ─── Acciones ──────────────────────────────────────────────────────

  /** Ocupa un asiento libre. Si con esto hay dos jugadores, la partida empieza. */
  join(player: string, prefer: Color | undefined, now: number): Color | null {
    const seated = this.colorOf(player);
    if (seated || this.status !== 'waiting') return seated;
    const free: Color[] = (['white', 'black'] as const).filter((c) => !this.seats[c]);
    if (!free.length) return null;
    const color = prefer && free.includes(prefer) ? prefer : free[0];
    this.seats[color] = player;
    if (this.seats.white && this.seats.black) {
      this.status = 'started';
      this.turnStart = now;
    }
    this.changed(now);
    return color;
  }

  /** Aplica una jugada. Devuelve un mensaje de error, o null si fue válida. */
  move(color: Color, uci: string, ply: number | undefined, now: number): string | null {
    if (this.status !== 'started') return 'La partida no está en curso';
    if (color !== this.turn) return 'No es tu turno';
    if (ply !== undefined && ply !== this.ply) return 'Jugada desfasada';
    if (!UCI_RE.test(uci)) return 'Formato de jugada no válido';

    let left: number | null = null;
    if (this.clockRunning) {
      left = this.clock[color] - (now - this.turnStart);
      if (left <= 0) {
        this.flag(color, now);
        return 'Tiempo agotado';
      }
    }

    let san: string;
    try {
      san = this.chess.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: uci[4]
      }).san;
    } catch {
      return 'Jugada ilegal';
    }

    if (left !== null) this.clock[color] = left + this.tc.increment * 1000;
    this.moves.push(uci);
    this.sans.push(san);
    this.turnStart = now;
    // Una oferta de tablas caduca cuando el rival juega en lugar de aceptarla.
    if (this.drawOffer && this.drawOffer !== color) this.drawOffer = null;
    // Y la petición de deshacer, en cuanto alguien mueve.
    this.takebackOffer = null;

    if (this.chess.isCheckmate()) return this.end('mate', color, now), null;
    if (this.chess.isStalemate()) return this.end('stalemate', null, now), null;
    if (this.chess.isInsufficientMaterial()) return this.end('insufficient', null, now), null;
    if (this.chess.isThreefoldRepetition()) return this.end('repetition', null, now), null;
    if (this.chess.isDrawByFiftyMoves()) return this.end('fiftyMoves', null, now), null;

    this.changed(now);
    return null;
  }

  resign(color: Color, now: number) {
    if (this.status !== 'started') return;
    this.end('resign', opposite(color), now);
  }

  /** Se puede anular mientras quien la anula no haya movido todavía. */
  canAbort(color: Color) {
    if (this.status === 'waiting') return true;
    if (this.status !== 'started') return false;
    return color === 'white' ? this.ply === 0 : this.ply <= 1;
  }

  abort(color: Color, now: number) {
    if (this.canAbort(color)) this.end('aborted', null, now);
  }

  draw(color: Color, offer: boolean, now: number) {
    if (this.status !== 'started') return;
    if (!offer) {
      // Retirar la propia oferta o rechazar la del rival.
      if (this.drawOffer) {
        this.drawOffer = null;
        this.changed(now);
      }
      return;
    }
    if (this.drawOffer === opposite(color)) return this.end('draw', null, now);
    if (this.ply < 2) return; // no tiene sentido antes de empezar
    this.drawOffer = color;
    this.changed(now);
  }

  /** Partida en curso, quien pide ya ha movido y no la acaban de rechazar. */
  canTakeback(color: Color) {
    return (
      this.status === 'started' &&
      this.ply >= (color === 'white' ? 1 : 2) &&
      this.ply !== this.noTakebackAt
    );
  }

  /** Pedir (o aceptar) deshacer la última jugada propia; `offer: false` retira o rechaza. */
  takeback(color: Color, offer: boolean, now: number) {
    if (this.status !== 'started') return;
    if (!offer) {
      if (!this.takebackOffer) return;
      // Rechazar la del rival impide pedirla otra vez hasta la siguiente jugada.
      if (this.takebackOffer !== color) this.noTakebackAt = this.ply;
      this.takebackOffer = null;
      this.changed(now);
      return;
    }
    if (this.takebackOffer === opposite(color)) return this.undo(opposite(color), now);
    if (this.takebackOffer || !this.canTakeback(color)) return;
    this.takebackOffer = color;
    this.changed(now);
  }

  /** Devuelve true cuando ambos jugadores han pedido la revancha. */
  offerRematch(color: Color, offer: boolean, now: number): boolean {
    if (!isOver(this.status) || this.next) return false;
    if (offer) this.rematch.add(color);
    else this.rematch.delete(color);
    if (this.rematch.size === 2) return true;
    this.changed(now);
    return false;
  }

  /** Jugadores de la revancha: con los colores cambiados. */
  rematchSeats(): { white: string; black: string } {
    return { white: this.seats.black!, black: this.seats.white! };
  }

  // ─── Tiempo ────────────────────────────────────────────────────────

  /**
   * Instante en que hay que volver a mirar la partida: caída de bandera del
   * jugador con el turno, o fin del plazo para su primera jugada. null si no hay nada pendiente.
   */
  nextDeadline(): number | null {
    if (this.status !== 'started') return null;
    if (this.ply < 2) return this.turnStart + FIRST_MOVE_MS;
    return this.turnStart + this.clock[this.turn];
  }

  /** Aplica la comprobación de `nextDeadline()`. Devuelve true si la partida cambió. */
  tick(now: number): boolean {
    if (this.status !== 'started') return false;
    if (this.ply < 2) {
      if (now < this.turnStart + FIRST_MOVE_MS) return false;
      this.end('aborted', null, now);
      return true;
    }
    if (this.remaining(this.turn, now) > 0) return false;
    this.flag(this.turn, now);
    return true;
  }

  // ─── Interno ───────────────────────────────────────────────────────

  /** Deshace hasta que vuelva a ser el turno de quien lo pidió. No devuelve tiempo. */
  private undo(requester: Color, now: number) {
    if (this.clockRunning) this.clock[this.turn] = this.remaining(this.turn, now);
    const n = this.turn === requester ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.chess.undo();
      this.moves.pop();
      this.sans.pop();
    }
    this.turnStart = now;
    this.takebackOffer = null;
    this.drawOffer = null;
    this.changed(now);
  }

  private flag(color: Color, now: number) {
    this.clock[color] = 0;
    const other = opposite(color);
    // Si al rival solo le queda material que no puede dar mate, son tablas.
    this.end('timeout', canMate(this.chess, other) ? other : null, now);
  }

  private end(status: GameStatus, winner: Color | null, now: number) {
    if (this.clockRunning) {
      const c = this.turn;
      // Congelar el reloj que corría.
      if (status !== 'timeout') this.clock[c] = this.remaining(c, now);
    }
    this.status = status;
    this.winner = winner;
    this.drawOffer = null;
    this.takebackOffer = null;
    this.endedAt = now;
    this.changed(now);
  }

  protected changed(now: number) {
    this.lastActivity = now;
    this.onChange(this);
  }

  // ─── Vista y serialización ─────────────────────────────────────────

  view(now: number, online: Record<Color, boolean> = { white: false, black: false }): GameView {
    return {
      id: this.id,
      tc: this.tc,
      status: this.status,
      winner: this.winner,
      initialFen: this.initialFen,
      fen: this.chess.fen(),
      moves: this.moves,
      sans: this.sans,
      turn: this.turn,
      clock: {
        white: this.remaining('white', now),
        black: this.remaining('black', now),
        running: this.clockRunning ? this.turn : null
      },
      seats: {
        white: { taken: !!this.seats.white, online: online.white },
        black: { taken: !!this.seats.black, online: online.black }
      },
      drawOffer: this.drawOffer,
      takeback: this.takebackOffer,
      rematch: [...this.rematch],
      firstMoveDeadline:
        this.status === 'started' && this.ply < 2
          ? Math.max(0, this.turnStart + FIRST_MOVE_MS - now)
          : null
    };
  }

  toJSON(): GameData {
    return {
      v: 1,
      id: this.id,
      tc: this.tc,
      createdAt: this.createdAt,
      moves: [...this.moves],
      seats: { ...this.seats },
      status: this.status,
      winner: this.winner,
      drawOffer: this.drawOffer,
      takeback: this.takebackOffer,
      noTakebackAt: this.noTakebackAt,
      rematch: [...this.rematch],
      next: this.next,
      clock: { ...this.clock },
      turnStart: this.turnStart,
      lastActivity: this.lastActivity,
      endedAt: this.endedAt
    };
  }

  /**
   * Reconstruye una partida. chess.js se rehace reproduciendo las jugadas,
   * porque la triple repetición necesita el historial de posiciones.
   */
  static fromJSON(data: GameData): Game {
    const g = new Game(data.id, data.tc, data.createdAt);
    g.load(data);
    return g;
  }

  /** Carga el estado en una instancia recién creada (útil para subclases). */
  protected load(data: GameData) {
    for (const uci of data.moves) {
      const san = this.chess.move({
        from: uci.slice(0, 2) as Square,
        to: uci.slice(2, 4) as Square,
        promotion: uci[4]
      }).san;
      this.moves.push(uci);
      this.sans.push(san);
    }
    Object.assign(this.seats, data.seats);
    for (const c of data.rematch) this.rematch.add(c);
    this.status = data.status;
    this.winner = data.winner;
    this.drawOffer = data.drawOffer;
    this.takebackOffer = data.takeback ?? null;
    this.noTakebackAt = data.noTakebackAt ?? null;
    this.next = data.next;
    this.clock = { ...data.clock };
    this.turnStart = data.turnStart;
    this.lastActivity = data.lastActivity;
    this.endedAt = data.endedAt;
  }
}
