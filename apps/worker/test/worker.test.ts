import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, listDurableObjectIds, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GameView } from '@jaque/shared';

const BASE = 'http://jaque.test';
const P1 = 'jugador-uno-000000';
const P2 = 'jugador-dos-000000';

type Msg = { t: string; [k: string]: any };

let ipCounter = 0;
/** Cada prueba usa una IP distinta para no chocar con el límite de peticiones. */
const nextIp = () => `10.0.0.${++ipCounter}`;

async function createGame(player = P1, color = 'white', tc = { initial: 300, increment: 3 }, ip = nextIp()) {
  const r = await exports.default.fetch(`${BASE}/api/games`, {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
    body: JSON.stringify({ player, tc, color })
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

async function getGame(id: string) {
  return exports.default.fetch(`${BASE}/api/games/${id}`);
}

/** Cliente WebSocket de prueba con una bandeja de entrada y `next(filtro)`. */
async function connect(path: string) {
  const res = await exports.default.fetch(`${BASE}${path}`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const inbox: Msg[] = [];
  const waiters: Array<[(m: Msg) => boolean, (m: Msg) => void]> = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    const i = waiters.findIndex(([f]) => f(m));
    if (i >= 0) waiters.splice(i, 1)[0][1](m);
    else inbox.push(m);
  });
  const next = (f: (m: Msg) => boolean) =>
    new Promise<Msg>((ok, ko) => {
      const i = inbox.findIndex(f);
      if (i >= 0) return ok(inbox.splice(i, 1)[0]);
      waiters.push([f, ok]);
      setTimeout(() => ko(new Error(`timeout esperando ${f}; bandeja: ${JSON.stringify(inbox.map((m) => m.t === 'state' ? { t: 'state', status: m.game.status, moves: m.game.moves.length } : m))}`)), 3000);
    });
  return { ws, next, send: (m: object) => ws.send(JSON.stringify(m)) };
}

type Client = Awaited<ReturnType<typeof connect>>;

/** Crea una partida y sienta a los dos jugadores; devuelve los dos clientes. */
async function startedGame(tc = { initial: 300, increment: 3 }) {
  const id = await createGame(P1, 'white', tc);
  const a = await connect(`/ws/game/${id}?player=${P1}`);
  expect((await a.next((m) => m.t === 'hello')).you).toBe('white');
  const b = await connect(`/ws/game/${id}?player=${P2}`);
  expect((await b.next((m) => m.t === 'hello')).you).toBe(null);
  b.send({ t: 'join' });
  expect((await b.next((m) => m.t === 'hello')).you).toBe('black');
  await a.next((m) => m.t === 'state' && m.game.status === 'started');
  return { id, a, b };
}

async function play(a: Client, b: Client, seq: string[], from = 0) {
  for (const [i, uci] of seq.entries()) {
    const ply = from + i;
    (ply % 2 ? b : a).send({ t: 'move', uci, ply });
    await a.next((m) => m.t === 'state' && m.game.moves.length === ply + 1);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('partidas', () => {
  it('crear, unirse, jugar hasta mate y revancha', async () => {
    const { id, a, b } = await startedGame();
    const view = (await (await getGame(id)).json()) as GameView;
    expect(view.id).toBe(id);
    expect(view.status).toBe('started');
    expect(view.seats.white).toEqual({ taken: true, online: true });

    await play(a, b, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const end = await b.next((m) => m.t === 'state' && m.game.status === 'mate');
    expect(end.game.winner).toBe('black');
    expect(end.game.sans.at(-1)).toBe('Qh4#');

    a.send({ t: 'rematch', offer: true });
    b.send({ t: 'rematch', offer: true });
    const redirect = await a.next((m) => m.t === 'redirect');
    expect(redirect.id).toMatch(/^[A-Za-z0-9]{8}$/);
    await b.next((m) => m.t === 'redirect' && m.id === redirect.id);

    const a2 = await connect(`/ws/game/${redirect.id}?player=${P1}`);
    expect((await a2.next((m) => m.t === 'hello')).you).toBe('black');
    const next = (await (await getGame(redirect.id)).json()) as GameView;
    expect(next.id).toBe(redirect.id);
    expect(next.status).toBe('started');
    for (const c of [a, b, a2]) c.ws.close();
  });

  it('deshacer: se pide y se acepta por WebSocket', async () => {
    const { a, b } = await startedGame();
    await play(a, b, ['e2e4', 'e7e5', 'g1f3']);
    a.send({ t: 'takeback', offer: true });
    await b.next((m) => m.t === 'state' && m.game.takeback === 'white');
    b.send({ t: 'takeback', offer: true });
    const undone = await a.next((m) => m.t === 'state' && m.game.moves.length === 2);
    expect(undone.game.turn).toBe('white');
    expect(undone.game.takeback).toBe(null);
    for (const c of [a, b]) c.ws.close();
  });

  it('la partida terminada se guarda en D1; las anuladas no', async () => {
    const { id, a, b } = await startedGame();
    await play(a, b, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    await b.next((m) => m.t === 'state' && m.game.status === 'mate');
    // El estado se difunde antes de escribir en D1.
    const row = await vi.waitUntil(() => env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(id).first());
    expect(row).toMatchObject({
      id,
      initial: 300,
      increment: 3,
      white_player: P1,
      black_player: P2,
      status: 'mate',
      winner: 'black',
      moves: 'f2f3 e7e5 g2g4 d8h4'
    });
    expect(row!.ended_at).toBeGreaterThanOrEqual(row!.created_at as number);

    const other = await startedGame();
    other.a.send({ t: 'abort' });
    await other.a.next((m) => m.t === 'state' && m.game.status === 'aborted');
    expect(await env.DB.prepare('SELECT 1 FROM games WHERE id = ?').bind(other.id).first()).toBeNull();
    for (const c of [a, b, other.a, other.b]) c.ws.close();
  });

  it('rechaza jugadas ilegales y reenvía el estado', async () => {
    const { a, b } = await startedGame();
    a.send({ t: 'move', uci: 'e2e5', ply: 0 });
    expect((await a.next((m) => m.t === 'error')).msg).toBe('Jugada ilegal');
    expect((await a.next((m) => m.t === 'state')).game.moves).toEqual([]);
    b.send({ t: 'move', uci: 'e7e5', ply: 0 });
    expect((await b.next((m) => m.t === 'error')).msg).toBe('No es tu turno');
    for (const c of [a, b]) c.ws.close();
  });

  it('la presencia se calcula con los sockets conectados', async () => {
    const { id, a, b } = await startedGame();
    b.ws.close();
    const s = await a.next((m) => m.t === 'state' && !m.game.seats.black.online);
    expect(s.game.seats.white.online).toBe(true);
    const view = (await (await getGame(id)).json()) as GameView;
    expect(view.seats.black.online).toBe(false);
    a.ws.close();
  });
});

describe('alarmas', () => {
  it('la bandera cae mediante la alarma', async () => {
    const { id, a, b } = await startedGame({ initial: 60, increment: 0 });
    await play(a, b, ['e2e4', 'e7e5']);
    const stub = env.GAME_ROOM.getByName(id);

    // Todavía no: la alarma se ejecuta, no cambia nada y se reprograma.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(((await stub.view()) as GameView).status).toBe('started');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const end = await b.next((m) => m.t === 'state' && m.game.status === 'timeout');
    expect(end.game.winner).toBe('black');
    expect(end.game.clock.white).toBe(0);
    for (const c of [a, b]) c.ws.close();
  });

  it('sin primera jugada en 30 s la partida se anula', async () => {
    const { id, a, b } = await startedGame();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    expect(await runDurableObjectAlarm(env.GAME_ROOM.getByName(id))).toBe(true);
    await a.next((m) => m.t === 'state' && m.game.status === 'aborted');
    for (const c of [a, b]) c.ws.close();
  });

  it('las partidas terminadas se borran a las 2 h si no queda nadie', async () => {
    const { id, a, b } = await startedGame();
    a.send({ t: 'resign' });
    await b.next((m) => m.t === 'state' && m.game.status === 'resign');
    for (const c of [a, b]) c.ws.close();
    // Esperar a que el objeto procese los cierres.
    await vi.waitUntil(async () => ((await (await getGame(id)).json()) as GameView).seats.white.online === false);

    const stub = env.GAME_ROOM.getByName(id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await getGame(id)).status).toBe(404);
  });

  it('los desafíos sin actividad se borran a las 3 h', async () => {
    const id = await createGame();
    const stub = env.GAME_ROOM.getByName(id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * 60_000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await getGame(id)).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await getGame(id)).status).toBe(404);
  });
});

describe('hibernación', () => {
  it('el estado y los sockets sobreviven a la expulsión del objeto', async () => {
    const { id, a, b } = await startedGame({ initial: 60, increment: 0 });
    await play(a, b, ['g1f3', 'g8f6', 'f3g1']);
    a.send({ t: 'draw', offer: true });
    await b.next((m) => m.t === 'state' && m.game.drawOffer === 'white');
    const before = (await env.GAME_ROOM.getByName(id).view()) as GameView;

    // Se descarta la memoria; los WebSockets quedan hibernados.
    await evictDurableObject(env.GAME_ROOM.getByName(id));

    const after = (await env.GAME_ROOM.getByName(id).view()) as GameView;
    expect({ ...after, clock: null }).toEqual({ ...before, clock: null });
    expect(after.seats.white.online && after.seats.black.online).toBe(true);

    // Los mismos sockets siguen jugando, y la triple repetición usa el historial reconstruido.
    await play(a, b, ['f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'], 3);
    const end = await b.next((m) => m.t === 'state' && m.game.status === 'repetition');
    expect(end.game.moves).toHaveLength(8);
    for (const c of [a, b]) c.ws.close();
  });

  it('el ping se responde sin despertar al objeto', async () => {
    const { id, a, b } = await startedGame();
    await evictDurableObject(env.GAME_ROOM.getByName(id));
    a.ws.send('{"t":"ping"}');
    await a.next((m) => m.t === 'pong');
    for (const c of [a, b]) c.ws.close();
  });
});

describe('lobby', () => {
  // El lobby es uno solo para todo el archivo: cada prueba usa sus propios jugadores
  // y compara el número de partidas con el de partida.
  it('empareja dos búsquedas del mismo ritmo y cuenta la partida', async () => {
    const a = await connect(`/ws/lobby?player=lobby-uno-00000000`);
    const b = await connect(`/ws/lobby?player=lobby-dos-00000000`);
    const { games } = await a.next((m) => m.t === 'stats' && m.players === 2);

    a.send({ t: 'seek', tc: '3+2' });
    await a.next((m) => m.t === 'seeking' && m.tc === '3+2');
    await b.next((m) => m.t === 'stats' && m.seeks['3+2'] === 1);

    b.send({ t: 'seek', tc: '3+2' });
    const [sa, sb] = await Promise.all([a.next((m) => m.t === 'start'), b.next((m) => m.t === 'start')]);
    expect(sa.id).toBe(sb.id);
    await a.next((m) => m.t === 'stats' && m.games === games + 1 && m.seeks['3+2'] === 0);

    const view = (await (await getGame(sa.id)).json()) as GameView;
    expect(view.status).toBe('started');
    expect(view.tc).toEqual({ initial: 180, increment: 2 });

    // Al terminar la partida, el GameRoom avisa al lobby.
    const g = await connect(`/ws/game/${sa.id}?player=lobby-uno-00000000`);
    g.send({ t: 'abort' });
    await a.next((m) => m.t === 'stats' && m.games === games);
    for (const c of [a, b, g]) c.ws.close();
  });

  it('cuenta las partidas terminadas, no las anuladas', async () => {
    const l = await connect(`/ws/lobby?player=lobby-cuatro-000000`);
    const { played } = await l.next((m) => m.t === 'stats');
    expect(typeof played).toBe('number');

    const aborted = await startedGame();
    aborted.a.send({ t: 'abort' });
    await aborted.a.next((m) => m.t === 'state' && m.game.status === 'aborted');

    // Si la anulada sumara, el stats tras el mate llevaría played + 2.
    const { a, b } = await startedGame();
    await play(a, b, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    await l.next((m) => m.t === 'stats' && m.played === played + 1);
    for (const c of [l, a, b, aborted.a, aborted.b]) c.ws.close();
  });

  it('no empareja a un jugador consigo mismo y permite cancelar', async () => {
    const a = await connect(`/ws/lobby?player=lobby-tres-0000000`);
    const { players } = await a.next((m) => m.t === 'stats');
    const a2 = await connect(`/ws/lobby?player=lobby-tres-0000000`);
    a.send({ t: 'seek', tc: '1+0' });
    await a.next((m) => m.t === 'seeking');
    a2.send({ t: 'seek', tc: '1+0' });
    await a2.next((m) => m.t === 'seeking');
    const stats = await a.next((m) => m.t === 'stats' && m.seeks['1+0'] === 2);
    expect(stats.players).toBe(players);
    a.send({ t: 'cancel' });
    a2.ws.close();
    await a.next((m) => m.t === 'stats' && m.seeks['1+0'] === 0);
    a.ws.close();
  });
});

describe('validación y límites', () => {
  it('valida ids y jugadores antes de tocar ningún Durable Object', async () => {
    const before = (await listDurableObjectIds(env.GAME_ROOM)).length;
    expect((await getGame('no-valido')).status).toBe(404);
    const ws = await exports.default.fetch(`${BASE}/ws/game/AAAAAAAA?player=x`, {
      headers: { Upgrade: 'websocket' }
    });
    expect(ws.status).toBe(404);
    const lobby = await exports.default.fetch(`${BASE}/ws/lobby?player=x`, {
      headers: { Upgrade: 'websocket' }
    });
    expect(lobby.status).toBe(400);
    expect((await listDurableObjectIds(env.GAME_ROOM)).length).toBe(before);
  });

  it('rechaza datos no válidos', async () => {
    const r = await exports.default.fetch(`${BASE}/api/games`, {
      method: 'POST',
      headers: { 'CF-Connecting-IP': nextIp() },
      body: JSON.stringify({ player: 'x', tc: { initial: 1, increment: 0 } })
    });
    expect(r.status).toBe(400);
    expect((await exports.default.fetch(`${BASE}/api/health`)).status).toBe(200);
    expect((await getGame('ZZZZZZZZ')).status).toBe(404);
  });

  it('limita la creación de partidas por IP', async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await exports.default.fetch(`${BASE}/api/games`, {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip },
        body: JSON.stringify({ player: P1, tc: { initial: 60, increment: 0 }, color: 'random' })
      });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
    // Otra IP no se ve afectada.
    await createGame();
  });
});
