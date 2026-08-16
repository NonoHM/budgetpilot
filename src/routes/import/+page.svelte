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
	import { applyAction, deserialize, enhance } from '$app/forms';
	import DuplicateStatementDialog from '$lib/components/import/DuplicateStatementDialog.svelte';
	import type { CollidingBatchView, CollisionFigures } from '$lib/domain/importCollision';
	import {
		clearPendingCollision,
		takePendingCollision,
		type PendingCollision
	} from '$lib/import/pendingCollision.svelte';
	import { MAPPING_ROLES } from '$lib/domain/mappingRoles';
	import type { ImportSummaryResult } from '$lib/domain/importSummary';
	import { groupInvalidRows } from '$lib/domain/groupInvalidRows';
	import {
		EMPTY_ASSIGNMENT,
		type DesignationFile,
		type RoleAssignment
	} from '$lib/domain/columnDesignation';
	import {
		clearPendingDesignation,
		setPendingDesignation
	} from '$lib/import/pendingDesignation.svelte';
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

	/**
	 * The chosen statement, held ONCE for the two mounts of this form.
	 *
	 * This page renders its upload form twice, `hidden lg:block` and `lg:hidden`, and each mount
	 * carried its own `<input type="file">`. Both are named `csvFile` but they sit in two separate
	 * `<form>` elements, so only the submitted one is ever posted. Measured: choose a file at 1280,
	 * resize to 390 without reloading, and the now-visible input reads `files.length` 0 while the
	 * hidden one still holds the file. The label reverted to « Aucun fichier sélectionné », pressing
	 * Import issued NO request, and the user was shown Chromium's own `valueMissing` bubble, in
	 * English, on a French page.
	 *
	 * `FileDropZone` already exposes `files` as `$bindable`, and its own docstring records that this
	 * page renders a parallel pair. Binding both mounts to one value is the whole fix: the two inputs
	 * hold the same `FileList`, so whichever one is visible when the user submits carries the file.
	 *
	 * This is NOT the single-mount rewrite, which stays out of scope: `/import` is server rendered, so
	 * gating the chromes on a media query would give every desktop visitor a mobile flash on first
	 * paint. That is an architecture decision and it is filed rather than taken here.
	 */
	let csvFiles = $state<FileList | undefined>(undefined);

	/**
	 * And `required` came off both inputs, which is a separate decision from the binding above.
	 *
	 * A native `required` file input refuses in the BROWSER's language, not the page's, so a French
	 * screen answered « Please select a file. » Worse, it refuses before any request is sent, so the
	 * app never got to say anything of its own.
	 *
	 * ASVS 5.0 **V2.2.2** is the row, and it reads the right way round: input validation is enforced
	 * at a trusted service layer, while client-side validation "improves usability and should be
	 * encouraged" but is not the control. The control already exists and is unchanged: the action
	 * refuses an absent or empty upload with `import_error_no_file`, in the page's own locale, and
	 * `isSupportedImportFile` plus `IMPORT_MAX_BYTES` still answer **V5.2.2** and **V5.2.1** on the
	 * server. Nothing that decides anything moved; a monolingual affordance was replaced by the
	 * refusal the server was already able to give.
	 */
	const netWorthAccountOptions = $derived([
		{ value: '', label: m.import_field_net_worth_account_placeholder() },
		...data.linkableNetWorthAccounts.map((account) => ({ value: account.id, label: account.name }))
	]);
	let selectedNetWorthAccountId = $state('');

	/**
	 * The table's rows, folded onto the reason each was refused for.
	 *
	 * Derived for the TABLE only. `errorReport` below still walks `invalidRowDetails`, so the
	 * report a user copies into a support request keeps one line per rejected row: the grouping
	 * is a reading aid on the screen, never a reduction of what the run actually reported.
	 */
	const invalidRowGroups = $derived(groupInvalidRows(importResult?.invalidRowDetails ?? []));

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
	 * The designations to reopen the screen WITH, when this upload is a correction.
	 *
	 * Read through the same `in` check and for the same reason. Absent on the ordinary offer, where
	 * nothing has been designated yet and an empty assignment is the truth.
	 */
	const correctingAssignment = $derived(
		form && 'correctingAssignment' in form
			? (form.correctingAssignment as RoleAssignment | undefined)
			: undefined
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
		// Read from the SHARED binding rather than by querying the submitted form for its own input.
		// The DOM query worked only because the submitted form happened to be the one the user chose
		// in, which is the same per-mount coupling that lost the file across a resize. One value, read
		// the same way whichever chrome is on screen.
		const file = csvFiles?.[0];
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
			initialAssignment: correctingAssignment ?? EMPTY_ASSIGNMENT,
			candidates: {}
		});
		await goto(resolve('/import/columns'));
	}

	/**
	 * The memorisation the designation screen promised, and the server then refused.
	 *
	 * `/import/columns` displays « Cette correspondance sera réutilisée pour les prochains fichiers
	 * ayant les mêmes colonnes » before the import, and `saveColumnMapping` refuses with
	 * `cap-reached` once the user holds `COLUMN_MAPPINGS_PER_USER` of them. The refusal was computed,
	 * returned by the action, carried across the navigation and typed on `CompletedImport` -- and
	 * rendered by nothing. The user was left with a promise the mechanism had already declined to
	 * keep, and the only symptom was that this bank kept reopening the designation screen forever.
	 *
	 * The design source states the rule this restores: before displaying a promise about future
	 * behaviour, the mechanism behind it must be able to keep it in every state it will meet. Where
	 * it cannot, the state where it fails is exactly the state where the user has no way to find out
	 * why.
	 *
	 * The cap FIGURE is deliberately not in the sentence. It is read from the environment
	 * (`COLUMN_MAPPINGS_PER_USER`), so a literal here would be wrong on any instance that moved it,
	 * and there is nothing the user can do with the number until a remembered-correspondance list
	 * exists to delete from (#326).
	 */
	const capReached = $derived(carriedImport?.capReached === true);

	async function copyErrorReport() {
		if (!errorReport || !navigator.clipboard) return;
		await navigator.clipboard.writeText(errorReport);
	}

	/**
	 * The statement the server says this run appears to repeat, from either of its two sources.
	 *
	 * `/import`'s own action returns it as a `fail(409)` payload, read through the same `in` check as
	 * `designation` above and for the same reason: `fail()` returns a union of payload shapes, and
	 * widening every branch to carry every key destroys the narrowing the rest of this file depends on.
	 *
	 * `/import/columns` cannot ask the question itself (§5.5 of the handoff, and §5.2's general rule
	 * that the designation screen does not own a server refusal), so it hands it here through
	 * `pendingCollision` along with everything needed to answer it. Both sources draw one dialog.
	 */
	const formCollision = $derived(
		form && 'collision' in form ? (form.collision as CollidingBatchView | undefined) : undefined
	);
	const formIncoming = $derived(
		form && 'incoming' in form ? (form.incoming as CollisionFigures | undefined) : undefined
	);

	// Read in `onMount` for the reason `carriedImport` is: module state is shared between requests on
	// the server, and a value present on the client but absent on the server is a hydration mismatch.
	let carriedCollision = $state<PendingCollision | null>(null);
	onMount(() => {
		carriedCollision = takePendingCollision();
	});

	const collisionExisting = $derived(formCollision ?? carriedCollision?.existing);
	const collisionIncoming = $derived(formIncoming ?? carriedCollision?.incoming);

	/**
	 * Answered per collision rather than with a bare boolean.
	 *
	 * A boolean would stay true across the next submit, so the second collision of a session would be
	 * suppressed by the user's answer to the first. The key is the batch plus the file, which is
	 * exactly what the question was about.
	 */
	let dismissedCollision = $state<string | null>(null);
	let collisionError = $state<string | null>(null);
	let confirmingCollision = $state(false);
	const collisionKey = $derived(
		collisionExisting && collisionIncoming
			? `${collisionExisting.batchId}|${collisionIncoming.fileName}`
			: null
	);
	const collisionOpen = $derived(collisionKey !== null && dismissedCollision !== collisionKey);

	/**
	 * « Ne pas importer ». Nothing was written, so there is nothing to undo.
	 *
	 * The carried collision is dropped as well as dismissed: leaving it in module state would have it
	 * reappear behind the next upload, attached to a file the user has since replaced.
	 */
	function cancelCollision() {
		dismissedCollision = collisionKey;
		collisionError = null;
		carriedCollision = null;
		clearPendingCollision();
	}

	/**
	 * « Importer quand même », re-posted with the answer to whichever action asked the question.
	 *
	 * The `/import` body is hand-assembled rather than a resubmit of the upload form, because this
	 * page renders that form TWICE (`hidden lg:block` and `lg:hidden`) and only the visible mount
	 * holds anything the browser would submit. Reading the shared `csvFiles` binding is the same fix
	 * the file input itself already carries: one value, read the same way whichever chrome is on.
	 *
	 * `correctMappingId` is deliberately NOT carried. The correction path returns the designation
	 * screen before the collision check can run, so a correction never reaches this dialog, and
	 * posting the field would turn the confirmation into a second request to designate.
	 */
	async function confirmCollisionImport(event: SubmitEvent) {
		event.preventDefault();
		if (confirmingCollision) return;

		const carried = carriedCollision;
		const file = carried?.repost.file ?? csvFiles?.[0];
		if (!file) return;

		confirmingCollision = true;
		// Cleared per attempt, so a retry that succeeds leaves no banner contradicting the summary and
		// a retry that fails differently does not read as the first failure still standing.
		collisionError = null;

		const body = new FormData();
		body.set('csvFile', file);
		body.set('confirmCollision', '1');
		if (carried) {
			body.set('remember', String(carried.repost.remember));
			body.set('hasHeaderRow', String(carried.repost.hasHeaderRow));
			for (const role of MAPPING_ROLES) {
				const index = carried.repost.assignment[role];
				// Indices, never names. The server resolves them against ITS own header list.
				if (index !== null) body.set(`${role}Index`, String(index));
			}
		} else {
			body.set('netWorthAccountId', selectedNetWorthAccountId);
		}

		try {
			// `x-sveltekit-action` is what makes the reply a serialised ActionResult rather than a
			// rendered page. Without it there is nothing in the response worth reading and the summary
			// the server just built is dropped, which is the defect #338 recorded next door.
			const response = await fetch(carried ? resolve('/import/columns') : '', {
				method: 'POST',
				body,
				headers: { 'x-sveltekit-action': 'true' }
			});
			const actionResult = deserialize<
				{ importResult: ImportSummaryResult; capReached?: boolean },
				{ error?: string }
			>(await response.text());

			// EVERY non-success is applied, not only `failure`: `redirect` is the expired session, and
			// dropping it leaves the user pressing a button against a screen that does nothing.
			if (actionResult.type !== 'success') {
				await applyAction(actionResult);
				return;
			}
			if (!actionResult.data?.importResult) {
				collisionError = m.import_columns_error_unexpected();
				return;
			}

			// The designated run's summary arrives as data rather than as this page's `form`, so it is
			// written into the same state the columns screen hands its results through. `/import`'s own
			// confirmation goes through `applyAction` instead, which sets `form`.
			if (carried) {
				clearPendingDesignation();
				clearPendingCollision();
				carriedCollision = null;
				carriedImport = {
					importResult: actionResult.data.importResult,
					capReached: actionResult.data.capReached === true,
					canRevisit: actionResult.data.importResult.invalidRows > 0
				};
			} else {
				await applyAction(actionResult);
			}
		} catch {
			// ASVS 5.0 V16.5.1: generic, and the caught value is never rendered. V16.5.3: it fails
			// CLOSED, and the dialog deliberately stays OPEN. Dismissing it here would answer the
			// user's question for them with the wrong answer, since nothing was imported, and a dialog
			// that closes on failure is indistinguishable from one that closed on success.
			collisionError = m.import_columns_error_unexpected();
		} finally {
			confirmingCollision = false;
		}
	}
</script>

<svelte:head>
	<title>{m.import_page_title()}</title>
</svelte:head>

<!--
	The correction path, arriving from « Modifier les colonnes » on the §3.7 recap.

	Two sentences and a hidden field. The field is what turns this upload from an import into a
	reopening: without it the file would be recognised by the very correspondance the user came to
	change, and imported through it again.

	The second sentence is NOT in the plate, and it is here because the plate does not model an
	import that has already happened. The dedupe key carries the label, so a corrected mapping does
	not produce duplicates: it produces a SECOND set of rows beside the first. A recovery path that
	silently doubles a statement is not a recovery path, so the step is named where it is about to
	be needed rather than left to be discovered afterwards.

	It names the ORDER too, and the order is not the obvious one. Deleting the bad import first
	looks right and is a trap: the recap is reached from that import's own row on `/imports`, so
	deleting it removes the only route back to the columns, and the user's next upload is read
	through the same wrong correspondance. Correct first, delete second.
-->
{#snippet correctionNotice()}
	{#if data.correctMappingId}
		<input type="hidden" name="correctMappingId" value={data.correctMappingId} />
		<div class="rounded-xl border border-zinc-200 bg-white p-3">
			<p class="text-sm font-semibold text-zinc-900">{m.import_columns_correct_heading()}</p>
			<p class="mt-1 text-xs text-zinc-600">{m.import_columns_correct_explanation()}</p>
			<p class="mt-2 text-xs text-zinc-500">{m.import_columns_correct_duplicate_note()}</p>
		</div>
	{/if}
{/snippet}

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
				{@render correctionNotice()}
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
					bind:files={csvFiles}
					chooseLabel={m.common_file_dropzone_choose()}
					noFileLabel={m.common_file_dropzone_no_file()}
				/>

				{#if data.hasAllImportBucketsExisting}
					<p class="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500">
						{m.import_existing_bucket_notice()}
					</p>
				{:else if data.linkableNetWorthAccounts.length > 0}
					<label class="block text-sm font-medium text-zinc-700">
						{m.import_field_net_worth_account()}
						<div class="mt-2">
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
						<!--
							Not on the correction path: « Ce relevé n'est pas reconnu » is false there. The
							statement IS recognised, and that is precisely why the user is here. The block
							above already says what this upload is for.
						-->
						{#if !data.correctMappingId}
							<p class="mt-1 text-xs text-zinc-500">{m.import_columns_offer_explanation()}</p>
						{/if}
						<Button type="submit" class="mt-3">{m.import_columns_offer()}</Button>
					</div>
				{/if}

				<Button type="submit">{m.import_submit()}</Button>
			</form>
		</div>

		<!-- Above the summary, because it qualifies it: the counts below are true and the memorisation
		     they were produced under did not happen. `warning` rather than `error`: nothing failed
		     that the user asked for, the import landed, and only the convenience attached to it was
		     declined. -->
		{#if capReached}
			<!--
			#326. The cap is REFUSED rather than evicted, so without a way to free a row it is a
			permanent block: a user at the maximum can never import a new bank again. The refusal
			said so and named no screen, no issue and no next step — `store.ts` claimed otherwise in
			a comment for a whole release. The action snippet is the one the bulk-tag banner already
			uses; the destination is the list that now exists.
			-->
			<AlertBanner variant="warning">
				{m.import_columns_cap_reached()}
				{#snippet action()}
					<a
						href={resolve('/settings')}
						class="shrink-0 self-center font-semibold text-amber-900 underline underline-offset-2"
					>
						{m.import_columns_cap_reached_action()}
					</a>
				{/snippet}
			</AlertBanner>
		{/if}

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
									<!--
									One row per REASON, not per line. Twenty-five rows carrying one sentence
									twenty-five times pushed the offer to designate the columns off the fold,
									which is the action the reader needed. A group of one renders exactly as
									it always did — same line number, same preview, no disclosure — so the
									ordinary single-refusal case is untouched.
									-->
									{#each invalidRowGroups as group (group.key)}
										<tr class="border-t border-zinc-100">
											<td class="px-3 py-2 font-medium">
												{#if group.count === 1}
													{scopeLabel(group.head.scope)}
												{:else}
													{m.import_invalid_group_lines({ count: group.count })}
												{/if}
											</td>
											<td class="px-3 py-2 text-rose-700">{refusalLabel(group.head.fact)}</td>
											<td class="px-3 py-2">{group.head.field ?? ''}</td>
											<td class="px-3 py-2 text-zinc-600">
												{#if group.count === 1}
													{group.head.preview}
												{:else}
													<!--
													A native <details>. The referential has no disclosure brique and
													#332 is the issue that decides what the table ones become, so
													inventing a fourth here would define a shared component from the
													rarest case — the ordering that issue exists to prevent.
													-->
													<details class="group/reveal">
														<summary
															class="cursor-pointer list-none text-zinc-700 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:outline-none"
														>
															{m.import_invalid_group_reveal({ count: group.count })}
														</summary>
														<ul class="mt-2 space-y-1">
															{#each group.rows as row (row.key)}
																<li class="flex gap-2">
																	<span class="shrink-0 font-medium text-zinc-500"
																		>{scopeLabel(row.scope)}</span
																	>
																	<span>{row.preview}</span>
																</li>
															{/each}
														</ul>
													</details>
												{/if}
											</td>
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
			{@render correctionNotice()}
			<FileDropZone
				name="csvFile"
				accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				label={m.import_file_label()}
				bind:files={csvFiles}
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
					<div class="mt-2">
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
					<!--
							Not on the correction path: « Ce relevé n'est pas reconnu » is false there. The
							statement IS recognised, and that is precisely why the user is here. The block
							above already says what this upload is for.
						-->
					{#if !data.correctMappingId}
						<p class="mt-1 text-xs text-zinc-500">{m.import_columns_offer_explanation()}</p>
					{/if}
					<Button type="submit" class="mt-3">{m.import_columns_offer()}</Button>
				</div>
			{/if}

			<Button type="submit" class="h-11 w-full !rounded-xl">{m.import_submit()}</Button>
		</form>

		<!-- Same placement and same reason as the desktop chrome: it qualifies the counts below it. -->
		{#if capReached}
			<!--
			#326. The cap is REFUSED rather than evicted, so without a way to free a row it is a
			permanent block: a user at the maximum can never import a new bank again. The refusal
			said so and named no screen, no issue and no next step — `store.ts` claimed otherwise in
			a comment for a whole release. The action snippet is the one the bulk-tag banner already
			uses; the destination is the list that now exists.
			-->
			<AlertBanner variant="warning">
				{m.import_columns_cap_reached()}
				{#snippet action()}
					<a
						href={resolve('/settings')}
						class="shrink-0 self-center font-semibold text-amber-900 underline underline-offset-2"
					>
						{m.import_columns_cap_reached_action()}
					</a>
				{/snippet}
			</AlertBanner>
		{/if}

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
						<!--
						The SAME grouping as the 1280 table, over the same derived value. This list is a
						second copy of one screen rather than a second screen, and collapsing only the
						table left the width where the repetition costs most — eight cards of one
						sentence, on 390 px — exactly as it was. Measured at 390 before this: the offer
						to designate the columns sat above eight identical cards.
						-->
						{#each invalidRowGroups as group (group.key)}
							<div class="rounded-xl border border-zinc-100 bg-zinc-50/60 p-3">
								<p class="text-xs text-zinc-400">
									{#if group.count === 1}
										{m.import_invalid_table_line()}
										{scopeLabel(group.head.scope)}
									{:else}
										{m.import_invalid_group_lines({ count: group.count })}
									{/if}
								</p>
								<p class="mt-0.5 font-semibold text-rose-600">{refusalLabel(group.head.fact)}</p>
								<!-- Both of these are omitted rather than rendered empty: a field prefix with
								     nothing after it, or an empty preview box, each state something the refusal
								     does not say. A header scoped refusal names no field and previews no row. -->
								{#if group.head.field}
									<p class="mt-1 text-xs text-zinc-500">
										{m.import_invalid_field_prefix()}
										{group.head.field}
									</p>
								{/if}
								{#if group.count === 1}
									{#if group.head.preview}
										<p
											class="mt-2 rounded-lg bg-zinc-100 px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-zinc-600"
										>
											{group.head.preview}
										</p>
									{/if}
								{:else}
									<details class="mt-2">
										<summary
											class="cursor-pointer list-none text-xs text-zinc-600 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:outline-none"
										>
											{m.import_invalid_group_reveal({ count: group.count })}
										</summary>
										<div class="mt-2 space-y-2">
											{#each group.rows as row (row.key)}
												<p
													class="rounded-lg bg-zinc-100 px-2.5 py-2 font-mono text-xs break-words whitespace-pre-wrap text-zinc-600"
												>
													<span class="text-zinc-400">{scopeLabel(row.scope)}</span>
													{row.preview}
												</p>
											{/each}
										</div>
									</details>
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

<!--
	The duplicate-statement question, for both paths that can raise it.

	Outside the two upload sections rather than inside either: this page renders its form twice, one
	chrome per breakpoint, and a dialog rendered per chrome would exist twice with two focus traps.
	The `<form>` here owns nothing but the submit, which `ConfirmDialog`'s primary is; the handler
	assembles the body itself, so the Enter key works and neither mount is involved.
-->
{#if collisionExisting && collisionIncoming}
	<form onsubmit={confirmCollisionImport}>
		<DuplicateStatementDialog
			open={collisionOpen}
			existing={collisionExisting}
			incoming={collisionIncoming}
			importedAt={collisionExisting.createdAt}
			confirming={confirmingCollision}
			error={collisionError}
			onCancel={cancelCollision}
		/>
	</form>
{/if}
