import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GROUPS,
  GROUP_SIZE,
  PER_DAY,
  PuzzleRun,
  dayKey,
  puzzlesOfDay,
  type DailyPuzzle,
  type PuzzleData,
  type PuzzleEntry
} from '../src/puzzle.ts';

const puzzle = (fen: string, solution: string[]): DailyPuzzle => ({
  key: '2026-01-05',
  n: 0,
  id: 'x',
  fen,
  solution,
  goal: Math.ceil(solution.length / 2)
});

// 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? — Qxf7#
const SCHOLAR = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
// Ra8# y Re8# dan mate los dos.
const BACK_RANK = '6k1/5ppp/8/8/8/8/5PPP/R3R1K1 w - - 0 1';
// Mate en 2: Re8+ Rxe8 Rxe8#.
const DOUBLED = '3r2k1/5ppp/8/8/8/8/4RPPP/4R1K1 w - - 0 1';
// h8=D# (y h8=T# también).
const PROMO = 'k7/7P/1K6/8/8/8/8/8 w - - 0 1';

test('dayKey cambia a medianoche de Madrid', () => {
  assert.equal(dayKey(new Date('2026-07-15T21:59:00Z')), '2026-07-15');
  assert.equal(dayKey(new Date('2026-07-15T22:30:00Z')), '2026-07-16'); // verano, UTC+2
  assert.equal(dayKey(new Date('2026-01-15T22:30:00Z')), '2026-01-15'); // invierno, UTC+1
  assert.equal(dayKey(new Date('2026-01-15T23:00:00Z')), '2026-01-16');
});

test('puzzlesOfDay: un grupo por día de la semana, tres al día y vuelta al empezar', () => {
  // Dos semanas por grupo: bloques [0, 1] (primer problema), [2, 3] y [4, 5].
  const data: PuzzleData = {
    v: 1,
    days: Array.from({ length: 7 }, (_, d) =>
      Array.from({ length: 2 * PER_DAY }, (_, i): PuzzleEntry => [`d${d}-${i}`, SCHOLAR, 'h5f7', 1000])
    )
  };
  const ids = (iso: string) => puzzlesOfDay(new Date(iso), data).map((p) => p.id);
  assert.deepEqual(ids('2026-01-05T10:00:00Z'), ['d0-0', 'd0-2', 'd0-4']); // lunes de referencia
  assert.deepEqual(ids('2026-01-11T10:00:00Z'), ['d6-0', 'd6-2', 'd6-4']); // domingo
  assert.deepEqual(ids('2026-01-12T10:00:00Z'), ['d0-1', 'd0-3', 'd0-5']); // lunes siguiente
  assert.deepEqual(ids('2026-01-19T10:00:00Z'), ['d0-0', 'd0-2', 'd0-4']); // vuelta al principio
  assert.deepEqual(ids('2026-01-04T10:00:00Z'), ['d6-1', 'd6-3', 'd6-5']); // antes de la referencia
  const [p] = puzzlesOfDay(new Date('2026-01-05T10:00:00Z'), data);
  assert.deepEqual(p, { key: '2026-01-05', n: 0, id: 'd0-0', fen: SCHOLAR, solution: ['h5f7'], goal: 1 });
});

test('puzzlesOfDay: el primer problema de cada día es el de la lista original', () => {
  const data = JSON.parse(readFileSync(new URL('../src/puzzles.json', import.meta.url), 'utf8')) as PuzzleData;
  // Lunes 19-10-2026 (semana 41): antes de ampliar la lista salía data.days[0][41].
  assert.equal(puzzlesOfDay(new Date('2026-10-19T10:00:00Z'), data)[0].id, data.days[0][41][0]);
});

test('GROUPS: siete grupos, mates en 1, 1, 2, 2, 2, 3, 3', () => {
  assert.deepEqual(GROUPS.map((g) => g.goal), [1, 1, 2, 2, 2, 3, 3]);
});

test('mate en 1: acierto y fallo', () => {
  const run = new PuzzleRun(puzzle(SCHOLAR, ['h5f7']));
  assert.equal(run.side, 'white');
  assert.equal(run.play('a1a8'), 'wrong', 'una jugada ilegal es un fallo');
  assert.equal(run.missed, false, 'la ilegal no queda en el tablero');
  assert.equal(run.play('h5h6'), 'wrong');
  assert.ok(run.missed, 'la fallada queda pendiente');
  assert.equal(run.play('h5f7'), 'wrong', 'hasta decidir, no se juega');
  run.retry();
  assert.equal(run.fen, SCHOLAR, 'volver a intentarlo deshace la jugada');
  assert.equal(run.play('h5f7'), 'solved');
  assert.ok(run.solved);
  assert.deepEqual(run.lastMove, ['h5', 'f7']);
});

test('cualquier mate vale', () => {
  const run = new PuzzleRun(puzzle(BACK_RANK, ['a1a8']));
  assert.equal(run.play('e1e8'), 'solved');
});

test('mate en 2: contestación con step()', () => {
  const run = new PuzzleRun(puzzle(DOUBLED, ['e2e8', 'd8e8', 'e1e8']));
  assert.equal(run.hint(), 'e2');
  assert.equal(run.play('g1f1'), 'wrong');
  run.retry();
  assert.deepEqual(run.play('e2e8'), { reply: 'd8e8' });
  assert.equal(run.turn, 'black');
  assert.equal(run.step(), 'd8e8');
  assert.equal(run.turn, 'white');
  assert.equal(run.hint(), 'e1');
  assert.equal(run.play('e1e8'), 'solved');
  assert.equal(run.hint(), undefined);
});

test('rechaza jugadas fuera de turno o tras resolver', () => {
  const run = new PuzzleRun(puzzle(DOUBLED, ['e2e8', 'd8e8', 'e1e8']));
  run.play('e2e8');
  assert.equal(run.play('d8e8'), 'wrong', 'no es turno de quien resuelve');
  run.step();
  run.play('e1e8');
  assert.equal(run.play('g1f1'), 'wrong');
  assert.equal(run.dests().size, 0);
});

test('step() reproduce la solución entera', () => {
  const run = new PuzzleRun(puzzle(DOUBLED, ['e2e8', 'd8e8', 'e1e8']));
  const played: string[] = [];
  for (let m = run.step(); m; m = run.step()) played.push(m);
  assert.deepEqual(played, ['e2e8', 'd8e8', 'e1e8']);
  assert.ok(run.solved);
  assert.deepEqual(run.sans, ['Re8+', 'Rxe8', 'Rxe8#']);
});

test('coronación: completa la pieza y acepta otra que dé mate', () => {
  const run = new PuzzleRun(puzzle(PROMO, ['h7h8q']));
  assert.equal(run.uci('h7', 'h8'), 'h7h8q');
  assert.equal(run.uci('b6', 'b5'), 'b6b5');
  assert.equal(run.play('h7h8r'), 'solved');
});

test('isPromotion: solo un peón que llega a la última fila', () => {
  const run = new PuzzleRun(puzzle(PROMO, ['h7h8q']));
  assert.equal(run.isPromotion('h7', 'h8'), true);
  assert.equal(run.isPromotion('b6', 'b7'), false, 'el rey no corona');
  const other = new PuzzleRun(puzzle(SCHOLAR, ['h5f7']));
  assert.equal(other.isPromotion('e4', 'e5'), false, 'un peón que no llega a la última fila');
});

test('dests: solo las del bando que mueve', () => {
  const run = new PuzzleRun(puzzle(PROMO, ['h7h8q']));
  assert.deepEqual(run.dests().get('h7'), ['h8']);
});

test('puzzles.json: 7 grupos de 159, soluciones legales que acaban en mate', () => {
  const data = JSON.parse(readFileSync(new URL('../src/puzzles.json', import.meta.url), 'utf8')) as PuzzleData;
  assert.equal(data.v, 1);
  assert.equal(data.days.length, 7);
  const ids = new Set<string>();
  data.days.forEach((group, d) => {
    assert.equal(group.length, GROUP_SIZE, `grupo ${d}`);
    for (const [id, fen, moves, rating] of group) {
      assert.ok(!ids.has(id), `repetido ${id}`);
      ids.add(id);
      assert.ok(rating >= GROUPS[d].min && rating < GROUPS[d].max, `${id}: Elo ${rating}`);
      const solution = moves.split(' ');
      assert.equal(Math.ceil(solution.length / 2), GROUPS[d].goal, `${id}: mate en ${GROUPS[d].goal}`);
      const run = new PuzzleRun({ key: '', n: 0, id, fen, solution, goal: GROUPS[d].goal });
      for (let i = 0; i < solution.length; i += 2) {
        const r = run.play(solution[i]);
        if (i === solution.length - 1) assert.equal(r, 'solved', id);
        else {
          assert.deepEqual(r, { reply: solution[i + 1] }, id);
          run.step();
        }
      }
    }
  });
});

test('seguir la línea: partida libre desde la jugada fallada', () => {
  const run = new PuzzleRun(puzzle(DOUBLED, ['e2e8', 'd8e8', 'e1e8']));
  assert.equal(run.play('g1f1'), 'wrong');
  run.follow();
  assert.ok(run.line && !run.missed);
  assert.equal(run.hint(), undefined, 'sin pistas fuera del problema');
  assert.equal(run.step(), undefined, 'ni solución');
  assert.equal(run.play('h2h3'), 'wrong', 'play() es solo para el problema');
  assert.equal(run.turn, 'black');
  assert.ok(run.playLine('h7h6'), 'juega la máquina');
  assert.ok(run.playLine('h2h3'), 'y luego quien resuelve');
  assert.equal(run.playLine('a1a8'), false, 'una ilegal no se juega');
  assert.deepEqual(run.ucis, ['g1f1', 'h7h6', 'h2h3']);
  assert.equal(run.outcome, undefined);
});

test('seguir la línea: victoria, derrota y tablas', () => {
  // Fallar Re8+ y dar el mate igual dos jugadas después.
  const win = new PuzzleRun(puzzle(DOUBLED, ['e2e8', 'd8e8', 'e1e8']));
  win.play('h2h3');
  win.follow();
  win.playLine('d8c8');
  win.playLine('e2e8');
  win.playLine('c8e8');
  win.playLine('e1e8');
  assert.equal(win.outcome, 'win');
  assert.equal(win.solved, true);
  assert.equal(win.playLine('g8h8'), false, 'terminada, no se juega más');

  // Avanzar un peón deja el mate en la primera fila a las negras.
  const loss = new PuzzleRun(puzzle('3r2k1/5ppp/8/8/P7/8/5PPP/6K1 w - - 0 1', ['g1f1']));
  loss.play('a4a5');
  loss.follow();
  loss.playLine('d8d1');
  assert.equal(loss.outcome, 'loss');

  // Dc7 en lugar de Dc8#: rey ahogado, tablas en cuanto se sigue la línea.
  const draw = new PuzzleRun(puzzle('k7/8/1K6/8/8/8/8/2Q5 w - - 0 1', ['c1c8']));
  draw.play('c1c7');
  assert.equal(draw.outcome, undefined, 'aún no se sigue la línea');
  draw.follow();
  assert.equal(draw.outcome, 'draw');
});
