import { createRequire } from 'node:module';
import type * as U from 'uWebSockets.js';
import {
  GAME_ID_RE,
  PLAYER_ID_RE,
  PRESETS,
  presetById,
  validTc,
  type ClientGameMsg,
  type ClientLobbyMsg,
  type Color,
  type CreateGameBody,
  type ServerGameMsg,
  type ServerLobbyMsg
} from '@jaque/shared';
import { GameStore, FULL_MSG, type StoreLimits } from './store.js';
import type { Game } from './game.js';

// El envoltorio ESM de uWebSockets.js apunta a un archivo inexistente; se carga con require.
const uWS: typeof U = createRequire(import.meta.url)('uWebSockets.js');

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '0.0.0.0';

type GameSocketData = { kind: 'game'; gameId: string; player: string; color: Color | null };
type LobbySocketData = { kind: 'lobby'; player: string; seek: string | null };
type SocketData = GameSocketData | LobbySocketData;
type Socket = U.WebSocket<SocketData>;

/** Entero positivo de una variable de entorno; si falta o no es válido, undefined (valor por defecto). */
function envInt(name: string, scale = 1): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(`${name}=${raw} no es un entero positivo: se usa el valor por defecto`);
    return undefined;
  }
  return n * scale;
}
// MAX_GAMES (partidas en memoria) y KEEP_FINISHED_MIN (minutos que se conserva una terminada).
const limits: Partial<StoreLimits> = {
  maxGames: envInt('MAX_GAMES'),
  keepFinishedMs: envInt('KEEP_FINISHED_MIN', 60_000)
};
const store = new GameStore(Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined)));
const app = uWS.App();
const enc = new TextDecoder();

const gameTopic = (id: string) => `g:${id}`;
const LOBBY = 'lobby';

/** Jugadores únicos conectados (lobby + partidas). */
const online = new Map<string, number>();
const touchOnline = (player: string, d: 1 | -1) => {
  const n = (online.get(player) ?? 0) + d;
  if (n <= 0) online.delete(player);
  else online.set(player, n);
};

// ─── Difusión ────────────────────────────────────────────────────────

store.onChange = (game) => {
  const msg: ServerGameMsg = { t: 'state', game: game.view() };
  app.publish(gameTopic(game.id), JSON.stringify(msg));
};
store.onRedirect = (from, to) => {
  const msg: ServerGameMsg = { t: 'redirect', id: to.id };
  app.publish(gameTopic(from.id), JSON.stringify(msg));
};
store.onFinished = () => app.publish(LOBBY, JSON.stringify(lobbyStats()));

const send = (ws: Socket, msg: ServerGameMsg | ServerLobbyMsg) => {
  ws.send(JSON.stringify(msg));
};

// ─── Emparejamiento rápido ───────────────────────────────────────────

/** Una cola por control de tiempo. Normalmente contiene 0 o 1 personas. */
const seeks = new Map<string, Socket[]>(PRESETS.map((p) => [p.id, []]));

function removeSeek(ws: Socket) {
  const data = ws.getUserData() as LobbySocketData;
  if (!data.seek) return;
  const queue = seeks.get(data.seek);
  if (queue) {
    const i = queue.indexOf(ws);
    if (i >= 0) queue.splice(i, 1);
  }
  data.seek = null;
}

function seek(ws: Socket, tcId: string) {
  const preset = presetById(tcId);
  if (!preset) return send(ws, { t: 'error', msg: 'Control de tiempo desconocido' });
  removeSeek(ws);
  const me = ws.getUserData() as LobbySocketData;
  const queue = seeks.get(tcId)!;
  const rivalIdx = queue.findIndex((s) => (s.getUserData() as LobbySocketData).player !== me.player);

  if (rivalIdx < 0) {
    queue.push(ws);
    me.seek = tcId;
    return send(ws, { t: 'seeking', tc: tcId });
  }

  const [rival] = queue.splice(rivalIdx, 1);
  const them = rival.getUserData() as LobbySocketData;
  them.seek = null;
  const [white, black] = Math.random() < 0.5 ? [me.player, them.player] : [them.player, me.player];
  const game = store.pair(preset, white, black);
  if (!game) {
    // Los dos salieron de la cola: hay que avisar a ambos, no solo a quien llegó último.
    send(ws, { t: 'error', msg: FULL_MSG });
    return send(rival, { t: 'error', msg: FULL_MSG });
  }
  send(ws, { t: 'start', id: game.id });
  send(rival, { t: 'start', id: game.id });
}

function lobbyStats(): ServerLobbyMsg {
  const counts: Record<string, number> = {};
  for (const [id, q] of seeks) counts[id] = q.length;
  return { t: 'stats', players: online.size, games: store.playing, seeks: counts, played: store.played };
}

// ─── Mensajes de partida ─────────────────────────────────────────────

function onGameMessage(ws: Socket, data: GameSocketData, game: Game, msg: ClientGameMsg) {
  if (msg.t === 'ping') return send(ws, { t: 'pong' });
  if (msg.t === 'join') {
    if (data.color) return;
    const color = game.join(data.player);
    if (color) {
      data.color = color;
      game.setOnline(color, 1);
      send(ws, { t: 'hello', you: color });
    }
    return;
  }

  const color = data.color;
  if (!color) return send(ws, { t: 'error', msg: 'Eres espectador' });

  switch (msg.t) {
    case 'move': {
      const err = game.move(color, String(msg.uci), Number(msg.ply));
      // Si la jugada se rechaza, reenviamos el estado para que el cliente se resincronice.
      if (err) {
        send(ws, { t: 'error', msg: err });
        send(ws, { t: 'state', game: game.view() });
      }
      break;
    }
    case 'resign':
      return game.resign(color);
    case 'abort':
      return game.abort(color);
    case 'draw':
      return game.draw(color, !!msg.offer);
    case 'takeback':
      return game.takeback(color, !!msg.offer, msg.ply === undefined ? undefined : Number(msg.ply));
    case 'rematch':
      if (!store.rematch(game, color, !!msg.offer)) {
        app.publish(gameTopic(game.id), JSON.stringify({ t: 'error', msg: FULL_MSG }));
      }
      return;
  }
}

// ─── WebSockets ──────────────────────────────────────────────────────

const wsOptions = {
  compression: uWS.SHARED_COMPRESSOR,
  maxPayloadLength: 1024,
  // Cloudflare corta las conexiones inactivas a los ~100 s: con pings cada <60 s no pasa.
  idleTimeout: 60,
  sendPingsAutomatically: true,
  maxBackpressure: 64 * 1024
};

app.ws<SocketData>('/ws/game/:id', {
  ...wsOptions,
  upgrade: (res, req, context) => {
    const id = req.getParameter(0) ?? '';
    const player = new URLSearchParams(req.getQuery() ?? '').get('player') ?? '';
    const key = req.getHeader('sec-websocket-key');
    const protocol = req.getHeader('sec-websocket-protocol');
    const ext = req.getHeader('sec-websocket-extensions');
    if (!GAME_ID_RE.test(id) || !PLAYER_ID_RE.test(player) || !store.get(id)) {
      res.writeStatus('404 Not Found').end();
      return;
    }
    const data: GameSocketData = { kind: 'game', gameId: id, player, color: null };
    res.upgrade(data, key, protocol, ext, context);
  },
  open: (ws) => {
    const data = ws.getUserData() as GameSocketData;
    const game = store.get(data.gameId);
    if (!game) return ws.end(4004, 'not found');
    touchOnline(data.player, 1);
    data.color = game.colorOf(data.player);
    ws.subscribe(gameTopic(game.id));
    send(ws, { t: 'hello', you: data.color });
    if (data.color) game.setOnline(data.color, 1); // publica el estado a todos
    else send(ws, { t: 'state', game: game.view() });
  },
  message: (ws, buf) => {
    const data = ws.getUserData() as GameSocketData;
    const game = store.get(data.gameId);
    if (!game) return;
    let msg: ClientGameMsg;
    try {
      msg = JSON.parse(enc.decode(buf));
    } catch {
      return;
    }
    onGameMessage(ws, data, game, msg);
  },
  close: (ws) => {
    const data = ws.getUserData() as GameSocketData;
    touchOnline(data.player, -1);
    const game = store.get(data.gameId);
    if (game && data.color) game.setOnline(data.color, -1);
  }
});

app.ws<SocketData>('/ws/lobby', {
  ...wsOptions,
  upgrade: (res, req, context) => {
    const player = new URLSearchParams(req.getQuery() ?? '').get('player') ?? '';
    const key = req.getHeader('sec-websocket-key');
    const protocol = req.getHeader('sec-websocket-protocol');
    const ext = req.getHeader('sec-websocket-extensions');
    if (!PLAYER_ID_RE.test(player)) {
      res.writeStatus('400 Bad Request').end();
      return;
    }
    res.upgrade<SocketData>({ kind: 'lobby', player, seek: null }, key, protocol, ext, context);
  },
  open: (ws) => {
    touchOnline(ws.getUserData().player, 1);
    ws.subscribe(LOBBY);
    send(ws, lobbyStats());
  },
  message: (ws, buf) => {
    let msg: ClientLobbyMsg;
    try {
      msg = JSON.parse(enc.decode(buf));
    } catch {
      return;
    }
    if (msg.t === 'seek') seek(ws, String(msg.tc));
    else if (msg.t === 'cancel') removeSeek(ws);
    else if (msg.t === 'ping') send(ws, { t: 'pong' });
  },
  close: (ws) => {
    removeSeek(ws);
    touchOnline(ws.getUserData().player, -1);
  }
});

// ─── HTTP ────────────────────────────────────────────────────────────

function json(res: U.HttpResponse, status: string, body: unknown) {
  res.cork(() => {
    res.writeStatus(status).writeHeader('Content-Type', 'application/json').end(JSON.stringify(body));
  });
}

/** Lee un cuerpo JSON pequeño (máx. 4 KB). */
function readJson(res: U.HttpResponse, cb: (body: unknown) => void) {
  let buffer = Buffer.alloc(0);
  let aborted = false;
  res.onAborted(() => (aborted = true));
  res.onData((chunk, isLast) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > 4096) {
      if (!aborted) json(res, '413 Payload Too Large', { error: 'Demasiado grande' });
      aborted = true;
      return;
    }
    if (!isLast || aborted) return;
    let body: unknown;
    try {
      body = JSON.parse(buffer.toString('utf8'));
    } catch {
      return json(res, '400 Bad Request', { error: 'JSON no válido' });
    }
    cb(body);
  });
}

app.post('/api/games', (res) => {
  readJson(res, (raw) => {
    const body = raw as Partial<CreateGameBody>;
    if (!body || !PLAYER_ID_RE.test(String(body.player)) || !validTc(body.tc)) {
      return json(res, '400 Bad Request', { error: 'Datos no válidos' });
    }
    const game = store.create({ initial: body.tc.initial, increment: body.tc.increment });
    if (!game) return json(res, '503 Service Unavailable', { error: FULL_MSG });
    const color: Color =
      body.color === 'white' || body.color === 'black'
        ? body.color
        : Math.random() < 0.5
          ? 'white'
          : 'black';
    game.join(body.player!, color);
    json(res, '201 Created', { id: game.id });
  });
});

app.get('/api/games/:id', (res, req) => {
  const game = store.get(req.getParameter(0) ?? '');
  if (!game) return json(res, '404 Not Found', { error: 'Partida no encontrada' });
  json(res, '200 OK', game.view());
});

app.get('/api/health',(res) => json(res, '200 OK', { ok: true, games: store.size }));

app.any('/*', (res) => json(res, '404 Not Found', { error: 'No encontrado' }));

// ─── Arranque ────────────────────────────────────────────────────────

setInterval(() => app.publish(LOBBY, JSON.stringify(lobbyStats())), 3000).unref();
setInterval(() => store.sweep(), 60_000).unref();

let listenSocket: U.us_listen_socket | null = null;
app.listen(HOST, PORT, (token) => {
  if (!token) {
    console.error(`No se pudo escuchar en ${HOST}:${PORT}`);
    process.exit(1);
  }
  listenSocket = token;
  console.log(`♞ jaque server en http://${HOST}:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`${sig}: cerrando`);
    if (listenSocket) uWS.us_listen_socket_close(listenSocket);
    app.close();
    process.exit(0);
  });
}
