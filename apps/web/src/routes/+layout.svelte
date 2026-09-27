<script lang="ts">
  import '../app.css';
  let { children } = $props();
</script>

<header class="top">
  <a class="brand" href="/" aria-label="jaque, inicio">
    <svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true">
      <rect x="0" y="0" width="8" height="8" fill="var(--brass)" />
      <rect x="8" y="8" width="8" height="8" fill="var(--brass)" />
      <rect x="8" y="0" width="8" height="8" fill="var(--line)" />
      <rect x="0" y="8" width="8" height="8" fill="var(--line)" />
    </svg>
    jaque
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
