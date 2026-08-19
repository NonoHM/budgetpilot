<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import ImportCardSkeleton from '$lib/components/import/ImportCardSkeleton.svelte';
	import { createDelayedFlag } from '$lib/delayedFlag.svelte';
	import { resolve } from '$app/paths';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import type { ActionData, PageData } from './$types';
	import ImportDeleteButton from '$lib/components/import/ImportDeleteButton.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { formatCents } from '$lib/domain/budget';
	import { importProfileLabel } from '$lib/domain/importProfileLabel';
	import type { CollidingBatchView } from '$lib/domain/importCollision';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const collisionPair = $derived(data.collisions[0] ?? null);
	const otherCollisions = $derived(Math.max(0, data.collisions.length - 1));

	/**
	 * The import the confirmation is about to destroy, named by the one attribute two candidates do
	 * not share.
	 *
	 * `createdAt` is here for the title. After a correction `/imports` holds two rows agreeing on
	 * file name, profile, period and all four counts, because that is what a re-import of the same
	 * statement produces, and the withheld case of the replace leaves exactly that pair behind on
	 * purpose. A confirmation naming the file name would state an identity both satisfy while
	 * calling itself irreversible.
	 */
	let pendingCancel = $state<{
		id: string;
		fileName: string | null;
		importedRows: number;
		createdAt: string;
	} | null>(null);
	/**
	 * The three times of the delete (Planche 5f), and the rule that governs them is one sentence: the
	 * modal does not close on the press, it closes on the answer.
	 *
	 * A dialog that closes on the press moves the answer out of the screen where the finger was and
	 * where the focus is. The row is still there, nothing has changed, and it reads exactly like a
	 * press that did nothing, which is the defect this wave exists to remove arriving AFTER the press
	 * instead of during it.
	 *
	 * TWO FAILURE CLASSES, and they are told apart by their ACTION and not only by their sentence.
	 * The server answered and refused: nothing was removed, so retrying is the right offer. Nothing
	 * answered at all: the deletion may have gone through, so the offer is to refresh the list,
	 * because retrying an irreversible action blind is the worst advice a banner can give.
	 *
	 * A THIRD CLASS THE PLATE DESCRIBES IS NOT BUILT, and that is a finding rather than an omission.
	 * The delete plate's 2k models a permanent business refusal (« import verrouillé, droits
	 * insuffisants ») whose destructive button DISAPPEARS. No route produces it: `deleteImportBatch`
	 * answers 404 for a batch that is not this user's and 500 for a database failure, and there is no
	 * locked-import rule anywhere. Building it would be a branch nothing can reach, which is the
	 * shape this repository checks for by name.
	 */
	let deletePhase = $state<'idle' | 'busy' | 'error'>('idle');
	let deleteFailure = $state<'refused' | 'noAnswer' | null>(null);

	/** 20 s, from the plate: past it the answer is not late, it is absent. */
	const DELETE_NO_ANSWER_MS = 20_000;
	let noAnswerTimer: ReturnType<typeof setTimeout> | null = null;

	function clearNoAnswerTimer() {
		if (noAnswerTimer !== null) {
			clearTimeout(noAnswerTimer);
			noAnswerTimer = null;
		}
	}

	function closeCancelDialog() {
		clearNoAnswerTimer();
		pendingCancel = null;
		deletePhase = 'idle';
		deleteFailure = null;
	}

	const deleteError = $derived(
		deleteFailure === null
			? undefined
			: deleteFailure === 'noAnswer'
				? {
						message: m.imports_delete_no_answer_message(),
						actionLabel: m.imports_delete_no_answer_action(),
						onAction: () => void invalidateAll().then(closeCancelDialog)
					}
				: {
						message: m.imports_delete_failed_message(),
						actionLabel: m.imports_delete_failed_action(),
						onAction: () => {
							deletePhase = 'idle';
							deleteFailure = null;
							cancelFormEl?.requestSubmit();
						}
					}
	);

	let cancelFormEl = $state<HTMLFormElement | null>(null);

	/**
	 * Brique 9's skeleton, at the destination Planche 5f moves it to.
	 *
	 * `/imports` on arrival is a server WRITE followed by a list re-read, two round trips one of
	 * which writes the rows, so the 300 ms threshold is crossed even on a fast network. That is why
	 * the plate calls this the place it was really missing, and why the designation screen, whose
	 * cards exist because the file is already in memory, could never show one.
	 *
	 * Scoped to this route, following the pattern `/` and `/upcoming-bills` already use: navigating
	 * away from this page must not paint a skeleton over the page being left.
	 */
	const listLoading = createDelayedFlag();
	$effect(() => {
		listLoading.set(navigating.to?.url.pathname === '/imports');
	});
	$effect(() => () => listLoading.destroy());
	// The no-answer timer follows the same discipline as the skeleton's, and it was the one timer in
	// this file that did not. Navigating away with a delete still in flight left it armed to fire
	// twenty seconds later into state nothing was reading.
	$effect(() => () => clearNoAnswerTimer());

	/**
	 * The timestamp this page identifies an import BY, so it is rendered to the second.
	 *
	 * MEASURED, and it is why this is not `timeStyle: 'short'` like everywhere else. Running the
	 * correction journey end to end produced two rows both reading « 17 août 2026 à 14:10 »: a
	 * repair happens minutes after the import that went wrong, so the two land in the same minute
	 * often enough that it cannot be called an edge. A discriminant that is not unique identifies
	 * nothing, and a confirmation naming both candidates while calling itself irreversible is worse
	 * than one naming neither, because it reads as precise.
	 *
	 * This deviates from the plate, which writes the title as « Supprimer l'import du 1 juillet 2026
	 * à 10:59 ? ». The deviation is forced by the plate's own rule that the discriminant be unique,
	 * so the rule is kept and the example is not.
	 *
	 * One function for the row and for the dialog title, deliberately: they are two renderings of
	 * one identity and a second formatter is how they start disagreeing.
	 */
	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString(getLocale(), { dateStyle: 'long', timeStyle: 'medium' });
	}

	function formatDateOnly(iso: string): string {
		return new Date(iso).toLocaleDateString(getLocale(), { dateStyle: 'long' });
	}

	/**
	 * The two imports named, with the figures that make them look alike.
	 *
	 * Named rather than resolved. For an import already written the certainty the pre-write check has
	 * is gone: its fingerprints cannot be recomputed, so « the same statement twice » and « two
	 * statements that happen to agree on all three figures » are no longer distinguishable from here.
	 * The copy says « peut-être » because that is what is known, and the banner's job is to make the
	 * pair findable rather than to decide for the user. Each import already links to its own
	 * transactions from its row below, which is where a comparison actually happens.
	 */
	function collisionFigures(batch: CollidingBatchView): string {
		return m.imports_collision_figures({
			count: batch.transactionCount,
			debit: formatCents(batch.debitCents),
			credit: formatCents(batch.creditCents),
			from: batch.periodStart ? formatDateOnly(batch.periodStart) : '',
			to: batch.periodEnd ? formatDateOnly(batch.periodEnd) : ''
		});
	}

	function cancelConfirmDescription(importedRows: number): string {
		return importedRows > 1
			? m.imports_cancel_confirm_description_count_many({ count: importedRows })
			: m.imports_cancel_confirm_description_count_one({ count: importedRows });
	}

	/**
	 * « Correspondance mémorisée le 12 juillet, utilisée 4 fois. »
	 *
	 * The plate writes the date as day and month with no year, and that is a choice rather than an
	 * omission: the sentence exists to let a user place the memorisation against their own memory of
	 * using the application, not to date a record.
	 */
	function memorisedSentence(mapping: { memorisedAt: string; useCount: number }): string {
		const date = new Date(mapping.memorisedAt).toLocaleDateString(getLocale(), {
			day: 'numeric',
			month: 'long'
		});
		return mapping.useCount === 1
			? m.import_columns_memorised_one({ date, count: mapping.useCount })
			: m.import_columns_memorised_many({ date, count: mapping.useCount });
	}
</script>

<!--
	The plate's §3.7 block: a check glyph, `Colonnes reconnues`, the memorisation sentence, and a
	TapLink that opens the recap. Drawn under the file, in both chromes.

	It is the ONLY thing standing between a wrong designation and a permanent one. A correspondance
	that named the wrong column imports every row of every file with nothing invalid, so no count is
	wrong and no banner appears; without this the user has no route back to the four rows at all, and
	the mistake repeats unattended on every statement of that shape.

	The check glyph is BLACK, not green (§8): it is the state of a condition, not the result of an
	action, and this screen carries no tinted surface.
-->
{#snippet recognisedColumns(batchId: string, mapping: { memorisedAt: string; useCount: number })}
	<div class="flex items-start gap-2">
		<svg
			class="mt-0.5 h-[15px] w-[15px] shrink-0 text-zinc-900"
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M4 10.5 8 14.5 16 6" />
		</svg>
		<div class="min-w-0">
			<p class="text-[13.5px] font-semibold text-zinc-900">{m.import_columns_recognised()}</p>
			<p class="text-[12.5px] text-zinc-500">{memorisedSentence(mapping)}</p>
			<a
				href={resolve('/imports/[batchId]/columns', { batchId })}
				class="flex min-h-[44px] items-center text-[13.5px] font-semibold text-zinc-600 hover:text-zinc-900"
			>
				{m.import_columns_view()}
			</a>
		</div>
	</div>
{/snippet}

<!--
	Two imports that look like the same statement, surfaced on the page that lists them.

	A banner above the history rather than a badge on a row, because the finding is about a PAIR and
	a row cannot express one.

	`AlertBanner` (brique 8) rather than a surface built here. The first draft of this block was a
	bordered `<section>` with its own heading and five paragraphs, which is a seventeenth pattern for
	a job the referential already has a piece for, on the one page that owns page-level messages.

	`warning` and not `info`, decided from AlertBanner's own rule: info « carries no judgement »
	and is for a banner that merely offers a choice. This is not an offer. Something in the user's
	data is probably wrong and they are the only one who can settle it.

	AlertBanner's root is a `<p>`, so every line here is phrasing content. `<strong>` and
	`<span class="block">` rather than headings and paragraphs, which would be invalid inside it.

	No « Supprimer » button. Deleting an import takes its transactions, and with them, by cascade,
	every répartition and every étiquette added since. Offering that as the one-tap answer to a
	finding the app is explicitly unsure about is the class of destructive shortcut this codebase has
	spent a fortnight removing. The way out is the row's own Supprimer, which now states that cost.
-->
{#snippet collisionNotice()}
	{#if collisionPair}
		<AlertBanner variant="warning">
			<strong class="block font-semibold">{m.imports_collision_title()}</strong>
			<span class="mt-1 block font-normal">
				{m.imports_collision_body({
					first: collisionPair.first.fileName ?? m.imports_default_file_name(),
					second: collisionPair.second.fileName ?? m.imports_default_file_name()
				})}
			</span>
			<span class="mt-0.5 block text-xs font-normal">{collisionFigures(collisionPair.first)}</span>
			<span class="mt-2 block font-semibold">{m.imports_collision_consequence()}</span>
			<span class="mt-0.5 block text-xs font-normal">{m.imports_collision_advice()}</span>
			{#if otherCollisions > 0}
				<span class="mt-2 block text-xs font-normal">
					{otherCollisions === 1
						? m.imports_collision_more_one({ count: otherCollisions })
						: m.imports_collision_more_many({ count: otherCollisions })}
				</span>
			{/if}
		</AlertBanner>
	{/if}
{/snippet}

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
			<!--
				« Import supprimé », not « Import annulé ». A label naming something other than what it
				labels, and this one said the wrong thing about an irreversible act: nothing was
				cancelled, an import was deleted, and every other control on this path already says
				« Supprimer ». An action keeps the same name through the whole flow, so the button that
				says Supprimer produces a message that says supprimé.

				The route keeps `?/cancel` and `?cancelled=1`: those are internal names, and renaming
				them is a change to an address for the sake of a caption.
			-->
			<AlertBanner variant="success">{m.imports_cancelled_notice()}</AlertBanner>
		{/if}
		{@render collisionNotice()}
		<!-- Gated to skip while the cancel-import ConfirmDialog is open: it already shows its own
		     contextual AlertBanner for the same form.error — without this, both would mount
		     role="alert" simultaneously for the same message, double-announcing it to screen
		     readers. -->
		{#if form?.error && !pendingCancel}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}

		{#if listLoading.shown}
			<ImportCardSkeleton />
		{:else if data.batches.length === 0}
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
									<td class="px-4 py-3 font-medium">
										{batch.fileName ?? m.imports_default_file_name()}
										{#if batch.columnMapping}
											<div class="mt-1 font-normal">
												{@render recognisedColumns(batch.id, batch.columnMapping)}
											</div>
										{/if}
									</td>
									<td class="px-4 py-3 text-zinc-700">{importProfileLabel(batch.profile)}</td>
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
											<!--
												THE DESKTOP LOSES ITS WORD (Planche 5e). Brique 1's « Remplace » section
												names imports, bin included, so the mobile chrome was applying the
												referential and this surface had stayed on a drawing already replaced.
												A divergence tolerated is a divergence that grows, and this one is the
												documented origin of the chantier.
											-->
											<ImportDeleteButton
												namedAt={formatDate(batch.createdAt)}
												onPress={() =>
													(pendingCancel = {
														id: batch.id,
														fileName: batch.fileName,
														importedRows: batch.importedRows,
														createdAt: batch.createdAt
													})}
											/>
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
						<ListCard>
							<div class="flex items-start justify-between gap-3">
								<p class="font-bold text-zinc-950" title={batch.createdAt}>
									{formatDate(batch.createdAt)}
								</p>
								<span class="shrink-0">
									<Badge tone="neutral">{importProfileLabel(batch.profile)}</Badge>
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
							{#if batch.columnMapping}
								<div class="mt-3 border-t border-zinc-100 pt-3">
									{@render recognisedColumns(batch.id, batch.columnMapping)}
								</div>
							{/if}
							<!--
								The action row of Planche 5e's anatomy. The destructive control joins the row
								that already existed, to the right of « Voir », on the far side of the rule
								that already separates the data from the actions: no new zone to invent, the
								card had a foot and it changes contents.

								12 px between the two targets and not 8, because one of them is irreversible:
								that gap is the margin between a mistyped tap and a deletion. « Voir » rises to
								48 so the row's two targets align rather than one sitting under the floor.

								The 12 px optical overhang is what drops the glyph under the right edge of the
								content, like the profile badge above it; without it a transparent 48 px box
								leaves 15 px of air and the right column reads as broken. It bites into the
								card's own 16 px padding and never past it, so the target stays inside the card.
							-->
							<div class="mt-3 flex items-center justify-end gap-3 border-t border-zinc-100 pt-3">
								<a
									href={resolve(
										`/transactions?importBatch=${batch.id}` as `/transactions?${string}`
									)}
									class="flex min-h-12 items-center px-2 text-sm font-semibold text-zinc-700 hover:text-zinc-900"
								>
									{m.imports_view()}
								</a>
								<span class="-mr-3">
									<ImportDeleteButton
										namedAt={formatDate(batch.createdAt)}
										onPress={() =>
											(pendingCancel = {
												id: batch.id,
												fileName: batch.fileName,
												importedRows: batch.importedRows,
												createdAt: batch.createdAt
											})}
									/>
								</span>
							</div>
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
		bind:this={cancelFormEl}
		method="POST"
		action="?/cancel"
		use:enhance={() => {
			deletePhase = 'busy';
			deleteFailure = null;
			// The absence of an answer is a state of its own, so it is armed here rather than inferred
			// from a rejection that may never come: a request that hangs produces no event at all.
			clearNoAnswerTimer();
			noAnswerTimer = setTimeout(() => {
				deletePhase = 'error';
				deleteFailure = 'noAnswer';
			}, DELETE_NO_ANSWER_MS);

			return async ({ result, update }) => {
				clearNoAnswerTimer();
				await update();
				// CLOSES ON THE ANSWER, and only on the successful one. A redirect is what the action
				// returns once the rows are gone; anything else leaves the dialog mounted with the
				// failure inside it, where the press happened.
				if (result.type === 'redirect') {
					closeCancelDialog();
					// NAVIGATED EXPLICITLY, with the load invalidated, and it is a repair rather than a
					// flourish. Measured in a browser: after the enhanced delete the address bar read
					// `/imports?cancelled=1` and the success banner was ABSENT, while a fresh navigation
					// to that same address rendered it. The load reads the flag off the query string, so
					// the run that produced the redirect was the only one not to re-read it, and the
					// delete finished in silence on the one screen whose whole job is to report it.
					//
					// That is A3's family, and Planche 5f's success row requires the banner by name.
					// The location comes from the server action's own redirect, so it is already a
					// resolved address rather than a route id this file could pass through `resolve()`.
					// eslint-disable-next-line svelte/no-navigation-without-resolve
					await goto(result.location, { invalidateAll: true });
					return;
				}
				deletePhase = 'error';
				deleteFailure = 'refused';
			};
		}}
	>
		<input type="hidden" name="batchId" value={pendingCancel.id} />
		<!--
			The plate's §2g. The title is the dialog's `aria-labelledby` target, so the name a screen
			reader announces and the sentence on screen are one node and cannot diverge.

			`formatDate` rather than a second formatter: it is what the row above already shows for
			this import, so the user is comparing two renderings of the same string rather than a
			timestamp against a date. That is also why the date is written in words. `01/07/2026
			10:59` is read out as digits and slashes, which is not comparable button to button.

			The confirm is short because the dialog is already named. Repeating the object in the
			button, « Supprimer l'import », says less than « Supprimer » does under a title that has
			just said WHICH import.

			TWO DEVIATIONS FROM THE PLATE, both deliberate and recorded rather than rounded away.

			The dismiss keeps « Garder l'import » where the plate writes « Annuler ». Settled by the
			owner: this change exists partly to stop « Annuler » naming a deletion, so adopting the
			plate's value here would work against the change it is making. A dismiss that says what it
			PRESERVES also beats one that says what it abandons.

			And the plate's drawn body claims « Les transactions déjà importées ne seront pas
			supprimées », which is the opposite of what this action does and contradicts the plate's
			own description of the existing copy. Treated as a transcription slip and not
			implemented; the cost note below is what ships.
		-->
		<ConfirmDialog
			open={true}
			title={m.imports_cancel_confirm_title({ date: formatDate(pendingCancel.createdAt) })}
			description={cancelConfirmDescription(pendingCancel.importedRows)}
			confirmLabel={m.imports_cancel_confirm_label()}
			cancelLabel={m.imports_cancel_keep_label()}
			tone="danger"
			phase={deletePhase}
			busyLabel={m.imports_delete_busy()}
			error={deleteError}
			onClose={closeCancelDialog}
		>
			<p class="text-sm text-zinc-600">
				{m.imports_cancel_file_prefix()}
				<span class="font-medium">{pendingCancel.fileName ?? m.imports_default_file_name()}</span>
			</p>
			<!--
				What the count in the description does not say. Deleting the transactions cascades to
				their répartitions and their étiquettes, and those are the user's own work rather than
				the import's: a statement can be re-imported, an evening spent splitting a shopping trip
				across four categories cannot. A destructive action stating only half its cost is a
				confirmation that is not one.
			-->
			<p class="mt-2 text-sm text-zinc-600">{m.imports_cancel_cost_note()}</p>
			<!--
				The failure is no longer rendered here. It is the dialog's own `error` slot now, which
				puts it between the body and the actions, announces it with `role="alert"` AND moves the
				focus onto it. A banner inside the body announced itself and left the reader on the
				confirm button, which is where the focus already was.
			-->
		</ConfirmDialog>
	</form>
{/if}
