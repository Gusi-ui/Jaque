// Empaqueta el servidor (y @jaque/shared) en un único archivo.
// uWebSockets.js queda fuera porque incluye binarios nativos.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['uWebSockets.js'],
  sourcemap: true,
  logLevel: 'info'
});
