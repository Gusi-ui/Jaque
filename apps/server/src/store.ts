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

/** Límite de seguridad para no agotar memoria si alguien abusa de la API. */
const MAX_GAMES = 50_000;
/** Partidas terminadas se conservan un rato para verlas y pedir revancha. */
const KEEP_FINISHED_MS = 60 * 60_000;
/** Desafíos que nadie acepta. */
const KEEP_WAITING_MS = 3 * 60 * 60_000;

/**
 * Partidas en memoria. Para un solo servidor es suficiente y muy rápido;
 * el siguiente paso es guardar las terminadas en PostgreSQL.
 */
export class GameStore {
  private games = new Map<string, Game>();
  onChange: (game: Game) => void = () => {};
  onRedirect: (from: Game, to: Game) => void = () => {};
  onFinished: (game: Game) => void = () => {};
  /** Partidas terminadas (no anuladas) desde que arrancó el servidor. */
  played = 0;

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
    if (this.games.size >= MAX_GAMES) this.sweep();
    if (this.games.size >= MAX_GAMES) return null;
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

  rematch(game: Game, by: Color, offer: boolean) {
    if (!game.offerRematch(by, offer)) return;
    const { white, black } = game.rematchSeats();
    const next = this.pair(game.tc, white, black);
    if (!next) return;
    game.next = next.id;
    this.onRedirect(game, next);
  }

  sweep(now = Date.now()) {
    for (const [id, g] of this.games) {
      const idle = now - g.lastActivity;
      const online = g.online.white + g.online.black;
      const stale =
        (isOver(g.status) && now - (g.endedAt ?? now) > KEEP_FINISHED_MS && online === 0) ||
        (g.status === 'waiting' && idle > KEEP_WAITING_MS);
      if (stale) {
        g.dispose();
        this.games.delete(id);
      }
    }
  }
}
