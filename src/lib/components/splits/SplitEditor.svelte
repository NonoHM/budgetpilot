<script lang="ts">
	import { tick, untrack } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import SplitPartRow from './SplitPartRow.svelte';
	import SplitRemainderBand from './SplitRemainderBand.svelte';
	import {
		MAX_SPLITS_PER_TRANSACTION,
		MIN_SPLITS_PER_TRANSACTION,
		distributeEvenly
	} from '$lib/domain/allocation';
	import {
		canDistributeEvenly,
		isUnevenDistribution,
		resolveRemainder
	} from '$lib/domain/splitDraft';

	/**
	 * The split editor, design 1j — one panel, three entrances: creating a first split, editing an
	 * existing one, and asking for its removal. What changes is the initial state and the reading
	 * order, never the mechanics.
	 */
	let {
		transactionId,
		amountCents,
		parentCategoryId,
		categoryOptions,
		existingParts,
		conflictPositions = [],
		error,
		parentLockId,
		size = 'md',
		dirty = $bindable()
	}: {
		transactionId: string;
		/** The parent's amount, signed and stored. Parts are typed as magnitudes. */
		amountCents: number;
		parentCategoryId: string;
		/** Already excludes the « Non catégorisé » sentinel — OD-5: a part may never carry it. */
		categoryOptions: Array<{ value: string; label: string }>;
		existingParts: Array<{ categoryId: string; amountCents: number; note: string }> | null;
		/** 0-based positions the server refused, from `replaceSplits`'s discriminated union (1r). */
		conflictPositions?: number[];
		error?: string;
		/**
		 * Id of the sentence this component renders to explain the neutralised PARENT selector — which
		 * the CALLER owns and points its own `aria-describedby` at.
		 *
		 * Passed in rather than generated here, and that is the whole reason it is a prop: 1j keeps the
		 * parent selector « en haut, à sa place habituelle », i.e. outside this component entirely,
		 * while the sentence explaining it belongs to the editor that caused the lock. A control and
		 * its reason live in two components, so exactly one of them must own the id, and it has to be
		 * the one that cannot see the other. The caller renders the selector twice — desktop aside and
		 * mobile sheet — so it also has to be the caller that keeps the two ids apart.
		 */
		parentLockId: string;
		size?: 'md' | 'lg';
		dirty?: boolean;
	} = $props();

	const instanceId = $props.id();
	// Built from `$props.id()`, never a literal: this editor is mounted TWICE at once, in the desktop
	// aside and in the mobile sheet, and two identical ids would let both Save buttons resolve to
	// whichever explanation the DOM found first.
	const announcementId = `split-remainder-${instanceId}`;
	const floorHintId = `split-floor-${instanceId}`;
	const ceilingHintId = `split-ceiling-${instanceId}`;
	const reasonId = `split-reason-${instanceId}`;

	interface DraftPart {
		categoryId: string;
		amount: string;
		note: string;
	}

	function magnitudeString(cents: number): string {
		return (Math.abs(cents) / 100).toFixed(2).replace('.', ',');
	}

	function fromExisting(): DraftPart[] {
		if (existingParts && existingParts.length > 0) {
			return existingParts.map((part) => ({
				categoryId: part.categoryId,
				amount: magnitudeString(part.amountCents),
				note: part.note
			}));
		}
		// 1j-A: part 1 inherits the parent's category, part 2 is empty. Zero risk, one keystroke less.
		return [
			{ categoryId: parentCategoryId, amount: '0,00', note: '' },
			{ categoryId: '', amount: '0,00', note: '' }
		];
	}

	// The snapshot the dirty check compares against — the parts as they arrived. Deliberately not
	// reactive: it is the BEFORE, and a reactive one would track the after so nothing is ever dirty.
	const initialParts = fromExisting();
	let parts = $state<DraftPart[]>(initialParts.map((part) => ({ ...part })));
	let removalPending = $state(false);
	/** 1e: the mention explains a GESTURE, so any edit to an amount clears it. */
	let evenSplitAppliedAt = $state<number | null>(null);

	let band = $state<ReturnType<typeof SplitRemainderBand> | null>(null);
	// Scoped to THIS editor's own subtree, never `document`: both mounts are in the page at once, and
	// a document-wide lookup would move focus inside the surface the user cannot see.
	let rootEl = $state<HTMLElement | null>(null);

	/**
	 * Every category label this editor was handed WHEN IT OPENED, by id.
	 *
	 * Deliberately a snapshot rather than a live read, and that is the whole mechanism behind 1r's
	 * « le nom perdu reste écrit ». A category deleted in another window disappears from
	 * `categoryOptions` at the next load, taking its label with it — so the only place « Cadeaux »
	 * still exists is a copy taken before the deletion. « Vider le champ effacerait la seule chose
	 * qui permet de retrouver quelle catégorie choisir à la place. »
	 */
	// `untrack`, not an accident: Svelte is right that this captures only the initial value, and the
	// initial value is precisely what is wanted. Saying so in code rather than suppressing the
	// warning keeps the intent readable — a live read here would lose the label at the exact moment
	// 1r needs it.
	const labelsWhenOpened = untrack(
		() => new Map(categoryOptions.map((option) => [option.value, option.label]))
	);

	const isEditingExisting = $derived(Boolean(existingParts && existingParts.length > 0));

	/**
	 * 1r, and it covers BOTH moments the design names with one derivation rather than two code
	 * paths: a part pointing at a category the CURRENT options no longer offer. The options refresh
	 * on tab return and on the save response — the two moments the app already reloads — so nothing
	 * polls and nothing is scheduled.
	 *
	 * An EMPTY categoryId is excluded, and that exclusion is the point: a freshly added row has no
	 * category yet, and reporting it as « supprimée » would announce a deletion that never happened
	 * on the most ordinary state in the editor.
	 */
	const missingCategoryPositions = $derived(
		parts
			.map((part, index) => ({ part, index }))
			.filter(
				({ part }) =>
					part.categoryId.length > 0 &&
					!categoryOptions.some((option) => option.value === part.categoryId)
			)
			.map(({ index }) => index)
	);

	/**
	 * The server's refusal and the client's own detection, merged. Both mean the same thing to the
	 * user — this part's category is not usable — and 1r asks for one sentence naming every affected
	 * part, so they cannot be two separate messages competing for the one reason line.
	 */
	const conflicts = $derived(
		[...new Set([...conflictPositions, ...missingCategoryPositions])].sort((a, b) => a - b)
	);
	const remainder = $derived(
		resolveRemainder(
			parts.map((part) => part.amount),
			amountCents
		)
	);
	const atFloor = $derived(parts.length <= MIN_SPLITS_PER_TRANSACTION);
	const atCeiling = $derived(parts.length >= MAX_SPLITS_PER_TRANSACTION);
	const everyPartHasCategory = $derived(parts.every((part) => part.categoryId.length > 0));

	const isDirty = $derived.by(() => {
		if (removalPending) return true;
		if (parts.length !== initialParts.length) return true;
		return parts.some((part, index) => {
			const before = initialParts[index];
			return (
				part.categoryId !== before.categoryId ||
				part.amount !== before.amount ||
				part.note !== before.note
			);
		});
	});

	$effect(() => {
		if (dirty !== isDirty) dirty = isDirty;
	});

	/**
	 * The single reason line under the button (1j-B, 1r, 1q). The BAND carries arithmetic causes and
	 * nothing else; every other cause lands here. Exactly one location per neutralised control, never
	 * both and never none.
	 */
	const reasonSentence = $derived.by(() => {
		if (removalPending) return undefined;
		if (conflicts.length > 0)
			return m.splits_reason_conflict({
				positions: conflicts.map((position) => position + 1).join(', ')
			});
		if (!everyPartHasCategory) return m.splits_reason_missing_category();
		if (remainder.complete && !isDirty) return m.splits_reason_unchanged();
		return undefined;
	});

	const canSave = $derived(
		removalPending ||
			(remainder.complete && everyPartHasCategory && isDirty && conflicts.length === 0)
	);

	/**
	 * `aria-describedby` for the neutralised Save. When the cause is the remainder it points at the
	 * HIDDEN ANNOUNCEMENT REGION — never into the band, which is `aria-hidden` and whose descendants
	 * are therefore out of the accessibility tree. When the cause is anything else it points at the
	 * reason line. One location, always exactly one.
	 */
	const saveDescribedBy = $derived(
		canSave ? undefined : reasonSentence ? reasonId : announcementId
	);

	/**
	 * Focus after add and remove, design 1p.
	 *
	 * Explicit, and the reason is that the correct behaviour currently happens BY ACCIDENT for one
	 * of the three cases: `{#each ... (index)}` keys rows by position, so removing a middle row
	 * reuses the same button elements and updates their labels, and focus never leaves. That is the
	 * right outcome for the wrong reason — it is a property of the key, not a decision — and it
	 * disappears the day the each block is keyed by anything else. Removing the LAST row destroys
	 * the focused node outright and drops focus to `<body>`, which for a keyboard user means the
	 * next Tab restarts from the top of the document.
	 *
	 * Selected by `data-` attribute rather than by accessible name: the name is a translated
	 * sentence, and building a CSS selector out of user-facing copy makes focus a function of the
	 * catalogue.
	 */
	function focusIn(selector: string) {
		rootEl?.querySelector<HTMLElement>(selector)?.focus();
	}

	async function addPart() {
		if (atCeiling) return;
		parts = [...parts, { categoryId: '', amount: '0,00', note: '' }];
		evenSplitAppliedAt = null;
		// `tick`, not `queueMicrotask`: the row does not exist until Svelte has flushed, and focusing
		// a node that is not there yet fails silently rather than loudly.
		await tick();
		// `:not([type="hidden"])` because the row renders its hidden `splitCategoryId` field FIRST
		// inside that wrapper — a bare `input` selector finds that one, and focusing a hidden input
		// silently does nothing, which is the failure mode that reads as "focus management is off".
		focusIn(`[data-split-category="${parts.length}"] input:not([type="hidden"])`);
	}

	async function removePart(index: number) {
		if (atFloor) return;
		const wasLast = index === parts.length - 1;
		parts = parts.filter((_, i) => i !== index);
		evenSplitAppliedAt = null;
		await tick();
		// The NEXT part's cross is the one that has taken the removed row's place, so it is at the
		// same 1-based position the removed row had.
		if (wasLast) focusIn('[data-split-add] button');
		else focusIn(`[data-split-remove="${index + 1}"] button`);
	}

	function distribute() {
		if (!canDistributeEvenly(amountCents, parts.length)) return;
		const shares = distributeEvenly(amountCents, parts.length);
		parts = parts.map((part, index) => ({ ...part, amount: magnitudeString(shares[index]) }));
		// The extra cent always lands on part 1, and the screen says so before anyone wonders why one
		// line differs — but only when the division actually falls uneven.
		evenSplitAppliedAt = isUnevenDistribution(amountCents, parts.length) ? 0 : null;
	}

	function onAmountEdited() {
		evenSplitAppliedAt = null;
	}
</script>

<div class="grid gap-3" bind:this={rootEl}>
	<!--
		1j: the parent selector stays where it always was and neutralises IN SITU. It is the thing
		being prevented, so the sentence reads next to it. This block is rendered by the caller; what
		belongs here is the sentence and its id, which the caller's selector points at.
	-->
	<p id={parentLockId} class="text-xs text-zinc-500">
		{removalPending ? m.splits_parent_unlocked() : m.splits_parent_locked()}
	</p>

	{#if removalPending}
		<!--
			1j-C: removal is deferred to save, therefore reversible, therefore NO ConfirmDialog. An
			information band in zinc — neither success nor danger, and AlertBanner has no `info`
			variant, so this must not be built as one.
		-->
		<div class="grid gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2">
			<p class="text-sm text-zinc-700">
				{m.splits_removal_pending({ count: parts.length })}
			</p>
			<div>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onclick={() => (removalPending = false)}
				>
					{m.splits_removal_cancel()}
				</Button>
			</div>
		</div>
		<input type="hidden" name="splitIntent" value="clear" />
	{:else}
		<input type="hidden" name="splitIntent" value="replace" />

		<fieldset class="rounded-xl border border-zinc-200 p-3">
			<legend class="px-1 text-sm font-semibold">
				{isEditingExisting
					? m.splits_section_heading_count({ count: parts.length })
					: m.splits_section_heading()}
			</legend>

			<div class="mt-1">
				{#each parts as _part, index (index)}
					<SplitPartRow
						position={index + 1}
						bind:categoryId={parts[index].categoryId}
						bind:amount={parts[index].amount}
						bind:note={parts[index].note}
						{categoryOptions}
						{size}
						deletedCategoryName={missingCategoryPositions.includes(index)
							? labelsWhenOpened.get(parts[index].categoryId)
							: undefined}
						removeSoftDisabled={atFloor}
						removeHintId={floorHintId}
						showRoundingCent={evenSplitAppliedAt === index}
						onRemove={() => removePart(index)}
						onAmountInput={onAmountEdited}
						onAmountBlur={() => band?.flushAnnouncement()}
					/>
				{/each}
			</div>

			{#if atFloor}
				<!--
					1f: at the floor the sentence CONTAINS the exit. Whoever clicks the second cross does
					not want one part fewer, they want out — and without this they face two dead buttons
					with no idea the way out is elsewhere in the panel.
				-->
				<p id={floorHintId} class="mt-2 text-xs text-zinc-500">
					{m.splits_floor_hint()}
					<button
						type="button"
						class="underline underline-offset-2 hover:text-zinc-700"
						onclick={() => (removalPending = true)}
					>
						{m.splits_remove_action()}
					</button>
					{m.splits_floor_hint_tail()}
				</p>
			{/if}

			<div class="mt-3 grid gap-2 sm:flex sm:flex-wrap">
				<div data-split-add>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						softDisabled={atCeiling}
						aria-describedby={atCeiling ? ceilingHintId : undefined}
						onclick={addPart}
					>
						{m.splits_add_part()}
					</Button>
				</div>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					softDisabled={!canDistributeEvenly(amountCents, parts.length)}
					onclick={distribute}
				>
					{m.splits_distribute_evenly()}
				</Button>
			</div>
			{#if atCeiling}
				<!-- The button is not removed: a disappearance is one more mystery to solve. -->
				<p id={ceilingHintId} class="mt-2 text-xs text-zinc-500">
					{m.splits_ceiling_hint({ max: MAX_SPLITS_PER_TRANSACTION })}
				</p>
			{/if}
		</fieldset>
	{/if}

	<input type="hidden" name="transactionId" value={transactionId} />

	<!--
		1d and 1k: the remainder band and the action row travel TOGETHER, pinned to the bottom of
		whatever is scrolling, « c'est la règle du pied de feuille étendue d'un cran : ce qui commande
		l'action primaire voyage avec elle ». That is what guarantees the reason and the neutralised
		button are read in the same glance whatever the number of parts, and at 390 it is what keeps
		the remainder visible while typing — « un reste placé en haut disparaîtrait au premier champ
		ciblé, exactement au moment où il devient utile ».

		DIVERGENCE FROM THE DRAWING, recorded rather than smuggled. 1k puts this group in the SHEET's
		own sticky footer. This app's detail sheet is not the sheet 1k drew: it hosts four independent
		forms — manual category, manual nature, étiquettes and this one — so a sheet-level footer
		would pin ONE form's « Enregistrer » as the whole sheet's permanent chrome, and a screen
		reader would meet a Save button with no fieldset to belong to. `position: sticky` scoped to
		this editor's own box gives the identical property with the right owner: the group pins while
		the editor is on screen and releases when it is not. The cost is that the sheet keeps its
		`max-h-[85vh]` instead of the ~809 px the footer prop grants; that is a height, not a
		reachability, and 1k's own note says the property that matters is unaffected.
	-->
	<div class="sticky bottom-0 z-10 grid gap-2 bg-white pt-2 pb-1">
		{#if error}
			<!--
				1i: inside the panel, ABOVE the remainder band, never at the top of the page — « l'échec
				appartient à ce formulaire ». `role="alert"` and no auto-dismiss, and the sentence
				promises first what matters, that nothing is lost.
			-->
			<div role="alert">
				<AlertBanner variant="error" size="sm" autoDismissMs={Infinity}>
					{error}
					{#snippet action()}
						<button type="submit" class="font-semibold text-rose-700 underline underline-offset-2">
							{m.splits_error_retry()}
						</button>
					{/snippet}
				</AlertBanner>
			</div>
		{/if}

		{#if !removalPending}
			<SplitRemainderBand bind:this={band} {remainder} {announcementId} />
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<Button type="submit" size="sm" softDisabled={!canSave} aria-describedby={saveDescribedBy}>
				{m.common_save()}
			</Button>
			<!--
			Rendered only ABOVE the floor, and that is a resolution the design leaves implicit rather
			than a deviation from it. 1f puts an actionable « Retirer la répartition » inside the floor
			sentence, and 1j-B puts one in the footer; at exactly 2 parts both apply and the panel grew
			two buttons with the same accessible name, which a screen reader reads twice with no way to
			tell them apart. The floor sentence's copy is the one that must stay, because 1f's whole
			argument is that the sentence itself has to contain the exit.
		-->
			{#if isEditingExisting && !removalPending && !atFloor}
				<Button type="button" variant="ghost" size="sm" onclick={() => (removalPending = true)}>
					{m.splits_remove_action()}
				</Button>
			{/if}
		</div>
		{#if reasonSentence}
			<p id={reasonId} class="text-xs text-zinc-500">{reasonSentence}</p>
		{/if}
	</div>
</div>
