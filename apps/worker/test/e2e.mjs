// Extremo a extremo: arranca `wrangler dev` y ejecuta contra él las mismas
// pruebas que el servidor Node (apps/server/test/server.test.ts), cambiando solo la URL base.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const worker = path.resolve(import.meta.dirname, '..');
const server = path.resolve(worker, '../server');
const web = path.resolve(worker, '../web');
const port = 8800 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${port}`;
const persist = mkdtempSync(path.join(tmpdir(), 'jaque-e2e-'));
const wrangler = path.join(worker, 'node_modules/.bin/wrangler');

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(path.join(web, 'build/index.html'))) run('pnpm', ['build'], web);
run(wrangler, ['d1', 'migrations', 'apply', 'jaque', '--local', '--persist-to', persist], worker);

const dev = spawn(
  wrangler,
  ['dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist, '--show-interactive-dev-session=false'],
  { cwd: worker, stdio: ['ignore', 'inherit', 'inherit'] }
);
const stop = () => {
  dev.kill('SIGTERM');
  rmSync(persist, { recursive: true, force: true });
};

let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await new Promise((ok) => setTimeout(ok, 500));
  ready = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
}
if (!ready) {
  console.error('wrangler dev no arrancó');
  stop();
  process.exit(1);
}

const tests = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-force-exit', 'test/server.test.ts'], {
  cwd: server,
  env: { ...process.env, BASE_URL: base },
  stdio: 'inherit'
});
const code = await new Promise((ok) => tests.on('exit', ok));
stop();
process.exit(code ?? 1);
