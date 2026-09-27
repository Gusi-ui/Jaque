import { RESULT_TEXT, type Color, type GameStatus } from '@jaque/shared';

export const colorName = (c: Color) => (c === 'white' ? 'Blancas' : 'Negras');

/** 5:03, o 0:08.4 por debajo de 10 s. */
export function formatClock(ms: number) {
  const t = Math.max(0, ms);
  const totalSec = t < 10_000 ? Math.floor(t / 100) / 10 : Math.floor(t / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  if (t < 10_000) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function scoreText(winner: Color | null, status: GameStatus) {
  if (status === 'aborted') return '·';
  return winner === 'white' ? '1–0' : winner === 'black' ? '0–1' : '½–½';
}

export function resultText(status: GameStatus, winner: Color | null) {
  if (status === 'waiting' || status === 'started') return '';
  const base = RESULT_TEXT[status];
  if (status === 'timeout' && !winner) return 'Tiempo agotado; el rival no puede dar mate: tablas';
  return winner ? `${base}. Ganan ${colorName(winner).toLowerCase()}` : base;
}
