<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import type { ActionData, PageData } from './$types';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let pendingCancel = $state<{ id: string; fileName: string | null; importedRows: number } | null>(
		null
	);
	let cancelSubmitting = $state(false);

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString(getLocale(), { dateStyle: 'long', timeStyle: 'short' });
	}

	function formatDateOnly(iso: string): string {
		return new Date(iso).toLocaleDateString(getLocale(), { dateStyle: 'long' });
	}

	function cancelConfirmDescription(importedRows: number): string {
		return importedRows > 1
			? m.imports_cancel_confirm_description_count_many({ count: importedRows })
			: m.imports_cancel_confirm_description_count_one({ count: importedRows });
	}
</script>

<svelte:head>
	<title>{m.imports_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<section class="mx-auto max-w-7xl space-y-6">
		<!-- Header -->
		<div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
			<div>
				<h1 class="text-2xl font-semibold tracking-normal">{m.imports_heading()}</h1>
				<p class="mt-0.5 text-sm text-zinc-500">
					{m.imports_subtitle()}
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-3">
				<a class="text-sm text-zinc-500 hover:text-zinc-700" href={resolve('/transactions')}>
					{m.imports_transactions_link()}
				</a>
				<a
					class="text-sm text-zinc-500 hover:text-zinc-700"
					href={resolve('/imports/bank-connections')}
				>
					{m.bank_connections_heading()}
				</a>
				<Button href="/import">
					{m.imports_new()}
				</Button>
			</div>
		</div>

		{#if data.cancelled}
			<AlertBanner variant="success">{m.imports_cancelled_notice()}</AlertBanner>
		{/if}
		<!-- Gated to skip while the cancel-import ConfirmDialog is open: it already shows its own
		     contextual AlertBanner for the same form.error — without this, both would mount
		     role="alert" simultaneously for the same message, double-announcing it to screen
		     readers. -->
		{#if form?.error && !pendingCancel}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}

		{#if data.batches.length === 0}
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
					<path d="M12 16V4M7 9l5-5 5 5" />
					<path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
				</svg>
			{/snippet}
			<EmptyState
				icon={emptyIcon}
				title={m.imports_empty_title()}
				description={m.imports_empty_description()}
				ctaLabel={m.imports_empty_cta()}
				ctaHref="/import"
			/>
		{:else}
			<!-- ============ DESKTOP (≥lg, unchanged) ============ -->
			<div class="hidden rounded-lg border border-zinc-200 bg-white lg:block">
				<div class="overflow-x-auto">
					<table class="w-full min-w-[900px] text-left text-sm">
						<thead class="border-b border-zinc-200 text-xs text-zinc-500 uppercase">
							<tr>
								<th class="px-4 py-3 font-medium">{m.imports_table_date()}</th>
								<th class="px-4 py-3 font-medium">{m.imports_table_file()}</th>
								<th class="px-4 py-3 font-medium">{m.imports_table_profile()}</th>
								<th class="px-4 py-3 font-medium">{m.imports_table_period()}</th>
								<th class="px-4 py-3 text-right font-medium">{m.imports_table_read()}</th>
								<th class="px-4 py-3 text-right font-medium">{m.imports_table_imported()}</th>
								<th class="px-4 py-3 text-right font-medium">{m.imports_table_duplicates()}</th>
								<th class="px-4 py-3 text-right font-medium">{m.imports_table_invalid()}</th>
								<th class="px-4 py-3 text-right font-medium">{m.imports_table_actions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.batches as batch (batch.id)}
								<tr class="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
									<td class="px-4 py-3 text-zinc-600" title={batch.createdAt}>
										{formatDate(batch.createdAt)}
									</td>
									<td class="px-4 py-3 font-medium"
										>{batch.fileName ?? m.imports_default_file_name()}</td
									>
									<td class="px-4 py-3 text-zinc-700">{batch.profile}</td>
									<td class="px-4 py-3 text-zinc-500">
										{batch.periodStart ? formatDateOnly(batch.periodStart) : 'n/a'} –
										{batch.periodEnd ? formatDateOnly(batch.periodEnd) : 'n/a'}
									</td>
									<td
										class="px-4 py-3 text-right tabular-nums"
										class:text-zinc-300={batch.rowCount === 0}
										class:text-zinc-700={batch.rowCount > 0}
									>
										{batch.rowCount}
									</td>
									<td
										class="px-4 py-3 text-right tabular-nums"
										class:text-zinc-300={batch.importedRows === 0}
										class:text-zinc-700={batch.importedRows > 0}
									>
										{batch.importedRows}
									</td>
									<td
										class="px-4 py-3 text-right tabular-nums"
										class:text-zinc-300={batch.duplicateRows === 0}
										class:text-amber-600={batch.duplicateRows > 0}
									>
										{batch.duplicateRows}
									</td>
									<td
										class="px-4 py-3 text-right tabular-nums"
										class:text-zinc-300={batch.invalidRows === 0}
										class:text-rose-600={batch.invalidRows > 0}
									>
										{batch.invalidRows}
									</td>
									<td class="px-4 py-3 text-right">
										<div class="flex justify-end gap-2">
											<Button
												variant="secondary"
												size="sm"
												href={resolve(
													`/transactions?importBatch=${batch.id}` as `/transactions?${string}`
												)}
											>
												{m.imports_view()}
											</Button>
											<Button
												type="button"
												variant="ghost-danger"
												size="sm"
												onclick={() =>
													(pendingCancel = {
														id: batch.id,
														fileName: batch.fileName,
														importedRows: batch.importedRows
													})}>{m.common_delete()}</Button
											>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>

			<!-- ============ MOBILE (<lg) ============ -->
			<div class="lg:hidden">
				<div class="space-y-3">
					{#each data.batches as batch (batch.id)}
						<ListCard
							expandAriaLabel={m.imports_cancel_expand_aria({
								name: batch.fileName ?? m.imports_default_file_name()
							})}
						>
							<div class="flex items-start justify-between gap-3">
								<p class="font-bold text-zinc-950" title={batch.createdAt}>
									{formatDate(batch.createdAt)}
								</p>
								<span class="shrink-0">
									<Badge tone="neutral">{batch.profile}</Badge>
								</span>
							</div>
							<p class="mt-1 truncate text-sm text-zinc-500">
								{batch.fileName ?? m.imports_default_file_name()}
							</p>
							<p class="mt-1 text-sm text-zinc-400">
								{#if batch.periodStart || batch.periodEnd}
									{batch.periodStart ? formatDateOnly(batch.periodStart) : 'n/a'} – {batch.periodEnd
										? formatDateOnly(batch.periodEnd)
										: 'n/a'}
								{:else}
									n/a
								{/if}
							</p>
							<p class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-600">
								<span
									>{m.imports_table_read()}
									<span class="font-semibold text-zinc-900">{batch.rowCount}</span></span
								>
								<span
									>{m.imports_table_imported()}
									<span class="font-semibold text-zinc-900">{batch.importedRows}</span></span
								>
								<span class:text-amber-600={batch.duplicateRows > 0}
									>{m.imports_table_duplicates()}
									<span class="font-semibold" class:text-amber-600={batch.duplicateRows > 0}
										>{batch.duplicateRows}</span
									></span
								>
								<span class:text-rose-600={batch.invalidRows > 0}
									>{m.imports_table_invalid()}
									<span class="font-semibold" class:text-rose-600={batch.invalidRows > 0}
										>{batch.invalidRows}</span
									></span
								>
							</p>
							<div class="mt-3 border-t border-zinc-100 pt-3">
								<a
									href={resolve(
										`/transactions?importBatch=${batch.id}` as `/transactions?${string}`
									)}
									class="flex min-h-[44px] items-center text-sm font-semibold text-zinc-900 hover:text-zinc-700"
								>
									{m.imports_view()}
								</a>
							</div>
							{#snippet details()}
								<div class="flex items-center justify-end">
									<IconButton
										tone="danger"
										label={m.common_delete()}
										onclick={() =>
											(pendingCancel = {
												id: batch.id,
												fileName: batch.fileName,
												importedRows: batch.importedRows
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
											<path
												d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6M6 6v9.5A1.5 1.5 0 0 0 7.5 17h5A1.5 1.5 0 0 0 14 15.5V6"
											/>
										</svg>
									</IconButton>
								</div>
							{/snippet}
						</ListCard>
					{/each}
				</div>
			</div>
		{/if}
	</section>
</main>

<!-- ConfirmDialog — supprimer un import -->
{#if pendingCancel}
	<form
		method="POST"
		action="?/cancel"
		use:enhance={() => {
			cancelSubmitting = true;
			return async ({ result, update }) => {
				await update();
				cancelSubmitting = false;
				if (result.type === 'redirect') pendingCancel = null;
			};
		}}
	>
		<input type="hidden" name="batchId" value={pendingCancel.id} />
		<ConfirmDialog
			open={true}
			title={m.imports_cancel_confirm_title()}
			description={cancelConfirmDescription(pendingCancel.importedRows)}
			confirmLabel={m.imports_cancel_confirm_label()}
			cancelLabel={m.imports_cancel_keep_label()}
			tone="danger"
			confirmLoading={cancelSubmitting}
			onClose={() => (pendingCancel = null)}
		>
			<p class="text-sm text-zinc-600">
				{m.imports_cancel_file_prefix()}
				<span class="font-medium">{pendingCancel.fileName ?? m.imports_default_file_name()}</span>
			</p>
			{#if form?.error}
				<AlertBanner variant="error" class="mt-2">{form.error}</AlertBanner>
			{/if}
		</ConfirmDialog>
	</form>
{/if}
