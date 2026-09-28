import { PLAYER_ID_RE } from '@jaque/shared';
import type { BotLevel } from '@jaque/engine/levels';

/**
 * La máquina se conecta a la partida como un jugador más, con su propio id y
 * su propio WebSocket. El servidor no sabe que es un bot: la partida sigue el
 * flujo real (relojes, tablas, abandono, revancha, historial).
 */
export interface BotConfig {
  player: string;
  level: BotLevel;
}

const key = (gameId: string) => `jaque:bot:${gameId}`;

/** Máquina asociada a una partida en esta pestaña, si la hay. */
export function botFor(gameId: string): BotConfig | null {
  try {
    const cfg = JSON.parse(sessionStorage.getItem(key(gameId)) ?? 'null') as BotConfig | null;
    if (cfg && PLAYER_ID_RE.test(cfg.player) && [1, 2, 3].includes(cfg.level)) return cfg;
  } catch {
    /* almacenamiento bloqueado o dato corrupto */
  }
  return null;
}

export function saveBot(gameId: string, cfg: BotConfig) {
  try {
    sessionStorage.setItem(key(gameId), JSON.stringify(cfg));
  } catch {
    /* sin almacenamiento: la máquina no sobrevivirá a una recarga */
  }
}

export function newBot(level: BotLevel): BotConfig {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const rand = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  return { player: `bot-${rand}`, level };
}

const LEVEL_KEY = 'jaque:bot-level';

/** Último nivel elegido en el diálogo; fácil si no hay ninguno. */
export function lastLevel(): BotLevel {
  try {
    const l = Number(localStorage.getItem(LEVEL_KEY));
    if (l === 1 || l === 2 || l === 3) return l;
  } catch {
    /* almacenamiento bloqueado */
  }
  return 1;
}

export function saveLastLevel(level: BotLevel) {
  try {
    localStorage.setItem(LEVEL_KEY, String(level));
  } catch {
    /* sin almacenamiento: se usará el nivel fácil */
  }
}
