<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import {
		computeSuggestedMonthlyPaceCents,
		formatGoalDelta,
		type SavingsGoalStatus
	} from '$lib/domain/savingsGoal';
	import { widthClass } from '$lib/domain/widthClass';
	import Modal from './Modal.svelte';
	import Button from './Button.svelte';
	import Badge from './ui/Badge.svelte';
	import TapLink from './ui/TapLink.svelte';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';

	export interface SavingsGoalDetail {
		name: string;
		targetAmountCents: number;
		currentAmountCents: number;
		targetDate: string | null;
		progressPercent: number;
		status: SavingsGoalStatus;
		linkedAccount: { id: string; name: string } | null;
		linkStale: boolean;
		history: Array<{ capturedAt: string; balanceCents: number }>;
	}

	let {
		goal,
		onClose,
		onEdit,
		onDelete
	}: {
		goal: SavingsGoalDetail;
		onClose: () => void;
		onEdit: () => void;
		onDelete: () => void;
	} = $props();

	const remainingCents = $derived(Math.max(0, goal.targetAmountCents - goal.currentAmountCents));
	const delta = $derived(formatGoalDelta(goal.status, remainingCents));

	function statusLabel(status: SavingsGoalStatus): string {
		if (status === 'reached') return m.savings_goal_status_reached();
		if (status === 'behind') return m.savings_goal_status_behind();
		return m.savings_goal_status_in_progress();
	}

	const targetDateObj = $derived(goal.targetDate ? new Date(goal.targetDate) : null);
	const monthlyPaceCents = $derived(
		targetDateObj
			? computeSuggestedMonthlyPaceCents(
					goal.targetAmountCents,
					goal.currentAmountCents,
					targetDateObj
				)
			: null
	);
	const monthsRemaining = $derived.by(() => {
		if (!targetDateObj) return 0;
		const msPerMonth = (365.25 / 12) * 24 * 60 * 60 * 1000;
		return Math.max(0, Math.ceil((targetDateObj.getTime() - Date.now()) / msPerMonth));
	});

	function formatDeadline(date: Date): string {
		return date.toLocaleDateString(getLocale(), { day: 'numeric', month: 'long', year: 'numeric' });
	}

	// Same technique as NetWorthChart (time-proportional x, value-normalized y, viewBox + w-full
	// for responsive scaling), simplified: no interactive hover points, just the line + gradient.
	const WIDTH = 400;
	const HEIGHT = 100;
	const PADDING = 6;
	const gradientId = `savings-goal-gradient-${crypto.randomUUID().slice(0, 8)}`;

	const points = $derived.by(() => {
		if (goal.history.length === 0) return [];
		const values = goal.history.map((point) => point.balanceCents);
		const min = Math.min(...values, 0);
		const max = Math.max(...values, goal.targetAmountCents);
		const span = max - min || 1;

		const timestamps = goal.history.map((point) => new Date(point.capturedAt).getTime());
		const minTs = Math.min(...timestamps);
		const maxTs = Math.max(...timestamps);
		const tsSpan = maxTs - minTs || 1;

		return goal.history.map((point, index) => {
			const x =
				goal.history.length === 1
					? WIDTH / 2
					: PADDING + ((timestamps[index] - minTs) / tsSpan) * (WIDTH - PADDING * 2);
			const y = HEIGHT - PADDING - ((point.balanceCents - min) / span) * (HEIGHT - PADDING * 2);
			return { x, y };
		});
	});

	const linePath = $derived(
		points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')
	);
	const areaPath = $derived(
		points.length < 2
			? ''
			: `${linePath} L${points[points.length - 1].x},${HEIGHT} L${points[0].x},${HEIGHT} Z`
	);
</script>

<Modal open={true} title={goal.name} variant="compact" {onClose}>
	<p class="mb-4 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">{goal.name}</p>

	<div class="space-y-4">
		<div>
			<Badge
				tone={goal.status === 'reached'
					? 'success'
					: goal.status === 'behind'
						? 'warning'
						: 'neutral'}
				solid={goal.status === 'reached'}
			>
				{statusLabel(goal.status)}
			</Badge>

			<div class="mt-2 flex items-baseline gap-2">
				<span class="text-2xl font-semibold tabular-nums text-zinc-900"
					>{formatCents(goal.currentAmountCents)}</span
				>
				<span class="text-sm text-zinc-400">/ {formatCents(goal.targetAmountCents)}</span>
			</div>

			<div class="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
				<div
					class="h-full rounded-full transition-all duration-300 {widthClass(goal.progressPercent)}"
					class:bg-emerald-500={goal.status === 'reached'}
					class:bg-amber-500={goal.status === 'behind'}
					class:bg-zinc-800={goal.status === 'in_progress'}
				></div>
			</div>
			<div class="mt-1.5 flex items-baseline justify-between text-xs">
				<span class="text-zinc-500"
					>{m.savings_goal_progress_percent({ percent: goal.progressPercent })}</span
				>
				<span
					class="font-medium tabular-nums"
					class:text-emerald-700={delta.tone === 'positive'}
					class:text-amber-600={delta.tone === 'warning'}
					class:text-zinc-500={delta.tone === 'neutral'}>{delta.text}</span
				>
			</div>

			{#if goal.linkedAccount}
				<p class="mt-2 text-xs text-zinc-500">
					{m.savings_goal_linked_to({ account: goal.linkedAccount.name })}
				</p>
			{:else if goal.linkStale}
				<p class="mt-2 text-xs text-amber-600">{m.savings_goal_unlinked_notice()}</p>
			{/if}
		</div>

		{#if targetDateObj && monthlyPaceCents !== null}
			<div class="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5">
				<div class="text-xs font-medium text-amber-900">{m.savings_goal_pace_title()}</div>
				<div class="mt-1 text-lg font-semibold tabular-nums text-amber-900">
					{m.savings_goal_pace_per_month({ amount: formatCents(monthlyPaceCents) })}
				</div>
				<div class="mt-1 text-xs text-amber-700">
					{monthsRemaining === 1
						? m.savings_goal_deadline_months_remaining_one({
								date: formatDeadline(targetDateObj),
								count: monthsRemaining
							})
						: m.savings_goal_deadline_months_remaining_many({
								date: formatDeadline(targetDateObj),
								count: monthsRemaining
							})}
				</div>
			</div>
		{/if}

		<div>
			<div class="text-xs font-medium text-zinc-600">{m.savings_goal_history_title()}</div>
			{#if points.length > 0}
				<svg
					class="mt-2 w-full text-zinc-500"
					viewBox="0 0 {WIDTH} {HEIGHT}"
					role="img"
					aria-label={m.savings_goal_history_title()}
				>
					<defs>
						<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stop-color="currentColor" stop-opacity="0.2" />
							<stop offset="100%" stop-color="currentColor" stop-opacity="0" />
						</linearGradient>
					</defs>
					<path d={areaPath} fill="url(#{gradientId})" stroke="none" />
					<path d={linePath} fill="none" stroke="currentColor" stroke-width="1.5" />
				</svg>
			{:else}
				<p class="mt-2 text-xs text-zinc-400">{m.savings_goal_history_unavailable()}</p>
			{/if}
		</div>

		<div class="flex items-center justify-between border-t border-zinc-100 pt-3 text-sm">
			<TapLink onclick={onEdit}>{m.savings_goal_edit()}</TapLink>
			<TapLink onclick={onDelete} tone="danger">{m.savings_goal_delete()}</TapLink>
		</div>

		<div class="flex justify-end lg:hidden">
			<Button type="button" variant="secondary" class="w-full" onclick={onClose}
				>{m.common_close()}</Button
			>
		</div>
	</div>
</Modal>
