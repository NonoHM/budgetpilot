<script lang="ts">
	import type { Snippet } from 'svelte';
	import { formatCents } from '$lib/domain/budget';
	import { formatGoalDelta, type SavingsGoalStatus } from '$lib/domain/savingsGoal';
	import { widthClass } from '$lib/domain/widthClass';
	import { cardBase } from '$lib/styles';
	import Badge from '$lib/components/ui/Badge.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		name,
		currentAmountCents,
		targetAmountCents,
		progressPercent,
		status,
		variant = 'card',
		onclick,
		actions
	}: {
		name: string;
		currentAmountCents: number;
		targetAmountCents: number;
		progressPercent: number;
		status: SavingsGoalStatus;
		variant?: 'card' | 'plain';
		onclick?: () => void;
		actions?: Snippet;
	} = $props();

	const remainingCents = $derived(Math.max(0, targetAmountCents - currentAmountCents));
	const delta = $derived(formatGoalDelta(status, remainingCents));

	function statusLabel(value: SavingsGoalStatus): string {
		if (value === 'reached') return m.savings_goal_status_reached();
		if (value === 'behind') return m.savings_goal_status_behind();
		return m.savings_goal_status_in_progress();
	}
</script>

{#snippet content()}
	<div class="flex items-center justify-between gap-3">
		<div class="flex min-w-0 items-center gap-2">
			<span class="truncate text-sm font-semibold text-zinc-900">{name}</span>
			{#if variant === 'card'}
				<span class="shrink-0">
					<Badge
						tone={status === 'reached' ? 'success' : status === 'behind' ? 'warning' : 'neutral'}
						solid={status === 'reached'}
					>
						{statusLabel(status)}
					</Badge>
				</span>
			{/if}
		</div>
		{#if actions}
			<!-- -my-3: same 44px-IconButton optical alignment as BudgetStatusCard. -->
			<div class="-my-3 flex shrink-0 items-center">
				{@render actions()}
			</div>
		{/if}
	</div>

	<div
		class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100"
		class:mt-1.5={variant === 'plain'}
	>
		<div
			class="h-full rounded-full transition-all duration-300 {widthClass(progressPercent)}"
			class:bg-emerald-500={status === 'reached'}
			class:bg-amber-500={status === 'behind'}
			class:bg-zinc-800={status === 'in_progress'}
		></div>
	</div>

	<div class="mt-2 flex items-baseline justify-between gap-2 text-sm">
		<div
			class="tabular-nums text-zinc-900"
			class:font-semibold={variant === 'card'}
			class:font-medium={variant === 'plain'}
		>
			<!-- Space kept between nodes, not inside the span — Svelte trims
			     element-boundary whitespace (same fix as BudgetStatusCard). -->
			{formatCents(currentAmountCents)}
			<span class="font-normal text-zinc-400">/ {formatCents(targetAmountCents)}</span>
		</div>
		<div
			class="shrink-0 text-xs tabular-nums"
			class:text-emerald-700={delta.tone === 'positive'}
			class:text-amber-600={delta.tone === 'warning'}
			class:text-zinc-500={delta.tone === 'neutral'}
		>
			{delta.text}
		</div>
	</div>
{/snippet}

{#if onclick}
	<button
		type="button"
		class="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 {variant ===
		'card'
			? `${cardBase} p-4 hover:bg-zinc-50`
			: ''}"
		{onclick}
	>
		{@render content()}
	</button>
{:else}
	<div class={variant === 'card' ? `${cardBase} p-4` : ''}>
		{@render content()}
	</div>
{/if}
