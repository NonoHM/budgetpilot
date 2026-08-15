<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatCents } from '$lib/domain/budget';
	import type { ActionData, PageData } from './$types';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import FileDropZone from '$lib/components/ui/FileDropZone.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import { cardBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';
	import { refusalLabel, scopeLabel } from '$lib/i18n/refusalLabel';
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import { EMPTY_ASSIGNMENT, type DesignationFile } from '$lib/domain/columnDesignation';
	import { setPendingDesignation } from '$lib/import/pendingDesignation.svelte';
	import { takeCompletedImport, type CompletedImport } from '$lib/import/completedImport.svelte';
	import { onMount } from 'svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	/**
	 * An import performed on `/import/columns`, whose action result cannot arrive here as `form`.
	 *
	 * Read in `onMount` rather than at initialisation for two reasons, both of which were live
	 * defects in the first draft. This module renders on the server, where module state is shared
	 * between requests, so reading it during SSR is a cross-request leak waiting for a writer. And
	 * a value present on the client but absent on the server is a hydration mismatch: the summary
	 * would be painted, then thrown away when hydration reconciled the two trees.
	 */
	let carriedImport = $state<CompletedImport | null>(null);
	onMount(() => {
		carriedImport = takeCompletedImport();
	});

	const importResult = $derived(form?.importResult ?? carriedImport?.importResult);
	const netWorthAccountOptions = $derived([
		{ value: '', label: m.import_field_net_worth_account_placeholder() },
		...data.linkableNetWorthAccounts.map((account) => ({ value: account.id, label: account.name }))
	]);
	let selectedNetWorthAccountId = $state('');

	const errorReport = $derived(
		importResult?.invalidRowDetails
			?.map((row) =>
				[
					`${m.import_invalid_table_line()} ${scopeLabel(row.scope)}`,
					`${m.import_invalid_table_reason()}=${refusalLabel(row.fact)}`,
					// Omitted rather than interpolated when absent: `${undefined}` would write the
					// literal string into text the user copies into a support request.
					...(row.field ? [`${m.import_invalid_table_field()}=${row.field}`] : []),
					`${m.import_invalid_table_preview()}=${row.preview}`
				].join('; ')
			)
			.join('\n') ?? ''
	);

	// Read through an `in` check rather than directly: `fail()` returns a UNION of payload shapes
	// and only one branch carries this key. Widening every branch to carry it as `undefined` was
	// tried first and cost 28 unrelated type errors, because it also widened `importResult` and
	// destroyed the narrowing the rest of this file depends on.
	const designation = $derived(
		form && 'designation' in form ? (form.designation as DesignationFile | undefined) : undefined
	);

	/**
	 * Hands the file to the designation screen and navigates.
	 *
	 * The FILE goes with it, in memory, because owner ruling 2 keeps it in the browser: storing the
	 * upload server side between two requests would create an asset with a lifetime, an expiry and a
	 * key to protect, which is three problems created to avoid one re-post.
	 *
	 * The headers and samples travel too, but only so the screen can DRAW the file. The server never
	 * reads them back: the submit re-posts the file and re-derives its own header list.
	 */
	async function designateColumns(event: SubmitEvent) {
		// **The form is `use:enhance`d and that is what makes this reachable at all.** Without it the
		// refusal arrives through a full page POST, the document is replaced, and the `<input
		// type="file">` the user chose comes back EMPTY. The offer button would then read no file and
		// do nothing at all: a button that looks correct, is correct in every unit and component
		// test, and cannot work in a browser.
		//
		// Found by the e2e in `import-column-designation.spec.ts`, which is the only level that can
		// see it: the defect is entirely about what survives a navigation.
		event.preventDefault();
		const input = (event.currentTarget as HTMLFormElement).querySelector(
			'input[type="file"]'
		) as HTMLInputElement | null;
		const file = input?.files?.[0];
		if (!file || !designation) return;

		setPendingDesignation({
			file,
			view: {
				name: designation.name,
				headers: designation.headers,
				samples: designation.samples,
				coverage: designation.coverage,
				firstRow: designation.firstRow,
				rowCount: designation.rowCount,
				hasHeaderRow: designation.hasHeaderRow
			},
			initialAssignment: EMPTY_ASSIGNMENT,
			candidates: {}
		});
		await goto(resolve('/import/columns'));
	}

	async function copyErrorReport() {
		if (!errorReport || !navigator.clipboard) return;
		await navigator.clipboard.writeText(errorReport);
	}
</script>

<svelte:head>
	<title>{m.import_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<!-- ============ DESKTOP (≥lg, unchanged) ============ -->
	<section class="mx-auto hidden max-w-7xl space-y-8 lg:block">
		<div class="rounded-lg border border-zinc-200 bg-white p-6">
			<div class="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
				<div>
					<h1 class="text-2xl font-semibold tracking-normal">{m.import_heading()}</h1>
					<p class="mt-2 max-w-3xl text-sm text-zinc-600">
						{m.import_description()}
					</p>
				</div>
				<a class="text-sm font-medium text-zinc-500 hover:text-zinc-700" href={resolve('/')}
					>{m.import_back_to_dashboard()}</a
				>
			</div>

			<form
				class="mt-6 grid gap-4"
				method="POST"
				enctype="multipart/form-data"
				use:enhance
				onsubmit={designation ? designateColumns : undefined}
			>
				<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600">
					<span class="font-medium text-zinc-800">{m.import_supported_formats()}</span>
					<br />
					<span class="font-medium text-zinc-800">{m.import_supported_profiles_label()}</span>
					{m.import_supported_profiles_list()}
				</div>
				<FileDropZone
					name="csvFile"
					accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
					label={m.import_file_label()}
					required
					chooseLabel={m.common_file_dropzone_choose()}
					noFileLabel={m.common_file_dropzone_no_file()}
					desktopInputClass="lg:rounded-md lg:border lg:border-zinc-300 lg:bg-white lg:p-2 lg:text-sm lg:focus:border-zinc-500 lg:focus:outline-none lg:focus:ring-2 lg:focus:ring-zinc-400"
				/>

				{#if data.hasAllImportBucketsExisting}
					<p class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500">
						{m.import_existing_bucket_notice()}
					</p>
				{:else if data.linkableNetWorthAccounts.length > 0}
					<label class="block text-sm font-medium text-zinc-700">
						{m.import_field_net_worth_account()}
						<div class="mt-1.5">
							<Combobox
								name="netWorthAccountId"
								bind:value={selectedNetWorthAccountId}
								options={netWorthAccountOptions}
								placeholder={m.import_field_net_worth_account_placeholder()}
								ariaLabel={m.import_field_net_worth_account()}
							/>
						</div>
						<span class="mt-1 block text-xs font-normal text-zinc-500"
							>{m.import_field_net_worth_account_hint()}</span
						>
					</label>
				{/if}

				{#if form?.error}
					<AlertBanner variant="error">{form.error}</AlertBanner>
				{/if}

				{#if designation}
					<!-- The file nothing recognised. A refusal that offers the repair rather than
					     stating the problem: the user's next step is naming three columns, and the
					     screen that does it is one tap away. -->
					<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
						<p class="text-sm font-semibold text-zinc-900">{m.import_columns_offer()}</p>
						<p class="mt-1 text-xs text-zinc-500">{m.import_columns_offer_explanation()}</p>
						<Button type="submit" class="mt-3">{m.import_columns_offer()}</Button>
					</div>
				{/if}

				<Button type="submit">{m.import_submit()}</Button>
			</form>
		</div>

		{#if importResult}
			<div class="rounded-lg border border-zinc-200 bg-white p-5">
				<div
					class="flex flex-col gap-3 border-b border-zinc-200 pb-4 md:flex-row md:items-start md:justify-between"
				>
					<div>
						<h2 class="text-lg font-semibold">{m.import_summary_heading()}</h2>
						{#if importResult.fileName}
							<p class="mt-1 text-sm text-zinc-500">
								{m.import_summary_file({ name: importResult.fileName })}
							</p>
						{/if}
					</div>
					{#if importResult.profile}
						<span class="w-fit rounded-md border border-zinc-200 px-3 py-1 text-sm font-medium">
							{importResult.profile}
						</span>
					{/if}
				</div>

				{#if importResult.netWorthLinkStatus}
					<p
						class="mt-4 rounded-xl border p-3 text-xs"
						class:border-emerald-200={importResult.netWorthLinkStatus === 'applied'}
						class:bg-emerald-50={importResult.netWorthLinkStatus === 'applied'}
						class:text-emerald-700={importResult.netWorthLinkStatus === 'applied'}
						class:border-zinc-200={importResult.netWorthLinkStatus === 'ignored'}
						class:bg-zinc-50={importResult.netWorthLinkStatus === 'ignored'}
						class:text-zinc-500={importResult.netWorthLinkStatus === 'ignored'}
					>
						{importResult.netWorthLinkStatus === 'applied'
							? m.import_link_applied_notice()
							: m.import_link_ignored_notice()}
					</p>
				{/if}

				<div class="mt-4 grid gap-3 md:grid-cols-3 lg:grid-cols-6">
					<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
						<p class="text-xs text-zinc-500 uppercase">{m.import_stat_rows_read()}</p>
						<p class="mt-1 text-xl font-semibold">{importResult.totalRows}</p>
					</div>
					<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
						<p class="text-xs text-zinc-500 uppercase">{m.import_stat_imported()}</p>
						<p class="mt-1 text-xl font-semibold text-emerald-700">{importResult.importedRows}</p>
					</div>
					<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
						<p class="text-xs text-zinc-500 uppercase">{m.import_stat_duplicates()}</p>
						<p class="mt-1 text-xl font-semibold">{importResult.duplicateRows}</p>
					</div>
					<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
						<p class="text-xs text-zinc-500 uppercase">{m.import_stat_invalid()}</p>
						<p class="mt-1 text-xl font-semibold text-rose-700">{importResult.invalidRows}</p>
					</div>
					<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
						<p class="text-xs text-zinc-500 uppercase">{m.import_stat_total_debit()}</p>
						<p class="mt-1 text-xl font-semibold">{formatCents(importResult.totalDebitCents)}</p>
					</div>
					<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-3">
						<p class="text-xs text-zinc-500 uppercase">{m.import_stat_total_credit()}</p>
						<p class="mt-1 text-xl font-semibold">{formatCents(importResult.totalCreditCents)}</p>
					</div>
				</div>

				{#if importResult.period}
					<p class="mt-4 text-sm text-zinc-600">
						{m.import_period({
							from: importResult.period.from ?? 'n/a',
							to: importResult.period.to ?? 'n/a'
						})}
					</p>
				{/if}

				{#if importResult.invalidRowDetails?.length > 0}
					<section class="mt-6 border-t border-zinc-200 pt-5">
						<div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
							<div>
								<h3 class="font-semibold">{m.import_invalid_heading()}</h3>
								<p class="mt-1 text-sm text-zinc-600">
									{m.import_invalid_description()}
								</p>
							</div>
							<Button type="button" variant="secondary" size="sm" onclick={copyErrorReport}
								>{m.import_copy_error_report()}</Button
							>
						</div>

						<div class="mt-4 overflow-x-auto rounded-xl border border-zinc-200">
							<table class="w-full min-w-[760px] text-left text-sm">
								<thead class="bg-zinc-50 text-xs text-zinc-500 uppercase">
									<tr>
										<th class="px-3 py-2 font-medium">{m.import_invalid_table_line()}</th>
										<th class="px-3 py-2 font-medium">{m.import_invalid_table_reason()}</th>
										<th class="px-3 py-2 font-medium">{m.import_invalid_table_field()}</th>
										<th class="px-3 py-2 font-medium">{m.import_invalid_table_preview()}</th>
									</tr>
								</thead>
								<tbody>
									{#each importResult.invalidRowDetails as row (row.key)}
										<tr class="border-t border-zinc-100">
											<td class="px-3 py-2 font-medium">{scopeLabel(row.scope)}</td>
											<td class="px-3 py-2 text-rose-700">{refusalLabel(row.fact)}</td>
											<td class="px-3 py-2">{row.field ?? ''}</td>
											<td class="px-3 py-2 text-zinc-600">{row.preview}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>

						{#if importResult.hiddenInvalidRowsCount > 0}
							<p class="mt-3 text-sm text-zinc-600">
								{m.import_hidden_errors({ count: importResult.hiddenInvalidRowsCount })}
							</p>
						{/if}

						{#if carriedImport?.canRevisit}
							<!--
							Plate §1q table B: the ONE addition to the invalid-rows screen. It reopens the
							designation screen « en état 2, désignations intactes », so a user whose amount
							column was wrong corrects one row instead of redoing the import. A TapLink, not a
							Button: the primary here is still « Voir les transactions ».
						-->
							<TapLink class="mt-4" onclick={() => goto(resolve('/import/columns'))}>
								{m.import_columns_revisit()}
							</TapLink>
						{/if}
					</section>
				{/if}

				<Button href="/transactions" class="mt-5">
					{m.import_view_transactions()}
				</Button>
			</div>
		{/if}
	</section>

	<!-- ============ MOBILE (<lg) ============ -->
	<section class="mx-auto max-w-7xl space-y-6 lg:hidden">
		<div>
			<a class="text-sm text-zinc-500 hover:text-zinc-700" href={resolve('/')}
				>{m.import_back_to_dashboard()}</a
			>
			<h1 class="mt-2 text-2xl font-bold tracking-tight">{m.import_heading()}</h1>
			<p class="mt-1 text-sm text-zinc-500">{m.import_description()}</p>
		</div>

		<div class="rounded-xl bg-zinc-50 p-4 text-xs text-zinc-500">
			<span class="font-medium text-zinc-700">{m.import_supported_formats()}</span>
			<br />
			<span class="font-medium text-zinc-700">{m.import_supported_profiles_label()}</span>
			{m.import_supported_profiles_list()}
		</div>

		<form
			class="grid gap-4"
			method="POST"
			enctype="multipart/form-data"
			use:enhance
			onsubmit={designation ? designateColumns : undefined}
		>
			<FileDropZone
				name="csvFile"
				accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				label={m.import_file_label()}
				required
				chooseLabel={m.common_file_dropzone_choose()}
				noFileLabel={m.common_file_dropzone_no_file()}
			/>

			{#if data.hasAllImportBucketsExisting}
				<p class="rounded-xl bg-zinc-50 p-3 text-xs text-zinc-500">
					{m.import_existing_bucket_notice()}
				</p>
			{:else if data.linkableNetWorthAccounts.length > 0}
				<label class="block text-sm font-medium text-zinc-700">
					{m.import_field_net_worth_account()}
					<div class="mt-1.5">
						<Combobox
							name="netWorthAccountId"
							bind:value={selectedNetWorthAccountId}
							options={netWorthAccountOptions}
							placeholder={m.import_field_net_worth_account_placeholder()}
							ariaLabel={m.import_field_net_worth_account()}
							triggerClass="!bg-zinc-50"
						/>
					</div>
					<span class="mt-1 block text-xs font-normal text-zinc-500"
						>{m.import_field_net_worth_account_hint()}</span
					>
				</label>
			{/if}

			{#if form?.error}
				<AlertBanner variant="error">{form.error}</AlertBanner>
			{/if}

			{#if designation}
				<!-- The file nothing recognised. A refusal that offers the repair rather than
				     stating the problem: the user's next step is naming three columns, and the
				     screen that does it is one tap away. -->
				<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
					<p class="text-sm font-semibold text-zinc-900">{m.import_columns_offer()}</p>
					<p class="mt-1 text-xs text-zinc-500">{m.import_columns_offer_explanation()}</p>
					<Button type="submit" class="mt-3">{m.import_columns_offer()}</Button>
				</div>
			{/if}

			<Button type="submit" class="h-11 w-full !rounded-xl">{m.import_submit()}</Button>
		</form>

		{#if importResult}
			<div class="{cardBase} p-5">
				<div class="flex items-start justify-between gap-3">
					<div>
						<h2 class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">
							{m.import_summary_heading()}
						</h2>
						{#if importResult.fileName}
							<p class="mt-1 text-sm font-medium break-all text-zinc-900">
								{importResult.fileName}
							</p>
						{/if}
					</div>
					{#if importResult.profile}
						<span class="shrink-0">
							<Badge tone="neutral">{importResult.profile}</Badge>
						</span>
					{/if}
				</div>

				{#if importResult.netWorthLinkStatus}
					<p
						class="mt-3 rounded-xl p-3 text-xs"
						class:bg-emerald-50={importResult.netWorthLinkStatus === 'applied'}
						class:text-emerald-700={importResult.netWorthLinkStatus === 'applied'}
						class:bg-zinc-50={importResult.netWorthLinkStatus === 'ignored'}
						class:text-zinc-500={importResult.netWorthLinkStatus === 'ignored'}
					>
						{importResult.netWorthLinkStatus === 'applied'
							? m.import_link_applied_notice()
							: m.import_link_ignored_notice()}
					</p>
				{/if}

				<div class="mt-4 grid grid-cols-2 gap-3">
					<div class="rounded-xl bg-zinc-50 p-3">
						<p class="text-[11px] text-zinc-400 uppercase">{m.import_stat_rows_read()}</p>
						<p class="mt-1 text-lg font-bold">{importResult.totalRows}</p>
					</div>
					<div class="rounded-xl bg-zinc-50 p-3">
						<p class="text-[11px] text-zinc-400 uppercase">{m.import_stat_imported()}</p>
						<p class="mt-1 text-lg font-bold text-emerald-700">{importResult.importedRows}</p>
					</div>
					<div class="rounded-xl bg-zinc-50 p-3">
						<p class="text-[11px] text-zinc-400 uppercase">{m.import_stat_duplicates()}</p>
						<p class="mt-1 text-lg font-bold" class:text-amber-600={importResult.duplicateRows > 0}>
							{importResult.duplicateRows}
						</p>
					</div>
					<div class="rounded-xl bg-zinc-50 p-3">
						<p class="text-[11px] text-zinc-400 uppercase">{m.import_stat_invalid()}</p>
						<p class="mt-1 text-lg font-bold" class:text-rose-700={importResult.invalidRows > 0}>
							{importResult.invalidRows}
						</p>
					</div>
					<div class="rounded-xl bg-zinc-50 p-3">
						<p class="text-[11px] text-zinc-400 uppercase">{m.import_stat_total_debit()}</p>
						<p class="mt-1 text-lg font-bold">{formatCents(importResult.totalDebitCents)}</p>
					</div>
					<div class="rounded-xl bg-zinc-50 p-3">
						<p class="text-[11px] text-zinc-400 uppercase">{m.import_stat_total_credit()}</p>
						<p class="mt-1 text-lg font-bold">{formatCents(importResult.totalCreditCents)}</p>
					</div>
				</div>

				{#if importResult.period}
					<p class="mt-4 text-xs text-zinc-500">
						{m.import_period({
							from: importResult.period.from ?? 'n/a',
							to: importResult.period.to ?? 'n/a'
						})}
					</p>
				{/if}

				<Button href="/transactions" class="mt-5 flex h-11 w-full">
					{m.import_view_transactions()}
				</Button>
			</div>

			{#if importResult.invalidRowDetails?.length > 0}
				<div class="{cardBase} p-5">
					<div class="flex items-center justify-between gap-3">
						<h3 class="font-bold text-zinc-950">{m.import_invalid_heading()}</h3>
						<Button type="button" variant="secondary" size="sm" onclick={copyErrorReport}>
							{m.import_copy_error_report()}
						</Button>
					</div>
					<p class="mt-1 text-sm text-zinc-500">{m.import_invalid_description()}</p>

					<div class="mt-4 space-y-3">
						{#each importResult.invalidRowDetails as row (row.key)}
							<div class="rounded-xl border border-zinc-100 bg-zinc-50/60 p-3">
								<p class="text-xs text-zinc-400">
									{m.import_invalid_table_line()}
									{scopeLabel(row.scope)}
								</p>
								<p class="mt-0.5 font-semibold text-rose-600">{refusalLabel(row.fact)}</p>
								<!-- Both of these are omitted rather than rendered empty: a field prefix with
								     nothing after it, or an empty preview box, each state something the refusal
								     does not say. A header scoped refusal names no field and previews no row. -->
								{#if row.field}
									<p class="mt-1 text-xs text-zinc-500">
										{m.import_invalid_field_prefix()}
										{row.field}
									</p>
								{/if}
								{#if row.preview}
									<p
										class="mt-2 rounded-lg bg-zinc-100 px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-zinc-600"
									>
										{row.preview}
									</p>
								{/if}
							</div>
						{/each}
					</div>

					{#if importResult.hiddenInvalidRowsCount > 0}
						<p class="mt-3 text-center text-xs text-zinc-400">
							{m.import_hidden_errors({ count: importResult.hiddenInvalidRowsCount })}
						</p>
					{/if}

					{#if carriedImport?.canRevisit}
						<!--
							Plate §1q table B: the ONE addition to the invalid-rows screen. It reopens the
							designation screen « en état 2, désignations intactes », so a user whose amount
							column was wrong corrects one row instead of redoing the import. A TapLink, not a
							Button: the primary here is still « Voir les transactions ».
						-->
						<TapLink class="mt-4" onclick={() => goto(resolve('/import/columns'))}>
							{m.import_columns_revisit()}
						</TapLink>
					{/if}
				</div>
			{/if}
		{/if}
	</section>
</main>
