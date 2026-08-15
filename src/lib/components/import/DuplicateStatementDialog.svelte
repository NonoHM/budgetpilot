<script lang="ts">
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import * as m from '$lib/paraglide/messages';
	import { formatCents } from '$lib/domain/budget';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { CollisionFigures } from '$lib/domain/importCollision';

	/**
	 * The question asked before a run that deduplication cannot see is written.
	 *
	 * ## Why it is a modal here and a full page for the columns
	 *
	 * The designation screen was settled as a full page in the navigation stack because it carries up
	 * to 512 columns and its picker list is 4751 px at 40 of them. This is the opposite shape: three
	 * figures on each side and two buttons, with nothing to scroll and nothing to choose. What it
	 * needs is exactly what a modal gives, a decision that has to be answered before anything else
	 * happens, and `Modal` already owns the focus trap and the restore.
	 *
	 * ## Both sides are shown, and they are identical
	 *
	 * That is the argument rather than a redundancy. The rule fires on an exact match of count and of
	 * both sums (`server/import/collision.ts`), so the two columns agreeing to the cent is the whole
	 * evidence, and a warning that asserts a resemblance without showing it is asking to be believed.
	 *
	 * ## No comparison screen
	 *
	 * Deliberate, and the alternative was scoped and dropped rather than left open: a screen showing
	 * two batches row against row is a feature, not a detail of this one, and shipping the warning
	 * without it is better than discovering it mid-implementation. What the user needs to compare is
	 * already reachable: every batch on `/imports` links to its own transactions.
	 *
	 * ## The route that produces each state
	 *
	 * `open` is set by the `fail(409)` branch of `/import` (auto-detected and remembered imports) and
	 * by the same branch of `/import/columns` (the run that designates by hand). Named here because a
	 * prop no route sets is a draft, not a feature.
	 *
	 * ## Confirming is the CALLER's form
	 *
	 * `ConfirmDialog`'s primary is a `type="submit"`, so this component renders no submit handler of
	 * its own and each page wraps it in the `<form>` that knows how to re-post. Neither page can use
	 * an ordinary nested form: `/import` renders its upload form TWICE, once per chrome, and
	 * `/import/columns` holds the file in memory rather than in an input. Both therefore intercept
	 * `onsubmit` and post a hand-assembled body, which also keeps the Enter key working.
	 */
	let {
		open = false,
		existing,
		incoming,
		importedAt,
		confirming = false,
		error = null,
		onCancel
	}: {
		open?: boolean;
		existing: CollisionFigures;
		incoming: CollisionFigures;
		/** ISO instant the existing batch was created. Formatted here, where the locale is known. */
		importedAt: string;
		confirming?: boolean;
		/**
		 * A confirmation that could not be delivered, reported INSIDE the dialog.
		 *
		 * A banner on the page behind a modal is a message nobody reads, and the failure it reports
		 * is exactly the one where the user presses the primary and nothing happens. The caller keeps
		 * it generic (ASVS 5.0 V16.5.1); nothing caught is rendered here.
		 */
		error?: string | null;
		onCancel: () => void;
	} = $props();

	// `ImportBatch.fileName` is nullable, and an empty line where a file name belongs reads as a
	// rendering fault rather than as an absence. Same substitution `/imports` already makes.
	function fileNameOf(batch: CollisionFigures): string {
		return batch.fileName ?? m.imports_default_file_name();
	}

	function figures(batch: CollisionFigures): string {
		return m.import_collision_figures({
			count: batch.transactionCount,
			debit: formatCents(batch.debitCents),
			credit: formatCents(batch.creditCents)
		});
	}

	function period(batch: CollisionFigures): string | null {
		if (!batch.periodStart || !batch.periodEnd) return null;
		return m.import_collision_period({
			from: formatDate(batch.periodStart),
			to: formatDate(batch.periodEnd)
		});
	}

	function formatDate(iso: string): string {
		// Date-only strings are `YYYY-MM-DD`; parsed as UTC so a negative local offset cannot move
		// the displayed day back one, which on a period boundary would contradict the batch row on
		// `/imports` for the same batch.
		return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString(getLocale(), {
			dateStyle: 'long',
			timeZone: 'UTC'
		});
	}

	function formatInstant(iso: string): string {
		return new Date(iso).toLocaleString(getLocale(), { dateStyle: 'long', timeStyle: 'short' });
	}
</script>

<ConfirmDialog
	{open}
	title={m.import_collision_title()}
	confirmLabel={m.import_collision_confirm()}
	cancelLabel={m.import_collision_cancel()}
	tone="danger"
	confirmLoading={confirming}
	onClose={onCancel}
>
	<!--
		The two panels are a `<dl>` rather than a two-column table. Below lg they stack, and a table
		that reflows into two stacked rows loses the one thing a table gives, which is the reading of
		a column against its neighbour. A description list stacks without pretending otherwise, and
		each figure keeps the heading that names which side it belongs to.
	-->
	<p class="text-sm text-zinc-700">{m.import_collision_explanation()}</p>

	<dl class="mt-4 grid gap-3 text-left sm:grid-cols-2">
		<div class="rounded-2xl border border-zinc-200 bg-zinc-50 p-3">
			<dt class="text-[11px] font-bold tracking-[0.03em] text-zinc-500 uppercase">
				{m.import_collision_existing_heading()}
			</dt>
			<dd class="mt-1 space-y-0.5">
				<p class="truncate text-sm font-medium text-zinc-900" title={fileNameOf(existing)}>
					{fileNameOf(existing)}
				</p>
				<p class="text-xs text-zinc-600">{figures(existing)}</p>
				{#if period(existing)}
					<p class="text-xs text-zinc-600">{period(existing)}</p>
				{/if}
				<p class="text-xs text-zinc-500">
					{m.import_collision_existing_date({ date: formatInstant(importedAt) })}
				</p>
			</dd>
		</div>
		<div class="rounded-2xl border border-zinc-200 bg-zinc-50 p-3">
			<dt class="text-[11px] font-bold tracking-[0.03em] text-zinc-500 uppercase">
				{m.import_collision_incoming_heading()}
			</dt>
			<dd class="mt-1 space-y-0.5">
				<p class="truncate text-sm font-medium text-zinc-900" title={fileNameOf(incoming)}>
					{fileNameOf(incoming)}
				</p>
				<p class="text-xs text-zinc-600">{figures(incoming)}</p>
				{#if period(incoming)}
					<p class="text-xs text-zinc-600">{period(incoming)}</p>
				{/if}
			</dd>
		</div>
	</dl>

	<p class="mt-4 text-sm font-medium text-zinc-900">{m.import_collision_consequence()}</p>

	<!--
		The registered banner, and the same call `/imports` already makes inside its own
		ConfirmDialog. A hand-rolled rose paragraph was the first draft: it duplicated the one
		component that owns this tone, and it carried its own `role="alert"` rather than the live
		region AlertBanner already resolves per variant.
	-->
	{#if error}
		<AlertBanner variant="error" class="mt-3">{error}</AlertBanner>
	{/if}
</ConfirmDialog>
