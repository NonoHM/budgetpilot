<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { DropdownMenu as Menu } from 'bits-ui';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Button from '$lib/components/Button.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import DropdownMenu from '$lib/components/ui/DropdownMenu.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import MoneyInput from '$lib/components/ui/MoneyInput.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Spinner from '$lib/components/ui/Spinner.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import { cardBase, inputBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import {
		NET_WORTH_ACCOUNT_TYPES,
		suggestNetWorthAccountType,
		type NetWorthAccountType
	} from '$lib/domain/netWorth';
	import { netWorthAccountTypeLabel } from '$lib/domain/netWorthLabels';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Connection = PageData['connections'][number];
	type BankAccount = Connection['accounts'][number];

	let selectedBank = $state('');
	let connectOpen = $state(false);
	let startSubmitting = $state(false);
	/** Bank name shown in the pre-redirect transitional panel (design state 8). */
	let redirectingBank = $state<string | null>(null);
	let syncingConnectionId = $state<string | null>(null);
	let pendingDelete = $state<{ id: string; name: string; intent: 'revoke' | 'forget' } | null>(
		null
	);
	let deleteSubmitting = $state(false);

	let linkingAccount = $state<BankAccount | null>(null);
	let linkMode = $state<'existing' | 'create' | 'none'>('existing');
	let linkExistingId = $state('');
	let linkCreateType = $state<NetWorthAccountType>('checking');
	let linkSubmitting = $state(false);

	const typeOptions = NET_WORTH_ACCOUNT_TYPES.map((type) => ({
		value: type,
		label: netWorthAccountTypeLabel(type)
	}));

	const netWorthAccountOptions = $derived(
		data.linkableNetWorthAccounts.map((account) => ({ value: account.id, label: account.name }))
	);

	const linkModeOptions = $derived(
		[
			data.linkableNetWorthAccounts.length > 0
				? { value: 'existing', label: m.bank_connections_link_mode_existing() }
				: null,
			{ value: 'create', label: m.bank_connections_link_mode_create() },
			{ value: 'none', label: m.bank_connections_link_mode_none() }
		].filter((option) => option !== null)
	);

	const todayIso = new Date().toISOString().slice(0, 10);

	/**
	 * Opens the link modal, pre-selecting a sensible default: the current link if there is
	 * one, otherwise a fresh "create" pre-filled with the type suggestNetWorthAccountType()
	 * derives from the bucket's providerCashAccountType — never imposed, always editable
	 * before submit (D6/mapping decisions, see CLAUDE.md).
	 */
	function openLinkModal(account: BankAccount): void {
		linkingAccount = account;
		if (account.netWorthAccountId && data.linkableNetWorthAccounts.length > 0) {
			linkMode = 'existing';
			linkExistingId = account.netWorthAccountId;
		} else {
			linkMode = data.linkableNetWorthAccounts.length > 0 ? 'existing' : 'create';
			linkExistingId = '';
		}
		// hasCreditLimit isn't persisted (see domain/netWorth.ts's doc comment) — `false` is
		// the conservative "unknown" default, which only affects the CARD ambiguity branch.
		linkCreateType =
			suggestNetWorthAccountType(account.providerCashAccountType, false) ?? 'checking';
	}

	// FI included: Enable Banking's sandbox "Mock ASPSP" banks are Finnish.
	const COUNTRY_OPTIONS = ['FR', 'BE', 'DE', 'ES', 'IT', 'NL', 'PT', 'LU', 'FI'].map((code) => ({
		value: code,
		label: code
	}));

	/** "Expire bientôt" is a DISPLAY derivation only — status stays `active` in the data. */
	const EXPIRING_SOON_DAYS = 14;
	const DAY_MS = 24 * 60 * 60 * 1000;

	const bankOptions = $derived((data.banks ?? []).map((name) => ({ value: name, label: name })));

	function connectionName(connection: Connection): string {
		return connection.aspspName ?? connection.provider;
	}

	function isDisconnected(connection: Connection): boolean {
		return connection.status === 'expired' || connection.status === 'revoked';
	}

	function isExpiringSoon(connection: Connection): boolean {
		if (connection.status !== 'active' || !connection.consentExpiresAt) return false;
		return (
			new Date(connection.consentExpiresAt).getTime() - Date.now() <= EXPIRING_SOON_DAYS * DAY_MS
		);
	}

	function expiresInDays(connection: Connection): number {
		if (!connection.consentExpiresAt) return 0;
		return Math.max(
			0,
			Math.ceil((new Date(connection.consentExpiresAt).getTime() - Date.now()) / DAY_MS)
		);
	}

	/** The 6h throttle window, precomputed server-side — button disabled instead of a 429. */
	function canSyncNow(connection: Connection): boolean {
		return (
			!connection.syncAvailableAt || new Date(connection.syncAvailableAt).getTime() <= Date.now()
		);
	}

	function badgeTone(connection: Connection): 'neutral' | 'success' | 'warning' | 'danger' {
		if (isDisconnected(connection)) return 'neutral';
		if (connection.status === 'error') return 'danger';
		if (isExpiringSoon(connection)) return 'warning';
		return 'success';
	}

	function badgeLabel(connection: Connection): string {
		if (isDisconnected(connection)) return m.bank_connections_status_disconnected();
		if (connection.status === 'error') return m.bank_connections_status_error();
		if (isExpiringSoon(connection)) return m.bank_connections_status_expiring();
		return m.bank_connections_status_active();
	}

	function formatDateTime(iso: string): string {
		return new Date(iso).toLocaleString(getLocale(), { dateStyle: 'long', timeStyle: 'short' });
	}

	function formatDateOnly(iso: string): string {
		return new Date(iso).toLocaleDateString(getLocale(), { dateStyle: 'long' });
	}

	function formatTimeOnly(iso: string): string {
		return new Date(iso).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
	}

	function lastSyncLine(connection: Connection): string {
		return connection.lastSyncAt
			? m.bank_connections_last_sync({ date: formatDateTime(connection.lastSyncAt) })
			: m.bank_connections_never_synced();
	}

	/**
	 * Pre-redirect enhance handler shared by the connect and renew forms: shows the
	 * transitional role="status" panel, then waits ~400ms before letting SvelteKit
	 * follow the provider redirect, so screen readers can announce the departure
	 * (design precision 3).
	 */
	function redirectingEnhance(bank: string) {
		return () => {
			startSubmitting = true;
			redirectingBank = bank;
			return async ({ update }: { update: () => Promise<void> }) => {
				await new Promise((resolve) => setTimeout(resolve, 400));
				await update();
				// Only reached on failure (success navigates away).
				startSubmitting = false;
				redirectingBank = null;
			};
		};
	}

	const menuItemClass =
		'flex min-h-11 w-full items-center px-4 text-sm font-semibold outline-none data-[highlighted]:bg-zinc-50';
</script>

<svelte:head>
	<title>{m.bank_connections_page_title()}</title>
</svelte:head>

{#snippet bankIcon(stroke: string)}
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
		<path
			d="M3 9.5 12 4l9 5.5"
			{stroke}
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<path
			d="M4.5 9.5V19h15V9.5"
			{stroke}
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<path
			d="M8.5 19v-6h7v6"
			{stroke}
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
{/snippet}

{#snippet syncForm(connection: Connection, asTapLink: boolean)}
	<form
		method="POST"
		action="?/sync"
		use:enhance={() => {
			syncingConnectionId = connection.id;
			return async ({ update }) => {
				await update();
				syncingConnectionId = null;
			};
		}}
	>
		<input type="hidden" name="connectionId" value={connection.id} />
		{#if asTapLink}
			<TapLink
				type="submit"
				disabled={!canSyncNow(connection) || syncingConnectionId === connection.id}
			>
				{m.bank_connections_sync_action()}
			</TapLink>
		{:else}
			<Button
				type="submit"
				variant="secondary"
				size="field"
				loading={syncingConnectionId === connection.id}
				loadingLabel={m.bank_connections_syncing()}
				disabled={!canSyncNow(connection)}
			>
				{m.bank_connections_sync_now()}
			</Button>
		{/if}
	</form>
{/snippet}

{#snippet renewForm(connection: Connection, label: string, primary: boolean)}
	<form method="POST" action="?/renew" use:enhance={redirectingEnhance(connectionName(connection))}>
		<input type="hidden" name="connectionId" value={connection.id} />
		{#if primary}
			<Button type="submit" size="field" loading={startSubmitting}>{label}</Button>
		{:else}
			<TapLink type="submit" disabled={startSubmitting}>{label}</TapLink>
		{/if}
	</form>
{/snippet}

{#snippet moreMenu(connection: Connection)}
	<DropdownMenu
		triggerAriaLabel={m.bank_connections_more_actions()}
		triggerClass="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 text-zinc-500"
	>
		{#snippet trigger()}
			<svg width="16" height="4" viewBox="0 0 16 4" fill="none" aria-hidden="true">
				<circle cx="2" cy="2" r="1.6" fill="currentColor" />
				<circle cx="8" cy="2" r="1.6" fill="currentColor" />
				<circle cx="14" cy="2" r="1.6" fill="currentColor" />
			</svg>
		{/snippet}
		<div class="py-1.5">
			{#if isDisconnected(connection)}
				<Menu.Item
					onSelect={() =>
						(pendingDelete = {
							id: connection.id,
							name: connectionName(connection),
							intent: 'forget'
						})}
				>
					{#snippet child({ props })}
						<button {...props} type="button" class="{menuItemClass} text-zinc-700">
							{m.bank_connections_forget_action()}
						</button>
					{/snippet}
				</Menu.Item>
			{:else}
				{#if isExpiringSoon(connection)}
					<Menu.Item closeOnSelect={false}>
						{#snippet child({ props })}
							<form
								method="POST"
								action="?/sync"
								use:enhance={() => {
									syncingConnectionId = connection.id;
									return async ({ update }) => {
										await update();
										syncingConnectionId = null;
									};
								}}
							>
								<input type="hidden" name="connectionId" value={connection.id} />
								<button
									{...props}
									type="submit"
									class="{menuItemClass} text-zinc-700"
									disabled={!canSyncNow(connection)}
								>
									{m.bank_connections_sync_now()}
								</button>
							</form>
						{/snippet}
					</Menu.Item>
				{:else}
					<Menu.Item closeOnSelect={false}>
						{#snippet child({ props })}
							<form
								method="POST"
								action="?/renew"
								use:enhance={redirectingEnhance(connectionName(connection))}
							>
								<input type="hidden" name="connectionId" value={connection.id} />
								<button {...props} type="submit" class="{menuItemClass} text-zinc-700">
									{m.bank_connections_renew_action()}
								</button>
							</form>
						{/snippet}
					</Menu.Item>
				{/if}
				<Menu.Item
					onSelect={() =>
						(pendingDelete = {
							id: connection.id,
							name: connectionName(connection),
							intent: 'revoke'
						})}
				>
					{#snippet child({ props })}
						<button {...props} type="button" class="{menuItemClass} text-rose-600">
							{m.bank_connections_revoke_action()}
						</button>
					{/snippet}
				</Menu.Item>
			{/if}
		</div>
	</DropdownMenu>
{/snippet}

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<section class="mx-auto max-w-4xl space-y-6">
		<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
			<div>
				<h1 class="text-2xl font-semibold tracking-normal">{m.bank_connections_heading()}</h1>
				<p class="mt-0.5 text-sm text-zinc-500">{m.bank_connections_subtitle()}</p>
			</div>
			<a class="text-sm text-zinc-500 hover:text-zinc-700" href={resolve('/imports')}>
				{m.bank_connections_imports_link()}
			</a>
		</div>

		{#if data.connected}
			<AlertBanner variant="success">{m.bank_connections_connected_success()}</AlertBanner>
		{/if}
		{#if data.errorMessage}
			<AlertBanner variant="error">{data.errorMessage}</AlertBanner>
		{/if}
		{#if form?.success}
			<AlertBanner variant="success">{form.success}</AlertBanner>
		{/if}
		{#if form?.warning}
			<AlertBanner variant="warning">{form.warning}</AlertBanner>
		{/if}
		{#if form?.error && !pendingDelete}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}

		{#if !data.enabled}
			<AlertBanner variant="warning" size="md">{m.bank_connections_disabled_notice()}</AlertBanner>
		{:else}
			<!-- Pre-redirect transitional panel (design state 8) -->
			{#if redirectingBank}
				<div class="{cardBase} flex flex-col items-center gap-2.5 bg-zinc-50 px-5 py-6 text-center">
					<Spinner size={20} class="text-zinc-900" />
					<p role="status" class="text-sm text-zinc-700">
						{m.bank_connections_redirecting({ bank: redirectingBank })}
					</p>
					<p class="text-xs leading-relaxed text-zinc-400">{m.bank_connections_redirect_note()}</p>
				</div>
			{/if}

			<!-- Connections -->
			<div class="space-y-3">
				<h2 class="text-[11px] font-bold tracking-wider text-zinc-400 uppercase">
					{m.bank_connections_list_title()}
				</h2>

				{#if data.connections.length === 0}
					<EmptyState
						title={m.bank_connections_empty_title()}
						description={m.bank_connections_empty_description()}
						ctaLabel={m.bank_connections_connect_cta()}
						onCtaClick={() => (connectOpen = true)}
					>
						{#snippet icon()}
							{@render bankIcon('#a1a1aa')}
						{/snippet}
					</EmptyState>
				{:else}
					{#each data.connections as connection (connection.id)}
						<div class="{cardBase} flex flex-col gap-3.5 p-4 lg:p-5">
							<div class="flex items-start gap-3">
								<div
									class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-100"
									aria-hidden="true"
								>
									{@render bankIcon(isDisconnected(connection) ? '#a1a1aa' : '#71717a')}
								</div>
								<div class="flex min-w-0 flex-1 flex-col gap-1">
									<div class="flex flex-wrap items-center gap-2">
										<p
											class="truncate text-sm font-bold {isDisconnected(connection)
												? 'text-zinc-700'
												: 'text-zinc-950'}"
										>
											{connectionName(connection)}
										</p>
										<Badge tone={badgeTone(connection)}>{badgeLabel(connection)}</Badge>
									</div>
									<p role="status" class="text-xs leading-relaxed text-zinc-500">
										{#if isDisconnected(connection)}
											{#if connection.consentExpiresAt}
												{m.bank_connections_expired_on({
													date: formatDateOnly(connection.consentExpiresAt)
												})}
											{/if}
											{m.bank_connections_disconnected_notice()}
										{:else}
											{m.bank_connections_accounts_count({
												count: String(connection.accountCount)
											})}
											· {lastSyncLine(connection)}
											{#if isExpiringSoon(connection) && connection.consentExpiresAt}
												· {m.bank_connections_expires_in_days({
													date: formatDateOnly(connection.consentExpiresAt),
													days: String(expiresInDays(connection))
												})}
											{/if}
										{/if}
									</p>
									{#if !isDisconnected(connection) && !canSyncNow(connection) && connection.syncAvailableAt}
										<p class="text-xs text-zinc-400">
											{m.bank_connections_synced_recently({
												time: formatTimeOnly(connection.syncAvailableAt)
											})}
										</p>
									{/if}
								</div>
							</div>

							{#if connection.status === 'error'}
								<div
									role="status"
									class="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs leading-relaxed text-rose-700"
								>
									{m.bank_connections_sync_error_inline()}
								</div>
							{/if}

							{#if connection.accounts.length > 0}
								<div class="rounded-xl border border-zinc-200">
									<p
										class="border-b border-zinc-200 px-3 py-2 text-[11px] font-bold tracking-wider text-zinc-400 uppercase"
									>
										{m.bank_connections_accounts_section_title()}
									</p>
									<ul class="divide-y divide-zinc-100">
										{#each connection.accounts as account (account.id)}
											<li class="flex items-center justify-between gap-3 px-3 py-2.5">
												<div class="flex min-w-0 items-center gap-2">
													<p class="truncate text-sm text-zinc-700">{account.name}</p>
													{#if account.netWorthAccountId}
														<Badge tone="neutral">{m.net_worth_badge_connected()}</Badge>
													{/if}
												</div>
												<TapLink onclick={() => openLinkModal(account)}>
													{account.netWorthAccountId
														? m.bank_connections_link_action_edit()
														: m.bank_connections_link_action()}
												</TapLink>
											</li>
										{/each}
									</ul>
								</div>
							{/if}

							<div class="h-px bg-zinc-100" aria-hidden="true"></div>

							<!-- Desktop: full action row -->
							<div class="hidden items-center gap-4 lg:flex">
								{#if isDisconnected(connection)}
									{@render renewForm(connection, m.bank_connections_reconnect_action(), true)}
									<TapLink
										onclick={() =>
											(pendingDelete = {
												id: connection.id,
												name: connectionName(connection),
												intent: 'forget'
											})}
									>
										{m.bank_connections_forget_action()}
									</TapLink>
								{:else if isExpiringSoon(connection)}
									{@render renewForm(connection, m.bank_connections_renew_now(), true)}
									{@render syncForm(connection, true)}
									<TapLink
										tone="danger"
										onclick={() =>
											(pendingDelete = {
												id: connection.id,
												name: connectionName(connection),
												intent: 'revoke'
											})}
									>
										{m.bank_connections_revoke_action()}
									</TapLink>
								{:else}
									{@render syncForm(connection, false)}
									{@render renewForm(connection, m.bank_connections_renew_action(), false)}
									<TapLink
										tone="danger"
										onclick={() =>
											(pendingDelete = {
												id: connection.id,
												name: connectionName(connection),
												intent: 'revoke'
											})}
									>
										{m.bank_connections_revoke_action()}
									</TapLink>
								{/if}
							</div>

							<!-- Mobile: one primary action + "···" menu (ListCard convention) -->
							<div class="flex items-center gap-2.5 lg:hidden">
								{#if isDisconnected(connection)}
									<div class="flex-1">
										{@render renewForm(connection, m.bank_connections_reconnect_action(), true)}
									</div>
								{:else if isExpiringSoon(connection)}
									<div class="flex-1">
										{@render renewForm(connection, m.bank_connections_renew_now(), true)}
									</div>
								{:else}
									<div class="flex-1">
										{@render syncForm(connection, false)}
									</div>
								{/if}
								{@render moreMenu(connection)}
							</div>
						</div>
					{/each}
				{/if}
			</div>

			<!-- Connect a bank (progressive disclosure below the list) -->
			{#if data.connections.length > 0 && !connectOpen}
				<TapLink onclick={() => (connectOpen = true)}>
					{m.bank_connections_connect_another()}
				</TapLink>
			{/if}
			{#if connectOpen}
				<div class="{cardBase} p-4 lg:p-5">
					<h2 class="text-base font-semibold">{m.bank_connections_connect_title()}</h2>
					<p class="mt-0.5 text-sm text-zinc-500">{m.bank_connections_connect_description()}</p>
					{#if data.banks === null}
						<AlertBanner variant="error" class="mt-4">
							{m.bank_connections_banks_unavailable()}
						</AlertBanner>
					{:else}
						<form
							method="POST"
							action="?/start"
							class="mt-4 flex flex-col gap-3 md:flex-row md:items-end"
							use:enhance={redirectingEnhance(selectedBank)}
						>
							<div class="w-full md:w-28">
								<label class="mb-1 block text-xs font-medium text-zinc-600" for="bank-country">
									{m.bank_connections_country_label()}
								</label>
								<Select
									options={COUNTRY_OPTIONS}
									value={data.country}
									name="country"
									ariaLabel={m.bank_connections_country_label()}
									onValueChange={(value) => {
										selectedBank = '';
										goto(
											resolve(
												`/imports/bank-connections?country=${value}` as `/imports/bank-connections?${string}`
											),
											{ keepFocus: true, noScroll: true }
										);
									}}
								/>
							</div>
							<div class="w-full md:flex-1">
								<label class="mb-1 block text-xs font-medium text-zinc-600" for="bank-name">
									{m.bank_connections_bank_label()}
								</label>
								<Combobox
									options={bankOptions}
									bind:value={selectedBank}
									name="bank"
									required
									placeholder={m.bank_connections_bank_placeholder()}
									ariaLabel={m.bank_connections_bank_label()}
								/>
							</div>
							<Button type="submit" size="field" loading={startSubmitting} disabled={!selectedBank}>
								{m.bank_connections_connect_submit()}
							</Button>
						</form>
					{/if}
				</div>
			{/if}
		{/if}
	</section>
</main>

<!-- ConfirmDialog — revoke/forget a connection -->
{#if pendingDelete}
	<form
		method="POST"
		action="?/delete"
		use:enhance={() => {
			deleteSubmitting = true;
			return async ({ result, update }) => {
				await update();
				deleteSubmitting = false;
				if (result.type === 'success') pendingDelete = null;
			};
		}}
	>
		<input type="hidden" name="connectionId" value={pendingDelete.id} />
		<ConfirmDialog
			open={true}
			title={pendingDelete.intent === 'forget'
				? m.bank_connections_delete_confirm_title()
				: m.bank_connections_revoke_confirm_title({ bank: pendingDelete.name })}
			description={pendingDelete.intent === 'forget'
				? m.bank_connections_delete_confirm_description()
				: m.bank_connections_revoke_confirm_description()}
			confirmLabel={pendingDelete.intent === 'forget'
				? m.bank_connections_delete_action()
				: m.bank_connections_revoke_action()}
			tone="danger"
			confirmLoading={deleteSubmitting}
			onClose={() => (pendingDelete = null)}
		>
			{#if form?.error}
				<AlertBanner variant="error" class="mt-2">{form.error}</AlertBanner>
			{/if}
		</ConfirmDialog>
	</form>
{/if}

<!-- Explicit net worth link — never automatic, always editable (D1/D2) -->
{#if linkingAccount}
	<Modal
		open={true}
		title={m.bank_connections_link_modal_title({ account: linkingAccount.name })}
		description={m.bank_connections_link_modal_description()}
		variant="compact"
		onClose={() => (linkingAccount = null)}
	>
		<form
			method="POST"
			action="?/linkAccount"
			class="space-y-4"
			use:enhance={() => {
				linkSubmitting = true;
				return async ({ result, update }) => {
					await update();
					linkSubmitting = false;
					if (result.type === 'success') linkingAccount = null;
				};
			}}
		>
			<input type="hidden" name="accountId" value={linkingAccount.id} />

			<label class="block text-xs font-medium text-zinc-600">
				{m.bank_connections_link_mode_label()}
				<div class="mt-1.5">
					<Select
						name="mode"
						bind:value={linkMode}
						options={linkModeOptions}
						ariaLabel={m.bank_connections_link_mode_label()}
					/>
				</div>
			</label>

			{#if linkMode === 'existing'}
				<label class="block text-xs font-medium text-zinc-600">
					{m.bank_connections_link_existing_label()}
					<div class="mt-1.5">
						<Combobox
							name="netWorthAccountId"
							bind:value={linkExistingId}
							options={netWorthAccountOptions}
							placeholder={m.bank_connections_link_existing_placeholder()}
							ariaLabel={m.bank_connections_link_existing_label()}
							required
						/>
					</div>
				</label>
			{:else if linkMode === 'create'}
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
							bind:value={linkCreateType}
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
			{:else}
				<p class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500">
					{m.bank_connections_link_none_hint()}
				</p>
			{/if}

			{#if form?.error}
				<AlertBanner variant="error">{form.error}</AlertBanner>
			{/if}

			<div
				class="flex gap-2 border-t border-zinc-100 pt-3 lg:items-center lg:justify-end lg:border-0 lg:pt-1"
			>
				<TapLink
					class="flex-1 justify-center lg:flex-none"
					onclick={() => (linkingAccount = null)}
					disabled={linkSubmitting}
				>
					{m.common_cancel()}
				</TapLink>
				<Button type="submit" class="flex-1 lg:flex-none" loading={linkSubmitting}>
					{m.bank_connections_link_submit()}
				</Button>
			</div>
		</form>
	</Modal>
{/if}
