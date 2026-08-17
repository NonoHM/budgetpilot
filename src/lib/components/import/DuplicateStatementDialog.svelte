<script lang="ts">
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import * as m from '$lib/paraglide/messages';
	import { formatCents } from '$lib/domain/budget';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { CollisionFigures, CorrectionContext } from '$lib/domain/importCollision';

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
	 * `correctionContext` comes from the same two branches, derived on `/import` from the POSTED
	 * CHOICE rather than from the presence of a correction. `none` is every collision that has
	 * nothing to do with a correction; `keeping` is a correction whose control was unticked;
	 * `replacing` is a correction whose control was ticked AND a third batch that also matches,
	 * which needs a duplicate to exist already.
	 *
	 * ## Why the confirm loses its tint in the two correction framings
	 *
	 * The design plate for the import deletion settles this, and it settles it for the product
	 * rather than for that screen: « le glyphe porte le sens, pas la couleur », and a red spent
	 * where it is not data « affaiblirait celui qui informe au profit de celui qui décore ». This
	 * application spends red on irreversible deletion and on the invalid-rows counter, both of which
	 * are facts. Confirming a correction destroys nothing at the moment it is pressed: it imports.
	 *
	 * The blind session met the other version of this. The correction flow instructed the user to
	 * import, and two clicks later the guard rendered that instructed action as a red button, in
	 * the colour the application uses for irreversible deletion. The dialog's writing was good; it
	 * simply did not know how the user had arrived at it.
	 *
	 * NOT a new tone. `ConfirmDialog`'s existing `default` is exactly a neutral confirmation, so
	 * this reuses it rather than inventing a third value for one surface. Brique 15 is the modal and
	 * it is unchanged.
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
		correctionContext = 'none',
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
		/** What this run will do with the import it is correcting. Defaults to 'none'. */
		correctionContext?: CorrectionContext;
		onCancel: () => void;
	} = $props();

	/**
	 * The TITLE branches on all three values, exactly as the body does.
	 *
	 * It used to read `isCorrection ? keeping : title`, a boolean over a three-valued prop, and the
	 * `replacing` case therefore wore the `keeping` heading: « Vous avez choisi de garder l'ancien
	 * import » over a body reading « L'import que vous corrigez sera remplacé. » Two sentences
	 * contradicting each other about a delete, on one screen, with the false one as the
	 * `aria-labelledby` target — so a screen reader announced the dialog by the claim that is wrong.
	 *
	 * That is the defect the three-valued prop was introduced to prevent, surviving one level up. The
	 * spec's own words: « a boolean prop would produce the contradiction this design was caught on ».
	 * The lesson is not "fix the title" but that a prop widened from a boolean has to be re-read at
	 * EVERY site that consumed the boolean, and this one was missed because the body was the site
	 * everyone was looking at.
	 *
	 * The `replacing` heading names the SITUATION rather than either fact, because both facts are
	 * true and the body states both. A heading that picked one would be the same defect with the
	 * other half showing.
	 */
	const title = $derived(
		correctionContext === 'keeping'
			? m.import_collision_keeping_heading()
			: correctionContext === 'replacing'
				? m.import_collision_replacing_heading()
				: m.import_collision_title()
	);

	/**
	 * Still a boolean, and only for the things that genuinely are binary: the confirm's label and its
	 * tone are the same in both correction framings, because in both the user did nothing wrong and
	 * in both the press imports rather than destroys.
	 */
	const isCorrection = $derived(correctionContext !== 'none');

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

<!--
	NO `tone`, in any framing, so `ConfirmDialog`'s neutral default applies.

	The two correction framings lost the danger tint when they were added, on the argument below. The
	`none` case kept it, and walking the flow is what showed the argument covers this case too:
	NOTHING HERE DELETES ANYTHING. This dialog fires before the first write, and every button on it
	either imports or abandons. The red was spent on the risk of a DUPLICATE, which the app then
	repairs with a delete the user can see.

	This application spends red on irreversible deletion and on the invalid-rows counter, both facts.
	The plate's doctrine, from the import-deletion sheet: « le glyphe porte le sens, pas la couleur »,
	and a red spent where it is not data « affaiblirait celui qui informe au profit de celui qui
	décore ». A red here is exactly that, and it makes the red on the delete confirmation worth less.

	The WORD was always doing the work: `import_collision_consequence` states the doubling in bold in
	all three framings, and the `none` label still reads « Importer quand même », which carries the
	override in its own words. Colour never travelled alone here; it travelled where it was not needed.
-->
<ConfirmDialog
	{open}
	{title}
	confirmLabel={isCorrection
		? m.import_collision_correction_confirm()
		: m.import_collision_confirm()}
	cancelLabel={m.import_collision_cancel()}
	confirmLoading={confirming}
	onClose={onCancel}
>
	<!--
		The two panels are a `<dl>` rather than a two-column table. Below lg they stack, and a table
		that reflows into two stacked rows loses the one thing a table gives, which is the reading of
		a column against its neighbour. A description list stacks without pretending otherwise, and
		each figure keeps the heading that names which side it belongs to.
	-->
	<!--
		The frame, and only the frame, changes with the context. The two panels below and the
		consequence line are FACTS about the two runs and they are true in all three framings, so
		they are outside this branch: a reframing that replaced them would be a dialog that stopped
		showing its evidence.
	-->
	{#if correctionContext === 'keeping'}
		<p class="text-sm text-zinc-700">{m.import_collision_keeping_body()}</p>
	{:else if correctionContext === 'replacing'}
		<!--
			BOTH facts, because both are true and saying one of them is the same defect one level
			along: the import being corrected really is replaced, AND the statement drawn above is a
			third import this run would duplicate.
		-->
		<p class="text-sm text-zinc-700">{m.import_collision_replacing_body()}</p>
	{:else}
		<p class="text-sm text-zinc-700">{m.import_collision_explanation()}</p>
	{/if}

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
