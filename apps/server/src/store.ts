import { randomBytes } from 'node:crypto';
import { isOver, type Color, type TimeControl } from '@jaque/shared';
import { Game } from './game.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(len = 8) {
  const bytes = randomBytes(len);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

/** Mensaje al rechazar una partida nueva porque se alcanzó el tope. */
export const FULL_MSG = 'Servidor lleno, inténtalo en un momento';

export interface StoreLimits {
  /** Límite de seguridad para no agotar memoria si alguien abusa de la API. */
  maxGames: number;
  /** Partidas terminadas se conservan un rato para verlas y pedir revancha. */
  keepFinishedMs: number;
  /** Desafíos que nadie acepta. */
  keepWaitingMs: number;
}

export const DEFAULT_LIMITS: StoreLimits = {
  maxGames: 50_000,
  keepFinishedMs: 60 * 60_000,
  keepWaitingMs: 3 * 60 * 60_000
};

/**
 * Partidas en memoria. Para un solo servidor es suficiente y muy rápido;
 * el siguiente paso es guardar las terminadas en PostgreSQL.
 */
export class GameStore {
  private games = new Map<string, Game>();
  readonly limits: StoreLimits;
  onChange: (game: Game) => void = () => {};
  onRedirect: (from: Game, to: Game) => void = () => {};
  onFinished: (game: Game) => void = () => {};
  /** Partidas terminadas (no anuladas) desde que arrancó el servidor. */
  played = 0;

  constructor(limits: Partial<StoreLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get size() {
    return this.games.size;
  }

  get playing() {
    let n = 0;
    for (const g of this.games.values()) if (g.status === 'started') n++;
    return n;
  }

  get(id: string) {
    return this.games.get(id);
  }

  create(tc: TimeControl): Game | null {
    if (this.games.size >= this.limits.maxGames) this.sweep();
    if (this.games.size >= this.limits.maxGames) return null;
    let id = randomId();
    while (this.games.has(id)) id = randomId();
    const game = new Game(id, tc);
    let counted = false;
    game.onChange = () => {
      if (!counted && isOver(game.status) && game.status !== 'aborted') {
        counted = true;
        this.played++;
        this.onFinished(game);
      }
      this.onChange(game);
    };
    this.games.set(id, game);
    return game;
  }

  /** Crea una partida con los dos jugadores ya sentados; empieza al instante. */
  pair(tc: TimeControl, white: string, black: string) {
    const game = this.create(tc);
    if (!game) return null;
    game.join(white, 'white');
    game.join(black, 'black');
    return game;
  }

  /**
   * Gestiona una oferta de revancha. Devuelve false si ya no hay sitio para otra
   * partida; en ese caso se retiran las dos ofertas para que puedan reintentarlo.
   */
  rematch(game: Game, by: Color, offer: boolean): boolean {
    if (!game.offerRematch(by, offer)) return true;
    const { white, black } = game.rematchSeats();
    const next = this.pair(game.tc, white, black);
    if (!next) {
      game.offerRematch('white', false);
      game.offerRematch('black', false);
      return false;
    }
    game.next = next.id;
    this.onRedirect(game, next);
    return true;
  }

  sweep(now = Date.now()) {
    for (const [id, g] of this.games) {
      const idle = now - g.lastActivity;
      const online = g.online.white + g.online.black;
      const stale =
        (isOver(g.status) && now - (g.endedAt ?? now) > this.limits.keepFinishedMs && online === 0) ||
        (g.status === 'waiting' && idle > this.limits.keepWaitingMs);
      if (stale) {
        g.dispose();
        this.games.delete(id);
      }
    }
  }
}
