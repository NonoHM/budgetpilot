<script lang="ts">
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { cardBase, inputBase } from '$lib/styles';
	import Badge from '$lib/components/ui/Badge.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const dateFormatter = new Intl.DateTimeFormat(getLocale(), {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric'
	});
	function formatDate(value: Date | string): string {
		return dateFormatter.format(new Date(value));
	}

	const dateTimeFormatter = new Intl.DateTimeFormat(getLocale(), {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
	function formatDateTime(value: Date | string): string {
		return dateTimeFormatter.format(new Date(value));
	}

	function pluralTx(n: number): string {
		return n > 1
			? m.categories_delete_tx_count_many({ count: n })
			: m.categories_delete_tx_count_one({ count: n });
	}

	let deleteTarget: (typeof data.users)[number] | null = $state(null);
	let resetTarget: (typeof data.users)[number] | null = $state(null);
	let revokeInviteTarget: (typeof data.invitations)[number] | null = $state(null);

	function buildPageHref(page: number): string {
		// Local scratch value, built and discarded within this function; never stored as reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const params = new URLSearchParams();
		params.set('page', String(page));
		return `?${params.toString()}`;
	}

	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | undefined;
	async function copyTempPassword() {
		if (!form?.temporaryPassword || !navigator.clipboard) return;
		await navigator.clipboard.writeText(form.temporaryPassword);
		copied = true;
		clearTimeout(copyTimeout);
		copyTimeout = setTimeout(() => {
			copied = false;
		}, 1500);
	}

	let inviteCopied = $state(false);
	let inviteCopyTimeout: ReturnType<typeof setTimeout> | undefined;
	async function copyInviteUrl() {
		if (!form?.inviteUrl || !navigator.clipboard) return;
		await navigator.clipboard.writeText(form.inviteUrl);
		inviteCopied = true;
		clearTimeout(inviteCopyTimeout);
		inviteCopyTimeout = setTimeout(() => {
			inviteCopied = false;
		}, 1500);
	}
</script>

<svelte:head>
	<title>{m.admin_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<!-- ============ DESKTOP (≥lg, unchanged) ============ -->
	<section class="mx-auto hidden max-w-5xl space-y-4 lg:block">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h1 class="text-2xl font-semibold tracking-normal">{m.admin_heading()}</h1>
				<p class="mt-1 text-sm text-zinc-500">{m.admin_subtitle()}</p>
			</div>
			<Button href="/register">
				{m.admin_create_user()}
			</Button>
		</div>

		{#if form?.temporaryPassword}
			<div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
				<p class="font-medium">
					{m.admin_temp_password_for({ email: form.resetTargetEmail ?? '' })}
					<span class="font-mono text-base">{form.temporaryPassword}</span>
				</p>
				<p class="mt-1 text-xs text-amber-700">
					{m.admin_temp_password_notice()}
				</p>
			</div>
		{/if}

		{#if form?.deleteSuccess}
			<AlertBanner variant="success">{form.deleteSuccess}</AlertBanner>
		{/if}

		{#if form?.deleteError}
			<AlertBanner variant="error">{form.deleteError}</AlertBanner>
		{/if}

		{#if form?.resetError}
			<AlertBanner variant="error">{form.resetError}</AlertBanner>
		{/if}

		<div class="overflow-hidden rounded-lg border border-zinc-200 bg-white">
			<table class="w-full text-sm">
				<thead
					class="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500"
				>
					<tr>
						<th class="px-4 py-3 font-medium">{m.admin_table_email()}</th>
						<th class="px-4 py-3 font-medium">{m.admin_table_role()}</th>
						<th class="px-4 py-3 font-medium">{m.admin_table_created()}</th>
						<th class="px-4 py-3 font-medium">{m.admin_table_transactions()}</th>
						<th class="px-4 py-3 font-medium">{m.admin_table_actions()}</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-100">
					{#each data.users as user (user.id)}
						<tr>
							<td class="px-4 py-3 text-zinc-900">{user.email}</td>
							<td class="px-4 py-3">
								{#if user.role === 'ADMIN'}
									<span
										class="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white"
									>
										{user.role}
									</span>
								{:else}
									<span
										class="rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600"
									>
										{user.role}
									</span>
								{/if}
							</td>
							<td class="px-4 py-3 text-zinc-500">{formatDate(user.createdAt)}</td>
							<td class="px-4 py-3 tabular-nums text-zinc-500">{user.transactionCount}</td>
							<td class="px-4 py-3">
								{#if user.id !== data.currentUserId}
									<div class="flex items-center gap-3">
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onclick={() => (resetTarget = user)}>{m.admin_reset_password()}</Button
										>
										<Button
											type="button"
											variant="ghost-danger"
											size="sm"
											onclick={() => (deleteTarget = user)}>{m.common_delete()}</Button
										>
									</div>
								{:else}
									<span class="text-xs text-zinc-400">{m.admin_you()}</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if data.pagination.totalPages > 1}
			<div class="flex items-center justify-between gap-2">
				<p class="text-sm text-zinc-500">
					{m.admin_pagination_page({
						page: data.pagination.page,
						totalPages: data.pagination.totalPages
					})}
				</p>
				<div class="flex gap-2">
					<Button
						variant="secondary"
						size="sm"
						href={buildPageHref(data.pagination.page - 1)}
						disabled={!data.pagination.hasPrevious}>{m.transactions_previous()}</Button
					>
					<Button
						variant="secondary"
						size="sm"
						href={buildPageHref(data.pagination.page + 1)}
						disabled={!data.pagination.hasNext}>{m.transactions_next()}</Button
					>
				</div>
			</div>
		{/if}

		<div class="space-y-3 border-t border-zinc-200 pt-4">
			<div>
				<h2 class="text-lg font-semibold tracking-normal">{m.admin_invitations_heading()}</h2>
				<p class="mt-1 text-sm text-zinc-500">{m.admin_invitations_subtitle()}</p>
			</div>

			<form method="POST" action="?/createInvitation" class="flex items-end gap-3">
				<label class="grid gap-1 text-sm font-medium">
					{m.admin_invitation_email_label()}
					<input
						class={inputBase}
						name="email"
						type="email"
						autocomplete="off"
						placeholder={m.admin_invitation_email_placeholder()}
					/>
				</label>
				<Button type="submit" size="field">{m.admin_invitation_create()}</Button>
			</form>

			{#if form?.inviteError}
				<AlertBanner variant="error">{form.inviteError}</AlertBanner>
			{/if}

			{#if form?.inviteUrl}
				<div
					class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
				>
					<p class="flex items-start gap-1.5 font-medium">
						<svg
							class="mt-0.5 h-4 w-4 shrink-0"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M12 3.5 21 19H3L12 3.5Z" stroke-linejoin="round" />
							<path d="M12 9.5v4M12 16.5h.01" />
						</svg>
						{m.admin_invitation_created_notice()}
					</p>
					<div class="mt-2 flex items-center gap-2">
						<input
							class="w-full truncate rounded-md border border-amber-200 bg-white px-2 py-1 font-mono text-xs text-zinc-900"
							type="text"
							readonly
							value={form.inviteUrl}
							onclick={(event) => (event.currentTarget as HTMLInputElement).select()}
						/>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							class="inline-flex shrink-0 items-center gap-1.5"
							onclick={copyInviteUrl}
						>
							<svg
								class="h-3.5 w-3.5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<rect x="8" y="4" width="8" height="4" rx="1" />
								<path
									d="M8 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2"
								/>
							</svg>
							{inviteCopied ? m.admin_copied() : m.common_copy()}
						</Button>
					</div>
					<p class="mt-1 text-xs text-amber-700">
						{m.admin_invitation_created_expiry({
							expiresAt: formatDateTime(form.inviteExpiresAt ?? new Date())
						})}
					</p>
				</div>
			{/if}

			{#if form?.revokeInviteError}
				<AlertBanner variant="error">{form.revokeInviteError}</AlertBanner>
			{/if}
			{#if form?.revokeInviteSuccess}
				<AlertBanner variant="success">{form.revokeInviteSuccess}</AlertBanner>
			{/if}

			{#if data.invitations.length > 0}
				<div class="overflow-hidden rounded-lg border border-zinc-200 bg-white">
					<table class="w-full text-sm">
						<thead
							class="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500"
						>
							<tr>
								<th class="px-4 py-3 font-medium">{m.admin_table_email()}</th>
								<th class="px-4 py-3 font-medium">{m.admin_invitation_expires()}</th>
								<th class="px-4 py-3 font-medium">{m.admin_table_actions()}</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-100">
							{#each data.invitations as invitation (invitation.id)}
								<tr>
									<td class="px-4 py-3 text-zinc-900"
										>{invitation.email ?? m.admin_invitation_generic_link()}</td
									>
									<td class="px-4 py-3 text-zinc-500">{formatDateTime(invitation.expiresAt)}</td>
									<td class="px-4 py-3">
										<button
											type="button"
											class="text-sm font-medium text-rose-600 hover:text-rose-700"
											onclick={() => (revokeInviteTarget = invitation)}
										>
											{m.admin_invitation_revoke()}
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="text-sm text-zinc-500">{m.admin_invitations_empty()}</p>
			{/if}
		</div>
	</section>

	<!-- ============ MOBILE (<lg) ============ -->
	<section class="mx-auto max-w-4xl space-y-4 lg:hidden">
		{#if form?.temporaryPassword}
			<div class="rounded-xl border border-amber-200 bg-amber-50 p-4">
				<div
					class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-amber-800"
				>
					<svg
						class="h-3.5 w-3.5 shrink-0"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M12 3.5 21 19H3L12 3.5Z" />
						<path d="M12 9.5v4M12 16.5h.01" />
					</svg>
					{m.admin_temp_password_title()}
				</div>
				<p class="mt-1.5 text-sm text-amber-900">
					{m.admin_temp_password_prefix()}
					<span class="font-semibold">{form.resetTargetEmail}</span>
				</p>
				<div class="mt-3 flex items-center justify-between gap-3 rounded-xl bg-white px-4 py-3">
					<span class="truncate font-mono text-base font-semibold text-zinc-900"
						>{form.temporaryPassword}</span
					>
					<IconButton label={m.admin_copy_password_aria()} onclick={copyTempPassword}>
						{#if copied}
							<svg
								class="h-5 w-5 text-emerald-600"
								viewBox="0 0 20 20"
								fill="none"
								aria-hidden="true"
							>
								<path
									d="M4.5 10.5 8 14l7.5-9"
									stroke="currentColor"
									stroke-width="2.2"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						{:else}
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<rect x="8" y="4" width="8" height="4" rx="1" />
								<path
									d="M8 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2"
								/>
							</svg>
						{/if}
					</IconButton>
				</div>
				<p class="mt-2 text-xs text-amber-700">{m.admin_temp_password_notice_mobile()}</p>
			</div>
		{/if}

		<div>
			<h1 class="text-xl font-semibold">{m.admin_heading()}</h1>
			<p class="mt-1 text-sm text-zinc-500">{m.admin_subtitle()}</p>
		</div>

		<Button href="/register" class="h-11 w-full">
			{m.admin_create_user()}
		</Button>

		{#if form?.deleteSuccess}
			<AlertBanner variant="success">{form.deleteSuccess}</AlertBanner>
		{/if}

		{#if form?.deleteError}
			<AlertBanner variant="error">{form.deleteError}</AlertBanner>
		{/if}

		{#if form?.resetError}
			<AlertBanner variant="error">{form.resetError}</AlertBanner>
		{/if}

		<div class="space-y-3">
			{#each data.users as user (user.id)}
				{@const isSelf = user.id === data.currentUserId}
				{#snippet userPrimary()}
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<span class="truncate text-[15.5px] font-bold text-zinc-950">{user.email}</span>
								{#if user.role === 'ADMIN'}
									<span class="shrink-0">
										<Badge tone="neutral" solid>{user.role}</Badge>
									</span>
								{:else}
									<span class="shrink-0">
										<Badge tone="neutral" bordered>{user.role}</Badge>
									</span>
								{/if}
							</div>
							<p class="mt-0.5 text-[12.5px] text-zinc-400">
								{m.admin_table_created()}
								{formatDate(user.createdAt)} · {pluralTx(user.transactionCount)}
							</p>
						</div>
						{#if isSelf}
							<span class="shrink-0">
								<Badge tone="neutral">{m.admin_you()}</Badge>
							</span>
						{/if}
					</div>

					{#if !isSelf}
						<div class="mt-3.5">
							<Button
								type="button"
								variant="secondary"
								class="h-11 w-full !rounded-xl"
								onclick={() => (resetTarget = user)}
							>
								{m.admin_reset_password()}
							</Button>
						</div>
					{/if}
				{/snippet}

				{#if isSelf}
					<div class="{cardBase} p-[18px]">
						{@render userPrimary()}
					</div>
				{:else}
					<ListCard expandAriaLabel={m.admin_delete_expand_aria({ email: user.email })}>
						{@render userPrimary()}
						{#snippet details()}
							<div class="flex items-center justify-end">
								<button
									type="button"
									class="flex min-h-11 items-center justify-center text-sm font-medium text-rose-600 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2"
									onclick={() => (deleteTarget = user)}
								>
									{m.common_delete()}
								</button>
							</div>
						{/snippet}
					</ListCard>
				{/if}
			{/each}
		</div>

		{#if data.pagination.totalPages > 1}
			<div class="flex items-center justify-between gap-2">
				<Button
					variant="secondary"
					class="h-11"
					href={buildPageHref(data.pagination.page - 1)}
					disabled={!data.pagination.hasPrevious}>{m.transactions_previous()}</Button
				>
				<p class="text-xs text-zinc-500">
					{m.admin_pagination_page({
						page: data.pagination.page,
						totalPages: data.pagination.totalPages
					})}
				</p>
				<Button
					variant="secondary"
					class="h-11"
					href={buildPageHref(data.pagination.page + 1)}
					disabled={!data.pagination.hasNext}>{m.transactions_next()}</Button
				>
			</div>
		{/if}

		<div class="space-y-3 border-t border-zinc-200 pt-4">
			<div>
				<h2 class="text-lg font-semibold">{m.admin_invitations_heading()}</h2>
				<p class="mt-1 text-sm text-zinc-500">{m.admin_invitations_subtitle()}</p>
			</div>

			<form method="POST" action="?/createInvitation" class="space-y-2">
				<label class="grid gap-1 text-sm font-medium">
					{m.admin_invitation_email_label()}
					<input
						class={inputBase}
						name="email"
						type="email"
						autocomplete="off"
						placeholder={m.admin_invitation_email_placeholder()}
					/>
				</label>
				<Button type="submit" class="h-11 w-full !rounded-xl">{m.admin_invitation_create()}</Button>
			</form>

			{#if form?.inviteError}
				<AlertBanner variant="error">{form.inviteError}</AlertBanner>
			{/if}

			{#if form?.inviteUrl}
				<div class="rounded-xl border border-amber-200 bg-amber-50 p-4">
					<p class="flex items-start gap-1.5 text-sm font-medium text-amber-900">
						<svg
							class="mt-0.5 h-4 w-4 shrink-0"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M12 3.5 21 19H3L12 3.5Z" stroke-linejoin="round" />
							<path d="M12 9.5v4M12 16.5h.01" />
						</svg>
						{m.admin_invitation_created_notice()}
					</p>
					<div class="mt-2 flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2">
						<span class="truncate font-mono text-xs text-zinc-900">{form.inviteUrl}</span>
						<button
							type="button"
							class="flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"
							onclick={copyInviteUrl}
						>
							<svg
								class="h-3.5 w-3.5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<rect x="8" y="4" width="8" height="4" rx="1" />
								<path
									d="M8 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-2"
								/>
							</svg>
							{inviteCopied ? m.admin_copied() : m.common_copy()}
						</button>
					</div>
					<p class="mt-2 text-xs text-amber-700">
						{m.admin_invitation_created_expiry({
							expiresAt: formatDateTime(form.inviteExpiresAt ?? new Date())
						})}
					</p>
				</div>
			{/if}

			{#if form?.revokeInviteError}
				<AlertBanner variant="error">{form.revokeInviteError}</AlertBanner>
			{/if}
			{#if form?.revokeInviteSuccess}
				<AlertBanner variant="success">{form.revokeInviteSuccess}</AlertBanner>
			{/if}

			{#if data.invitations.length > 0}
				<div class="space-y-2">
					{#each data.invitations as invitation (invitation.id)}
						<!-- Revoke stays always visible: unlike the other cards in this migration wave,
						     an invitation row has exactly one action — hiding a card's sole action
						     behind an expand tap adds friction with no decluttering benefit, since
						     there's nothing else on the card competing for space. -->
						<ListCard>
							<div class="flex items-center justify-between gap-3">
								<div class="min-w-0">
									<p class="truncate text-sm font-medium text-zinc-900">
										{invitation.email ?? m.admin_invitation_generic_link()}
									</p>
									<p class="text-xs text-zinc-500">
										{m.admin_invitation_expires()}
										{formatDateTime(invitation.expiresAt)}
									</p>
								</div>
								<button
									type="button"
									class="flex min-h-11 shrink-0 items-center text-sm font-medium text-rose-600 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2"
									onclick={() => (revokeInviteTarget = invitation)}
								>
									{m.admin_invitation_revoke()}
								</button>
							</div>
						</ListCard>
					{/each}
				</div>
			{:else}
				<p class="text-sm text-zinc-500">{m.admin_invitations_empty()}</p>
			{/if}
		</div>
	</section>
</main>

<!-- Confirm suppression -->
<form method="POST" action="?/deleteUser">
	<input type="hidden" name="targetUserId" value={deleteTarget?.id ?? ''} />
	<ConfirmDialog
		open={deleteTarget !== null}
		title={m.admin_delete_confirm_title()}
		description={m.admin_delete_confirm_description()}
		confirmLabel={m.common_delete()}
		tone="danger"
		onClose={() => (deleteTarget = null)}
	>
		{#if deleteTarget}
			<p class="text-sm text-zinc-600">
				{m.admin_delete_confirm_prefix()}
				<span class="font-medium text-zinc-900">{deleteTarget.email}</span>
				{m.admin_delete_confirm_suffix({
					transactions: deleteTarget.transactionCount,
					categories: deleteTarget.categoryCount,
					budgets: deleteTarget.budgetCount
				})}
			</p>
		{/if}
	</ConfirmDialog>
</form>

<!-- Confirm password reset -->
<form method="POST" action="?/resetPassword">
	<input type="hidden" name="targetUserId" value={resetTarget?.id ?? ''} />
	<ConfirmDialog
		open={resetTarget !== null}
		title={m.admin_reset_confirm_title()}
		description={m.admin_reset_confirm_description()}
		confirmLabel={m.admin_reset_confirm_label()}
		onClose={() => (resetTarget = null)}
	>
		{#if resetTarget}
			<p class="text-sm text-zinc-600">
				{m.admin_reset_confirm_body({ email: resetTarget.email })}
			</p>
		{/if}
	</ConfirmDialog>
</form>

<!-- Confirm invitation revocation -->
<form method="POST" action="?/revokeInvitation">
	<input type="hidden" name="invitationId" value={revokeInviteTarget?.id ?? ''} />
	<ConfirmDialog
		open={revokeInviteTarget !== null}
		title={m.admin_invitation_revoke_confirm_title()}
		description={m.admin_invitation_revoke_confirm_description()}
		confirmLabel={m.admin_invitation_revoke()}
		tone="danger"
		onClose={() => (revokeInviteTarget = null)}
	>
		{#if revokeInviteTarget}
			<p class="text-sm text-zinc-600">
				{m.admin_invitation_revoke_confirm_body({
					email: revokeInviteTarget.email ?? m.admin_invitation_generic_link()
				})}
			</p>
		{/if}
	</ConfirmDialog>
</form>
