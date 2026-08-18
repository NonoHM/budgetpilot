<script lang="ts">
	import { cardBase } from '$lib/styles';

	/**
	 * Brique 9's skeleton, AT THE DESTINATION THAT CAN SHOW ONE (Planche 5f).
	 *
	 * ## It was built on a screen that structurally cannot show it
	 *
	 * The designation screen's cards exist because the file is already read in memory: there is no
	 * instant at which the structure is known and the content absent. Its `analysing` prop was set by
	 * NO route, which is this repository's own check firing rather than an opinion, and the state was
	 * therefore drafted rather than built.
	 *
	 * `/imports` on arrival is the destination that always has that instant: a server write followed
	 * by a list re-read, two round trips one of which writes the rows. The 300 ms threshold is crossed
	 * even on a fast network, which is why the plate says this is where it was really missing.
	 *
	 * ## The threshold is a filter, and the floor is what makes it one
	 *
	 * Past 300 ms only. A screen that beats the threshold shows nothing, and that is the intended
	 * behaviour rather than evidence the skeleton is useless. And once shown it holds for at least
	 * 300 ms: without an exit floor an answer arriving at 320 ms produces a 20 ms flicker, the exact
	 * opposite of what the entry threshold protects.
	 *
	 * Same slots as the real card, never a generic rectangle: it announces the shape of what is
	 * coming rather than a placeholder for anything at all. Pulse 1.6 s, brique 9 unchanged.
	 */
	let { rows = 3 }: { rows?: number } = $props();
</script>

<div class="space-y-3" role="status" aria-label="Chargement en cours" data-testid="imports-skeleton">
	{#each Array.from({ length: rows }, (_, i) => i) as row (row)}
		<div class="{cardBase} p-4" aria-hidden="true">
			<div class="flex items-start justify-between gap-3">
				<div class="skeleton-pulse h-4 w-40 rounded bg-zinc-200"></div>
				<div class="skeleton-pulse h-[22px] w-24 shrink-0 rounded-full bg-zinc-200"></div>
			</div>
			<div class="skeleton-pulse mt-2 h-3 w-32 rounded bg-zinc-200"></div>
			<div class="skeleton-pulse mt-2 h-3 w-48 rounded bg-zinc-200"></div>
			<div class="mt-3 flex gap-4">
				<div class="skeleton-pulse h-3 w-14 rounded bg-zinc-200"></div>
				<div class="skeleton-pulse h-3 w-20 rounded bg-zinc-200"></div>
				<div class="skeleton-pulse h-3 w-20 rounded bg-zinc-200"></div>
				<div class="skeleton-pulse h-3 w-16 rounded bg-zinc-200"></div>
			</div>
			<div class="mt-3 flex items-center justify-end gap-3 border-t border-zinc-100 pt-3">
				<div class="skeleton-pulse h-4 w-10 rounded bg-zinc-200"></div>
				<div class="skeleton-pulse h-6 w-6 rounded bg-zinc-200"></div>
			</div>
		</div>
	{/each}
</div>

<style>
	.skeleton-pulse {
		animation: import-card-skeleton-pulse 1.6s ease-in-out infinite;
	}

	@keyframes import-card-skeleton-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}

	/* Reduced motion: still a skeleton, just not pulsing. */
	@media (prefers-reduced-motion: reduce) {
		.skeleton-pulse {
			animation: none;
			opacity: 1;
		}
	}
</style>
