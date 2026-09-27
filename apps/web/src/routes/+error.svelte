<script lang="ts">
  import { page } from '$app/state';
  import { pageTitle } from '$lib/site';
</script>

<svelte:head>
  <title>{pageTitle(page.status === 404 ? 'Página no encontrada' : 'Error')}</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<section>
  <h1>{page.status === 404 ? 'Página no encontrada' : 'Algo ha fallado'}</h1>
  <p>{page.error?.message}</p>
  <a class="btn primary" href="/">Volver al inicio</a>
</section>

<style>
  section {
    display: grid;
    place-items: center;
    gap: 12px;
    padding: 18vh var(--gutter);
    text-align: center;
  }
  h1 {
    margin: 0;
  }
  p {
    margin: 0 0 8px;
    color: var(--muted);
  }
</style>
