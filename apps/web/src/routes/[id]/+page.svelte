<script lang="ts">
  import { page } from '$app/state';
  import Game from '$lib/Game.svelte';
</script>

<!-- #key: al saltar a la revancha se crea un componente nuevo con estado limpio -->
{#key page.params.id}
  <Game id={page.params.id!} />
{/key}
