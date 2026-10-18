import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spanishSan } from '../src/notation.ts';

test('spanishSan: piezas en español, el resto igual', () => {
  assert.equal(spanishSan('Nf3'), 'Cf3');
  assert.equal(spanishSan('Bxc6+'), 'Axc6+');
  assert.equal(spanishSan('Rxe8#'), 'Txe8#');
  assert.equal(spanishSan('Qh5'), 'Dh5');
  assert.equal(spanishSan('Kxg2'), 'Rxg2');
  assert.equal(spanishSan('Nbd7'), 'Cbd7'); // la columna de desambiguación no cambia
  assert.equal(spanishSan('exd8=Q+'), 'exd8=D+');
  assert.equal(spanishSan('b1=N'), 'b1=C');
  assert.equal(spanishSan('O-O-O'), 'O-O-O');
  assert.equal(spanishSan('e4'), 'e4');
});
