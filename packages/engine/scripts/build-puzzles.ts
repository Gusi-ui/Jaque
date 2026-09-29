// Genera src/puzzles.json a partir de la base abierta (CC0) de problemas de lichess.
// Uso: pnpm --filter @jaque/engine puzzles   (descarga unos 270 MB)
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';
import { Chess } from 'chess.js';
import { GROUPS, GROUP_SIZE, type PuzzleEntry } from '../src/puzzle.ts';

const URL_DB = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';

interface Candidate {
  entry: PuzzleEntry;
  popularity: number;
  plays: number;
}

/**
 * La base viene en formato pzstd: cada trozo comprimido va precedido de un
 * «skippable frame» con su tamaño, y el descompresor de Node no los acepta.
 * Se quitan y se deja pasar solo lo comprimido.
 */
async function* withoutSkippableFrames(input: AsyncIterable<Uint8Array>) {
  let buf = Buffer.alloc(0);
  let pass = 0; // bytes del trozo actual que faltan por dejar pasar
  for await (const chunk of input) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    while (buf.length) {
      if (pass > 0) {
        const n = Math.min(pass, buf.length);
        yield buf.subarray(0, n);
        buf = buf.subarray(n);
        pass -= n;
        continue;
      }
      if (buf.length < 8) break;
      if ((buf.readUInt32LE(0) & 0xfffffff0) !== 0x184d2a50) {
        pass = Infinity; // zstd normal, sin trozos
        continue;
      }
      const size = buf.readUInt32LE(4);
      if (buf.length < 8 + size) break;
      pass = size === 4 ? buf.readUInt32LE(8) : Infinity;
      buf = buf.subarray(8 + size);
    }
  }
}

const res = await fetch(URL_DB);
if (!res.ok || !res.body) throw new Error(`Descarga fallida: ${res.status}`);
const csv = createZstdDecompress();
pipeline(Readable.from(withoutSkippableFrames(res.body)), csv).catch((err) => {
  console.error(err);
  process.exit(1);
});

const buckets: Candidate[][] = GROUPS.map(() => []);
let header = true;
let rows = 0;
for await (const line of createInterface({ input: csv, crlfDelay: Infinity })) {
  if (header) {
    header = false;
    continue;
  }
  rows++;
  // PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
  const [id, fen, moves, rating, deviation, popularity, plays, themes] = line.split(',');
  if (Number(popularity) < 90 || Number(plays) < 1000 || Number(deviation) >= 80) continue;
  const goal = Number(/\bmateIn([123])\b/.exec(themes)?.[1]);
  const r = Number(rating);
  const g = GROUPS.findIndex((x) => x.goal === goal && r >= x.min && r < x.max);
  if (g < 0) continue;

  // La primera jugada es la del rival: la posición del problema es la de después.
  const [first, ...solution] = moves.split(' ');
  const chess = new Chess(fen);
  const move = (uci: string) => chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  move(first);
  const start = chess.fen();
  solution.forEach(move);
  if (!chess.isCheckmate()) continue;

  buckets[g].push({ entry: [id, start, solution.join(' '), r], popularity: Number(popularity), plays: Number(plays) });
}

// Si la descarga se corta, readline termina sin error: mejor fallar que escribir una lista pobre.
if (rows < 1_000_000) throw new Error(`Solo se han leído ${rows} filas`);

const days = buckets.map((b, i) => {
  if (b.length < GROUP_SIZE) throw new Error(`Grupo ${i}: solo ${b.length} problemas`);
  return b
    .sort((a, z) => z.popularity - a.popularity || z.plays - a.plays)
    .slice(0, GROUP_SIZE)
    .map((c) => c.entry)
    .sort((a, z) => a[0].localeCompare(z[0]));
});

// Un problema por línea: diffs legibles.
const json = `{"v":1,"days":[\n${days.map((d) => `[\n${d.map((e) => JSON.stringify(e)).join(',\n')}\n]`).join(',\n')}\n]}\n`;
writeFileSync(new URL('../src/puzzles.json', import.meta.url), json);
console.log(`puzzles.json: ${days.map((d) => d.length).join(' + ')} problemas`);
