// Prueba de extremo a extremo: arranca el servidor real y juega con dos clientes WebSocket.
// Con BASE_URL (p. ej. http://127.0.0.1:8787) se ejecuta contra un servidor ya arrancado,
// como la versión de Cloudflare en `wrangler dev`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { bestMove, planBot } from '@jaque/engine/bot';

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

test('el lobby cuenta las partidas jugadas', async () => {
  const lobby = connect(`/ws/lobby?player=${P1}`);
  const { played } = await lobby.next((m) => m.t === 'stats');
  assert.equal(typeof played, 'number');
  const r = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    body: JSON.stringify({ player: P1, tc: { initial: 300, increment: 0 }, color: 'white' })
  });
  const { id } = await r.json();
  const a = connect(`/ws/game/${id}?player=${P1}`);
  await a.next((m) => m.t === 'hello');
  const b = connect(`/ws/game/${id}?player=${P2}`);
  await b.opened;
  b.send({ t: 'join' });
  await a.next((m) => m.t === 'state' && m.game.status === 'started');
  for (const [i, uci] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) {
    (i % 2 ? b : a).send({ t: 'move', uci, ply: i });
    await a.next((m) => m.t === 'state' && m.game.moves.length === i + 1);
  }
  await lobby.next((m) => m.t === 'stats' && m.played === played + 1);
  for (const c of [lobby, a, b]) c.ws.close();
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

test('contra la máquina: se sienta, juega, deja deshacer, acepta tablas y la revancha', async () => {
  const r = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    body: JSON.stringify({ player: P1, tc: { initial: 300, increment: 0 }, color: 'white' })
  });
  const { id } = await r.json();
  const a = connect(`/ws/game/${id}?player=${P1}`);
  await a.next((m) => m.t === 'state' && m.game.status === 'waiting');

  // La máquina es un cliente más, con la misma política que usa el navegador.
  const bot = connect(`/ws/game/${id}?player=${P2}`);
  let you: string | null = null;
  bot.ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'hello') you = m.you;
    if (m.t !== 'state') return;
    const plan = planBot(m.game, you as never);
    for (const msg of plan.send) bot.send(msg);
    if (plan.think) bot.send({ t: 'move', uci: bestMove(m.game.moves, { level: 1, random: () => 0.9 }), ply: m.game.moves.length });
  });

  await a.next((m) => m.t === 'state' && m.game.status === 'started');
  a.send({ t: 'move', uci: 'e2e4', ply: 0 });
  const reply = await a.next((m) => m.t === 'state' && m.game.moves.length === 2);
  assert.equal(reply.game.turn, 'white', 'la máquina ha contestado');

  // `next` también mira los mensajes ya recibidos: solo cuenta lo que llega tras la petición.
  let asked = false;
  a.send({ t: 'takeback', offer: true });
  await a.next((m) => {
    if (m.t === 'state' && m.game.takeback === 'white') asked = true;
    return asked && m.t === 'state' && m.game.moves.length === 0;
  });
  a.send({ t: 'move', uci: 'd2d4', ply: 0 });
  await a.next((m) => m.t === 'state' && m.game.moves.length === 2 && m.game.moves[0] === 'd2d4');

  a.send({ t: 'draw', offer: true });
  await a.next((m) => m.t === 'state' && m.game.status === 'draw');

  a.send({ t: 'rematch', offer: true });
  const redirect = await a.next((m) => m.t === 'redirect');
  assert.match(redirect.id, /^[A-Za-z0-9]{8}$/);
  for (const c of [a, bot]) c.ws.close();
});

test('rechaza datos no válidos', async () => {
  const r = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    body: JSON.stringify({ player: 'x', tc: { initial: 1, increment: 0 } })
  });
  assert.equal(r.status, 400);
  assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
});
