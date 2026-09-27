import { error } from '@sveltejs/kit';
import { GAME_ID_RE } from '@jaque/shared';

export function load({ params }) {
  if (!GAME_ID_RE.test(params.id)) error(404, 'Página no encontrada');
}
