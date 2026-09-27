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

/**
 * Una partida. Es la única fuente de verdad: valida jugadas con chess.js
 * y lleva los relojes. No sabe nada de WebSockets; avisa de los cambios con `onChange`.
 */
export class Game {
  readonly chess = new Chess();
  readonly initialFen = this.chess.fen();
  readonly moves: string[] = [];
  readonly sans: string[] = [];
  readonly seats: Partial<Record<Color, string>> = {};
  readonly online: Record<Color, number> = { white: 0, black: 0 };
  readonly rematch = new Set<Color>();

  status: GameStatus = 'waiting';
  winner: Color | null = null;
  drawOffer: Color | null = null;
  /** Id de la revancha, cuando la hay. */
  next: string | null = null;

  /** Ms restantes de cada jugador al comienzo de su turno actual. */
  private clock: Record<Color, number>;
  /** Momento (Date.now) en que empezó el turno actual. */
  private turnStart = 0;
  private timer: NodeJS.Timeout | undefined;

  lastActivity = Date.now();
  endedAt: number | null = null;

  onChange: (game: Game) => void = () => {};

  constructor(
    readonly id: string,
    readonly tc: TimeControl
  ) {
    this.clock = { white: tc.initial * 1000, black: tc.initial * 1000 };
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

  remaining(c: Color, now = Date.now()) {
    return this.clockRunning && this.turn === c
      ? Math.max(0, this.clock[c] - (now - this.turnStart))
      : this.clock[c];
  }

  // ─── Acciones ──────────────────────────────────────────────────────

  /** Ocupa un asiento libre. Si con esto hay dos jugadores, la partida empieza. */
  join(player: string, prefer?: Color): Color | null {
    const seated = this.colorOf(player);
    if (seated || this.status !== 'waiting') return seated;
    const free: Color[] = (['white', 'black'] as const).filter((c) => !this.seats[c]);
    if (!free.length) return null;
    const color = prefer && free.includes(prefer) ? prefer : free[0];
    this.seats[color] = player;
    if (this.seats.white && this.seats.black) this.start();
    else this.changed();
    return color;
  }

  /** Aplica una jugada. Devuelve un mensaje de error, o null si fue válida. */
  move(color: Color, uci: string, ply?: number): string | null {
    if (this.status !== 'started') return 'La partida no está en curso';
    if (color !== this.turn) return 'No es tu turno';
    if (ply !== undefined && ply !== this.ply) return 'Jugada desfasada';
    if (!UCI_RE.test(uci)) return 'Formato de jugada no válido';

    const now = Date.now();
    if (this.clockRunning) {
      const left = this.clock[color] - (now - this.turnStart);
      if (left <= 0) {
        this.flag(color);
        return 'Tiempo agotado';
      }
      this.clock[color] = left + this.tc.increment * 1000;
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

    this.moves.push(uci);
    this.sans.push(san);
    this.turnStart = now;
    // Una oferta de tablas caduca cuando el rival juega en lugar de aceptarla.
    if (this.drawOffer && this.drawOffer !== color) this.drawOffer = null;

    if (this.chess.isCheckmate()) return this.end('mate', color), null;
    if (this.chess.isStalemate()) return this.end('stalemate', null), null;
    if (this.chess.isInsufficientMaterial()) return this.end('insufficient', null), null;
    if (this.chess.isThreefoldRepetition()) return this.end('repetition', null), null;
    if (this.chess.isDrawByFiftyMoves()) return this.end('fiftyMoves', null), null;

    this.schedule();
    this.changed();
    return null;
  }

  resign(color: Color) {
    if (this.status !== 'started') return;
    this.end('resign', opposite(color));
  }

  /** Se puede anular mientras quien la anula no haya movido todavía. */
  canAbort(color: Color) {
    if (this.status === 'waiting') return true;
    if (this.status !== 'started') return false;
    return color === 'white' ? this.ply === 0 : this.ply <= 1;
  }

  abort(color: Color) {
    if (this.canAbort(color)) this.end('aborted', null);
  }

  draw(color: Color, offer: boolean) {
    if (this.status !== 'started') return;
    if (!offer) {
      // Retirar la propia oferta o rechazar la del rival.
      if (this.drawOffer) {
        this.drawOffer = null;
        this.changed();
      }
      return;
    }
    if (this.drawOffer === opposite(color)) return this.end('draw', null);
    if (this.ply < 2) return; // no tiene sentido antes de empezar
    this.drawOffer = color;
    this.changed();
  }

  /** Devuelve true cuando ambos jugadores han pedido la revancha. */
  offerRematch(color: Color, offer: boolean): boolean {
    if (!isOver(this.status) || this.next) return false;
    if (offer) this.rematch.add(color);
    else this.rematch.delete(color);
    if (this.rematch.size === 2) return true;
    this.changed();
    return false;
  }

  setOnline(color: Color, delta: 1 | -1) {
    this.online[color] = Math.max(0, this.online[color] + delta);
    this.changed();
  }

  // ─── Interno ───────────────────────────────────────────────────────

  private start() {
    this.status = 'started';
    this.turnStart = Date.now();
    this.schedule();
    this.changed();
  }

  private flag(color: Color) {
    this.clock[color] = 0;
    const other = opposite(color);
    // Si al rival solo le queda material que no puede dar mate, son tablas.
    this.end('timeout', this.canMate(other) ? other : null);
  }

  /** Aproximación de lichess: rey solo, o rey + una pieza menor, no pueden dar mate. */
  private canMate(color: Color) {
    const c = color === 'white' ? 'w' : 'b';
    const pieces = this.chess
      .board()
      .flat()
      .filter((p) => p && p.color === c && p.type !== 'k')
      .map((p) => p!.type);
    if (pieces.length === 0) return false;
    if (pieces.length === 1 && (pieces[0] === 'n' || pieces[0] === 'b')) return false;
    return true;
  }

  private end(status: GameStatus, winner: Color | null) {
    if (this.clockRunning) {
      const c = this.turn;
      // Congelar el reloj que corría.
      if (status !== 'timeout') this.clock[c] = this.remaining(c);
    }
    this.status = status;
    this.winner = winner;
    this.drawOffer = null;
    this.endedAt = Date.now();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.changed();
  }

  /** Programa el único temporizador de la partida: caída de bandera o anulación. */
  private schedule() {
    clearTimeout(this.timer);
    if (this.status !== 'started') return;
    if (this.ply < 2) {
      const left = this.turnStart + FIRST_MOVE_MS - Date.now();
      this.timer = setTimeout(() => this.status === 'started' && this.end('aborted', null), left);
    } else {
      const c = this.turn;
      this.timer = setTimeout(() => {
        if (this.status !== 'started' || this.turn !== c) return;
        if (this.remaining(c) <= 0) this.flag(c);
        else this.schedule();
      }, this.remaining(c));
    }
    this.timer.unref?.();
  }

  private changed() {
    this.lastActivity = Date.now();
    this.onChange(this);
  }

  dispose() {
    clearTimeout(this.timer);
    this.onChange = () => {};
  }

  view(now = Date.now()): GameView {
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
        white: { taken: !!this.seats.white, online: this.online.white > 0 },
        black: { taken: !!this.seats.black, online: this.online.black > 0 }
      },
      drawOffer: this.drawOffer,
      rematch: [...this.rematch],
      firstMoveDeadline:
        this.status === 'started' && this.ply < 2
          ? Math.max(0, this.turnStart + FIRST_MOVE_MS - now)
          : null
    };
  }
}
