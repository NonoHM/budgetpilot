import { describe, expect, it } from 'vitest';
import {
	boundedColumnName,
	MAX_COLUMN_NAME_LENGTH,
	validateColumnMapping,
	type ColumnMappingInput
} from './model';

const byName: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'date operation',
	labelColumn: 'libelle complet',
	amountColumn: 'montant',
	categoryColumn: 'categorie banque',
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 15
};

const byPosition: ColumnMappingInput = {
	matchBy: 'position',
	dateColumn: null,
	labelColumn: null,
	amountColumn: null,
	categoryColumn: null,
	dateIndex: 0,
	labelIndex: 1,
	amountIndex: 2,
	categoryIndex: 3,
	columnCount: 15
};

describe('validateColumnMapping, what it accepts', () => {
	it('accepts a complete name-matched mapping', () => {
		expect(validateColumnMapping(byName)).toEqual({ ok: true });
	});

	it('accepts a complete position-matched mapping', () => {
		expect(validateColumnMapping(byPosition)).toEqual({ ok: true });
	});

	it('accepts a mapping with no category, because that role is optional', () => {
		expect(validateColumnMapping({ ...byName, categoryColumn: null })).toEqual({ ok: true });
		expect(validateColumnMapping({ ...byPosition, categoryIndex: null })).toEqual({ ok: true });
	});

	it('accepts index 0 and the last index, so the range is not off by one at either end', () => {
		expect(
			validateColumnMapping({ ...byPosition, dateIndex: 0, categoryIndex: 14, columnCount: 15 })
		).toEqual({ ok: true });
	});
});

describe('validateColumnMapping, what it refuses', () => {
	it('refuses a category that repeats a required role, naming which one', () => {
		expect(validateColumnMapping({ ...byName, categoryColumn: 'libelle complet' })).toEqual({
			ok: false,
			reason: { code: 'category-repeats-required-role', role: 'label' }
		});
		expect(validateColumnMapping({ ...byPosition, categoryIndex: 1 })).toEqual({
			ok: false,
			reason: { code: 'category-repeats-required-role', role: 'label' }
		});
	});

	it('refuses two required roles sharing a column, naming both', () => {
		expect(validateColumnMapping({ ...byName, labelColumn: 'montant' })).toEqual({
			ok: false,
			reason: { code: 'roles-share-a-column', roles: ['label', 'amount'] }
		});
	});

	it('refuses a missing required role, naming it in row order', () => {
		expect(validateColumnMapping({ ...byName, amountColumn: null })).toEqual({
			ok: false,
			reason: { code: 'missing-required-role', role: 'amount' }
		});
		// Two missing: the first in row order wins, so the message is one sentence rather than a list.
		expect(validateColumnMapping({ ...byName, dateColumn: null, amountColumn: null })).toEqual({
			ok: false,
			reason: { code: 'missing-required-role', role: 'date' }
		});
	});

	it('refuses a mapping carrying both a name and an index for the same role', () => {
		expect(validateColumnMapping({ ...byName, dateIndex: 0 })).toEqual({
			ok: false,
			reason: { code: 'name-mapping-carries-indices' }
		});
		expect(validateColumnMapping({ ...byPosition, dateColumn: 'date' })).toEqual({
			ok: false,
			reason: { code: 'position-mapping-carries-names' }
		});
	});

	it('refuses an index outside the file it claims to describe', () => {
		// The only structural check a positional mapping has. Without it a restored mapping could
		// point past the end of a file and read undefined as a date.
		expect(validateColumnMapping({ ...byPosition, amountIndex: 15, columnCount: 15 })).toEqual({
			ok: false,
			reason: { code: 'index-out-of-range', role: 'amount' }
		});
		expect(validateColumnMapping({ ...byPosition, amountIndex: -1 })).toEqual({
			ok: false,
			reason: { code: 'index-out-of-range', role: 'amount' }
		});
	});

	it('refuses an unknown matchBy rather than treating it as a default', () => {
		// The value arrives from a restored backup as free text. Defaulting it would let a payload
		// choose the weaker matching mode by writing a typo.
		expect(validateColumnMapping({ ...byName, matchBy: 'whatever' as unknown as 'name' })).toEqual({
			ok: false,
			reason: { code: 'match-by-unknown', value: 'whatever' }
		});
	});

	it('refuses a column count that is not a positive whole number', () => {
		for (const columnCount of [0, -1, 1.5, Number.NaN]) {
			expect(validateColumnMapping({ ...byName, columnCount })).toEqual({
				ok: false,
				reason: { code: 'column-count-invalid' }
			});
		}
	});
});

describe('boundedColumnName', () => {
	it('bounds a name a file can make arbitrarily long', () => {
		expect(boundedColumnName('x'.repeat(500))).toHaveLength(MAX_COLUMN_NAME_LENGTH);
	});

	it('leaves an ordinary header untouched', () => {
		expect(boundedColumnName('  Date  operation ')).toBe('Date operation');
	});

	it('neutralises a leading formula character, like every other imported text', () => {
		expect(boundedColumnName('=cmd()')).toBe("'=cmd()");
	});

	it('cuts on characters, so an astral character is never split in half', () => {
		// A lone surrogate half is not valid UTF-8 and MySQL's utf8mb4 rejects it, so this is the
		// difference between a mapping that saves and one that fails on one engine only.
		const emoji = '😀';
		const name = emoji.repeat(200);
		const bounded = boundedColumnName(name);

		expect(Array.from(bounded)).toHaveLength(MAX_COLUMN_NAME_LENGTH);
		expect(bounded.endsWith(emoji)).toBe(true);
	});
});
