import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const api = process.env.API_URL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      '/api': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true }
    }
  }
});
