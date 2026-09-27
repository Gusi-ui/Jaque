import { describe, expect, it } from 'vitest';
import { canonicalRedirect, serveSite } from '../src/site';

const prod = { ENVIRONMENT: 'production', CANONICAL_HOST: 'damejaque.online' } as unknown as Env;
const preview = { ENVIRONMENT: 'preview', CANONICAL_HOST: '' } as unknown as Env;

/** Assets falsos: /, /200 y /robots.txt existen; lo demás es 404. */
const withAssets = (env: Env): Env =>
  ({
    ...env,
    ASSETS: {
      fetch: async (req: Request) => {
        const { pathname } = new URL(req.url);
        const files: Record<string, string> = { '/': 'portada', '/200': 'spa', '/robots.txt': 'Allow: /' };
        return pathname in files
          ? new Response(files[pathname], { headers: { 'Content-Type': 'text/html' } })
          : new Response('no', { status: 404 });
      }
    }
  }) as unknown as Env;

const redirect = (url: string, env = prod) => canonicalRedirect(new URL(url), env);

describe('dominio canónico', () => {
  it('redirige www y workers.dev a damejaque.online con 301, conservando ruta y consulta', () => {
    for (const from of ['https://www.damejaque.online/AbCdEfGh?x=1', 'https://jaque.gusideveloper.workers.dev/AbCdEfGh?x=1']) {
      const r = redirect(from)!;
      expect(r.status).toBe(301);
      expect(r.headers.get('Location')).toBe('https://damejaque.online/AbCdEfGh?x=1');
    }
  });

  it('no redirige el dominio canónico, /api, /ws, local ni las Previews', () => {
    expect(redirect('https://damejaque.online/')).toBeNull();
    expect(redirect('https://www.damejaque.online/api/health')).toBeNull();
    expect(redirect('https://jaque.gusideveloper.workers.dev/ws/lobby')).toBeNull();
    expect(redirect('http://localhost:8787/')).toBeNull();
    expect(redirect('https://develop-jaque.gusideveloper.workers.dev/', preview)).toBeNull();
  });
});

describe('assets y fallback de la SPA', () => {
  const get = (path: string, env = prod) => serveSite(new Request(`https://damejaque.online${path}`), withAssets(env));

  it('sirve los archivos y el shell de la SPA: 200 en partidas, 404 en el resto', async () => {
    expect(await (await get('/')).text()).toBe('portada');
    const game = await get('/AbCdEfGh');
    expect([game.status, await game.text()]).toEqual([200, 'spa']);
    const missing = await get('/no-existe');
    expect([missing.status, await missing.text()]).toEqual([404, 'spa']);
    expect((await get('/200')).status).toBe(404);
  });

  it('producción se indexa; las Previews no', async () => {
    expect((await get('/')).headers.get('X-Robots-Tag')).toBeNull();
    expect((await get('/robots.txt')).headers.get('X-Robots-Tag')).toBeNull();

    const page = await get('/', preview);
    expect(page.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(await (await get('/robots.txt', preview)).text()).toBe('User-agent: *\nDisallow: /\n');
  });
});
