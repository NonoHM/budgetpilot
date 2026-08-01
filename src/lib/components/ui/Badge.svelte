<script lang="ts">
	import type { Snippet } from 'svelte';

	// Generic status/count badge. `tone="count"` is a local addition (not part
	// of the source design-system spec) for numeric counter pills (e.g. number
	// of transactions to classify) — everything else mirrors the reference
	// component 1:1.
	let {
		tone,
		shape = 'pill',
		bordered = false,
		solid = false,
		class: extraClass = '',
		children
	}: {
		tone: 'neutral' | 'success' | 'warning' | 'danger' | 'count';
		shape?: 'pill' | 'rounded';
		bordered?: boolean;
		solid?: boolean;
		// Escape hatch for the two documented recolourings the upcoming-bills design mandates:
		// the uncertain confidence tier (zinc-400) and any tier badge sitting on an overdue row
		// (amber-800 on amber-100). Both override a colour this component already sets, so they
		// must be written with Tailwind's `!` modifier — two utilities of the same property have
		// equal specificity and stylesheet order, not attribute order, decides the winner.
		class?: string;
		children: Snippet;
	} = $props();

	// `solid` is reserved for two documented cases: the "reached" savings-goal
	// exception (success tone) and the "active/primary" solid black state
	// (neutral tone, e.g. admin role badge) — silently ignored for any other
	// tone rather than producing an undocumented color combination.
	const isSolidSuccess = $derived(solid && tone === 'success');
	const isSolidNeutral = $derived(solid && tone === 'neutral');

	const toneClasses = $derived.by(() => {
		if (tone === 'count') {
			return 'bg-zinc-900 text-white';
		}
		if (bordered) {
			if (tone === 'neutral') return 'border border-zinc-200 text-zinc-600 bg-transparent';
			if (tone === 'success') return 'border border-emerald-200 text-emerald-700 bg-transparent';
			if (tone === 'warning') return 'border border-amber-200 text-amber-700 bg-transparent';
			return 'border border-rose-200 text-rose-700 bg-transparent';
		}
		if (isSolidSuccess) return 'bg-emerald-700 text-white';
		if (isSolidNeutral) return 'bg-zinc-900 text-white';
		if (tone === 'neutral') return 'bg-zinc-100 text-zinc-600';
		if (tone === 'success') return 'bg-emerald-50 text-emerald-700';
		if (tone === 'warning') return 'bg-amber-50 text-amber-700';
		return 'bg-rose-50 text-rose-700';
	});

	const shapeClasses = $derived(
		tone === 'count'
			? 'rounded-full h-[22px] min-w-[22px] px-1.5'
			: shape === 'rounded'
				? 'h-[19px] px-1.5 rounded-[5px]'
				: 'h-[22px] px-2.5 rounded-full'
	);

	const textClasses = $derived(
		tone === 'count'
			? 'text-[11px] font-semibold tabular-nums'
			: shape === 'rounded'
				? 'text-[10px] font-bold uppercase'
				: 'text-[11px] font-bold uppercase'
	);
</script>

<span
	class="inline-flex items-center justify-center gap-1 {shapeClasses} {textClasses} {toneClasses} {extraClass}"
>
	{#if isSolidSuccess}
		<svg viewBox="0 0 20 20" class="h-2.5 w-2.5 shrink-0" fill="none" aria-hidden="true">
			<path
				d="M4.5 10.5 8 14l7.5-8"
				stroke="currentColor"
				stroke-width="2.4"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	{/if}
	{@render children()}
</span>
