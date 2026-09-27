import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** SPA estática: Caddy sirve los archivos y cualquier ruta cae en index.html. */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: 'index.html', precompress: true })
  }
};
