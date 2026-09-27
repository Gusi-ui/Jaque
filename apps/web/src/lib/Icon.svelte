<script lang="ts">
  type Name = 'first' | 'prev' | 'next' | 'last' | 'flip' | 'share';
  let { name, size = 18 }: { name: Name; size?: number } = $props();

  const paths: Record<Name, string> = {
    first: 'M6 5v14M18 6l-8 6 8 6z',
    prev: 'M16 6l-8 6 8 6z',
    next: 'M8 6l8 6-8 6z',
    last: 'M18 5v14M6 6l8 6-8 6z',
    flip: 'M7 4v13m0 0-3-3m3 3 3-3M17 20V7m0 0 3 3m-3-3-3 3',
    share: 'M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7'
  };
  const filled = (n: Name) => n !== 'flip' && n !== 'share';
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={filled(name) ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d={paths[name]} />
</svg>
