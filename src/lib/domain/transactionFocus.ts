/**
 * Pure navigation helpers for the /transactions "focus mode" (classification
 * one-at-a-time flow). `stackIds` is the ordered list of ids to classify
 * (server-computed, cf. `classifyStackIds` in transactions/+page.server.ts).
 * `handledIds` are ids already treated in the current session (accepted,
 * ignored, or turned into a rule) — the same session-only sets already used
 * for `resolvedIds`/`ignoredIds` in +page.svelte.
 *
 * Two usages:
 * - "Previous"/"Skip" buttons: navigate through the stack without treating
 *   the current transaction — `currentId` is still present in `stackIds` and
 *   absent from `handledIds`.
 * - Auto-advance after Accept/Ignore/Create rule: the caller adds
 *   `currentId` to `handledIds` *before* calling this function, so it is no
 *   longer part of the remaining stack — the next/previous remaining id is
 *   found relative to its original position in `stackIds`.
 */

export type TransactionFocusAction = 'accept' | 'ignore' | 'createRule';
export type TransactionFocusOutcome = 'accepted' | 'ignored';

/**
 * Which session bucket (resolvedIds/ignoredIds in +page.svelte) a focus-mode
 * action falls into for the purpose of advancing the stack. "Create rule"
 * counts as "accepted", not "ignored": in focus mode, createRule classifies
 * the current transaction as if Accept had been clicked with the same
 * category/nature (see createRuleInFocusMode in +page.svelte, which submits
 * acceptSuggestion then createRule) — only the rule itself is never applied
 * retroactively to other transactions already pending.
 */
export function getFocusOutcomeForAction(action: TransactionFocusAction): TransactionFocusOutcome {
	return action === 'ignore' ? 'ignored' : 'accepted';
}

export type SwipeDecision = 'accept' | 'ignore' | null;

/**
 * Decides whether a horizontal swipe on the focus card (Tinder-style, mobile)
 * counts as a deliberate Accepter/Ignorer gesture — a real committed swipe
 * past `thresholdPx`, not an accidental brush. Financial data: a false
 * positive here would silently miscategorize a transaction, so the gesture
 * must cross the threshold decisively. Pairs with `getSwipeProgress` for the
 * matching progressive visual feedback below that threshold.
 */
export function resolveSwipeDecision(deltaX: number, thresholdPx: number): SwipeDecision {
	if (deltaX >= thresholdPx) return 'accept';
	if (deltaX <= -thresholdPx) return 'ignore';
	return null;
}

/**
 * Progressive visual feedback ratio for the swipe gesture, clamped to
 * [-1, 1] (negative = dragging left/Ignorer, positive = dragging
 * right/Accepter) — drives the card tint + label fade-in intensity before
 * the gesture actually commits at `resolveSwipeDecision`'s threshold, so the
 * user can see the action becoming "real" as they drag rather than being
 * surprised by a sudden all-or-nothing trigger.
 */
export function getSwipeProgress(deltaX: number, thresholdPx: number): number {
	if (thresholdPx <= 0) return 0;
	return Math.max(-1, Math.min(1, deltaX / thresholdPx));
}

export function getRemainingFocusStackIds(
	stackIds: readonly string[],
	handledIds: ReadonlySet<string>
): string[] {
	return stackIds.filter((id) => !handledIds.has(id));
}

export function getAdjacentFocusStackId(
	stackIds: readonly string[],
	handledIds: ReadonlySet<string>,
	currentId: string,
	direction: 'next' | 'previous'
): string | null {
	const remaining = getRemainingFocusStackIds(stackIds, handledIds);
	if (remaining.length === 0) return null;

	const remainingIndex = remaining.indexOf(currentId);
	if (remainingIndex !== -1) {
		const targetIndex = direction === 'next' ? remainingIndex + 1 : remainingIndex - 1;
		return targetIndex >= 0 && targetIndex < remaining.length ? remaining[targetIndex] : null;
	}

	// currentId was just handled (removed from `remaining`): walk stackIds from its
	// original position to find the nearest still-remaining id in the requested direction.
	const originalIndex = stackIds.indexOf(currentId);
	if (originalIndex === -1) return null;

	const step = direction === 'next' ? 1 : -1;
	for (let i = originalIndex + step; i >= 0 && i < stackIds.length; i += step) {
		if (!handledIds.has(stackIds[i])) return stackIds[i];
	}
	return null;
}
