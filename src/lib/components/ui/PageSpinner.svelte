<script lang="ts">
	import Spinner from './Spinner.svelte';
	import * as m from '$lib/paraglide/messages';

	// 28px centered page-level loader. Reserved for a first render with no
	// known page structure yet (e.g. a client-side navigation with no SSR
	// data to shape a skeleton around). Never blocks an already-rendered
	// header — this app being local-first with near-zero latency and full
	// SSR on every route today, no real call site currently needs it (see
	// CLAUDE.md); kept available for a future one.
	let { label = m.common_loading_page() }: { label?: string } = $props();
</script>

<div class="flex items-center justify-center py-10" role="status">
	<Spinner size={28} speedMs={900} class="text-zinc-400" />
	<span class="sr-only">{label}</span>
</div>
