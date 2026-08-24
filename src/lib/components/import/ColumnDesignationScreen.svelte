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
	import { bannerFor, fileMetaLine, submitLabel } from '$lib/domain/columnDesignationBanner';
	import { roleLabel } from '$lib/domain/columnMappingLabels';
	import { readWithHeaderRow } from '$lib/domain/headerRowReading';
	import FilePreviewTable from './FilePreviewTable.svelte';
	import ConditionBanner from '$lib/components/ui/ConditionBanner.svelte';
	import RoleRow from '$lib/components/ui/RoleRow.svelte';
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
	 * ## The body's 449 of 636, which is the plate's promise
	 *
	 *     16   padding-top
	 *     40   file block      (60 in state 3c, which adds a third line)
	 *     14   gap
	 *    355   designation card
	 *     24   padding-bottom
	 *    ---
	 *    449, leaving 187 px of air, and THE SCREEN DOES NOT SCROLL IN ANY STATE.
	 *
	 * The card ends at 425 of 636 (16 + 40 + 14 + 355). Both figures are asserted.
	 *
	 * **Was 511**, with a 48 px « Format du fichier » row and its 14 px gap. That row was a grey
	 * heading with nothing under it, at both widths, in every state, since the screen shipped: a
	 * visible empty affordance is a promise, and it had been making one for months. Deleted rather
	 * than kept warm. The date format, the decimal separator and the delimiter are still designed and
	 * still out of scope; when one is built it arrives with its own layout rather than inheriting a
	 * slot sized for nothing.
	 *
	 * The 62 px it frees are the ones the correction checkbox needs at 390, where the body carries
	 * only 25 px of air in state 2. That placement is the design brief's question rather than this
	 * change's — what this does is make the space measurable instead of occupied.
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
		accountHint = null,
		accountPrefill = '',
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
		) => Promise<{ ok: true; account: AccountPickerOption } | { ok: false; error: string }>;
		onSubmit?: (result: {
			assignment: RoleAssignment;
			/** The account the user chose. Never null by the time the primary submits. */
			accountId: string;
			remember: boolean;
			hasHeaderRow: boolean;
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
		return file.firstRow?.[index] ?? file.samples[index]?.[0] ?? '';
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
		 * `accountHint` is computed on the server when the page loads, and every sentence it can
		 * carry is a PROVENANCE: the file said so, we remembered, we have never seen this shape, you
		 * have no accounts. The moment the user overrides that answer, by choosing a different
		 * account or by creating one, the sentence describes a resolution that no longer holds. One
		 * of them becomes outright false: the row names an account while the line under it says
		 * there are none.
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
		if (chosenAccountId !== initialAccountId) return undefined;
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
		const answer = await onCreateAccount(name);
		if (!answer.ok) {
			createPhase = 'error';
			createError = answer.error;
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
		6b: « Sur l'écran de désignation, première rangée du corps ». Measured cost +81 px, and the
		body begins to scroll by 50, which is stated here rather than hidden.

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

{#snippet replaceConsent()}
	{#if replaces && !recap}
		<!--
			Planche 5c. It sits INSIDE the footer, which is the region that does not scroll, and above
			the count and the primary. At 549 px of body for 580 the same control placed as the last
			card is off screen at the moment of the press, and the user would be validating a deletion
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
		<button
			type="button"
			class="h-12 flex-1 rounded-[14px] border border-zinc-200 bg-white text-[15px] font-semibold text-zinc-700"
			onclick={onCancel}
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
				reachable without a scroll. 12 px brings it to 793.5.

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
						entirely; here the column simply scrolls, which costs 56 px of scroll on the
						tallest state and covers nothing.

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
			<h1 class="text-[16px] font-bold">{heading}</h1>
		</header>

		<!-- The ONLY scrolling region, and in practice it never does: 511 of 636 in every state. -->
		<div
			class="flex flex-col gap-[14px] overflow-y-auto px-5 pt-4 pb-6"
			data-testid="designation-body"
		>
			<!--
				`shrink-0` on every body child, and it is not decoration. A flex column shrinks its
				items before it scrolls, so without this an overfull body SQUASHES the 355 px card
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
			of it when a correction is replacing something. The 87 px freed by deleting the
			« Format du fichier » row are what pay for it: the body goes from 636 to 580 available for
			549 used, and 31 px of air remain.
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
