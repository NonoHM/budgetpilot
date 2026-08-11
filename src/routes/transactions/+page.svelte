<script lang="ts">
	import { enhance } from '$app/forms';
	import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import { tick } from 'svelte';
	import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
	import { formatCents } from '$lib/domain/budget';
	import { resolveCategoryColorClass } from '$lib/domain/colors';
	import { categoryDisplayName } from '$lib/domain/categoryLabels';
	import { natureLabel } from '$lib/domain/natureLabels';
	import { isTransactionNature, type TransactionNature } from '$lib/domain/transaction';
	import { isTagColorToken, MAX_TAG_NAME_LENGTH, type TagColorToken } from '$lib/domain/tags';
	import { getInitials } from '$lib/domain/initials';
	import { buildTransactionsHref, buildTransactionsExportHref, filterHiddenInputs } from './hrefs';
	import { splitSaveFailureMessage } from './split-save-failure';
	import { normalizeForMatch } from '$lib/domain/normalize';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { ActionData, PageData } from './$types';
	import Button from '$lib/components/Button.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import BottomSheet from '$lib/components/BottomSheet.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import SplitBadge from '$lib/components/splits/SplitBadge.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import TransactionProposalCard from '$lib/components/TransactionProposalCard.svelte';
	import TransactionTagsEditor from '$lib/components/TransactionTagsEditor.svelte';
	import SplitEditor from '$lib/components/splits/SplitEditor.svelte';
	import TransactionFocusOverlay from '$lib/components/TransactionFocusOverlay.svelte';
	import TagChips from '$lib/components/ui/TagChips.svelte';
	import FilterDropdown from '$lib/components/ui/FilterDropdown.svelte';
	import PeriodFilter from '$lib/components/ui/PeriodFilter.svelte';
	import ManageTagsFooter from '$lib/components/ui/ManageTagsFooter.svelte';
	import { tagColorBgClass, tagColorTextClass, tagTintBgClass } from '$lib/domain/colors';
	import { MAX_BULK_TAG_TRANSACTIONS } from '$lib/domain/tags';
	import {
		getAdjacentFocusStackId,
		getFocusOutcomeForAction,
		getRemainingFocusStackIds
	} from '$lib/domain/transactionFocus';
	import { cardBase, inputBase } from '$lib/styles';
	import Badge from '$lib/components/ui/Badge.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import SearchBar from '$lib/components/ui/SearchBar.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Skeleton from '$lib/components/ui/Skeleton.svelte';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let openSections = $state(new Set<string>());
	let ignoredIds = $state(new Set<string>());
	let resolvedIds = $state(new Set<string>());
	let manualCategoryValue = $state('');
	let manualNatureValue = $state('');
	let createRuleOpen = $state(false);
	let deleteConfirmOpen = $state(false);
	// Snapshot of the transaction being deleted, independent of data.selectedTransaction:
	// the mobile flow deselects (closes the bottom sheet) at the same moment it opens this
	// dialog, so the dialog can't rely on selection staying put while it's open.
	let pendingDelete = $state<{ id: string; label: string; amountCents: number } | null>(null);
	let ruleTarget = $state<{
		id: string;
		label: string;
		matchText: string;
		targetCategory: string;
		targetNature: string;
	} | null>(null);
	// Correct as-is (this effect below DOES track data.filters.qMode, unlike the dashboard's
	// flagged case): a writable $derived would be a valid idiom simplification, deferred rather
	// than forced during this lint cleanup since it touches this page's most exercised reactive
	// state.
	// eslint-disable-next-line svelte/prefer-writable-derived
	let searchIsRegex = $state(false);
	let mobileCategoryFormEl = $state<HTMLFormElement | null>(null);
	let mobileNatureFormEl = $state<HTMLFormElement | null>(null);
	// Focus mode (/transactions "to classify" one at a time): purely client-side,
	// deliberately not persisted in the URL — a refresh always exits it (consistent with
	// ignoredIds/resolvedIds, already non-persistent). The "Focus mode" button pushes
	// `?type=classify&selected=<id>` to reuse the existing state management
	// (data.selectedTransaction/selectedSuggestion).
	let focusOpen = $state(false);
	// Stack frozen when focus mode opens (NOT continuously derived from data.classifyStackIds):
	// accepting/ignoring a transaction removes it from the server-recomputed stack (reloaded by
	// each form's update()), so a reactive stack would make getAdjacentFocusStackId lose the
	// original position of the id we just processed (no longer present in the stack at all, not
	// just "handled") — it returned null and focus mode closed after every action. Actual
	// progress is still driven by resolvedIds/ignoredIds (session), not by this frozen stack.
	let focusStackIds = $state<string[]>([]);
	// Target of the direct rule creation in focus mode (no intermediate modal, see hidden
	// form below) — distinct from `ruleTarget`, which remains for the existing modal flow
	// (aside/list). "Create a rule" ALSO categorizes the current transaction (like Accept):
	// quickAcceptTarget drives a 2nd hidden form (?/acceptSuggestion) submitted before the rule
	// is created — only the rule itself is never applied retroactively to other pending transactions.
	let quickAcceptTarget = $state<{ id: string; category: string; nature: string } | null>(null);
	let quickAcceptFormEl = $state<HTMLFormElement | null>(null);
	let quickCreateRuleTarget = $state<{
		id: string;
		name: string;
		matchText: string;
		targetCategory: string;
		targetNature: string;
	} | null>(null);
	let quickCreateRuleFormEl = $state<HTMLFormElement | null>(null);
	// Remaining ids of the frozen stack (excluding the current transaction), sent to the server
	// for automatic classification scoped to the current focus session — see createRuleInFocusMode.
	let quickCreateRuleRemainingIds = $state<string[]>([]);
	// Submission-in-flight tracking for the button spinner (Button's `loading` prop) — see
	// ui/Spinner.svelte / ui/Skeleton.svelte migration. `acceptSubmittingIds` is per-transaction
	// (several accept-suggestion forms can be visible at once, one per row/card).
	let classifyAllSubmitting = $state(false);
	let acceptSubmittingIds = $state(new Set<string>());
	let deleteSubmitting = $state(false);
	let createRuleSubmitting = $state(false);
	// Bulk-tag confirmation dialog (Task 6.2, steps 3-4). `bulkTagName` is the tag name being
	// typed, reset every time the dialog opens so a previous, unrelated name never survives into
	// a fresh confirmation.
	let bulkTagOpen = $state(false);
	let bulkTagName = $state('');
	let bulkTagSubmitting = $state(false);
	let bulkTagUndoSubmitting = $state(false);

	$effect(() => {
		searchIsRegex = data.filters.qMode === 'regex';
	});

	const classificationMode = $derived(data.filters.type === 'classify');
	// Real perceptible-delay site (see CLAUDE.md's Skeleton decision): a paginated transactions
	// list, potentially thousands of rows server-side, reloaded via `load()` on every filter/page
	// link click. `navigating` is only truthy for the duration of that client-side navigation —
	// scoped to this same route so switching to another page of the app never shows it.
	const isNavigatingTransactions = $derived(navigating.to?.url.pathname === '/transactions');
	const visibleTransactions = $derived(
		data.transactions.filter((tx) => !resolvedIds.has(tx.id) && !ignoredIds.has(tx.id))
	);

	// Focus mode: classifyStackIds is computed server-side (independent of the current tab, see
	// +page.server.ts) and frozen into focusStackIds when opened (see declaration above). We
	// combine it with the session Sets resolvedIds/ignoredIds already used elsewhere on the page
	// to derive the remaining stack and the current position.
	const focusHandledIds = $derived(new Set([...resolvedIds, ...ignoredIds]));
	const focusRemainingIds = $derived(getRemainingFocusStackIds(focusStackIds, focusHandledIds));
	const focusPosition = $derived(
		data.selectedTransaction ? focusStackIds.indexOf(data.selectedTransaction.id) + 1 : 0
	);
	const focusPreviousId = $derived(
		data.selectedTransaction
			? getAdjacentFocusStackId(
					focusStackIds,
					focusHandledIds,
					data.selectedTransaction.id,
					'previous'
				)
			: null
	);
	const focusNextId = $derived(
		data.selectedTransaction
			? getAdjacentFocusStackId(focusStackIds, focusHandledIds, data.selectedTransaction.id, 'next')
			: null
	);

	// Safety net: if the stack empties while the overlay is open (e.g. "Accept all" triggered
	// just before), close it and fall back to the existing "all classified" state rather than
	// staying stuck on an id that no longer exists in the stack.
	$effect(() => {
		if (focusOpen && focusRemainingIds.length === 0) {
			focusOpen = false;
			goto(resolve(buildFilterHref('classify')), { keepFocus: true, noScroll: true });
		}
	});

	function handleAccepted(transactionId: string) {
		applyFocusOutcome('accept', transactionId);
	}

	function handleIgnore(transactionId: string) {
		applyFocusOutcome('ignore', transactionId);
	}

	// Routes a focus-mode action into the right session bucket (resolvedIds vs
	// ignoredIds) via getFocusOutcomeForAction, then advances the stack.
	function applyFocusOutcome(action: 'accept' | 'ignore' | 'createRule', transactionId: string) {
		if (getFocusOutcomeForAction(action) === 'accepted') {
			resolvedIds = new Set([...resolvedIds, transactionId]);
		} else {
			ignoredIds = new Set([...ignoredIds, transactionId]);
		}
		maybeAdvanceFocus(transactionId);
	}

	// Advances the stack after Accept/Ignore/Create a rule, only while the focus overlay is
	// open (no-op otherwise, to keep behavior unchanged outside focus mode).
	function maybeAdvanceFocus(transactionId: string) {
		if (!focusOpen) return;
		const handled = new Set([...resolvedIds, ...ignoredIds]);
		const nextId = getAdjacentFocusStackId(focusStackIds, handled, transactionId, 'next');
		if (nextId) {
			goto(resolve(buildSelectedHref(nextId)), { keepFocus: true, noScroll: true });
		} else {
			focusOpen = false;
			goto(resolve(buildFilterHref('classify')), { keepFocus: true, noScroll: true });
		}
	}

	const buildFocusHref = (id: string) =>
		buildTransactionsHref(data.filters, { type: 'classify', selected: id }, { keepIds: false });

	function openFocusMode() {
		const firstId = getRemainingFocusStackIds(data.classifyStackIds, focusHandledIds)[0];
		if (!firstId) return;
		focusStackIds = data.classifyStackIds;
		focusOpen = true;
		goto(resolve(buildFocusHref(firstId)), { keepFocus: true, noScroll: true });
	}

	function closeFocusMode() {
		focusOpen = false;
	}

	// Gates the "Enregistrer" buttons (category/nature, desktop+mobile): disabled until the
	// selected value actually differs from what's saved, so a no-op submit isn't offered.
	const categoryIsDirty = $derived(
		manualCategoryValue !== (data.selectedTransaction?.manualCategory ?? '')
	);
	const natureIsDirty = $derived(
		manualNatureValue !== (data.selectedTransaction?.manualNature ?? '')
	);

	/**
	 * The unsaved-changes guard.
	 *
	 * Dirtiness has three sources — manual category, manual nature, and tags. The first two are the
	 * two deriveds above; the third is owned by `TransactionTagsEditor` and mirrored out through its
	 * `dirty` prop rather than recomputed here, so the two surfaces cannot disagree about what
	 * "unsaved" means. Both mounts are bound and the two flags are OR-ed: the desktop panel and the
	 * mobile sheet render simultaneously (a documented duplication on this page), the user edits in
	 * exactly one of them, and "some editor holds unsaved work" is the question the guard asks.
	 *
	 * ONE mechanism covers all six paths, because every one of them is a navigation: selection is
	 * `?selected=`, closing drops the param, and a nav link or the browser's Back button is a
	 * navigation by definition. Before this, switching rows silently discarded pending edits — the
	 * `$effect` further down resets `manualCategoryValue`/`manualNatureValue` on every selection
	 * change with nothing asked.
	 */
	let tagsDirtyDesktop = $state(false);
	let tagsDirtyMobile = $state(false);
	// A fourth source, and it joins the guard for exactly the reason the third did: a répartition in
	// progress is hand-typed work, and up to twenty rows of it. Losing that to a row click would be
	// the most expensive silent discard on this page.
	let splitsDirtyDesktop = $state(false);
	let splitsDirtyMobile = $state(false);
	const hasUnsavedChanges = $derived(
		categoryIsDirty ||
			natureIsDirty ||
			tagsDirtyDesktop ||
			tagsDirtyMobile ||
			splitsDirtyDesktop ||
			splitsDirtyMobile
	);

	/**
	 * The split editor's presence, design 1b and 1j.
	 *
	 * ONE flag for both surfaces, not one each. The desktop panel and the mobile sheet are mounted
	 * simultaneously — a documented duplication on this page — but only ever one is visible, so a
	 * per-surface flag would let the mode be on in the hidden one and produce two Save buttons for a
	 * répartition the user opened once. `dirty` is still mirrored per surface, because that answers a
	 * different question: which editor is holding work.
	 */
	let splitDraftOpen = $state(false);
	/** 1i: a répartition write is in flight. Set by `use:enhance`, read by both mounts. */
	let splitSaving = $state(false);
	/**
	 * 1i's failure sentence for the answers that never reach `form` — see `split-save-failure.ts`
	 * for the measurement. ONE flag for both mounts, for the same reason `splitSaving` is one: the
	 * répartition is opened once and the two surfaces are two views of it, so a per-surface flag
	 * would leave the hidden one holding a stale failure.
	 *
	 * IT CARRIES THE TRANSACTION IT IS ABOUT, and that is not defensive bookkeeping. Selecting
	 * another row does not remount this page — it changes `?selected=`, so `data` moves and every
	 * `$state` here does not. A bare string would go on being rendered above a DIFFERENT
	 * transaction's editor, attributing a failure to a save that was never attempted on it. Scoped
	 * structurally through `splitSaveFailureForSelection` below rather than through an `$effect`
	 * that clears it, because a derivation cannot be forgotten by whoever adds the next navigation
	 * path.
	 */
	let splitSaveFailure = $state<{ transactionId: string; message: string } | null>(null);
	const splitParts = $derived(data.selectedTransaction?.splits ?? []);
	/**
	 * Remounts `SplitEditor` when — and only when — the SAVED parts change.
	 *
	 * The editor takes a snapshot of its parts at initialisation, deliberately: that snapshot is the
	 * BEFORE its dirty check compares against, and a reactive one would track the after so nothing
	 * would ever read as dirty. Under a full-page POST that snapshot was refreshed by the navigation
	 * remounting the component. `use:enhance` keeps the page, so without this the editor would still
	 * be comparing against the parts as they were BEFORE the save — « Enregistrer » would stay lit
	 * on a répartition that was just written, and the reason line would never say « rien n'a changé ».
	 *
	 * Keyed on the saved parts rather than on any save at all, which is what makes it safe: a FAILED
	 * save leaves them untouched, so the editor is not remounted and the user's draft survives —
	 * exactly what 1i promises with « vos parts sont conservées ». Same for the tab-return refresh
	 * when nothing has changed.
	 */
	const splitPartsSignature = $derived(JSON.stringify(splitParts));
	/** 1j-B when parts exist, 1j-A once the entry row is pressed. Same editor, same mechanics. */
	const splitEditorActive = $derived(splitParts.length > 0 || splitDraftOpen);

	// Two ids rather than one, kept apart HERE rather than inside the editor: the sentence belongs to
	// the editor and the control it explains belongs to this page, so the id has to be owned by
	// whichever of the two renders twice — and that is this page. See SplitEditor's `parentLockId`.
	const pageInstanceId = $props.id();
	const desktopParentLockId = `split-parent-lock-desktop-${pageInstanceId}`;
	const mobileParentLockId = `split-parent-lock-mobile-${pageInstanceId}`;

	const splitsError = $derived(
		form && 'splitsError' in form ? (form.splitsError as string) : undefined
	);
	/**
	 * The ONE sentence the editor is handed, whichever half produced it.
	 *
	 * THE CLIENT-SIDE SIGNAL WINS, AND THE ORDER IS LOAD-BEARING RATHER THAN ARBITRARY. The two can
	 * never both describe the same submission — a redirect or a transport error carries no
	 * `ActionData` — so this only decides what happens ACROSS two submissions, and there the two are
	 * not equally fresh:
	 *
	 * - `splitSaveFailure` is cleared at the start of every submission, so a non-null value can only
	 *   have come from the most recent one.
	 * - `splitsError` derives from `form`, which is replaced only by `update()` — and the failure
	 *   branch is defined as the branch that does NOT call `update()`. So it survives from whichever
	 *   earlier submission last answered, however long ago.
	 *
	 * The first draft of this had the opposite order, with a comment asserting the stale case could
	 * not arise because "`form` is replaced by `update()` on every submission that answers". True,
	 * and beside the point: the failing submission is exactly the one that does not answer. A user
	 * whose sum was refused, and whose session then expired before the retry, was told « les parts
	 * doivent totaliser… » — a false sentence sending them to re-check arithmetic that was fine,
	 * while the real cause went unsaid. Found by review, pinned by the two specs below.
	 */
	const splitSaveFailureForSelection = $derived(
		splitSaveFailure && splitSaveFailure.transactionId === data.selectedTransaction?.id
			? splitSaveFailure.message
			: null
	);
	const splitEditorError = $derived(splitSaveFailureForSelection ?? splitsError ?? undefined);

	/**
	 * ONE handler for the two `?/saveSplits` mounts, not one each.
	 *
	 * They were byte-identical copies before this, which was harmless while they only flipped a
	 * flag; it stops being harmless the moment they carry a decision about which answers are
	 * failures. A decision written twice is the shape this repo has been caught by repeatedly —
	 * the fix lands on the copy that was noticed and the other one goes on shipping the defect.
	 */
	const enhanceSplitForm: SubmitFunction = ({ formData }) => {
		splitSaving = true;
		// Cleared HERE rather than on success, so the banner belongs to the attempt in flight: a
		// failure sentence surviving into the next submission would describe a request that is over.
		splitSaveFailure = null;
		// Read off the FORM, not off `data.selectedTransaction`: the form field is what the server
		// acts on, so a banner keyed on it can never be attributed to a row the request did not name.
		const submittedTransactionId = String(formData.get('transactionId') ?? '');
		return async ({ result, update }) => {
			const failure = splitSaveFailureMessage(result);
			if (failure) {
				// Deliberately NOT `update()`, and this is the whole fix. `update()` hands the result
				// to `applyAction`, which follows a redirect with `goto('/login?…')` — taking the
				// draft with it, or, since the editor is dirty by construction whenever Save can be
				// pressed, being cancelled by this page's own unsaved-changes guard and asking
				// « Abandonner les modifications ? » about a save the user believes succeeded.
				// Measured 2026-08-09; see `split-save-failure.ts`.
				splitSaveFailure = { transactionId: submittedTransactionId, message: failure };
				splitSaving = false;
				return;
			}
			// `reset: false` because this editor is state-driven, not value-driven: resetting the
			// form would clear the native fields under a component that is not reading them.
			await update({ reset: false });
			splitSaving = false;
		};
	};
	/**
	 * 1r, the save-response half. Only the `category` refusal reaches the panel as « choisissez une
	 * catégorie pour la part N » — every other refusal carries positions too, so the discriminator is
	 * what stops an over-long note being reported as a missing category.
	 */
	const splitsConflictPositions = $derived.by(() => {
		// Read through one narrow cast rather than `'key' in form`: `ActionData` here is intersected
		// with `Record<string, unknown>`, so the `in` operator is true for every member of the union
		// and narrows nothing — the same reason the neighbouring deriveds read a single property each.
		const result = form as { splitsCategoryConflict?: boolean; splitsPositions?: number[] } | null;
		return result?.splitsCategoryConflict ? (result.splitsPositions ?? []) : [];
	});
	const splitsSavedCount = $derived(
		form && 'splitsSaved' in form && form.splitsSaved ? (form.splitsCount as number) : null
	);
	/**
	 * 1r's FIRST moment: « aux deux moments où l'application rafraîchit déjà — au retour sur
	 * l'onglet et à la réponse d'enregistrement. Aucun sondage périodique n'est introduit pour un
	 * cas qui se compte en unités par an. »
	 *
	 * The refresh is the whole mechanism. `SplitEditor` decides the conflict by comparing its draft
	 * against the options it is currently handed, so reloading is all this has to do, and the second
	 * moment reuses the same derivation rather than a second code path.
	 *
	 * THE GUARDS ARE THE CAREFUL PART, and each is here for a specific reason rather than for
	 * caution. `invalidateAll` re-runs the load and hands every editor on this page a fresh object.
	 * The split draft survives that — it is `$state` initialised once, never a `$derived` — but
	 * `TransactionTagsEditor`'s selection IS a writable `$derived` off `tags`, so it re-derives and
	 * a pending tag edit would be discarded by a gesture as innocent as coming back to the tab. So:
	 * only when there is an editor whose conflict this could reveal, and only when no sibling editor
	 * is holding work the refresh would throw away.
	 */
	function handleTabReturn() {
		if (document.visibilityState !== 'visible') return;
		if (!splitEditorActive) return;
		if (categoryIsDirty || natureIsDirty || tagsDirtyDesktop || tagsDirtyMobile) return;
		invalidateAll();
	}

	const splitsRemoved = $derived(
		form && 'splitsRemoved' in form ? Boolean(form.splitsRemoved) : false
	);

	// Set for exactly one hop, by "Abandonner". Without it, replaying the navigation would be
	// caught by the very guard that asked the question and the dialog would reopen forever.
	let bypassUnsavedGuard = $state(false);
	let pendingNavigation = $state<URL | null>(null);

	beforeNavigate((nav) => {
		if (!hasUnsavedChanges || bypassUnsavedGuard) return;
		// Nothing to replay means nothing to ask about. Cancelling here would swallow the gesture
		// with no dialog and no way forward while the editor stays dirty — the user would click and
		// see nothing happen. `nav.to` is null today only for `type: 'leave'`, which is handled
		// below on its own terms, so this is a guard against the API gaining a third case rather
		// than against a reachable state.
		if (!nav.willUnload && !nav.to) return;
		// Cancel FIRST. `beforeNavigate` is synchronous, so there is no awaiting a dialog here: the
		// navigation is stopped unconditionally and replayed later if the user says so.
		nav.cancel();
		// Two facts about this API, verified against SvelteKit's client runtime rather than assumed:
		//   - a cancelled `popstate` is counteracted with `history.go(-delta)`, so the Back button
		//     correctly stays put instead of leaving the address bar one entry ahead of the page;
		//   - for `type: 'leave'` (tab close, external link) the cancel becomes `preventDefault()` on
		//     `beforeunload`, i.e. THE BROWSER'S OWN dialog, not ours. We cannot render over it and
		//     must not try. So "the confirmation always looks the same" is false, and a test written
		//     on that premise would go red for the wrong reason.
		if (nav.willUnload) return;
		pendingNavigation = nav.to?.url ?? null;
	});

	function keepEditing() {
		pendingNavigation = null;
	}

	async function discardAndNavigate() {
		const target = pendingNavigation;
		pendingNavigation = null;
		if (!target) return;
		bypassUnsavedGuard = true;
		try {
			// `target` is the URL SvelteKit itself produced for the navigation it just handed us, so
			// it is already resolved; `resolve()` takes a route id and would not even type-check here.
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(target, { noScroll: true });
		} finally {
			// In a `finally`, so a rejected navigation (an offline load, a server error) cannot leave
			// the guard permanently switched off — which would silently disarm it for the rest of the
			// session, and a disarmed guard looks exactly like a working one until work is lost.
			bypassUnsavedGuard = false;
		}
	}

	// Whether the id filter is actually active (see the idsFilterNotice snippet). False when the
	// param is absent — and also when it was present but empty, which is exactly the collapse
	// `filters.ids` documents: an empty list yields no rows, so there is nothing to explain and no
	// filter worth advertising. The count shown alongside it is `pagination.totalTransactions`, not
	// the id count: an anchor can point at a transaction since deleted, and the row count is the
	// honest number of what is actually on screen.
	const idsFilterActive = $derived(Boolean(data.filters.ids));

	/**
	 * ON A RÉPARTIE ROW THE CATÉGORIE COLUMN SHOWS THE DOMINANT PART, NOT THE PARENT (design 1l) —
	 * AND UNDER A CATEGORY FILTER IT SHOWS THE MATCHED PART INSTEAD OF THE DOMINANT ONE (PR5).
	 *
	 * The parent keeps a category, but it is a restoration value rather than a display truth:
	 * writing « Alimentation » on a transaction of which 20 € went to Maison is false, and false in
	 * a way that cannot be seen — which is the worst kind. The dot follows the same value, because a
	 * colour disagreeing with the name beside it is a second false statement rather than a decoration.
	 *
	 * `matchedCategoryAllocation` is `null` outside a category filter, so this falls through to the
	 * pre-PR5 rule exactly. Inside one, the dominant category can differ from the one the filter
	 * actually found — a row can be dominated by Alimentation while `?category=Loisirs` matched a
	 * smaller part — and naming the dominant one there would be the same false-but-invisible claim
	 * the badge exists to prevent, just moved one filter later.
	 */
	function rowCategory(tx: (typeof data.transactions)[number]): string {
		return (
			tx.matchedCategoryAllocation?.category ?? tx.splitIndicator?.dominantCategory ?? tx.category
		);
	}

	/**
	 * ONE RULE FOR BOTH LINES, category and nature alike. Under OD-4 nature resolves per part, so
	 * printing a nature that belongs to a different part than the one `rowCategory` just named would
	 * be self-inconsistent — the two lines would describe different fragments of the same
	 * transaction. Mirrors `rowCategory` exactly, including the PR5 matched-allocation precedence.
	 */
	function rowNature(tx: (typeof data.transactions)[number]): TransactionNature {
		return tx.matchedCategoryAllocation?.nature ?? tx.splitIndicator?.dominantNature ?? tx.nature;
	}

	/**
	 * The matched allocation's amount, but only when it is a genuine FRAGMENT of the row's own
	 * total — never for an unsplit row (its one allocation IS the total) and never when the filter
	 * happens to match every part (their sum is the total too). `null` in both of those cases and
	 * outside a category filter, so the primary amount and the "sur {total}" secondary line both
	 * fall back to the row's own total exactly as before PR5.
	 *
	 * COMPARED AS MAGNITUDES, and that is not defensive rounding — it is what stops this predicate
	 * depending on a sign convention it does not own. `matched.amountCents` is signed by the row's
	 * resolved KIND. `tx.amountCents` is signed by whatever the loader decided, and the two write
	 * paths disagree: manual entry stores a signed value while `import/persist.ts` stores
	 * `Math.abs(...)` and puts the direction in `type`. Compared signed, an unsplit IMPORTED expense
	 * reads -4290 against +4290, reports itself a fragment of itself, and renders « -42,90 € » over
	 * « sur 42,90 € » — the same number twice, one announced as part of the other.
	 *
	 * Found by review on this branch alone, and it does NOT reproduce once the loader signs the
	 * column (a change landing on another branch of this chantier). That is exactly why it is fixed
	 * HERE rather than left to that: a predicate whose correctness rests on a sibling branch's
	 * behaviour regresses silently the day that behaviour is reverted, and nothing would point back
	 * to this line. Magnitudes are true under either convention.
	 */
	function rowPartialMatch(
		tx: (typeof data.transactions)[number]
	): { category: string; amountCents: number } | null {
		const matched = tx.matchedCategoryAllocation;
		return matched && Math.abs(matched.amountCents) !== Math.abs(tx.amountCents) ? matched : null;
	}

	/** The primary amount a row shows: the matched allocation's when it is a genuine fragment (see
	 *  `rowPartialMatch`), the transaction's own total otherwise. */
	function rowAmountCents(tx: (typeof data.transactions)[number]): number {
		return rowPartialMatch(tx)?.amountCents ?? tx.amountCents;
	}

	/** The badge renders what it is given, so the sentinel is resolved here rather than inside it. */
	function badgeParts(
		indicator: NonNullable<(typeof data.transactions)[number]['splitIndicator']>
	): Array<{ category: string; amountCents: number }> {
		return indicator.parts.map((part) => ({
			category: categoryDisplayName(part.category),
			amountCents: part.amountCents
		}));
	}

	// Maps the flat { id, name, colorToken: string } rows the load returns into TagChips'
	// TagChipItem shape. `colorToken` arrives as a plain string from the database column, not the
	// closed TagColorToken union; isTagColorToken re-validates it here rather than casting blindly,
	// so a value that somehow fell outside the palette renders TagChips' honest neutral dot instead
	// of a bogus Tailwind class.
	/**
	 * The active tag filter, as a chip. One of the only two surfaces the design lets a tag's colour
	 * leave its 8px dot, and the one where that colour does real work: it says at a glance WHICH
	 * filter is applied, without reading the control.
	 */
	const activeFilterTag = $derived(
		data.filters.tag ? (data.allTags.find((t) => t.id === data.filters.tag) ?? null) : null
	);

	/** Clears the tag filter, keeping every other one. */
	function clearTagFilter() {
		goto(resolve(buildTransactionsHref({ ...data.filters, tag: '' }, {}, { keepIds: false })), {
			keepFocus: true,
			noScroll: true
		});
	}

	/**
	 * The existing tag a typed bulk name resolves to, matched the way the server matches it (folded,
	 * accent-insensitive) rather than by raw string equality.
	 *
	 * The second allowed tinted surface. It answers the question the dialog otherwise leaves open:
	 * whether this is about to add to a tag that already exists, and which one — shown in that
	 * tag's own colour so it is the same object the user sees on their rows.
	 */
	const bulkTagMatch = $derived.by(() => {
		const typed = normalizeForMatch(bulkTagName.trim());
		if (!typed) return null;
		return data.allTags.find((t) => normalizeForMatch(t.name) === typed) ?? null;
	});

	function toTagChipItems(tags: Array<{ id: string; name: string; colorToken: string }>) {
		return tags.map((tag) => ({
			key: tag.id,
			name: tag.name,
			colorToken: isTagColorToken(tag.colorToken) ? (tag.colorToken as TagColorToken) : null
		}));
	}

	/**
	 * Applies one dimension of the filter, from a FilterDropdown selection.
	 *
	 * It navigates rather than submitting the surrounding GET form, and rather than letting the
	 * browser serialise a <select>: the trigger is a button opening a listbox, so there is no form
	 * control holding the value. `data.filters` is the server's own view of the filter, so this
	 * cannot drift from what produced the current page.
	 *
	 * `keepFocus` matters and is not decoration. SvelteKit's router blurs the active element and
	 * calls reset_focus() after a client-side navigation, which would throw focus to the body right
	 * after a selection and undo the focus-return the dropdown just performed. The same flag is why
	 * the period arrows on /upcoming-bills stopped stealing focus.
	 */
	function applyFilterDimension(patch: {
		category?: string;
		tag?: string;
		from?: string;
		to?: string;
		split?: string;
	}) {
		goto(resolve(buildTransactionsHref({ ...data.filters, ...patch }, {}, { keepIds: false })), {
			keepFocus: true,
			noScroll: true
		});
	}

	/**
	 * The category dimension's rows. No counts: the design puts a count on the tag menu only, and
	 * a per-category count is a separate load-shaped decision that has not been taken.
	 */
	const categoryFilterOptions = $derived(
		data.categoryOptions.map((name) => ({ value: name, label: categoryDisplayName(name) }))
	);

	/**
	 * The tag dimension's rows, alphabetical, always — one arrives with a name in mind, not with a
	 * volume, and a count-descending order would move rows on every filter change so a tag's
	 * position could never be memorised. Zero counts keep their alphabetical place, dimmed.
	 *
	 * A missing `tagCounts` (the server could not answer) is NOT zero: it yields `null`, which the
	 * dropdown renders as a placeholder rather than a digit, and leaves every row selectable —
	 * waiting on a count before choosing a name you already know would be absurd.
	 */
	const tagFilterOptions = $derived(
		data.allTags.map((tag) => {
			const count = data.tagCounts?.find((c) => c.tagId === tag.id)?.count ?? null;
			return {
				value: tag.id,
				label: tag.name,
				count: data.tagCounts === null ? null : (count ?? 0),
				// Reachable by the arrows so its state is announced, never activable: selecting it
				// would apply a filter the menu has just said returns nothing. Hiding it instead
				// would be indistinguishable from a deletion — and since a tag on zero transactions
				// really does disappear on its own, that confusion has a concrete cost.
				disabled: data.tagCounts !== null && (count ?? 0) === 0,
				swatchClass: isTagColorToken(tag.colorToken) ? tagColorBgClass(tag.colorToken) : undefined
			};
		})
	);

	/**
	 * The total for the "Toutes" return row: the filtered set with the tag dimension removed.
	 *
	 * `tagScopeTotal`, NOT `pagination.totalTransactions`. The latter is the tag-FILTERED total, so
	 * with `?tag=Portugal` active it rendered "Toutes 1" beside "Portugal 1" — telling the user that
	 * clearing the filter would change nothing, on the one row whose entire job is to say how much
	 * is waiting outside the current tag.
	 */
	const tagFilterAllCount = $derived(data.tagCounts === null ? null : data.tagScopeTotal);

	const activeCategoryLabel = $derived(
		data.filters.category
			? m.transactions_filter_active_trigger({
					dimension: m.transactions_filter_dimension_category(),
					value: categoryDisplayName(data.filters.category)
				})
			: undefined
	);

	const activeTagLabel = $derived(
		activeFilterTag
			? m.transactions_filter_active_trigger({
					dimension: m.tags_filter_dimension(),
					value: activeFilterTag.name
				})
			: undefined
	);

	/**
	 * The Répartition dimension. Exactly two rows plus the « Toutes » return row the component
	 * renders itself — "trois rangées, jamais plus".
	 *
	 * The zero row is written « 0 » and aria-disabled, following the tag rows, and the design notes
	 * that it can only ever be « Non répartie »: the control is not rendered at all until at least
	 * one répartition exists, so the répartie count cannot be zero while this list is on screen.
	 * The disabled flag is still computed from the count rather than hard-coded to the unsplit row —
	 * a rule derived from data outlives the reasoning that made it true today.
	 */
	const splitFilterOptions = $derived([
		{
			value: 'split',
			label: m.splits_filter_option_split(),
			count: data.splitCounts?.splitCount ?? null,
			disabled: data.splitCounts !== null && data.splitCounts.splitCount === 0
		},
		{
			value: 'unsplit',
			label: m.splits_filter_option_unsplit(),
			count: data.splitCounts?.unsplitCount ?? null,
			disabled: data.splitCounts !== null && data.splitCounts.unsplitCount === 0
		}
	]);

	const splitFilterAllCount = $derived(
		data.splitCounts === null ? null : data.splitCounts.splitCount + data.splitCounts.unsplitCount
	);

	const activeSplitLabel = $derived(
		data.filters.split === 'all'
			? undefined
			: m.transactions_filter_active_trigger({
					dimension: m.splits_filter_dimension(),
					value:
						data.filters.split === 'split'
							? m.splits_filter_option_split()
							: m.splits_filter_option_unsplit()
				})
	);

	/**
	 * Mobile-only: category and tag collapse behind one "Filtres" sheet instead of the desktop's
	 * two side-by-side dropdowns plus the date range — four controls that fit a 1280px bar but not
	 * a 390px card without pushing the submit button several swipes down. Search and the date
	 * range stay directly visible, unchanged: neither carries the "Dimension : Valeur" / "Toutes"
	 * grammar this sheet exists to collapse, and hiding a live search term behind a sheet would
	 * move it out of sight of where it was typed.
	 */
	let mobileFiltersOpen = $state(false);
	let mobileFilterSubDimension = $state<'category' | 'tag' | 'split' | null>(null);

	function closeMobileFiltersSheet() {
		mobileFiltersOpen = false;
	}

	function closeMobileFilterSubSheet() {
		mobileFilterSubDimension = null;
	}

	/** Category and tag are the only two dimensions behind the sheet — see the comment above. */
	const activeMobileFilterDimensionCount = $derived(
		(data.filters.category ? 1 : 0) + (activeFilterTag ? 1 : 0)
	);

	const mobileFiltersTriggerAriaLabel = $derived(
		activeMobileFilterDimensionCount === 0
			? m.transactions_filters_sheet_label()
			: activeMobileFilterDimensionCount === 1
				? m.transactions_filters_sheet_aria_one({ count: activeMobileFilterDimensionCount })
				: m.transactions_filters_sheet_aria_many({ count: activeMobileFilterDimensionCount })
	);

	/**
	 * The validation button says how many results the CURRENT filter set already returns, never
	 * "Appliquer": a selection made in the sub-sheet has already navigated — applyFilterDimension
	 * calls goto() immediately, same as the desktop dropdown — so `pagination.totalTransactions`
	 * is already the answer by the time this button is visible. Nothing is pending behind it.
	 */
	const mobileFiltersApplyLabel = $derived(
		data.pagination.totalTransactions === 1
			? m.transactions_filters_sheet_apply_one({ count: data.pagination.totalTransactions })
			: m.transactions_filters_sheet_apply_many({ count: data.pagination.totalTransactions })
	);

	// Same re-validation, for TagPicker's option list (TransactionTagsEditor -> TagPicker), whose
	// TagPickerOption.colorToken is the closed union rather than the raw database string. A row
	// that somehow failed the check is dropped rather than coerced: TagPicker has no "unknown
	// colour" rendering path the way TagChips does, so there is nothing honest to show for it.
	const allTagOptions = $derived(
		data.allTags.flatMap((tag) =>
			isTagColorToken(tag.colorToken) ? [{ ...tag, colorToken: tag.colorToken }] : []
		)
	);

	// Gates the bulk-tag trigger (design 6.5: "enabled only when a filter is active") and, by
	// construction, the dialog's own filter description below — the same four fields decide both,
	// so the trigger can never be enabled on a state the dialog would describe as empty. `type`
	// (the Toutes/Dépenses/Revenus/À classer tabs) is deliberately NOT one of them: this codebase's
	// vocabulary reserves "filter" for the narrowing controls the design lists by name (period,
	// category, search term, tag), the tab is a view. An invalid range/search must not enable it
	// either — a dialog naming an error as if it were a set of transactions is worse than a
	// momentarily inert button.
	const bulkTagFilterActive = $derived(
		Boolean(
			(data.filters.category ||
				data.filters.tag ||
				data.filters.from ||
				data.filters.to ||
				data.filters.q) &&
			!data.dateRangeError &&
			!data.queryError
		)
	);

	/**
	 * The trigger writes its own scope: "Étiqueter les 6 résultats", never a bare verb.
	 *
	 * The design puts the count in the LABEL and says why: "on sait ce qu'on va toucher avant même
	 * d'ouvrir la modale". Shipping it as "Appliquer une étiquette" moved that knowledge one click
	 * later, into the ConfirmDialog — which names the count correctly, but only once the user has
	 * already committed to opening it. Observed live against a filter matching 66 rows, and again
	 * at 301: nothing on the button said so.
	 *
	 * It is also what answers "should a `.*` regex, matching every row, count as a filter?" — it
	 * does, and it now announces itself as the whole set before anything opens, which is what the
	 * question was really asking for. Comparing the filtered count against the unfiltered total
	 * instead would disable the button on coincidence (one category that happens to match
	 * everything) and make the disabled hint's "activate a filter first" a false statement.
	 *
	 * `pagination.totalTransactions` is the FILTERED set size, not the page's — the same number the
	 * dialog quotes, so the two can never disagree.
	 */
	/**
	 * Whether ANY narrowing filter is on. Distinct from `bulkTagFilterActive`, which additionally
	 * requires the filter to be valid: an invalid range or regex still means the user is filtering
	 * (so the summary row must offer "Réinitialiser") while the bulk action must stay inert (a
	 * dialog naming an error as if it were a set of transactions is worse than a dead button).
	 */
	/**
	 * The two column sets, switched by the selection alone.
	 *
	 * Selected — `1fr / 140 / 190 / 110` — is TODAY'S set, byte for byte. The unselected set is the
	 * one that gains air; nothing is taken away when the panel opens, so a user who has learnt where
	 * a column sits does not find it moved. The chip cap (110px, in `TagChips`) is the same figure in
	 * both: the column breathes, the chip does not grow.
	 *
	 * The narrowing is strictly HORIZONTAL and carries no transition on purpose. Animating it over
	 * 160ms moves the targets during the exact window in which a user chains a second gesture, and
	 * `prefers-reduced-motion` would have to remove it anyway — two behaviours specified for one
	 * aesthetic gain. The row aimed at therefore stays on its own line at its exact ordinate.
	 */
	const detailOpen = $derived(data.selectedTransaction !== null);
	/**
	 * CATÉGORIE IS 176/200, NOT THE PLATE'S 140/160, AND THE PLATE'S OWN FIGURE IS WHAT MOVED.
	 *
	 * 1m states « à 140 px, "Alimentation" plus le badge occupent 126 px des 140 disponibles ». That
	 * measured the wrong box: 140 is the COLUMN, and `px-4` on the inner block takes 16 + 16, so the
	 * usable content is 108. Measured in Chromium at 14px, the real figures are dot 8 + gap 6 + name,
	 * plus gap 6 + badge 24 when the row is répartie:
	 *
	 *   Alimentation        79.28 → 93.28 plain, 123.28 with the badge
	 *   Abonnements         87.11 → 101.11 plain, 131.11 with the badge
	 *   Factures & énergie 115.56 → 129.56 plain   (the longest DEFAULT category)
	 *   Produits ménagers  118.03 → 132.03 plain   (a user-authored one, and the reported case)
	 *
	 * So at 108 the plate's own demonstration row truncates, and « Abonnements » truncates at the
	 * roomy set too. 184 gives 152 of content — 138 to the name on a plain row, 108 with a badge —
	 * and 200 gives 168, i.e. 154 plain and 124 with a badge. Both hold every label above on a plain
	 * row, including the 134.28 of « Loisirs et équipement », which 176 still cut by four pixels.
	 * A répartie row is a different promise and the plate makes it explicitly: « l'ellipse fait son
	 * travail sans que le décompte ne cède » — the badge is `shrink-0`, so what gives way there is
	 * the name, never the count.
	 *
	 * THE 36/40 px COME FROM LIBELLÉ, THE 1fr COLUMN, AND FROM NOTHING ELSE. Étiquettes has no slack
	 * to give: `TagChips` caps a chip at 110px, so two chips already exceed the 158 of content that
	 * 190 leaves — the column is at its own minimum, and it is empty in the reported fixture only by
	 * accident of that data. Libellé measured 682.5 roomy and 348.5 open against a `max-w-[260px]`
	 * label, so it is the only column carrying real slack; after the change it is 642.5 and 304.5,
	 * both still above the 292 that cap plus padding needs.
	 */
	const colCategory = $derived(detailOpen ? 'w-[184px]' : 'w-[200px]');
	const colTags = $derived(detailOpen ? 'w-[190px]' : 'w-[240px]');
	const colAmount = $derived(detailOpen ? 'w-[110px]' : 'w-[130px]');

	/**
	 * How a row says it is the selected one.
	 *
	 * NOT `aria-selected`. That attribute is only supported on `option`, `row` inside a
	 * `grid`/`treegrid`, `tab`, `columnheader`, `rowheader` and `gridcell`. This is a plain
	 * `<table>`: a `<tr>` does get the implicit `row` role, but outside a grid that role does not
	 * support `aria-selected`, so setting it is invalid ARIA that assistive technology may ignore or
	 * misreport. Adopting `role="grid"` to make it valid is not a one-attribute change — it obliges
	 * the full grid keyboard model (arrows cell to cell, Home/End, one tab stop with roving
	 * tabindex) for the entire transactions table, changing how every existing user navigates it.
	 *
	 * `aria-current="true"` is what is actually true here: selecting a row is a NAVIGATION (the label
	 * is an `<a href="?selected=id">` and the server answers with `selectedTransaction`), and
	 * `aria-current` means exactly "the current item within a set of related items". It is a global
	 * attribute, valid on any element.
	 *
	 * The 3px black left edge is the non-chromatic half of the signal, and it is the half the design
	 * actually protects: it doubles the zinc-50 fill so selection never rests on a shade of grey.
	 * Unselected rows carry the same 3px in `transparent` — without it, selecting a row would shift
	 * every cell 3px to the right, which is the horizontal twin of the vertical jump this whole
	 * reflow exists to avoid.
	 */
	function rowStateClass(id: string): string {
		return data.selectedTransaction?.id === id
			? 'border-l-[3px] border-l-zinc-900 bg-zinc-50 ring-1 ring-zinc-900/10 ring-inset'
			: 'border-l-[3px] border-l-transparent hover:bg-zinc-50/50';
	}

	const anyFilterActive = $derived(
		Boolean(
			data.filters.category ||
			data.filters.tag ||
			data.filters.from ||
			data.filters.to ||
			data.filters.q
		)
	);

	/**
	 * The trigger is RENDERED whenever a filter is active and merely inert when it cannot act —
	 * including when the user owns no tag at all. Deliberately unlike the tag FILTER, which is not
	 * rendered at all in that case: a filter with no possible value has nothing to offer, whereas an
	 * unavailable action has to teach the condition under which it becomes available.
	 */
	const bulkTagEnabled = $derived(
		bulkTagFilterActive && data.allTags.length > 0 && data.pagination.totalTransactions > 0
	);

	/**
	 * Why the trigger is inert, in the three states where it is rendered and cannot act.
	 *
	 * There is deliberately no "activate a filter first" branch any more. The trigger is not
	 * rendered at all without a filter — its absence IS that message, and tagging 142 transactions
	 * in one gesture is out of scope by design: the trigger is born with the first filter, which is
	 * what defines it. Keeping the old sentence would have made it fire in the one remaining case
	 * that reaches it, an INVALID filter, where "activate a filter first" is simply false: one is
	 * active, it just does not parse.
	 */
	const bulkTagDisabledReason = $derived(
		!bulkTagFilterActive
			? m.tags_bulk_cta_invalid_filter_hint()
			: data.allTags.length === 0
				? m.tags_bulk_cta_no_tags_hint()
				: m.tags_bulk_cta_no_results_hint()
	);

	const bulkTagCtaLabel = $derived(
		!bulkTagEnabled
			? m.tags_bulk_cta_disabled()
			: data.pagination.totalTransactions === 1
				? m.tags_bulk_cta_one()
				: m.tags_bulk_cta_many({ count: data.pagination.totalTransactions })
	);

	/**
	 * Human description of the active filter for the bulk-tag ConfirmDialog, built from the exact
	 * same four fields as `bulkTagFilterActive`. A count alone is ambiguous — it lets a stale or
	 * partially-applied filter pass unnoticed — so the dialog must say WHICH transactions, not just
	 * how many (task 6.2 step 3). Joined with " · ", the same ad-hoc separator `sheetMeta` in
	 * upcoming-bills/+page.svelte already uses for fragment lists: punctuation, not translated
	 * content.
	 */
	function describeBulkTagFilter(): string[] {
		const fragments: string[] = [];
		if (data.filters.from && data.filters.to) {
			fragments.push(
				m.tags_bulk_filter_period_between({
					from: formatDate(data.filters.from),
					to: formatDate(data.filters.to)
				})
			);
		} else if (data.filters.from) {
			fragments.push(m.tags_bulk_filter_period_from({ from: formatDate(data.filters.from) }));
		} else if (data.filters.to) {
			fragments.push(m.tags_bulk_filter_period_until({ to: formatDate(data.filters.to) }));
		}
		if (data.filters.category) {
			fragments.push(
				m.tags_bulk_filter_category({ category: categoryDisplayName(data.filters.category) })
			);
		}
		if (data.filters.q) {
			fragments.push(m.tags_bulk_filter_search({ query: data.filters.q }));
		}
		if (data.filters.tag) {
			const tagName = data.allTags.find((t) => t.id === data.filters.tag)?.name ?? '';
			if (tagName) fragments.push(m.tags_bulk_filter_tag({ tag: tagName }));
		}
		return fragments;
	}

	function openBulkTag(): void {
		if (!bulkTagFilterActive) return;
		bulkTagName = '';
		bulkTagOpen = true;
	}

	function closeBulkTag(): void {
		bulkTagOpen = false;
	}

	// The action URL is built from the SAME filters `?/bulkTag` reads server-side
	// (via `resolveTransactionScope` in $lib/server/transactions/scope.ts, driven from
	// `url.searchParams`), because the plain shorthand `action="?/bulkTag"` would resolve against
	// the current URL and REPLACE its query string entirely — dropping every active filter and
	// applying the tag to an unfiltered set. `buildTransactionsHref` already emits exactly the
	// params `resolveTransactionScope` consumes (q, qMode, category, from, to, importBatch, tag,
	// type, ids), so appending the bare action marker to it keeps the two in lockstep with no
	// separate list to maintain.
	const bulkTagActionHref = $derived(
		`${buildTransactionsHref(data.filters, {}, { keepIds: true })}&/bulkTag`
	);

	const bulkTagResult = $derived(form && 'bulkTagResult' in form ? form.bulkTagResult : null);
	const bulkTagEmpty = $derived(form && 'bulkTagEmpty' in form ? form.bulkTagEmpty : false);
	const undoBulkTagSuccess = $derived(
		form && 'undoBulkTagSuccess' in form ? form.undoBulkTagSuccess : false
	);

	// Closes the dialog on any successful outcome (applied or empty); an error leaves it open so
	// `form.bulkTagError` renders next to the field the user just submitted, same as the delete
	// confirmation's own `form?.deleteError`.
	$effect(() => {
		if (bulkTagResult || bulkTagEmpty) bulkTagOpen = false;
	});

	$effect(() => {
		const tx = data.selectedTransaction;
		openSections = new Set();
		manualCategoryValue = tx?.manualCategory ?? '';
		manualNatureValue = tx?.manualNature ?? '';
		// Same reset as the two above, and for the same reason: an editor opened on one transaction
		// must not be found open on the next one. After a save the load re-runs and `splitParts` is
		// what keeps the editor on screen, so this closes the DRAFT only — never a real répartition.
		splitDraftOpen = false;
		// Only dismiss a pending delete confirmation when the user actively switches to a
		// *different* transaction (desktop: clicking another row). Deselecting to null — which
		// is exactly what the mobile flow does to close the sheet behind the dialog — must not
		// close it; pendingDelete already carries what the dialog needs independently.
		if (pendingDelete && tx && tx.id !== pendingDelete.id) {
			deleteConfirmOpen = false;
			pendingDelete = null;
		}
	});

	function openDeleteConfirm(tx: { id: string; label: string; amountCents: number }) {
		pendingDelete = { id: tx.id, label: tx.label, amountCents: tx.amountCents };
		deleteConfirmOpen = true;
	}

	function closeDeleteConfirm() {
		deleteConfirmOpen = false;
		pendingDelete = null;
	}

	function toggleSection(id: string) {
		// Plain Set + copy-and-reassign idiom (not SvelteSet): already correct and tested as-is;
		// migrating to SvelteSet's in-place add()/delete() is a real reactivity-pattern change,
		// deferred rather than forced during this lint cleanup.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const next = new Set(openSections);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		openSections = next;
	}

	function getCategoryColor(categoryName: string): string {
		return resolveCategoryColorClass(categoryName, UNCLASSIFIED_CATEGORY);
	}

	const CURRENT_YEAR = new Date().getFullYear();
	function formatDate(dateStr: string): string {
		const [y, m, d] = dateStr.split('-').map(Number);
		const monthName = new Date(y, m - 1, 1).toLocaleString(getLocale(), { month: 'long' });
		return y === CURRENT_YEAR ? `${d} ${monthName}` : `${d} ${monthName} ${y}`;
	}

	function formatNatureLabel(nature: string | null): string {
		return nature && isTransactionNature(nature) ? natureLabel(nature) : m.nature_uncategorized();
	}

	function formatNatureSource(source: string) {
		if (source === 'manual') return m.transactions_nature_source_manual();
		if (source === 'category') return m.transactions_nature_source_category();
		return m.transactions_nature_source_default();
	}

	// Always passes the DESTINATION tab, never {}. An absent override means "keep the ambient
	// filter", which is what paging needs and the exact opposite of what a filter tab needs:
	// passing {} for 'all' made the "Toutes" tab re-emit the filter it exists to clear.
	const buildFilterHref = (filterType: string) =>
		buildTransactionsHref(data.filters, { type: filterType }, { keepIds: false });
	/**
	 * The over-cap banner's escape route, and NOT `buildFilterHref`.
	 *
	 * `buildFilterHref` drops `?ids=` on purpose — a tab switch visibly changes the list, so the user
	 * should see they left "the transactions linked to this bill" behind. That rule is right for a
	 * tab and wrong here: the count in the banner was MEASURED inside the id filter, so a link that
	 * drops it lands the user somewhere the number does not describe. A banner that names a figure
	 * has to carry every filter that figure was measured under.
	 *
	 * Unreachable today only by coincidence: `MAX_TRANSACTION_ID_FILTER` caps `?ids=` at 250 and
	 * `MAX_BULK_TAG_TRANSACTIONS` is also 250, so the over-cap gate cannot open while an id filter is
	 * active. Both constants document that they are free to diverge, and the day either moves this
	 * becomes a false claim with a number the user can check — the /upcoming-bills defect from #99,
	 * in the feature whose own comment cites #99 as the reason to compute the count at all.
	 */
	const buildBulkFallbackHref = (kind: string) =>
		buildTransactionsHref(data.filters, { type: kind }, { keepIds: true });

	const buildPageHref = (page: number) =>
		buildTransactionsHref(data.filters, { page: String(page) }, { keepIds: true });
	const buildSelectedHref = (id: string) =>
		buildTransactionsHref(
			data.filters,
			{ page: String(data.pagination.page), selected: id },
			{ keepIds: true }
		);
	// Closing the panel is a navigation dropping `selected`, not a local flag: the selection lives in
	// the URL, so a component-level `open = false` would be undone by the next reload or Back. The
	// param is OMITTED rather than emitted empty — `{ selected: '' }` would put a bare `selected=` in
	// the address bar, which reads as a broken link even though the server treats it as no selection.
	const buildDeselectedHref = () =>
		buildTransactionsHref(data.filters, { page: String(data.pagination.page) }, { keepIds: true });
	/**
	 * The row's own link toggles. A second click on the already-selected row closes the panel, which
	 * is one of the four closing gestures; the other three are the header cross, Escape from inside
	 * the panel, and — deliberately — NOT a click beside it. The panel is not modal, so it has no
	 * outside; a click-away would close it every time the user reached for anything else on the page.
	 */
	const buildRowHref = (id: string) =>
		data.selectedTransaction?.id === id ? buildDeselectedHref() : buildSelectedHref(id);

	/**
	 * The split form's action, carrying the CURRENT selection and filters through the POST.
	 *
	 * A bare `action="?/saveSplits"` posts to `/transactions?/saveSplits`, and that query string is
	 * the WHOLE query string — `selected` goes with it, so the panel the form lives in is gone by the
	 * time the response renders. Measured, not reasoned: the first e2e run of this flow saved the
	 * répartition correctly (the Répartition filter appeared, which only happens once the user owns a
	 * part) and then found no success banner, because there was no panel left to hold one. SvelteKit
	 * reads the action from the search param whose key starts with `/`, so every other param riding
	 * along is preserved rather than parsed.
	 *
	 * The three sibling forms in this panel — manual category, manual nature, étiquettes — have the
	 * same shape and all close the panel on save. That is pre-existing and is left alone here; it
	 * matters more for this one because 1j-B's edit state and 1i's success message are both things
	 * the user is meant to SEE after saving.
	 */
	const splitFormAction = $derived(
		data.selectedTransaction
			? `${buildSelectedHref(data.selectedTransaction.id)}&/saveSplits`
			: '?/saveSplits'
	);

	/**
	 * The ONE way the detail closes, whichever gesture asked for it: the header cross, Escape, a
	 * second click on the selected row, and the mobile sheet's own backdrop and close control.
	 *
	 * It was briefly two. Escape got a handler on the desktop `<aside>` while BottomSheet's
	 * `svelte:window` keydown was already closing the same selection — the sheet is mounted at every
	 * breakpoint and only hidden by CSS — so one keystroke fired two `goto`s at two slightly
	 * different URLs and pushed two history entries. Both halves looked correct in isolation, which
	 * is exactly why the duplicate was invisible: the panel did close.
	 *
	 * Escape therefore stays where it already was, on BottomSheet's window listener, and the layering
	 * still holds for the reason it always did: TagPicker calls `stopPropagation()` on Escape while
	 * its list is open, so the first keystroke never reaches window and closes only the picker.
	 *
	 * Focus goes back to the row the user came from. `goto` runs SvelteKit's `reset_focus()`, which
	 * lands on `<body>`, so without this the next Tab restarts at the top of the page. Both surfaces
	 * are tried because both are mounted: the desktop `<tr>`'s link, then the mobile ListCard's.
	 * The delete flow is the one exception — it closes the sheet with ConfirmDialog open and holding
	 * focus, and stealing it would break that modal's Tab trap. (Not detectable via
	 * `document.activeElement`: the sheet's 220ms exit transition keeps it, and the focus inside it,
	 * in the DOM past `goto`'s resolution.)
	 */
	async function closeDetail() {
		const id = data.selectedTransaction?.id;
		await goto(resolve(buildDeselectedHref()), { noScroll: true });
		if (!id || deleteConfirmOpen) return;
		// Both surfaces are MOUNTED at every breakpoint and only hidden by CSS, so "the desktop one
		// first" is wrong: on a phone it exists, is `display: none`, and swallows the focus silently.
		// `offsetParent === null` is the cheap test for "not rendered", and it is what decides which
		// of the two the user is actually looking at.
		const candidates = [
			document.querySelector<HTMLElement>(`[data-testid="tx-row-${id}"] a`),
			document.getElementById(`tx-row-${id}`)
		];
		candidates.find((el) => el !== null && el.offsetParent !== null)?.focus();
	}

	const buildExportHref = () => buildTransactionsExportHref(data.filters);

	function openRuleModal(
		id: string,
		label: string,
		suggestion: { category: string; nature: string | null } | null
	) {
		ruleTarget = {
			id,
			label,
			matchText: label.slice(0, 80),
			targetCategory: suggestion?.category ?? '',
			targetNature: suggestion?.nature ?? ''
		};
		createRuleOpen = true;
	}

	let quickAcceptDone: ((success: boolean) => void) | null = null;
	let quickCreateRuleDone: ((success: boolean, autoAppliedIds: string[]) => void) | null = null;

	function submitAndWait(
		formEl: HTMLFormElement | null,
		setResolver: (resolve: (success: boolean) => void) => void
	): Promise<boolean> {
		return new Promise((resolve) => {
			setResolver(resolve);
			formEl?.requestSubmit();
		});
	}

	function submitCreateRuleAndWait(): Promise<{ success: boolean; autoAppliedIds: string[] }> {
		return new Promise((resolve) => {
			quickCreateRuleDone = (success, autoAppliedIds) => resolve({ success, autoAppliedIds });
			quickCreateRuleFormEl?.requestSubmit();
		});
	}

	// Transient "N transactions auto-classified" banner (auto-hides): explains why the
	// counter/stack jumps after creating a rule in focus mode that matches other remaining
	// items — without it, the jump would look like a bug rather than intended behavior.
	let focusAutoAppliedCount = $state(0);
	let focusAutoAppliedTimer: ReturnType<typeof setTimeout> | null = null;

	function showFocusAutoAppliedToast(count: number) {
		focusAutoAppliedCount = count;
		if (focusAutoAppliedTimer) clearTimeout(focusAutoAppliedTimer);
		focusAutoAppliedTimer = setTimeout(() => {
			focusAutoAppliedCount = 0;
		}, 2500);
	}

	// Focus mode: "Create a rule" categorizes the current transaction (like "Accept" with the
	// same selection), THEN creates the rule for future transactions — with no intermediate
	// modal step, to keep the fast triage rhythm. Both hidden forms reuse ?/acceptSuggestion
	// and ?/createRule as-is (no duplicated server logic). The created rule is never applied
	// retroactively to the full history (only "Apply rules" does that) — only to the REMAINING
	// items of the current focus session's frozen stack (focusStackIds, see quickCreateRuleFormEl
	// below which sends focusRemainingIds to the server): matching ones are marked resolved
	// here, so they're automatically skipped by the getAdjacentFocusStackId call that follows,
	// with no dedicated skip logic to write.
	// await tick(): lets Svelte commit the values into the hidden inputs before requestSubmit(),
	// otherwise the form would still submit the previous values.
	async function createRuleInFocusMode(
		id: string,
		label: string,
		category: string,
		nature: string | null
	) {
		const remainingBeforeRuleCreation = getRemainingFocusStackIds(
			focusStackIds,
			new Set([...resolvedIds, ...ignoredIds, id])
		);

		quickAcceptTarget = { id, category, nature: nature ?? '' };
		quickCreateRuleTarget = {
			id,
			name: label.slice(0, 40),
			matchText: label.slice(0, 80),
			targetCategory: category,
			targetNature: nature ?? ''
		};
		quickCreateRuleRemainingIds = remainingBeforeRuleCreation;
		await tick();

		const accepted = await submitAndWait(quickAcceptFormEl, (resolve) => {
			quickAcceptDone = resolve;
		});
		if (!accepted) return;

		const { success: ruleCreated, autoAppliedIds } = await submitCreateRuleAndWait();
		if (!ruleCreated) return;

		if (autoAppliedIds.length > 0) {
			// Only keep ids actually in the remaining frozen stack (the server only returns ids
			// already scoped to the sent focusRemainingIds, but double-checking here costs nothing
			// and protects against the sent list's shape changing one day).
			const applied = autoAppliedIds.filter((appliedId) =>
				remainingBeforeRuleCreation.includes(appliedId)
			);
			if (applied.length > 0) {
				resolvedIds = new Set([...resolvedIds, ...applied]);
				showFocusAutoAppliedToast(applied.length);
			}
		}

		applyFocusOutcome('createRule', id);
	}

	// The mobile sheet's close gestures (backdrop, cross, Escape) are the same event as the desktop
	// panel's, so they run the same function. Kept as a named alias rather than passing closeDetail
	// directly, because BottomSheet's prop is what documents WHO is asking.
	const closeMobileSheet = closeDetail;

	/**
	 * Which of the design's three totals states applies (section 4C, "TROIS ÉTATS QUI NE SE
	 * RESSEMBLENT PAS").
	 *
	 * The error branch comes FIRST and is decided by the flags, never by the figures: when the query
	 * is rejected the server zeroes `filteredTotals` AND `pagination.totalTransactions` because it
	 * has no answer (+page.server.ts), so reading the numbers alone cannot tell "the filter matched
	 * nothing" from "the filter never ran". Those two used to render identically — both as no totals
	 * line at all — which is how a rejected regex came to be reported as "0 transaction".
	 */
	const filteredTotalsState = $derived(
		data.queryError || data.dateRangeError
			? 'error'
			: data.filteredTotals.incomeCents === 0 && data.filteredTotals.expenseCents === 0
				? 'zero'
				: 'normal'
	);

	/** The design's placeholder for "we do not know", and the reason it is a dash and not a zero:
	 *  "un tiret n'est pas un montant : il dit « on ne sait pas », ce qui est exactement la vérité".
	 *  A literal, not a translated message — it is a symbol standing in for a figure, identical in
	 *  every locale, and nothing about it is prose. */
	const TOTALS_UNKNOWN = '—';

	type Tab = { t: string; label: string; badge?: number };
	const TABS: Tab[] = [
		{ t: 'all', label: m.transactions_filter_all() },
		{ t: 'expense', label: m.reports_kpi_expense() },
		{ t: 'income', label: m.reports_kpi_income() }
	];
	const visibleTabs = $derived<Tab[]>(
		data.uncategorizedCount > 0 || data.filters.type === 'classify'
			? [
					...TABS,
					{
						t: 'classify',
						label: m.transactions_classify_tab_label(),
						badge: data.uncategorizedCount
					}
				]
			: TABS
	);
</script>

<!-- 1r's first moment. The handler itself explains why it is guarded. -->
<svelte:document onvisibilitychange={handleTabReturn} />

<svelte:head>
	<title>{m.transactions_page_title()}</title>
</svelte:head>

<!--
	`?ids=` is the one active filter with NO field of its own to echo it: `q`, `category`, the dates
	and the tab all render their own value, so the user can see why the list is short and undo it.
	Without this the bar looks empty while the list shows 5 rows out of 5000. Rendered in the same
	slot as the query/date errors in both filter bars, and paired with the "Réinitialiser" control
	already sitting next to it, so it needs no new escape hatch of its own.
-->
<!--
	The filtered-set totals, one snippet rendered on both surfaces so the three states cannot be
	fixed on the desktop header and forgotten on the mobile one.

	ONE live region for all three states, and its `role` never changes: the design is explicit that
	an element switching status → alert mid-flight "n'est pas détecté de façon fiable par tous les
	lecteurs d'écran", so the failure is announced by its CONTENT — "Totaux indisponibles" is the
	first thing read — rather than by escalating politeness. It is rendered unconditionally for the
	same reason: a region that appears only when it has something to say has no stable identity to
	announce into.

	Deliberately NO retry control, against the design's own sketch of this state. The design imagines
	"requête échouée", a transient failure worth re-running. Both error branches this page actually
	has are rejected USER INPUT — an invalid regex, an invalid date range — so a "Réessayer" would
	re-submit the same rejected filter and fail identically. That is the "recommends the one action
	that cannot help" defect closed in #99, and offering it here would re-create it. What is
	actionable already sits next to the field that caused it ("Expression régulière invalide.").
-->
{#snippet bulkOverLimitBanner()}
	<!-- The refusal, BEFORE the user opens the dialog, beside the filter it asks them to narrow.
	     It shipped as a rose/danger inline error inside the dialog: honest prose in a `role="alert"`
	     region, so no claim was false — but the tone said "you broke something" for a cap the user
	     had no way of knowing about, and it was only reachable by opening a dialog that then refused.
	     Amber, and up front.
	     The fallback is COMPUTED, with its real count, so the user sees which narrowing passes before
	     clicking anything. When neither half of the nature split lands under the cap there is no
	     fallback and no action at all — a proposal that cannot help is the /upcoming-bills defect
	     closed in #99, and here it would be worse, because it would name a number. -->
	{#if bulkTagFilterActive && data.pagination.totalTransactions > MAX_BULK_TAG_TRANSACTIONS}
		<AlertBanner variant="warning" class="mt-3">
			{m.tags_bulk_over_limit_title({
				count: data.pagination.totalTransactions,
				limit: MAX_BULK_TAG_TRANSACTIONS
			})}
			{m.tags_bulk_over_limit_body()}
			{#if data.bulkFallback}
				{data.bulkFallback.kind === 'expense'
					? m.tags_bulk_over_limit_fallback_expense({ count: data.bulkFallback.count })
					: m.tags_bulk_over_limit_fallback_income({ count: data.bulkFallback.count })}
			{/if}
			{#snippet action()}
				{#if data.bulkFallback}
					<a
						href={resolve(buildBulkFallbackHref(data.bulkFallback.kind))}
						class="shrink-0 self-center font-semibold text-amber-900 underline underline-offset-2"
					>
						{m.tags_bulk_over_limit_action()}
					</a>
				{/if}
			{/snippet}
		</AlertBanner>
	{/if}
{/snippet}

{#snippet bulkTagBanner()}
	<!-- Placement is load-bearing, not cosmetic. The design declines to move focus after a bulk
	     apply, and justifies that with where this banner sits: "« Annuler » est le tout premier
	     arrêt de tabulation après le déclencheur… C'est ce placement dans le DOM qui rend le
	     non-déplacement acceptable — s'il était rendu ailleurs dans la page, la décision inverse
	     s'imposerait."
	     It first rendered above the filter bar, which put Annuler 16 focusable stops BEFORE the
	     trigger. It then rendered under both filter bars, which was correct while the trigger lived
	     in the bar — and became wrong again the moment the trigger descended into the summary row,
	     putting the undo one stop EARLIER than the control it undoes. The invariant is "immediately
	     after the trigger", not "under the filter bar", so the banner now follows the trigger into
	     the summary row on both surfaces. The hidden breakpoint contributes no tab stop, so the two
	     copies cannot drift apart. -->
	{#if bulkTagResult}
		{#key bulkTagResult}
			<!-- Approved deviation from the 4s auto-dismiss every other success banner on this page
				     uses: an undo the user cannot reach because it vanished is worse than a banner that
				     lingers. `Infinity`, not a large finite value — setTimeout clamps/fires near-
				     immediately past the 32-bit signed int delay limit (~24.8 days), so a large-but-
				     finite number would silently misbehave instead of meaning "never" (see
				     AlertBanner.svelte's own comment on autoDismissMs). -->
			<AlertBanner variant="success" autoDismissMs={Infinity}>
				{m.tags_bulk_banner_applied({
					count: bulkTagResult.appliedCount,
					tag: bulkTagResult.tagName
				})}
				{#snippet action()}
					<button
						type="submit"
						form="bulk-tag-undo-banner"
						disabled={bulkTagUndoSubmitting}
						class="-my-2.5 inline-flex min-h-11 shrink-0 items-center rounded font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
					>
						{m.tags_bulk_banner_undo()}
					</button>
				{/snippet}
			</AlertBanner>
		{/key}
	{:else if bulkTagEmpty}
		{#key form}
			<AlertBanner variant="success">{m.tags_bulk_banner_empty()}</AlertBanner>
		{/key}
	{:else if undoBulkTagSuccess}
		{#key form}
			<AlertBanner variant="success">{m.tags_bulk_banner_undone()}</AlertBanner>
		{/key}
	{/if}
{/snippet}

{#snippet summaryCount()}
	<!-- "142 transactions" with no filter — the whole set, not a result — and "6 résultats" with
	     one. ONE WORD PER CONCEPT: the bar previously said "6 transactions filtrées" here while the
	     bulk trigger said "Étiqueter les 6 résultats", naming the same thing two ways. The locked
	     trigger label is the one that wins, so this follows it.
	     Suppressed entirely in the error state, not rendered as zero: the server sets the count to 0
	     because it has no answer, so printing it asserts an evaluated, empty result set that never
	     existed. The totals region beside it says what actually happened instead. -->
	{#if filteredTotalsState !== 'error'}
		<p data-testid="summary-count" class="text-sm text-zinc-600">
			{#if anyFilterActive}
				{data.pagination.totalTransactions === 1
					? m.transactions_results_one({ count: data.pagination.totalTransactions })
					: m.transactions_results_many({ count: data.pagination.totalTransactions })}
			{:else}
				{data.pagination.totalTransactions === 1
					? m.transactions_total_one({ count: data.pagination.totalTransactions })
					: m.transactions_total_many({ count: data.pagination.totalTransactions })}
			{/if}
		</p>
	{/if}
{/snippet}

{#snippet summaryActions(surface: string)}
	<!-- The two conditional controls. The ROW is always rendered because it carries the totals a
	     user has today with no filter at all; only these two depend on a filter being active. The
	     bulk trigger lives here rather than in the filter bar: posed between four filter controls it
	     read as a fifth filter, and here it is against the wall of the number defining its scope.
	     Both sit OUTSIDE the role="status" region — inside it, every filter change would re-announce
	     "Réinitialiser les filtres, bouton" along with the figures. -->
	{#if anyFilterActive}
		<!-- Stacked on mobile, side by side on desktop. Flat, this row overflowed the 390 viewport by
		     67px: the trigger label is a whole sentence ("Étiqueter les 5 résultats", 358px), the
		     reset link sits beside it, and the caller made the trigger `w-full` — 100% of a container
		     that still had to hold the link too. Nothing clipped it, so the DOCUMENT scrolled
		     sideways; it was the only element on the page that overflowed at 390.
		     Design 9A asks for the grouped trigger full-width on its own row in the summary card
		     anyway, so the stack is the design's arrangement and not merely a way out of the overflow.
		     `surface` rather than a Tailwind arbitrary variant reaching in from the call site: the
		     snippet already knows which surface it is rendering, and a `[&>div]:` selector describing
		     this layout from the outside is what produced the half-applied version. -->
		<div
			class="flex items-center gap-2 {surface === 'mobile'
				? 'w-full flex-col items-stretch'
				: 'shrink-0'}"
		>
			<!-- The testid sits on a wrapper because TapLink takes a fixed prop list with no rest
			     spread, so an unknown attribute is silently dropped rather than forwarded. -->
			<span data-testid="reset-filters">
				<TapLink href="/transactions">{m.transactions_reset_filters_link()}</TapLink>
			</span>
			<!-- Not a filled button: it acts on many rows at once and must not draw the eye before
			     the number to its left has been read. -->
			<button
				type="button"
				data-testid="bulk-tag-trigger"
				class="inline-flex h-11 items-center justify-center rounded-xl border px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 focus-visible:outline-none {surface ===
				'mobile'
					? 'w-full'
					: 'shrink-0'} {bulkTagEnabled
					? 'border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50'
					: 'cursor-not-allowed border-zinc-200 bg-white text-zinc-500'}"
				aria-disabled={bulkTagEnabled ? undefined : 'true'}
				aria-describedby={bulkTagEnabled ? undefined : `bulk-tag-reason-${surface}`}
				onclick={bulkTagEnabled ? openBulkTag : undefined}
			>
				{bulkTagSubmitting ? m.tags_bulk_applying() : bulkTagCtaLabel}
			</button>
		</div>
	{/if}
{/snippet}

{#snippet summaryDisabledReason(surface: string)}
	<!-- Native `disabled` would drop the trigger from the tab order and announce nothing; the
	     explanation has to stay reachable at the keyboard, which is why aria-disabled is used and
	     why this sentence is a real element aria-describedby can point at rather than a title. -->
	{#if anyFilterActive && !bulkTagEnabled}
		<p id="bulk-tag-reason-{surface}" class="mt-2 text-sm text-zinc-500">
			{bulkTagDisabledReason}
		</p>
	{/if}
{/snippet}

{#snippet filteredTotalsRegion()}
	<!-- The design's band reads "Dépenses −3 418,90 €   Revenus +4 260,00 €": each figure LABELLED
	     and SIGNED, on the same line as the count. It shipped as "42,50 € encaissés · 1 402,66 €
	     dépensés" — value first, label after, magnitudes with no sign, stacked on a second line
	     under the count. Both halves mattered: a reader scanning a column of figures finds the label
	     first, and the sign is what says which direction the money went without reading the word.
	     The three states are unchanged (error keeps the em dashes, zero keeps its own label), because
	     amendment 1 is explicit that the error state must not be weakened. -->
	<p
		data-testid="filtered-totals"
		role="status"
		aria-live="polite"
		class="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs tabular-nums {filteredTotalsState ===
		'error'
			? 'text-amber-700'
			: 'text-zinc-500'}"
	>
		{#if filteredTotalsState === 'error'}
			<span>{m.transactions_totals_unavailable_label()}</span>
			<span>{m.transactions_totals_expense_label()} {TOTALS_UNKNOWN}</span>
			<span>{m.transactions_totals_income_label()} {TOTALS_UNKNOWN}</span>
		{:else if filteredTotalsState === 'zero'}
			<span>{m.transactions_totals_zero_label()}</span>
			<span>{m.transactions_totals_expense_label()} {formatCents(0)}</span>
			<span>{m.transactions_totals_income_label()} {formatCents(0)}</span>
		{:else}
			<!-- Both are stored as MAGNITUDES, so the sign is applied here — and through `formatCents`
			     with `signDisplay`, never by concatenation: Intl decides both the glyph and which side
			     of the number it goes on. `exceptZero` so a zero stays unsigned.
			     The value colours are the table's own: expenses zinc-900, income emerald-700, the
			     same pairing every amount in the list already uses. The LABELS stay zinc-500, so the
			     colour marks the figure rather than the whole phrase. -->
			<span
				>{m.transactions_totals_expense_label()}
				<span class="font-medium text-zinc-900"
					>{formatCents(
						-data.filteredTotals.expenseCents,
						undefined,
						undefined,
						'exceptZero'
					)}</span
				></span
			>
			<span
				>{m.transactions_totals_income_label()}
				<span class="font-medium text-emerald-700"
					>{formatCents(data.filteredTotals.incomeCents, undefined, undefined, 'exceptZero')}</span
				></span
			>
		{/if}
	</p>
{/snippet}

{#snippet idsFilterNotice()}
	{#if idsFilterActive}
		<p class="mt-2 text-sm text-zinc-600">
			{m.transactions_filter_ids_active({ count: data.pagination.totalTransactions })}
		</p>
	{/if}
{/snippet}

<main class="min-h-screen bg-zinc-50 px-4 py-10 text-zinc-950 sm:px-6 lg:px-8">
	<section class="mx-auto max-w-7xl space-y-5">
		<!-- En-tête -->
		<div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-4">
			<div>
				<h1 class="text-2xl font-semibold tracking-normal">{m.nav_transactions()}</h1>
			</div>
			<div class="flex items-center gap-2">
				<Button
					href={buildExportHref()}
					variant="secondary"
					class="h-11 flex-1 !border-zinc-200 lg:h-auto lg:flex-none lg:!border-zinc-300"
				>
					{m.transactions_export_button()}
				</Button>
				<Button href="/import" class="h-11 flex-1 lg:h-auto lg:flex-none">
					{m.dashboard_import()}
				</Button>
			</div>
		</div>

		<!-- ============ BANDEAU "À CLASSER" — DESKTOP ============ -->
		{#if data.uncategorizedCount > 0}
			<div
				class="hidden items-center gap-4 rounded-lg border border-zinc-300 bg-zinc-50 px-4 py-3 lg:flex"
			>
				<span
					aria-label={data.uncategorizedCount > 1
						? m.transactions_classify_banner_count_aria_many({ count: data.uncategorizedCount })
						: m.transactions_classify_banner_count_aria_one({ count: data.uncategorizedCount })}
					class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white tabular-nums"
				>
					{data.uncategorizedCount}
				</span>
				<div class="min-w-0 flex-1">
					<div class="text-sm font-medium text-zinc-900">
						{m.transactions_classify_banner_title()}
					</div>
					<div class="text-xs text-zinc-500">{m.transactions_classify_banner_subtitle()}</div>
				</div>
				<Button
					variant="secondary"
					size="sm"
					onclick={openFocusMode}
					title={m.transactions_focus_mode_title()}
				>
					{m.transactions_focus_mode()}
				</Button>
				<Button href={buildFilterHref('classify')} size="sm" class="shrink-0">
					{m.transactions_classify_cta()}
				</Button>
			</div>
		{/if}

		<!-- ============ BANDEAU "À CLASSER" — MOBILE ============ -->
		{#if data.uncategorizedCount > 0}
			<div class="space-y-4 lg:hidden {cardBase} !bg-zinc-50 p-5">
				<div class="flex items-start gap-3.5">
					<span
						aria-label={data.uncategorizedCount > 1
							? m.transactions_classify_banner_count_aria_many({ count: data.uncategorizedCount })
							: m.transactions_classify_banner_count_aria_one({ count: data.uncategorizedCount })}
						class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-[15px] font-bold text-white tabular-nums"
					>
						{data.uncategorizedCount}
					</span>
					<div class="min-w-0">
						<p class="text-[15px] font-bold tracking-tight text-zinc-900">
							{m.transactions_classify_banner_title()}
						</p>
						<p class="mt-0.5 text-[13px] leading-snug text-zinc-500">
							{m.transactions_classify_banner_subtitle()}
						</p>
					</div>
				</div>
				<div class="flex items-center gap-2">
					{#if classificationMode}
						{#if data.classifiableCount > 0}
							<form
								method="POST"
								action="?/classifyAll"
								class="flex-1"
								use:enhance={() => {
									classifyAllSubmitting = true;
									return async ({ update }) => {
										await update({ reset: false });
										classifyAllSubmitting = false;
									};
								}}
							>
								<Button
									type="submit"
									variant="secondary"
									size="sm"
									loading={classifyAllSubmitting}
									class="!flex h-11 w-full items-center justify-center gap-1.5"
								>
									<svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
										<path
											d="M11 2.5 4.5 11.5h4.2L8 17.5l7-9.5H10.5L11 2.5Z"
											stroke="currentColor"
											stroke-width="1.4"
											stroke-linejoin="round"
										/>
									</svg>
									{m.transactions_accept_all({ count: data.classifiableCount })}
								</Button>
							</form>
						{/if}
						<a
							href={resolve(buildFilterHref('all'))}
							class="flex min-h-[44px] shrink-0 items-center justify-center rounded-md px-3 text-[13.5px] font-semibold text-zinc-600 underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 focus-visible:outline-none"
						>
							{m.transactions_classify_finish()}
						</a>
					{:else}
						<Button
							variant="secondary"
							size="sm"
							class="!flex h-11 shrink-0 items-center justify-center px-3"
							onclick={openFocusMode}
						>
							{m.transactions_focus_mode()}
						</Button>
						<Button href={buildFilterHref('classify')} size="field" class="flex-1">
							{m.transactions_classify_cta()}
						</Button>
					{/if}
				</div>
			</div>
		{/if}

		<!-- ============ BARRE DE FILTRES — DESKTOP ============ -->
		<div class="hidden space-y-3 rounded-lg border border-zinc-200 bg-white p-4 lg:block">
			<!-- Onglets type -->
			<div class="flex flex-wrap items-center gap-3">
				<div
					role="tablist"
					class="flex items-center gap-0.5 rounded-lg border border-zinc-200 p-1 text-sm"
				>
					{#each visibleTabs as tab (tab.t)}
						<a
							href={resolve(buildFilterHref(tab.t))}
							role="tab"
							aria-selected={data.filters.type === tab.t}
							class="{tab.badge !== undefined
								? 'inline-flex items-center gap-1.5'
								: ''} rounded-md px-3 py-1 font-medium transition-colors focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1 focus-visible:outline-none {data
								.filters.type === tab.t
								? 'bg-zinc-900 text-white'
								: 'text-zinc-600 hover:bg-zinc-100'}"
						>
							{tab.label}
							{#if tab.badge !== undefined}
								<span
									class="rounded px-1.5 text-[11px] font-semibold tabular-nums {data.filters
										.type === tab.t
										? 'bg-white/20 text-white'
										: 'bg-zinc-200 text-zinc-600'}"
								>
									{tab.badge}
								</span>
							{/if}
						</a>
					{/each}
				</div>

				{#if classificationMode && data.classifiableCount > 0}
					<form
						method="POST"
						action="?/classifyAll"
						use:enhance={() => {
							classifyAllSubmitting = true;
							return async ({ update }) => {
								await update({ reset: false });
								classifyAllSubmitting = false;
							};
						}}
					>
						<Button type="submit" variant="secondary" size="sm" loading={classifyAllSubmitting}>
							{m.transactions_accept_all({ count: data.classifiableCount })}
						</Button>
					</form>
				{/if}
			</div>

			<!-- Filtres secondaires -->
			<form method="GET" class="flex flex-wrap items-center gap-2">
				{#each filterHiddenInputs(data.filters) as field (field.name)}
					<input type="hidden" name={field.name} value={field.value} />
				{/each}
				<!-- At rest each trigger carries the NAME OF ITS DIMENSION and nothing else. "Toutes" is
				     the resting value of a filter, and two triggers each showing their resting value is
				     what put two adjacent "Toutes" in this bar. The word now lives only on the nature
				     group above — which shows all its options at once, so the set describes itself —
				     and as the return row inside an open list. Two dimensions can no longer render the
				     same text, by construction. -->
				<FilterDropdown
					dimensionLabel={m.transactions_filter_dimension_category()}
					activeLabel={activeCategoryLabel}
					options={categoryFilterOptions}
					value={data.filters.category}
					allLabel={m.transactions_category_filter_all()}
					searchPlaceholder={m.transactions_category_filter_placeholder()}
					clearAriaLabel={m.transactions_filter_clear_aria({
						dimension: m.transactions_filter_dimension_category()
					})}
					onSelect={(category) => applyFilterDimension({ category })}
					onClear={() => applyFilterDimension({ category: '' })}
				/>
				{#if data.allTags.length > 0}
					<!-- Absent entirely for a user with no tags: a filter with no possible value has
					     nothing to offer. Deliberately unlike the bulk trigger below, which IS rendered
					     and disabled in the equivalent case — an unavailable ACTION has to teach the
					     condition under which it becomes available; an empty dimension has nothing to
					     teach. -->
					<FilterDropdown
						dimensionLabel={m.tags_filter_dimension()}
						activeLabel={activeTagLabel}
						options={tagFilterOptions}
						value={data.filters.tag}
						allLabel={m.tags_filter_all()}
						allCount={tagFilterAllCount}
						scopeNote={data.tagCounts === null
							? m.tags_filter_counts_unavailable()
							: m.tags_filter_scope_note()}
						searchPlaceholder={m.tags_filter_search_placeholder()}
						clearAriaLabel={m.transactions_filter_clear_aria({
							dimension: m.tags_filter_dimension()
						})}
						tinted={true}
						tintBgClass={activeFilterTag && isTagColorToken(activeFilterTag.colorToken)
							? tagTintBgClass(activeFilterTag.colorToken)
							: ''}
						tintBorderClass="border-zinc-300"
						tintTextClass={activeFilterTag && isTagColorToken(activeFilterTag.colorToken)
							? tagColorTextClass(activeFilterTag.colorToken)
							: ''}
						onSelect={(tag) => applyFilterDimension({ tag })}
						onClear={clearTagFilter}
					>
						{#snippet footer()}
							<ManageTagsFooter />
						{/snippet}
					</FilterDropdown>
				{/if}
				<!-- Replaces the two native type="date" inputs. type="date" renders jj/mm/aaaa or
				     mm/dd/yyyy depending on the BROWSER's own locale and ignores every lang attribute
				     this app sets, so the same build showed two different formats on two machines —
				     the defect this dimension exists to close. Presets and free-text dates alike
				     serialise into the existing from/to params via onApply; no third param is added. -->
				<PeriodFilter
					dimensionLabel={m.transactions_filter_dimension_period()}
					from={data.filters.from}
					to={data.filters.to}
					invalid={data.dateRangeError}
					locale={getLocale()}
					todayIso={data.todayIso}
					allowCustomRung={true}
					clearAriaLabel={m.transactions_filter_clear_aria({
						dimension: m.transactions_filter_dimension_period()
					})}
					onApply={(range) => applyFilterDimension(range)}
					onClear={() => applyFilterDimension({ from: '', to: '' })}
				/>
				{#if data.splitFilterAvailable}
					<!-- LAST among the dimensions, and that placement is the reason it can exist at all:
					     it is the only one that can be ABSENT, and an absence at the end of a row moves
					     nobody. Inserted between Catégorie and Période, its appearance would shift two
					     controls whose position the user had memorised.
					     Rendered only once at least one répartition exists — ni grisé, ni "aucune
					     répartition". A visible filter would teach the feature in a toolbar, to someone
					     who came looking for something else. The condition is evaluated server-side at
					     view load and nowhere else, so it cannot evaporate under a finger mid-use.
					     A Dropdown rather than a segmented group like Nature, even though two values plus
					     "Toutes" would fit one: Nature is ALWAYS rendered, while a segmented group
					     appearing at once would add ~210px mid-bar and push everything after it. It is
					     the conditional rendering that chooses the component, not the number of values. -->
					<FilterDropdown
						dimensionLabel={m.splits_filter_dimension()}
						activeLabel={activeSplitLabel}
						options={splitFilterOptions}
						value={data.filters.split === 'all' ? '' : data.filters.split}
						allLabel={m.transactions_filter_all()}
						allCount={splitFilterAllCount}
						searchPlaceholder={m.splits_filter_dimension()}
						clearAriaLabel={m.transactions_filter_clear_aria({
							dimension: m.splits_filter_dimension()
						})}
						onSelect={(split) => applyFilterDimension({ split })}
						onClear={() => applyFilterDimension({ split: 'all' })}
					/>
				{/if}
				<!-- The search field sits at the RIGHT END of the bar, at 300px, with the regex toggle
				     INSIDE it. Both halves are section 7's point, and only the first half shipped at
				     first: the toggle got its bordered box and stayed outside the field, to its left,
				     which is exactly the arrangement the design names as the defect — a character in a
				     bordered box is a button, a character beside a field is a typo.
				     `ml-auto` rather than a fixed position, so the dimensions keep packing from the left
				     and the field keeps the right edge however many of them there are.
				     28x32 rather than IconButton's 44x44 floor: inside the field a 44px control fills it
				     edge to edge and stops reading as something within the field. Desktop only — the
				     design's 44px floor is the MOBILE one, and this box clears both SC 2.5.8's 24x24 and
				     the design's own 26x24 for a desktop control.
				     `density="bar"` because this is a filter-bar control, not a form field: four
				     controls on one line at two different heights (three 34px triggers against a 44px
				     field and a 44px button) reads as a defect before it reads as hierarchy. The 44px
				     template belongs to fields a user fills in as the point of the screen. The mobile
				     search field below deliberately keeps the default 44px density — that floor is a
				     touch-target rule and is a different question from this one. -->
				<div class="ml-auto w-[300px]">
					<input type="hidden" name="qMode" value={searchIsRegex ? 'regex' : 'contains'} />
					<SearchBar
						name="q"
						value={data.filters.q}
						placeholder={m.transactions_search_placeholder()}
						ariaLabel={m.transactions_search_label()}
						error={Boolean(data.queryError)}
						clearLabel={m.common_search_clear_aria()}
						density="bar"
						wrapperClass="w-full"
					>
						{#snippet trailing()}
							<IconButton
								shape="box"
								class="h-7 !min-h-0 w-8 !min-w-0"
								pressed={searchIsRegex}
								label={m.transactions_regex_toggle_aria()}
								title={m.transactions_regex_toggle_aria()}
								onclick={() => (searchIsRegex = !searchIsRegex)}
							>
								<span class="font-mono text-[13px] leading-none">.*</span>
							</IconButton>
						{/snippet}
					</SearchBar>
				</div>
				<Button type="submit" size="bar">{m.transactions_submit_filter()}</Button>
				{#if data.queryError}
					<p class="mt-2 text-sm font-medium text-rose-600">
						{m.transactions_error_invalid_regex_query()}
					</p>
					<!-- Says which results are on screen. The design asked for the totals to keep showing
				     the last valid expression's figures too; they deliberately do not, because the
				     server never evaluated this filter and figures printed beside the current input
				     would claim to describe it. The sentence is the honest half of that idea: the
				     ROWS are the last valid expression's, the TOTALS are unknown and say so. -->
					<p class="mt-1 text-sm text-zinc-500">{m.transactions_regex_error_unchanged()}</p>
				{/if}
				{@render idsFilterNotice()}
			</form>
		</div>

		<!-- ============ ONGLETS + FILTRES — MOBILE ============ -->
		<div class="space-y-4 lg:hidden">
			<div class="flex gap-2 overflow-x-auto pb-0.5">
				{#each visibleTabs as tab (tab.t)}
					<a
						href={resolve(buildFilterHref(tab.t))}
						role="tab"
						aria-selected={data.filters.type === tab.t}
						class="flex h-9 shrink-0 items-center {tab.badge !== undefined
							? 'gap-1.5'
							: ''} rounded-full px-4 text-[13px] whitespace-nowrap {tab.badge !== undefined
							? 'font-semibold'
							: 'font-medium'} transition-colors {data.filters.type === tab.t
							? 'bg-zinc-900 text-white'
							: 'border border-zinc-200 bg-white text-zinc-700'}"
					>
						{tab.label}
						{#if tab.badge !== undefined}
							<span
								class="flex h-5 min-w-[20px] items-center justify-center rounded-full px-1 text-[11px] font-bold tabular-nums {data
									.filters.type === 'classify'
									? 'bg-white/20 text-white'
									: 'bg-zinc-100 text-zinc-600'}"
							>
								{tab.badge}
							</span>
						{/if}
					</a>
				{/each}
			</div>

			<form method="GET" class="space-y-3 {cardBase} p-4.5">
				{#each filterHiddenInputs(data.filters) as field (field.name)}
					<input type="hidden" name={field.name} value={field.value} />
				{/each}
				<input type="hidden" name="qMode" value={searchIsRegex ? 'regex' : 'contains'} />

				<div class="flex items-center gap-1">
					<SearchBar
						name="q"
						value={data.filters.q}
						placeholder={m.transactions_search_placeholder()}
						ariaLabel={m.transactions_search_label()}
						error={Boolean(data.queryError)}
						clearLabel={m.common_search_clear_aria()}
						wrapperClass="flex-1"
						inputClass="!bg-zinc-50"
					/>
					<IconButton
						shape="pill"
						pressed={searchIsRegex}
						label={m.transactions_regex_toggle_aria()}
						onclick={() => (searchIsRegex = !searchIsRegex)}
					>
						.*
					</IconButton>
				</div>
				{#if data.queryError}
					<p class="flex items-center gap-1.5 px-0.5 text-xs text-rose-600">
						<svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden="true">
							<circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.6" />
							<path
								d="M10 6.5v4.2"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
							/>
							<circle cx="10" cy="13.4" r="0.9" fill="currentColor" />
						</svg>
						{m.transactions_error_invalid_regex_query()}
					</p>
					<!-- Same sentence as the desktop bar; see its comment there. -->
					<p class="px-0.5 text-xs text-zinc-500">{m.transactions_regex_error_unchanged()}</p>
				{/if}

				<!-- Category and tag collapse behind one "Filtres" sheet — see the comment on
				     activeMobileFilterDimensionCount above. What stays identical to the desktop bar is
				     what matters: "Dimension : Valeur", the × in the same place, the counts, and the
				     "Gérer dans Paramètres" footer. One logic, two layouts. -->
				{#snippet mobileFilterCheckMark()}
					<svg
						class="h-3.5 w-3.5 shrink-0 text-zinc-500"
						viewBox="0 0 16 16"
						fill="none"
						aria-hidden="true"
					>
						<path
							d="M2.5 8 6.5 12 13.5 4"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				{/snippet}
				<div class="flex flex-wrap items-center gap-2">
					<button
						type="button"
						class="inline-flex h-11 items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
						aria-label={mobileFiltersTriggerAriaLabel}
						onclick={() => (mobileFiltersOpen = true)}
					>
						{m.transactions_filters_sheet_label()}
						{#if activeMobileFilterDimensionCount > 0}
							<span
								aria-hidden="true"
								class="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-zinc-900 px-1 text-[11px] font-bold text-white tabular-nums"
							>
								{activeMobileFilterDimensionCount}
							</span>
						{/if}
					</button>

					<!-- The dimension's own trigger, always present — same "Dimension : Valeur" grammar
					     and the same two-adjoined-buttons shape as the desktop FilterDropdown trigger
					     (a resting name, an active "Dimension : Valeur" plus its own clear control), so
					     the two surfaces never disagree about what "active" reads like. Opens the
					     dimension's sub-sheet directly rather than routing through the "Filtres"
					     summary first — the summary sheet stays reachable too, for the count and the
					     "Voir les N résultats" confirmation, but is never the only way in. -->
					<span
						class="inline-flex min-h-11 items-stretch overflow-hidden rounded-xl border bg-white {data
							.filters.category
							? 'border-zinc-900'
							: 'border-zinc-200'}"
					>
						<button
							type="button"
							class="inline-flex min-h-11 items-center px-2.5 text-sm text-zinc-900"
							onclick={() => (mobileFilterSubDimension = 'category')}
						>
							<!-- Same trigger grammar as desktop, same cap: the dimension name never truncates,
							     the VALUE is bounded at 190px. The rule is universal, not desktop-only, and
							     the pill had no bound at all — a long tag or category name rendered as one
							     unbreakable pill wider than the design allows. -->
							<span class="max-w-[190px] truncate"
								>{data.filters.category
									? activeCategoryLabel
									: m.transactions_filter_dimension_category()}</span
							>
						</button>
						{#if data.filters.category}
							<span class="w-px self-stretch bg-zinc-200" aria-hidden="true"></span>
							<button
								type="button"
								class="inline-flex min-h-11 min-w-11 items-center justify-center text-zinc-500"
								aria-label={m.transactions_filter_clear_aria({
									dimension: m.transactions_filter_dimension_category()
								})}
								onclick={() => applyFilterDimension({ category: '' })}
							>
								<span aria-hidden="true">×</span>
							</button>
						{/if}
					</span>
					{#if data.allTags.length > 0}
						<span
							class="inline-flex min-h-11 items-stretch overflow-hidden rounded-xl border bg-white {activeFilterTag
								? `border-zinc-300 ${isTagColorToken(activeFilterTag.colorToken) ? tagTintBgClass(activeFilterTag.colorToken) : ''}`
								: 'border-zinc-200'}"
						>
							<!-- The value takes the TOKEN's hue on the token's tint, the same measured pairing
							     the desktop trigger carries (4.71:1 lagoon, 4.81:1 azure). Shipping the tint
							     alone leaves a surface with no measured foreground on it. -->
							<button
								type="button"
								class="inline-flex min-h-11 items-center px-2.5 text-sm {activeFilterTag &&
								isTagColorToken(activeFilterTag.colorToken)
									? tagColorTextClass(activeFilterTag.colorToken)
									: 'text-zinc-900'}"
								onclick={() => (mobileFilterSubDimension = 'tag')}
							>
								<span class="max-w-[190px] truncate"
									>{activeFilterTag ? activeTagLabel : m.tags_filter_dimension()}</span
								>
							</button>
							{#if activeFilterTag}
								<span class="w-px self-stretch bg-zinc-300" aria-hidden="true"></span>
								<button
									type="button"
									class="inline-flex min-h-11 min-w-11 items-center justify-center text-zinc-600"
									aria-label={m.transactions_filter_clear_aria({
										dimension: m.tags_filter_dimension()
									})}
									onclick={clearTagFilter}
								>
									<span aria-hidden="true">×</span>
								</button>
							{/if}
						</span>
					{/if}
					<!-- Same component as desktop, `surface="mobile"` and `allowCustomRung={false}`: the
					     "période personnalisée" rung relies on a Tooltip, and touch has no hover to open
					     one, so the mobile ladder stops at the numeric rung instead. -->
					<PeriodFilter
						dimensionLabel={m.transactions_filter_dimension_period()}
						from={data.filters.from}
						to={data.filters.to}
						invalid={data.dateRangeError}
						locale={getLocale()}
						todayIso={data.todayIso}
						allowCustomRung={false}
						surface="mobile"
						clearAriaLabel={m.transactions_filter_clear_aria({
							dimension: m.transactions_filter_dimension_period()
						})}
						onApply={(range) => applyFilterDimension(range)}
						onClear={() => applyFilterDimension({ from: '', to: '' })}
					/>
					{#if data.splitFilterAvailable}
						<!-- Third surface, same grammar and the same conditional rendering as the other
						     two. Last in the row for the reason 1s gives: it is the only dimension that
						     can be absent, and an absence at the end moves nobody. -->
						<span
							class="inline-flex min-h-11 items-stretch overflow-hidden rounded-xl border bg-white {data
								.filters.split !== 'all'
								? 'border-zinc-900'
								: 'border-zinc-200'}"
						>
							<button
								type="button"
								class="inline-flex min-h-11 items-center px-2.5 text-sm text-zinc-900"
								onclick={() => (mobileFilterSubDimension = 'split')}
							>
								<span class="max-w-[190px] truncate"
									>{data.filters.split !== 'all'
										? activeSplitLabel
										: m.splits_filter_dimension()}</span
								>
							</button>
							{#if data.filters.split !== 'all'}
								<span class="w-px self-stretch bg-zinc-200" aria-hidden="true"></span>
								<button
									type="button"
									class="inline-flex min-h-11 min-w-11 items-center justify-center text-zinc-500"
									aria-label={m.transactions_filter_clear_aria({
										dimension: m.splits_filter_dimension()
									})}
									onclick={() => applyFilterDimension({ split: 'all' })}
								>
									<span aria-hidden="true">×</span>
								</button>
							{/if}
						</span>
					{/if}
				</div>

				<!-- The "Filtres" sheet: category and tag rows, each showing the vertical form of
				     "Dimension : Valeur" — the dimension name in 12px above the value slot, "Toutes" in
				     zinc-400 when the dimension rests. Selecting a value happens one level down, in a
				     sub-sheet: this sheet only says what is set today and lets the user drill in. -->
				<BottomSheet
					open={mobileFiltersOpen}
					ariaLabel={m.transactions_filters_sheet_label()}
					onClose={closeMobileFiltersSheet}
				>
					{#snippet header()}
						<h2 class="text-base font-semibold text-zinc-950">
							{m.transactions_filters_sheet_label()}
						</h2>
					{/snippet}
					<div class="space-y-1 pb-1">
						<button
							type="button"
							class="flex min-h-[52px] w-full items-center justify-between gap-2 border-b border-zinc-100 py-2 text-left"
							onclick={() => (mobileFilterSubDimension = 'category')}
						>
							<span class="flex min-w-0 flex-col">
								<span class="text-[11px] font-medium text-zinc-500">
									{m.transactions_filter_dimension_category()}
								</span>
								<span
									class="truncate text-sm {data.filters.category
										? 'text-zinc-900'
										: 'text-zinc-400'}"
								>
									{data.filters.category
										? categoryDisplayName(data.filters.category)
										: m.transactions_category_filter_all()}
								</span>
							</span>
							<svg
								class="h-4 w-4 shrink-0 text-zinc-400"
								viewBox="0 0 20 20"
								fill="none"
								aria-hidden="true"
							>
								<path
									d="M7.5 5.5 12 10l-4.5 4.5"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</button>
						{#if data.allTags.length > 0}
							<button
								type="button"
								class="flex min-h-[52px] w-full items-center justify-between gap-2 border-b border-zinc-100 py-2 text-left"
								onclick={() => (mobileFilterSubDimension = 'tag')}
							>
								<span class="flex min-w-0 flex-col">
									<span class="text-[11px] font-medium text-zinc-500"
										>{m.tags_filter_dimension()}</span
									>
									<span
										class="flex items-center gap-1.5 truncate text-sm {activeFilterTag
											? 'text-zinc-900'
											: 'text-zinc-400'}"
									>
										{#if activeFilterTag && isTagColorToken(activeFilterTag.colorToken)}
											<span
												class="h-2 w-2 shrink-0 rounded-full {tagColorBgClass(
													activeFilterTag.colorToken
												)}"
											></span>
										{/if}
										{activeFilterTag ? activeFilterTag.name : m.tags_filter_all()}
									</span>
								</span>
								<svg
									class="h-4 w-4 shrink-0 text-zinc-400"
									viewBox="0 0 20 20"
									fill="none"
									aria-hidden="true"
								>
									<path
										d="M7.5 5.5 12 10l-4.5 4.5"
										stroke="currentColor"
										stroke-width="1.5"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</button>
						{/if}
						{#if data.splitFilterAvailable}
							<!-- Same conditional rendering as the desktop trigger, and last for the same
							     reason. The value sits right, « Toutes » in zinc-400 while the dimension
							     rests and the value in zinc-900 once set, so the sheet reads down one
							     column. -->
							<button
								type="button"
								class="flex min-h-[52px] w-full items-center justify-between gap-2 border-b border-zinc-100 py-2 text-left"
								onclick={() => (mobileFilterSubDimension = 'split')}
							>
								<span class="flex min-w-0 flex-col">
									<span class="text-[11px] font-medium text-zinc-500"
										>{m.splits_filter_dimension()}</span
									>
									<span
										class="truncate text-sm {data.filters.split !== 'all'
											? 'font-semibold text-zinc-900'
											: 'text-zinc-400'}"
									>
										{data.filters.split === 'split'
											? m.splits_filter_option_split()
											: data.filters.split === 'unsplit'
												? m.splits_filter_option_unsplit()
												: m.transactions_filter_all()}
									</span>
								</span>
								<svg
									class="h-4 w-4 shrink-0 text-zinc-400"
									viewBox="0 0 20 20"
									fill="none"
									aria-hidden="true"
								>
									<path
										d="M7.5 5.5 12 10l-4.5 4.5"
										stroke="currentColor"
										stroke-width="1.5"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</button>
						{/if}
						<Button type="button" class="mt-3 h-11 w-full" onclick={closeMobileFiltersSheet}>
							{mobileFiltersApplyLabel}
						</Button>
					</div>
				</BottomSheet>

				<!-- Category sub-sheet: the same option set FilterDropdown renders on desktop, as
				     full-width 52px rows instead of a small anchored panel. -->
				<BottomSheet
					open={mobileFilterSubDimension === 'category'}
					ariaLabel={m.transactions_filter_dimension_category()}
					onClose={closeMobileFilterSubSheet}
				>
					{#snippet header()}
						<h2 class="text-base font-semibold text-zinc-950">
							{m.transactions_filter_dimension_category()}
						</h2>
					{/snippet}
					<div class="pb-1">
						<ul class="divide-y divide-zinc-100">
							<li>
								<button
									type="button"
									class="flex min-h-[52px] w-full items-center justify-between gap-2 text-left text-sm text-zinc-700"
									onclick={() => {
										applyFilterDimension({ category: '' });
										closeMobileFilterSubSheet();
									}}
								>
									<span>{m.transactions_category_filter_all()}</span>
									{#if !data.filters.category}
										{@render mobileFilterCheckMark()}
									{/if}
								</button>
							</li>
							{#each categoryFilterOptions as option (option.value)}
								<li>
									<button
										type="button"
										class="flex min-h-[52px] w-full items-center justify-between gap-2 text-left text-sm text-zinc-700"
										onclick={() => {
											applyFilterDimension({ category: option.value });
											closeMobileFilterSubSheet();
										}}
									>
										<span class="truncate">{option.label}</span>
										{#if option.value === data.filters.category}
											{@render mobileFilterCheckMark()}
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					</div>
				</BottomSheet>

				<!-- Répartition sub-sheet: the same three rows the desktop panel renders, with the same
				     counts and the same zero-count rule — « 0 » and aria-disabled, reachable by the
				     arrows so the state is announced, never activable. -->
				{#if data.splitFilterAvailable}
					<BottomSheet
						open={mobileFilterSubDimension === 'split'}
						ariaLabel={m.splits_filter_dimension()}
						onClose={closeMobileFilterSubSheet}
					>
						{#snippet header()}
							<h2 class="text-base font-semibold text-zinc-950">
								{m.splits_filter_dimension()}
							</h2>
						{/snippet}
						<div class="pb-1">
							<ul class="divide-y divide-zinc-100">
								<li>
									<button
										type="button"
										class="flex min-h-[52px] w-full items-center justify-between gap-2 text-left text-sm text-zinc-700"
										onclick={() => {
											applyFilterDimension({ split: 'all' });
											closeMobileFilterSubSheet();
										}}
									>
										<span>{m.transactions_filter_all()}</span>
										<span class="flex items-center gap-2">
											{#if splitFilterAllCount !== null}
												<span class="text-xs text-zinc-500">{splitFilterAllCount}</span>
											{/if}
											{#if data.filters.split === 'all'}
												{@render mobileFilterCheckMark()}
											{/if}
										</span>
									</button>
								</li>
								{#each splitFilterOptions as option (option.value)}
									<li>
										<button
											type="button"
											class="flex min-h-[52px] w-full items-center justify-between gap-2 text-left text-sm {option.disabled
												? 'text-zinc-400'
												: 'text-zinc-700'}"
											aria-disabled={option.disabled ? 'true' : undefined}
											onclick={() => {
												if (option.disabled) return;
												applyFilterDimension({ split: option.value });
												closeMobileFilterSubSheet();
											}}
										>
											<span class="truncate">{option.label}</span>
											<span class="flex items-center gap-2">
												{#if option.count !== null}
													<span class="text-xs text-zinc-500">{option.count}</span>
												{/if}
												{#if option.value === data.filters.split}
													{@render mobileFilterCheckMark()}
												{/if}
											</span>
										</button>
									</li>
								{/each}
							</ul>
						</div>
					</BottomSheet>
				{/if}

				<!-- Tag sub-sheet: same option set as the desktop tag panel — counts, the scope note, a
				     zero-count row dimmed but reachable, and the same "Gérer dans Paramètres" footer. -->
				{#if data.allTags.length > 0}
					<BottomSheet
						open={mobileFilterSubDimension === 'tag'}
						ariaLabel={m.tags_filter_dimension()}
						onClose={closeMobileFilterSubSheet}
					>
						{#snippet header()}
							<h2 class="text-base font-semibold text-zinc-950">
								{m.tags_filter_dimension()}
							</h2>
						{/snippet}
						<div class="pb-1">
							<!-- The scope note stays in the body: it explains the counts, it is not the way
							     back, and only the way back is owed a fixed place. -->
							<p class="mb-2 text-xs text-zinc-500">
								{data.tagCounts === null
									? m.tags_filter_counts_unavailable()
									: m.tags_filter_scope_note()}
							</p>
							<ul class="divide-y divide-zinc-100">
								<li>
									<button
										type="button"
										class="flex min-h-[52px] w-full items-center justify-between gap-2 text-left text-sm text-zinc-700"
										onclick={() => {
											clearTagFilter();
											closeMobileFilterSubSheet();
										}}
									>
										<span>{m.tags_filter_all()}</span>
										<span class="flex items-center gap-2">
											<span class="text-xs text-zinc-500 tabular-nums">
												{tagFilterAllCount === null ? '—' : tagFilterAllCount}
											</span>
											{#if !data.filters.tag}
												{@render mobileFilterCheckMark()}
											{/if}
										</span>
									</button>
								</li>
								{#each tagFilterOptions as option (option.value)}
									<li>
										<button
											type="button"
											aria-disabled={option.disabled ? 'true' : undefined}
											class="flex min-h-[52px] w-full items-center justify-between gap-2 text-left text-sm {option.disabled
												? 'cursor-not-allowed text-zinc-400'
												: 'text-zinc-700'}"
											onclick={() => {
												if (option.disabled) return;
												applyFilterDimension({ tag: option.value });
												closeMobileFilterSubSheet();
											}}
										>
											<span class="flex min-w-0 items-center gap-2">
												{#if option.swatchClass}
													<span class="h-2 w-2 shrink-0 rounded-full {option.swatchClass}"></span>
												{/if}
												<span class="truncate">{option.label}</span>
											</span>
											<span class="flex items-center gap-2">
												<!-- Same rule as the desktop FilterDropdown: a disabled (zero-count) row
												     is dimmed by colour, never by opacity, and the count matches the
												     label's zinc-400 rather than staying at the active row's zinc-500. -->
												<span
													class="text-xs tabular-nums {option.disabled
														? 'text-zinc-400'
														: 'text-zinc-500'}"
												>
													{option.count === null || option.count === undefined ? '—' : option.count}
												</span>
												{#if option.value === data.filters.tag}
													{@render mobileFilterCheckMark()}
												{/if}
											</span>
										</button>
									</li>
								{/each}
							</ul>
							<ManageTagsFooter />
						</div>
					</BottomSheet>
				{/if}
				{@render idsFilterNotice()}

				<div class="flex gap-2 pt-1">
					<Button type="submit" class="!flex h-11 flex-1 !items-center !justify-center">
						{m.transactions_submit_filter()}
					</Button>
				</div>
			</form>
		</div>

		<!-- The hidden undo form stays here, rendered ONCE: its id has to be unique, and the button
		     that submits it carries `form=` so it can live anywhere on the page. Only the visible
		     banner moved (see the bulkTagBanner snippet). -->
		{#if bulkTagResult}
			<form
				id="bulk-tag-undo-banner"
				method="POST"
				action="?/undoBulkTag"
				class="hidden"
				use:enhance={() => {
					bulkTagUndoSubmitting = true;
					return async ({ update }) => {
						await update({ reset: false });
						bulkTagUndoSubmitting = false;
					};
				}}
			>
				<input type="hidden" name="tagId" value={bulkTagResult.tagId} />
				<input type="hidden" name="transactionIds" value={bulkTagResult.transactionIds.join(',')} />
			</form>
		{/if}

		<!-- ============ TABLEAU + PANNEAU DÉTAIL — DESKTOP ============ -->
		<!-- Nothing occupies the place of nothing: with no selection there is no second column at all,
		     and the table takes the width. `items-start` rather than the grid default `stretch`,
		     because a panel taller than a six-row table must not stretch the table to match — a table
		     claiming 520px of height for six rows is a layout lie, and the white space belongs to the
		     left instead.
		     The two-column state stays at `xl` (1280px) deliberately: below ~1120px the narrowed
		     table's label column drops under 300px and stops being readable, and today's `lg`-stacks-
		     under behaviour already avoids that. The design flags a modal side sheet for that range and
		     does not draw it; it is in the backlog, not here. -->
		<!-- The summary BAND, its own row between the filter bar and the table. Two rows, one function
		     each: you filter above, you read what the filter gave and act on it below. It shipped
		     inside the table card's pagination header instead, with the count on one line and the
		     totals stacked under it — the contents were right and the container was not, so the band
		     the design specifies ("142 transactions   Dépenses −3 418,90 €   Revenus +4 260,00 €" on
		     ONE line) did not exist.
		     Always rendered: it carries the totals, which a user has today with no filter at all and
		     must not lose. Only "Réinitialiser les filtres" and the bulk trigger are conditional. -->
		<div
			class="hidden flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border border-zinc-200 bg-white px-4 py-3 lg:flex"
			data-testid="summary-band"
		>
			<div class="flex flex-wrap items-baseline gap-x-6 gap-y-1">
				{@render summaryCount()}
				{@render filteredTotalsRegion()}
			</div>
			<div class="flex items-center gap-2">
				{@render summaryActions('desktop')}
			</div>
		</div>
		<!-- Gated with the band, not left at page level: these three are the DESKTOP copies, and the
		     mobile block renders its own further down. Ungated they rendered on both breakpoints at
		     once, which put a second undo banner in the tab order ahead of the trigger it undoes —
		     the exact ordering the guard in bulk-tag.svelte.spec.ts exists to hold. -->
		<div class="hidden lg:block">
			{@render summaryDisabledReason('desktop')}
			{@render bulkOverLimitBanner()}
			{@render bulkTagBanner()}
		</div>

		<div
			class="hidden items-start gap-6 lg:grid {data.selectedTransaction
				? 'xl:grid-cols-[1fr_400px]'
				: ''}"
		>
			<!-- Section tableau -->
			<section class="rounded-lg border border-zinc-200 bg-white">
				<!-- En-tête tableau : pagination only. The summary moved out into its own band above;
				     what stays here is the control that belongs to the TABLE rather than to the
				     filter's result. -->
				<div class="border-b border-zinc-200 px-4 py-3">
					<div class="flex flex-wrap items-center justify-end gap-2">
						<div class="flex items-center gap-2">
							<Button
								variant="secondary"
								size="sm"
								href={buildPageHref(data.pagination.page - 1)}
								disabled={!data.pagination.hasPrevious}>{m.transactions_previous()}</Button
							>
							<Button
								variant="secondary"
								size="sm"
								href={buildPageHref(data.pagination.page + 1)}
								disabled={!data.pagination.hasNext}>{m.transactions_next()}</Button
							>
						</div>
					</div>
				</div>

				<!-- Table -->
				<div class="overflow-x-auto">
					{#if visibleTransactions.length > 0}
						<table class="w-full text-left text-sm">
							<thead
								class="border-b border-zinc-100 bg-zinc-50 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase"
							>
								{#if classificationMode}
									<tr>
										<th class="w-52 px-4 py-2.5">{m.transactions_table_classify_transaction()}</th>
										<th class="px-4 py-2.5">{m.transactions_table_classify_proposal()}</th>
									</tr>
								{:else}
									<tr>
										<th class="px-4 py-2.5">{m.transactions_table_label()}</th>
										<th class="{colCategory} px-4 py-2.5">{m.transactions_table_category()}</th>
										<!-- A dedicated column, not chips at the end of the label. The design grants the
										     row-chips exception to "a table shows only what you scan at a glance" ONLY
										     against this counterpart: "colonne dédiée de 190 px (pas de puce en fin de
										     libellé, qui déchirerait la colonne de gauche)". Chips under the label tear
										     the left column ragged, and the eye then hunts for them instead of running
										     down one vertical band. Rendered even when the user has no tags, so rows do
										     not change shape the moment a first tag appears. -->
										<th class="{colTags} px-4 py-2.5" data-testid="tags-header-cell"
											>{m.transactions_table_tags()}</th
										>
										<th class="{colAmount} px-4 py-2.5 text-right"
											>{m.transactions_table_amount()}</th
										>
									</tr>
								{/if}
							</thead>
							<tbody>
								{#each data.transactions as tx (tx.id)}
									{#if !resolvedIds.has(tx.id) && !ignoredIds.has(tx.id)}
										{#if classificationMode}
											<!-- Ligne mode classement -->
											<tr
												class="border-b border-zinc-100 last:border-0 {rowStateClass(tx.id)}"
												data-testid="tx-row-{tx.id}"
												aria-current={data.selectedTransaction?.id === tx.id ? 'true' : undefined}
											>
												<td class="px-4 py-3 align-top">
													<a href={resolve(buildRowHref(tx.id))} class="block">
														<span
															class="line-clamp-2 font-medium text-zinc-900 underline-offset-2 hover:underline"
															>{tx.label}</span
														>
														<span class="mt-0.5 block text-xs text-zinc-400">
															{formatDate(tx.date)} ·
															<span class="font-semibold text-zinc-700 tabular-nums"
																>{formatCents(tx.amountCents)}</span
															>
														</span>
													</a>
												</td>
												<td class="px-4 py-3 align-middle">
													<div class="flex flex-wrap items-center justify-between gap-2">
														<div class="flex items-center gap-2">
															{#if tx.suggestion}
																<span
																	class="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-[13px] font-medium text-zinc-800"
																>
																	<span
																		class="h-2 w-2 shrink-0 rounded-full {getCategoryColor(
																			tx.suggestion.category
																		)}"
																	></span>
																	{categoryDisplayName(tx.suggestion.category)}
																</span>
																{#if tx.suggestion.nature}
																	<span
																		class="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-zinc-500 uppercase"
																	>
																		{formatNatureLabel(tx.suggestion.nature)}
																	</span>
																{/if}
															{:else}
																<span class="text-xs text-zinc-400"
																	>{m.transactions_no_suggestion()}</span
																>
															{/if}
														</div>
														<div class="flex items-center gap-1.5">
															{#if tx.suggestion}
																<form
																	method="POST"
																	action="?/acceptSuggestion"
																	use:enhance={() => {
																		const txId = tx.id;
																		acceptSubmittingIds = new Set([...acceptSubmittingIds, txId]);
																		return async ({ result, update }) => {
																			if (result.type === 'success')
																				resolvedIds = new Set([...resolvedIds, txId]);
																			await update({ reset: false });
																			acceptSubmittingIds = new Set(
																				[...acceptSubmittingIds].filter((id) => id !== txId)
																			);
																		};
																	}}
																>
																	<input type="hidden" name="transactionId" value={tx.id} />
																	<input
																		type="hidden"
																		name="category"
																		value={tx.suggestion.category}
																	/>
																	<input
																		type="hidden"
																		name="nature"
																		value={tx.suggestion.nature ?? ''}
																	/>
																	<Button
																		type="submit"
																		variant="primary"
																		size="sm"
																		loading={acceptSubmittingIds.has(tx.id)}
																		>{m.transactions_accept()}</Button
																	>
																</form>
															{/if}
															<Button
																variant="secondary"
																size="sm"
																onclick={() => openRuleModal(tx.id, tx.label, tx.suggestion)}
															>
																{m.transactions_rule_button()}
															</Button>
															<Button
																variant="ghost"
																size="sm"
																onclick={() => {
																	ignoredIds = new Set([...ignoredIds, tx.id]);
																}}
															>
																{m.transactions_ignore()}
															</Button>
														</div>
													</div>
												</td>
											</tr>
										{:else}
											<!-- Ligne mode normal -->
											<tr
												class="border-b border-zinc-100 last:border-0 {rowStateClass(tx.id)}"
												data-testid="tx-row-{tx.id}"
												aria-current={data.selectedTransaction?.id === tx.id ? 'true' : undefined}
											>
												<td class="max-w-[260px] px-4 py-3">
													<a
														class="line-clamp-2 font-medium text-zinc-900 underline-offset-2 hover:underline"
														href={resolve(buildRowHref(tx.id))}>{tx.label}</a
													>
													<p class="mt-0.5 text-xs text-zinc-400">{formatDate(tx.date)}</p>
												</td>
												<!-- Same shape as Étiquettes below, for the same reason and after the same measurement:
												     `w-[160px]` on the <td> alone is a suggestion under `table-layout: auto`, and an
												     unbreakable category name widened this column to 335px, taking 175px off Libellé.
												     The fixed-width child gives the column a max-content of exactly the figure, and the
												     padding moves onto it so the width stays the whole column box.
												     `truncate` + `min-w-0` are the second half: without them a WORDY name does not widen
												     the column, it wraps and grows the row from 63px to 103px — the invariant the
												     Étiquettes column exists to protect ("la hauteur de ligne ne bouge pas d'une ligne à
												     l'autre, c'est ce qui garde le tableau scannable"). -->
												<td class="{colCategory} p-0">
													<div class="{colCategory} px-4 py-3">
														<!-- h-6 RESERVES the badge's height on line 1 of EVERY row, répartie or not — the same
														     decision as the 22px meta line at 390, not a second one. Measured here: an ordinary row
														     is 63px and a row whose line 1 carries a 24px badge is 66.5, because THIS cell has two
														     lines (dot+name, then the nature) and is therefore exactly as tall as the Libellé cell,
														     with no slack to absorb a badge in. The design's « le badge est gratuit » is true of the
														     single-line cell it draws and false of the one shipped here. Reserving costs every
														     desktop row 3.5px once, instead of letting the rows carrying a badge grow past those
														     that do not. Reserve the height on the line; never let the content push it.

											     min-h-6 rather than h-6, and that is not a detail. A fixed height CLAMPS the
											     badge: a margin added to it then overflows this line silently instead of growing
											     the row, and the row-height guard — the one that exists to catch exactly that —
											     goes GREEN on the tags chantier's own regression. Found by break-checking with
											     h-6 in place. A minimum reserves the same 24px and leaves the failure visible. -->
														<div class="flex min-h-6 items-center gap-1.5">
															<span
																class="h-2 w-2 shrink-0 rounded-full {getCategoryColor(
																	rowCategory(tx)
																)}"
															></span>
															<span class="min-w-0 truncate text-zinc-700"
																>{categoryDisplayName(rowCategory(tx))}</span
															>
															<!-- The badge is `shrink-0` and the name is `min-w-0 truncate`, which is what
															     guarantees the count survives any category name: the ellipse does the work
															     rather than the number being cut off. What the ellipse must NOT do is fire
															     on an ordinary label, which is why the column is 176/200 rather than the
															     plate's 140/160 — see `colCategory` for the measured figures. -->
															{#if tx.splitIndicator}
																<SplitBadge
																	parts={badgeParts(tx.splitIndicator)}
																	otherCategoryCount={tx.splitIndicator.otherCategoryCount}
																	dominantCategory={categoryDisplayName(rowCategory(tx))}
																	interactive
																/>
															{/if}
														</div>
														<p class="mt-0.5 ml-3.5 truncate text-xs text-zinc-500">
															{formatNatureLabel(rowNature(tx))}
														</p>
													</div>
												</td>
												<!-- The 190px lives on an inner block, and the cell's own padding moved onto it.
												     `w-[190px]` on the <td> alone is only a suggestion: this table is
												     `table-layout: auto`, so the column is sized from its content's intrinsic
												     max-width, and two chips at their 110px cap widened it to 262px (299px with
												     longer names) while the header still measured 190px on an empty row. A
												     fixed-width child gives the column a max-content of exactly 190px, so the
												     figure the design specifies is the figure the browser uses. Padding sits on
												     the child rather than the cell so the 190 stays the whole column box (border-
												     box), with no "190 minus 2rem" arithmetic to get wrong later. -->
												<td class="{colTags} p-0">
													<div class="{colTags} px-4 py-3" data-testid="tags-cell">
														{#if tx.tags.length > 0}
															<TagChips tags={toTagChipItems(tx.tags)} size="sm" />
														{/if}
													</div>
												</td>
												<!-- Same fix again, third site of the same pattern: an amount past any real one widened
												     this column from 130px to 148px. `truncate` is a backstop rather than an expected
												     state — a realistic amount fits the column — but it decides what happens when one
												     does not, and silently stealing width from Libellé is not it. -->
												<td class="{colAmount} p-0">
													<div class="{colAmount} px-4 py-3 text-right">
														<div
															class="truncate font-semibold tabular-nums {tx.type === 'income'
																? 'text-emerald-700'
																: 'text-rose-600'}"
														>
															{formatCents(rowAmountCents(tx))}
														</div>
														<!-- PR5: only under a category filter, and only when the primary figure above is a
														     FRAGMENT of this row's own total (see rowPartialMatch). Measured free: the amount
														     cell's own headroom (44px used of the 67px the Libellé cell sets) absorbs this
														     second line at every 1280 column width, roomy or panel-open, and at 390. -->
														{#if rowPartialMatch(tx)}
															<p class="mt-0.5 truncate text-xs text-zinc-400">
																{m.transactions_row_matched_of({
																	amount: formatCents(tx.amountCents)
																})}
															</p>
														{/if}
													</div>
												</td>
											</tr>
										{/if}
									{/if}
								{/each}
							</tbody>
						</table>
					{:else}
						<div class="p-6">
							{#if classificationMode}
								<p class="text-sm text-zinc-500">{m.transactions_all_classified()}</p>
							{:else if filteredTotalsState === 'error'}
								<!-- "Aucune transaction pour ces critères" is a claim about the criteria having
								     been applied. When the filter was rejected they never were, so the list is
								     empty for a different reason and must say so. -->
								<p class="text-sm text-zinc-500">{m.transactions_empty_query_error_title()}</p>
								<p class="mt-1 text-sm text-zinc-500">
									{m.transactions_empty_query_error_body()}
								</p>
							{:else}
								<p class="text-sm text-zinc-500">{m.transactions_no_transactions_criteria()}</p>
								<!-- The testid distinguishes this reset from the summary row's, which carries the
								     same words and is on screen at the same time whenever a filter returns nothing.
								     TapLink has no rest spread, so the attribute goes on a wrapper or it is
								     silently dropped. -->
								<div class="mt-2" data-testid="empty-reset-filters">
									<TapLink href="/transactions">{m.transactions_reset_filters_link()}</TapLink>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			</section>

			<!-- Panneau détail — on demand only. There is no "select a transaction" placeholder and no
			     empty column: a column announcing its own emptiness is still an occupied column.
			     `position: sticky` keeps the panel in view while a long list scrolls, and it stays at
			     the TOP of its column rather than following the selected row — a card moving vertically
			     during scroll is unreadable.
			     `max-height` + `overflow-y: auto` is amendment 3, and it is load-bearing rather than
			     defensive: the panel holds six sections and exceeds 800px with them open. `sticky`
			     alone pins the top edge, so everything past the fold would simply be unreachable —
			     clipped, with no scroll of its own and no page scroll that can bring it back. The
			     element that scrolls is the same element that sticks, which is legal: an overflow
			     ANCESTOR would break stickiness, an overflow self does not. -->
			{#if data.selectedTransaction}
				<div
					class="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto"
					data-testid="detail-sticky"
				>
					<aside
						class="rounded-lg border border-zinc-200 bg-white"
						aria-label={m.transactions_detail_region_aria()}
						data-testid="transaction-detail"
					>
						<div
							class="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-zinc-200 bg-white px-4 py-3"
						>
							<h2 class="text-base font-semibold">{m.transactions_detail_heading()}</h2>
							<!-- 28px of visible glyph inside a 44x44 target, per the design's own floor. It is a
							     link rather than a button because closing IS a navigation: it drops `?selected=`,
							     so Back returns to the open panel and the state survives a reload. -->
							<a
								href={resolve(buildDeselectedHref())}
								aria-label={m.transactions_detail_close_aria()}
								data-sveltekit-noscroll
								onclick={(event) => {
									// The href is what survives with JS off and what a middle-click uses; the handler
									// exists only so focus can be put back on the row afterwards, which a plain link
									// navigation cannot do.
									if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
										return;
									event.preventDefault();
									void closeDetail();
								}}
								class="-mr-2 inline-flex h-11 w-11 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
							>
								<svg
									class="h-7 w-7"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
									aria-hidden="true"
								>
									<path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
								</svg>
							</a>
						</div>
						<div class="space-y-0">
							<!-- En-tête détail -->
							<div class="border-b border-zinc-100 px-4 py-3">
								<div class="flex items-start justify-between gap-2">
									<div>
										<p class="text-sm text-zinc-400">{formatDate(data.selectedTransaction.date)}</p>
										<p class="mt-0.5 text-sm font-semibold text-zinc-900">
											{data.selectedTransaction.label}
										</p>
										<p
											class="mt-1 text-xl font-semibold tabular-nums {data.selectedTransaction
												.type === 'income'
												? 'text-emerald-700'
												: 'text-rose-600'}"
										>
											{formatCents(data.selectedTransaction.amountCents)}
										</p>
									</div>
									<Button
										variant="ghost-danger"
										size="sm"
										onclick={() => openDeleteConfirm(data.selectedTransaction!)}
									>
										{m.common_delete()}
									</Button>
								</div>
							</div>

							<!-- Bloc proposition (mode classement uniquement) : toujours affiché, pré-rempli
						     avec la suggestion de règle ou "Non catégorisé" par défaut sinon (jamais masqué). -->
							{#if classificationMode}
								<TransactionProposalCard
									transactionId={data.selectedTransaction.id}
									suggestion={data.selectedSuggestion}
									categoryOptions={data.categoryOptions}
									natureOptions={data.natureOptions}
									variant="panel"
									{getCategoryColor}
									{formatNatureLabel}
									acceptError={form?.acceptError}
									onAccepted={handleAccepted}
									onIgnore={handleIgnore}
									onCreateRule={(category, nature) =>
										openRuleModal(data.selectedTransaction!.id, data.selectedTransaction!.label, {
											category,
											nature
										})}
								/>
							{/if}

							<div class="space-y-4 px-4 py-4">
								<!-- Résumé rapide -->
								<dl class="grid gap-2 text-sm">
									<div class="flex justify-between gap-3">
										<dt class="text-zinc-500">{m.transactions_summary_source()}</dt>
										<dd class="text-right font-medium">{data.selectedTransaction.source}</dd>
									</div>
									<div class="flex justify-between gap-3">
										<dt class="text-zinc-500">{m.transactions_summary_type()}</dt>
										<dd class="text-right">
											<span
												class="rounded px-1.5 py-0.5 text-xs font-semibold
											{data.selectedTransaction.type === 'income'
													? 'bg-emerald-50 text-emerald-700'
													: 'bg-rose-50 text-rose-700'}"
											>
												{data.selectedTransaction.type === 'income'
													? m.nature_income()
													: m.transactions_type_expense()}
											</span>
										</dd>
									</div>
									<div class="flex justify-between gap-3">
										<dt class="text-zinc-500">{m.transactions_summary_nature()}</dt>
										<dd class="text-right">
											<span class="text-xs text-zinc-600"
												>{formatNatureLabel(data.selectedTransaction.nature)}</span
											>
											<span class="ml-1 text-[11px] text-zinc-400"
												>({formatNatureSource(data.selectedTransaction.natureSource)})</span
											>
										</dd>
									</div>
								</dl>

								<!-- Catégorie manuelle -->
								<section class="rounded-xl border border-zinc-200 p-3">
									<h3 class="text-sm font-semibold">{m.transactions_manual_category_heading()}</h3>
									{#if splitsSavedCount !== null}
										<AlertBanner variant="success" size="sm" class="mt-2">
											{m.splits_success_saved({ count: splitsSavedCount })}
										</AlertBanner>
									{:else if splitsRemoved}
										<!-- Names the recovered category, which is what makes the removal obviously
										     lossless without a dialog having promised it in advance (1i). -->
										<AlertBanner variant="success" size="sm" class="mt-2">
											{m.splits_success_removed({
												category: categoryDisplayName(data.selectedTransaction.category)
											})}
										</AlertBanner>
									{/if}
									<form class="mt-3 grid gap-2" method="POST" action="?/saveManualCategory">
										<input type="hidden" name="transactionId" value={data.selectedTransaction.id} />
										<input type="hidden" name="manualCategory" value={manualCategoryValue} />
										<label class="grid gap-1 text-sm font-medium text-zinc-600">
											<span class="sr-only">{m.budgets_field_category()}</span>
											<!--
												D1 / 1j: neutralised IN SITU, never hidden and never silently ignored.
												`softDisabled` rather than `disabled` so it keeps its place in the tab
												order and can point at the sentence the editor renders below.
											-->
											<Combobox
												value={manualCategoryValue}
												options={[
													{ value: '', label: m.transactions_automatic() },
													...data.categoryOptions.map((c) => ({
														value: c,
														label: categoryDisplayName(c)
													}))
												]}
												placeholder={m.transactions_automatic()}
												ariaLabel={m.transactions_manual_category_heading()}
												softDisabled={splitEditorActive}
												aria-describedby={splitEditorActive ? desktopParentLockId : undefined}
												onValueChange={(v) => {
													manualCategoryValue = v;
												}}
											/>
										</label>
										{#if form?.manualCategoryError}
											<p class="text-xs text-rose-600">{form.manualCategoryError}</p>
										{/if}
										<div class="flex flex-wrap gap-2">
											<Button type="submit" size="sm" disabled={!categoryIsDirty}
												>{m.common_save()}</Button
											>
											<!--
												Withheld while the editor is open, and this is not cosmetic: this button
												submits `manualCategory=""`, which is a WRITE to the parent's category —
												the one thing D1 forbids while parts exist. The server refuses it anyway
												(`saveManualCategory` carries `splits: { none: {} }`), so offering it
												would be offering a button whose only outcome is a silent refusal.
											-->
											{#if data.selectedTransaction.manualCategory && !splitEditorActive}
												<Button
													type="submit"
													variant="secondary"
													size="sm"
													name="manualCategory"
													value="">{m.transactions_reset()}</Button
												>
											{/if}
										</div>
									</form>

									<!--
										1b: ONE action, 44px, directly under the selector, in the card it modifies —
										« on la trouve au moment exact où l'on constate qu'une catégorie ne suffit
										pas ». Not an overflow menu and not a footer button: that would make it a
										feature to discover instead of an answer to a difficulty. The label says what
										will happen rather than naming the feature.
									-->
									{#if data.selectedTransaction.splitEntryAvailable}
										<button
											type="button"
											class="mt-2 flex min-h-[44px] w-full items-center gap-2 rounded-xl px-1 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
											onclick={() => (splitDraftOpen = true)}
										>
											<svg
												viewBox="0 0 20 20"
												class="h-4 w-4 shrink-0"
												fill="none"
												aria-hidden="true"
											>
												<path
													d="M4 6h12M4 10h7M4 14h9"
													stroke="currentColor"
													stroke-width="1.5"
													stroke-linecap="round"
												/>
											</svg>
											{m.splits_entry_action()}
										</button>
									{/if}

									<p class="mt-2">
										<TapLink href="/categories">{m.transactions_manage_categories_link()}</TapLink>
									</p>
								</section>

								<!-- Répartition — spec §9.1's fourth sibling section -->
								{#if splitEditorActive}
									<section class="rounded-xl border border-zinc-200 p-3">
										<form method="POST" action={splitFormAction} use:enhance={enhanceSplitForm}>
											{#key splitPartsSignature}
												<SplitEditor
													transactionId={data.selectedTransaction.id}
													amountCents={data.selectedTransaction.amountCents}
													parentCategoryId={data.selectedTransaction.splitInheritCategoryId ?? ''}
													categoryOptions={data.splitCategoryOptions}
													existingParts={splitParts.length > 0 ? splitParts : null}
													conflictPositions={splitsConflictPositions}
													error={splitEditorError}
													parentLockId={desktopParentLockId}
													saving={splitSaving}
													bind:dirty={splitsDirtyDesktop}
												/>
											{/key}
										</form>
									</section>
								{/if}

								<!-- Nature manuelle -->
								<section class="rounded-xl border border-zinc-200 p-3">
									<h3 class="text-sm font-semibold">{m.transactions_manual_nature_heading()}</h3>
									<form class="mt-3 grid gap-2" method="POST" action="?/saveManualNature">
										<input type="hidden" name="transactionId" value={data.selectedTransaction.id} />
										<input type="hidden" name="manualNature" value={manualNatureValue} />
										<label class="grid gap-1 text-sm font-medium text-zinc-600">
											{m.categories_table_nature()}
											<Select
												value={manualNatureValue}
												options={[
													{ value: '', label: m.categories_nature_none() },
													...data.natureOptions.map((n) => ({
														value: n,
														label: formatNatureLabel(n)
													}))
												]}
												ariaLabel={m.transactions_manual_nature_heading()}
												onValueChange={(v) => {
													manualNatureValue = v;
												}}
											/>
										</label>
										{#if form?.manualNatureError}
											<p class="text-xs text-rose-600">{form.manualNatureError}</p>
										{/if}
										<div class="flex flex-wrap gap-2">
											<Button type="submit" size="sm" disabled={!natureIsDirty}
												>{m.common_save()}</Button
											>
											{#if data.selectedTransaction.manualNature}
												<Button
													type="submit"
													variant="secondary"
													size="sm"
													name="manualNature"
													value="">{m.transactions_reset()}</Button
												>
											{/if}
										</div>
									</form>
								</section>

								<!-- Étiquettes -->
								<TransactionTagsEditor
									transactionId={data.selectedTransaction.id}
									tags={data.selectedTransaction.tags}
									allTags={allTagOptions}
									error={form?.tagsError}
									bind:dirty={tagsDirtyDesktop}
								/>

								<!-- Détails bancaires -->
								<div class="rounded-xl border border-zinc-200">
									<h3 class="m-0">
										<button
											type="button"
											class="flex w-full items-center justify-between rounded-t-md px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:outline-none focus-visible:ring-inset"
											onclick={() => toggleSection('bankFields')}
											aria-expanded={openSections.has('bankFields')}
										>
											<span class="text-sm font-semibold"
												>{m.transactions_bank_details_heading()}</span
											>
											<svg
												aria-hidden="true"
												class="h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150 {openSections.has(
													'bankFields'
												)
													? 'rotate-180'
													: ''}"
												viewBox="0 0 20 20"
												fill="none"
											>
												<path
													d="M5.5 7.5 10 12l4.5-4.5"
													stroke="currentColor"
													stroke-width="1.5"
													stroke-linecap="round"
													stroke-linejoin="round"
												/>
											</svg>
										</button>
									</h3>
									{#if openSections.has('bankFields')}
										<div class="border-t border-zinc-100 px-4 py-4">
											{#if data.selectedTransaction.bankFields.length > 0 || data.selectedTransaction.account || data.selectedTransaction.bankOperationType}
												<dl class="grid gap-2 text-sm">
													{#if data.selectedTransaction.account}
														<div>
															<dt class="font-medium text-zinc-700">
																{m.transactions_account_label()}
															</dt>
															<dd class="mt-0.5 text-zinc-600">
																{#if data.selectedTransaction.account.netWorthAccountName}
																	{data.selectedTransaction.account.netWorthAccountName}
																{:else}
																	{data.selectedTransaction.account.name} · {data
																		.selectedTransaction.account.source}
																{/if}
															</dd>
														</div>
													{/if}
													{#if data.selectedTransaction.bankOperationType}
														<div>
															<dt class="font-medium text-zinc-700">
																{m.transactions_operation_type_label()}
															</dt>
															<dd class="mt-0.5 text-zinc-600">
																{data.selectedTransaction.bankOperationType}
															</dd>
														</div>
													{/if}
													{#each data.selectedTransaction.bankFields as field (field.label)}
														<div>
															<dt class="font-medium text-zinc-700">{field.label}</dt>
															<dd class="mt-0.5 text-zinc-600">{field.value}</dd>
														</div>
													{/each}
												</dl>
											{:else}
												<p class="text-sm text-zinc-500">{m.transactions_no_bank_details()}</p>
											{/if}
										</div>
									{/if}
								</div>

								<!-- Traçabilité -->
								<div class="rounded-xl border border-zinc-200">
									<h3 class="m-0">
										<button
											type="button"
											class="flex w-full items-center justify-between rounded-t-md px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:outline-none focus-visible:ring-inset"
											onclick={() => toggleSection('traceability')}
											aria-expanded={openSections.has('traceability')}
										>
											<span class="text-sm font-semibold"
												>{m.transactions_traceability_heading()}</span
											>
											<svg
												aria-hidden="true"
												class="h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150 {openSections.has(
													'traceability'
												)
													? 'rotate-180'
													: ''}"
												viewBox="0 0 20 20"
												fill="none"
											>
												<path
													d="M5.5 7.5 10 12l4.5-4.5"
													stroke="currentColor"
													stroke-width="1.5"
													stroke-linecap="round"
													stroke-linejoin="round"
												/>
											</svg>
										</button>
									</h3>
									{#if openSections.has('traceability')}
										<div class="border-t border-zinc-100 px-4 py-4">
											<dl class="grid gap-2 text-sm">
												{#if data.selectedTransaction.importBatch}
													<div>
														<dt class="font-medium text-zinc-700">
															{m.transactions_import_label()}
														</dt>
														<dd class="mt-0.5 text-zinc-600">
															<a
																class="text-zinc-700 underline-offset-2 hover:underline"
																href={resolve(
																	`/transactions?importBatch=${data.selectedTransaction.importBatch.id}` as `/transactions?${string}`
																)}
															>
																{data.selectedTransaction.importBatch.fileName ??
																	m.imports_default_file_name()}
															</a>
														</dd>
													</div>
												{/if}
												{#if data.selectedTransaction.reference}
													<div>
														<dt class="font-medium text-zinc-700">
															{m.transactions_reference_label()}
														</dt>
														<dd class="mt-0.5 text-zinc-600">
															{data.selectedTransaction.reference}
														</dd>
													</div>
												{/if}
												{#if data.selectedTransaction.dedupeKey}
													<div>
														<dt class="font-medium text-zinc-700">
															{m.transactions_dedupe_label()}
														</dt>
														<dd class="mt-0.5 text-zinc-600">
															{data.selectedTransaction.dedupeKey}
														</dd>
													</div>
												{/if}
												<div>
													<dt class="font-medium text-zinc-700">
														{m.transactions_created_label()}
													</dt>
													<dd class="mt-0.5 text-zinc-600">{data.selectedTransaction.createdAt}</dd>
												</div>
												<div>
													<dt class="font-medium text-zinc-700">
														{m.transactions_updated_label()}
													</dt>
													<dd class="mt-0.5 text-zinc-600">{data.selectedTransaction.updatedAt}</dd>
												</div>
											</dl>
										</div>
									{/if}
								</div>

								<!-- Notes -->
								<div class="rounded-xl border border-zinc-200">
									<h3 class="m-0">
										<button
											type="button"
											class="flex w-full items-center justify-between rounded-t-md px-4 py-3 text-left focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:outline-none focus-visible:ring-inset"
											onclick={() => toggleSection('notes')}
											aria-expanded={openSections.has('notes')}
										>
											<span class="text-sm font-semibold">{m.transactions_notes_heading()}</span>
											<svg
												aria-hidden="true"
												class="h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-150 {openSections.has(
													'notes'
												)
													? 'rotate-180'
													: ''}"
												viewBox="0 0 20 20"
												fill="none"
											>
												<path
													d="M5.5 7.5 10 12l4.5-4.5"
													stroke="currentColor"
													stroke-width="1.5"
													stroke-linecap="round"
													stroke-linejoin="round"
												/>
											</svg>
										</button>
									</h3>
									{#if openSections.has('notes')}
										<div class="border-t border-zinc-100 px-4 py-4">
											{#if data.selectedTransaction.notes}
												<p class="text-sm text-zinc-600">{data.selectedTransaction.notes}</p>
											{:else}
												<p class="text-sm text-zinc-400">{m.transactions_no_notes()}</p>
											{/if}
										</div>
									{/if}
								</div>
							</div>
						</div>
					</aside>
				</div>
			{/if}
		</div>

		<!-- ============ LISTE — MOBILE ============ -->
		<div class="space-y-4 lg:hidden">
			<div class="space-y-3">
				<div class="flex items-center justify-between gap-2">
					<div>
						{@render summaryCount()}
						{@render filteredTotalsRegion()}
					</div>
					<div class="flex gap-2">
						<Button
							variant="secondary"
							size="sm"
							class="h-9 !text-xs"
							href={buildPageHref(data.pagination.page - 1)}
							disabled={!data.pagination.hasPrevious}>{m.transactions_previous()}</Button
						>
						<Button
							variant="secondary"
							size="sm"
							class="h-9 !text-xs"
							href={buildPageHref(data.pagination.page + 1)}
							disabled={!data.pagination.hasNext}>{m.transactions_next()}</Button
						>
					</div>
				</div>
				{@render summaryActions('mobile')}
				{@render summaryDisabledReason('mobile')}
				{@render bulkOverLimitBanner()}
				{@render bulkTagBanner()}
			</div>

			{#if isNavigatingTransactions}
				<div class="space-y-3" role="status" aria-live="polite">
					<span class="sr-only">{m.common_loading_page()}</span>
					{#each { length: 5 } as _, i (i)}
						<!-- `chips` is what this skeleton is standing in for: these placeholders replace the
						     mobile ListCards that carry tag chips, so without the slot the row grows the moment
						     real data lands. Always drawn, never gated on whether the user has tags: there is no
						     count to know while the rows are still loading, and a slot that only appears
						     afterwards shifts the layout exactly as much as no slot at all. -->
						<Skeleton chips />
					{/each}
				</div>
			{:else if visibleTransactions.length > 0}
				<div class="space-y-3">
					{#each data.transactions as tx (tx.id)}
						{#if !resolvedIds.has(tx.id) && !ignoredIds.has(tx.id)}
							{#if classificationMode}
								<ListCard active={data.selectedTransaction?.id === tx.id}>
									<a
										href={resolve(buildSelectedHref(tx.id))}
										class="flex items-center gap-3 rounded-lg focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:outline-none"
									>
										<Avatar initials={getInitials(tx.label)} size={32} />
										<div class="min-w-0 flex-1">
											<p class="truncate text-[14.5px] font-semibold text-zinc-900">{tx.label}</p>
											<p class="mt-0.5 text-xs text-zinc-400">{formatDate(tx.date)}</p>
										</div>
										<div
											class="shrink-0 text-[14.5px] font-bold tabular-nums {tx.type === 'income'
												? 'text-emerald-600'
												: 'text-rose-600'}"
										>
											{formatCents(tx.amountCents)}
										</div>
									</a>

									{#if tx.suggestion}
										<div
											class="mt-3 flex items-center gap-2 rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2.5"
										>
											<svg
												class="h-3.5 w-3.5 shrink-0 text-zinc-500"
												viewBox="0 0 20 20"
												fill="none"
												aria-hidden="true"
											>
												<path
													d="M10 2.5 11.4 7.4 16.5 8.2 12.8 11.6 13.7 16.7 10 14.2 6.3 16.7 7.2 11.6 3.5 8.2 8.6 7.4 10 2.5Z"
													stroke="currentColor"
													stroke-width="1.3"
													stroke-linejoin="round"
												/>
											</svg>
											<span class="text-xs text-zinc-600">
												{m.transactions_suggested_label()}
												<strong class="font-bold text-zinc-900"
													>{categoryDisplayName(tx.suggestion.category)}</strong
												>
												{#if tx.suggestion.nature}
													· {formatNatureLabel(tx.suggestion.nature)}{/if}
											</span>
										</div>
										<div class="mt-3 flex items-center gap-2">
											<Button
												variant="ghost"
												size="sm"
												class="!flex min-h-[44px] items-center justify-center px-2"
												onclick={() => {
													ignoredIds = new Set([...ignoredIds, tx.id]);
												}}
											>
												{m.transactions_ignore()}
											</Button>
											<Button
												variant="secondary"
												size="sm"
												class="!flex min-h-[44px] flex-1 items-center justify-center"
												onclick={() => openRuleModal(tx.id, tx.label, tx.suggestion)}
											>
												{m.transactions_rule_button()}
											</Button>
											<form
												method="POST"
												action="?/acceptSuggestion"
												class="flex-1"
												use:enhance={() => {
													const txId = tx.id;
													acceptSubmittingIds = new Set([...acceptSubmittingIds, txId]);
													return async ({ result, update }) => {
														if (result.type === 'success')
															resolvedIds = new Set([...resolvedIds, txId]);
														await update({ reset: false });
														acceptSubmittingIds = new Set(
															[...acceptSubmittingIds].filter((id) => id !== txId)
														);
													};
												}}
											>
												<input type="hidden" name="transactionId" value={tx.id} />
												<input type="hidden" name="category" value={tx.suggestion.category} />
												<input type="hidden" name="nature" value={tx.suggestion.nature ?? ''} />
												<Button
													type="submit"
													variant="primary"
													size="sm"
													loading={acceptSubmittingIds.has(tx.id)}
													class="!flex min-h-[44px] w-full items-center justify-center"
												>
													{m.transactions_accept()}
												</Button>
											</form>
										</div>
									{:else}
										<p class="mt-3 text-xs text-zinc-400">{m.transactions_no_suggestion()}</p>
										<div class="mt-3 flex items-center gap-2">
											<Button
												variant="ghost"
												size="sm"
												class="!flex min-h-[44px] items-center justify-center px-2"
												onclick={() => {
													ignoredIds = new Set([...ignoredIds, tx.id]);
												}}
											>
												{m.transactions_ignore()}
											</Button>
											<Button
												variant="secondary"
												size="sm"
												class="!flex min-h-[44px] flex-1 items-center justify-center"
												onclick={() => openRuleModal(tx.id, tx.label, tx.suggestion)}
											>
												{m.transactions_rule_button()}
											</Button>
										</div>
									{/if}
								</ListCard>
							{:else}
								<ListCard
									href={buildSelectedHref(tx.id)}
									linkId={`tx-row-${tx.id}`}
									active={data.selectedTransaction?.id === tx.id}
								>
									<div class="flex items-center gap-3">
										<Avatar initials={getInitials(tx.label)} size={32} />
										<div class="min-w-0 flex-1">
											<p class="truncate text-[14.5px] font-semibold text-zinc-900">{tx.label}</p>
											<!-- PINNED TO 22px ON EVERY ROW, badge or no badge (design 1n/1o). An ordinary
											     meta line is 15px and the badge is 22 including its borders, so a répartie row
											     grew by 7 — the tags chantier's regression exactly: a component taller than the
											     line hosting it. The height is RESERVED here rather than paid by the rows that
											     carry one, which costs every 390 row 7px and about one row per screen at 844.
											     That is the price of a table whose height does not depend on its content, and
											     the alternative (a 15px badge) falls under the 24px target floor the moment it
											     becomes interactive again. Reserve the height on the line; never let the
											     content push it. -->
											<div class="mt-0.5 flex h-[22px] items-center gap-1.5 text-xs text-zinc-400">
												<span
													class="h-1.5 w-1.5 shrink-0 rounded-full {getCategoryColor(
														rowCategory(tx)
													)}"
												></span>
												<!-- TWO SPANS, NOT ONE, AND THAT IS 1n'S OWN STRUCTURE: the category is the
												     single element carrying `text-overflow: ellipsis` and everything beside it
												     is `flex-shrink:0`. Shipped as one span the ellipse landed on whatever came
												     last, which here is the NATURE — « Produits ménagers · Dépense… », a word
												     cut out of a closed set of seven, where a cut CATEGORY still reads as a
												     recognisable prefix of a name the user wrote. Same one line, same 22px, same
												     content; only which of the two gives way changes. -->
												<span class="min-w-0 truncate">{categoryDisplayName(rowCategory(tx))}</span>
												<span class="shrink-0">· {formatNatureLabel(rowNature(tx))}</span>
												<!-- Inert at 390: a 22px target glued to a full-row target is two destinations
												     under one thumb. The sentence that replaces « fois deux » travels inside the
												     component, so nothing here can render a badge without its explanation. -->
												{#if tx.splitIndicator}
													<SplitBadge
														parts={badgeParts(tx.splitIndicator)}
														otherCategoryCount={tx.splitIndicator.otherCategoryCount}
														dominantCategory={categoryDisplayName(rowCategory(tx))}
													/>
												{/if}
											</div>
										</div>
										<div class="shrink-0 text-right">
											<div
												class="text-[14.5px] font-bold tabular-nums {tx.type === 'income'
													? 'text-emerald-600'
													: 'text-rose-600'}"
											>
												{formatCents(rowAmountCents(tx))}
											</div>
											<!-- PR5: same rule as the desktop amount cell — see the comment there. -->
											{#if rowPartialMatch(tx)}
												<p class="mt-0.5 text-xs text-zinc-400">
													{m.transactions_row_matched_of({ amount: formatCents(tx.amountCents) })}
												</p>
											{/if}
										</div>
									</div>
									{#if tx.tags.length > 0}
										<div class="mt-1.5 pl-11">
											<TagChips tags={toTagChipItems(tx.tags)} size="sm" />
										</div>
									{/if}
								</ListCard>
							{/if}
						{/if}
					{/each}
				</div>
			{:else if classificationMode}
				{#snippet allClassifiedIcon()}
					<svg class="h-6 w-6" viewBox="0 0 20 20" fill="none" aria-hidden="true">
						<path
							d="M4 10.5 8 14.5 16 5.5"
							stroke="#16a34a"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				{/snippet}
				<EmptyState
					icon={allClassifiedIcon}
					iconBgClass="bg-emerald-50"
					title={m.transactions_empty_all_classified_title()}
				/>
			{:else}
				{#snippet noResultsIcon()}
					<svg class="h-5 w-5 text-zinc-400" viewBox="0 0 20 20" fill="none" aria-hidden="true">
						<circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="1.7" />
						<path
							d="M13.5 13.5 17 17"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
						/>
					</svg>
				{/snippet}
				{#snippet noResultsAction()}
					<span data-testid="empty-reset-filters">
						<TapLink href="/transactions">{m.transactions_reset_filters_link()}</TapLink>
					</span>
				{/snippet}
				<!-- Mobile counterpart of the desktop empty state: "Aucun résultat / Aucune transaction
				     ne correspond à ces filtres" describes an applied filter, which is exactly what did
				     NOT happen when the query was rejected. No reset action in that branch either — the
				     filter is still there to be corrected, and clearing it is not the fix. -->
				<EmptyState
					icon={noResultsIcon}
					title={filteredTotalsState === 'error'
						? m.transactions_empty_query_error_title()
						: m.transactions_empty_no_results_title()}
					description={filteredTotalsState === 'error'
						? m.transactions_empty_query_error_body()
						: m.transactions_empty_no_results_body()}
					action={filteredTotalsState === 'error' ? undefined : noResultsAction}
				/>
			{/if}
		</div>
	</section>

	<!-- Tone NEUTRAL, not danger. Abandoning an entry that was never saved is not destructive in the
	     referential's sense: nothing recorded is lost, only something typed. Rose here would spend
	     the alarm colour on the most ordinary interruption there is and leave nothing louder for
	     deleting a transaction, two dialogs away. -->
	{#if pendingNavigation}
		<form
			onsubmit={(event) => {
				// No server action: the confirm button is ConfirmDialog's own `type="submit"`, which
				// exists so the delete and bulk-tag dialogs can post. Here the "submission" is a
				// client-side navigation, so the default is prevented and the replay runs instead.
				event.preventDefault();
				void discardAndNavigate();
			}}
		>
			<ConfirmDialog
				open={pendingNavigation !== null}
				title={m.transactions_unsaved_title()}
				confirmLabel={m.transactions_unsaved_discard()}
				cancelLabel={m.transactions_unsaved_stay()}
				onClose={keepEditing}
			>
				<p class="text-sm text-zinc-600">{m.transactions_unsaved_body()}</p>
			</ConfirmDialog>
		</form>
	{/if}

	{#if pendingDelete}
		<form
			method="POST"
			action="?/deleteTransaction"
			use:enhance={() => {
				deleteSubmitting = true;
				return async ({ result, update }) => {
					if (result.type === 'success') closeDeleteConfirm();
					await update();
					deleteSubmitting = false;
				};
			}}
		>
			<input type="hidden" name="transactionId" value={pendingDelete.id} />
			<ConfirmDialog
				open={deleteConfirmOpen}
				title={m.transactions_delete_confirm_title({ label: pendingDelete.label })}
				confirmLabel={m.common_delete()}
				tone="danger"
				confirmLoading={deleteSubmitting}
				onClose={closeDeleteConfirm}
			>
				<p class="text-sm text-zinc-600">
					{m.transactions_delete_confirm_body({
						label: pendingDelete.label,
						amount: formatCents(pendingDelete.amountCents)
					})}
				</p>
				{#if form?.deleteError}
					<AlertBanner variant="error" class="mt-2">{form.deleteError}</AlertBanner>
				{/if}
			</ConfirmDialog>
		</form>
	{/if}

	{#if bulkTagOpen}
		<!-- The action URL, not the ambient "?/bulkTag" shorthand every other form action on this
		     page uses: see bulkTagActionHref's own comment. The GET filter form and this dialog's
		     form are otherwise identical in shape to the delete confirmation just above. -->
		<form
			method="POST"
			action={bulkTagActionHref}
			use:enhance={() => {
				bulkTagSubmitting = true;
				return async ({ update }) => {
					await update({ reset: false });
					bulkTagSubmitting = false;
				};
			}}
		>
			<ConfirmDialog
				open={bulkTagOpen}
				title={m.tags_bulk_confirm_title({ count: data.pagination.totalTransactions })}
				description={describeBulkTagFilter().join(' · ')}
				confirmLabel={m.tags_bulk_confirm_cta()}
				confirmLoading={bulkTagSubmitting}
				onClose={closeBulkTag}
			>
				<div class="space-y-3">
					<label for="bulk-tag-name" class="block text-left text-xs font-medium text-zinc-500">
						{m.tags_bulk_name_label()}
					</label>
					<input
						id="bulk-tag-name"
						class={inputBase}
						type="text"
						name="tagName"
						autocomplete="off"
						bind:value={bulkTagName}
						maxlength={MAX_TAG_NAME_LENGTH}
						placeholder={m.tags_bulk_name_placeholder()}
						required
					/>
					{#if bulkTagMatch}
						<!-- The second and last allowed tinted surface. It answers what a free-text field
						     alone cannot: that this name already exists, and which tag it is, in that tag's
						     own colour so it reads as the same object the user sees on their rows. -->
						<p class="flex flex-wrap items-center gap-2 text-left text-xs text-zinc-500">
							{m.tags_bulk_existing_tag()}
							<TagChips variant="tinted" max={Infinity} tags={toTagChipItems([bulkTagMatch])} />
						</p>
					{/if}
					{#if form?.bulkTagError}
						<AlertBanner variant="error">{form.bulkTagError}</AlertBanner>
					{/if}
				</div>
			</ConfirmDialog>
		</form>
	{/if}
</main>

<!-- ============ BOTTOM SHEET DÉTAIL — MOBILE ============ -->
<BottomSheet
	open={Boolean(data.selectedTransaction)}
	ariaLabel={data.selectedTransaction
		? data.selectedTransaction.label
		: m.transactions_detail_heading()}
	onClose={closeMobileSheet}
	initialFocus="panel"
>
	<!-- The date row and the label are the sheet's identity, so they sit in the fixed header rather
	     than at the top of the scrolling body: the body is 689px of panel against 936px of content,
	     measured at 390x844, and the label used to travel 247px out of view on the way down. Only
	     the identity is lifted — the amount and everything below it keep scrolling. -->
	{#snippet header()}
		{#if data.selectedTransaction}
			<div class="flex flex-col gap-1.5">
				<div class="flex items-center justify-between">
					<span class="text-[12.5px] font-medium text-zinc-400"
						>{formatDate(data.selectedTransaction.date)}</span
					>
					<button
						type="button"
						class="flex min-h-[44px] items-center border-0 bg-transparent p-0 text-[13px] font-semibold text-rose-600"
						onclick={() => {
							openDeleteConfirm(data.selectedTransaction!);
							closeMobileSheet();
						}}
					>
						{m.common_delete()}
					</button>
				</div>
				<p class="text-[17px] font-bold tracking-tight text-zinc-900">
					{data.selectedTransaction.label}
				</p>
			</div>
		{/if}
	{/snippet}
	{#if data.selectedTransaction}
		<div class="flex flex-col gap-4">
			<div class="flex flex-col gap-1.5">
				<p
					class="text-[30px] font-extrabold tracking-tight tabular-nums {data.selectedTransaction
						.type === 'income'
						? 'text-emerald-600'
						: 'text-rose-600'}"
				>
					{formatCents(data.selectedTransaction.amountCents)}
				</p>
			</div>

			<!-- Proposition (mode classement uniquement) : toujours affichée, cf. panneau desktop. -->
			{#if classificationMode}
				<TransactionProposalCard
					transactionId={data.selectedTransaction.id}
					suggestion={data.selectedSuggestion}
					categoryOptions={data.categoryOptions}
					natureOptions={data.natureOptions}
					variant="compact"
					{getCategoryColor}
					{formatNatureLabel}
					acceptError={form?.acceptError}
					onAccepted={handleAccepted}
					onIgnore={handleIgnore}
					onCreateRule={(category, nature) =>
						openRuleModal(data.selectedTransaction!.id, data.selectedTransaction!.label, {
							category,
							nature
						})}
				/>
			{/if}

			<!-- Résumé -->
			<dl class="flex flex-col gap-2.5 rounded-xl border border-zinc-100 bg-zinc-50 p-4 text-sm">
				<div class="flex items-center justify-between">
					<dt class="text-zinc-500">{m.transactions_summary_source()}</dt>
					<dd class="font-semibold text-zinc-900">{data.selectedTransaction.source}</dd>
				</div>
				<div class="flex items-center justify-between">
					<dt class="text-zinc-500">{m.transactions_summary_type()}</dt>
					<dd>
						<Badge tone={data.selectedTransaction.type === 'income' ? 'success' : 'danger'}>
							{data.selectedTransaction.type === 'income'
								? m.nature_income()
								: m.transactions_type_expense()}
						</Badge>
					</dd>
				</div>
				<div class="flex items-center justify-between">
					<dt class="text-zinc-500">{m.transactions_summary_nature()}</dt>
					<dd class="text-zinc-900">
						{formatNatureLabel(data.selectedTransaction.nature)}
						<span class="font-normal text-zinc-400"
							>({formatNatureSource(data.selectedTransaction.natureSource)})</span
						>
					</dd>
				</div>
			</dl>

			<!-- Catégorie -->
			<section class="flex flex-col gap-2">
				<div class="flex items-center justify-between">
					<h3 class="text-[13px] font-bold text-zinc-900">
						{m.transactions_manual_category_heading()}
					</h3>
					<!-- Withheld while the editor is open for the same reason as its desktop twin: it
					     writes the parent's category, which is what D1 forbids while parts exist. -->
					{#if data.selectedTransaction.manualCategory && !splitEditorActive}
						<button
							type="button"
							class="flex min-h-[44px] items-center border-0 bg-transparent p-0 text-xs font-semibold text-zinc-500 underline"
							onclick={() => {
								manualCategoryValue = '';
								mobileCategoryFormEl?.requestSubmit();
							}}
						>
							{m.transactions_reset()}
						</button>
					{/if}
				</div>
				{#if splitsSavedCount !== null}
					<AlertBanner variant="success" size="sm">
						{m.splits_success_saved({ count: splitsSavedCount })}
					</AlertBanner>
				{:else if splitsRemoved}
					<AlertBanner variant="success" size="sm">
						{m.splits_success_removed({
							category: categoryDisplayName(data.selectedTransaction.category)
						})}
					</AlertBanner>
				{/if}
				<form
					bind:this={mobileCategoryFormEl}
					class="flex flex-col gap-2"
					method="POST"
					action="?/saveManualCategory"
				>
					<input type="hidden" name="transactionId" value={data.selectedTransaction.id} />
					<input type="hidden" name="manualCategory" value={manualCategoryValue} />
					<Combobox
						value={manualCategoryValue}
						options={[
							{ value: '', label: m.transactions_automatic() },
							...data.categoryOptions.map((c) => ({ value: c, label: categoryDisplayName(c) }))
						]}
						placeholder={m.transactions_automatic()}
						ariaLabel={m.transactions_manual_category_heading()}
						softDisabled={splitEditorActive}
						aria-describedby={splitEditorActive ? mobileParentLockId : undefined}
						onValueChange={(v) => {
							manualCategoryValue = v;
						}}
						class="w-full"
						triggerClass="!bg-zinc-50"
					/>
					{#if form?.manualCategoryError}
						<p class="text-xs text-rose-600">{form.manualCategoryError}</p>
					{/if}
					<Button
						type="submit"
						size="sm"
						disabled={!categoryIsDirty}
						class="!flex min-h-[38px] items-center justify-center self-end px-4"
					>
						{m.common_save()}
					</Button>
				</form>

				<!-- 1b, the mobile twin: 48px here, since every control inside the sheet goes to 48 and
				     « le plancher de 44 l'emporte sans exception d'écran ». -->
				{#if data.selectedTransaction.splitEntryAvailable}
					<button
						type="button"
						class="flex min-h-12 w-full items-center gap-2 rounded-xl bg-zinc-50 px-3 text-left text-sm font-medium text-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
						onclick={() => (splitDraftOpen = true)}
					>
						<svg viewBox="0 0 20 20" class="h-4 w-4 shrink-0" fill="none" aria-hidden="true">
							<path
								d="M4 6h12M4 10h7M4 14h9"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
							/>
						</svg>
						{m.splits_entry_action()}
					</button>
				{/if}

				<p>
					<TapLink href="/categories">{m.transactions_manage_categories_link()}</TapLink>
				</p>
			</section>

			<!-- Répartition -->
			{#if splitEditorActive}
				<section class="flex flex-col gap-2">
					<form method="POST" action={splitFormAction} use:enhance={enhanceSplitForm}>
						{#key splitPartsSignature}
							<SplitEditor
								transactionId={data.selectedTransaction.id}
								amountCents={data.selectedTransaction.amountCents}
								parentCategoryId={data.selectedTransaction.splitInheritCategoryId ?? ''}
								categoryOptions={data.splitCategoryOptions}
								existingParts={splitParts.length > 0 ? splitParts : null}
								conflictPositions={splitsConflictPositions}
								error={splitEditorError}
								parentLockId={mobileParentLockId}
								saving={splitSaving}
								size="lg"
								bind:dirty={splitsDirtyMobile}
							/>
						{/key}
					</form>
				</section>
			{/if}

			<!-- Nature -->
			<section class="flex flex-col gap-2">
				<div class="flex items-center justify-between">
					<h3 class="text-[13px] font-bold text-zinc-900">
						{m.transactions_manual_nature_heading()}
					</h3>
					{#if data.selectedTransaction.manualNature}
						<button
							type="button"
							class="flex min-h-[44px] items-center border-0 bg-transparent p-0 text-xs font-semibold text-zinc-500 underline"
							onclick={() => {
								manualNatureValue = '';
								mobileNatureFormEl?.requestSubmit();
							}}
						>
							{m.transactions_reset()}
						</button>
					{/if}
				</div>
				<form
					bind:this={mobileNatureFormEl}
					class="flex flex-col gap-2"
					method="POST"
					action="?/saveManualNature"
				>
					<input type="hidden" name="transactionId" value={data.selectedTransaction.id} />
					<input type="hidden" name="manualNature" value={manualNatureValue} />
					<Select
						value={manualNatureValue}
						options={[
							{ value: '', label: m.categories_nature_none() },
							...data.natureOptions.map((n) => ({ value: n, label: formatNatureLabel(n) }))
						]}
						ariaLabel={m.transactions_manual_nature_heading()}
						onValueChange={(v) => {
							manualNatureValue = v;
						}}
						class="h-11 w-full !rounded-xl !border-zinc-200 !bg-zinc-50 px-3.5"
					/>
					{#if form?.manualNatureError}
						<p class="text-xs text-rose-600">{form.manualNatureError}</p>
					{/if}
					<Button
						type="submit"
						size="sm"
						disabled={!natureIsDirty}
						class="!flex min-h-[38px] items-center justify-center self-end px-4"
					>
						{m.common_save()}
					</Button>
				</form>
			</section>

			<!-- Étiquettes -->
			<TransactionTagsEditor
				transactionId={data.selectedTransaction.id}
				tags={data.selectedTransaction.tags}
				allTags={allTagOptions}
				error={form?.tagsError}
				bind:dirty={tagsDirtyMobile}
			/>

			<!-- Accordéons -->
			<div class="flex flex-col divide-y divide-zinc-100 border-t border-zinc-100">
				<button
					type="button"
					class="flex min-h-[48px] items-center justify-between py-3 text-left"
					onclick={() => toggleSection('bankFields')}
					aria-expanded={openSections.has('bankFields')}
				>
					<span class="text-sm font-semibold text-zinc-900"
						>{m.transactions_bank_details_heading()}</span
					>
					<svg
						aria-hidden="true"
						class="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-150 {openSections.has(
							'bankFields'
						)
							? 'rotate-180'
							: ''}"
						viewBox="0 0 20 20"
						fill="none"
					>
						<path
							d="M5.5 7.5 10 12l4.5-4.5"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</button>
				{#if openSections.has('bankFields')}
					<div class="pb-4">
						{#if data.selectedTransaction.bankFields.length > 0 || data.selectedTransaction.account || data.selectedTransaction.bankOperationType}
							<dl class="grid gap-2 text-sm">
								{#if data.selectedTransaction.account}
									<div>
										<dt class="font-medium text-zinc-700">{m.transactions_account_label()}</dt>
										<dd class="mt-0.5 text-zinc-600">
											{#if data.selectedTransaction.account.netWorthAccountName}
												{data.selectedTransaction.account.netWorthAccountName}
											{:else}
												{data.selectedTransaction.account.name} · {data.selectedTransaction.account
													.source}
											{/if}
										</dd>
									</div>
								{/if}
								{#if data.selectedTransaction.bankOperationType}
									<div>
										<dt class="font-medium text-zinc-700">
											{m.transactions_operation_type_label()}
										</dt>
										<dd class="mt-0.5 text-zinc-600">
											{data.selectedTransaction.bankOperationType}
										</dd>
									</div>
								{/if}
								{#each data.selectedTransaction.bankFields as field (field.label)}
									<div>
										<dt class="font-medium text-zinc-700">{field.label}</dt>
										<dd class="mt-0.5 text-zinc-600">{field.value}</dd>
									</div>
								{/each}
							</dl>
						{:else}
							<p class="text-sm text-zinc-500">{m.transactions_no_bank_details()}</p>
						{/if}
					</div>
				{/if}

				<button
					type="button"
					class="flex min-h-[48px] items-center justify-between py-3 text-left"
					onclick={() => toggleSection('traceability')}
					aria-expanded={openSections.has('traceability')}
				>
					<span class="text-sm font-semibold text-zinc-900"
						>{m.transactions_traceability_heading()}</span
					>
					<svg
						aria-hidden="true"
						class="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-150 {openSections.has(
							'traceability'
						)
							? 'rotate-180'
							: ''}"
						viewBox="0 0 20 20"
						fill="none"
					>
						<path
							d="M5.5 7.5 10 12l4.5-4.5"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</button>
				{#if openSections.has('traceability')}
					<div class="pb-4">
						<dl class="grid gap-2 text-sm">
							{#if data.selectedTransaction.importBatch}
								<div>
									<dt class="font-medium text-zinc-700">{m.transactions_import_label()}</dt>
									<dd class="mt-0.5 text-zinc-600">
										<a
											class="text-zinc-700 underline-offset-2 hover:underline"
											href={resolve(
												`/transactions?importBatch=${data.selectedTransaction.importBatch.id}` as `/transactions?${string}`
											)}
										>
											{data.selectedTransaction.importBatch.fileName ??
												m.imports_default_file_name()}
										</a>
									</dd>
								</div>
							{/if}
							{#if data.selectedTransaction.reference}
								<div>
									<dt class="font-medium text-zinc-700">{m.transactions_reference_label()}</dt>
									<dd class="mt-0.5 text-zinc-600">{data.selectedTransaction.reference}</dd>
								</div>
							{/if}
							{#if data.selectedTransaction.dedupeKey}
								<div>
									<dt class="font-medium text-zinc-700">{m.transactions_dedupe_label()}</dt>
									<dd class="mt-0.5 text-zinc-600">{data.selectedTransaction.dedupeKey}</dd>
								</div>
							{/if}
							<div>
								<dt class="font-medium text-zinc-700">{m.transactions_created_label()}</dt>
								<dd class="mt-0.5 text-zinc-600">{data.selectedTransaction.createdAt}</dd>
							</div>
							<div>
								<dt class="font-medium text-zinc-700">{m.transactions_updated_label()}</dt>
								<dd class="mt-0.5 text-zinc-600">{data.selectedTransaction.updatedAt}</dd>
							</div>
						</dl>
					</div>
				{/if}

				<button
					type="button"
					class="flex min-h-[48px] items-center justify-between py-3 text-left"
					onclick={() => toggleSection('notes')}
					aria-expanded={openSections.has('notes')}
				>
					<span class="text-sm font-semibold text-zinc-900">{m.transactions_notes_heading()}</span>
					<svg
						aria-hidden="true"
						class="h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-150 {openSections.has(
							'notes'
						)
							? 'rotate-180'
							: ''}"
						viewBox="0 0 20 20"
						fill="none"
					>
						<path
							d="M5.5 7.5 10 12l4.5-4.5"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</button>
				{#if openSections.has('notes')}
					<div class="pb-4">
						{#if data.selectedTransaction.notes}
							<p class="text-sm text-zinc-600">{data.selectedTransaction.notes}</p>
						{:else}
							<p class="text-sm text-zinc-400">{m.transactions_no_notes()}</p>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</BottomSheet>

<!-- Overlay mode focus : classement d'une transaction à la fois. -->
<TransactionFocusOverlay
	open={focusOpen}
	transaction={data.selectedTransaction}
	suggestion={data.selectedSuggestion}
	categoryOptions={data.categoryOptions}
	natureOptions={data.natureOptions}
	position={focusPosition}
	total={focusStackIds.length}
	canGoPrevious={focusPreviousId !== null}
	canGoNext={focusNextId !== null}
	autoAppliedCount={focusAutoAppliedCount}
	{getCategoryColor}
	{formatNatureLabel}
	{formatDate}
	{formatCents}
	acceptError={form?.acceptError}
	onClose={closeFocusMode}
	onPrevious={() => {
		if (focusPreviousId)
			goto(resolve(buildSelectedHref(focusPreviousId)), { keepFocus: true, noScroll: true });
	}}
	onNext={() => {
		if (focusNextId)
			goto(resolve(buildSelectedHref(focusNextId)), { keepFocus: true, noScroll: true });
	}}
	onAccepted={handleAccepted}
	onIgnore={handleIgnore}
	onCreateRule={(category, nature) => {
		if (data.selectedTransaction)
			createRuleInFocusMode(
				data.selectedTransaction.id,
				data.selectedTransaction.label,
				category,
				nature
			);
	}}
/>

<!-- Création de règle directe en mode focus (pas de modal) : soumis par createRuleInFocusMode(),
     qui catégorise d'abord la transaction courante (formulaire ci-dessous) puis crée la règle. -->
<form
	bind:this={quickAcceptFormEl}
	method="POST"
	action="?/acceptSuggestion"
	class="hidden"
	use:enhance={() =>
		async ({ result, update }) => {
			await update({ reset: false });
			quickAcceptDone?.(result.type === 'success');
			quickAcceptDone = null;
		}}
>
	<input type="hidden" name="transactionId" value={quickAcceptTarget?.id ?? ''} />
	<input type="hidden" name="category" value={quickAcceptTarget?.category ?? ''} />
	<input type="hidden" name="nature" value={quickAcceptTarget?.nature ?? ''} />
</form>
<form
	bind:this={quickCreateRuleFormEl}
	method="POST"
	action="?/createRule"
	class="hidden"
	use:enhance={() =>
		async ({ result, update }) => {
			await update({ reset: false });
			const autoAppliedIds =
				result.type === 'success' && result.data && Array.isArray(result.data.autoAppliedIds)
					? (result.data.autoAppliedIds as string[])
					: [];
			quickCreateRuleDone?.(result.type === 'success', autoAppliedIds);
			quickCreateRuleDone = null;
		}}
>
	<input type="hidden" name="name" value={quickCreateRuleTarget?.name ?? ''} />
	<input type="hidden" name="matchText" value={quickCreateRuleTarget?.matchText ?? ''} />
	<input type="hidden" name="targetCategory" value={quickCreateRuleTarget?.targetCategory ?? ''} />
	<input type="hidden" name="targetNature" value={quickCreateRuleTarget?.targetNature ?? ''} />
	{#each quickCreateRuleRemainingIds as remainingId (remainingId)}
		<input type="hidden" name="focusRemainingIds" value={remainingId} />
	{/each}
</form>

<!-- Modal : créer une règle -->
<Modal
	open={createRuleOpen}
	title={m.transactions_create_rule()}
	variant="compact"
	onClose={() => {
		createRuleOpen = false;
	}}
>
	<!-- Titre mobile visible : le header par défaut de Modal passe sr-only sous lg
	     (cf. variant="compact"). Marqué aria-hidden pour éviter un double-discours
	     avec ce header sr-only, qui porte déjà le nom accessible du dialogue. -->
	<p class="mb-4 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
		{m.transactions_create_rule()}
	</p>
	<form
		method="POST"
		action="?/createRule"
		class="grid gap-3"
		use:enhance={() => {
			createRuleSubmitting = true;
			return async ({ result, update }) => {
				if (result.type === 'success') {
					createRuleOpen = false;
					if (focusOpen && ruleTarget) {
						applyFocusOutcome('createRule', ruleTarget.id);
					}
				}
				await update({ reset: false });
				createRuleSubmitting = false;
			};
		}}
	>
		<label class="grid gap-1 text-sm font-medium text-zinc-600">
			{m.transactions_rule_name_label()}
			<input
				class="{inputBase} !bg-zinc-50 lg:!bg-white"
				name="name"
				type="text"
				required
				maxlength="80"
				value={ruleTarget?.label.slice(0, 40) ?? ''}
				placeholder={m.transactions_rule_name_placeholder()}
			/>
		</label>
		<label class="grid gap-1 text-sm font-medium text-zinc-600">
			{m.transactions_rule_match_label()}
			<input
				class="{inputBase} !bg-zinc-50 lg:!bg-white"
				name="matchText"
				type="text"
				required
				maxlength="80"
				value={ruleTarget?.matchText ?? ''}
				placeholder={m.transactions_rule_match_placeholder()}
			/>
		</label>
		<label class="grid gap-1 text-sm font-medium text-zinc-600">
			{m.rules_field_target_category()}
			<Combobox
				name="targetCategory"
				value={ruleTarget?.targetCategory ?? ''}
				options={data.categoryOptions.map((c) => ({ value: c, label: categoryDisplayName(c) }))}
				placeholder={m.transactions_rule_target_category_placeholder()}
				ariaLabel={m.rules_field_target_category()}
				triggerClass="!bg-zinc-50 lg:!bg-white"
				required
			/>
		</label>
		<label class="grid gap-1 text-sm font-medium text-zinc-600">
			{m.transactions_rule_nature_label()}
			<Select
				name="targetNature"
				value={ruleTarget?.targetNature ?? ''}
				ariaLabel={m.rules_field_target_nature()}
				options={[
					{ value: '', label: '—' },
					...data.natureOptions.map((n) => ({ value: n, label: formatNatureLabel(n) }))
				]}
				class="!bg-zinc-50 lg:!bg-white"
			/>
		</label>
		{#if form?.createRuleError}
			<AlertBanner variant="error">{form.createRuleError}</AlertBanner>
		{/if}
		<div class="flex gap-2 pt-1">
			<TapLink
				class="flex-1 justify-center lg:flex-none"
				onclick={() => {
					createRuleOpen = false;
				}}>{m.common_cancel()}</TapLink
			>
			<Button
				type="submit"
				variant="primary"
				class="flex-1 lg:flex-none"
				loading={createRuleSubmitting}>{m.transactions_create_rule_submit()}</Button
			>
		</div>
	</form>
</Modal>
