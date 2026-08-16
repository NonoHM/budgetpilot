import { describe, expect, it } from 'vitest';
import { rememberedMappingView, type RememberedMappingSource } from './rememberedMapping';

const NAMED: RememberedMappingSource = {
	id: 'm1',
	matchBy: 'name',
	dateColumn: 'date operation',
	labelColumn: 'libelle',
	amountColumn: 'montant',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 4,
	useCount: 3,
	lastUsedAt: new Date('2026-08-15T10:00:00Z'),
	createdAt: new Date('2026-08-01T10:00:00Z'),
	importBatchCount: 2
};

const POSITIONAL: RememberedMappingSource = {
	...NAMED,
	id: 'm2',
	matchBy: 'position',
	dateColumn: null,
	labelColumn: null,
	amountColumn: null,
	categoryColumn: null,
	dateIndex: 0,
	labelIndex: 2,
	amountIndex: 5,
	categoryIndex: null
};

describe('rememberedMappingView', () => {
	it('names the columns of a name-matched mapping, and omits the role it never held', () => {
		expect.assertions(3);

		const view = rememberedMappingView(NAMED);

		expect(view.matchBy).toBe('name');
		expect(view.columns).toEqual({
			date: 'date operation',
			label: 'libelle',
			amount: 'montant'
		});
		// `category` is optional and this mapping has none: absent, never an empty string, so the
		// row can decide not to draw it rather than drawing a role with nothing beside it.
		expect(view.columns.category).toBeUndefined();
	});

	/**
	 * The state #326 calls the riskiest, and the reason it is built rather than deferred.
	 *
	 * A positional mapping has NO column names — the fields are null by schema. A row that fell
	 * back to the name presentation would render four blanks and read as an empty correspondance,
	 * on precisely the mapping a user made because they could not read their own headers.
	 */
	it('gives a positional mapping no columns at all, and keeps its indices', () => {
		expect.assertions(3);

		const view = rememberedMappingView(POSITIONAL);

		expect(view.matchBy).toBe('position');
		expect(view.columns).toEqual({});
		expect(view.indices).toEqual({ date: 0, label: 2, amount: 5 });
	});

	/**
	 * A stored `matchBy` nobody recognises resolves to `position`, the WEAKER claim.
	 *
	 * A stored record outlives the code that wrote it: a restore from before the validator, or a
	 * row edited in the database. Falling to `name` would print whatever sat in `dateColumn` as
	 * though it had been verified. Falling to `position` claims less, which is the correct
	 * direction for a record we cannot vouch for.
	 */
	it('treats an unrecognised matchBy as positional, never as named', () => {
		expect.assertions(2);

		const view = rememberedMappingView({ ...NAMED, matchBy: 'wibble' });

		expect(view.matchBy).toBe('position');
		expect(view.columns).toEqual({});
	});

	it('drops a blank column name rather than drawing a role with nothing beside it', () => {
		expect.assertions(2);

		const view = rememberedMappingView({ ...NAMED, labelColumn: '   ' });

		expect(view.columns.label).toBeUndefined();
		expect(view.columns.date).toBe('date operation');
	});

	/** A negative or fractional index is a malformed record, not a column zero. */
	it('drops an index that is not a real position', () => {
		expect.assertions(2);

		const view = rememberedMappingView({ ...POSITIONAL, dateIndex: -1, labelIndex: 1.5 });

		expect(view.indices.date).toBeUndefined();
		expect(view.indices.label).toBeUndefined();
	});

	it('carries the batch count through, which is what the confirmation warns about', () => {
		expect.assertions(1);

		expect(rememberedMappingView(NAMED).importBatchCount).toBe(2);
	});
});
