import { describe, expect, it } from 'vitest';
import { buildTransactionsCsv } from '$lib/server/transactions/exportCsv';
import type { TransactionRowForMapping } from '$lib/server/transactions/nature';
import type { TransactionNature } from '$lib/domain/transaction';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { parseCsvTransactions } from './csv';

/**
 * THE CONTRACT: a file BudgetPilot produced is a file BudgetPilot can read back.
 *
 * `docs/getting-started.md` advertises it, and it is the one property that must survive long after
 * répartition stops being the newest thing in the repo — so this spec is aimed at the contract, not
 * at the feature. It is what goes red when a future chantier tidies a column.
 *
 * Both halves are the REAL ones: `buildTransactionsCsv` is the function the download route calls,
 * `parseCsvTransactions` is the function the upload route calls. A round-trip test whose "expected
 * CSV" is retyped by the test proves only that the test agrees with itself — the oracle mistake
 * CLAUDE.md records, one level worse here because it would be a committed green light rather than
 * one afternoon's wrong conclusion.
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

function roundTrip(rows: TransactionRowForMapping[]) {
	return parseCsvTransactions(buildTransactionsCsv(rows, NO_MAPPINGS));
}

const SPLIT_ROW = row({
	category: { name: 'Maison' },
	splits: [
		{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
		{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
	]
});

describe('CSV round trip', () => {
	/**
	 * The defect option (b) was chosen to pay for. One line per allocation, on its own, meant an
	 * 80,00 € répartition came back as a 50,00 € transaction and a 30,00 € one — and nothing
	 * reported it, because `amountCents` is in the dedupe key, so neither line matched the
	 * original's fingerprint and neither was skipped as a duplicate.
	 */
	it('returns a répartition as ONE transaction with its parts, not as N transactions', () => {
		expect.assertions(4);

		const result = roundTrip([SPLIT_ROW]);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].amountCents).toBe(-8_000);
		expect(result.transactions[0].splitParts).toEqual([
			{ category: 'Bricolage', amountCents: -5_000 },
			{ category: 'Jardin', amountCents: -3_000 }
		]);
	});

	// §2.2's restoration value, and the reason the export carries a tenth column: a correctly-split
	// transaction has a zero remainder, so the parent's own category is in none of its lines.
	it('restores the PARENT category, which no allocation line carries', () => {
		expect.assertions(1);

		expect(roundTrip([SPLIT_ROW]).transactions[0].category).toBe('Maison');
	});

	it('returns an ordinary transaction unchanged', () => {
		expect.assertions(4);

		const result = roundTrip([row()]);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].category).toBe('Maison');
		expect(result.transactions[0].amountCents).toBe(-8_000);
		expect(result.transactions[0].splitParts).toBeUndefined();
	});

	/**
	 * MEASURED AS BROKEN BEFORE THIS PR, on the v1 format, and it has nothing to do with splits:
	 * the export writes `getEffectiveCategory`, which is the literal sentinel for every row in the
	 * « à classer » pile, and the importer refused that exact string as a reserved category. So the
	 * commonest kind of row in a fresh install exported and came back as « catégorie réservée
	 * refusée », silently dropped, while the documentation said an export re-imports cleanly.
	 */
	it('returns an unclassified transaction instead of refusing the sentinel it just wrote', () => {
		expect.assertions(2);

		const result = roundTrip([row({ category: { name: UNCLASSIFIED_CATEGORY } })]);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
	});

	it('survives a label carrying the separator, a quote and a formula lead-in', () => {
		expect.assertions(2);

		const result = roundTrip([row({ label: '=Chèque n°1; "spécial"' })]);

		expect(result.transactions).toHaveLength(1);
		// The apostrophe the export prefixes to de-fang the spreadsheet is part of the stored label
		// on the way back, exactly as it is for v1 — this asserts what the trip DOES, not what a
		// reader might hope, so a future change to either half is visible rather than plausible.
		expect(result.transactions[0].label).toBe('\'=Chèque n°1; "spécial"');
	});

	/**
	 * Re-importing your own export into the SAME instance must be a no-op, not a second copy of your
	 * history. That works only if the v2 fingerprint of an unsplit transaction is byte-identical to
	 * the v1 one — the fingerprint is (date, |amount|, label), so it is the PARENT total that has to
	 * go into it, never a part.
	 */
	it('fingerprints a v2 line exactly as v1 did, so an export re-imported twice adds nothing', () => {
		expect.assertions(1);

		const viaV2 = roundTrip([row()]).transactions[0].metadata.deduplicationKey;
		const viaV1 = parseCsvTransactions(
			[
				'date;libelle;categorie;montant;type;nature;source_bancaire',
				"2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv"
			].join('\r\n')
		).transactions[0].metadata.deduplicationKey;

		expect(viaV2).toBe(viaV1);
	});

	it('keeps a répartition’s fingerprint on the PARENT total, not on its first part', () => {
		expect.assertions(1);

		expect(roundTrip([SPLIT_ROW]).transactions[0].metadata.deduplicationKey).toBe(
			roundTrip([row()]).transactions[0].metadata.deduplicationKey
		);
	});

	it('round-trips income as income, on the sign that is not the common one', () => {
		expect.assertions(3);

		const result = roundTrip([
			row({
				label: 'Salaire',
				type: 'income',
				amountCents: 250_000,
				category: { name: 'Revenus' },
				splits: [
					{ amountCents: 200_000, position: 0, category: { name: 'Revenus' } },
					{ amountCents: 50_000, position: 1, category: { name: 'Primes' } }
				]
			})
		]);

		expect(result.transactions[0].amountCents).toBe(250_000);
		expect(result.transactions[0].metadata.type).toBe('income');
		expect(result.transactions[0].splitParts).toEqual([
			{ category: 'Revenus', amountCents: 200_000 },
			{ category: 'Primes', amountCents: 50_000 }
		]);
	});

	/**
	 * PR5's resolution of the filtered-export tension: a file that only PARTLY captures a
	 * répartition (the screen's own category filter dropped a part the export therefore never
	 * wrote) must be refused BY NAME as incomplete, never silently re-imported as a smaller, wrong
	 * répartition — CLAUDE.md's own recorded case for why a refusal test asserts the REASON, not
	 * merely that a refusal happened: a different check catching the same file for the WRONG reason
	 * (e.g. "duplicate positions") would send a user looking at the wrong lines.
	 */
	it('refuses a category-filtered export of a partial split as INCOMPLETE, never as a smaller répartition', () => {
		expect.assertions(3);

		const filtered = parseCsvTransactions(buildTransactionsCsv([SPLIT_ROW], NO_MAPPINGS, 'Jardin'));

		expect(filtered.transactions).toHaveLength(0);
		expect(filtered.invalidRows).toHaveLength(1);
		expect(filtered.invalidRows[0]).toMatchObject({
			fact: { code: 'split-incomplete' },
			field: 'part'
		});
	});

	it('keeps round-tripping cleanly when the filter happens to match every part', () => {
		expect.assertions(3);

		// Both parts are filed under the SAME category, so a filter on it matches the whole
		// répartition — nothing is dropped, and the file re-imports exactly like an unfiltered one.
		const bothBricolage = row({
			category: { name: 'Maison' },
			splits: [
				{ amountCents: 5_000, position: 0, category: { name: 'Bricolage' } },
				{ amountCents: 3_000, position: 1, category: { name: 'Bricolage' } }
			]
		});

		const result = parseCsvTransactions(
			buildTransactionsCsv([bothBricolage], NO_MAPPINGS, 'Bricolage')
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].splitParts).toEqual([
			{ category: 'Bricolage', amountCents: -5_000 },
			{ category: 'Bricolage', amountCents: -3_000 }
		]);
	});
});
