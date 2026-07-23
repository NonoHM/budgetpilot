<script lang="ts">
	import Modal from './Modal.svelte';
	import AlertBanner from './AlertBanner.svelte';
	import TransactionProposalCard from './TransactionProposalCard.svelte';
	import IconButton from './ui/IconButton.svelte';
	import { getSwipeProgress, resolveSwipeDecision } from '$lib/domain/transactionFocus';
	import { widthClass } from '$lib/domain/widthClass';
	import * as m from '$lib/paraglide/messages';

	// Focus mode: triage one transaction at a time. Based on Modal (variant "compact" +
	// hideHeader + mobileFullscreen), not BottomSheet — the latter is designed for
	// vertical swipe-to-dismiss, not for navigating a stack. `hideHeader` hides Modal's
	// generic header (title + ×) at ALL screen sizes — unlike ConfirmDialog, the custom
	// header below (counter, progress bar, ×) must be visible on both desktop and mobile,
	// not just below lg. `mobileFullscreen` makes it take up the whole screen below lg
	// (no floating card with visible background around it). The header's × is the only
	// exit (no redundant "Exit"/"View full detail" link); "Create rule" creates the rule
	// directly with no intermediate modal (see createRuleInFocusMode in +page.svelte), so
	// there's no need to disable keyboard shortcuts for a modal opened on top.
	let {
		open,
		transaction,
		suggestion,
		categoryOptions,
		natureOptions,
		position,
		total,
		canGoPrevious,
		canGoNext,
		autoAppliedCount = 0,
		getCategoryColor,
		displayCategory,
		formatNatureLabel,
		formatDate,
		formatCents,
		acceptError,
		onClose,
		onPrevious,
		onNext,
		onAccepted,
		onIgnore,
		onCreateRule
	}: {
		open: boolean;
		transaction: {
			id: string;
			date: string;
			label: string;
			amountCents: number;
			type: 'income' | 'expense';
			source: string;
		} | null;
		suggestion: { category: string; nature: string | null } | null;
		categoryOptions: readonly string[];
		natureOptions: readonly string[];
		position: number;
		total: number;
		canGoPrevious: boolean;
		canGoNext: boolean;
		// Number of transactions auto-classified by the last rule created in this session (see
		// createRuleInFocusMode in +page.svelte) — drives the transient banner below, 0 = hidden.
		autoAppliedCount?: number;
		getCategoryColor: (categoryName: string) => string;
		displayCategory: (name: string) => string;
		formatNatureLabel: (nature: string | null) => string;
		formatDate: (dateStr: string) => string;
		formatCents: (amountCents: number) => string;
		acceptError?: string;
		onClose: () => void;
		onPrevious: () => void;
		onNext: () => void;
		onAccepted: (transactionId: string) => void;
		onIgnore: (transactionId: string) => void;
		onCreateRule: (category: string, nature: string | null) => void;
	} = $props();

	let cardRef = $state<{ submitAccept: () => void; triggerCreateRule: () => void } | null>(null);

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (!open || !transaction) return;
		if (isTypingTarget(event.target)) return;

		switch (event.key) {
			case 'Escape':
				event.preventDefault();
				onClose();
				break;
			case 'Enter':
				event.preventDefault();
				cardRef?.submitAccept();
				break;
			case 'r':
			case 'R':
				event.preventDefault();
				cardRef?.triggerCreateRule();
				break;
			case 'i':
			case 'I':
				event.preventDefault();
				onIgnore(transaction.id);
				break;
			case 'ArrowRight':
				if (canGoNext) {
					event.preventDefault();
					onNext();
				}
				break;
			case 'ArrowLeft':
				if (canGoPrevious) {
					event.preventDefault();
					onPrevious();
				}
				break;
		}
	}

	// Tinder-style horizontal mobile swipe — right = Accept (current selection of the
	// Proposal form), left = Dismiss. Previous/Skip (buttons) remain the only "pure"
	// navigation that doesn't commit a decision. Threshold of the same order of magnitude
	// as the one already used elsewhere (BottomSheet.DISMISS_THRESHOLD = 110): a deliberate
	// gesture, not a graze — this is financial data, an accidental swipe must never silently
	// categorize it. resolveSwipeDecision/getSwipeProgress (transactionFocus.ts, tested in
	// isolation) carry the threshold and the progressive visual feedback; this component
	// just wires them to pointer events and rendering.
	const SWIPE_DECISION_THRESHOLD = 110;
	let swiping = $state(false);
	let startX = 0;
	let deltaX = $state(0);

	function handlePointerDown(event: PointerEvent) {
		swiping = true;
		startX = event.clientX;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!swiping) return;
		deltaX = event.clientX - startX;
	}

	function handlePointerUp() {
		if (!swiping) return;
		swiping = false;
		const decision = resolveSwipeDecision(deltaX, SWIPE_DECISION_THRESHOLD);
		if (decision === 'accept') cardRef?.submitAccept();
		else if (decision === 'ignore' && transaction) onIgnore(transaction.id);
		deltaX = 0;
	}

	const progressPercent = $derived(total > 0 ? Math.round((position / total) * 100) : 0);
	const swipeProgress = $derived(getSwipeProgress(deltaX, SWIPE_DECISION_THRESHOLD));
	const swipeIntensity = $derived(Math.min(1, Math.abs(swipeProgress)));
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<Modal
	{open}
	title={m.transactions_focus_mode()}
	variant="compact"
	hideHeader
	mobileFullscreen
	{onClose}
>
	{#if transaction}
		<div class="flex flex-col gap-4">
			<!-- Focus mode header: the only visible header (Modal's stays sr-only at all
			     sizes, see `hideHeader`), shown on both desktop and mobile. -->
			<div class="flex items-center justify-between gap-3">
				<div class="min-w-0">
					<p class="text-lg font-bold text-zinc-950">{m.transactions_focus_mode()}</p>
					<p class="text-xs font-medium tabular-nums text-zinc-500">
						{m.transactions_focus_progress({ position, total })}
					</p>
				</div>
				<IconButton label={m.transactions_focus_exit()} onclick={onClose}>✕</IconButton>
			</div>
			<div class="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
				<div
					class="h-full rounded-full bg-zinc-900 transition-all {widthClass(progressPercent)}"
				></div>
			</div>

			{#if autoAppliedCount > 0}
				<AlertBanner variant="success" size="sm">
					{autoAppliedCount > 1
						? m.transactions_focus_auto_applied_many({ count: autoAppliedCount })
						: m.transactions_focus_auto_applied_one({ count: autoAppliedCount })}
				</AlertBanner>
			{/if}

			<div
				class="relative overflow-hidden rounded-3xl border border-zinc-200 bg-white"
				role="group"
				onpointerdown={handlePointerDown}
				onpointermove={handlePointerMove}
				onpointerup={handlePointerUp}
				onpointercancel={handlePointerUp}
			>
				<!-- Progressive visual feedback for the swipe (Tinder-style, mobile): tint + fading label,
				     proportional to swipeIntensity — doesn't move with the card (stays centered), so
				     the intention becomes visible before the gesture commits at the threshold. -->
				<div
					class="pointer-events-none absolute inset-0 flex items-center justify-center"
					style:background-color={swipeProgress > 0
						? `rgba(16, 185, 129, ${swipeIntensity * 0.16})`
						: swipeProgress < 0
							? `rgba(244, 63, 94, ${swipeIntensity * 0.16})`
							: undefined}
				>
					{#if swipeProgress > 0}
						<span class="text-base font-bold text-emerald-700" style:opacity={swipeIntensity}
							>{m.transactions_accept()}</span
						>
					{:else if swipeProgress < 0}
						<span class="text-base font-bold text-rose-700" style:opacity={swipeIntensity}
							>{m.transactions_ignore()}</span
						>
					{/if}
				</div>
				<div
					class="flex flex-col gap-1.5 p-4 transition-transform duration-200 ease-out"
					style:transform={deltaX !== 0 ? `translateX(${deltaX}px)` : undefined}
					style:transition={swiping ? 'none' : undefined}
				>
					<span class="text-[12.5px] font-medium text-zinc-400"
						>{formatDate(transaction.date)} · {transaction.source.toUpperCase()}</span
					>
					<p class="text-[17px] font-bold tracking-tight text-zinc-900">{transaction.label}</p>
					<p
						class="text-[24px] font-bold tracking-tight tabular-nums {transaction.type === 'income'
							? 'text-emerald-600'
							: 'text-rose-600'}"
					>
						{formatCents(transaction.amountCents)}
					</p>
				</div>
			</div>

			<TransactionProposalCard
				bind:this={cardRef}
				transactionId={transaction.id}
				{suggestion}
				{categoryOptions}
				{natureOptions}
				variant="compact"
				{getCategoryColor}
				{displayCategory}
				{formatNatureLabel}
				{acceptError}
				{onAccepted}
				{onIgnore}
				{onCreateRule}
			/>

			<div class="flex items-center justify-between gap-2 pt-1">
				<button
					type="button"
					class="text-sm font-medium text-zinc-600 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 rounded-md px-1"
					disabled={!canGoPrevious}
					onclick={onPrevious}
				>
					{m.transactions_focus_previous()}
				</button>
				<button
					type="button"
					class="text-sm font-medium text-zinc-600 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2 rounded-md px-1"
					disabled={!canGoNext}
					onclick={onNext}
				>
					{m.transactions_focus_skip()}
				</button>
			</div>
		</div>
	{/if}
</Modal>
