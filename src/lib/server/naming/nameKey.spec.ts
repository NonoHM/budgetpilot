import { describe, expect, it } from 'vitest';
import { computeNameKey, computeNullableNameKey } from './nameKey';

describe('computeNameKey', () => {
	it('gives the same key to names that differ only by case or accents', () => {
		expect.assertions(3);

		expect(computeNameKey('Courses')).toBe(computeNameKey('courses'));
		expect(computeNameKey('Café')).toBe(computeNameKey('cafe'));
		expect(computeNameKey('Épargne')).toBe(computeNameKey('EPARGNE'));
	});

	it('ignores surrounding whitespace', () => {
		expect.assertions(1);

		expect(computeNameKey('  Loisirs  ')).toBe(computeNameKey('Loisirs'));
	});

	it('gives different keys to names that are genuinely different', () => {
		expect.assertions(2);

		expect(computeNameKey('Courses')).not.toBe(computeNameKey('Course'));
		expect(computeNameKey('Loyer')).not.toBe(computeNameKey('Loisirs'));
	});

	it('is a fixed-length lowercase hex digest whatever the name looks like', () => {
		expect.assertions(3);

		// Fixed width is what keeps the column inside MySQL's default varchar(191) and well
		// under InnoDB's index key limit, however long a category name gets.
		for (const name of ['a', 'x'.repeat(500), '🎉 Vacances ☀️']) {
			expect(computeNameKey(name)).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it('is stable across calls, so a stored key stays valid', () => {
		expect.assertions(1);

		expect(computeNameKey('Alimentation')).toBe(computeNameKey('Alimentation'));
	});

	describe('names that no collation can be trusted to separate', () => {
		it('keeps emoji-only names distinct from one another', () => {
			expect.assertions(2);

			// MySQL's utf8mb4_general_ci maps every character outside the BMP to the same
			// replacement, which makes all emoji one value. Hashing the app-side folded name
			// is what stops two unrelated categories from colliding on such a database.
			expect(computeNameKey('🎉')).not.toBe(computeNameKey('🚀'));
			expect(computeNameKey('🎉🎉')).not.toBe(computeNameKey('🎉'));
		});

		it('keeps an emoji-only name distinct from a text name', () => {
			expect.assertions(1);

			expect(computeNameKey('🎉')).not.toBe(computeNameKey('Fête'));
		});

		it('keeps non-Latin names distinct', () => {
			expect.assertions(2);

			expect(computeNameKey('Спорт')).not.toBe(computeNameKey('Спорты'));
			expect(computeNameKey('食費')).not.toBe(computeNameKey('交通費'));
		});
	});

	describe('names that fold to nothing', () => {
		// Folding strips combining marks, so a name made only of them, or only of
		// whitespace, has an empty folded form. Hashing that empty string alone would give
		// every such name the same key and merge unrelated rows.
		const emptyFolding = ['́', '̈', '́́', '   ', '\t'];

		it('still produces a key for each of them', () => {
			expect.assertions(emptyFolding.length);

			for (const name of emptyFolding) {
				expect(computeNameKey(name)).toMatch(/^[0-9a-f]{64}$/);
			}
		});

		it('keeps them distinct from each other', () => {
			expect.assertions(1);

			const keys = new Set(emptyFolding.map(computeNameKey));
			expect(keys.size).toBe(emptyFolding.length);
		});

		it('keeps them distinct from the empty name', () => {
			expect.assertions(emptyFolding.length);

			for (const name of emptyFolding) {
				expect(computeNameKey(name)).not.toBe(computeNameKey(''));
			}
		});

		it('never collides with a name that folds normally', () => {
			expect.assertions(1);

			// The two branches are domain-separated, so no ordinary name can ever produce the
			// digest of a fallback one.
			const ordinary = ['Courses', 'Café', 'raw:x', 'norm:x', '', ' Loisirs'].map(computeNameKey);
			const fallback = emptyFolding.map(computeNameKey);
			expect(ordinary.some((key) => fallback.includes(key))).toBe(false);
		});
	});
});

describe('computeNullableNameKey', () => {
	it('passes null through, so a null name keeps a null key', () => {
		expect.assertions(1);

		expect(computeNullableNameKey(null)).toBeNull();
	});

	it('matches computeNameKey for any actual name', () => {
		expect.assertions(1);

		expect(computeNullableNameKey('Courses')).toBe(computeNameKey('Courses'));
	});
});
