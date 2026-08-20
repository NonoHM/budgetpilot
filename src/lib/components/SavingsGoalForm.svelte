<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import Combobox from './ui/Combobox.svelte';
	import Button from './Button.svelte';
	import AlertBanner from './AlertBanner.svelte';
	import MoneyInput from './ui/MoneyInput.svelte';
	import TapLink from './ui/TapLink.svelte';
	import { inputBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';

	export interface SavingsGoalFormValues {
		id?: string;
		name: string;
		targetAmountEuros: string;
		trackingMode: 'manual' | 'linked';
		netWorthAccountId: string;
		currentAmountEuros: string;
		targetDate: string;
	}

	let {
		action,
		values,
		linkableAccounts,
		error,
		onCancel,
		onSuccess
	}: {
		action: string;
		values: SavingsGoalFormValues;
		linkableAccounts: Array<{ id: string; name: string }>;
		error?: string;
		onCancel: () => void;
		onSuccess: () => void;
	} = $props();

	// Only the INITIAL `values` matters here: the parent always remounts this component fresh
	// (wrapped in an `{#if}`) for each create/edit open, it never mutates `values` on a live
	// instance — so capturing once via untrack() is intentional, not a staleness bug.
	let trackingMode = $state(untrack(() => values.trackingMode));
	let netWorthAccountId = $state(untrack(() => values.netWorthAccountId));
	// Additive disclosure: the deadline field starts hidden unless the goal already has one
	// (editing an existing deadline must not hide it behind an extra click).
	let showDeadline = $state(untrack(() => values.targetDate !== ''));
	let submitting = $state(false);

	const accountOptions = $derived(
		linkableAccounts.map((account) => ({ value: account.id, label: account.name }))
	);
</script>

<form
	method="POST"
	{action}
	class="space-y-4"
	use:enhance={() => {
		submitting = true;
		return async ({ result, update }) => {
			await update();
			submitting = false;
			if (result.type === 'success') onSuccess();
		};
	}}
>
	{#if values.id}
		<input type="hidden" name="id" value={values.id} />
	{/if}

	<label class="block text-xs font-medium text-zinc-600">
		{m.savings_goal_form_name_label()}
		<input
			type="text"
			name="name"
			class="mt-1.5 w-full {inputBase}"
			placeholder={m.savings_goal_form_name_placeholder()}
			value={values.name}
			required
		/>
	</label>

	<MoneyInput
		name="targetAmount"
		label={m.savings_goal_form_target_label()}
		labelClass="text-xs font-medium text-zinc-600"
		value={values.targetAmountEuros}
		allowZero={false}
		allowNegative={false}
	/>

	<div>
		<div class="text-xs font-medium text-zinc-600">{m.savings_goal_form_tracking_label()}</div>
		<div class="mt-1.5 grid grid-cols-2 gap-2">
			<button
				type="button"
				class="rounded-md border px-3 py-2 text-sm font-medium transition-colors {trackingMode ===
				'manual'
					? 'border-zinc-950 bg-zinc-950 text-white'
					: 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'}"
				onclick={() => (trackingMode = 'manual')}
			>
				{m.savings_goal_form_tracking_manual()}
			</button>
			<button
				type="button"
				class="rounded-md border px-3 py-2 text-sm font-medium transition-colors {trackingMode ===
				'linked'
					? 'border-zinc-950 bg-zinc-950 text-white'
					: 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'}"
				onclick={() => (trackingMode = 'linked')}
			>
				{m.savings_goal_form_tracking_linked()}
			</button>
		</div>
		<input type="hidden" name="trackingMode" value={trackingMode} />
	</div>

	{#if trackingMode === 'linked'}
		<label class="block text-xs font-medium text-zinc-600">
			{m.savings_goal_form_account_label()}
			<div class="mt-1.5">
				<Combobox
					name="netWorthAccountId"
					value={netWorthAccountId}
					onValueChange={(value) => (netWorthAccountId = value)}
					ariaLabel={m.savings_goal_form_account_label()}
					options={accountOptions}
					required
				/>
			</div>
			<span class="mt-1 block text-xs font-normal text-zinc-400"
				>{m.savings_goal_form_account_hint()}</span
			>
		</label>
	{:else}
		<MoneyInput
			name="currentAmount"
			label={m.savings_goal_form_current_amount_label()}
			labelClass="text-xs font-medium text-zinc-600"
			value={values.currentAmountEuros}
			required={false}
			allowZero={true}
			allowNegative={false}
		/>
	{/if}

	{#if showDeadline}
		<label class="block text-xs font-medium text-zinc-600">
			{m.savings_goal_form_deadline_label()}
			<input
				type="date"
				name="targetDate"
				class="mt-1.5 w-full {inputBase}"
				value={values.targetDate}
			/>
		</label>
	{:else}
		<TapLink onclick={() => (showDeadline = true)}>{m.savings_goal_form_add_deadline()}</TapLink>
	{/if}

	{#if error}
		<!-- Announced, not merely coloured — same reason as the dashboard's manual-add modal. -->
		<AlertBanner variant="error">{error}</AlertBanner>
	{/if}

	<div
		class="flex gap-2 border-t border-zinc-100 pt-3 lg:items-center lg:justify-end lg:border-0 lg:pt-1"
	>
		<TapLink class="flex-1 justify-center lg:flex-none" onclick={onCancel} disabled={submitting}
			>{m.common_cancel()}</TapLink
		>
		<Button type="submit" class="flex-1 lg:flex-none" loading={submitting}>
			{values.id ? m.savings_goal_submit_update() : m.savings_goal_submit_create()}
		</Button>
	</div>
</form>
