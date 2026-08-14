import { afterEach, describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import {
	assertCsvColumnBoundConfigured,
	CSV_DEFAULT_MAX_COLUMNS,
	CSV_MAX_COLUMNS_CEILING,
	CSV_MAX_COLUMNS_ENV,
	resolveCsvMaxColumns
} from './columnBounds';

/** A file of one data row and `count` columns, the first three being the required roles. */
function fileWithColumns(count: number): string {
	const headers = ['date', 'libelle', 'montant'];
	const cells = ['24/06/2026', 'CARREFOUR MARKET', '-24,90'];
	for (let index = headers.length; index < count; index += 1) {
		headers.push(`c${index}`);
		cells.push('x');
	}
	return `${headers.join(';')}\n${cells.join(';')}`;
}

afterEach(() => {
	delete process.env[CSV_MAX_COLUMNS_ENV];
});

describe('the column bound', () => {
	it('refuses a file past the bound, naming the number', () => {
		const result = parseCsvTransactions(fileWithColumns(11), { profile: 'auto', maxColumns: 10 });

		expect(result.invalidRows).toEqual([
			{ scope: { kind: 'file' }, fact: { code: 'too-many-columns', max: 10 } }
		]);
		expect(result.transactions).toHaveLength(0);
	});

	it('accepts a file EXACTLY at the bound, so it is not off by one', () => {
		// The direction this change is not moving in, and the half that can actually fail: a bound
		// written with `>=` refuses a legitimate file and satisfies the test above perfectly.
		const result = parseCsvTransactions(fileWithColumns(10), { profile: 'auto', maxColumns: 10 });

		expect(result.invalidRows).toEqual([]);
		expect(result.transactions).toHaveLength(1);
	});

	it('refuses before choosing a profile, because the width is a fact about the file', () => {
		// A maison file is recognised by its exact header, so if the bound ran after profile
		// resolution this would be refused for the wrong reason, or not at all.
		const maisonHeader = 'date;libelle;categorie;montant;type;nature;source_bancaire';
		const result = parseCsvTransactions(
			`${maisonHeader}\n2026-06-01;Courses;Alimentation;-10;expense;;csv`,
			{ profile: 'auto', maxColumns: 3 }
		);

		expect(result.invalidRows).toEqual([
			{ scope: { kind: 'file' }, fact: { code: 'too-many-columns', max: 3 } }
		]);
	});

	it('lets an ordinary bank statement through at the shipped default', () => {
		// The absolute figure that stops this whole file being satisfied by a parser that refuses
		// everything, and the claim the default is chosen for: the design plate says fifteen
		// columns in a bank statement, forty in an accounting package's export.
		const result = parseCsvTransactions(fileWithColumns(40), { profile: 'auto' });

		expect(CSV_DEFAULT_MAX_COLUMNS).toBeGreaterThanOrEqual(40);
		expect(result.invalidRows).toEqual([]);
		expect(result.transactions).toHaveLength(1);
	});
});

describe('resolveCsvMaxColumns', () => {
	it('returns the default when unset or blank', () => {
		expect(resolveCsvMaxColumns()).toBe(CSV_DEFAULT_MAX_COLUMNS);
		process.env[CSV_MAX_COLUMNS_ENV] = '   ';
		expect(resolveCsvMaxColumns()).toBe(CSV_DEFAULT_MAX_COLUMNS);
	});

	it('returns a configured value inside the range', () => {
		process.env[CSV_MAX_COLUMNS_ENV] = '64';
		expect(resolveCsvMaxColumns()).toBe(64);
	});

	it('throws on a value that is not a whole number of at least one', () => {
		for (const bad of ['0', '-1', '1.5', 'many', '']) {
			process.env[CSV_MAX_COLUMNS_ENV] = bad;
			if (bad === '') {
				// Empty is the unset case, deliberately, so it falls back rather than throwing.
				expect(resolveCsvMaxColumns()).toBe(CSV_DEFAULT_MAX_COLUMNS);
				continue;
			}
			expect(() => resolveCsvMaxColumns()).toThrow(CSV_MAX_COLUMNS_ENV);
		}
	});

	it('refuses a value above the ceiling rather than clamping it', () => {
		// Clamping is the tempting alternative and it is the one that lies: the operator reads
		// their own number in the environment and a different one is in force.
		process.env[CSV_MAX_COLUMNS_ENV] = String(CSV_MAX_COLUMNS_CEILING + 1);
		expect(() => resolveCsvMaxColumns()).toThrow(/ceiling/);
	});

	it('accepts the ceiling itself, so the boundary is not off by one either', () => {
		process.env[CSV_MAX_COLUMNS_ENV] = String(CSV_MAX_COLUMNS_CEILING);
		expect(resolveCsvMaxColumns()).toBe(CSV_MAX_COLUMNS_CEILING);
	});
});

describe('assertCsvColumnBoundConfigured', () => {
	it('says nothing at the default', () => {
		const warnings: unknown[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args);
		try {
			assertCsvColumnBoundConfigured();
		} finally {
			console.warn = original;
		}
		expect(warnings).toEqual([]);
	});

	it('warns when the bound is lowered below an ordinary accounting export', () => {
		// The presence half for the assertion above: without it, a function that never warns at
		// all would pass "says nothing at the default" perfectly.
		process.env[CSV_MAX_COLUMNS_ENV] = '12';
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => void warnings.push(message);
		try {
			assertCsvColumnBoundConfigured();
		} finally {
			console.warn = original;
		}
		expect(warnings).toHaveLength(2);
		expect(warnings.join(' ')).toContain('LOWERED');
	});
});
