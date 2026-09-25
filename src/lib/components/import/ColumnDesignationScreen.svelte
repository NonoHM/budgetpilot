<script lang="ts">
	import type { Snippet } from 'svelte';
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
	// A DOMAIN module, so this is an ordinary value import: the two readings, the default and the
	// precedence over `ColumnDateState` live there precisely so this component does not hold its own
	// copy of them. `dateReadingAgreement.spec.ts` compares that ladder against the parser's over
	// every state and every answer; a copy here would be outside what that gate inspects.
	import { readingForState, type DateOrder } from '$lib/domain/dateReading';
	import { bannerFor, fileMetaLine, submitLabel } from '$lib/domain/columnDesignationBanner';
	import { roleLabel } from '$lib/domain/columnMappingLabels';
	import { readWithHeaderRow } from '$lib/domain/headerRowReading';
	import FilePreviewTable from './FilePreviewTable.svelte';
	import ConditionBanner from '$lib/components/ui/ConditionBanner.svelte';
	import RoleRow from '$lib/components/ui/RoleRow.svelte';
	import { formatReadingDate } from '$lib/domain/dateFormat';
	import { getLocale } from '$lib/paraglide/runtime';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	// The recap's one action. Brique 4's affordance clause is why it is not a TapLink there; see the
	// note at the call site.
	import Button from '$lib/components/Button.svelte';
	import ColumnPicker from './ColumnPicker.svelte';
	import AccountRow from './AccountRow.svelte';
	import AccountPicker, { type AccountPickerOption } from './AccountPicker.svelte';
	import CreateAccountSheet from './CreateAccountSheet.svelte';
	import CheckboxField from '$lib/components/ui/CheckboxField.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

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
	 * On a correction, Planche 5c's consent storey sits between the body and the banner and is paid
	 * out of the body: 60 px, or 96 with its cost note, so the body is 576 or 540. See below.
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
	 * ## The body's 549 of 636, and the one path where it stops fitting
	 *
	 *     16   padding-top
	 *     40   file block      (60 in state 3c, which adds a third line)
	 *     14   gap
	 *     68   account row     (#480; 68 in its error state too)
	 *     14   gap
	 *    373   designation card
	 *     24   padding-bottom
	 *    ---
	 *    549 in states 0 and 1, leaving 87 px of air. State 2 adds the 48 px memorisation link and
	 *    its 14 px gap: 611, leaving 25.
	 *
	 * The card ends at 525 of 636 (16 + 40 + 14 + 68 + 14 + 373). All three figures are asserted in
	 * `ColumnDesignationScreen.svelte.spec.ts`; `npx vitest run` on that file re-derives them.
	 *
	 * **THE BODY SCROLLS ON A CORRECTION**, which Planche 7c says it never does. 5c's storey leaves
	 * 576 px for state 2's 611, 35 over, or 540 with the cost note, 71 over. Asserted in the same
	 * spec's 5c block. Measured on the running app by #684's M9 first, and the spec reads the same
	 * figures. 7c's own budget (511 → 529, 611 → 629) still counts the « Format du fichier » row and
	 * has no line for the account row; the correction lives in `docs/reference/design-referential.md`
	 * « Plate figures that do not reconcile ».
	 *
	 * **Was 511** before #384, with a 48 px « Format du fichier » row and its 14 px gap. That row was a grey
	 * heading with nothing under it, at both widths, in every state, since the screen shipped: a
	 * visible empty affordance is a promise, and it had been making one for months. Deleted rather
	 * than kept warm. The date format, the decimal separator and the delimiter are still designed and
	 * still out of scope; when one is built it arrives with its own layout rather than inheriting a
	 * slot sized for nothing.
	 *
	 * The 62 px it freed were meant for the correction checkbox at 390. The account row (#480) spent
	 * them first, 82 px of them, and the checkbox went into its own storey outside the body, which is
	 * why a correction scrolls. Where it should sit is the design's question, not this file's.
	 *
	 * ## No text input anywhere
	 *
	 * Consequence rather than coincidence: the virtual keyboard never opens, so the visual-viewport
	 * case that governs every other form screen in this product does not arise: the body's height
	 * moves only with 5c's consent storey, never with a keyboard. The single exception is the search
	 * field above 20 columns, which lives in the picker and not here.
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
		submitting = false,
		signaturePartial = false,
		signatureLostDate = null,
		announceDelayMs = 150,
		readOnly = false,
		modifyAsksForFile = false,
		recapCaption,
		replaces,
		wide = false,
		accounts = [],
		initialAccountId = null,
		initialDateOrder = null,
		accountHint = null,
		accountHintAboutFile = false,
		accountPrefill = '',
		declaredCurrency = null,
		onCreateAccount,
		onCancel,
		onModify,
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
		 * A READING ALREADY ANSWERED, handed back so this screen does not ask again.
		 *
		 * `null` means nobody has answered, which is NOT day-first: the row says so with
		 * « Confirmer » and the sheet's second step is reachable. See `chosenReading`.
		 *
		 * It exists for the duplicate-statement dialog's DECLINE leg, which reopens this screen and
		 * already carries `hasHeaderRow` the same way, for the same reason: re-deriving the answer on
		 * the way back would replace the user's with the application's on the one screen built to
		 * stop that. WCAG 2.2 3.3.7 Redundant Entry.
		 *
		 * Captured once, like `initialAssignment`: this screen owns the answer from arrival.
		 */
		initialDateOrder?: DateOrder | null;
		/**
		 * Per role, the column indices detection proposes. Two or more is what makes a row ambiguous.
		 *
		 * Detection DOES NOT PICK BETWEEN EQUALS: it shortens the path when a column is unambiguous
		 * and stays out of the way when it is not. A rule, never a confidence score.
		 */
		candidates?: Partial<Record<MappingRole, readonly number[]>>;
		/** State 3b: per role, the remembered header that is gone from this file. */
		lostHeaders?: Partial<Record<MappingRole, string>>;
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
		 * Whether « Modifier les colonnes » will ask for the statement again, said BEFORE the press.
		 *
		 * Question 5 of the design project's own issue list, and the answer is that the order cannot
		 * change: the picker chooses a column on its VALUES, and a stored correspondance holds four
		 * column names out of N with no values at all. So the file has to come back before anything
		 * can be chosen, and the only thing left to repair is the surprise. A surprise is repaired by
		 * naming the cost before the press, with its reason, since a cost with no reason reads as an
		 * apology.
		 *
		 * **A prop and not a consequence of `readOnly`, because the same recap has two callers.** The
		 * one opened from an upload still holds the file and flips the rows back to their controls in
		 * place; there the note would promise a re-ask that does not happen. Only the route that
		 * navigates away knows, so only the route says so.
		 */
		modifyAsksForFile?: boolean;
		/**
		 * Whatever the caller has to say ABOUT the correspondance, drawn under the card in recap mode.
		 *
		 * A snippet rather than a string, because the route's copy is two paragraphs today and one of
		 * them is parameterised by a date it formats itself. What the component owns is the PLACE, and
		 * the place is the only thing a route cannot get right from outside: below this component its
		 * paragraphs fall outside the frame at 1280 and behind the tab bar at 390.
		 *
		 * Recap only. The control form's equivalent region is the memorisation block, which is about
		 * a decision being taken rather than about an answer being read.
		 */
		recapCaption?: Snippet;
		/**
		 * The import this correction would REPLACE, named by the one attribute two candidates do not
		 * share.
		 *
		 * Absent on an ordinary import, and absent on a correction whose batch did not resolve. Then
		 * no consent is rendered at all: with nothing to replace there is nothing to choose, and a
		 * ticked box promising a deletion that cannot happen is the defect this wave exists to remove.
		 *
		 * `namedAt` arrives ALREADY FORMATTED, from the route that knows the negotiated locale, and it
		 * is the same string the delete confirmation and the withheld retraction use. The user has to
		 * match the name on the control they ticked against the name in whatever the run reports
		 * afterwards; two formats would make that a puzzle on the one screen whose job is to say which
		 * import was destroyed.
		 *
		 * `replacedRows` is the OLD import's count and the primary's own count is the NEW file's.
		 * They are different numbers and the confirmation names both, which is what a confirmation for
		 * a compound act owes its reader.
		 */
		replaces?: { batchId: string; namedAt: string; replacedRows: number; hasUserWork: boolean };
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
		/**
		 * What « Modifier les colonnes » does, when flipping back to the control form is not it.
		 *
		 * The recap opened by an UPLOAD has the file, so returning the rows to their 68 px controls
		 * is the whole of the modification. The recap opened from `/imports` months later does not:
		 * the file lived in the browser for the length of one import (owner ruling 2) and nothing
		 * kept it. There the rows would be a control form over a file that no longer exists, so the
		 * route asks for the file back instead and the screen reopens with the same designations.
		 *
		 * Default preserved, so the upload path and the three specs written against it are unchanged.
		 */
		onModify?: () => void;
		/**
		 * `hasHeaderRow` is part of the RESULT, not only of the props.
		 *
		 * It used to be absent, and the answer to « la première ligne contient des données » could
		 * therefore not leave this component: the parent went on posting the detection it had
		 * guessed on arrival. A four-line headerless file then imported three rows, ate the first
		 * transaction without a word, and stored a mapping whose column names were that row's own
		 * values — a fingerprint no later file can match. See `header-row-toggle.svelte.spec.ts`.
		 */
		/**
		 * The accounts this statement could belong to: the user's own, never archived, never manual.
		 * Empty is a real state rather than missing data, and the panel then offers only « Nouveau
		 * compte ».
		 */
		accounts?: readonly AccountPickerOption[];
		/**
		 * The currency the file declared, after the `/import/columns` currency refusal (#600): the
		 * account panel then says each account's currency and mutes the others, the same rule as on
		 * `/import`. Null everywhere else.
		 */
		declaredCurrency?: string | null;
		/**
		 * What resolution already worked out, if anything. The user can always change it.
		 *
		 * `initial`, like `initialAssignment` beside it and for the same reason: the screen owns the
		 * choice from arrival, so a reactive read would throw the user's chosen account away every
		 * time the parent re-derived its resolution.
		 */
		initialAccountId?: string | null;
		/**
		 * The provenance line, already composed by the caller: which rank answered and from what.
		 * A sentence rather than a state, because the screen renders it and does not reason about it.
		 */
		accountHint?: string | null;
		/**
		 * Whether `accountHint` is a fact about the FILE rather than a provenance for the answer.
		 *
		 * Decided by `accountAnswerFor`, never here: this component sees an opaque sentence and
		 * classifying it a second time is the copied predicate. Exactly one sentence sets it today,
		 * « ce fichier contient plusieurs comptes », and that one has to outlive a choice.
		 */
		accountHintAboutFile?: boolean;
		/**
		 * The name the create sheet opens with, composed by the server from what the FILE said.
		 * Empty when it said nothing, which is a state rather than missing data: see the sheet.
		 */
		accountPrefill?: string;
		/**
		 * Creates an account and answers with the option to add, or with a sentence to show.
		 *
		 * A PROMISE handed down rather than a request made here, for the reason every other decision
		 * on this screen is taken elsewhere: this component has no route, no session and no file. The
		 * three states of 6g are owned here because they are states of a screen; the request that
		 * moves between them is owned by the page.
		 *
		 * Absent means the footer action does nothing but close the panel, which is what shipped in
		 * Task 6 and is a screen a user cannot finish an import on. Named here because a prop no
		 * route sets is a draft, not a feature: `/import/columns/+page.svelte` sets it.
		 */
		onCreateAccount?: (
			name: string
		) => Promise<
			| { ok: true; account: AccountPickerOption }
			| { ok: false; error: string; field?: string | null }
		>;
		onSubmit?: (result: {
			assignment: RoleAssignment;
			/** The account the user chose. Never null by the time the primary submits. */
			accountId: string;
			remember: boolean;
			hasHeaderRow: boolean;
			/**
			 * THE READING THE USER ANSWERED, or `null` when the question was never put to them.
			 *
			 * The ANSWER, never the applied reading. `decideDateOrder` on the server consults an
			 * override only where the column leaves the question genuinely open, so posting the
			 * applied reading would send `day-first` for every proven column and every ISO file,
			 * recording a decision nobody took. Null and `day-first` are different payloads.
			 */
			dateOrder: DateOrder | null;
			/**
			 * Whether the run replaces the import it was launched from.
			 *
			 * Always present, and `false` when nothing is being replaced, so the caller never has to
			 * tell « the user said no » from « the screen never asked ». On a control that decides a
			 * DELETE those two must not be the same value.
			 */
			deleteOldImport: boolean;
		}) => void;
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
	/**
	 * Planche 5c, pre-ticked by owner ruling.
	 *
	 * « No default pre-arms an irreversible » holds when nothing else consents. Here the destructive
	 * confirmation below consents and names both facts, so the box does not pre-arm: it PROPOSES.
	 * Unticked it demanded a deliberate extra act to obtain exactly the repair the user came for, and
	 * forgetting it left behind the duplicate the previous wave removed from this journey.
	 */
	let deleteOldImport = $state(true);
	let confirmingReplace = $state(false);
	// Same reasoning: the user can flip "the first line is data" from inside any picker, and that
	// answer must outlive the parent's own guess about the file.
	// svelte-ignore state_referenced_locally
	// THE ONLY READ OF THE GUESS in this component, and from here on the state is the DECLARATION.
	let hasHeaderRow = $state(file.detectedHeaderRow);
	// svelte-ignore state_referenced_locally
	let recap = $state(readOnly);
	let announcement = $state('');
	let announceTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * The screen names itself after what it is currently DOING, not after the route that opened it.
	 *
	 * In the recap the four rows answer a question rather than asking one, so « Désigner les colonnes »
	 * is an instruction for work that is already done and cannot be done here. It follows `recap`
	 * rather than `readOnly` so the upload path's « Modifier les colonnes », which flips back to the
	 * control form, renames the screen with it.
	 */
	const heading = $derived(
		recap ? m.import_columns_recap_page_title() : m.import_columns_page_title()
	);

	/**
	 * The file AS THE USER HAS DECLARED IT, which is not the same object as the one detection sent.
	 *
	 * This used to be `{ ...file, hasHeaderRow }`, which carried the answer and none of its
	 * consequences: the picker relabelled its cards and the screen went on saying « 2 lignes »,
	 * previewing the header line as a heading, and promising « Importer 2 lignes » to a server that
	 * read three. Measured on the real journey. A count the primary repeats is a figure, and it was
	 * false.
	 */
	const effectiveFile = $derived(readWithHeaderRow(file, hasHeaderRow));
	const columnCount = $derived(file.headers.length);
	const candidateCounts = $derived(
		Object.fromEntries(
			Object.entries(candidates).map(([role, list]) => [role, list?.length ?? 0])
		) as Partial<Record<MappingRole, number>>
	);
	const pageState = $derived(
		pageStateOf({ assignment, columnCount, submitting, signaturePartial })
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
	const importable = $derived(canImport(assignment, columnCount) && !submitting);

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

	/**
	 * Whether picking THIS column for THIS role leaves the reading genuinely open.
	 *
	 * Read off the column PICKED rather than off `dateColumn`, which is derived from an `assignment`
	 * that `choose` reassigns a line earlier: reading the derived value there would race the
	 * recompute. That is the same reason the comment inside `choose` used to give for a gate it
	 * never actually applied.
	 *
	 * Both halves are required. `ambiguous` is the only state that asks anybody anything, and
	 * without readings for the column `ColumnPicker` falls back to step 1 anyway, so deferring the
	 * close would hold the sheet open on the question it cannot render.
	 */
	function defersToReading(role: MappingRole, columnIndex: number): boolean {
		return (
			role === 'date' &&
			(effectiveFile.dateStates?.[columnIndex] ?? null) === 'ambiguous' &&
			(effectiveFile.dateReadings?.[columnIndex] ?? null) !== undefined
		);
	}

	function choose(columnIndex: number) {
		const role = openRole;
		if (role === null) return;

		// Choosing the already-designated card closes and changes nothing. Not an error, an
		// abandonment, so nothing is announced: a "3 sur 3" here would imply a change.
		//
		// The deferred question is still OWED, though, and that is why this branch is not a plain
		// close. It is ALSO the only route back to the reading once it has been answered, and gating
		// it on the question being unanswered made the answer a one-way door: `openPicker` sends an
		// answered row to step 1, which is right because what that row then offers is the column, and
		// re-choosing the column closed. Between them there was no way to change a value that decides
		// how every date in the file is read. Found by walking the screen, not by a test.
		//
		// So: re-choosing the designated column re-asks, answered or not. Nothing is APPLIED on this
		// branch either way, which is §5.3 unchanged: the announcement still belongs to a change, and
		// re-choosing the same column is not one.
		if (assignment[role] === columnIndex) {
			if (defersToReading(role, columnIndex)) {
				pickerStep = 'reading';
				return;
			}
			openRole = null;
			pickerStep = 'columns';
			return;
		}

		const deferred = defersToReading(role, columnIndex);
		const moved = designate(assignment, role, columnIndex);
		assignment = moved.assignment;
		vacated = moved.vacated ? { [moved.vacated]: role } : {};

		// THE CLOSE IS DEFERRED BY EXACTLY ONE QUESTION, and only here. Plate 7b: choosing an
		// ambiguous date column APPLIES immediately, which is §5.3 unchanged, and then the same
		// surface asks how the column reads instead of closing. Every other choose still closes.
		if (deferred) {
			pickerStep = 'reading';
		} else {
			openRole = null;
			pickerStep = 'columns';
		}

		const next = bannerFor({
			state: pageStateOf({ assignment, columnCount, signaturePartial }),
			assignment,
			columnCount,
			candidateCounts,
			lostCount: Object.keys(lostHeaders).length
		});

		announceLater(
			// A DEFERRED QUESTION IS THE OUTCOME OF THIS GESTURE, so the sentence says so. The generic
			// designated sentence carries a consequence clause, and on this column it would read as if
			// the designation were finished when the screen is still asking. Plate 7i's own key.
			//
			// A displacement still wins, because it carries the fact the user did not ask for: a
			// vacated row is the half a reader most needs and the half a second polite update drops.
			deferred && !moved.vacated
				? m.import_designate_announce_date_assumed({
						header: effectiveFile.headers[columnIndex] ?? '',
						count: next.count
					})
				: moved.vacated
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

	/**
	 * THE ANSWER, applied and announced. Plate 7j: assumed becomes confirmed, which is a value
	 * change even when the reading chosen is the one already retained, so this always commits.
	 *
	 * The close is here rather than in `ColumnPicker` for the same reason step 1's is: the sheet
	 * never closes itself on a choose, so one caller owns both applications and there is no second
	 * path a close could take.
	 */
	function chooseReading(order: DateOrder) {
		const column = dateColumn;
		if (column === null) return;
		chosenReading = order;
		readingAnsweredFor = column;
		openRole = null;
		pickerStep = 'columns';

		// The FIRST DATA ROW under the reading just chosen, which is the cell the row's line 3 will
		// state. Index 0 of `dateReadings` is that row by that field's own contract.
		const iso = effectiveFile.dateReadings?.[column]?.[readingKey(order)]?.[0] ?? null;
		const pretty = iso ? formatReadingDate(iso, getLocale()) : null;
		// A cell that is not a date under the reading in force has no first line to name, and a
		// sentence reading « Première ligne : . » would be a false figure in the live region. The
		// shorter form states the reading and claims nothing about a row. An ambiguous column
		// guarantees an ambiguous CELL, never that it is the first one.
		announceLater(
			pretty
				? order === 'month-first'
					? m.import_datesheet_announce_month_first({ pretty })
					: m.import_datesheet_announce_day_first({ pretty })
				: order === 'month-first'
					? m.import_recap_date_reading_month_first()
					: m.import_recap_date_reading_day_first()
		);
	}

	function closeWithoutChoosing() {
		// The live region says NOTHING. Only the focus return speaks, announcing the unchanged row.
		// Announcing a count after a no-op close would imply a change that did not happen.
		openRole = null;
		// 7d: a session run twice must not remember the first run's body. A sheet reopened on step 2
		// because the previous session ended there would put the question in front of a user who
		// came back to change the column.
		pickerStep = 'columns';
	}

	/**
	 * Which body the sheet OPENS on, which is a second entry point rather than a second rule.
	 *
	 * Step 2 when the row's own line 3 carries the imperative: a designated ambiguous column whose
	 * reading no human has confirmed reads `01/02/2026 → 1 février 2026 · Confirmer`, and an
	 * imperative that opens a list of columns is a false affordance. Step 1 in every other state,
	 * including once the question is answered, because what that row then offers is the column.
	 *
	 * Once answered, step 1 stays one tap from step 2 through its foot TapLink, « Changer l'ordre des
	 * dates » (`canChangeOrder`, #683), which is what makes this safe rather than a trap. That
	 * sentence stood here before the link existed; the way back was then only re-choosing the same
	 * column, which re-asks (see `choose`).
	 */
	function openPicker(role: MappingRole) {
		pickerStep =
			role === 'date' && dateState === 'ambiguous' && !dateAnswered && dateReadingPairs
				? 'reading'
				: 'columns';
		openRole = role;
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
	/**
	 * THE READING THE USER CHOSE, when the file left the question open.
	 *
	 * Null means nobody has answered, which is NOT the same as day-first: the row says so with
	 * "Confirmer" and the sheet's second step is reachable. Reset whenever the designated column
	 * changes, because a reading is an answer about ONE column and carrying it to the next one
	 * would silently apply an answer given about different data.
	 */
	// svelte-ignore state_referenced_locally
	let chosenReading = $state<DateOrder | null>(initialDateOrder);
	// Seeded together with the answer, and from `initialAssignment` rather than from the derived
	// `dateColumn`: an answer handed back belongs to the column it was given about, which is the one
	// the screen is reopening on.
	// svelte-ignore state_referenced_locally
	let readingAnsweredFor = $state<number | null>(initialDateOrder ? initialAssignment.date : null);
	/**
	 * Which body the ONE picker surface is showing. See `ColumnPicker`'s `step` section, plate 7b.
	 *
	 * Owned here because the transition between the two bodies is a consequence of gestures this
	 * screen already owns: designating a column, and answering about it. `ColumnPicker` never
	 * advances it on its own, exactly as it never closes itself on a choose.
	 */
	let pickerStep = $state<'columns' | 'reading'>('columns');

	/** The order VALUE to the payload's key. One translation, used by both readers below. */
	function readingKey(order: DateOrder): 'dayFirst' | 'monthFirst' {
		return order === 'month-first' ? 'monthFirst' : 'dayFirst';
	}

	const dateColumn = $derived(assignment.date);
	const dateState = $derived(
		dateColumn === null ? null : (effectiveFile.dateStates?.[dateColumn] ?? null)
	);

	/**
	 * The order this screen is currently reading the date column under.
	 *
	 * ## THE LADDER IS NOT HERE, AND THAT IS THE FIX RATHER THAN A TIDY
	 *
	 * This used to restate `decideDateOrder`'s precedence inline, under a comment saying « stating
	 * it twice would be two answers, so this mirrors that order deliberately ». It was two answers:
	 * the server decides the import and this decides what the row STATES, and a row stating a date
	 * the import will not write is a false displayed figure and data written wrong that looks right,
	 * at once. Nothing stood between the two copies.
	 *
	 * `readingForState` is that ladder as a function, in `domain/`, and
	 * `dateReadingAgreement.spec.ts` compares it against the parser's over every `ColumnDateState`
	 * and every answer, driving both from the same cells. A ladder inside a component can be
	 * described; it cannot be compared.
	 *
	 * The answer is passed as `null` unless it was given about THIS column, which is what stops a
	 * reading chosen over one column's data being applied to another's.
	 */
	const appliedReading = $derived(
		readingForState(dateState, readingAnsweredFor === dateColumn ? chosenReading : null)
	);

	/**
	 * Line 3 of the Date row, or `null` to reserve its 18 px with nothing in it.
	 *
	 * `undefined` is never returned: the Date row ALWAYS interprets, so it is always 86 px, in every
	 * state including empty. That is what keeps the card's height fixed and the skeleton exact.
	 */
	const dateInterpretation = $derived.by(() => {
		if (recap || dateColumn === null || dateState === null) return null;
		if (dateState === 'inconsistent') return 'inconsistent' as const;
		if (dateState === 'no-dates') return 'no-dates' as const;
		if (dateState === 'empty') return 'empty' as const;

		// READ FROM `firstRow` DIRECTLY, and not through `sampleOf`, because the two halves of this
		// line must describe THE SAME CELL.
		//
		// `sampleOf` falls back to `samples[index][0]` when `firstRow` is absent, and `firstRow` is
		// optional on `DesignationFile`. The ISO below is always index 0 of `dateReadings`, which is
		// the FIRST DATA ROW's cell by that field's own contract. So on a payload carrying readings
		// and no first row, the old expression printed one cell's raw value beside another cell's
		// conversion: a line that reads perfectly and states a conversion the import never made.
		// Both production payloads set `firstRow`, so this was correct by coupling rather than by
		// construction, and nothing asserted the coupling.
		//
		// Reading the same source makes the pair true by construction, and a missing `firstRow` now
		// reserves the line instead of pairing two different cells.
		const raw = effectiveFile.firstRow?.[dateColumn] ?? '';
		// The payload keys the two readings as `dayFirst`/`monthFirst`; the order VALUE is
		// `day-first`/`month-first`. One translation, here, rather than a second spelling of the
		// order anywhere else.
		const iso = effectiveFile.dateReadings?.[dateColumn]?.[readingKey(appliedReading)]?.[0] ?? null;
		// A cell that is not a date under the order in force has no conversion to show. The row falls
		// back to reserving the line rather than printing the raw value twice.
		if (!raw || !iso) return null;
		// `null` for a column whose FORMAT settles the reading (ISO): `appliedReading` is the default
		// there only because `readingForState` is total, and the row must not name a day/month order
		// for a column that has none (#645). Every other reaching state has a real order.
		return {
			raw,
			pretty: formatReadingDate(iso, getLocale()),
			order: dateState === 'proven-shape' ? null : appliedReading
		};
	});

	/**
	 * Confirmed is the ABSENCE of an open question, not the presence of an answer.
	 *
	 * A proven column was never asked about, so its line carries no imperative. An ambiguous one
	 * carries "Confirmer" until a human has looked, which is 7a's rule that an assumption is never
	 * allowed to stand unread.
	 */
	const dateAnswered = $derived(readingAnsweredFor === dateColumn && chosenReading !== null);

	const dateInterpretationConfirmed = $derived(dateState !== 'ambiguous' || dateAnswered);

	/**
	 * THE VALUE THAT LEAVES THIS SCREEN, derived once so both submit paths cannot post different
	 * things.
	 *
	 * The ANSWER and never `appliedReading`. An answer belongs to the column it was given about, so
	 * it is null the moment the designation moves, and it is null for a proven column and for an ISO
	 * file because nobody was asked. `decideDateOrder` on the server consults an override only where
	 * the column is genuinely ambiguous, so posting `appliedReading` would record a decision no
	 * human took on every file that never raised the question.
	 */
	const answeredReading = $derived<DateOrder | null>(dateAnswered ? chosenReading : null);

	/**
	 * What the second step's two cards show, in the shape `ColumnPicker` declares.
	 *
	 * ## Parallel to `effectiveFile.samples[dateColumn]`, POSITION FOR POSITION, and that is the contract
	 *
	 * The picker prints the raw cell from `samples` and the converted date from here, side by side
	 * on one line, so a value dropped from one array and not the other would pair a raw cell with
	 * its NEIGHBOUR's conversion: a card that reads correctly and states a conversion the import
	 * never made. Nothing is therefore filtered out. A cell that is not a date under one order maps
	 * to the empty string, and the card is responsible for naming it « pas une date » (#705, one
	 * definition in `DateReadingCard`) rather than this being responsible for hiding it.
	 *
	 * Index 0 of `dateReadings` is the FIRST DATA ROW, which is what the Date row's line 3 prints
	 * and not what the cards print, so it is sliced off here. That the two surfaces show different
	 * cells is deliberate and is recorded on `DesignationFile.dateReadings`: the row shows one
	 * transaction read vertically, the cards show values chosen to discriminate.
	 *
	 * `null` when there is no designated column or no readings for it, which makes `ColumnPicker`
	 * fall back to step 1 rather than render an empty question.
	 */
	const dateReadingPairs = $derived.by(() => {
		if (dateColumn === null) return null;
		const readings = effectiveFile.dateReadings?.[dateColumn];
		if (!readings) return null;
		const prettyFor = (order: DateOrder) =>
			readings[readingKey(order)]
				.slice(1)
				.map((iso: string | null) => (iso ? formatReadingDate(iso, getLocale()) : ''));
		return {
			dayFirstPretty: prettyFor('day-first'),
			monthFirstPretty: prettyFor('month-first'),
			// What the sheet opens WITH: the order already in force, whether that is a locale
			// assumption nobody has confirmed or an answer given earlier this session. 7j: the card
			// showing it is marked retained, and re-choosing it is still a value change.
			retained: appliedReading
		};
	});

	/**
	 * Whether step 1 offers « Changer l'ordre des dates » (plate 7b, #683): a reading was ANSWERED
	 * about the designated column and the sheet has the evidence to ask again.
	 *
	 * **Not on a column that proves its order, and that departs from 7b's « proven or confirmed ».**
	 * An answer about a proven column is discarded twice, by `readingForState` here and by
	 * `decideDateOrder` on the server, because a proof outranks a statement (#613). A link offering
	 * to change it would take an answer and apply nothing, which is the control that appears to
	 * decide and does not (#619). Unanswered is excluded too, as 7b draws it: the row itself opens
	 * the question there.
	 */
	const canChangeOrder = $derived(
		dateState === 'ambiguous' && dateAnswered && dateReadingPairs !== null
	);

	function stateOf(
		role: MappingRole
	): 'empty' | 'ambiguous' | 'designated' | 'vacated' | 'missingColumn' | 'recap' {
		if (recap) return 'recap';
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
		// POSITIONAL, and handoff §3.2 is why: the four rows are one transaction read vertically,
		// which is the stated reason this screen carries no rows-preview at 390. `samples` is chosen
		// to discriminate and would put a Montant from row 9 beside a Date from row 1.
		return effectiveFile.firstRow?.[index] ?? effectiveFile.samples[index]?.[0] ?? '';
	}

	// The INITIAL value is the whole point, so the warning is suppressed rather than worked around,
	// exactly as `assignment` above does: this is what resolution worked out on arrival, and the
	// user owns it from that moment.
	// svelte-ignore state_referenced_locally
	let chosenAccountId = $state<string | null>(initialAccountId);
	let accountPanelOpen = $state(false);
	let accountPanelFocus = $state<'list' | 'footer'>('list');
	let accountErrorShown = $state(false);
	let accountRowWrapper = $state<HTMLElement | null>(null);

	/**
	 * Accounts created on this screen, in the order they were created.
	 *
	 * Held HERE and not pushed back up to the caller, because the caller's `accounts` prop is what
	 * the server answered when the file arrived and a re-derivation of it would throw these away.
	 * Appended rather than merged into the alphabetical order the server sent: a row the user has
	 * just created and is about to see selected is easier to find where they left it than where a
	 * sort would put it.
	 */
	let createdAccounts = $state<AccountPickerOption[]>([]);
	const shownAccounts = $derived<readonly AccountPickerOption[]>([...accounts, ...createdAccounts]);

	let createOpen = $state(false);
	/** 5f's contract, owned here because these are states of a screen. See `CreateAccountSheet`. */
	let createPhase = $state<'idle' | 'busy' | 'error'>('idle');
	let createError = $state<string | null>(null);
	/** Which surface the caller's refusal belongs on. The endpoint says; this only carries it. */
	let createErrorField = $state<string | null>(null);

	const chosenAccount = $derived(
		shownAccounts.find((account) => account.id === chosenAccountId) ?? null
	);

	/**
	 * `error` only AFTER the primary has been pressed, never before.
	 *
	 * A row that is red before anything was asked of it accuses the user of a mistake they have not
	 * had the chance to make. 6k puts the error at the press and nowhere earlier, which is the same
	 * rule the create sheet's emptied field follows.
	 */
	const accountState = $derived<'ok' | 'todo' | 'error'>(
		chosenAccount !== null ? 'ok' : accountErrorShown ? 'error' : 'todo'
	);

	/**
	 * The error sentence REPLACES the provenance line rather than stacking under it.
	 *
	 * Two lines of help under one row is the shape that pushes the columns card off the screen, and
	 * the provenance is a fact about a choice that has not been made: it has nothing left to explain
	 * at the moment the user is being told to make one.
	 */
	const accountHintShown = $derived.by(() => {
		if (accountState === 'error') return m.import_account_error_required();
		/**
		 * THE HINT DESCRIBES THE ANSWER THE SERVER PROPOSED, so it survives only while that is still
		 * the answer on the row.
		 *
		 * `accountHint` is computed on the server when the page loads, and almost every sentence it
		 * can carry is a PROVENANCE: the file said so, we remembered, we have never seen this shape,
		 * you have no accounts. The moment the user overrides that answer, by choosing a different
		 * account or by creating one, the sentence describes a resolution that no longer holds. One
		 * of them becomes outright false: the row names an account while the line under it says
		 * there are none.
		 *
		 * **ALMOST every sentence, and the exception is load bearing.** « Ce fichier contient
		 * plusieurs comptes » is a fact about the BYTES, true whatever the user picks, and it is the
		 * only notice on this screen that the file mixes accounts. Dropping it at the moment the
		 * user commits every row of that file to ONE account is the worst timing available. The
		 * first version of this guard did exactly that, and the comment above it claimed the general
		 * rule while the enumeration underneath it did not hold. `aboutTheFile` is that
		 * enumeration, made once, where the sentence is chosen.
		 *
		 * `chosenAccountId !== initialAccountId` is the whole test, and it reads as « the user
		 * changed the answer » because `chosenAccountId` starts AS `initialAccountId`. It covers a
		 * created account for free, since a created id is never the one the resolution named.
		 *
		 * BOTH HALVES WERE FOUND BY LOOKING AT THE SCREEN rather than by any assertion here, and the
		 * second was found in the images shipped by the fix for the first: that fix argued this
		 * general rule and implemented the created case alone. Every state here puts the same NAME on
		 * the row, so only the description separates them.
		 */
		if (chosenAccountId !== initialAccountId && !accountHintAboutFile) return undefined;
		return accountHint ?? undefined;
	});

	/**
	 * Reveals the error, brings the row back into view and puts the focus on it.
	 *
	 * The plate's transverse rule, which this plate applies and does not impose: « le primaire n'est
	 * jamais désactivé pour cause d'invalidité ; l'appui révèle l'erreur, remonte le champ en vue et
	 * y pose le focus ». A greyed primary explains nothing and cannot be asked why.
	 *
	 * The focus goes to the ROW and not to the alert, because the row is the thing to act on. It is
	 * reached through the wrapper rather than through a ref on the component: the row is one
	 * `<button>` and the wrapper holds exactly one, so there is nothing to disambiguate, and adding
	 * an imperative focus method to a presentational component to save this line would be the
	 * larger change.
	 */
	function revealAccountError() {
		accountErrorShown = true;
		const trigger = accountRowWrapper?.querySelector('button');
		trigger?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		trigger?.focus();
	}

	function chooseAccount(id: string) {
		chosenAccountId = id;
		accountPanelOpen = false;
		// The error cannot outlive the thing it was about.
		accountErrorShown = false;
	}

	/** The row, reached through its wrapper. One button lives there, so there is nothing to pick. */
	function focusAccountRow() {
		accountRowWrapper?.querySelector('button')?.focus();
	}

	/**
	 * Closes the panel WITHOUT choosing, and puts focus back where it came from.
	 *
	 * MEASURED 2026-08-24, and it was a real defect rather than a precaution: Escape closed the
	 * panel and left `document.activeElement` on `<body>`. Focus had entered the panel on the
	 * listbox, the listbox was then removed from the document, and a removed element's focus goes
	 * nowhere — so a keyboard user pressing Escape was returned to the top of the document, with the
	 * row they had just been operating somewhere below them and no way back but Tab.
	 *
	 * Nothing caught it. Every component assertion about this panel is about the panel while it is
	 * OPEN, and the six accessibility assertions are about accessible names and structure. Where
	 * focus lands after a key closes something is only answerable in a real browser, which is the
	 * whole argument for the keyboard walk existing beside them.
	 *
	 * `chooseAccount` already returns focus by a different route (the row re-renders with a value
	 * and the panel closes on the choice), so this is the DISMISS path specifically: 6k's
	 * « Fermeture sans choix ».
	 */
	function closeAccountPanel() {
		accountPanelOpen = false;
		focusAccountRow();
	}

	function openCreateSheet() {
		accountPanelOpen = false;
		accountPanelFocus = 'list';
		createPhase = 'idle';
		createError = null;
		createErrorField = null;
		createOpen = true;
	}

	/**
	 * Cancelling REOPENS the panel, on the action it was opened from.
	 *
	 * Without it, abandoning a creation drops the user on a row they have to open again to get back
	 * where they were, which is a dead end our own navigation manufactured rather than one the task
	 * has. The focus goes to the footer action and not to the list, because the footer action is
	 * where they were standing.
	 */
	function cancelCreate() {
		createOpen = false;
		accountPanelFocus = 'footer';
		accountPanelOpen = true;
	}

	/**
	 * On SUCCESS the sheet closes, the account is selected, and the focus returns to the ROW.
	 *
	 * Not to the panel, which has no reason left to be open, and not to a live region: the row
	 * announces its new value through its own accessible name, so an added announcement would say
	 * the same thing twice. 6g settles all three.
	 */
	async function submitCreate(name: string) {
		if (!onCreateAccount) return;
		createPhase = 'busy';
		createError = null;
		createErrorField = null;
		const answer = await onCreateAccount(name);
		if (!answer.ok) {
			createPhase = 'error';
			createError = answer.error;
			createErrorField = answer.field ?? null;
			return;
		}
		createdAccounts = [...createdAccounts, answer.account];
		chosenAccountId = answer.account.id;
		accountErrorShown = false;
		createPhase = 'idle';
		createOpen = false;
		accountPanelOpen = false;
		focusAccountRow();
	}

	/**
	 * The primary's press, and the whole of 5c's ordering is in it.
	 *
	 * Ticked, the press PROPOSES and the confirmation consents: one deliberate intention for one
	 * irreversible result, carried by the modal rather than by the box. Unticked, the user untied it
	 * themselves, nothing irreversible is in play, and there is nothing to confirm.
	 *
	 * The label does not change either way. « Importer et supprimer » on the footer would put two
	 * verbs on one action and make the primary's name depend on a checkbox sitting above it; the
	 * import is the act and the deletion is its consequence.
	 */
	function pressPrimary() {
		if (!importable) return;
		// Before the replace question, because a user with no account chosen must not be asked to
		// confirm a deletion for an import that cannot happen yet.
		if (chosenAccountId === null) {
			revealAccountError();
			return;
		}
		if (replaces && deleteOldImport) {
			confirmingReplace = true;
			return;
		}
		onSubmit?.({
			accountId: chosenAccountId,
			assignment,
			remember,
			hasHeaderRow,
			dateOrder: answeredReading,
			deleteOldImport: false
		});
	}

	function confirmReplace() {
		confirmingReplace = false;
		// Unreachable with a null account: `pressPrimary` is the only way into the modal and it
		// refuses one. Narrowed rather than asserted, so the compiler carries the claim.
		if (chosenAccountId === null) return;
		onSubmit?.({
			accountId: chosenAccountId,
			assignment,
			remember,
			hasHeaderRow,
			dateOrder: answeredReading,
			deleteOldImport: true
		});
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
{#snippet accountBlock()}
	<!--
		THE FIRST ROW OF THE BODY, above the roles list and OUTSIDE it.
		6b: « Sur l'écran de désignation, première rangée du corps ». Measured cost +82 px, the 68 px
		row and the 14 px body gap; 6b published +81 with the row inside the card. The ordinary path
		still fits because deleting the « Format du fichier » row had freed 62. A correction does
		not: see the docstring's body budget.

		Not inside the designation card, and not a fifth `RoleRow`. `RoleRow` takes a `MappingRole`,
		a CLOSED union of four the plate verifies as a constraint (« Quatre rôles, ensemble fermé.
		Tenu. Le compte n'est pas un rôle : il est lu avant la correspondance, comme le préambule
		d'un fichier »). Widening that union to carry an account would break the one thing that check
		exists to protect, and a column named « Compte » in an export must still appear in the
		columns list and stay ignored.

		`relative`, so the panel anchors UNDER the row that opened it, exactly as the column picker
		does one card below. `shrink-0` for the reason every body child has it: a flex column shrinks
		its items before it scrolls.
	-->
	<div class="relative shrink-0" bind:this={accountRowWrapper} data-testid="designation-account">
		<AccountRow
			state={accountState}
			value={chosenAccount?.name}
			hint={accountHintShown}
			expanded={accountPanelOpen}
			panelId="account-picker-panel"
			busy={submitting}
			onOpen={() => {
				// The list, always, when the ROW is what opened the panel. `footer` is set only by the
				// return from a cancelled creation, and leaving it set would land the next ordinary
				// opening on the action instead of on the options.
				accountPanelFocus = 'list';
				accountPanelOpen = !accountPanelOpen;
			}}
		/>
		<AccountPicker
			open={accountPanelOpen}
			options={shownAccounts}
			selectedId={chosenAccountId}
			panelId="account-picker-panel"
			initialFocus={accountPanelFocus}
			{declaredCurrency}
			onChoose={chooseAccount}
			onClose={closeAccountPanel}
			onCreate={openCreateSheet}
		/>
		<!--
			Inside the account block rather than beside the two other dialogs at the end of the file,
			because it is part of one control: the row, its panel and the sheet the panel opens are the
			same question asked three ways. Brique 15 traps its own focus and restores it, so nesting
			costs nothing.
		-->
		<CreateAccountSheet
			open={createOpen}
			prefill={accountPrefill}
			state={createPhase}
			error={createError}
			errorField={createErrorField}
			onSubmit={submitCreate}
			onCancel={cancelCreate}
		/>
	</div>
{/snippet}

{#snippet fileBlock()}
	<div class="shrink-0" data-testid="designation-file-block">
		<p class="h-[22px] truncate text-[15px] leading-[22px] font-semibold">{file.name}</p>
		<p class="h-[18px] truncate text-[12.5px] leading-[18px] text-zinc-500">
			{fileMetaLine({
				columns: columnCount,
				rows: effectiveFile.rowCount,
				// The live state, never `file.hasHeaderRow`: the prop is what DETECTION guessed and
				// this line has to follow what the USER said.
				headers: hasHeaderRow
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
		373 at 390: 16 label + 10 gap + 86 (the Date row, which carries a reading line) + 2x68 rows
		+ 2 hairlines + 12 + 1 separator + 12 + 68, plus 28 padding and 2 border.
		325 at 1280: the same stack with 74 and 56 px rows. Both asserted, in this component's spec
		and in its desktop spec. Only the row height and the radius change, which
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
						{...role === 'date'
							? {
									interpretation: dateInterpretation,
									interpretationConfirmed: dateInterpretationConfirmed
								}
							: {}}
						busy={submitting}
						onOpen={() => openPicker(role)}
					/>
					{#if wide && openRole === role}
						<ColumnPicker
							open
							variant="anchored"
							{role}
							file={effectiveFile}
							{assignment}
							candidates={candidates[role] ?? []}
							step={role === 'date' ? pickerStep : 'columns'}
							dateReading={role === 'date' ? (dateReadingPairs ?? undefined) : undefined}
							onChoose={choose}
							onChooseReading={chooseReading}
							onChangeColumn={() => (pickerStep = 'columns')}
							onChangeOrder={role === 'date' && canChangeOrder
								? () => (pickerStep = 'reading')
								: undefined}
							onClose={closeWithoutChoosing}
							onToggleHeaderRow={() => (hasHeaderRow = !hasHeaderRow)}
						/>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/snippet}

{#snippet trailingBlock()}
	{#if recap}
		<!--
			ONE action. Returning the four rows to their control form is what proves the recap is a
			MODE of this screen rather than a second screen: the same rows, resolved the same way,
			drawn differently.
		-->
		<!--
			What the CALLER has to say about the correspondance, inside the column that draws it.

			A route's own paragraphs under this component land outside its frame: at 1280 that is below
			the card's border and centred on a different axis, and at 390 it is under the action footer
			and behind the tab bar. Measured on the journey, at both widths. A sentence qualifying the
			four rows has to be read with them, so the caller hands it in and the screen places it in
			the one column that exists at either width.
		-->
		{#if recapCaption}
			<div class="shrink-0" data-testid="designation-recap-caption">{@render recapCaption()}</div>
		{/if}
		<div class="shrink-0" data-testid="designation-modify">
			<!--
				ABOVE the link, which is the whole of what this sentence is for. Under it, it would
				explain a cost the user has already paid. The shape is the memorisation block's, a
				sentence at 12.5 then a 48 px TapLink, so nothing new is introduced for it.
			-->
			{#if modifyAsksForFile}
				<p class="text-[12.5px] leading-[17px] text-zinc-500">
					{m.import_columns_recap_modify_note()}
				</p>
			{/if}
			<!--
				A BUTTON, and the referential is what settles it rather than a preference.

				§3.7 enumerates « la même carte, des rangées de 44 px, un TapLink », so the plate names
				this brick. But brique 4's own accessibility clause says a TapLink's affordance « comes
				from colour and font-weight and from sitting in an already-interactive context (list row,
				card, under an action title) » — and §3.7's rows are NON-FOCUSABLE by the same ruling. So
				the plate places a brick whose affordance depends on a context the same section removes,
				and the two statements cannot both be honoured here.

				Measured, and this is the cost of resolving it the other way: the blind tester read the
				bordered « Annuler » in the footer as the only control on the screen and recorded that they
				had hit a dead end. « Modifier les colonnes » is the only reason to be on this page.

				§3.7 drew this block on the UPLOAD screen, where `Importer le relevé` is the primary and a
				TapLink beside it is correctly subordinate. Ruling A1 deleted that moment, so the recap
				lives on `/imports/[batchId]/columns` where no primary exists — the inversion is a
				consequence of moving the block to a surface the plate does not draw, not of the brick.

				Recorded as a plate deviation for the design brief rather than settled unilaterally.
			-->
			<div class="flex items-center">
				<Button onclick={onModify ?? (() => (recap = false))}>{m.import_columns_modify()}</Button>
			</div>
		</div>
	{:else if pageState === 'complete' || pageState === 'submitting'}
		<!--
			48 px: a TapLink and nothing else. With its 14 px gap that is the 62 px state 2 adds,
			taking the body to 611 of 636, or of 576 on a correction, where it scrolls.

			## THE SENTENCE MOVED, AND ONLY THE SENTENCE

			This block used to be 86: two lines of sentence at 17, a 4 px gap, then the 48 px
			TapLink. The Date row's reading line costs 18 px in every state, and state 2 had 5 px of
			air, not the 25 the plate assumed, because this branch had already deleted the « Format
			du fichier » row the plate was sized against. So state 2 was 649 of a body capped at 636
			and the screen scrolled, which the plate forbids.

			34 + 4 = 38 px was recovered by moving the SENTENCE to the import summary, where it is
			drawn from `ImportSummaryResult.rememberedMapping`. Nothing was shrunk to fit: the
			sentence is a DISCLOSURE and belongs on the surface that reports what the import did.

			THE LINK DID NOT MOVE, and that is the part that is not arithmetic. Storing the mapping
			with no opt-out in reach BEFORE the write is a consent taken rather than given, so the
			control stays on the screen where the choice can still be made. Moving the whole block
			was rejected for that reason and the rejection is the reason this split exists.

			Memorisation is ON by default. There is deliberately NO toggle: the referential has none,
			and a switch would present a default as a decision the user has to take before they can
			leave. The link's two labels carry the state, which is what lets the sentence go.

			HEIGHT IS INVARIANT ACROSS THE TWO STATES, which is what the plate's promise needs: both
			labels sit in the same 48 px row, so opting out does not move anything below it.
		-->
		<div class="shrink-0" data-testid="designation-remember">
			<div class="flex h-12 items-center">
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

{#snippet replaceConsent()}
	{#if replaces && !recap}
		<!--
			Planche 5c. It sits INSIDE the footer, which is the region that does not scroll, and above
			the count and the primary. State 2 already fills 611 of the 636 px body, so the same control
			placed as the last card would be off screen at the moment of the press, and the user
			would be validating a deletion
			they cannot see; placed among the role cards it reads as one more designation.

			The order of the four storeys IS the meaning: the box (an option), the count (a fact), the
			primary (the act), the exit. What the footer does not become is a second primary, so
			« Annuler » stays a TapLink.

			`CheckboxField` unextended, which is exactly its registered use (brique 6b, #378): a boolean
			submitted with the form, labelled by its consequence, with a help line. That is also what
			keeps it distinct from brique 6c in 5d, whose press reconfigures a list on the spot.

			DEVIATION FROM THE PLATE'S DRAWING, recorded rather than resolved in silence: the footer
			sketch draws a 22 px black rounded box with a white check, and 5g's own props table says
			`CheckboxField` is used « inchangée ». The table governs the component and the sketch is a
			composition study of the four storeys, so the registered brick ships and the difference is
			written into the referential row.
		-->
		<div class="px-5 pt-3 pb-1 lg:px-0 lg:pt-0" data-testid="designation-replace-consent">
			<CheckboxField
				name="deleteOldImport"
				label={m.import_correct_delete_old_label({ date: replaces.namedAt })}
				note={replaces.hasUserWork ? m.imports_delete_cost_note() : undefined}
				bind:checked={deleteOldImport}
			/>
		</div>
	{/if}
{/snippet}

{#snippet actions()}
	{#if recap}
		<!--
			THE ESCAPE, and it is a TapLink because it is now the secondary on this screen.

			It also stops saying « Annuler ». On a read-only page nothing is in progress and nothing can
			be abandoned, so that word named no action — A14's phantom. What the control does is go back
			to the list this recap was opened from, and it now says so.

			The swap is the whole of the affordance repair: the bordered box was carrying all the visual
			weight on the screen for the one control that changes nothing.
		-->
		<div class="flex flex-1 items-center">
			<TapLink onclick={onCancel}>{m.import_columns_recap_back()}</TapLink>
		</div>
	{:else}
		<!--
			Plate 1q B « Envoi »: `aria-disabled` while the import is out, « même raison » as the primary,
			and that reason is the banner's second line (« Import en cours. L'écran se fermera de
			lui-même. »), which is what `aria-describedby` points at. The press is swallowed here: leaving
			mid-import drops the answer on a screen that no longer exists.
		-->
		<button
			type="button"
			class="h-12 flex-1 rounded-[14px] border border-zinc-200 bg-white text-[15px] font-semibold {submitting
				? 'cursor-default text-zinc-400'
				: 'text-zinc-700'}"
			aria-disabled={submitting ? 'true' : undefined}
			aria-describedby={submitting ? CONSEQUENCE_ID : undefined}
			onclick={() => {
				if (submitting) return;
				onCancel?.();
			}}
		>
			{pageState === 'tooFewColumns' ? m.import_columns_other_file() : m.import_columns_cancel()}
		</button>
	{/if}
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
			data-testid="designation-primary"
			class="h-12 flex-[1.4] rounded-[14px] text-[15px] font-semibold {importable
				? 'bg-zinc-900 text-white'
				: 'bg-zinc-200 text-zinc-400'}"
			aria-disabled={importable ? undefined : 'true'}
			aria-describedby={importable ? undefined : CONSEQUENCE_ID}
			aria-busy={submitting ? 'true' : undefined}
			onclick={pressPrimary}
		>
			{#if submitting}
				{m.import_columns_submitting()}
			{:else if importable}
				{submitLabel(effectiveFile.rowCount)}
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
			<!--
				THE HEADING SHARES THE COLUMN'S AXIS IN RECAP MODE, and this was found by looking at the
				screenshot rather than by a test. With the preview area gone the card centres at 560 and
				the title stayed pinned to the left gutter, so the screen named its content from a
				different axis than the content sat on. Every geometry assertion on this file was green
				through it: they measure the column, and nothing measured the two against each other.
			-->
			<!--
				`pt-4 pb-3` and not `pt-6 pb-4`, and the 12 px it reclaims is the whole reason.
				MEASURED at 1280x800 with the account row in the column: the primary's bottom edge
				landed at 805.5 against a fold of 800, so the screen stopped keeping its own action
				reachable without a scroll. 12 px brought it to 793.5.

				Re-measured by #684's M9 on the running app, 2026-09-25: 773.5 in state 2. THE NEXT
				STOREY DID BREAK IT: with 5c's consent storey the primary ends at 837.5, and at 873.5
				with the cost note, below the fold on every correction. No test re-derives these three:
				the frame's top is the app layout's header, which no component spec mounts. The method
				is in PR #729's body.

				**THIS IS SHAVING TO FIT AND IT IS RECORDED AS SUCH.** It leaves a 6.5 px margin, which
				is smaller than one line of anything, so the next storey added to this column breaks it
				again. The durable answer is the V2 referential's sheet-footer rule, which the 390
				chrome already obeys: the card and the memorisation block scroll inside their own
				region and the actions sit outside it, which is height-independent for any column.
				That is a restructure of this frame, it touches the preview pane and the recap mode,
				and it earns its own commit and its own screenshot pass rather than riding in on this
				one.

				NOT sticky positioning, which was tried on this column and rejected with its reason in
				the actions block below: a sticky box RISES OVER content, and it covered 29.5 px of the
				44 px « Ne pas mémoriser » control. A static footer outside an `overflow-y-auto`
				sibling cannot overlap anything by construction, which is the difference between the
				two and the reason the rejected one does not rule out the other.
			-->
			<div class="pt-4 pb-3 {recap ? 'mx-auto w-[560px]' : ''}" data-testid="designation-heading">
				<h1 class="text-[22px] leading-7 font-bold">{heading}</h1>
				<p class="mt-1 truncate text-[13px] text-zinc-500">
					{file.name} ·
					{fileMetaLine({
						columns: columnCount,
						rows: effectiveFile.rowCount,
						// The live state, never `file.hasHeaderRow`. Same reason as the 390 copy above.
						headers: hasHeaderRow
							? m.import_columns_headers_detected()
							: m.import_columns_headers_absent()
					})}
				</p>
			</div>

			<div class="flex items-start gap-6 pb-8 {recap ? 'justify-center' : ''}">
				<!--
					The command column. 400 wide, and it is AUTHORITATIVE rather than a convenience:
					it alone shows all four roles at once, and therefore it alone shows what is
					missing. The preview beside it is a shortcut, which is why this chantier can ship
					without the preview at all.

					560 IN THE RECAP, centred, and it is brique 15's tall-modal width rather than a
					number chosen here: already a reading width of this product, so a screen with no
					new data to show introduces nothing new to show it in. The recap is four rows and
					a link; it has no content to spread, and spreading emptiness is what 5b repairs.
				-->
				<div
					class="flex shrink-0 flex-col gap-4 {recap ? 'w-[560px]' : 'w-[400px]'}"
					data-testid="designation-command"
				>
					{#if !recap && !readOnly}
						{@render accountBlock()}
					{/if}
					{@render designationCard()}
					{@render trailingBlock()}

					<!--
						The banner and the actions are ONE box. The Repartition plate's amendment, same
						argument: what COMMANDS the primary action travels with it, so the count
						explaining why the primary is off is never separated from the primary it
						explains.

						NO LONGER `sticky bottom-6`, and it was measured rather than reasoned. A
						bottom-sticky element rises above its static position as soon as its column
						overflows, and what it rises over is whatever sits above it. Planche 5c adds a
						storey to this column, which pushed it past the frame: on the real page the box
						then covered 29.5 px of the 44 px « Ne pas mémoriser » control, the one control
						governing whether the application remembers the user's bank format.

						This repository already records the rule and had already paid for it once, on the
						band whose whole purpose was to explain why Save was disabled, covering the rows
						it was about: `position: sticky; bottom: 0` and « must not cover content » are not
						jointly satisfiable, and no offset fixes it. The 390 chrome obeys the V2
						sheet-footer rule instead, keeping its footer outside the scrolling region
						entirely; here the column simply scrolls and covers nothing. Measured by #684's
						M9 (the frame's scrollHeight less its clientHeight): 24 px in state 2, 88 on a
						correction, 124 with the cost note, and the last two take the primary below
						the fold (see the heading block above).

						The count and the primary stay welded, which is what the amendment actually asked
						for. What is given up is the box following the viewport, which was never the
						requirement.

						NO BOX IN THE RECAP, and it is the same rule rather than an exception to it. The box
						exists to bind a count to the primary it explains; the recap has neither. Once the
						escape became a TapLink, the border was a bordered white card drawn around a text
						link — a control-shaped surface containing no control, which is the false affordance
						this wave keeps removing. Seen on the journey immediately after the swap.
					-->
					<div
						class="overflow-hidden {recap ? '' : 'rounded-lg border border-zinc-200 bg-white'}"
						data-testid="designation-command-foot"
					>
						{#if replaces && !recap}
							<div class="px-4 pt-4">{@render replaceConsent()}</div>
						{/if}
						{@render bannerBlock()}
						<div class="flex items-stretch gap-3 {recap ? 'pt-1' : 'p-4'}">
							{@render actions()}
						</div>
					</div>
				</div>

				<!--
					LACUNE B, now drawn. It stayed empty while the argument was about the REFERENTIAL:
					registering the shared table from this screen would define it from its rarest case,
					and #332 still owns that ordering. What changed is the measurement: at 1280 this
					slot was 806 px wide and 0 px tall, so the screen was a 400 px column with 855 px of
					blank beside it, on the one screen a user reaches when the application has already
					failed to read their statement.

					`FilePreviewTable` is therefore LOCAL and unregistered, and it is #332's first
					consumer to absorb rather than its source. Its measurements come from the plate.

					NOT DECLARED IN RECAP MODE, and Planche 5b's whole point is that this is the repair
					rather than a height correction. The table is guarded on `previewRows` and the recap
					builds none, because without a file there is nothing to preview (owner arbitrage 2),
					so the component is right and the defect is here: a grid declaring an area that
					recap mode inherits and never fills. A `min-height` on this slot would reserve the
					emptiness on purpose. The column stops being the left half of something instead.
				-->
				{#if !recap}
					<div class="flex min-w-0 flex-1" data-testid="designation-preview-slot">
						<FilePreviewTable file={effectiveFile} {assignment} />
					</div>
				{/if}
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
			<!-- Same rule and same reason as « Annuler », plate 1q B « Envoi ». -->
			<IconButton
				label={m.import_columns_back()}
				softDisabled={submitting}
				aria-describedby={submitting ? CONSEQUENCE_ID : undefined}
				onclick={onCancel}
			>
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
			<h1 class="text-[16px] font-bold">{heading}</h1>
		</header>

		<!-- The ONLY scrolling region. An ordinary import fits (549 of 636, 611 in state 2); a
		     correction scrolls, 611 of 576 or of 540. Figures and their tests: the docstring. -->
		<div
			class="flex flex-col gap-[14px] overflow-y-auto px-5 pt-4 pb-6"
			data-testid="designation-body"
		>
			<!--
				`shrink-0` on every body child, and it is not decoration. A flex column shrinks its
				items before it scrolls, so without this an overfull body SQUASHES the 373 px card
				instead of scrolling, and the card's fixed height quietly stops being fixed. Found by
				the overflow calibration in this component's spec.
			-->
			{@render fileBlock()}
			{#if !recap && !readOnly}
				{@render accountBlock()}
			{/if}
			{@render designationCard()}
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
			<!--
				THE ORDER IS THE MEANING, and it is the plate's: the box (an option), the count (a fact),
				the primary (the act), the exit. So the consent sits in this region, above the count, and
				not inside the footer with the actions.
				Built the other way first, and the screenshot is what caught it: the count read above the
				consent, which puts the fact before the option it depends on.
			-->
			{@render replaceConsent()}
			{@render bannerBlock()}
		{/if}

		<!--
			88 = 12 top padding + 48 controls + 28 home indicator area, and 5c adds one storey in front
			of it when a correction is replacing something. The body pays for it: the storey is 60 px,
			96 with its cost note, so state 2's 611 sits in 576 or 540 and the body scrolls by 35 or
			71. The 62 px the « Format du fichier » deletion freed were spent first by the account
			row's 82. Asserted in this component's spec, 5c block.
		-->
		<footer class="flex items-stretch gap-3 px-5 pt-3 pb-7" data-testid="designation-footer">
			{@render actions()}
		</footer>
	</div>
{/if}

<!--
	Brique 15's destructive variant, the one the delete plate already drew. No new modal: the title
	names BOTH facts, the body states what the deletion costs, the primary is the filled rose that
	only a destructive confirmation is allowed, and the dismiss is a TapLink.

	« Annuler » here and not « Garder l'import » as on `/imports`: there the dismiss PRESERVES
	something and says so, here it abandons a press that has not happened yet.
-->
{#if replaces && confirmingReplace}
	<ConfirmDialog
		open={true}
		title={m.import_columns_replace_confirm_title({
			count: effectiveFile.rowCount,
			date: replaces.namedAt
		})}
		confirmLabel={m.import_columns_replace_confirm_label()}
		tone="danger"
		onConfirm={confirmReplace}
		onClose={() => (confirmingReplace = false)}
	>
		<p class="text-sm text-zinc-600" data-testid="replace-confirm-body">
			{m.import_columns_replace_confirm_body({ count: replaces.replacedRows })}
		</p>
	</ConfirmDialog>
{/if}

{#if openRole && !wide}
	<!-- 390 only: at 1280 the picker is anchored to its row, inside the card, a few lines up. -->
	<ColumnPicker
		open
		role={openRole}
		file={effectiveFile}
		{assignment}
		candidates={candidates[openRole as MappingRole] ?? []}
		step={openRole === 'date' ? pickerStep : 'columns'}
		dateReading={openRole === 'date' ? (dateReadingPairs ?? undefined) : undefined}
		onChoose={choose}
		onChooseReading={chooseReading}
		onChangeColumn={() => (pickerStep = 'columns')}
		onChangeOrder={openRole === 'date' && canChangeOrder
			? () => (pickerStep = 'reading')
			: undefined}
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
