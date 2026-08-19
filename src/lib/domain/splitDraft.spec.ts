import { describe, it, expect } from 'vitest';
import {
	canDistributeEvenly,
	isUnevenDistribution,
	parseDraftAmountCents,
	resolveRemainder
} from './splitDraft';

/** The design's canonical case throughout: an 80,00 € EXPENSE, stored as −8000. */
const EXPENSE_TOTAL = -8_000;

describe('resolveRemainder — on an expense, which is where the signs bite', () => {
	it('opens at the whole amount, which is 1j-A’s lesson at a glance', () => {
		// « Le reste démarre à 80,00 €, le montant entier. C'est la leçon en un coup d'œil. »
		expect(resolveRemainder(['0,00', '0,00'], EXPENSE_TOTAL)).toMatchObject({
			kind: 'positive',
			magnitudeCents: 8_000,
			partCount: 2,
			complete: false
		});
	});

	it('reads a SHORT expense as « reste à répartir », not as an overshoot', () => {
		// The trap this module exists for. `total - placed` here is -8000 - -6000 = -2000, a NEGATIVE
		// number that means "20,00 € still to place". Reading that sign directly labels every
		// under-allocated expense in the app « Dépassement ».
		expect(resolveRemainder(['60,00'], EXPENSE_TOTAL)).toMatchObject({
			kind: 'positive',
			magnitudeCents: 2_000
		});
	});

	it('reads an OVER-allocated expense as « dépassement »', () => {
		expect(resolveRemainder(['60,00', '25,00'], EXPENSE_TOTAL)).toMatchObject({
			kind: 'negative',
			magnitudeCents: 500
		});
	});

	it('reaches zero on the design’s canonical 60 + 20', () => {
		expect(resolveRemainder(['60,00', '20,00'], EXPENSE_TOTAL)).toMatchObject({
			kind: 'zero',
			magnitudeCents: 0,
			complete: true,
			invalidPositions: []
		});
	});
});

describe('resolveRemainder — the same three states on an income', () => {
	// Same arithmetic, opposite sign. If the module ever special-cased expenses, these would be the
	// tests that notice: an income refund split across two categories is a real case (1p's own
	// example is a refund posted as income).
	const INCOME_TOTAL = 5_000;

	it.each([
		[['30,00'], 'positive', 2_000],
		[['30,00', '20,00'], 'zero', 0],
		[['30,00', '30,00'], 'negative', 1_000]
	])('%s resolves to %s', (amounts, kind, magnitude) => {
		expect(resolveRemainder(amounts as string[], INCOME_TOTAL)).toMatchObject({
			kind,
			magnitudeCents: magnitude
		});
	});
});

describe('resolveRemainder — completeness is not the same question as the remainder', () => {
	it('a zero remainder with an EMPTY part is not complete', () => {
		// The distinction that stops a draft of two blank parts on a 0,00 € parent from looking
		// saveable. `kind` answers "is the arithmetic balanced"; `complete` answers "is there
		// anything to write", and `replaceSplits` refuses a zero part outright.
		const state = resolveRemainder(['', ''], 0);
		expect(state.kind).toBe('zero');
		expect(state.complete).toBe(false);
		expect(state.invalidPositions).toEqual([0, 1]);
	});

	it('a zero remainder with a 0,00 part is not complete either', () => {
		const state = resolveRemainder(['80,00', '0,00'], EXPENSE_TOTAL);
		expect(state.kind).toBe('zero');
		expect(state.complete).toBe(false);
		expect(state.invalidPositions).toEqual([1]);
	});

	it('names every unusable part, not just the first', () => {
		expect(resolveRemainder(['', '60,00', 'abc', '20,00'], EXPENSE_TOTAL).invalidPositions).toEqual(
			[0, 2]
		);
	});

	it('a minus moves the band nowhere and marks the part, rather than doubling the remainder', () => {
		// The measured defect, at the level it was met. Before #199 this returned
		// magnitudeCents 12_000 with invalidPositions [] — 120,00 € remaining on an 80,00 €
		// transaction, with nothing on screen saying which field caused it.
		const state = resolveRemainder(['-60,00', '20,00'], EXPENSE_TOTAL);
		expect(state.magnitudeCents).toBe(6_000);
		expect(state.kind).toBe('positive');
		expect(state.invalidPositions).toEqual([0]);
		expect(state.complete).toBe(false);
	});

	it('counts an unparseable amount as nothing placed, so the band still reads', () => {
		// « abc » must not make the whole band go blank or NaN — the user is mid-typing and the
		// remainder is still a true statement about what HAS been placed.
		expect(resolveRemainder(['60,00', 'abc'], EXPENSE_TOTAL)).toMatchObject({
			kind: 'positive',
			magnitudeCents: 2_000
		});
	});
});

describe('parseDraftAmountCents', () => {
	it('accepts zero, unlike parseManualAmountCents', () => {
		// The one deliberate divergence: 1j-A opens with « 0,00 » in both fields, so zero has to be
		// displayable. It is the save gate that refuses it, not the parser.
		expect(parseDraftAmountCents('0,00')).toBe(0);
		expect(parseDraftAmountCents('0')).toBe(0);
	});

	it('refuses a leading minus, which the editor has no way to mean (#199)', () => {
		// Every part's stored sign is the PARENT's; a part is typed as a magnitude. A field that
		// accepts « -60,00 » does not produce a negative part, it produces a part that SUBTRACTS
		// from the placed total — so on an 80,00 € expense with a 20,00 € second part the band
		// read « 120,00 € » and flagged nothing, because the parser returned a non-null non-zero
		// number. The refusal has to happen in the parser: `resolveRemainder` cannot distinguish
		// a deliberate negative from a typo once it holds an integer.
		expect(parseDraftAmountCents('-60,00')).toBeNull();
		expect(parseDraftAmountCents('-0,01')).toBeNull();
		expect(parseDraftAmountCents('-60.00')).toBeNull();
	});

	it('still accepts a plain magnitude, so the refusal above is not a blanket one', () => {
		// The control for the case above. A parser that returned null for everything would pass
		// the previous test and break the feature.
		expect(parseDraftAmountCents('60,00')).toBe(6_000);
		expect(parseDraftAmountCents('0,00')).toBe(0);
	});

	it('takes a comma or a dot, and rejects what the server would reject', () => {
		expect(parseDraftAmountCents('60,00')).toBe(6_000);
		expect(parseDraftAmountCents('60.00')).toBe(6_000);
		expect(parseDraftAmountCents('')).toBeNull();
		expect(parseDraftAmountCents('abc')).toBeNull();
		expect(parseDraftAmountCents('60,000')).toBeNull();
	});
});

describe('isUnevenDistribution', () => {
	it('is true only when there is something to explain (1e)', () => {
		expect(isUnevenDistribution(-10_000, 3)).toBe(true);
		// « 80,00 € en deux ne montre rien : il n'y a rien à expliquer. »
		expect(isUnevenDistribution(-8_000, 2)).toBe(false);
	});

	it('reads the magnitude, so an income and an expense of the same size agree', () => {
		expect(isUnevenDistribution(10_000, 3)).toBe(isUnevenDistribution(-10_000, 3));
	});
});

describe('canDistributeEvenly', () => {
	it('refuses a division that would produce a zero part', () => {
		// 1e's guard: `replaceSplits` refuses a zero part, so the button must not offer one. 0,02 €
		// across three parts is the boundary.
		expect(canDistributeEvenly(-2, 3)).toBe(false);
		expect(canDistributeEvenly(-3, 3)).toBe(true);
		expect(canDistributeEvenly(0, 2)).toBe(false);
	});

	it('holds at the model’s ceiling of 20 parts', () => {
		expect(canDistributeEvenly(-2_000, 20)).toBe(true);
		expect(canDistributeEvenly(-19, 20)).toBe(false);
	});
});
