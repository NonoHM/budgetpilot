<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatCents, formatBudgetDelta } from '$lib/domain/budget';
	import { widthClass } from '$lib/domain/widthClass';
	import { buildDefaultKeyByName, categoryLabelByName } from '$lib/domain/categoryLabels';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Button from '$lib/components/Button.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import BudgetStatusCard from '$lib/components/ui/BudgetStatusCard.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import MoneyInput from '$lib/components/ui/MoneyInput.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import { cardBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const defaultKeyByName = $derived(buildDefaultKeyByName(data.categories));
	function displayCategory(name: string): string {
		return categoryLabelByName(name, defaultKeyByName);
	}

	let showCreateModal = $state(false);
	let editingBudget = $state<{ id: string; categoryName: string; amountEuros: string } | null>(
		null
	);
	let deletingBudget = $state<{ id: string; categoryName: string } | null>(null);
	let createSubmitting = $state(false);
	let updateSubmitting = $state(false);
	let deleteSubmitting = $state(false);

	const totalLimitCents = $derived(data.budgets.reduce((s, b) => s + b.amountCents, 0));
	const totalSpentCents = $derived(data.budgets.reduce((s, b) => s + b.spentCents, 0));
	const totalPercent = $derived(
		totalLimitCents > 0 ? Math.min(Math.round((totalSpentCents / totalLimitCents) * 100), 100) : 0
	);
	const totalDelta = $derived(formatBudgetDelta(totalSpentCents, totalLimitCents));

	function formatCurrentMonth(month: string): string {
		const [year, m] = month.split('-');
		return new Date(Number(year), Number(m) - 1, 1).toLocaleDateString(getLocale(), {
			month: 'long',
			year: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>{m.budgets_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<section class="mx-auto max-w-4xl space-y-6">
		<!-- Page-level feedback: the error clause is gated to skip while a modal is open, since
		     each modal below already shows its own contextual AlertBanner for the same form.error
		     — without this, both would mount role="alert" simultaneously for the same message,
		     double-announcing it to screen readers. Success needs no gating: every modal below
		     already closes itself on success before this banner would render. -->
		{#if form?.error && !showCreateModal && !editingBudget && !deletingBudget}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}
		{#if form?.success}
			<AlertBanner variant="success">{form.success}</AlertBanner>
		{/if}

		<!-- En-tête -->
		<div class="flex items-start justify-between gap-4">
			<div>
				<h1 class="text-2xl font-semibold tracking-tight">{m.nav_budgets()}</h1>
				<p class="mt-1 text-sm text-zinc-500">
					{m.budgets_subtitle({ month: formatCurrentMonth(data.currentMonth) })}
				</p>
			</div>
			<div class="flex shrink-0 items-center gap-2">
				<IconButton
					class="!bg-zinc-950 !text-white hover:!bg-zinc-800 lg:hidden"
					label={m.budgets_new()}
					onclick={() => (showCreateModal = true)}
				>
					<svg
						class="h-5 w-5"
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
				{#if data.budgets.length > 0}
					<Button size="sm" class="hidden lg:inline-flex" onclick={() => (showCreateModal = true)}
						>{m.budgets_new()}</Button
					>
				{/if}
			</div>
		</div>

		{#if data.budgets.length === 0}
			{#snippet emptyIcon()}
				<svg
					class="h-5 w-5 text-zinc-400"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<rect x="3" y="5" width="18" height="14" rx="2" />
					<path d="M3 10h18M15 14h.01" />
				</svg>
			{/snippet}
			<EmptyState
				icon={emptyIcon}
				title={m.budgets_empty_heading()}
				description={m.budgets_empty_description()}
				ctaLabel={m.budgets_empty_cta()}
				onCtaClick={() => (showCreateModal = true)}
			/>
		{:else}
			<!-- Bandeau total (mobile) -->
			<div class="{cardBase} p-5 lg:hidden">
				<div class="flex items-center justify-between gap-4">
					<div>
						<div class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
							{m.budgets_spent_this_month()}
						</div>
						<div class="mt-0.5 text-lg font-semibold text-zinc-900 tabular-nums">
							{formatCents(totalSpentCents)}
						</div>
					</div>
					<div class="text-right">
						<div class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
							{m.budgets_total_budget()}
						</div>
						<div class="mt-0.5 text-lg font-semibold text-zinc-900 tabular-nums">
							{formatCents(totalLimitCents)}
						</div>
					</div>
				</div>
				<div class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
					<div
						class="h-full rounded-full bg-zinc-800 transition-all duration-300 {widthClass(
							totalPercent
						)}"
					></div>
				</div>
				<div class="mt-2 flex items-baseline justify-between text-xs">
					<span class="text-zinc-500">{m.budgets_percent_used({ percent: totalPercent })}</span>
					<span
						class="font-medium tabular-nums"
						class:text-emerald-600={totalDelta.tone === 'positive'}
						class:text-amber-600={totalDelta.tone === 'warning'}
						class:text-rose-600={totalDelta.tone === 'danger'}>{totalDelta.text}</span
					>
				</div>
			</div>

			<!-- Liste des budgets (mobile) -->
			<div class="space-y-3 lg:hidden">
				{#each data.budgets as budget (budget.id)}
					<ListCard
						expandAriaLabel={m.budgets_delete_expand_aria({
							name: displayCategory(budget.categoryName)
						})}
					>
						<BudgetStatusCard
							variant="plain"
							showBadge
							categoryLabel={displayCategory(budget.categoryName)}
							spentCents={budget.spentCents}
							limitCents={budget.amountCents}
						>
							{#snippet actions()}
								<IconButton
									label={m.budgets_edit_aria({ name: displayCategory(budget.categoryName) })}
									onclick={() =>
										(editingBudget = {
											id: budget.id,
											categoryName: budget.categoryName,
											amountEuros: budget.amountEuros
										})}
								>
									<svg
										class="h-4 w-4"
										viewBox="0 0 20 20"
										fill="none"
										stroke="currentColor"
										stroke-width="1.6"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<path d="m13.5 3.5 3 3L6 17H3v-3L13.5 3.5Z" />
									</svg>
								</IconButton>
							{/snippet}
						</BudgetStatusCard>
						{#snippet details()}
							<button
								type="button"
								class="flex min-h-11 w-full items-center justify-center gap-2 text-sm font-medium text-rose-600 hover:bg-rose-50"
								onclick={() =>
									(deletingBudget = {
										id: budget.id,
										categoryName: budget.categoryName
									})}
							>
								<svg
									class="h-4 w-4"
									viewBox="0 0 20 20"
									fill="none"
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M7 8.5v5m3-5v5m3-5v5M4.5 5.5h11M8 5.5V4h4v1.5M6 5.5l.9 10h6.2l.9-10" />
								</svg>
								{m.common_delete()}
							</button>
						{/snippet}
					</ListCard>
				{/each}
			</div>

			<!-- Bandeau total (desktop) -->
			<div
				class="hidden flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-zinc-200 bg-zinc-50/70 px-5 py-4 lg:flex"
			>
				<div>
					<div class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
						{m.budgets_spent_this_month()}
					</div>
					<div class="mt-0.5 text-lg font-semibold text-zinc-900 tabular-nums">
						{formatCents(totalSpentCents)}
					</div>
				</div>
				<div class="hidden h-8 w-px bg-zinc-200 sm:block"></div>
				<div>
					<div class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
						{m.budgets_total_budget()}
					</div>
					<div class="mt-0.5 text-lg font-semibold text-zinc-900 tabular-nums">
						{formatCents(totalLimitCents)}
					</div>
				</div>
				<div class="ml-auto max-w-[240px] flex-1">
					<div class="flex items-baseline justify-between text-xs">
						<span class="text-zinc-500">{m.budgets_percent_used({ percent: totalPercent })}</span>
						<span
							class="font-medium tabular-nums"
							class:text-emerald-600={totalDelta.tone === 'positive'}
							class:text-amber-600={totalDelta.tone === 'warning'}
							class:text-rose-600={totalDelta.tone === 'danger'}>{totalDelta.text}</span
						>
					</div>
					<div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
						<div
							class="h-full rounded-full bg-zinc-800 transition-all duration-300 {widthClass(
								totalPercent
							)}"
						></div>
					</div>
				</div>
			</div>

			<!-- Liste des budgets (desktop) -->
			<div class="hidden gap-3 sm:grid-cols-2 lg:grid">
				{#each data.budgets as budget (budget.id)}
					<BudgetStatusCard
						categoryLabel={displayCategory(budget.categoryName)}
						spentCents={budget.spentCents}
						limitCents={budget.amountCents}
					>
						{#snippet actions()}
							<IconButton
								label={m.budgets_edit_aria({ name: displayCategory(budget.categoryName) })}
								onclick={() =>
									(editingBudget = {
										id: budget.id,
										categoryName: budget.categoryName,
										amountEuros: budget.amountEuros
									})}
							>
								<svg
									class="h-4 w-4"
									viewBox="0 0 20 20"
									fill="none"
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="m13.5 3.5 3 3L6 17H3v-3L13.5 3.5Z" />
								</svg>
							</IconButton>
							<IconButton
								tone="danger"
								label={m.budgets_delete_aria({ name: displayCategory(budget.categoryName) })}
								onclick={() =>
									(deletingBudget = {
										id: budget.id,
										categoryName: budget.categoryName
									})}
							>
								<svg
									class="h-4 w-4"
									viewBox="0 0 20 20"
									fill="none"
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<path d="M7 8.5v5m3-5v5m3-5v5M4.5 5.5h11M8 5.5V4h4v1.5M6 5.5l.9 10h6.2l.9-10" />
								</svg>
							</IconButton>
						{/snippet}
					</BudgetStatusCard>
				{/each}
			</div>
		{/if}
	</section>
</main>

<!-- Modale — créer un budget -->
{#if showCreateModal}
	<Modal
		open={true}
		title={m.budgets_modal_create_title()}
		description={m.budgets_modal_description()}
		variant="compact"
		onClose={() => (showCreateModal = false)}
	>
		<!-- Titre mobile visible : le header par défaut de Modal passe sr-only sous lg
		     (cf. variant="compact"). Marqué aria-hidden pour éviter un double-discours
		     avec ce header sr-only, qui porte déjà le nom accessible du dialogue. -->
		<p class="mb-1 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
			{m.budgets_modal_create_title()}
		</p>
		<p class="mb-4 text-sm text-zinc-500 lg:hidden" aria-hidden="true">
			{m.budgets_modal_description()}
		</p>
		<form
			method="POST"
			action="?/create"
			class="space-y-4"
			use:enhance={() => {
				createSubmitting = true;
				return async ({ result, update }) => {
					await update();
					createSubmitting = false;
					if (result.type === 'success') showCreateModal = false;
				};
			}}
		>
			<div>
				<label class="block text-xs font-medium text-zinc-600">
					{m.budgets_field_category()}
					<div class="mt-1.5">
						<Combobox
							name="category"
							placeholder={m.budgets_field_category_placeholder()}
							ariaLabel={m.budgets_field_category()}
							required
							triggerClass="!bg-zinc-50 lg:!bg-white"
							options={data.categoryOptions.map((c) => ({ value: c, label: displayCategory(c) }))}
						/>
					</div>
				</label>
			</div>
			<MoneyInput
				name="amount"
				label={m.budgets_field_amount()}
				labelClass="text-xs font-medium text-zinc-600"
				placeholder="250,00"
				allowZero={false}
				allowNegative={false}
				inputClass="!bg-zinc-50 placeholder:text-zinc-400 lg:!bg-white"
			/>
			{#if form?.error}
				<AlertBanner variant="error">{form.error}</AlertBanner>
			{/if}
			<div
				class="flex gap-2 border-t border-zinc-100 pt-3 lg:items-center lg:justify-end lg:border-0 lg:pt-1"
			>
				<TapLink
					class="flex-1 justify-center lg:flex-none"
					onclick={() => (showCreateModal = false)}
					disabled={createSubmitting}>{m.common_cancel()}</TapLink
				>
				<Button type="submit" class="flex-1 lg:flex-none" loading={createSubmitting}
					>{m.common_save()}</Button
				>
			</div>
		</form>
	</Modal>
{/if}

<!-- Modale — modifier un budget -->
{#if editingBudget}
	<Modal
		open={true}
		title={m.budgets_modal_update_title()}
		description={m.budgets_modal_description()}
		variant="compact"
		onClose={() => (editingBudget = null)}
	>
		<!-- Titre mobile visible : le header par défaut de Modal passe sr-only sous lg
		     (cf. variant="compact"). Marqué aria-hidden pour éviter un double-discours
		     avec ce header sr-only, qui porte déjà le nom accessible du dialogue. -->
		<p class="mb-1 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
			{m.budgets_modal_update_title()}
		</p>
		<p class="mb-4 text-sm text-zinc-500 lg:hidden" aria-hidden="true">
			{m.budgets_modal_description()}
		</p>
		<form
			method="POST"
			action="?/update"
			class="space-y-4"
			use:enhance={() => {
				updateSubmitting = true;
				return async ({ result, update }) => {
					await update();
					updateSubmitting = false;
					if (result.type === 'success') editingBudget = null;
				};
			}}
		>
			<input type="hidden" name="id" value={editingBudget.id} />
			<div>
				<label class="block text-xs font-medium text-zinc-600">
					{m.budgets_field_category()}
					<div class="mt-1.5">
						<Combobox
							name="category"
							value={editingBudget.categoryName}
							ariaLabel={m.budgets_field_category()}
							required
							triggerClass="!bg-zinc-50 lg:!bg-white"
							options={data.categoryOptions.map((c) => ({ value: c, label: displayCategory(c) }))}
						/>
					</div>
				</label>
			</div>
			<MoneyInput
				name="amount"
				label={m.budgets_field_amount()}
				labelClass="text-xs font-medium text-zinc-600"
				value={editingBudget.amountEuros}
				allowZero={false}
				allowNegative={false}
				inputClass="!bg-zinc-50 placeholder:text-zinc-400 lg:!bg-white"
			/>
			{#if form?.error}
				<AlertBanner variant="error">{form.error}</AlertBanner>
			{/if}
			<div
				class="flex gap-2 border-t border-zinc-100 pt-3 lg:items-center lg:justify-end lg:border-0 lg:pt-1"
			>
				<TapLink
					class="flex-1 justify-center lg:flex-none"
					onclick={() => (editingBudget = null)}
					disabled={updateSubmitting}>{m.common_cancel()}</TapLink
				>
				<Button type="submit" class="flex-1 lg:flex-none" loading={updateSubmitting}
					>{m.budgets_submit_update()}</Button
				>
			</div>
		</form>
	</Modal>
{/if}

<!-- ConfirmDialog — supprimer un budget -->
{#if deletingBudget}
	<form
		method="POST"
		action="?/delete"
		use:enhance={() => {
			deleteSubmitting = true;
			return async ({ result, update }) => {
				await update();
				deleteSubmitting = false;
				if (result.type === 'success') deletingBudget = null;
			};
		}}
	>
		<input type="hidden" name="id" value={deletingBudget.id} />
		<ConfirmDialog
			open={true}
			title={m.budgets_delete_confirm_title({ name: displayCategory(deletingBudget.categoryName) })}
			confirmLabel={m.common_delete()}
			tone="danger"
			confirmLoading={deleteSubmitting}
			onClose={() => (deletingBudget = null)}
		>
			<p class="text-sm text-zinc-600">
				{m.budgets_delete_confirm_body()}
			</p>
			{#if form?.error}
				<AlertBanner variant="error" class="mt-2">{form.error}</AlertBanner>
			{/if}
		</ConfirmDialog>
	</form>
{/if}
