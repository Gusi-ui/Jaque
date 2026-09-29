import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { Chess as Position } from 'chessops/chess';
import type { GameView } from '@jaque/shared';
import { Game } from '../src/index.ts';
import { bestMove, evaluate, planBot, positionAfter, type BotLevel } from '../src/bot.ts';

const noNoise = { random: () => 0.5 };

test('la evaluación es simétrica en la posición inicial', () => {
  assert.equal(evaluate(Position.default()), 0);
});

test('encuentra el mate en una (niveles medio y difícil)', () => {
  // 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? — Qxf7#
  const moves = ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6'];
  for (const level of [2, 3] as BotLevel[]) assert.equal(bestMove(moves, { level, ...noNoise }), 'h5f7', `nivel ${level}`);
});

test('las negras dan el mate del loco', () => {
  assert.equal(bestMove(['f2f3', 'e7e5', 'g2g4'], { level: 2, ...noNoise }), 'd8h4');
});

test('captura una dama colgada', () => {
  // 1.e4 Nf6 2.Qh5?? Nxh5
  assert.equal(bestMove(['e2e4', 'g8f6', 'd1h5'], { level: 2, ...noNoise }), 'f6h5');
});

test('siempre devuelve una jugada legal, y null sin jugadas', () => {
  for (const level of [1, 2, 3] as BotLevel[]) {
    const uci = bestMove(['e2e4'], { level });
    const chess = new Chess();
    chess.move('e4');
    assert.ok(chess.moves({ verbose: true }).some((m) => m.from + m.to + (m.promotion ?? '') === uci), `nivel ${level}: ${uci}`);
  }
  assert.equal(bestMove(['f2f3', 'e7e5', 'g2g4', 'd8h4']), null, 'mate: no hay jugadas');
});

test('enroca con la notación UCI estándar', () => {
  // Blancas con el camino despejado para O-O; el enroque debe salir como e1g1.
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6'];
  const legal = new Set<string>();
  for (let i = 0; i < 40; i++) legal.add(bestMove(moves, { level: 1 })!);
  assert.ok(![...legal].includes('e1h1'), 'nunca e1h1');
  assert.equal(positionAfter([...moves, 'e1g1']).board.get(6)?.role, 'king', 'el rey acaba en g1');
});

test('respeta el tiempo máximo', () => {
  let t = 0;
  const uci = bestMove(['e2e4', 'e7e5'], { level: 3, now: () => (t += 50), budget: 100 });
  assert.match(uci!, /^[a-h][1-8][a-h][1-8]$/);
});

function view(g: Game): GameView {
  return g.view(1_000);
}

test('política: se sienta, piensa en su turno y no en el del rival', () => {
  const g = new Game('AAAAAAAA', { initial: 60, increment: 0 }, 0);
  g.join('human-player-00000', 'white', 0);
  assert.deepEqual(planBot(view(g), null), { send: [{ t: 'join' }], think: false });
  g.join('bot-player-0000000', undefined, 0);
  assert.equal(planBot(view(g), 'black').think, false, 'juegan blancas');
  g.move('white', 'e2e4', 0, 0);
  assert.deepEqual(planBot(view(g), 'black'), { send: [], think: true });
});

test('política: tablas, revancha y abandono', () => {
  const g = new Game('AAAAAAAA', { initial: 60, increment: 0 }, 0);
  g.join('human-player-00000', 'white', 0);
  g.join('bot-player-0000000', 'black', 0);
  for (const [i, m] of ['e2e4', 'e7e5', 'g1f3', 'b8c6'].entries()) g.move(i % 2 ? 'black' : 'white', m, i, 0);
  g.draw('white', true, 0);
  // Posición igualada: acepta.
  assert.deepEqual(planBot(view(g), 'black').send, [{ t: 'draw', offer: true }]);

  g.resign('white', 0);
  g.offerRematch('white', true, 0);
  assert.deepEqual(planBot(view(g), 'black').send, [{ t: 'rematch', offer: true }]);

  // Sin dama y con la partida avanzada, abandona en su turno.
  const lost: GameView = { ...view(g), status: 'started', turn: 'black', drawOffer: null, moves: Array(30).fill('e2e4'), fen: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1' };
  assert.deepEqual(planBot(lost, 'black'), { send: [{ t: 'resign' }], think: false });
});

test('política: acepta siempre deshacer y nunca lo pide', () => {
  const g = new Game('AAAAAAAA', { initial: 60, increment: 0 }, 0);
  g.join('human-player-00000', 'white', 0);
  g.join('bot-player-0000000', 'black', 0);
  for (const [i, m] of ['e2e4', 'e7e5', 'g1f3'].entries()) g.move(i % 2 ? 'black' : 'white', m, i, 0);
  g.takeback('white', true, undefined, 0);
  assert.deepEqual(planBot(view(g), 'black'), { send: [{ t: 'takeback', offer: true, ply: 3 }], think: false });
  g.takeback('black', true, undefined, 0);
  assert.deepEqual(planBot(view(g), 'black').send, []);
});
