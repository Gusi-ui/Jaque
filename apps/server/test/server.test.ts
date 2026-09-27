// Prueba de extremo a extremo: arranca el servidor real y juega con dos clientes WebSocket.
// Con BASE_URL (p. ej. http://127.0.0.1:8787) se ejecuta contra un servidor ya arrancado,
// como la versión de Cloudflare en `wrangler dev`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;

before(async () => {
  if (process.env.BASE_URL) return;
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise<void>((ok) => server!.stdout!.on('data', (d) => String(d).includes('server') && ok()));
});
after(() => server?.kill('SIGTERM'));

type Msg = { t: string; [k: string]: any };

function connect(path: string) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}${path}`);
  const inbox: Msg[] = [];
  const waiters: Array<[(m: Msg) => boolean, (m: Msg) => void]> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    const i = waiters.findIndex(([f]) => f(m));
    if (i >= 0) waiters.splice(i, 1)[0][1](m);
    else inbox.push(m);
  });
  const next = (f: (m: Msg) => boolean) =>
    new Promise<Msg>((ok, ko) => {
      const i = inbox.findIndex(f);
      if (i >= 0) return ok(inbox.splice(i, 1)[0]);
      waiters.push([f, ok]);
      setTimeout(() => ko(new Error('timeout esperando mensaje')), 3000).unref();
    });
  const opened = new Promise((ok) => ws.on('open', ok));
  return { ws, next, opened, send: (m: object) => ws.send(JSON.stringify(m)) };
}

const P1 = 'jugador-uno-000000';
const P2 = 'jugador-dos-000000';

test('partida con un amigo: crear, unirse, jugar hasta mate y revancha', async () => {
  const r = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    body: JSON.stringify({ player: P1, tc: { initial: 300, increment: 3 }, color: 'white' })
  });
  assert.equal(r.status, 201);
  const { id } = await r.json();

  const a = connect(`/ws/game/${id}?player=${P1}`);
  assert.equal((await a.next((m) => m.t === 'hello')).you, 'white');
  assert.equal((await a.next((m) => m.t === 'state')).game.status, 'waiting');

  const b = connect(`/ws/game/${id}?player=${P2}`);
  assert.equal((await b.next((m) => m.t === 'hello')).you, null, 'entra como espectador');
  await b.opened;
  b.send({ t: 'join' });
  assert.equal((await b.next((m) => m.t === 'hello')).you, 'black');
  await a.next((m) => m.t === 'state' && m.game.status === 'started');

  const seq = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  for (const [i, uci] of seq.entries()) {
    (i % 2 ? b : a).send({ t: 'move', uci, ply: i });
    await a.next((m) => m.t === 'state' && m.game.moves.length === i + 1);
  }
  const end = await b.next((m) => m.t === 'state' && m.game.status === 'mate');
  assert.equal(end.game.winner, 'black');
  assert.equal(end.game.sans.at(-1), 'Qh4#');

  a.send({ t: 'rematch', offer: true });
  b.send({ t: 'rematch', offer: true });
  const redirect = await a.next((m) => m.t === 'redirect');
  assert.match(redirect.id, /^[A-Za-z0-9]{8}$/);

  const a2 = connect(`/ws/game/${redirect.id}?player=${P1}`);
  assert.equal((await a2.next((m) => m.t === 'hello')).you, 'black', 'colores cambiados');
  for (const c of [a, b, a2]) c.ws.close();
});

test('emparejamiento rápido en el lobby', async () => {
  const a = connect(`/ws/lobby?player=${P1}`);
  const b = connect(`/ws/lobby?player=${P2}`);
  await Promise.all([a.opened, b.opened]);
  a.send({ t: 'seek', tc: '3+2' });
  await a.next((m) => m.t === 'seeking');
  b.send({ t: 'seek', tc: '3+2' });
  const [sa, sb] = await Promise.all([a.next((m) => m.t === 'start'), b.next((m) => m.t === 'start')]);
  assert.equal(sa.id, sb.id);
  a.ws.close();
  b.ws.close();
});

test('keepalive: responde pong al ping, también a los espectadores', async () => {
  const r = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    body: JSON.stringify({ player: P1, tc: { initial: 60, increment: 0 }, color: 'white' })
  });
  const { id } = await r.json();
  const spectator = connect(`/ws/game/${id}?player=${P2}`);
  const lobby = connect(`/ws/lobby?player=${P1}`);
  await Promise.all([spectator.opened, lobby.opened]);
  for (const c of [spectator, lobby]) {
    c.ws.send('{"t":"ping"}');
    await c.next((m) => m.t === 'pong');
  }
  for (const c of [spectator, lobby]) c.ws.close();
});

test('rechaza datos no válidos', async () => {
  const r = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    body: JSON.stringify({ player: 'x', tc: { initial: 1, increment: 0 } })
  });
  assert.equal(r.status, 400);
  assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
});
