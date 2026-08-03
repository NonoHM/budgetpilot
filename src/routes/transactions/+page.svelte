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
	import FilterDropdown from '$lib/components/ui/FilterDropdown.svelte';
	import ManageTagsFooter from '$lib/components/ui/ManageTagsFooter.svelte';
	import { tagColorBgClass, tagTintBgClass } from '$lib/domain/colors';
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
	function applyFilterDimension(patch: { category?: string; tag?: string }) {
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
		data.categoryOptions.map((name) => ({ value: name, label: displayCategory(name) }))
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

	/** The total for the "Toutes" return row: the filtered set with the tag dimension removed. */
	const tagFilterAllCount = $derived(
		data.tagCounts === null ? null : data.pagination.totalTransactions
	);

	const activeCategoryLabel = $derived(
		data.filters.category
			? m.transactions_filter_active_trigger({
					dimension: m.transactions_filter_dimension_category(),
					value: displayCategory(data.filters.category)
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
	const colCategory = $derived(detailOpen ? 'w-[140px]' : 'w-[160px]');
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
	 * Closing returns focus to the row the user came from.
	 *
	 * `goto` runs SvelteKit's `reset_focus()`, which lands on `<body>` — so without this the next Tab
	 * restarts at the top of the page, several dozen stops away from where the user was working. The
	 * row is looked up AFTER the navigation because the panel that held focus no longer exists.
	 */
	async function closeDetail() {
		const id = data.selectedTransaction?.id;
		await goto(resolve(buildDeselectedHref()), { noScroll: true });
		if (id) document.querySelector<HTMLElement>(`[data-testid="tx-row-${id}"] a`)?.focus();
	}

	/**
	 * Escape closes the panel, wherever focus sits inside it.
	 *
	 * Bound to the `<aside>` rather than to `window` on purpose: a control inside the panel gets the
	 * key first and may consume it. TagPicker calls `stopPropagation()` on Escape while its list is
	 * open, and that is exactly what makes the layering work — the first Escape closes the picker,
	 * the second reaches here and closes the panel. A window-level listener would close both at once.
	 */
	function onDetailKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		void closeDetail();
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
		<div class="flex shrink-0 items-center gap-2">
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
				class="inline-flex h-11 shrink-0 items-center justify-center rounded-xl border px-4 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 focus-visible:outline-none {bulkTagEnabled
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
	<p
		data-testid="filtered-totals"
		role="status"
		aria-live="polite"
		class="text-xs tabular-nums {filteredTotalsState === 'error'
			? 'text-amber-700'
			: 'text-zinc-500'}"
	>
		{#if filteredTotalsState === 'error'}
			{m.transactions_totals_unavailable_label()} · {m.transactions_totals_summary({
				income: TOTALS_UNKNOWN,
				expense: TOTALS_UNKNOWN
			})}
		{:else if filteredTotalsState === 'zero'}
			{m.transactions_totals_zero_label()} · {m.transactions_totals_summary({
				income: formatCents(0),
				expense: formatCents(0)
			})}
		{:else}
			{m.transactions_totals_summary({
				income: formatCents(data.filteredTotals.incomeCents),
				expense: formatCents(data.filteredTotals.expenseCents)
			})}
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
				{#if data.filters.type !== 'all'}
					<input type="hidden" name="type" value={data.filters.type} />
				{/if}
				{#if data.filters.importBatchId}
					<input type="hidden" name="importBatch" value={data.filters.importBatchId} />
				{/if}
				<div class="flex items-center gap-1">
					<!-- ".*" at BOTH sizes. Desktop used to render a bare lowercase "r", which reads as a
					     stray character in the bar rather than as a control; mobile already rendered
					     ".*", so the glyph that exists is unified upward instead of a third rendering
					     being invented. Carrying visible text is a deviation from "IconButton never has
					     visible text", accepted because there is no legible convention for a regex glyph
					     and the word "Regex" costs 46px in a 300px field. The word is still said twice:
					     in the accessible name and in the tooltip, which opens on keyboard focus as well
					     as on hover. -->
					<IconButton
						shape="box"
						pressed={searchIsRegex}
						label={m.transactions_regex_toggle_aria()}
						title={m.transactions_regex_toggle_aria()}
						onclick={() => (searchIsRegex = !searchIsRegex)}
					>
						<span class="font-mono text-[13px] leading-none">.*</span>
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
						scopeNote={m.tags_filter_scope_note()}
						searchPlaceholder={m.tags_filter_search_placeholder()}
						clearAriaLabel={m.transactions_filter_clear_aria({
							dimension: m.tags_filter_dimension()
						})}
						tinted={true}
						tintBgClass={activeFilterTag && isTagColorToken(activeFilterTag.colorToken)
							? tagTintBgClass(activeFilterTag.colorToken)
							: ''}
						tintBorderClass="border-zinc-300"
						onSelect={(tag) => applyFilterDimension({ tag })}
						onClear={clearTagFilter}
					>
						{#snippet footer()}
							<ManageTagsFooter />
						{/snippet}
					</FilterDropdown>
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
				{#if data.dateRangeError}
					<p class="mt-2 text-sm font-medium text-rose-600">
						{m.date_range_error_invalid_custom()}
					</p>
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
					<!-- Same sentence as the desktop bar; see its comment there. -->
					<p class="px-0.5 text-xs text-zinc-500">{m.transactions_regex_error_unchanged()}</p>
				{/if}

				<!-- Same grammar as the desktop bar, different pixels. What stays identical is what
				     matters: "Dimension : Valeur", the × in the same place, the counts, and the
				     "Gérer dans Paramètres" footer. One logic, two layouts. -->
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
					<FilterDropdown
						dimensionLabel={m.tags_filter_dimension()}
						activeLabel={activeTagLabel}
						options={tagFilterOptions}
						value={data.filters.tag}
						allLabel={m.tags_filter_all()}
						allCount={tagFilterAllCount}
						scopeNote={m.tags_filter_scope_note()}
						searchPlaceholder={m.tags_filter_search_placeholder()}
						clearAriaLabel={m.transactions_filter_clear_aria({
							dimension: m.tags_filter_dimension()
						})}
						tinted={true}
						tintBgClass={activeFilterTag && isTagColorToken(activeFilterTag.colorToken)
							? tagTintBgClass(activeFilterTag.colorToken)
							: ''}
						tintBorderClass="border-zinc-300"
						onSelect={(tag) => applyFilterDimension({ tag })}
						onClear={clearTagFilter}
					>
						{#snippet footer()}
							<ManageTagsFooter />
						{/snippet}
					</FilterDropdown>
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
		<div
			class="hidden items-start gap-6 lg:grid {data.selectedTransaction
				? 'xl:grid-cols-[1fr_400px]'
				: ''}"
		>
			<!-- Section tableau -->
			<section class="rounded-lg border border-zinc-200 bg-white">
				<!-- En-tête tableau : pagination -->
				<div class="border-b border-zinc-200 px-4 py-3">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div>
							{@render summaryCount()}
							{@render filteredTotalsRegion()}
						</div>
						<div class="flex items-center gap-2">
							{@render summaryActions('desktop')}
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
					{@render summaryDisabledReason('desktop')}
					{@render bulkTagBanner()}
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
												<td
													class="{colAmount} px-4 py-3 text-right font-semibold tabular-nums {tx.type ===
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
								<div class="mt-2">
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
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<!-- The rule guards against a non-interactive element BEING the control. This one is
					     not: it listens for Escape as a container, on the keys its own focusable children
					     produce, and adds no target a pointer user or a screen-reader user is expected to
					     find. Every gesture that closes the panel has its own real control (the header
					     cross, the row link); this handler only lets the keyboard user out from wherever
					     they already are. A window-level listener would close the panel from anywhere on
					     the page, including the filter bar, which is not what the design asks for. -->
					<aside
						class="rounded-lg border border-zinc-200 bg-white"
						aria-label={m.transactions_detail_region_aria()}
						data-testid="transaction-detail"
						onkeydown={onDetailKeydown}
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
				<!-- Full width in the summary card, never in the filter rows. -->
				<div class="[&_[data-testid=bulk-tag-trigger]]:w-full [&>div]:w-full">
					{@render summaryActions('mobile')}
				</div>
				{@render summaryDisabledReason('mobile')}
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
