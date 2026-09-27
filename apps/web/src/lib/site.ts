/** Datos públicos del sitio, para títulos, URL canónicas y datos estructurados. */
export const SITE = {
  name: 'DameJaque',
  url: (import.meta.env.VITE_SITE_URL as string | undefined) ?? 'https://damejaque.online',
  title: 'DameJaque · Ajedrez online gratis y sin registro',
  description:
    'Juega al ajedrez online gratis y sin registro: partidas rápidas por ritmo, reta a un amigo con un enlace o juega contra la máquina. Bullet, blitz y rápidas.'
};

/** Título de página con la marca detrás. */
export const pageTitle = (title: string) => `${title} · ${SITE.name}`;
