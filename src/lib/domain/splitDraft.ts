import { MAX_MANUAL_AMOUNT_CENTS, parseMoneyCents } from './money';

/**
 * The arithmetic behind the split editor's remainder band (design 1d), kept apart from the
 * component and from Paraglide.
 *
 * No i18n here on purpose. The band shows three lines and the live region speaks one sentence, and
 * both are built from the SAME structured state — so the state is what gets tested, in one place,
 * without a locale in the way. The component maps this to messages; the announcer
 * (`$lib/announce.ts`) decides when the sentence is allowed to be heard.
 *
 * Everything is expressed relative to the PARENT's sign. A user splitting an 80,00 € expense types
 * « 60,00 » and « 20,00 », never « -60,00 » — `parseDraftAmountCents` refuses a minus, see there —
 * so a part's magnitude is what is typed and its stored sign is the parent's. That is also why the three
 * states cannot be read off the raw sign of `total - placed`: on an expense (total −8000) a part
 * short of the total leaves a NEGATIVE difference that means "money still to place", and a part
 * over it leaves a positive one that means "dépassement". Reading the sign directly gets both
 * backwards on every expense in the app, which is most of them.
 */

/** « Reste à répartir » / « Tout est réparti » / « Dépassement » — 1d's three cases, in order. */
export type RemainderKind = 'positive' | 'zero' | 'negative';

export interface RemainderState {
	kind: RemainderKind;
	/** Magnitude in cents. Every sentence in 1d quotes this, never a signed value: « Une formulation
	 *  unique du type "Reste : −5,00 €" obligerait à lire un signe pour comprendre un sens. » */
	magnitudeCents: number;
	/** How many parts the draft holds — the count « 80,00 € répartis en 2 parts » quotes. */
	partCount: number;
	/** The parent's amount, signed, as stored. */
	totalCents: number;
	/**
	 * Whether the draft could be written at all: the remainder is exactly zero AND every part
	 * carries a usable amount. Distinct from `kind === 'zero'`, and the difference is load-bearing —
	 * a draft of two empty parts on a 0,00 € parent has a zero remainder and nothing to save.
	 */
	complete: boolean;
	/** 0-based indices of parts whose amount is missing, unparseable or zero. */
	invalidPositions: number[];
}

/**
 * Parses one part's amount field. `allowZero` is TRUE here and false in `parseManualAmountCents`,
 * and that is the whole difference: 1j-A opens the editor with both parts showing « 0,00 », so zero
 * must be DISPLAYABLE while never being SAVABLE. The save gate is `complete` below, not the parser.
 *
 * `minCents: 0` is the OTHER gate and it belongs here rather than downstream (#199). A part is
 * typed as a magnitude and its stored sign is the parent's, so a minus has no meaning the editor
 * can act on — but `parseMoneyCents` never gated `-` (only `+`, behind `allowPlusSign`), so
 * « -60,00 » parsed to -6000 and was ADDED to the placed total. On an 80,00 € expense with a
 * 20,00 € second part the band moved to « 120,00 € » — twice the amount, in the wrong direction —
 * and flagged nothing, because a non-null non-zero number is what `resolveRemainder` treats as a
 * usable part. It has to be refused here: one integer later, a deliberate negative and a typo are
 * the same value.
 */
export function parseDraftAmountCents(raw: string): number | null {
	return parseMoneyCents(raw, {
		allowZero: true,
		minCents: 0,
		maxAbsCents: MAX_MANUAL_AMOUNT_CENTS,
		requireSafeInteger: true
	});
}

export function resolveRemainder(
	rawAmounts: readonly string[],
	totalCents: number
): RemainderState {
	// The parent's direction. A zero-amount parent is treated as positive; it has no expense/income
	// meaning to preserve, and the alternative is a `sign` of 0 that annihilates every comparison.
	const sign = totalCents < 0 ? -1 : 1;

	let placedAlongSign = 0;
	const invalidPositions: number[] = [];

	rawAmounts.forEach((raw, index) => {
		const magnitude = parseDraftAmountCents(raw);
		if (magnitude === null || magnitude === 0) invalidPositions.push(index);
		placedAlongSign += magnitude ?? 0;
	});

	const totalAlongSign = totalCents * sign;
	const remainingAlongSign = totalAlongSign - placedAlongSign;

	const kind: RemainderKind =
		remainingAlongSign > 0 ? 'positive' : remainingAlongSign < 0 ? 'negative' : 'zero';

	return {
		kind,
		magnitudeCents: Math.abs(remainingAlongSign),
		partCount: rawAmounts.length,
		totalCents,
		complete: kind === 'zero' && invalidPositions.length === 0,
		invalidPositions
	};
}

/**
 * Whether « Répartir également » has anything to explain (1e). 100,00 € in three does; 80,00 € in
 * two does not, « il n'y a rien à expliquer ». The mention and its footnote appear only when true.
 */
export function isUnevenDistribution(totalCents: number, partCount: number): boolean {
	if (partCount <= 0) return false;
	return Math.abs(totalCents) % partCount !== 0;
}

/**
 * 1e's guard: the button must never offer a distribution containing a zero part, because
 * `replaceSplits` refuses one and the user would be handed an unsavable draft by a button whose
 * whole promise is that it produces a valid one.
 */
export function canDistributeEvenly(totalCents: number, partCount: number): boolean {
	return partCount > 0 && Math.abs(totalCents) >= partCount;
}
