import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from '../csv';
import type { ColumnMappingInput } from '../mapping/model';

/**
 * A file no alias table recognises, imported because the user said which column is which.
 *
 * **This widens, so the tests that matter are the ones for the direction it is NOT moving in.** A
 * widening's natural tests assert that more imports, and that is exactly the state in which a loss
 * goes unnoticed: something that used to be refused quietly stops being. So every "imports" case
 * below is paired with a "still refused" case, and the refusals assert the CODE, because the
 * reason is the only part of a refusal a user ever sees.
 *
 * The header cells are FILE CONTENT, not identifiers, which is why they are French: they are the
 * literal bytes a French bank writes.
 */
const UNRECOGNISED =
	'Jour;Intitule operation;Somme\n24/06/2026;CARREFOUR MARKET;-24,90\n21/06/2026;VIR RECU SALAIRE;1850,00\n03/06/2026;SNCF;-58,00\n';

const MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'jour',
	labelColumn: 'intitule operation',
	amountColumn: 'somme',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 3
};

function importMapped(content: string, columnMapping: ColumnMappingInput | undefined = MAPPING) {
	return parseCsvTransactions(content, { profile: 'mapped', columnMapping });
}

describe('a designated file imports', () => {
	it('reads the dates, labels, signs and amounts through the columns the user named', () => {
		const result = importMapped(UNRECOGNISED);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(3);
		expect(
			result.transactions.map((t) => [t.date, t.label, t.amountCents, t.metadata.type])
		).toStrictEqual([
			['2026-06-24', 'CARREFOUR MARKET', -2490, 'expense'],
			['2026-06-21', 'VIR RECU SALAIRE', 185000, 'income'],
			['2026-06-03', 'SNCF', -5800, 'expense']
		]);
		// The absolute figures beside the emptiness assertion above: a parser returning nothing
		// satisfies `invalidRows` being empty perfectly.
		expect(result.summary.totalDebitCents).toBe(8290);
		expect(result.summary.totalCreditCents).toBe(185000);
	});

	it('reports its own profile in the summary rather than borrowing generic', () => {
		// A parser labelling its result with a sibling's name is how a per-profile coverage gate
		// once reported a profile blind while it was being exercised thousands of times.
		expect(importMapped(UNRECOGNISED).summary.profile).toBe('mapped');
	});

	it('resolves a mapping stored in one spelling against a file written in another', () => {
		const shouty = 'JOUR;Intitule Operation;  Somme  \n24/06/2026;CARREFOUR MARKET;-24,90\n';

		expect(importMapped(shouty).transactions).toHaveLength(1);
	});

	it('reads a positional mapping, which is what a headerless-looking file gets', () => {
		const positional: ColumnMappingInput = {
			...MAPPING,
			matchBy: 'position',
			dateColumn: null,
			labelColumn: null,
			amountColumn: null,
			dateIndex: 0,
			labelIndex: 1,
			amountIndex: 2
		};

		expect(importMapped(UNRECOGNISED, positional).transactions).toHaveLength(3);
	});
});

describe('the direction this is NOT moving in: what must still be refused', () => {
	it('still refuses the same file with NO mapping, so the unmapped path did not widen', () => {
		// The whole point of the pairing. If designating a file were what made `generic` accept
		// unknown columns, this test would go green and the widening would have reached a path
		// nobody asked it to reach.
		const unmapped = parseCsvTransactions(UNRECOGNISED);

		expect(unmapped.transactions).toStrictEqual([]);
		expect(unmapped.invalidRows.map((row) => row.fact.code)).toStrictEqual([
			'missing-required-column',
			'missing-required-column',
			'missing-required-column'
		]);
	});

	it('refuses a mapped file whose amounts are magnitudes beside a direction column', () => {
		// #320's defect arriving through the mapping path. Designating the amount column is not
		// evidence that the file can be read: every row would import as income, and the user would
		// read 0,00 EUR of spending against a statement full of it.
		const withSens =
			'jour;intitule operation;somme;sens\n24/06/2026;CARREFOUR;24,90;D\n21/06/2026;SALAIRE;1850,00;C\n';
		const mapping: ColumnMappingInput = { ...MAPPING, columnCount: 4 };

		const result = importMapped(withSens, mapping);

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'amount-sign-in-separate-column',
			column: 'sens'
		});
	});

	it('refuses a mapped file that declares a currency it cannot hold', () => {
		const gbp = 'jour;intitule operation;somme;currency\n24/06/2026;TESCO;-12,30;GBP\n';
		const mapping: ColumnMappingInput = { ...MAPPING, columnCount: 4 };

		const result = importMapped(gbp, mapping);

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'unsupported-currency',
			currency: 'GBP'
		});
	});

	it('refuses a duplicated header, which matters MORE here because a mapping resolves by name', () => {
		const duplicated = 'jour;somme;somme\n24/06/2026;-24,90;-99,00\n';
		const result = importMapped(duplicated, { ...MAPPING, columnCount: 3 });

		expect(result.invalidRows.map((row) => row.fact)).toContainEqual({
			code: 'duplicate-column',
			column: 'somme'
		});
	});
});

describe('a stored mapping that no longer fits, or never should have', () => {
	it('refuses rather than importing what it can, naming the roles that are gone', () => {
		// State 3b reaching the parser. The route is supposed to open the designation screen
		// instead, so this is defence in depth, and it is the difference between a bug and a
		// silent wrong import if a future caller forgets the verdict.
		const renamed = 'jour;libelle complet;somme\n24/06/2026;CARREFOUR;-24,90\n';

		const result = importMapped(renamed);

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'mapping-columns-missing',
			roles: 'label'
		});
	});

	it('names every mapped role when the file has nothing in common with it', () => {
		const foreign = 'a;b;c\n1;2;3\n';

		expect(importMapped(foreign).invalidRows[0].fact).toStrictEqual({
			code: 'mapping-columns-missing',
			roles: 'date, label, amount'
		});
	});

	it('refuses an invalid mapping instead of parsing through it', () => {
		// Reachable through a backup restored from a version before the validator existed. A bad
		// mapping is not one wrong row: it decides which column is money for every future file of
		// this shape.
		const invalid: ColumnMappingInput = { ...MAPPING, labelColumn: 'somme' };

		const result = importMapped(UNRECOGNISED, invalid);

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'mapping-invalid',
			reason: 'roles-share-a-column'
		});
	});

	it('refuses when the profile was asked for and no mapping came with it', () => {
		// Called directly rather than through the helper: a JavaScript default parameter fires on
		// `undefined`, so `importMapped(file, undefined)` would silently pass the default mapping
		// and this test would assert the opposite of its own name while passing.
		const result = parseCsvTransactions(UNRECOGNISED, { profile: 'mapped' });

		expect(result.transactions).toStrictEqual([]);
		expect(result.invalidRows[0].fact).toStrictEqual({
			code: 'mapping-invalid',
			reason: 'mapping-absent'
		});
	});
});

describe('the mapped path agrees with the generic one where they overlap', () => {
	it('produces the identical transactions for a file both can read', () => {
		// An anti-drift comparison, and it carries the assertion that makes such a comparison mean
		// anything: the two profiles really do resolve their columns by different routes here, one
		// through the alias table and one through a stored mapping. Two paths agreeing is worth
		// nothing when they are secretly one path, which this repository has measured.
		const readable = 'date;label;amount\n24/06/2026;CARREFOUR MARKET;-24,90\n';
		const mapping: ColumnMappingInput = {
			...MAPPING,
			dateColumn: 'date',
			labelColumn: 'label',
			amountColumn: 'amount'
		};

		const generic = parseCsvTransactions(readable);
		const mapped = importMapped(readable, mapping);

		expect(generic.summary.profile).toBe('generic');
		expect(mapped.summary.profile).toBe('mapped');
		expect(mapped.transactions).toHaveLength(1);
		expect(mapped.transactions.map((t) => ({ ...t, metadata: { ...t.metadata } }))).toStrictEqual(
			generic.transactions.map((t) => ({ ...t, metadata: { ...t.metadata } }))
		);
	});
});
