<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import { tick } from 'svelte';
	import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
	import { formatCents } from '$lib/domain/budget';
	import { resolveCategoryColorClass } from '$lib/domain/colors';
	import { buildDefaultKeyByName, categoryLabelByName } from '$lib/domain/categoryLabels';
	import { natureLabel } from '$lib/domain/natureLabels';
	import { isTransactionNature } from '$lib/domain/transaction';
	import { isTagColorToken, MAX_TAG_NAME_LENGTH, type TagColorToken } from '$lib/domain/tags';
	import { getInitials } from '$lib/domain/initials';
	import { buildTransactionsHref, buildTransactionsExportHref } from './hrefs';
	import { normalizeForMatch } from '$lib/domain/normalize';
	import type { ActionData, PageData } from './$types';
	import Button from '$lib/components/Button.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import BottomSheet from '$lib/components/BottomSheet.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import Avatar from '$lib/components/Avatar.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import TransactionProposalCard from '$lib/components/TransactionProposalCard.svelte';
	import TransactionTagsEditor from '$lib/components/TransactionTagsEditor.svelte';
	import TransactionFocusOverlay from '$lib/components/TransactionFocusOverlay.svelte';
	import TagChips from '$lib/components/ui/TagChips.svelte';
	import {
		getAdjacentFocusStackId,
		getFocusOutcomeForAction,
		getRemainingFocusStackIds
	} from '$lib/domain/transactionFocus';
	import { cardBase, inputBase, inputFilter } from '$lib/styles';
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

	// Whether the id filter is actually active (see the idsFilterNotice snippet). False when the
	// param is absent — and also when it was present but empty, which is exactly the collapse
	// `filters.ids` documents: an empty list yields no rows, so there is nothing to explain and no
	// filter worth advertising. The count shown alongside it is `pagination.totalTransactions`, not
	// the id count: an anchor can point at a transaction since deleted, and the row count is the
	// honest number of what is actually on screen.
	const idsFilterActive = $derived(Boolean(data.filters.ids));

	const defaultKeyByName = $derived(buildDefaultKeyByName(data.categories));
	function displayCategory(name: string): string {
		return categoryLabelByName(name, defaultKeyByName);
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
				m.tags_bulk_filter_category({ category: displayCategory(data.filters.category) })
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
	// (+page.server.ts:parseListFilters, driven from `url.searchParams`), because the plain
	// shorthand `action="?/bulkTag"` would resolve against the current URL and REPLACE its query
	// string entirely — dropping every active filter and applying the tag to an unfiltered set.
	// `buildTransactionsHref` already emits exactly the params `parseListFilters` consumes (q,
	// qMode, category, from, to, importBatch, tag, type, ids), so appending the bare action marker
	// to it keeps the two in lockstep with no separate list to maintain.
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
	const buildPageHref = (page: number) =>
		buildTransactionsHref(data.filters, { page: String(page) }, { keepIds: true });
	const buildSelectedHref = (id: string) =>
		buildTransactionsHref(
			data.filters,
			{ page: String(data.pagination.page), selected: id },
			{ keepIds: true }
		);
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

	async function closeMobileSheet() {
		// Opening the sheet is a real navigation (?selected=<id>), so focus was
		// already on <body> when it opened — BottomSheet's own focus restore has
		// nothing useful to give back. Re-establish keyboard context explicitly by
		// refocusing the opener row. Exception: the delete flow closes the sheet
		// with ConfirmDialog open and holding focus — stealing it would break that
		// modal's Tab trap. (Can't detect this via document.activeElement: the
		// sheet's 220ms exit transition keeps it — and the focus inside it — in
		// the DOM past goto's resolution.)
		const txId = data.selectedTransaction?.id;
		await goto(resolve(buildPageHref(data.pagination.page)), { keepFocus: true });
		if (txId && !deleteConfirmOpen) {
			document.getElementById(`tx-row-${txId}`)?.focus();
		}
	}

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

		<!-- Result of the last bulk-tag action, following upcoming-bills/+page.svelte's undo banner
		     shape exactly (see its comment at :752-786): the undo form sits OUTSIDE AlertBanner
		     because the banner renders a <p>, and a <form> start tag would close that open <p> in the
		     HTML parser. The button carries `form=` so it can still live visually inside the banner.
		     Keyed on `bulkTagResult` so a second identical bulk-tag action (same tag, same count) is
		     announced again instead of reusing an already-dismissed banner.
		     Deliberately no `autoDismissMs` override on this one (defaults apply): the undo it carries
		     is available for as long as the banner is, and the deviation only applies to the "applied"
		     banner just below, which DOES override it. -->
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
				{#if data.filters.type !== 'all'}
					<input type="hidden" name="type" value={data.filters.type} />
				{/if}
				{#if data.filters.importBatchId}
					<input type="hidden" name="importBatch" value={data.filters.importBatchId} />
				{/if}
				<div class="flex items-center gap-1">
					<IconButton
						pressed={searchIsRegex}
						label={m.transactions_regex_toggle_aria()}
						title={m.transactions_regex_toggle_aria()}
						onclick={() => (searchIsRegex = !searchIsRegex)}
					>
						r
					</IconButton>
					<input type="hidden" name="qMode" value={searchIsRegex ? 'regex' : 'contains'} />
					<SearchBar
						name="q"
						value={data.filters.q}
						placeholder={m.transactions_search_placeholder()}
						ariaLabel={m.transactions_search_label()}
						error={Boolean(data.queryError)}
						clearLabel={m.common_search_clear_aria()}
					/>
				</div>
				<Combobox
					name="category"
					value={data.filters.category}
					options={[
						{ value: '', label: m.transactions_category_filter_all() },
						...data.categoryOptions.map((c) => ({ value: c, label: displayCategory(c) }))
					]}
					placeholder={m.transactions_category_filter_placeholder()}
					ariaLabel={m.transactions_category_filter_aria()}
					class="w-48"
				/>
				{#if data.allTags.length > 0}
					{#if activeFilterTag}
						<!-- Active state: the tag's own tinted chip rather than a control showing its name as
						     plain text. This is one of the two surfaces the design allows a tint on, and the
						     one where the colour is genuinely useful: which filter is applied is readable at
						     a glance. Removing it clears only the tag, keeping every other filter. -->
						<TagChips
							variant="tinted"
							max={Infinity}
							tags={toTagChipItems([activeFilterTag])}
							onRemove={clearTagFilter}
						/>
					{:else}
						<Combobox
							name="tag"
							value={data.filters.tag}
							options={[
								{ value: '', label: m.tags_filter_all() },
								...data.allTags.map((t) => ({ value: t.id, label: t.name }))
							]}
							placeholder={m.tags_filter_placeholder()}
							ariaLabel={m.tags_filter_aria()}
							class="w-48"
						/>
					{/if}
				{/if}
				<div class="flex items-center gap-1.5">
					<label for="tx-from" class="text-xs font-medium text-zinc-500"
						>{m.reports_from_label()}</label
					>
					<input
						id="tx-from"
						class="{inputFilter} tabular-nums {data.dateRangeError
							? '!border-rose-300 !bg-rose-50'
							: ''}"
						name="from"
						type="date"
						value={data.filters.from}
					/>
				</div>
				<div class="flex items-center gap-1.5">
					<label for="tx-to" class="text-xs font-medium text-zinc-500">{m.reports_to_label()}</label
					>
					<input
						id="tx-to"
						class="{inputFilter} tabular-nums {data.dateRangeError
							? '!border-rose-300 !bg-rose-50'
							: ''}"
						name="to"
						type="date"
						value={data.filters.to}
					/>
				</div>
				<Button type="submit" size="field">{m.transactions_submit_filter()}</Button>
				<Button href="/transactions" variant="secondary" size="field">
					{m.transactions_reset()}
				</Button>
				<!-- Native `disabled` would drop this control from the tab order and announce nothing
				     when a screen-reader user tabs onto it; `aria-disabled` keeps it focusable so the
				     reason stays reachable at the keyboard. Not a Button/TapLink instance: both apply
				     real `disabled` to their <button> branch.
				     One channel for the reason, not two: no `title` (a second, redundant source), and
				     the explanation is the SAME visible sentence `aria-describedby` points at below —
				     never a duplicate in an `aria-label`. Its text stays `zinc-500` (not `zinc-400`,
				     not dimmed further by an `opacity` class): measured at 4.6:1, an inactive control
				     must stay readable, not fade toward invisible. -->
				<button
					type="button"
					class="inline-flex h-11 shrink-0 items-center justify-center rounded-xl border px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 focus-visible:outline-none {bulkTagFilterActive
						? 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50'
						: 'cursor-not-allowed border-zinc-200 bg-white text-zinc-500'}"
					aria-disabled={bulkTagFilterActive ? undefined : 'true'}
					aria-describedby={bulkTagFilterActive ? undefined : 'bulk-tag-disabled-reason-desktop'}
					onclick={openBulkTag}
				>
					{m.tags_bulk_cta()}
				</button>
			</form>
			{#if !bulkTagFilterActive}
				<p id="bulk-tag-disabled-reason-desktop" class="mt-2 text-sm text-zinc-500">
					{m.tags_bulk_cta_disabled_hint()}
				</p>
			{/if}
			{#if data.queryError}
				<p class="mt-2 text-sm font-medium text-rose-600">
					{m.transactions_error_invalid_regex_query()}
				</p>
			{/if}
			{#if data.dateRangeError}
				<p class="mt-2 text-sm font-medium text-rose-600">{m.date_range_error_invalid_custom()}</p>
			{/if}
			{@render idsFilterNotice()}
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
				{#if data.filters.type !== 'all'}
					<input type="hidden" name="type" value={data.filters.type} />
				{/if}
				{#if data.filters.importBatchId}
					<input type="hidden" name="importBatch" value={data.filters.importBatchId} />
				{/if}
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
				{/if}

				<Combobox
					name="category"
					value={data.filters.category}
					options={[
						{ value: '', label: m.transactions_category_filter_all() },
						...data.categoryOptions.map((c) => ({ value: c, label: displayCategory(c) }))
					]}
					placeholder={m.transactions_category_filter_placeholder()}
					ariaLabel={m.transactions_category_filter_aria()}
					class="w-full"
					triggerClass="!bg-zinc-50"
				/>
				{#if data.allTags.length > 0}
					{#if activeFilterTag}
						<!-- Same active state as the desktop bar; see its comment there. -->
						<TagChips
							variant="tinted"
							max={Infinity}
							tags={toTagChipItems([activeFilterTag])}
							onRemove={clearTagFilter}
						/>
					{:else}
						<Combobox
							name="tag"
							value={data.filters.tag}
							options={[
								{ value: '', label: m.tags_filter_all() },
								...data.allTags.map((t) => ({ value: t.id, label: t.name }))
							]}
							placeholder={m.tags_filter_placeholder()}
							ariaLabel={m.tags_filter_aria()}
							class="w-full"
							triggerClass="!bg-zinc-50"
						/>
					{/if}
				{/if}
				<div class="flex gap-2">
					<div class="flex-1">
						<label for="tx-from-mobile" class="block px-0.5 text-xs font-medium text-zinc-500">
							{m.reports_from_label()}
						</label>
						<input
							id="tx-from-mobile"
							class="{inputFilter} mt-1 w-full !bg-zinc-50 tabular-nums {data.dateRangeError
								? '!border-rose-300 !bg-rose-50'
								: ''}"
							name="from"
							type="date"
							value={data.filters.from}
						/>
					</div>
					<div class="flex-1">
						<label for="tx-to-mobile" class="block px-0.5 text-xs font-medium text-zinc-500">
							{m.reports_to_label()}
						</label>
						<input
							id="tx-to-mobile"
							class="{inputFilter} mt-1 w-full !bg-zinc-50 tabular-nums {data.dateRangeError
								? '!border-rose-300 !bg-rose-50'
								: ''}"
							name="to"
							type="date"
							value={data.filters.to}
						/>
					</div>
				</div>
				{#if data.dateRangeError}
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
						{m.date_range_error_invalid_custom()}
					</p>
				{/if}
				{@render idsFilterNotice()}

				<div class="flex gap-2 pt-1">
					<Button href="/transactions" variant="secondary" class="h-11 flex-1">
						{m.transactions_reset()}
					</Button>
					<Button type="submit" class="!flex h-11 flex-1 !items-center !justify-center">
						{m.transactions_submit_filter()}
					</Button>
				</div>
				<!-- Same aria-disabled trigger as the desktop bar (see the comment there: one channel
				     for the reason, no title, zinc-500 not opacity-dimmed), mobile copy. -->
				<button
					type="button"
					class="flex h-11 w-full items-center justify-center rounded-xl border text-sm font-semibold focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 focus-visible:outline-none {bulkTagFilterActive
						? 'border-zinc-300 bg-white text-zinc-700'
						: 'cursor-not-allowed border-zinc-200 bg-white text-zinc-500'}"
					aria-disabled={bulkTagFilterActive ? undefined : 'true'}
					aria-describedby={bulkTagFilterActive ? undefined : 'bulk-tag-disabled-reason-mobile'}
					onclick={openBulkTag}
				>
					{m.tags_bulk_cta()}
				</button>
				{#if !bulkTagFilterActive}
					<p id="bulk-tag-disabled-reason-mobile" class="px-0.5 text-sm text-zinc-500">
						{m.tags_bulk_cta_disabled_hint()}
					</p>
				{/if}
			</form>
		</div>

		<!-- ============ TABLEAU + PANNEAU DÉTAIL — DESKTOP ============ -->
		<div class="hidden gap-6 lg:grid xl:grid-cols-[1fr_400px]">
			<!-- Section tableau -->
			<section class="rounded-lg border border-zinc-200 bg-white">
				<!-- En-tête tableau : pagination -->
				<div class="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
					<div>
						<p class="text-sm text-zinc-600">
							{data.pagination.totalTransactions > 1
								? m.transactions_count_many({
										count: data.pagination.totalTransactions,
										page: data.pagination.page
									})
								: m.transactions_count_one({
										count: data.pagination.totalTransactions,
										page: data.pagination.page
									})}
						</p>
						{#if data.filteredTotals.incomeCents > 0 || data.filteredTotals.expenseCents > 0}
							<p class="text-xs text-zinc-500 tabular-nums">
								{m.transactions_totals_summary({
									income: formatCents(data.filteredTotals.incomeCents),
									expense: formatCents(data.filteredTotals.expenseCents)
								})}
							</p>
						{/if}
					</div>
					<div class="flex gap-2">
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
										<th class="px-4 py-2.5">{m.transactions_table_category()}</th>
										<!-- A dedicated column, not chips at the end of the label. The design grants the
										     row-chips exception to "a table shows only what you scan at a glance" ONLY
										     against this counterpart: "colonne dédiée de 190 px (pas de puce en fin de
										     libellé, qui déchirerait la colonne de gauche)". Chips under the label tear
										     the left column ragged, and the eye then hunts for them instead of running
										     down one vertical band. Rendered even when the user has no tags, so rows do
										     not change shape the moment a first tag appears. -->
										<th class="w-[190px] px-4 py-2.5">{m.transactions_table_tags()}</th>
										<th class="px-4 py-2.5 text-right">{m.transactions_table_amount()}</th>
									</tr>
								{/if}
							</thead>
							<tbody>
								{#each data.transactions as tx (tx.id)}
									{#if !resolvedIds.has(tx.id) && !ignoredIds.has(tx.id)}
										{#if classificationMode}
											<!-- Ligne mode classement -->
											<tr
												class="border-b border-zinc-100 last:border-0 {data.selectedTransaction
													?.id === tx.id
													? 'bg-zinc-50 ring-1 ring-zinc-900/10 ring-inset'
													: 'hover:bg-zinc-50/50'}"
											>
												<td class="px-4 py-3 align-top">
													<a href={resolve(buildSelectedHref(tx.id))} class="block">
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
																	{displayCategory(tx.suggestion.category)}
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
												class="border-b border-zinc-100 last:border-0 {data.selectedTransaction
													?.id === tx.id
													? 'bg-zinc-50 ring-1 ring-zinc-900/10 ring-inset'
													: 'hover:bg-zinc-50/50'}"
											>
												<td class="max-w-[260px] px-4 py-3">
													<a
														class="line-clamp-2 font-medium text-zinc-900 underline-offset-2 hover:underline"
														href={resolve(buildSelectedHref(tx.id))}>{tx.label}</a
													>
													<p class="mt-0.5 text-xs text-zinc-400">{formatDate(tx.date)}</p>
												</td>
												<td class="px-4 py-3">
													<div class="flex items-center gap-1.5">
														<span
															class="h-2 w-2 shrink-0 rounded-full {getCategoryColor(tx.category)}"
														></span>
														<span class="text-zinc-700">{displayCategory(tx.category)}</span>
													</div>
													<p class="mt-0.5 ml-3.5 text-xs text-zinc-500">
														{formatNatureLabel(tx.nature)}
													</p>
												</td>
												<td class="w-[190px] px-4 py-3">
													{#if tx.tags.length > 0}
														<TagChips tags={toTagChipItems(tx.tags)} size="sm" />
													{/if}
												</td>
												<td
													class="px-4 py-3 text-right font-semibold tabular-nums {tx.type ===
													'income'
														? 'text-emerald-700'
														: 'text-rose-600'}"
												>
													{formatCents(tx.amountCents)}
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
							{:else}
								<p class="text-sm text-zinc-500">{m.transactions_no_transactions_criteria()}</p>
								<div class="mt-2">
									<TapLink href="/transactions">{m.transactions_reset_filters_link()}</TapLink>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			</section>

			<!-- Panneau détail -->
			<aside class="rounded-lg border border-zinc-200 bg-white">
				<div class="border-b border-zinc-200 px-4 py-3">
					<h2 class="text-base font-semibold">{m.transactions_detail_heading()}</h2>
				</div>
				{#if data.selectedTransaction}
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
								{displayCategory}
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
								<form class="mt-3 grid gap-2" method="POST" action="?/saveManualCategory">
									<input type="hidden" name="transactionId" value={data.selectedTransaction.id} />
									<input type="hidden" name="manualCategory" value={manualCategoryValue} />
									<label class="grid gap-1 text-sm font-medium text-zinc-600">
										<span class="sr-only">{m.budgets_field_category()}</span>
										<Combobox
											value={manualCategoryValue}
											options={[
												{ value: '', label: m.transactions_automatic() },
												...data.categoryOptions.map((c) => ({
													value: c,
													label: displayCategory(c)
												}))
											]}
											placeholder={m.transactions_automatic()}
											ariaLabel={m.transactions_manual_category_heading()}
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
										{#if data.selectedTransaction.manualCategory}
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
								<p class="mt-2">
									<TapLink href="/categories">{m.transactions_manage_categories_link()}</TapLink>
								</p>
							</section>

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
																{data.selectedTransaction.account.name} · {data.selectedTransaction
																	.account.source}
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
													<dt class="font-medium text-zinc-700">
														{m.transactions_reference_label()}
													</dt>
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
				{:else}
					<p class="px-4 py-6 text-sm text-zinc-500">
						{m.transactions_select_prompt()}
					</p>
				{/if}
			</aside>
		</div>

		<!-- ============ LISTE — MOBILE ============ -->
		<div class="space-y-4 lg:hidden">
			<div class="flex items-center justify-between gap-2">
				<div>
					<p class="text-sm text-zinc-500">
						{data.pagination.totalTransactions > 1
							? m.transactions_count_many({
									count: data.pagination.totalTransactions,
									page: data.pagination.page
								})
							: m.transactions_count_one({
									count: data.pagination.totalTransactions,
									page: data.pagination.page
								})}
					</p>
					{#if data.filteredTotals.incomeCents > 0 || data.filteredTotals.expenseCents > 0}
						<p class="text-xs text-zinc-500 tabular-nums">
							{m.transactions_totals_summary({
								income: formatCents(data.filteredTotals.incomeCents),
								expense: formatCents(data.filteredTotals.expenseCents)
							})}
						</p>
					{/if}
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
													>{displayCategory(tx.suggestion.category)}</strong
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
											<div class="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-400">
												<span
													class="h-1.5 w-1.5 shrink-0 rounded-full {getCategoryColor(tx.category)}"
												></span>
												<span class="truncate"
													>{displayCategory(tx.category)} · {formatNatureLabel(tx.nature)}</span
												>
											</div>
										</div>
										<div
											class="shrink-0 text-[14.5px] font-bold tabular-nums {tx.type === 'income'
												? 'text-emerald-600'
												: 'text-rose-600'}"
										>
											{formatCents(tx.amountCents)}
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
					<TapLink href="/transactions">{m.transactions_reset_filters_link()}</TapLink>
				{/snippet}
				<EmptyState
					icon={noResultsIcon}
					title={m.transactions_empty_no_results_title()}
					description={m.transactions_empty_no_results_body()}
					action={noResultsAction}
				/>
			{/if}
		</div>
	</section>

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
>
	{#if data.selectedTransaction}
		<div class="flex flex-col gap-4">
			<!-- En-tête -->
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
					{displayCategory}
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
					{#if data.selectedTransaction.manualCategory}
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
							...data.categoryOptions.map((c) => ({ value: c, label: displayCategory(c) }))
						]}
						placeholder={m.transactions_automatic()}
						ariaLabel={m.transactions_manual_category_heading()}
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
				<p>
					<TapLink href="/categories">{m.transactions_manage_categories_link()}</TapLink>
				</p>
			</section>

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
	{displayCategory}
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
				options={data.categoryOptions.map((c) => ({ value: c, label: displayCategory(c) }))}
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
