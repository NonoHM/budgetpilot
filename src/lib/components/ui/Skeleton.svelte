<script lang="ts">
	// Placeholder mirroring a real ListCard row's slots (see ui/ListCard.svelte):
	// a 38px icon/pastille + two text lines + a trailing value — never a lone
	// generic rectangle. Purely decorative (aria-hidden): the caller is
	// expected to keep an accessible "loading" announcement elsewhere (e.g. a
	// role="status" region wrapping a list of these), same pattern as
	// PageSpinner.
	import { cardBase } from '$lib/styles';

	let { class: extraClass = '' }: { class?: string } = $props();
</script>

<div class="flex items-center gap-3 {cardBase} p-4 {extraClass}" aria-hidden="true">
	<div class="skeleton-pulse h-[38px] w-[38px] shrink-0 rounded-full bg-zinc-200"></div>
	<div class="min-w-0 flex-1 space-y-2">
		<div class="skeleton-pulse h-3 w-3/5 rounded bg-zinc-200"></div>
		<div class="skeleton-pulse h-2.5 w-2/5 rounded bg-zinc-200"></div>
	</div>
	<div class="skeleton-pulse h-3 w-12 shrink-0 rounded bg-zinc-200"></div>
</div>

<style>
	.skeleton-pulse {
		animation: skeleton-pulse 1.6s ease-in-out infinite;
	}

	@keyframes skeleton-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}

	/* Reduced motion: stay a static skeleton (still readable as a placeholder), just no pulse. */
	@media (prefers-reduced-motion: reduce) {
		.skeleton-pulse {
			animation: none;
			opacity: 1;
		}
	}
</style>
