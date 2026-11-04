import { describe, expect, it } from 'vitest';
import {
	HISTORY_SUGGESTION_FLOOR,
	HISTORY_WINDOW,
	buildHistoryIndex,
	historyKey,
	suggestFromHistory
} from './historySuggestion';

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const row = (label: string, category: string, n: number) => ({
	label,
	category,
	date: day(n)
});

describe('historyKey', () => {
	it('drops the tokens that carry a digit, so a date suffix does not split one merchant', () => {
		expect(historyKey('CB BOULANGERIE DUPONT 12/03')).toBe(
			historyKey('CB Boulangérie Dupont 04/05')
		);
		expect(historyKey('CB BOULANGERIE DUPONT 12/03')).toBe('cb boulangerie dupont');
	});

	it('keeps two merchants apart when only their words differ', () => {
		expect(historyKey('CB EPICERIE VALOMI 01/02')).not.toBe(historyKey('CB EPICERIE RENTU 01/02'));
	});

	it('is empty for a label made only of digits, which then never suggests', () => {
		expect(historyKey('12/03 4521')).toBe('');
		const index = buildHistoryIndex([row('12/03 4521', 'food', 1)]);
		expect(suggestFromHistory(index, '12/03 4521')).toBeNull();
	});
});

describe('suggestFromHistory', () => {
	it('suggests the category of the one earlier row of the same merchant', () => {
		const index = buildHistoryIndex([row('CB PRIMEUR LOMI 02/01', 'food', 2)]);
		expect(suggestFromHistory(index, 'CB PRIMEUR LOMI 09/01')).toBe('food');
	});

	it('suggests nothing for a merchant the member never categorized', () => {
		const index = buildHistoryIndex([row('CB PRIMEUR LOMI 02/01', 'food', 2)]);
		expect(suggestFromHistory(index, 'CB CINEMA ZUPEL 09/01')).toBeNull();
	});

	// The floor's boundary, on the single value where `>=` and `>` disagree: 9 of 10 is exactly
	// 0.90. Separates a floor applied as « reaches 0.90 » (#1014) from one applied as « exceeds ».
	it('suggests at exactly 9 of 10 and not at 8 of 10', () => {
		expect(HISTORY_SUGGESTION_FLOOR).toBe(0.9);
		expect(HISTORY_WINDOW).toBe(10);
		const nine = [
			...Array.from({ length: 9 }, (_, i) => row('VIR SEPA ATELIERS MIRE', 'income', 10 + i)),
			row('VIR SEPA ATELIERS MIRE', 'savings', 30)
		];
		expect(suggestFromHistory(buildHistoryIndex(nine), 'VIR SEPA ATELIERS MIRE')).toBe('income');
		const eight = [
			...Array.from({ length: 8 }, (_, i) => row('VIR SEPA ATELIERS MIRE', 'income', 10 + i)),
			row('VIR SEPA ATELIERS MIRE', 'savings', 30),
			row('VIR SEPA ATELIERS MIRE', 'savings', 31)
		];
		expect(suggestFromHistory(buildHistoryIndex(eight), 'VIR SEPA ATELIERS MIRE')).toBeNull();
	});

	// Separates a window over the LATEST rows from one over the first rows read or over all rows:
	// the member moved this merchant from leisure to subscriptions, and the ten latest agree.
	it('reads only the latest rows, so a member who changed their mind is followed', () => {
		const rows = [
			...Array.from({ length: 10 }, (_, i) =>
				row('PRLV SEPA STUDIO NEVA', 'subscriptions', 20 + i)
			),
			...Array.from({ length: 10 }, (_, i) => row('PRLV SEPA STUDIO NEVA', 'leisure', 1 + i))
		];
		expect(suggestFromHistory(buildHistoryIndex(rows), 'PRLV SEPA STUDIO NEVA')).toBe(
			'subscriptions'
		);
		expect(
			suggestFromHistory(buildHistoryIndex([...rows].reverse()), 'PRLV SEPA STUDIO NEVA')
		).toBe('subscriptions');
	});
});
