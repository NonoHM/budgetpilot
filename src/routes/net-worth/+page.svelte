<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatCents } from '$lib/domain/budget';
	import {
		computeNetWorthTotal,
		computeNegativeBalanceTotal,
		negativeBalanceDisplayCents,
		buildNetWorthAssetBreakdown,
		isLinkableNetWorthAccountType,
		NET_WORTH_ACCOUNT_TYPES
	} from '$lib/domain/netWorth';
	import type { NetWorthAccountType } from '$lib/domain/netWorth';
	import { netWorthAccountTypeLabel } from '$lib/domain/netWorthLabels';
	import { NET_WORTH_TYPE_COLORS } from '$lib/domain/colors';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Button from '$lib/components/Button.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Switch from '$lib/components/Switch.svelte';
	import NetWorthChart from '$lib/components/ui/NetWorthChart.svelte';
	import DonutChart from '$lib/components/ui/DonutChart.svelte';
	import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import SavingsGoalsSection from '$lib/components/SavingsGoalsSection.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import MoneyInput from '$lib/components/ui/MoneyInput.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import { cardBase, inputBase } from '$lib/styles';
	import Badge from '$lib/components/ui/Badge.svelte';
	import * as m from '$lib/paraglide/messages';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const typeOptions = NET_WORTH_ACCOUNT_TYPES.map((type) => ({
		value: type,
		label: netWorthAccountTypeLabel(type)
	}));

	const totalCents = $derived(computeNetWorthTotal(data.accounts));
	const negativeBalanceTotalCents = $derived(computeNegativeBalanceTotal(data.accounts));
	const assetBreakdown = $derived(buildNetWorthAssetBreakdown(data.accounts));
	const assetsTotalCents = $derived(
		assetBreakdown.reduce((sum, entry) => sum + entry.totalCents, 0)
	);
	const assetDonutSegments = $derived(
		assetBreakdown.map((entry) => ({
			label: netWorthAccountTypeLabel(entry.type),
			color: NET_WORTH_TYPE_COLORS[entry.type],
			pct: entry.pct
		}))
	);
	const assetDonutMeta = $derived(
		`${formatCents(assetsTotalCents)} · ${
			assetBreakdown.length > 1
				? m.net_worth_assets_type_count_many({ count: assetBreakdown.length })
				: m.net_worth_assets_type_count_one({ count: assetBreakdown.length })
		}`
	);

	let netWorthView = $state<'curve' | 'donut'>('curve');

	let showCreateModal = $state(false);
	let createType = $state<NetWorthAccountType>(typeOptions[0].value as NetWorthAccountType);
	let createConnectToTransactions = $state(false);
	let editingAccount = $state<{
		id: string;
		name: string;
		type: NetWorthAccountType;
		balanceEuros: string;
	} | null>(null);
	let editConnectToTransactions = $state(false);
	let deletingAccount = $state<{ id: string; name: string } | null>(null);
	let createSubmitting = $state(false);
	let updateSubmitting = $state(false);
	let deleteSubmitting = $state(false);

	function openCreateModal() {
		createType = typeOptions[0].value as NetWorthAccountType;
		createConnectToTransactions = false;
		showCreateModal = true;
	}

	function openEditModal(account: {
		id: string;
		name: string;
		type: NetWorthAccountType;
		balanceEuros: string;
	}) {
		editingAccount = account;
		editConnectToTransactions = data.manualAccountNetWorthAccountId === account.id;
	}

	const todayIso = new Date().toISOString().slice(0, 10);

	function toneClass(cents: number): string {
		if (cents > 0) return 'text-emerald-600';
		if (cents < 0) return 'text-rose-600';
		return 'text-zinc-500';
	}
</script>

<svelte:head>
	<title>{m.net_worth_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<section class="mx-auto max-w-4xl space-y-6">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h1 class="text-2xl font-semibold tracking-tight">{m.nav_net_worth()}</h1>
				<p class="mt-1 text-sm text-zinc-500">{m.net_worth_subtitle()}</p>
			</div>
			{#if data.accounts.length > 0}
				<Button size="sm" onclick={openCreateModal}>{m.net_worth_new()}</Button>
			{/if}
		</div>

		<!-- Gated to skip while a modal is open: each modal below already shows its own
		     contextual AlertBanner for the same form.error — without this, both would mount
		     role="alert" simultaneously for the same message, double-announcing it to screen
		     readers. Success needs no gating: every modal below already closes itself on success
		     before this banner would render. -->
		{#if form?.error && !showCreateModal && !editingAccount && !deletingAccount}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}
		{#if form?.success}
			<AlertBanner variant="success">{form.success}</AlertBanner>
		{/if}

		{#if data.accounts.length === 0}
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
					<path
						d="M4 8h16M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2M4 8v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"
					/>
					<path d="M15 13h3" />
				</svg>
			{/snippet}
			<EmptyState
				icon={emptyIcon}
				title={m.net_worth_empty_heading()}
				description={m.net_worth_empty_description()}
				ctaLabel={m.net_worth_empty_cta()}
				onCtaClick={openCreateModal}
			/>

			<SavingsGoalsSection
				goals={data.savingsGoals}
				linkableAccounts={data.linkableAccounts}
				error={form && 'error' in form ? form.error : undefined}
			/>
		{:else}
			<!-- Total + graphique / répartition -->
			<div class="{cardBase} p-5">
				<div class="flex items-start justify-between gap-3">
					<div>
						<div class="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
							{m.net_worth_total_label()}
						</div>
						<div class="mt-0.5 text-2xl font-semibold tabular-nums {toneClass(totalCents)}">
							{formatCents(totalCents)}
						</div>
					</div>
					<SegmentedControl
						options={[
							{ value: 'curve', label: m.net_worth_view_curve() },
							{ value: 'donut', label: m.net_worth_view_donut() }
						]}
						bind:value={netWorthView}
					>
						{#snippet icon(option: { value: string; label: string })}
							{#if option.value === 'curve'}
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
									<path d="M3 14 8 8l4 3 5-6" />
									<path d="M13 5h4v4" />
								</svg>
							{:else}
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
									<path d="M10 2a8 8 0 1 0 8 8h-8V2Z" />
									<path d="M14.5 3.5A8 8 0 0 1 17 9h-6.5l4-5.5Z" />
								</svg>
							{/if}
						{/snippet}
					</SegmentedControl>
				</div>
				{#if netWorthView === 'curve'}
					<div class="mt-4">
						<NetWorthChart series={data.series} />
					</div>
				{:else}
					<div class="mt-4">
						<DonutChart
							segments={assetDonutSegments}
							othersColor="#d4d4d8"
							title={m.net_worth_assets_title()}
							meta={assetDonutMeta}
							centerCaption={m.net_worth_assets_center_label()}
							centerValue={formatCents(assetsTotalCents)}
							emptyText={m.net_worth_assets_empty()}
						/>
						<div class="mt-5 border-t border-zinc-100 pt-4">
							<div class="flex items-center justify-between gap-3">
								<span class="text-sm font-semibold text-zinc-900">{m.net_worth_debt_label()}</span>
								<span class="text-sm font-semibold tabular-nums text-rose-600">
									{formatCents(negativeBalanceDisplayCents(negativeBalanceTotalCents))}
								</span>
							</div>
							<p class="mt-1 text-xs text-zinc-400">{m.net_worth_debt_note()}</p>
						</div>
					</div>
				{/if}
			</div>

			<SavingsGoalsSection
				goals={data.savingsGoals}
				linkableAccounts={data.linkableAccounts}
				error={form && 'error' in form ? form.error : undefined}
			/>

			<!-- Liste des comptes (mobile) -->
			<div class="space-y-3 lg:hidden">
				{#each data.accounts as account (account.id)}
					<ListCard expandAriaLabel={m.net_worth_delete_expand_aria({ name: account.name })}>
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<div class="truncate text-sm font-semibold text-zinc-900">{account.name}</div>
								<span class="mt-1 inline-block">
									<Badge tone="neutral">{netWorthAccountTypeLabel(account.type)}</Badge>
								</span>
								{#if account.connected}
									<span class="mt-1 ml-1 inline-block">
										<Badge tone="neutral">{m.net_worth_badge_connected()}</Badge>
									</span>
								{/if}
							</div>
							<IconButton
								class="-my-3 shrink-0"
								label={m.net_worth_edit_aria({ name: account.name })}
								onclick={() =>
									openEditModal({
										id: account.id,
										name: account.name,
										type: account.type,
										balanceEuros: account.balanceEuros
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
						</div>
						<div
							class="mt-3 text-lg font-semibold tabular-nums {toneClass(
								account.type === 'debt' ? -account.balanceCents : account.balanceCents
							)}"
						>
							{formatCents(account.balanceCents)}
						</div>
						{#snippet details()}
							<button
								type="button"
								class="flex min-h-11 w-full items-center justify-center gap-2 text-sm font-medium text-rose-600 hover:bg-rose-50"
								onclick={() => (deletingAccount = { id: account.id, name: account.name })}
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

			<!-- Liste des comptes (desktop) -->
			<div class="hidden gap-3 sm:grid-cols-2 lg:grid">
				{#each data.accounts as account (account.id)}
					<div class="{cardBase} p-4">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<div class="truncate text-sm font-semibold text-zinc-900">{account.name}</div>
								<span class="mt-1 inline-block">
									<Badge tone="neutral">{netWorthAccountTypeLabel(account.type)}</Badge>
								</span>
								{#if account.connected}
									<span class="mt-1 ml-1 inline-block">
										<Badge tone="neutral">{m.net_worth_badge_connected()}</Badge>
									</span>
								{/if}
							</div>
							<div class="-my-3 flex shrink-0 items-center gap-1">
								<IconButton
									label={m.net_worth_edit_aria({ name: account.name })}
									onclick={() =>
										openEditModal({
											id: account.id,
											name: account.name,
											type: account.type,
											balanceEuros: account.balanceEuros
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
								<IconButton
									tone="danger"
									label={m.net_worth_delete_aria({ name: account.name })}
									onclick={() => (deletingAccount = { id: account.id, name: account.name })}
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
								</IconButton>
							</div>
						</div>
						<div
							class="mt-3 text-lg font-semibold tabular-nums {toneClass(
								account.type === 'debt' ? -account.balanceCents : account.balanceCents
							)}"
						>
							{formatCents(account.balanceCents)}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</section>
</main>

<!-- Create account modal -->
{#if showCreateModal}
	<Modal
		open={true}
		title={m.net_worth_modal_create_title()}
		description={m.net_worth_modal_description()}
		variant="compact"
		onClose={() => (showCreateModal = false)}
	>
		<p class="mb-1 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
			{m.net_worth_modal_create_title()}
		</p>
		<p class="mb-4 text-sm text-zinc-500 lg:hidden" aria-hidden="true">
			{m.net_worth_modal_description()}
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
			<label class="block text-xs font-medium text-zinc-600">
				{m.net_worth_field_name()}
				<input
					type="text"
					name="name"
					class="mt-1.5 w-full {inputBase}"
					placeholder={m.net_worth_field_name_placeholder()}
					required
				/>
			</label>
			<label class="block text-xs font-medium text-zinc-600">
				{m.net_worth_field_type()}
				<div class="mt-1.5">
					<Select
						name="type"
						bind:value={createType}
						options={typeOptions}
						ariaLabel={m.net_worth_field_type()}
					/>
				</div>
			</label>
			<MoneyInput
				name="balance"
				label={m.net_worth_field_balance()}
				labelClass="text-xs font-medium text-zinc-600"
				allowZero={true}
				allowNegative={true}
			/>
			<label class="block text-xs font-medium text-zinc-600">
				{m.net_worth_field_as_of_date()}
				<input type="date" name="asOfDate" max={todayIso} class="mt-1.5 w-full {inputBase}" />
				<span class="mt-1 block text-xs font-normal text-zinc-400"
					>{m.net_worth_field_as_of_date_hint()}</span
				>
			</label>
			{#if isLinkableNetWorthAccountType(createType)}
				<div
					class="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3.5 py-3"
				>
					<div class="min-w-0">
						<div class="text-xs font-medium text-zinc-900">{m.net_worth_field_connect_title()}</div>
						<div class="mt-0.5 text-xs text-zinc-500">
							{m.net_worth_field_connect_description()}
						</div>
					</div>
					<input
						type="hidden"
						name="connectToTransactions"
						value={createConnectToTransactions.toString()}
					/>
					<Switch
						checked={createConnectToTransactions}
						ariaLabel={m.net_worth_field_connect_title()}
						onchange={(next) => (createConnectToTransactions = next)}
					/>
				</div>
			{/if}
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

<!-- Modale — modifier un compte -->
{#if editingAccount}
	<Modal
		open={true}
		title={m.net_worth_modal_update_title()}
		description={m.net_worth_modal_description()}
		variant="compact"
		onClose={() => (editingAccount = null)}
	>
		<p class="mb-1 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
			{m.net_worth_modal_update_title()}
		</p>
		<p class="mb-4 text-sm text-zinc-500 lg:hidden" aria-hidden="true">
			{m.net_worth_modal_description()}
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
					if (result.type === 'success') editingAccount = null;
				};
			}}
		>
			<input type="hidden" name="id" value={editingAccount.id} />
			<label class="block text-xs font-medium text-zinc-600">
				{m.net_worth_field_name()}
				<input
					type="text"
					name="name"
					class="mt-1.5 w-full {inputBase}"
					value={editingAccount.name}
					required
				/>
			</label>
			<label class="block text-xs font-medium text-zinc-600">
				{m.net_worth_field_type()}
				<div class="mt-1.5">
					<Select
						name="type"
						bind:value={editingAccount.type}
						options={typeOptions}
						ariaLabel={m.net_worth_field_type()}
					/>
				</div>
			</label>
			<MoneyInput
				name="balance"
				label={m.net_worth_field_balance()}
				labelClass="text-xs font-medium text-zinc-600"
				value={editingAccount.balanceEuros}
				allowZero={true}
				allowNegative={true}
			/>
			<label class="block text-xs font-medium text-zinc-600">
				{m.net_worth_field_as_of_date()}
				<input type="date" name="asOfDate" max={todayIso} class="mt-1.5 w-full {inputBase}" />
				<span class="mt-1 block text-xs font-normal text-zinc-400"
					>{m.net_worth_field_as_of_date_hint()}</span
				>
			</label>
			{#if isLinkableNetWorthAccountType(editingAccount.type)}
				<div
					class="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 px-3.5 py-3"
				>
					<div class="min-w-0">
						<div class="text-xs font-medium text-zinc-900">{m.net_worth_field_connect_title()}</div>
						<div class="mt-0.5 text-xs text-zinc-500">
							{m.net_worth_field_connect_description()}
						</div>
					</div>
					<input
						type="hidden"
						name="connectToTransactions"
						value={editConnectToTransactions.toString()}
					/>
					<Switch
						checked={editConnectToTransactions}
						ariaLabel={m.net_worth_field_connect_title()}
						onchange={(next) => (editConnectToTransactions = next)}
					/>
				</div>
			{/if}
			{#if form?.error}
				<AlertBanner variant="error">{form.error}</AlertBanner>
			{/if}
			<div
				class="flex gap-2 border-t border-zinc-100 pt-3 lg:items-center lg:justify-end lg:border-0 lg:pt-1"
			>
				<TapLink
					class="flex-1 justify-center lg:flex-none"
					onclick={() => (editingAccount = null)}
					disabled={updateSubmitting}>{m.common_cancel()}</TapLink
				>
				<Button type="submit" class="flex-1 lg:flex-none" loading={updateSubmitting}
					>{m.net_worth_submit_update()}</Button
				>
			</div>
		</form>
	</Modal>
{/if}

<!-- ConfirmDialog — supprimer un compte -->
{#if deletingAccount}
	<form
		method="POST"
		action="?/delete"
		use:enhance={() => {
			deleteSubmitting = true;
			return async ({ result, update }) => {
				await update();
				deleteSubmitting = false;
				if (result.type === 'success') deletingAccount = null;
			};
		}}
	>
		<input type="hidden" name="id" value={deletingAccount.id} />
		<ConfirmDialog
			open={true}
			title={m.net_worth_delete_confirm_title({ name: deletingAccount.name })}
			confirmLabel={m.common_delete()}
			tone="danger"
			confirmLoading={deleteSubmitting}
			onClose={() => (deletingAccount = null)}
		>
			<p class="text-sm text-zinc-600">{m.net_worth_delete_confirm_body()}</p>
			{#if form?.error}
				<AlertBanner variant="error" class="mt-2">{form.error}</AlertBanner>
			{/if}
		</ConfirmDialog>
	</form>
{/if}
