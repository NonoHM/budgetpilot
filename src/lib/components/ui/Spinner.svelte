<script lang="ts">
	// Generic rotating loading icon, reused by Button's `loading` state (14px,
	// 0.8s) and by PageSpinner (28px, 0.9s) — a single component parameterized
	// by size/speed rather than two near-duplicate SVGs. Purely decorative
	// (aria-hidden): the accessible label always comes from the caller (e.g.
	// Button's sr-only loadingLabel, or PageSpinner's own sr-only text).
	let {
		size = 14,
		speedMs = 800,
		class: extraClass = ''
	}: { size?: number; speedMs?: number; class?: string } = $props();
</script>

<svg
	class="spinner-icon {extraClass}"
	style="width: {size}px; height: {size}px; --spinner-duration: {speedMs}ms;"
	viewBox="0 0 24 24"
	fill="none"
	aria-hidden="true"
>
	<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
	<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
</svg>

<style>
	.spinner-icon {
		animation: spinner-rotate var(--spinner-duration, 800ms) linear infinite;
	}

	@keyframes spinner-rotate {
		to {
			transform: rotate(360deg);
		}
	}

	/* Reduced motion: freeze as a static icon, never hide it (still conveys "loading"). */
	@media (prefers-reduced-motion: reduce) {
		.spinner-icon {
			animation: none;
		}
	}
</style>
