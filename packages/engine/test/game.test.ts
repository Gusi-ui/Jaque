import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { Game, FIRST_MOVE_MS, canMate } from '../src/index.ts';

const blitz = { initial: 180, increment: 2 };
const T0 = 1_000_000;

function started(tc = blitz, now = T0) {
  const g = new Game('AAAAAAAA', tc, now);
  g.join('white-player-00000', 'white', now);
  g.join('black-player-00000', undefined, now);
  return g;
}

/** Juega una secuencia alternando colores, todas en el instante `now`. */
function play(g: Game, seq: string[], now = T0) {
  for (const m of seq) assert.equal(g.move(g.turn, m, g.ply, now), null, m);
}

test('dos jugadores empiezan la partida', () => {
  const g = started();
  assert.equal(g.status, 'started');
  assert.equal(g.colorOf('black-player-00000'), 'black');
});

test('mate del pastor', () => {
  const g = started();
  const seq = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  seq.forEach((m, i) => assert.equal(g.move(i % 2 ? 'black' : 'white', m, i, T0), null, m));
  assert.equal(g.status, 'mate');
  assert.equal(g.winner, 'white');
  assert.deepEqual(g.sans.at(-1), 'Qxf7#');
  assert.equal(g.nextDeadline(), null);
});

test('rechaza jugadas ilegales, fuera de turno y desfasadas', () => {
  const g = started();
  assert.equal(g.move('black', 'e7e5', 0, T0), 'No es tu turno');
  assert.equal(g.move('white', 'e2e5', 0, T0), 'Jugada ilegal');
  assert.equal(g.move('white', 'e2e4', 3, T0), 'Jugada desfasada');
  assert.equal(g.move('white', 'hola', 0, T0), 'Formato de jugada no válido');
  assert.equal(g.move('white', 'e2e4', 0, T0), null);
});

test('coronación', () => {
  const g = started();
  play(g, ['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'c8b7', 'a6b7', 'h7h6', 'b7a8n']);
  assert.equal(g.sans.at(-1), 'bxa8=N');
});

test('el reloj arranca tras la 2ª jugada, suma incremento y la bandera cae', () => {
  const g = started({ initial: 60, increment: 1 });
  g.move('white', 'e2e4', 0, T0);
  g.move('black', 'e7e5', 1, T0 + 10_000);
  assert.equal(g.view(T0 + 10_000).clock.white, 60_000, 'antes de la 2ª jugada no corre');
  g.move('white', 'g1f3', 2, T0 + 15_000);
  assert.equal(g.view(T0 + 15_000).clock.white, 56_000, '60 − 5 + 1');
  assert.equal(g.view(T0 + 15_000).clock.running, 'black');

  assert.equal(g.nextDeadline(), T0 + 15_000 + 60_000);
  assert.equal(g.tick(T0 + 74_999), false, 'aún no');
  assert.equal(g.status, 'started');
  assert.equal(g.tick(T0 + 75_000), true);
  assert.equal(g.status, 'timeout');
  assert.equal(g.winner, 'white');
  assert.equal(g.nextDeadline(), null);
});

test('una jugada ilegal no toca el reloj', () => {
  const g = started({ initial: 60, increment: 5 });
  play(g, ['e2e4', 'e7e5']);
  assert.equal(g.move('white', 'e1e3', 2, T0 + 1_000), 'Jugada ilegal');
  assert.equal(g.view(T0 + 1_000).clock.white, 59_000);
});

test('jugar con el tiempo agotado hace caer la bandera', () => {
  const g = started({ initial: 60, increment: 0 });
  play(g, ['e2e4', 'e7e5']);
  assert.equal(g.move('white', 'g1f3', 2, T0 + 60_000), 'Tiempo agotado');
  assert.equal(g.status, 'timeout');
  assert.equal(g.winner, 'black');
});

test('por tiempo son tablas si el rival no puede dar mate', () => {
  const fen = (pieces: string) => new Chess(`${pieces} w - - 0 1`);
  assert.equal(canMate(fen('4k3/8/8/8/8/8/8/4K3'), 'white'), false, 'rey solo');
  assert.equal(canMate(fen('4k3/8/8/8/8/8/8/3NK3'), 'white'), false, 'rey y caballo');
  assert.equal(canMate(fen('4k3/8/8/8/8/8/8/3BK3'), 'white'), false, 'rey y alfil');
  assert.equal(canMate(fen('4k3/8/8/8/8/8/8/2NNK3'), 'white'), true, 'dos caballos');
  assert.equal(canMate(fen('4k3/8/8/8/8/8/P7/4K3'), 'white'), true, 'un peón');

  const g = started({ initial: 60, increment: 0 });
  play(g, ['e2e4', 'e7e5']);
  g.tick(T0 + 60_000);
  assert.equal(g.status, 'timeout');
  assert.equal(g.winner, 'black', 'las negras tienen material de sobra');
});

test('sin primera jugada en 30 s la partida se anula', () => {
  const g = started();
  assert.equal(g.nextDeadline(), T0 + FIRST_MOVE_MS);
  assert.equal(g.view(T0 + 10_000).firstMoveDeadline, FIRST_MOVE_MS - 10_000);
  assert.equal(g.tick(T0 + FIRST_MOVE_MS - 1), false);
  assert.equal(g.tick(T0 + FIRST_MOVE_MS), true);
  assert.equal(g.status, 'aborted');
});

test('las negras también tienen 30 s para su primera jugada', () => {
  const g = started();
  g.move('white', 'e2e4', 0, T0 + 20_000);
  assert.equal(g.nextDeadline(), T0 + 20_000 + FIRST_MOVE_MS);
  assert.equal(g.tick(T0 + 20_000 + FIRST_MOVE_MS), true);
  assert.equal(g.status, 'aborted');
});

test('ofrecer y aceptar tablas, abandono y anulación', () => {
  const g = started();
  assert.ok(g.canAbort('white'));
  g.move('white', 'e2e4', 0, T0);
  assert.ok(!g.canAbort('white'));
  assert.ok(g.canAbort('black'));
  g.move('black', 'e7e5', 1, T0);
  g.draw('white', true, T0);
  assert.equal(g.drawOffer, 'white');
  g.draw('black', true, T0);
  assert.equal(g.status, 'draw');
  assert.equal(g.winner, null);

  const h = started();
  h.resign('white', T0);
  assert.equal(h.status, 'resign');
  assert.equal(h.winner, 'black');
});

test('la oferta de tablas caduca si el rival mueve', () => {
  const g = started();
  play(g, ['e2e4', 'e7e5']);
  g.draw('white', true, T0);
  g.move('white', 'g1f3', 2, T0);
  assert.equal(g.drawOffer, 'white', 'sigue mientras el rival no juegue');
  g.move('black', 'b8c6', 3, T0);
  assert.equal(g.drawOffer, null);
});

test('revancha con los colores cambiados', () => {
  const g = started();
  g.resign('black', T0);
  assert.equal(g.offerRematch('white', true, T0), false);
  assert.deepEqual(g.rematch, new Set(['white']));
  assert.equal(g.offerRematch('black', true, T0), true);
  assert.deepEqual(g.rematchSeats(), { white: 'black-player-00000', black: 'white-player-00000' });
});

test('toJSON / fromJSON conservan el estado y los relojes', () => {
  const g = started({ initial: 60, increment: 1 });
  play(g, ['e2e4', 'e7e5'], T0);
  g.move('white', 'g1f3', 2, T0 + 5_000);
  g.draw('white', true, T0 + 5_000);

  const copy = Game.fromJSON(JSON.parse(JSON.stringify(g)));
  const now = T0 + 12_000;
  assert.deepEqual(copy.view(now), g.view(now));
  assert.deepEqual(copy.toJSON(), g.toJSON());
  assert.equal(copy.nextDeadline(), g.nextDeadline());
  assert.equal(copy.colorOf('black-player-00000'), 'black');
});

test('tras fromJSON se detecta la triple repetición (necesita el historial)', () => {
  const g = started();
  const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
  play(g, [...shuffle, 'g1f3', 'g8f6', 'f3g1']);
  const copy = Game.fromJSON(g.toJSON());
  assert.equal(copy.move('black', 'f6g8', copy.ply, T0), null);
  assert.equal(copy.status, 'repetition');
});
