<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { MAPPING_ROLES, type MappingRole } from '$lib/domain/mappingRoles';
	import {
		EMPTY_ASSIGNMENT,
		canImport,
		designate,
		pageStateOf,
		type DesignationFile,
		type RoleAssignment
	} from '$lib/domain/columnDesignation';
	import { bannerFor } from '$lib/domain/columnDesignationBanner';
	import { roleLabel } from '$lib/domain/columnMappingLabels';
	import ConditionBanner from '$lib/components/ui/ConditionBanner.svelte';
	import RoleRow from '$lib/components/ui/RoleRow.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import ColumnPicker from './ColumnPicker.svelte';

	/**
	 * « Désigner les colonnes », the 390x844 screen, as four fixed regions.
	 *
	 * ## The region stack, and the two shapes it must not use
	 *
	 *     56   header        back plus title, does not scroll
	 *    636   body          the only scrolling region
	 *     64   condition banner
	 *     88   action footer (28 of it the home indicator area)
	 *    ---
	 *    844
	 *
	 * **Not `position: sticky; bottom: 0`.** A bottom-sticky element is painted at the scrollport's
	 * bottom edge for as long as its containing block extends past that edge, so "sticky and must
	 * not cover content" are not jointly satisfiable and no offset fixes it. This repository has
	 * already shipped that defect once, on the band whose whole purpose was to explain why Save was
	 * disabled, covering the rows it was about.
	 *
	 * **`minmax(0, 1fr)`, never `1fr`.** A `1fr` track's automatic minimum size is content-based, so
	 * it refuses to shrink below its content and the 636 cap is silently ignored: the page grows and
	 * the banner leaves the screen, in exactly the states with the most content.
	 *
	 * **Measured here, and the measurement is worth keeping: it makes no difference in THIS
	 * configuration.** Swapping in a bare `1fr` leaves all eleven geometry tests green, because a
	 * grid item's automatic minimum size is content-based only while its `overflow` is `visible`,
	 * and the body is a scroll container. Kept regardless: it is explicit, it costs nothing, and it
	 * stops being redundant the day somebody removes the overflow. What must not be claimed is that
	 * a test guards it. None does, and none can while the body scrolls.
	 *
	 * ## The body's 511 of 636, which is the plate's promise
	 *
	 *     16   padding-top
	 *     40   file block      (60 in state 3c, which adds a third line)
	 *     14   gap
	 *    355   designation card
	 *     14   gap
	 *     48   « Format du fichier », a RESERVED SLOT with no content today
	 *     24   padding-bottom
	 *    ---
	 *    511, leaving 125 px of air, and THE SCREEN DOES NOT SCROLL IN ANY STATE.
	 *
	 * The card ends at 425 of 636 (16 + 40 + 14 + 355). Both figures are asserted, and the 125 px is
	 * the room the out-of-scope trio (date format, decimal separator, delimiter) moves into without
	 * any measurement here being redone.
	 *
	 * ## No text input anywhere
	 *
	 * Consequence rather than coincidence: the virtual keyboard never opens, so the visual-viewport
	 * case that governs every other form screen in this product does not arise and the body is 636
	 * px in every state. The single exception is the search field above 20 columns, which lives in
	 * the picker and not here.
	 *
	 * ## The screen iterates over the FOUR ROLES, never over the N columns
	 *
	 * Do not undo this. Column count is unbounded (a bank CSV carries fifteen, and forty is
	 * measured); role count is closed at four. A preview table with a role selector per column
	 * measures 1980 px at 390 and does not exist here at any breakpoint. If you find yourself
	 * building a wide table with a select per column, the 390 constraint has stopped being
	 * respected.
	 */
	let {
		file,
		initialAssignment = EMPTY_ASSIGNMENT,
		candidates = {},
		lostHeaders = {},
		analysing = false,
		submitting = false,
		signaturePartial = false,
		signatureLostDate = null,
		announceDelayMs = 150,
		readOnly = false,
		wide = false,
		onCancel,
		onSubmit
	}: {
		file: DesignationFile;
		/**
		 * What detection already worked out. The screen OWNS the assignment from here on, because
		 * every state that matters (the move, the vacated row, the recount) is a consequence of one
		 * gesture on this screen, and threading it through a parent would put the three halves of one
		 * mechanism in two files.
		 */
		initialAssignment?: RoleAssignment;
		/**
		 * Per role, the column indices detection proposes. Two or more is what makes a row ambiguous.
		 *
		 * Detection DOES NOT PICK BETWEEN EQUALS: it shortens the path when a column is unambiguous
		 * and stays out of the way when it is not. A rule, never a confidence score.
		 */
		candidates?: Partial<Record<MappingRole, readonly number[]>>;
		/** State 3b: per role, the remembered header that is gone from this file. */
		lostHeaders?: Partial<Record<MappingRole, string>>;
		analysing?: boolean;
		submitting?: boolean;
		signaturePartial?: boolean;
		/** State 3c only: the date the lost correspondance was memorised, already formatted. */
		signatureLostDate?: string | null;
		/**
		 * How long after the focus return the live region may speak. The plate's floor is 150 ms and
		 * the reason is ordering rather than pacing: the focus return is the direct answer to the
		 * gesture and must not be pre-empted by a summary. A prop only so a test can drive it.
		 */
		announceDelayMs?: number;
		/**
		 * Opens as the read-only RECAPITULATIF rather than as the control form.
		 *
		 * A MODE of this screen and deliberately not a second screen. Ruling A1 says the designation
		 * screen does not open for a recognised file, and its accepted cost is that the user never
		 * re-sees what was memorised: a correspondance that is ninety percent right then repeats
		 * unattended forever. This is the path that corrects it, so it has to show the same four
		 * roles resolved the same way. A separate screen would drift from this one by exactly the
		 * detail that matters, and nothing would go red.
		 */
		readOnly?: boolean;
		/**
		 * The 1280 layout: a 400 px command column beside the room the preview table will occupy.
		 *
		 * ONE control surface, two chromes. Everything that decides anything is shared through snippets,
		 * so the rows, the states, the picker, the announcements and the memorisation cannot differ by
		 * breakpoint. What changes is the card's radius (8 rather than 24, referential rule 5), the row
		 * height (56 rather than 68) and where the banner and actions live.
		 *
		 * A prop rather than a media query, for the same reason `RoleRow` takes `compact`: both heights
		 * are asserted absolutely, and a breakpoint-driven layout cannot be measured without also
		 * driving the viewport, which turns every figure into a fact about the test runner.
		 */
		wide?: boolean;
		onCancel?: () => void;
		onSubmit?: (result: { assignment: RoleAssignment; remember: boolean }) => void;
	} = $props();

	// Capturing only the INITIAL value is the whole point, so the warning is suppressed rather than
	// worked around: `initialAssignment` is what detection worked out on arrival, and this screen
	// owns the assignment from that moment. A reactive read would make the user's designations
	// disappear whenever the parent re-derived its detection result.
	// svelte-ignore state_referenced_locally
	let assignment = $state<RoleAssignment>({ ...initialAssignment });
	/** Transient, and deliberately not stored: it describes the last gesture, not the file. */
	let vacated = $state<Partial<Record<MappingRole, MappingRole>>>({});
	let openRole = $state<MappingRole | null>(null);
	let remember = $state(true);
	// Same reasoning: the user can flip "the first line is data" from inside any picker, and that
	// answer must outlive the parent's own guess about the file.
	// svelte-ignore state_referenced_locally
	let hasHeaderRow = $state(file.hasHeaderRow);
	// svelte-ignore state_referenced_locally
	let recap = $state(readOnly);
	let announcement = $state('');
	let announceTimer: ReturnType<typeof setTimeout> | null = null;

	const effectiveFile = $derived({ ...file, hasHeaderRow });
	const columnCount = $derived(file.headers.length);
	const candidateCounts = $derived(
		Object.fromEntries(
			Object.entries(candidates).map(([role, list]) => [role, list?.length ?? 0])
		) as Partial<Record<MappingRole, number>>
	);
	const pageState = $derived(
		pageStateOf({ assignment, columnCount, analysing, submitting, signaturePartial })
	);
	const banner = $derived(
		bannerFor({
			state: pageState,
			assignment,
			columnCount,
			candidateCounts,
			lostCount: Object.keys(lostHeaders).length
		})
	);
	const importable = $derived(canImport(assignment, columnCount) && !analysing && !submitting);

	/**
	 * The announcement order is NORMATIVE, and this is the whole of it.
	 *
	 *   1. The sheet closes.
	 *   2. Focus returns to the row, whose accessible name is ALREADY up to date, because the
	 *      assignment is written before the sheet is told to close and Svelte flushes both in the
	 *      same task. That is what makes the focus return the direct answer to the gesture.
	 *   3. Only then, in a LATER task and not before `announceDelayMs`, the live region speaks.
	 *
	 * **Focus return wins.** A live region that fires in the same task pre-empts the row's own name,
	 * and the reader loses the answer to what they just did in favour of a summary.
	 *
	 * **A displacement is ONE update carrying both facts, never two.** A screen reader receiving two
	 * successive polite updates drops one, and the one it drops is the second: the unintended
	 * consequence, which is the half the user did not ask for and most needs to hear.
	 */
	function announceLater(sentence: string) {
		if (announceTimer) clearTimeout(announceTimer);
		announceTimer = setTimeout(() => {
			announcement = sentence;
			announceTimer = null;
		}, announceDelayMs);
	}

	function choose(columnIndex: number) {
		const role = openRole;
		if (role === null) return;

		// Choosing the already-designated card closes and changes nothing. Not an error, an
		// abandonment, so nothing is announced: a "3 sur 3" here would imply a change.
		if (assignment[role] === columnIndex) {
			openRole = null;
			return;
		}

		const moved = designate(assignment, role, columnIndex);
		assignment = moved.assignment;
		vacated = moved.vacated ? { [moved.vacated]: role } : {};
		openRole = null;

		const next = bannerFor({
			state: pageStateOf({ assignment, columnCount, signaturePartial }),
			assignment,
			columnCount,
			candidateCounts,
			lostCount: Object.keys(lostHeaders).length
		});

		announceLater(
			moved.vacated
				? m.import_columns_announce_moved({
						role: roleLabel(role),
						header: effectiveFile.headers[columnIndex] ?? '',
						vacated: roleLabel(moved.vacated),
						count: next.count
					})
				: m.import_columns_announce_designated({
						count: next.count,
						consequence: next.consequence
					})
		);
	}

	function closeWithoutChoosing() {
		// The live region says NOTHING. Only the focus return speaks, announcing the unchanged row.
		// Announcing a count after a no-op close would imply a change that did not happen.
		openRole = null;
	}

	/**
	 * The row's state, resolved in ONE place so the visible line and the accessible name cannot
	 * disagree: `RoleRow` derives both from this single value.
	 *
	 * Order matters and is the state table's own. A vacated row is vacated even though its column is
	 * null, and a row whose remembered column vanished is reported as such rather than as merely
	 * empty. Falling through to `empty` in either case makes the row look self-emptied, and the user
	 * is never told a designation moved.
	 */
	function stateOf(
		role: MappingRole
	): 'empty' | 'ambiguous' | 'designated' | 'vacated' | 'missingColumn' | 'skeleton' | 'recap' {
		if (recap) return 'recap';
		if (analysing) return 'skeleton';
		if (lostHeaders[role]) return 'missingColumn';
		if (vacated[role]) return 'vacated';
		if (assignment[role] !== null) return 'designated';
		if ((candidateCounts[role] ?? 0) >= 2) return 'ambiguous';
		return 'empty';
	}

	function headerOf(role: MappingRole): string | null {
		const index = assignment[role];
		if (index === null) return null;
		// Null when the first line is data: the row then names the column by position, which is what
		// `RoleRow` falls back to. Reading the header here anyway would print a transaction's own
		// first value as if it were a column name.
		return hasHeaderRow ? (file.headers[index] ?? null) : null;
	}

	function sampleOf(role: MappingRole): string {
		const index = assignment[role];
		if (index === null) return '';
		// The FIRST data row, for every role, and that is load bearing rather than convenient: it is
		// why there is no rows-preview at 390. The four example values read vertically ARE one
		// transaction, which is the only line-level verification the screen offers. Sourcing them
		// from different rows per role would destroy it silently.
		return file.samples[index]?.[0] ?? '';
	}

	const CONSEQUENCE_ID = 'column-designation-consequence';
</script>

<!--
	Two layouts, ONE control surface. Everything below `#snippet` is shared verbatim between them,
	so the rows, the states, the picker, the announcements and the memorisation cannot differ by
	breakpoint. Only the CHROME differs: 390 stacks four fixed regions, 1280 puts the same card in a
	400 px command column beside the room a preview table will occupy.

	A prop rather than a media query, for the same reason `RoleRow` takes `compact`: both heights are
	asserted absolutely, and a breakpoint-driven layout cannot be measured without also driving the
	viewport, which makes every figure a fact about the runner.
-->
{#snippet fileBlock()}
	<div class="shrink-0" data-testid="designation-file-block">
		<p class="h-[22px] truncate text-[15px] leading-[22px] font-semibold">{file.name}</p>
		<p class="h-[18px] truncate text-[12.5px] leading-[18px] text-zinc-500">
			{m.import_columns_file_meta({
				columns: columnCount,
				rows: file.rowCount,
				headers: file.hasHeaderRow
					? m.import_columns_headers_detected()
					: m.import_columns_headers_absent()
			})}
		</p>
		{#if signatureLostDate}
			<!-- State 3c's third line. No tint: the bank changed its export format, which is not
			     an act of the user. -->
			<p class="h-[20px] truncate text-[12.5px] leading-[20px] text-zinc-500">
				{m.import_columns_signature_lost({ date: signatureLostDate })}
			</p>
		{/if}
	</div>
{/snippet}

{#snippet designationCard()}
	<!--
		355 at 390: 16 label + 10 gap + 3x68 rows + 2 hairlines + 12 + 1 separator + 12 + 68, plus 28
		padding and 2 border.
		307 at 1280: the same stack with 56 px rows. Only the row height and the radius change, which
		is what "same control surface" has to mean if it means anything.

		Radius 24 on a mobile page card and 8 on a desktop one, from the referential's rule 5. No
		shadow at either width.
	-->
	<div
		class="shrink-0 border border-zinc-200 bg-white p-[14px] {wide ? 'rounded-lg' : 'rounded-3xl'}"
		data-testid="designation-card"
	>
		<p
			class="h-4 text-[11px] leading-4 font-bold tracking-[0.03em] text-zinc-500 uppercase"
			id="designation-card-label"
		>
			{m.import_columns_section_label()}
		</p>
		<div class="mt-2.5">
			{#each MAPPING_ROLES as role, position (role)}
				{#if role === 'category' && !recap}
					<!-- A STRONGER separator than the hairlines above it, with 12 px either side. It
					     is what marks the optional role as a different kind of thing, and it is why
					     the three required rows need no asterisk. Not drawn in the recap: nothing
					     there is being asked for, so there is no required/optional to mark. -->
					<div class="my-3 h-px bg-zinc-200" aria-hidden="true"></div>
				{:else if position > 0}
					<div class="h-px bg-zinc-100" aria-hidden="true"></div>
				{/if}
				<!--
					`relative`, so the 1280 picker can anchor UNDER THE ROW THAT OPENED IT. At 390 the
					wrapper costs nothing and the sheet is rendered at screen level instead.
				-->
				<div class="relative">
					<RoleRow
						{role}
						state={stateOf(role)}
						optional={role === 'category'}
						compact={wide}
						expanded={openRole === role}
						columnHeader={headerOf(role)}
						columnIndex={assignment[role] ?? undefined}
						sampleValue={sampleOf(role)}
						candidateCount={candidateCounts[role]}
						vacatedBy={vacated[role]}
						lostHeader={lostHeaders[role]}
						onOpen={() => (openRole = role)}
					/>
					{#if wide && openRole === role}
						<ColumnPicker
							open
							variant="anchored"
							{role}
							file={effectiveFile}
							{assignment}
							candidates={candidates[role] ?? []}
							onChoose={choose}
							onClose={closeWithoutChoosing}
							onToggleHeaderRow={() => (hasHeaderRow = !hasHeaderRow)}
						/>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/snippet}

{#snippet formatRow()}
	<!--
		RESERVED SLOT, deliberately empty today. The date format, the decimal separator and the
		delimiter each belong to a role or to the file and are designed but out of scope; there
		are 125 px of air below this row at 390, so all three can arrive without the page beginning
		to scroll and without any figure in this file being recomputed.
	-->
	<div
		class="flex h-12 shrink-0 items-center text-[13px] text-zinc-400"
		data-testid="designation-format-row"
	>
		{m.import_columns_file_format_row()}
	</div>
{/snippet}

{#snippet trailingBlock()}
	{#if recap}
		<!--
			ONE action. Returning the four rows to their control form is what proves the recap is a
			MODE of this screen rather than a second screen: the same rows, resolved the same way,
			drawn differently.
		-->
		<div class="flex h-12 shrink-0 items-center" data-testid="designation-modify">
			<TapLink onclick={() => (recap = false)}>{m.import_columns_modify()}</TapLink>
		</div>
	{:else if pageState === 'complete' || pageState === 'submitting'}
		<!--
			86 px: two lines of sentence at 17, then a 48 px TapLink. With its 14 px gap that is
			the 100 px state 2 adds, taking the body to 611 of 636 and still not scrolling.

			Memorisation is ON by default and stated in ONE sentence with an opt-out link. There
			is deliberately NO toggle: the referential has none, and a switch would present a
			default as a decision the user has to take before they can leave.
		-->
		<div class="shrink-0" data-testid="designation-remember">
			<p class="h-[34px] text-[12.5px] leading-[17px] text-zinc-500">
				{remember
					? m.import_columns_remember_sentence()
					: m.import_columns_remember_opt_in_explanation()}
			</p>
			<div class="mt-1 flex h-12 items-center">
				<TapLink onclick={() => (remember = !remember)}>
					{remember ? m.import_columns_remember_opt_out() : m.import_columns_remember_opt_in()}
				</TapLink>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet bannerBlock()}
	{#if !recap}
		<ConditionBanner
			label={banner.label}
			count={banner.count}
			consequence={banner.consequence}
			consequenceId={CONSEQUENCE_ID}
			complete={banner.complete}
		/>
	{/if}
{/snippet}

{#snippet actions()}
	<button
		type="button"
		class="h-12 flex-1 rounded-[14px] border border-zinc-200 bg-white text-[15px] font-semibold text-zinc-700"
		onclick={onCancel}
	>
		{pageState === 'tooFewColumns' ? m.import_columns_other_file() : m.import_columns_cancel()}
	</button>
	{#if !recap}
		<!--
			`aria-disabled`, NEVER the `disabled` attribute, and `aria-describedby` pointing at the
			banner's second line. One reason location per disabled control: the cause is a count, the
			count is in the banner, so the explanation lives beside the count and never in a line
			under this button. A natively disabled button is unreachable by keyboard and therefore
			mute about its own reason.
		-->
		<button
			type="button"
			class="h-12 flex-[1.4] rounded-[14px] text-[15px] font-semibold {importable
				? 'bg-zinc-900 text-white'
				: 'bg-zinc-200 text-zinc-400'}"
			aria-disabled={importable ? undefined : 'true'}
			aria-describedby={importable ? undefined : CONSEQUENCE_ID}
			aria-busy={submitting ? 'true' : undefined}
			onclick={() => importable && onSubmit?.({ assignment, remember })}
		>
			{#if submitting}
				{m.import_columns_submitting()}
			{:else if importable}
				{m.import_columns_submit({ rows: file.rowCount })}
			{:else}
				{m.import_columns_submit_blocked()}
			{/if}
		</button>
	{/if}
{/snippet}

{#if wide}
	<!--
		1280x800. The frame's OWN width is asserted by the spec, absolutely, because the plate records
		a desktop frame capped to its window rendering 802 px while the document claimed six visible
		columns against 2.2 actually visible. A compressed desktop frame must never pass silently
		again, and the only assertion that can see it is one on the frame itself.

		1230 of content = 1280 - 2 (frame border) - 2x24 (padding). Those figures INCLUDE every
		border; do not round them up.
	-->
	<div
		class="h-full w-full overflow-y-auto border border-zinc-200 bg-white px-6 text-zinc-900"
		data-testid="designation-frame"
	>
		<div class="mx-auto w-full" data-testid="designation-content">
			<div class="pt-6 pb-4">
				<h1 class="text-[22px] leading-7 font-bold">{m.import_columns_page_title()}</h1>
				<p class="mt-1 truncate text-[13px] text-zinc-500">
					{file.name} ·
					{m.import_columns_file_meta({
						columns: columnCount,
						rows: file.rowCount,
						headers: file.hasHeaderRow
							? m.import_columns_headers_detected()
							: m.import_columns_headers_absent()
					})}
				</p>
			</div>

			<div class="flex items-start gap-6 pb-8">
				<!--
					The command column. 400 wide, and it is AUTHORITATIVE rather than a convenience:
					it alone shows all four roles at once, and therefore it alone shows what is
					missing. The preview beside it is a shortcut, which is why this chantier can ship
					without the preview at all.
				-->
				<div class="flex w-[400px] shrink-0 flex-col gap-4" data-testid="designation-command">
					{@render designationCard()}
					{@render formatRow()}
					{@render trailingBlock()}

					<!--
						The banner and the actions are ONE box and the box is what sticks, never the
						page. The Repartition plate's amendment, same argument: what COMMANDS the
						primary action travels with it, so the count explaining why the primary is off
						can never be scrolled away from the primary it explains.
					-->
					<div
						class="sticky bottom-6 overflow-hidden rounded-lg border border-zinc-200 bg-white"
						data-testid="designation-command-foot"
					>
						{@render bannerBlock()}
						<div class="flex items-stretch gap-3 p-4">
							{@render actions()}
						</div>
					</div>
				</div>

				<!--
					LACUNE B, deliberately empty. The `Apercu du fichier` table is not built here and
					that is a scope decision rather than an omission: the referential contains no table
					at all while three screens already ship one, so building it here would define the
					component from its RAREST case. Filed as this screen's first consumer.

					The desktop is therefore ruling D2 widened: the values are read in the picker
					cards, exactly as at 390.
				-->
				<div class="min-w-0 flex-1" data-testid="designation-preview-slot"></div>
			</div>
		</div>
	</div>
{:else}
	<!--
		`grid-rows-[auto_minmax(0,1fr)_auto_auto]`. See the docstring: the two alternatives that look
		equivalent, `position: sticky; bottom: 0` and a bare `1fr`, each fail in a way no offset fixes.
	-->
	<div
		class="grid h-full w-full grid-rows-[auto_minmax(0,1fr)_auto_auto] bg-white text-zinc-900"
		data-testid="designation-screen"
	>
		<header class="flex h-14 items-center gap-1 pr-4 pl-1" data-testid="designation-header">
			<IconButton label={m.import_columns_back()} onclick={onCancel}>
				<svg viewBox="0 0 20 20" class="h-5 w-5" fill="none" aria-hidden="true">
					<path
						d="M12 4l-6 6 6 6"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</IconButton>
			<h1 class="text-[16px] font-bold">{m.import_columns_page_title()}</h1>
		</header>

		<!-- The ONLY scrolling region, and in practice it never does: 511 of 636 in every state. -->
		<div
			class="flex flex-col gap-[14px] overflow-y-auto px-5 pt-4 pb-6"
			data-testid="designation-body"
		>
			<!--
				`shrink-0` on all three body children, and it is not decoration. A flex column shrinks
				its items before it scrolls, so without this an overfull body SQUASHES the 355 px card
				instead of scrolling, and the card's fixed height quietly stops being fixed. Found by
				the overflow calibration in this component's spec.
			-->
			{@render fileBlock()}
			{@render designationCard()}
			{@render formatRow()}
			{@render trailingBlock()}
		</div>

		{#if recap}
			<!--
				No condition banner and no primary in the recap. There is no condition: nothing is being
				satisfied and nothing is blocked, so a banner would report the state of a question
				nobody is being asked.
			-->
			<div></div>
		{:else}
			{@render bannerBlock()}
		{/if}

		<!-- 88 = 12 top padding + 48 controls + 28 home indicator area. -->
		<footer class="flex items-stretch gap-3 px-5 pt-3 pb-7" data-testid="designation-footer">
			{@render actions()}
		</footer>
	</div>
{/if}

{#if openRole && !wide}
	<!-- 390 only: at 1280 the picker is anchored to its row, inside the card, a few lines up. -->
	<ColumnPicker
		open
		role={openRole}
		file={effectiveFile}
		{assignment}
		candidates={candidates[openRole as MappingRole] ?? []}
		onChoose={choose}
		onClose={closeWithoutChoosing}
		onToggleHeaderRow={() => (hasHeaderRow = !hasHeaderRow)}
	/>
{/if}

<!--
	ONE announcement per user GESTURE, never one per internal state change. `role="status"` and not
	`alert`: designating a column is a form state in progress, not an incident.

	It announces nothing on open, nothing on a close without a choice, and nothing about the ignored
	column count outside state 2's own sentence.
-->
<div class="sr-only" role="status" aria-live="polite" data-testid="designation-live">
	{announcement}
</div>
