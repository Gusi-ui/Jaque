import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * SPA estática. La portada se prerenderiza (index.html) y el resto de rutas
 * caen en 200.html, que arranca la aplicación en el navegador.
 */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: '200.html', precompress: true }),
    // Tras un despliegue, los archivos de la versión anterior dejan de existir.
    // Se comprueba cada minuto si hay una versión nueva (ver +layout.svelte).
    version: { pollInterval: 60_000 }
  }
};
