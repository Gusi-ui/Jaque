import { PLAYER_ID_RE } from '@jaque/shared';

const KEY = 'jaque:player';

/** Identificador anónimo y persistente del jugador, como la cookie de sesión de lichess. */
export function playerId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(KEY);
  } catch {
    /* modo privado o almacenamiento bloqueado */
  }
  if (id && PLAYER_ID_RE.test(id)) return id;
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* sin persistencia: el id dura lo que la pestaña */
  }
  return id;
}
