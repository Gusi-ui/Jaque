// Con MAX_GAMES=2, comprueba que el cliente recibe un error claro (no un fallo mudo)
// al llegar al tope: al crear, en el emparejamiento rápido y al pedir la revancha.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { FULL_MSG } from '../src/store.js';

const PORT = 3800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;
let invalidWarning = '';

before(async () => {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MAX_GAMES: '2', KEEP_FINISHED_MIN: 'abc' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr!.on('data', (d) => (invalidWarning += String(d)));
  server.stdout!.on('data', (d) => (invalidWarning += String(d)));
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
  /** Comprueba que NO llega ningún mensaje así en un rato (la ausencia también es un fallo). */
  const never = async (f: (m: Msg) => boolean, ms = 400) => {
    await new Promise((r) => setTimeout(r, ms));
    assert.equal(inbox.some(f), false, 'no debía llegar ese mensaje');
  };
  const opened = new Promise((ok) => ws.on('open', ok));
  return { ws, next, never, opened, send: (m: object) => ws.send(JSON.stringify(m)) };
}

const P1 = 'jugador-uno-000000';
const P2 = 'jugador-dos-000000';
const create = (player: string) =>
  fetch(`${BASE}/api/games`, {
    method: 'POST',
    body: JSON.stringify({ player, tc: { initial: 300, increment: 0 }, color: 'white' })
  });

let finishedId = '';
let a: ReturnType<typeof connect>;
let b: ReturnType<typeof connect>;

test('una variable de entorno inválida se ignora con un aviso', () => {
  assert.match(invalidWarning, /KEEP_FINISHED_MIN=abc/);
});

test('llegar al tope: crear partida responde 503 con un mensaje claro', async () => {
  // Partida 1: se juega hasta el mate (queda terminada, pero ocupa sitio).
  const r1 = await create(P1);
  assert.equal(r1.status, 201);
  finishedId = (await r1.json()).id;
  a = connect(`/ws/game/${finishedId}?player=${P1}`);
  b = connect(`/ws/game/${finishedId}?player=${P2}`);
  await a.next((m) => m.t === 'hello');
  await b.opened;
  b.send({ t: 'join' });
  await a.next((m) => m.t === 'state' && m.game.status === 'started');
  let last: Msg | undefined;
  for (const [i, uci] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries()) {
    (i % 2 ? b : a).send({ t: 'move', uci, ply: i });
    last = await a.next((m) => m.t === 'state' && m.game.moves.length === i + 1);
  }
  assert.equal(last!.game.status, 'mate');

  // Partida 2: ocupa el segundo (y último) sitio.
  assert.equal((await create('otro-jugador-000000')).status, 201);

  // Partida 3: no cabe.
  const r3 = await create('tercero-jugador-0000');
  assert.equal(r3.status, 503);
  const body = await r3.json();
  assert.equal(body.error, FULL_MSG);
  assert.match(body.error, /lleno/i);
  assert.equal((await fetch(`${BASE}/api/health`)).status, 200, 'el servidor sigue sano');
});

test('llegar al tope: el emparejamiento rápido avisa a los DOS jugadores', async () => {
  const x = connect(`/ws/lobby?player=${P1}`);
  const y = connect(`/ws/lobby?player=${P2}`);
  await Promise.all([x.opened, y.opened]);
  x.send({ t: 'seek', tc: '3+2' });
  await x.next((m) => m.t === 'seeking');
  y.send({ t: 'seek', tc: '3+2' });
  const [ex, ey] = await Promise.all([x.next((m) => m.t === 'error'), y.next((m) => m.t === 'error')]);
  assert.equal(ex.msg, FULL_MSG);
  assert.equal(ey.msg, FULL_MSG);
  await x.never((m) => m.t === 'start');
  await y.never((m) => m.t === 'start');
  x.ws.close();
  y.ws.close();
});

test('llegar al tope: la revancha avisa a los dos y se retiran las ofertas', async () => {
  a.send({ t: 'rematch', offer: true });
  b.send({ t: 'rematch', offer: true });
  const [ea, eb] = await Promise.all([a.next((m) => m.t === 'error'), b.next((m) => m.t === 'error')]);
  assert.equal(ea.msg, FULL_MSG);
  assert.equal(eb.msg, FULL_MSG);
  await a.never((m) => m.t === 'redirect');
  const st = await a.next((m) => m.t === 'state' && m.game.status === 'mate' && m.game.rematch.length === 0);
  assert.deepEqual(st.game.rematch, []);
  a.ws.close();
  b.ws.close();
});
