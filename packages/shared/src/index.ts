// Tipos y constantes compartidos entre cliente y servidor.

export type Color = 'white' | 'black';

export const opposite = (c: Color): Color => (c === 'white' ? 'black' : 'white');

/** Control de tiempo: minutos iniciales + incremento en segundos. */
export interface TimeControl {
  /** Tiempo inicial en segundos. */
  initial: number;
  /** Incremento por jugada en segundos. */
  increment: number;
}

export type Speed = 'bullet' | 'blitz' | 'rapid' | 'classical';

export interface TimeControlPreset extends TimeControl {
  id: string;
  speed: Speed;
}

export const SPEED_LABEL: Record<Speed, string> = {
  bullet: 'Bullet',
  blitz: 'Blitz',
  rapid: 'Rápida',
  classical: 'Clásica'
};

/** Misma fórmula que lichess: tiempo estimado = inicial + 40 × incremento. */
export function speedOf(tc: TimeControl): Speed {
  const t = tc.initial + 40 * tc.increment;
  if (t < 180) return 'bullet';
  if (t < 480) return 'blitz';
  if (t < 1500) return 'rapid';
  return 'classical';
}

const preset = (min: number, inc: number): TimeControlPreset => {
  const tc = { initial: min * 60, increment: inc };
  return { id: `${min}+${inc}`, ...tc, speed: speedOf(tc) };
};

/** Parrilla de emparejamiento rápido (como la portada de lichess). */
export const PRESETS: TimeControlPreset[] = [
  preset(1, 0),
  preset(2, 1),
  preset(3, 0),
  preset(3, 2),
  preset(5, 0),
  preset(5, 3),
  preset(10, 0),
  preset(10, 5),
  preset(15, 10)
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id);

export const tcLabel = (tc: TimeControl) => {
  const m = tc.initial / 60;
  const min = Number.isInteger(m) ? String(m) : m === 0.5 ? '½' : m.toFixed(1);
  return `${min}+${tc.increment}`;
};

/** Estados de una partida. Todos menos 'waiting' y 'started' son finales. */
export type GameStatus =
  | 'waiting' // falta el segundo jugador
  | 'started'
  | 'aborted'
  | 'mate'
  | 'resign'
  | 'stalemate'
  | 'timeout'
  | 'draw' // tablas de mutuo acuerdo
  | 'repetition'
  | 'insufficient'
  | 'fiftyMoves';

export const isOver = (s: GameStatus) => s !== 'waiting' && s !== 'started';

export interface ClockView {
  /** Milisegundos restantes en el instante en que el servidor envió el mensaje. */
  white: number;
  black: number;
  /** Lado cuyo reloj está corriendo, o null. */
  running: Color | null;
}

export interface SeatView {
  taken: boolean;
  online: boolean;
}

export interface GameView {
  id: string;
  tc: TimeControl;
  status: GameStatus;
  winner: Color | null;
  /** FEN inicial (siempre la posición estándar por ahora). */
  initialFen: string;
  fen: string;
  /** Jugadas en UCI (e2e4, e7e8q). */
  moves: string[];
  /** Jugadas en SAN, en paralelo con `moves`. */
  sans: string[];
  turn: Color;
  clock: ClockView;
  seats: Record<Color, SeatView>;
  drawOffer: Color | null;
  rematch: Color[];
  /** Ms que le quedan al jugador con el turno para hacer su primera jugada. */
  firstMoveDeadline: number | null;
}

// ─── Mensajes WebSocket ──────────────────────────────────────────────

/**
 * Keepalive del cliente. Se envía y compara como texto exacto: en Cloudflare,
 * el Durable Object responde sin despertarse (`setWebSocketAutoResponse`).
 */
export const PING = '{"t":"ping"}';
export const PONG = '{"t":"pong"}';

export type ClientGameMsg =
  | { t: 'join' }
  | { t: 'move'; uci: string; ply: number }
  | { t: 'resign' }
  | { t: 'abort' }
  | { t: 'draw'; offer: boolean }
  | { t: 'rematch'; offer: boolean }
  | { t: 'ping' };

export type ServerGameMsg =
  | { t: 'hello'; you: Color | null }
  | { t: 'state'; game: GameView }
  | { t: 'redirect'; id: string }
  | { t: 'error'; msg: string }
  | { t: 'pong' };

export type ClientLobbyMsg = { t: 'seek'; tc: string } | { t: 'cancel' } | { t: 'ping' };

export type ServerLobbyMsg =
  | { t: 'stats'; players: number; games: number; seeks: Record<string, number> }
  | { t: 'seeking'; tc: string }
  | { t: 'start'; id: string }
  | { t: 'error'; msg: string }
  | { t: 'pong' };

export interface CreateGameBody {
  player: string;
  tc: TimeControl;
  color: Color | 'random';
}

/** Identificador anónimo del jugador (se guarda en localStorage). */
export const PLAYER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const GAME_ID_RE = /^[A-Za-z0-9]{8}$/;

/** Límites para controles personalizados. */
export const TC_LIMITS = { minInitial: 30, maxInitial: 180 * 60, maxIncrement: 180 };

export function validTc(tc: unknown): tc is TimeControl {
  if (!tc || typeof tc !== 'object') return false;
  const { initial, increment } = tc as TimeControl;
  return (
    Number.isInteger(initial) &&
    Number.isInteger(increment) &&
    initial >= TC_LIMITS.minInitial &&
    initial <= TC_LIMITS.maxInitial &&
    increment >= 0 &&
    increment <= TC_LIMITS.maxIncrement
  );
}

export const RESULT_TEXT: Record<Exclude<GameStatus, 'waiting' | 'started'>, string> = {
  aborted: 'Partida anulada',
  mate: 'Jaque mate',
  resign: 'Abandono',
  stalemate: 'Rey ahogado',
  timeout: 'Tiempo agotado',
  draw: 'Tablas de mutuo acuerdo',
  repetition: 'Tablas por triple repetición',
  insufficient: 'Tablas por material insuficiente',
  fiftyMoves: 'Tablas por la regla de las 50 jugadas'
};
