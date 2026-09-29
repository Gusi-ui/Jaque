<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { updated } from '$app/state';
  import { SITE } from '$lib/site';
  let { children } = $props();

  // Con una versión nueva publicada, la siguiente navegación recarga la página
  // entera: la pestaña vieja pediría archivos que ya no existen.
  beforeNavigate(({ willUnload, to }) => {
    if (updated.current && !willUnload && to?.url) location.href = to.url.href;
  });

  /** Última recarga por un módulo que no se pudo descargar (para no entrar en bucle). */
  const RELOAD_KEY = 'jaque:recarga-version';

  onMount(() => {
    // Si aun así falla la descarga de un módulo, se recarga una vez.
    const onPreloadError = (e: Event) => {
      try {
        if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY)) < 60_000) return;
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      } catch {
        return;
      }
      e.preventDefault();
      location.reload();
    };
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => window.removeEventListener('vite:preloadError', onPreloadError);
  });
</script>

<header class="top">
  <a class="brand" href="/" aria-label="{SITE.name}, inicio">
    <svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true">
      <rect x="0" y="0" width="8" height="8" fill="var(--brass)" />
      <rect x="8" y="8" width="8" height="8" fill="var(--brass)" />
      <rect x="8" y="0" width="8" height="8" fill="var(--line)" />
      <rect x="0" y="8" width="8" height="8" fill="var(--line)" />
    </svg>
    {SITE.name}
  </a>
</header>

<main>
  {@render children()}
</main>

<style>
  .top {
    display: flex;
    align-items: center;
    height: 56px;
    padding: 0 var(--gutter);
    max-width: 1100px;
    margin: 0 auto;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-weight: 800;
    font-size: 1.3rem;
    letter-spacing: -0.04em;
    text-decoration: none;
  }
  .brand svg {
    border-radius: 4px;
  }
</style>
