import { describe, expect, it } from 'vitest';
import { buildTransactionsCsv, TRANSACTION_CSV_HEADER } from './exportCsv';
import type { TransactionRowForMapping } from './nature';
import type { TransactionNature } from '$lib/domain/transaction';

/**
 * The export half of the round trip (OD-2 option b).
 *
 * Split out of `routes/transactions/export/+server.ts` so the CSV a user downloads can be handed
 * straight to the REAL parser in `round-trip.spec.ts`. That is the whole reason this module exists
 * as a module: a round-trip test whose "expected CSV" is retyped by the test proves the test agrees
 * with itself, which is the oracle mistake CLAUDE.md records.
 */

const NO_MAPPINGS = new Map<string, TransactionNature>();

function row(overrides: Partial<TransactionRowForMapping> = {}): TransactionRowForMapping {
	return {
		id: 'tx-1',
		date: new Date('2026-06-12T00:00:00.000Z'),
		label: 'Leroy Merlin',
		amountCents: 8000,
		type: 'expense',
		source: 'csv',
		manualCategory: null,
		natureManual: null,
		category: { name: 'Maison' },
		splits: [],
		...overrides
	};
}

// Deliberately assertion-free: an `expect` in a helper called a varying number of times per test
// makes every `expect.assertions(n)` a puzzle. The header is pinned once, in its own test.
function bodyOf(csv: string): string[] {
	return csv.split('\r\n').slice(1);
}

describe('buildTransactionsCsv', () => {
	it('leads with the versioned header, which is the thing maison-v2 recognises', () => {
		expect.assertions(1);

		expect(buildTransactionsCsv([row()], NO_MAPPINGS).split('\r\n')[0]).toBe(
			TRANSACTION_CSV_HEADER
		);
	});

	it('emits one line per allocation, so a répartition is N lines and an ordinary row is one', () => {
		expect.assertions(2);

		const plain = bodyOf(buildTransactionsCsv([row()], NO_MAPPINGS));
		const split = bodyOf(
			buildTransactionsCsv(
				[
					row({
						splits: [
							{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
							{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
						]
					})
				],
				NO_MAPPINGS
			)
		);

		expect(plain).toHaveLength(1);
		expect(split).toHaveLength(2);
	});

	it('carries the parent total and the position on EVERY line, which is what lets the parser regroup them', () => {
		expect.assertions(2);

		const [first, second] = bodyOf(
			buildTransactionsCsv(
				[
					row({
						splits: [
							{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
							{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
						]
					})
				],
				NO_MAPPINGS
			)
		);

		// montant = the PART, montant_total = the PARENT, both signed as expenses.
		expect(first).toBe(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison"
		);
		expect(second).toBe(
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison"
		);
	});

	// §2.2's restoration value. Nothing else in the file carries it: a correctly-split transaction
	// has a zero remainder, so the parent's own category appears in NO allocation, and a round trip
	// without this column silently replaces it with whichever part came first.
	it('states the PARENT category even when no allocation carries it', () => {
		expect.assertions(2);

		const [first] = bodyOf(
			buildTransactionsCsv(
				[
					row({
						category: { name: 'Maison' },
						splits: [
							{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
							{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
						]
					})
				],
				NO_MAPPINGS
			)
		);

		expect(first.split(';').at(-1)).toBe('Maison');
		expect(first.split(';')[2]).toBe('Bricolage');
	});

	it('unsplit rows say 1/1 and repeat themselves, so every line has the same shape', () => {
		expect.assertions(1);

		expect(bodyOf(buildTransactionsCsv([row()], NO_MAPPINGS))[0]).toBe(
			"2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison"
		);
	});

	// OD-4: each part's nature comes from its OWN category. A file stating the parent's nature on
	// every line would be a per-category export whose natures disagree with the app's own reports.
	it('resolves nature per part, not once for the parent', () => {
		expect.assertions(2);

		const mappings = new Map<string, TransactionNature>([['jardin', 'transfer']]);
		const [first, second] = bodyOf(
			buildTransactionsCsv(
				[
					row({
						splits: [
							{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
							{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
						]
					})
				],
				mappings
			)
		);

		expect(first.split(';')[5]).toBe('spending');
		expect(second.split(';')[5]).toBe('transfer');
	});

	it('escapes and de-fangs every column, including the two new ones', () => {
		expect.assertions(2);

		const [line] = bodyOf(
			buildTransactionsCsv([row({ label: 'A;B"C', category: { name: '=SUM(A1)' } })], NO_MAPPINGS)
		);

		expect(line).toContain('"A;B""C"');
		// The formula guard applies to the parent-category column too — it is the same user text,
		// reaching the same spreadsheet, and a guard applied to one copy and not the other is the
		// fix-the-instance shape.
		expect(line.split(';').at(-1)).toBe("'=SUM(A1)");
	});
});
