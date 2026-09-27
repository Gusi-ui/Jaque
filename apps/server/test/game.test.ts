import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Game, FIRST_MOVE_MS } from '../src/game.js';

const blitz = { initial: 180, increment: 2 };

function started(tc = blitz) {
  const g = new Game('AAAAAAAA', tc);
  g.join('white-player-00000', 'white');
  g.join('black-player-00000');
  return g;
}

test('dos jugadores empiezan la partida', () => {
  const g = started();
  assert.equal(g.status, 'started');
  assert.equal(g.colorOf('black-player-00000'), 'black');
  g.dispose();
});

test('mate del pastor', () => {
  const g = started();
  const seq = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7'];
  seq.forEach((m, i) => assert.equal(g.move(i % 2 ? 'black' : 'white', m, i), null, m));
  assert.equal(g.status, 'mate');
  assert.equal(g.winner, 'white');
  assert.deepEqual(g.sans.at(-1), 'Qxf7#');
});

test('rechaza jugadas ilegales, fuera de turno y desfasadas', () => {
  const g = started();
  assert.equal(g.move('black', 'e7e5', 0), 'No es tu turno');
  assert.equal(g.move('white', 'e2e5', 0), 'Jugada ilegal');
  assert.equal(g.move('white', 'e2e4', 3), 'Jugada desfasada');
  assert.equal(g.move('white', 'hola', 0), 'Formato de jugada no válido');
  assert.equal(g.move('white', 'e2e4', 0), null);
  g.dispose();
});

test('coronación', () => {
  const g = started();
  const seq = ['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'c8b7', 'a6b7', 'h7h6', 'b7a8n'];
  seq.forEach((m, i) => assert.equal(g.move(i % 2 ? 'black' : 'white', m, i), null, m));
  assert.equal(g.sans.at(-1), 'bxa8=N');
  g.dispose();
});

test('el reloj arranca tras la 2ª jugada, suma incremento y la bandera cae', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const g = started({ initial: 60, increment: 1 });
    g.move('white', 'e2e4', 0);
    mock.timers.tick(10_000);
    g.move('black', 'e7e5', 1);
    assert.equal(g.view().clock.white, 60_000, 'antes de la 2ª jugada no corre');
    mock.timers.tick(5_000);
    g.move('white', 'g1f3', 2);
    assert.equal(g.view().clock.white, 56_000, '60 − 5 + 1');
    assert.equal(g.view().clock.running, 'black');
    mock.timers.tick(60_000);
    assert.equal(g.status, 'timeout');
    assert.equal(g.winner, 'white');
  } finally {
    mock.timers.reset();
  }
});

test('sin primera jugada en 30 s la partida se anula', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  try {
    const g = started();
    mock.timers.tick(FIRST_MOVE_MS + 1);
    assert.equal(g.status, 'aborted');
  } finally {
    mock.timers.reset();
  }
});

test('ofrecer y aceptar tablas, abandono y anulación', () => {
  const g = started();
  assert.ok(g.canAbort('white'));
  g.move('white', 'e2e4', 0);
  assert.ok(!g.canAbort('white'));
  assert.ok(g.canAbort('black'));
  g.move('black', 'e7e5', 1);
  g.draw('white', true);
  assert.equal(g.drawOffer, 'white');
  g.draw('black', true);
  assert.equal(g.status, 'draw');
  assert.equal(g.winner, null);

  const h = started();
  h.resign('white');
  assert.equal(h.status, 'resign');
  assert.equal(h.winner, 'black');
});

test('la oferta de tablas caduca si el rival mueve', () => {
  const g = started();
  g.move('white', 'e2e4', 0);
  g.move('black', 'e7e5', 1);
  g.draw('white', true);
  g.move('white', 'g1f3', 2);
  assert.equal(g.drawOffer, 'white', 'sigue mientras el rival no juegue');
  g.move('black', 'b8c6', 3);
  assert.equal(g.drawOffer, null);
  g.dispose();
});
