import { describe, expect, it } from 'vitest';
import { groupInvalidRows } from './groupInvalidRows';
import type { ImportInvalidRowDetail } from './importSummary';

const row = (
	line: number,
	fact: ImportInvalidRowDetail['fact'],
	field?: string,
	preview = ''
): ImportInvalidRowDetail => ({
	key: line,
	scope: { kind: 'row', line },
	fact,
	field,
	profile: 'generic',
	preview
});

const badDate = (value: string) =>
	({ code: 'invalid-date', column: 'date', value }) satisfies ImportInvalidRowDetail['fact'];

describe('groupInvalidRows', () => {
	it('collapses rows refused for the same reason into one group, in order', () => {
		expect.assertions(3);

		const groups = groupInvalidRows([
			row(2, badDate('01.06.2026')),
			row(3, badDate('02.06.2026')),
			row(4, badDate('03.06.2026'))
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(3);
		expect(groups[0].rows.map((r) => r.scope)).toEqual([
			{ kind: 'row', line: 2 },
			{ kind: 'row', line: 3 },
			{ kind: 'row', line: 4 }
		]);
	});

	/**
	 * The value differs per row and the group is keyed on the REASON, not on the rendered
	 * sentence. Keying on the sentence would put three dates in three groups and collapse
	 * nothing, which is the whole defect: the tester met twenty-five rows that differed only in
	 * the value, and twenty-five groups of one is the table he already had.
	 */
	it('groups on the code and the field, never on the rendered sentence', () => {
		expect.assertions(2);

		const groups = groupInvalidRows([row(2, badDate('01.06.2026')), row(3, badDate('31.02.2026'))]);

		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(2);
	});

	/**
	 * The case that caught the first version of this function.
	 *
	 * Keying on the code alone folded `Colonne non autorisée: alpha` together with
	 * `Colonne non autorisée: beta` and rendered one row naming `alpha`. `beta` was then nowhere
	 * on the screen — a table that had lost a complaint rather than folded one. It was found by
	 * `invalid-rows-table.svelte.spec.ts`, which counts body rows and had asserted three.
	 */
	it('keeps one code apart when its payload describes the FILE, not the row', () => {
		expect.assertions(2);

		const groups = groupInvalidRows([
			row(2, { code: 'unknown-column', column: 'alpha' }),
			row(3, { code: 'unknown-column', column: 'beta' })
		]);

		expect(groups).toHaveLength(2);
		expect(groups.map((g) => g.count)).toEqual([1, 1]);
	});

	/** And its opposite, so the pair states the rule rather than half of it. */
	it('folds one code together when its payload describes the ROW', () => {
		expect.assertions(2);

		const groups = groupInvalidRows([
			row(2, { code: 'unsupported-currency', currency: 'GBP' }),
			row(3, { code: 'unsupported-currency', currency: 'JPY' })
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(2);
	});

	it('keeps two different reasons apart', () => {
		expect.assertions(3);

		const groups = groupInvalidRows([
			row(2, badDate('01.06.2026')),
			row(3, { code: 'invalid-amount', column: 'amount' }),
			row(4, badDate('03.06.2026'))
		]);

		expect(groups).toHaveLength(2);
		expect(groups[0].count).toBe(2);
		expect(groups[1].count).toBe(1);
	});

	/**
	 * The direction this change is NOT moving in.
	 *
	 * A table of one row per reason is only an improvement while every line is still reachable.
	 * A group that dropped its members would be a smaller screen carrying less, not the same
	 * information in less space, so the sum of the groups is asserted against the input.
	 */
	it('loses no row: the groups sum to what went in', () => {
		expect.assertions(2);

		const input = [
			row(2, badDate('a')),
			row(3, { code: 'invalid-amount', column: 'amount' }),
			row(4, badDate('b')),
			row(5, { code: 'zero-amount', column: 'amount' }),
			row(6, badDate('c'))
		];
		const groups = groupInvalidRows(input);

		expect(groups.reduce((total, g) => total + g.count, 0)).toBe(input.length);
		expect(groups.flatMap((g) => g.rows)).toHaveLength(input.length);
	});

	/**
	 * Same code, two different columns, two groups.
	 *
	 * The heading can print exactly one field name, so a group spanning two of them would label
	 * every row with whichever column happened to come first — a table that names the wrong
	 * column is worse than one that repeats itself, because the user goes and looks at it.
	 *
	 * Same standing as the scope pair above: this is a contract on the function, and no parser
	 * emits two fields under one code in one file today.
	 */
	it('keeps one code apart when it names two different columns', () => {
		expect.assertions(3);

		const groups = groupInvalidRows([
			row(2, { code: 'invalid-amount', column: 'Debit' }, 'Debit'),
			row(3, { code: 'invalid-amount', column: 'Credit' }, 'Credit'),
			row(4, { code: 'invalid-amount', column: 'Debit' }, 'Debit')
		]);

		expect(groups).toHaveLength(2);
		expect(groups[0].count).toBe(2);
		expect(groups[0].head.field).toBe('Debit');
	});

	it('leaves a single refusal as a group of one', () => {
		expect.assertions(2);

		const groups = groupInvalidRows([row(2, badDate('01.06.2026'))]);

		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(1);
	});

	it('returns nothing for nothing', () => {
		expect(groupInvalidRows([])).toEqual([]);
	});

	/**
	 * A header scoped complaint and a row scoped one never merge, EVEN ON THE SAME CODE.
	 *
	 * They differ in what the user can do about them: a header refusal is about the file, a row
	 * refusal about a line in it, and folding them together would report « 3 lignes » for a
	 * problem that has one cause and two consequences.
	 *
	 * **The pair below shares its code deliberately, and that is what makes the assertion say
	 * anything.** An earlier version of this test used two different codes, so it passed with the
	 * scope dropped from the key entirely — measured: that break left all seven green. Two
	 * different codes were never going to merge whatever the scope did.
	 *
	 * Stated plainly rather than implied: **no parser emits this pair today.** `invalid-date` is
	 * row scoped everywhere and the header scoped codes are their own set. This is a contract on
	 * the function, which takes whatever `buildInvalidRowDetails` hands it, not a reproduction of
	 * a state the app currently reaches.
	 */
	it('keeps a header complaint out of a row group carrying the same code', () => {
		expect.assertions(3);

		const header: ImportInvalidRowDetail = {
			key: -1,
			scope: { kind: 'header' },
			fact: badDate('en-tête'),
			profile: 'generic',
			preview: ''
		};
		const groups = groupInvalidRows([header, row(2, badDate('a')), row(3, badDate('b'))]);

		expect(groups).toHaveLength(2);
		expect(groups[0].rows[0].scope).toEqual({ kind: 'header' });
		expect(groups[1].count).toBe(2);
	});
});
