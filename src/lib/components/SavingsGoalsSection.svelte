<script lang="ts">
	import { enhance } from '$app/forms';
	import Modal from './Modal.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import AlertBanner from './AlertBanner.svelte';
	import GoalStatusCard from './ui/GoalStatusCard.svelte';
	import IconButton from './ui/IconButton.svelte';
	import TapLink from './ui/TapLink.svelte';
	import SavingsGoalForm from './SavingsGoalForm.svelte';
	import SavingsGoalDetailModal from './SavingsGoalDetailModal.svelte';
	import type { SavingsGoalStatus } from '$lib/domain/savingsGoal';
	import * as m from '$lib/paraglide/messages';
	import { cardBase } from '$lib/styles';

	export interface SavingsGoalListItem {
		id: string;
		name: string;
		targetAmountCents: number;
		currentAmountCents: number;
		targetDate: string | null;
		progressPercent: number;
		status: SavingsGoalStatus;
		linkedAccount: { id: string; name: string } | null;
		linkStale: boolean;
		reachedAt: string | null;
		reachedBannerDismissedAt: string | null;
		createdAt: string;
		history: Array<{ capturedAt: string; balanceCents: number }>;
	}

	// Goals are amounts entered manually (declarative) or read live from a linked
	// NetWorthAccount — never re-derived from raw transactions.
	let {
		goals,
		linkableAccounts,
		error
	}: {
		goals: SavingsGoalListItem[];
		linkableAccounts: Array<{ id: string; name: string }>;
		error?: string;
	} = $props();

	const VISIBLE_GOALS = 3;
	let expanded = $state(false);
	const visibleGoals = $derived(expanded ? goals : goals.slice(0, VISIBLE_GOALS));
	const overflowCount = $derived(Math.max(0, goals.length - VISIBLE_GOALS));

	const reachedBanners = $derived(
		goals.filter((goal) => goal.reachedAt !== null && goal.reachedBannerDismissedAt === null)
	);
	const dismissForms: Record<string, HTMLFormElement> = {};

	let showCreateModal = $state(false);
	let editingGoal = $state<SavingsGoalListItem | null>(null);
	let deletingGoal = $state<SavingsGoalListItem | null>(null);
	let viewingGoal = $state<SavingsGoalListItem | null>(null);
	let deleteSubmitting = $state(false);

	function toFormValues(goal: SavingsGoalListItem | null) {
		return {
			id: goal?.id,
			name: goal?.name ?? '',
			targetAmountEuros: goal ? formatEurosInput(goal.targetAmountCents) : '',
			trackingMode: (goal?.linkedAccount || goal?.linkStale ? 'linked' : 'manual') as
				'manual' | 'linked',
			netWorthAccountId: goal?.linkedAccount?.id ?? '',
			currentAmountEuros: goal ? formatEurosInput(goal.currentAmountCents) : '',
			targetDate: goal?.targetDate ? goal.targetDate.slice(0, 10) : ''
		};
	}

	function formatEurosInput(cents: number): string {
		return (cents / 100).toFixed(2).replace('.', ',');
	}
</script>

<section class="{cardBase} p-5">
	<div class="flex items-center justify-between gap-3">
		<h2 class="text-lg font-semibold tracking-tight text-zinc-950">{m.savings_goals_title()}</h2>
		<!-- -my-2.5 cancels TapLink's 44px tap-target height so the header row
		     keeps its text height (tap target itself is untouched). -->
		<span class="-my-2.5 hidden lg:block">
			<TapLink onclick={() => (showCreateModal = true)}>
				{m.savings_goals_new()}
			</TapLink>
		</span>
		<IconButton
			class="!bg-zinc-950 !text-white hover:!bg-zinc-800 lg:hidden"
			label={m.savings_goals_new_aria()}
			onclick={() => (showCreateModal = true)}
		>
			<svg
				class="h-4 w-4"
				viewBox="0 0 20 20"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				aria-hidden="true"
			>
				<path d="M10 4v12M4 10h12" />
			</svg>
		</IconButton>
	</div>

	{#each reachedBanners as goal (goal.id)}
		<form
			bind:this={dismissForms[goal.id]}
			method="POST"
			action="?/dismissSavingsGoalReachedBanner"
			class="hidden"
			use:enhance={() =>
				async ({ update }) => {
					await update();
				}}
		>
			<input type="hidden" name="id" value={goal.id} />
		</form>
		<div class="mt-3">
			<AlertBanner
				variant="success"
				autoDismissMs={Infinity}
				onDismiss={() => dismissForms[goal.id]?.requestSubmit()}
			>
				{m.savings_goal_reached_banner({ name: goal.name })}
			</AlertBanner>
		</div>
	{/each}

	{#if goals.length === 0}
		<p class="mt-4 text-sm text-zinc-500">{m.savings_goals_empty()}</p>
	{:else}
		<div class="mt-4 space-y-3">
			{#each visibleGoals as goal (goal.id)}
				<GoalStatusCard
					name={goal.name}
					currentAmountCents={goal.currentAmountCents}
					targetAmountCents={goal.targetAmountCents}
					progressPercent={goal.progressPercent}
					status={goal.status}
					onclick={() => (viewingGoal = goal)}
				/>
			{/each}
		</div>
		{#if !expanded && overflowCount > 0}
			<div class="mt-1">
				<TapLink onclick={() => (expanded = true)}>
					{m.savings_goals_see_all()} ({overflowCount})
				</TapLink>
			</div>
		{/if}
	{/if}
</section>

{#if showCreateModal}
	<Modal
		open={true}
		title={m.savings_goal_modal_create_title()}
		variant="compact"
		onClose={() => (showCreateModal = false)}
	>
		<p class="mb-4 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
			{m.savings_goal_modal_create_title()}
		</p>
		<SavingsGoalForm
			action="?/createSavingsGoal"
			values={toFormValues(null)}
			{linkableAccounts}
			{error}
			onCancel={() => (showCreateModal = false)}
			onSuccess={() => (showCreateModal = false)}
		/>
	</Modal>
{/if}

{#if editingGoal}
	<Modal
		open={true}
		title={m.savings_goal_modal_update_title()}
		variant="compact"
		onClose={() => (editingGoal = null)}
	>
		<p class="mb-4 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
			{m.savings_goal_modal_update_title()}
		</p>
		<SavingsGoalForm
			action="?/updateSavingsGoal"
			values={toFormValues(editingGoal)}
			{linkableAccounts}
			{error}
			onCancel={() => (editingGoal = null)}
			onSuccess={() => (editingGoal = null)}
		/>
	</Modal>
{/if}

{#if viewingGoal}
	<SavingsGoalDetailModal
		goal={viewingGoal}
		onClose={() => (viewingGoal = null)}
		onEdit={() => {
			editingGoal = viewingGoal;
			viewingGoal = null;
		}}
		onDelete={() => {
			deletingGoal = viewingGoal;
			viewingGoal = null;
		}}
	/>
{/if}

{#if deletingGoal}
	<form
		method="POST"
		action="?/deleteSavingsGoal"
		use:enhance={() => {
			deleteSubmitting = true;
			return async ({ result, update }) => {
				await update();
				deleteSubmitting = false;
				if (result.type === 'success') deletingGoal = null;
			};
		}}
	>
		<input type="hidden" name="id" value={deletingGoal.id} />
		<ConfirmDialog
			open={true}
			title={m.savings_goal_delete_confirm_title({ name: deletingGoal.name })}
			confirmLabel={m.common_delete()}
			tone="danger"
			confirmLoading={deleteSubmitting}
			onClose={() => (deletingGoal = null)}
		>
			<p class="text-sm text-zinc-600">{m.savings_goal_delete_confirm_body()}</p>
			{#if error}
				<p class="mt-2 text-sm text-rose-600">{error}</p>
			{/if}
		</ConfirmDialog>
	</form>
{/if}
