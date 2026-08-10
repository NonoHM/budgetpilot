import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from '../csv';
import { MAISON_V2_HEADER } from './maison-v2';
import { TRANSACTION_CSV_HEADER } from '$lib/server/transactions/exportCsv';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';

/**
 * The « maison » profile, version 2 — the shape that survives a répartition.
 *
 * Version 1 is NOT touched: a file a user exported last month must keep importing exactly as it
 * did, so v2 is a second recognised header rather than an edit to the first. The last test here is
 * what proves that, and it is the one that must never be deleted as redundant.
 */

const MAISON_V1_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';

function parse(...lines: string[]) {
	return parseCsvTransactions([MAISON_V2_HEADER, ...lines].join('\n'));
}

describe('profil maison v2', () => {
	// The coupling stated once, explicitly, instead of implicitly in every fixture below. If a
	// future chantier adds a column to the export, this is what says the parser has not been told.
	it('recognises exactly the header the export writes', () => {
		expect.assertions(1);

		expect(MAISON_V2_HEADER).toBe(TRANSACTION_CSV_HEADER);
	});

	it('auto-detects the v2 header without being asked for a profile', () => {
		expect.assertions(2);

		const result = parse(
			"2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison"
		);

		expect(result.summary.profile).toBe('maison');
		expect(result.errors).toEqual([]);
	});

	// The whole point of the version. Before OD-2 these two lines were two transactions of 50,00 €
	// and 30,00 €, the user's répartition was gone, and nothing reported it: `amountCents` is in the
	// dedupe key, so neither line matched the original fingerprint and neither was skipped.
	it('regroups N allocation lines into ONE transaction carrying N parts', () => {
		expect.assertions(4);

		const result = parse(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison"
		);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].amountCents).toBe(-8_000);
		expect(result.transactions[0].splitParts).toEqual([
			{ category: 'Bricolage', amountCents: -5_000 },
			{ category: 'Jardin', amountCents: -3_000 }
		]);
		expect(result.errors).toEqual([]);
	});

	// §2.2: the parent keeps its own category as the restoration value. Taking the first part's
	// instead would look identical on every screen until the user removes the répartition.
	it('takes the parent category from categorie_parent, never from the first part', () => {
		expect.assertions(1);

		const result = parse(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison"
		);

		expect(result.transactions[0].category).toBe('Maison');
	});

	it('keeps the position order the file states, because it decides which part carries the cent', () => {
		expect.assertions(1);

		const result = parse(
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison",
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison"
		);

		expect(result.transactions[0].splitParts?.map((part) => part.category)).toEqual([
			'Bricolage',
			'Jardin'
		]);
	});

	it('refuses a group whose parts do not sum to the stated total', () => {
		expect.assertions(2);

		const result = parse(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-20.00;expense;spending;csv;'-80.00;2/2;Maison"
		);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toMatchObject({ field: 'amount' });
	});

	/**
	 * The REASON is asserted, not just the refusal, and that is not pedantry — it is what this test
	 * measured. Deleting the completeness check left this file still refused, by the duplicate-index
	 * check that follows it, under a sentence describing something that did not happen. A test
	 * asserting only `field: 'part'` reported that as a working guard.
	 */
	it('refuses a truncated group rather than importing the lines it happens to have', () => {
		expect.assertions(2);

		const result = parse(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/3;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/3;Maison"
		);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toMatchObject({
			field: 'part',
			reason: 'répartition incomplète'
		});
	});

	// The direction the index check structurally cannot see: three lines for a stated two, whose
	// indices repeat, so the set is exactly the size it should be.
	it('refuses a group carrying MORE lines than it declares', () => {
		expect.assertions(2);

		const result = parse(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison"
		);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toMatchObject({
			field: 'part',
			reason: 'lignes de répartition en trop'
		});
	});

	it('refuses a group past the server-side ceiling on parts', () => {
		expect.assertions(1);

		const lines = Array.from(
			{ length: 21 },
			(_, index) =>
				`2026-06-12;Leroy Merlin;Cat${index};'-1.00;expense;spending;csv;'-21.00;${index + 1}/21;Maison`
		);

		expect(parse(...lines).transactions).toHaveLength(0);
	});

	/**
	 * A répartition CAN cross a nature boundary (OD-4), so differing natures are the normal case and
	 * must not be refused. But `natureManual` belongs to the PARENT and overrides every part, so
	 * there is no honest value to give it when the lines disagree: leaving it unset lets each part
	 * resolve its own nature from its own category, which is what produced those lines in the first
	 * place.
	 */
	it('pins natureManual only when every line agrees on it', () => {
		expect.assertions(2);

		const agreed = parse(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;fee;csv;'-80.00;1/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;fee;csv;'-80.00;2/2;Maison"
		);
		const mixed = parse(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;transfer;csv;'-80.00;2/2;Maison"
		);

		expect(agreed.transactions[0].metadata.natureManual).toBe('fee');
		expect(mixed.transactions[0].metadata.natureManual).toBeUndefined();
	});

	// A file where every transaction is split would otherwise report twice the money it holds.
	it('counts a split transaction ONCE in the summary, not once per part', () => {
		expect.assertions(2);

		const result = parse(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison"
		);

		expect(result.summary.totalDebitCents).toBe(8_000);
		expect(result.summary.validRows).toBe(1);
	});

	// The mirror of the test above, and the asymmetry is OD-5: the parent may sit in the « à
	// classer » pile, a part may not. Refused here so the user reads a line number instead of the
	// import failing after the parent row is already inserted.
	it('refuses the sentinel on a PART while accepting it on the parent', () => {
		expect.assertions(2);

		const result = parse(
			"2026-06-12;Leroy Merlin;uncategorized;'-50.00;expense;spending;csv;'-80.00;1/2;Maison",
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison"
		);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toMatchObject({ field: 'category' });
	});

	it('accepts the sentinel the export writes for an unclassified row', () => {
		expect.assertions(2);

		const result = parse(
			"2026-06-12;Leroy Merlin;uncategorized;'-80.00;expense;;csv;'-80.00;1/1;uncategorized"
		);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
	});

	it('gives an unsplit v2 line no parts at all, so nothing downstream sees a one-part split', () => {
		expect.assertions(1);

		const result = parse(
			"2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison"
		);

		expect(result.transactions[0].splitParts).toBeUndefined();
	});

	/**
	 * THE VERSIONING CLAIM ITSELF. A v1 file is on somebody's disk right now; if this ever goes red
	 * it means v2 was built by editing v1 rather than beside it, and every installed export stopped
	 * importing. It is not redundant with `maison.spec.ts` — that file asserts v1 works, this one
	 * asserts v1 still works with v2 present and matching first in the registry.
	 */
	it('leaves the v1 header importing exactly as before', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			`${MAISON_V1_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`
		);

		expect(result.summary.profile).toBe('maison');
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].amountCents).toBe(-4_210);
	});
});
