import {
  GAME_ID_RE,
  PLAYER_ID_RE,
  validTc,
  type Color,
  type CreateGameBody
} from '@jaque/shared';
import { isWebSocketUpgrade, json, randomId } from './util';

export { GameRoom } from './game-room';
export { Lobby } from './lobby';

/**
 * Mismo protocolo HTTP y WebSocket que apps/server. Solo llegan aquí /api/* y
 * /ws/* (assets.run_worker_first); el resto lo sirven los assets estáticos.
 * Ids y jugadores se validan antes de tocar ningún Durable Object.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const player = searchParams.get('player') ?? '';

    if (pathname === '/api/health') return json({ ok: true });

    if (pathname === '/api/games') {
      if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
      return createGame(request, env);
    }

    let m = pathname.match(/^\/api\/games\/([^/]+)$/);
    if (m && request.method === 'GET') {
      if (!GAME_ID_RE.test(m[1])) return json({ error: 'Partida no encontrada' }, 404);
      const view = await env.GAME_ROOM.getByName(m[1]).view();
      return view ? json(view) : json({ error: 'Partida no encontrada' }, 404);
    }

    m = pathname.match(/^\/ws\/game\/([^/]+)$/);
    if (m) {
      if (!isWebSocketUpgrade(request)) return new Response('Se esperaba WebSocket', { status: 426 });
      if (!GAME_ID_RE.test(m[1]) || !PLAYER_ID_RE.test(player)) {
        return new Response('No encontrado', { status: 404 });
      }
      return env.GAME_ROOM.getByName(m[1]).fetch(request);
    }

    if (pathname === '/ws/lobby') {
      if (!isWebSocketUpgrade(request)) return new Response('Se esperaba WebSocket', { status: 426 });
      if (!PLAYER_ID_RE.test(player)) return new Response('Jugador no válido', { status: 400 });
      return env.LOBBY.getByName('lobby').fetch(request);
    }

    if (pathname.startsWith('/api/') || pathname.startsWith('/ws/')) {
      return json({ error: 'No encontrado' }, 404);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;

async function createGame(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const { success } = await env.CREATE_LIMITER.limit({ key: ip });
  if (!success) return json({ error: 'Demasiadas partidas, espera un momento' }, 429);

  const text = await request.text();
  if (text.length > 4096) return json({ error: 'Demasiado grande' }, 413);
  let body: Partial<CreateGameBody>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'JSON no válido' }, 400);
  }
  if (!body || !PLAYER_ID_RE.test(String(body.player)) || !validTc(body.tc)) {
    return json({ error: 'Datos no válidos' }, 400);
  }

  const tc = { initial: body.tc.initial, increment: body.tc.increment };
  const color: Color =
    body.color === 'white' || body.color === 'black'
      ? body.color
      : Math.random() < 0.5
        ? 'white'
        : 'black';
  // Con 62⁸ ids posibles una colisión es casi imposible, pero init() la detecta.
  for (let i = 0; i < 3; i++) {
    const id = randomId();
    if (await env.GAME_ROOM.getByName(id).init(tc, body.player!, color)) return json({ id }, 201);
  }
  return json({ error: 'No se pudo crear la partida' }, 503);
}
