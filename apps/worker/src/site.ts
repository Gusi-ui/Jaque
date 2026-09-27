import { GAME_ID_RE } from '@jaque/shared';

/**
 * Todo lo que no es /api ni /ws: dominio canónico, indexación y archivos
 * estáticos con el fallback de la SPA.
 *
 * - Producción: www.<dominio> y *.workers.dev redirigen (301) al dominio canónico,
 *   para que Google indexe una sola URL. /api y /ws no se redirigen.
 * - Previews: nunca se indexan (X-Robots-Tag y robots.txt que lo prohíbe todo).
 * - Rutas desconocidas: 200.html (la SPA) con 200 si es una partida y 404 si no.
 */
export function canonicalRedirect(url: URL, env: Env): Response | null {
  const canonical = env.CANONICAL_HOST;
  if (env.ENVIRONMENT !== 'production' || !canonical || url.hostname === canonical) return null;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return null;
  if (url.hostname !== `www.${canonical}` && !url.hostname.endsWith('.workers.dev')) return null;
  return Response.redirect(`https://${canonical}${url.pathname}${url.search}`, 301);
}

const PREVIEW_ROBOTS = 'User-agent: *\nDisallow: /\n';

export async function serveSite(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const preview = env.ENVIRONMENT !== 'production';

  let res: Response;
  if (preview && url.pathname === '/robots.txt') {
    res = new Response(PREVIEW_ROBOTS, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } else {
    // /200 es el shell interno de la SPA: no debe existir como página propia.
    res = url.pathname === '/200' ? new Response(null, { status: 404 }) : await env.ASSETS.fetch(request);
    if (res.status === 404 && (request.method === 'GET' || request.method === 'HEAD')) {
      // /200 y no /200.html: los assets redirigen las rutas .html a su forma sin extensión.
      const shell = await env.ASSETS.fetch(new Request(new URL('/200', url), request));
      const isGame = GAME_ID_RE.test(url.pathname.slice(1));
      res = new Response(shell.body, { status: isGame ? 200 : 404, headers: shell.headers });
    }
  }
  if (!preview) return res;
  res = new Response(res.body, res);
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return res;
}
