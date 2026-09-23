import { describe, expect, it } from 'vitest';
import {
	CSV_RESOURCE_CEILING_MULTIPLE,
	resolveCsvColumnResourceCeiling,
	resolveCsvCellResourceCeiling,
	exceedsCsvResourceCeiling
} from './resourceBounds';
import { CSV_DEFAULT_MAX_COLUMNS, CSV_MAX_COLUMNS_CEILING } from './columnBounds';
import { CSV_MAX_ROWS } from './csv';

/**
 * THE ORDERING INVARIANT.
 *
 * The product limit and the resource ceiling are two different rules, not one rule with two
 * sentences. The product limit is user-facing and actionable; the ceiling exists so the oversized
 * array is never allocated and no real file reaches it. What they share is an ORDER: the ceiling
 * must sit strictly above the limit, or the ceiling starts refusing files the product says are
 * legal and the user meets the wrong sentence.
 *
 * This separates "the ceiling is above the limit" from "someone tuned one of the two numbers and
 * inverted them without noticing", which is the only way this can break and the reason the
 * assertion is a test rather than a comment.
 */
describe('the resource ceiling sits strictly above the product limit', () => {
	it('holds at the default column configuration', () => {
		expect(resolveCsvColumnResourceCeiling()).toBeGreaterThan(CSV_DEFAULT_MAX_COLUMNS);
		expect(resolveCsvCellResourceCeiling()).toBeGreaterThan(CSV_DEFAULT_MAX_COLUMNS * CSV_MAX_ROWS);
	});

	it('holds at the highest column count an operator may configure', () => {
		const previous = process.env.CSV_MAX_COLUMNS;
		process.env.CSV_MAX_COLUMNS = String(CSV_MAX_COLUMNS_CEILING);
		try {
			expect(resolveCsvColumnResourceCeiling()).toBeGreaterThan(CSV_MAX_COLUMNS_CEILING);
			expect(resolveCsvCellResourceCeiling()).toBeGreaterThan(
				CSV_MAX_COLUMNS_CEILING * CSV_MAX_ROWS
			);
		} finally {
			if (previous === undefined) delete process.env.CSV_MAX_COLUMNS;
			else process.env.CSV_MAX_COLUMNS = previous;
		}
	});

	it('holds at the lowest column count an operator may configure', () => {
		const previous = process.env.CSV_MAX_COLUMNS;
		process.env.CSV_MAX_COLUMNS = '1';
		try {
			expect(resolveCsvColumnResourceCeiling()).toBeGreaterThan(1);
			expect(resolveCsvCellResourceCeiling()).toBeGreaterThan(1 * CSV_MAX_ROWS);
		} finally {
			if (previous === undefined) delete process.env.CSV_MAX_COLUMNS;
			else process.env.CSV_MAX_COLUMNS = previous;
		}
	});

	// The multiple is what makes the ordering true BY CONSTRUCTION rather than by choosing two
	// numbers that happen to be ordered. A multiple of 1 or less would invert the rule silently.
	it('is built from a multiple greater than one, so the ordering cannot be configured away', () => {
		expect(CSV_RESOURCE_CEILING_MULTIPLE).toBeGreaterThan(1);
	});
});

/**
 * Separates "a file is over the ceiling" from "a file is merely over the product limit". The
 * second must NOT trip the ceiling: that is the whole point of the two being different rules.
 */
describe('exceedsCsvResourceCeiling', () => {
	it('says nothing about an ordinary statement', () => {
		expect(exceedsCsvResourceCeiling({ columns: 40, rows: 1000 })).toBe(false);
	});

	it('says nothing about a file that is over the PRODUCT limit but under the ceiling', () => {
		// Refused later by the parser cap, with the friendly sentence. Not the ceiling's business.
		expect(exceedsCsvResourceCeiling({ columns: CSV_DEFAULT_MAX_COLUMNS + 1, rows: 2000 })).toBe(
			false
		);
	});

	it('refuses the measured attack shape on its cell count', () => {
		expect(exceedsCsvResourceCeiling({ columns: 3000, rows: 100_000 })).toBe(true);
	});

	it('refuses a file whose column count alone is past the ceiling', () => {
		// The quadratic term is driven by columns, so columns are bounded on their own and not
		// only through the product.
		expect(exceedsCsvResourceCeiling({ columns: 60_000, rows: 4 })).toBe(true);
	});
});
