import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from '../csv';
import { assignDedupeKeysForBatch } from '../dedupeRecompute';

/**
 * The bucket a CSV run lands on. The key is no longer built at parse time, so a spec that wants to
 * talk about fingerprints asks the WRITE path what it would write, through the same function the
 * write path calls. Retyping the key format here instead would assert the copy.
 */
const CSV_BUCKET = {
	accountId: 'account-1',
	source: 'csv',
	currency: 'EUR',
	exponent: 2,
	providerAccountId: null
};
import { resolveRequiredColumns } from './columnAliases';
import { fingerprintFor } from '../mapping/fingerprint';

/**
 * `Libellé` resolves, and the boundary that widening must not cross.
 *
 * ## The gap
 *
 * `resolveRequiredColumns` folded with `trim().toLowerCase()` and nothing else, so the alias
 * `libelle` never matched the accented spelling — which is the one French banks actually write.
 * Measured before this: `Date,Libellé,Montant,Catégorie` imported 0 of 4 with
 * `missing-required-column: label`, while the identical file unaccented imported 4 of 4.
 *
 * It was equally broken before the column-mapping chantier, so it is a gap rather than a
 * regression. It is closed here because the alias table exists precisely to accept banks we do
 * not know, and refusing the commonest French header in the product's own language is the
 * narrowest possible reading of that job.
 *
 * ## Reuse, not invention
 *
 * `revolut.ts` already carried a diacritic-folding `normalizeComparableHeader`, which is what
 * lets it match `Etat` for `État`. That function moved to `utils/encoding.ts` and is now shared
 * rather than copied — the repository's rule against a test and its subject sharing a source
 * applies just as much to two production call sites.
 *
 * ## The boundary: the mapping fingerprint keeps its own fold
 *
 * `mapping/fingerprint.ts` folds with `trim().toLowerCase()` and **must go on doing so.** That
 * fingerprint is STORED: it is how a memorised correspondance recognises the same header row on
 * a later upload. Changing the fold changes every stored fingerprint at once, and the symptom
 * would be « it forgot my designation », with nothing on screen to point at. The last test in
 * this file is what stops a later tidy-up unifying the two folds on the grounds that they look
 * alike.
 */
describe('an accented French header', () => {
	it('resolves the label role, where it used to be missing', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			'Date,Libellé,Montant,Catégorie\n01/06/2026,Mercerie Lafayette,"-45,20",Alimentation'
		);

		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].label).toBe('Mercerie Lafayette');
	});

	it('reads the same file identically with and without its accents', () => {
		expect.assertions(2);

		const accented = parseCsvTransactions(
			'Date,Libellé,Montant,Catégorie\n01/06/2026,Mercerie Lafayette,"-45,20",Alimentation'
		);
		const plain = parseCsvTransactions(
			'Date,Libelle,Montant,Categorie\n01/06/2026,Mercerie Lafayette,"-45,20",Alimentation'
		);

		expect(accented.summary).toEqual(plain.summary);
		// The dedupe key too, so the same statement exported twice by a bank that changed its
		// header encoding does not import twice.
		expect(assignDedupeKeysForBatch(accented.transactions, CSV_BUCKET)).toEqual(
			assignDedupeKeysForBatch(plain.transactions, CSV_BUCKET)
		);
	});

	it('resolves through the alias table itself, not only end to end', () => {
		expect.assertions(2);

		const resolution = resolveRequiredColumns(['Date', 'Libellé', 'Montant']);

		expect(resolution.ok).toBe(true);
		// The FOLDED name, because `toRecord` keys the record by the folded header and the caller
		// looks the value up through whatever this returns. An unfolded name here finds nothing
		// and the row imports with a blank label rather than failing loudly.
		expect(resolution.ok && resolution.columns.label).toBe('libelle');
	});

	/**
	 * The direction this change is NOT moving in, part one.
	 *
	 * Folding accents means two spellings of one column now collide. That must be REFUSED, not
	 * silently resolved: `toRecord` assigns `record[header] = row[index]`, so the later duplicate
	 * overwrites the earlier one and the last column quietly wins.
	 */
	it('refuses a file carrying both spellings of one column', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			'Date,Libellé,Libelle,Montant\n01/06/2026,Mercerie,Autre chose,"-45,20"'
		);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows.map((row) => row.fact.code)).toContain('duplicate-column');
	});

	/**
	 * The direction this change is NOT moving in, part two, and the load-bearing one.
	 *
	 * The mapping fingerprint is stored in the database. If it folded accents, every memorised
	 * correspondance written before this change would stop matching its own file.
	 */
	it('leaves the stored mapping fingerprint folding accents apart', () => {
		expect.assertions(2);

		const accented = fingerprintFor(['Date', 'Libellé', 'Montant'], 'name');
		const plain = fingerprintFor(['Date', 'Libelle', 'Montant'], 'name');

		expect(accented).not.toBe(plain);
		// And it is stable, so the assertion above is about the accent rather than about the
		// function being nondeterministic.
		expect(fingerprintFor(['Date', 'Libellé', 'Montant'], 'name')).toBe(accented);
	});
});
