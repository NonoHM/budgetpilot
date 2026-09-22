<script lang="ts">
	import Modal from '$lib/components/Modal.svelte';
	import Button from '$lib/components/Button.svelte';
	import * as m from '$lib/paraglide/messages';

	/**
	 * #485's one offer: does this file cover more than one account?
	 *
	 * ## Why this is `Modal` + `Button` and not `ConfirmDialog`
	 *
	 * `ConfirmDialog` is confirm-or-cancel: one substantive action (the primary) and one plain
	 * dismissal (the `TapLink`, which only calls `onClose`). This question has two substantive,
	 * mutually exclusive answers — "several accounts" and "something else" — and neither is a plain
	 * dismissal; there is no third state to hand `onClose` here beyond leaving the file unresolved,
	 * which Escape, the backdrop and (below) the header's own close already do for free. Forcing one
	 * real answer into `cancelLabel` would make the TapLink call `onClose` for an ANSWER, and Escape
	 * or the backdrop would then silently submit that same answer on a plain dismissal — a user who
	 * meant "let me look at this file again" would import it as a single account instead. So this
	 * composes `Modal` and `Button` directly, one level down from where `ConfirmDialog` itself is
	 * built, the same way `DuplicateStatementDialog` composes `ConfirmDialog` one level up.
	 *
	 * ## The evidence is the column's own values, never the word "discriminant"
	 *
	 * The user does not think in discriminant columns; they know whether their statement covers one
	 * account or several. So the question is asked in those words, and what is SHOWN is the file's
	 * own header and two of its own differing values — same shape as the date-reading offer showing
	 * both readings rather than naming `dd/mm` versus `mm/dd`.
	 *
	 * ## Confirming is the CALLER's business, same convention as `DuplicateStatementDialog`
	 *
	 * Both buttons are `type="button"`: this dialog is not itself submitting a form load-bearing
	 * enough to answer either question. The caller (`/import`, `/import/columns`) resubmits with the
	 * file it already holds and `accountColumnAnswer` set to the answer, mirroring how the reading
	 * offer's chosen order is threaded back through the SAME resubmission mechanism.
	 */
	let {
		open = false,
		column,
		header,
		samples,
		onConfirmAccount,
		onDenyAccount,
		onClose
	}: {
		open?: boolean;
		/** The header's own declared index, for the numbered fallback when the file has none. */
		column: number;
		/** The column's own header text, or `''` for a headerless file. */
		header: string;
		/** Two or more of the column's own values, chosen to DISCRIMINATE (#342), never the first rows. */
		samples: string[];
		/** "Yes, these are account numbers." Refuses the import; never writes a split. */
		onConfirmAccount: () => void;
		/** "No, something else." The column is dropped as noise and the import proceeds. */
		onDenyAccount: () => void;
		onClose: () => void;
	} = $props();

	const evidence = $derived(
		header
			? m.import_account_column_evidence({ header, values: samples.join(', ') })
			: m.import_account_column_evidence_no_header({
					count: column + 1,
					values: samples.join(', ')
				})
	);
</script>

<!--
	The question mark, brique 15's own glyph (`ConfirmDialog`'s mobile header, reused verbatim
	rather than invented): zinc-toned, since this is a question and never the danger tone — nothing
	here deletes anything, the same doctrine `DuplicateStatementDialog` records at length. Decorative
	only (`aria-hidden`): the accessible name is `Modal`'s own title, unchanged.
-->
<Modal {open} title={m.import_account_column_title()} {onClose}>
	<div class="flex flex-col gap-4">
		<div class="flex items-start gap-3">
			<div
				class="flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-100"
				aria-hidden="true"
			>
				<svg class="size-5 text-zinc-500" viewBox="0 0 20 20" fill="none">
					<circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.6" />
					<path d="M10 6v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
					<circle cx="10" cy="13.6" r="1" fill="currentColor" />
				</svg>
			</div>
			<p class="mt-1.5 text-sm text-zinc-600">{evidence}</p>
		</div>
		<div class="flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-3">
			<Button type="button" variant="secondary" class="flex-1 sm:flex-none" onclick={onDenyAccount}>
				{m.import_account_column_deny()}
			</Button>
			<Button
				type="button"
				variant="primary"
				class="flex-1 sm:flex-none"
				onclick={onConfirmAccount}
			>
				{m.import_account_column_confirm()}
			</Button>
		</div>
	</div>
</Modal>
