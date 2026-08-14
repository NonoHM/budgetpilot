import { describe, expect, it } from 'vitest';
import {
	buildDeduplicationGroupKey,
	buildDeduplicationKey,
	refusalCellValue,
	sanitizeImportedText
} from './safety';

/**
 * `refusalCellValue` exists because a refusal fact travels to the browser.
 *
 * Every other sanitised value in the import path stays on the server or is written to a column,
 * where an unbounded length is somebody else's problem. A fact is serialised into the page's
 * data on every failed import, so a cell the user controls reaches the client verbatim unless
 * something bounds it. `sanitizeImportedText` does not: it normalises and neutralises, and
 * returns whatever length it was given.
 */

const LIMIT = 64;

describe('refusalCellValue', () => {
	it('leaves a short value exactly as sanitizeImportedText would', () => {
		// The presence half. Without it, the bound assertions below would pass on a function
		// that returned the empty string for everything.
		expect(refusalCellValue('depense')).toBe('depense');
		expect(refusalCellValue('  EUR  ')).toBe('EUR');
		expect(refusalCellValue('depense')).toBe(sanitizeImportedText('depense'));
	});

	it('bounds a long value, and the input it bounds is one a CSV can really carry', () => {
		// 250000 is the order of a single cell under IMPORT_MAX_BYTES (256000). This is the
		// figure the bound exists for, not a token long string.
		const hostile = 'A'.repeat(250_000);

		const bounded = refusalCellValue(hostile);

		expect(hostile).toHaveLength(250_000);
		expect(bounded.length).toBeLessThanOrEqual(LIMIT + 3);
		expect(bounded.startsWith('A'.repeat(LIMIT))).toBe(true);
		expect(bounded.endsWith('...')).toBe(true);
	});

	it('still neutralises a formula before bounding, so truncation cannot hide the guard', () => {
		// Order matters: bounding first could cut a value down to something the dangerous
		// pattern no longer matches, and the quote would never be added.
		expect(refusalCellValue('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
		expect(refusalCellValue(`=${'9'.repeat(200)}`).startsWith("'=")).toBe(true);
	});

	it('collapses whitespace, so a cell of newlines cannot pad the payload', () => {
		expect(refusalCellValue('a\n\n\n\n\nb')).toBe('a b');
	});
});

describe('buildDeduplicationGroupKey and buildDeduplicationKey', () => {
	const base = {
		date: '2026-06-24',
		label: 'CARREFOUR  MARKET',
		amountCents: -2490,
		type: 'expense' as const
	};

	it('folds the label and takes the magnitude, so the group key is what collides', () => {
		expect(buildDeduplicationGroupKey(base)).toBe('2026-06-24|carrefour market|2490|expense');
	});

	it('takes the same group key whichever sign the caller passes', () => {
		// The direction lives in `type`. A caller passing a signed amount and one passing a
		// magnitude must not produce two keys for one transaction, which is what happened while
		// each profile applied Math.abs at its own call site.
		expect(buildDeduplicationGroupKey({ ...base, amountCents: 2490, type: 'income' })).toBe(
			'2026-06-24|carrefour market|2490|income'
		);
	});

	it('appends the occurrence and the account scope to the group key, in that order', () => {
		expect(buildDeduplicationKey({ ...base, occurrence: 0 })).toBe(
			'2026-06-24|carrefour market|2490|expense|0|'
		);
	});

	it('cannot disagree with its own group key', () => {
		// The whole reason the group key is exported rather than recomputed at each call site:
		// the ordinal is assigned over one string and the final key is built from another, and
		// two copies of that expression are where they quietly stop agreeing.
		const key = buildDeduplicationKey({ ...base, occurrence: 2 });
		expect(key.startsWith(`${buildDeduplicationGroupKey(base)}|`)).toBe(true);
	});

	it('separates two otherwise identical rows by their occurrence', () => {
		expect(buildDeduplicationKey({ ...base, occurrence: 0 })).not.toBe(
			buildDeduplicationKey({ ...base, occurrence: 1 })
		);
	});

	it('still separates two accounts holding the same transaction', () => {
		expect(
			buildDeduplicationKey({ ...base, occurrence: 0, accountScope: 'enablebanking:a' })
		).not.toBe(buildDeduplicationKey({ ...base, occurrence: 0, accountScope: 'enablebanking:b' }));
	});

	it('carries exactly six fields, so nothing optional can widen it', () => {
		// The absolute figure. `category` and `reference` used to occupy the fifth slot depending
		// on the profile, which made the key depend on which columns a file happened to carry:
		// a file with a reference this month and none next month produced two keys for one
		// transaction, and correcting a column mapping would have rewritten every key a user has.
		expect(buildDeduplicationKey({ ...base, occurrence: 0 }).split('|')).toHaveLength(6);
	});
});
