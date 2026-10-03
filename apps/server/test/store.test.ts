import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameStore, DEFAULT_LIMITS, FULL_MSG } from '../src/store.js';
import type { Game } from '../src/game.js';

const blitz = { initial: 180, increment: 2 };
const W = 'white-player-00000';
const B = 'black-player-00000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Partida terminada (mate del loco). */
function mated(store: GameStore): Game {
  const g = store.pair(blitz, W, B)!;
  ['f2f3', 'e7e5', 'g2g4', 'd8h4'].forEach((m, i) => g.move(i % 2 ? 'black' : 'white', m, i));
  assert.equal(g.status, 'mate');
  return g;
}

test('los valores por defecto no cambian', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    maxGames: 50_000,
    keepFinishedMs: 60 * 60_000,
    keepWaitingMs: 3 * 60 * 60_000
  });
  assert.deepEqual(new GameStore().limits, DEFAULT_LIMITS);
  assert.deepEqual(new GameStore({ maxGames: 3000 }).limits, { ...DEFAULT_LIMITS, maxGames: 3000 });
});

test('una partida terminada se elimina pasado el plazo configurado', () => {
  const keep = 10 * 60_000;
  const store = new GameStore({ keepFinishedMs: keep });
  const g = mated(store);
  const ended = g.endedAt!;
  store.sweep(ended + keep - 1000);
  assert.equal(store.get(g.id), g, 'antes del plazo se conserva');
  store.sweep(ended + keep + 1000);
  assert.equal(store.get(g.id), undefined, 'pasado el plazo se elimina');
});

test('con el plazo por defecto se conserva una hora', () => {
  const store = new GameStore();
  const g = mated(store);
  store.sweep(g.endedAt! + 59 * 60_000);
  assert.ok(store.get(g.id));
  store.sweep(g.endedAt! + 61 * 60_000);
  assert.equal(store.get(g.id), undefined);
});

test('no se elimina mientras alguien siga conectado', () => {
  const store = new GameStore({ keepFinishedMs: 1000 });
  const g = mated(store);
  g.setOnline('white', 1);
  store.sweep(g.endedAt! + 60_000);
  assert.ok(store.get(g.id), 'con un jugador conectado se conserva');
  g.setOnline('white', -1);
  store.sweep(g.endedAt! + 60_000);
  assert.equal(store.get(g.id), undefined);
});

test('la revancha funciona antes del plazo y no la afecta la limpieza', () => {
  const keep = 10 * 60_000;
  const store = new GameStore({ keepFinishedMs: keep });
  const redirects: string[] = [];
  store.onRedirect = (_from, to) => redirects.push(to.id);
  const g = mated(store);
  assert.equal(store.rematch(g, 'white', true), true);
  assert.equal(g.next, null, 'con una sola oferta aún no hay partida nueva');
  assert.equal(store.rematch(g, 'black', true), true);
  assert.ok(g.next, 'con las dos ofertas se crea la revancha');
  assert.deepEqual(redirects, [g.next]);
  assert.equal(store.get(g.next!)?.status, 'started');
  // La limpieza posterior quita la partida vieja, no la revancha en curso.
  store.sweep(g.endedAt! + keep + 1000);
  assert.equal(store.get(g.id), undefined);
  assert.equal(store.get(g.next!)?.status, 'started');
});

test('una partida en espera caduca con keepWaitingMs', () => {
  const store = new GameStore({ keepWaitingMs: 5000 });
  const g = store.create(blitz)!;
  store.sweep(Date.now() + 4000);
  assert.ok(store.get(g.id));
  store.sweep(Date.now() + 6000);
  assert.equal(store.get(g.id), undefined);
});

test('al llegar a maxGames se rechaza con null; si caducó alguna, se libera sitio', async () => {
  const store = new GameStore({ maxGames: 1, keepWaitingMs: 1 });
  assert.ok(store.create(blitz));
  await sleep(10);
  assert.ok(store.create(blitz), 'create barre las caducadas antes de rechazar');
  assert.equal(store.size, 1);

  const lleno = new GameStore({ maxGames: 2 });
  assert.ok(lleno.create(blitz));
  assert.ok(lleno.create(blitz));
  assert.equal(lleno.create(blitz), null, 'create devuelve null en el tope');
  assert.equal(lleno.pair(blitz, W, B), null, 'pair también');
});

test('revancha sin sitio: devuelve false, retira las ofertas y se puede reintentar', () => {
  const store = new GameStore({ maxGames: 3, keepWaitingMs: 5000 });
  const g = mated(store); // 1
  store.create(blitz); // 2
  store.create(blitz); // 3: lleno
  assert.equal(store.rematch(g, 'white', true), true);
  assert.equal(store.rematch(g, 'black', true), false, 'no hay sitio: lo avisa');
  assert.equal(g.next, null);
  assert.deepEqual(g.view().rematch, [], 'las ofertas quedan retiradas');
  // Se libera sitio (caducan las dos en espera) y se puede reintentar.
  store.sweep(Date.now() + 10_000);
  assert.equal(store.rematch(g, 'white', true), true);
  assert.equal(store.rematch(g, 'black', true), true);
  assert.ok(g.next);
});

test('el mensaje de «lleno» es claro', () => {
  assert.match(FULL_MSG, /lleno/i);
  assert.match(FULL_MSG, /inténtalo/i);
});
