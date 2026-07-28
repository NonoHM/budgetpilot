<script lang="ts">
	import type { Snippet } from 'svelte';
	import { formatBudgetDelta, formatCents } from '$lib/domain/budget';
	import { widthClass } from '$lib/domain/widthClass';
	import { cardBase } from '$lib/styles';
	import Badge from '$lib/components/ui/Badge.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		categoryLabel,
		spentCents,
		limitCents,
		variant = 'card',
		showBadge = variant === 'card',
		actions
	}: {
		categoryLabel: string;
		spentCents: number;
		limitCents: number;
		variant?: 'card' | 'plain';
		showBadge?: boolean;
		actions?: Snippet;
	} = $props();

	const delta = $derived(formatBudgetDelta(spentCents, limitCents));
	const barPercent = $derived(
		limitCents > 0 ? Math.min(Math.round((spentCents / limitCents) * 100), 100) : 0
	);

	function statusLabel(status: 'ok' | 'near_limit' | 'over_budget'): string {
		if (status === 'over_budget') return m.budgets_status_over();
		if (status === 'near_limit') return m.budgets_status_near_limit();
		return m.budgets_status_ok();
	}
</script>

<div class={variant === 'card' ? `${cardBase} p-4` : ''}>
	<div class="flex items-center justify-between gap-3">
		<div class="flex min-w-0 items-center gap-2">
			<span class="truncate text-sm font-semibold text-zinc-900">{categoryLabel}</span>
			{#if showBadge}
				<span class="shrink-0">
					<Badge
						tone={delta.tone === 'positive'
							? 'success'
							: delta.tone === 'warning'
								? 'warning'
								: 'danger'}
					>
						{statusLabel(delta.status)}
					</Badge>
				</span>
			{/if}
		</div>
		{#if actions}
			<!-- -my-3 cancels the 44px IconButton touch target's height so the row
			     stays text-height and the glyph optically centers on the title line
			     (22px icon center - 12px = ~10px, the text-sm line center). -->
			<div class="-my-3 flex shrink-0 items-center">
				{@render actions()}
			</div>
		{/if}
	</div>

	<div
		class="mt-2 h-1.5 w-full overflow-hidden rounded-full"
		class:mt-1.5={variant === 'plain'}
		class:bg-zinc-100={delta.status !== 'over_budget'}
		class:bg-rose-100={delta.status === 'over_budget'}
	>
		<div
			class="h-full rounded-full transition-all duration-300 {widthClass(barPercent)}"
			class:bg-emerald-500={delta.status === 'ok'}
			class:bg-amber-500={delta.status === 'near_limit'}
			class:bg-rose-500={delta.status === 'over_budget'}
		></div>
	</div>

	<div class="mt-2 flex items-baseline justify-between gap-2 text-sm">
		<div
			class="text-zinc-900 tabular-nums"
			class:font-semibold={variant === 'card'}
			class:font-medium={variant === 'plain'}
		>
			<!-- The space before the <span> must sit between the two nodes: Svelte
			     silently trims leading/trailing whitespace inside an element, so a
			     space at the start of the span's own content would be dropped. -->
			{formatCents(spentCents)}
			<span class="font-normal text-zinc-400">/ {formatCents(limitCents)}</span>
		</div>
		<div
			class="shrink-0 text-xs tabular-nums"
			class:text-emerald-600={delta.tone === 'positive'}
			class:text-amber-600={delta.tone === 'warning'}
			class:text-rose-600={delta.tone === 'danger'}
		>
			{delta.text}
		</div>
	</div>
</div>
