import { describe, expect, it } from 'vitest';
import {
	normalizeRecurringLabel,
	normalizeStoredRecurringLabel,
	STORED_LABEL_MAX_CHARS,
	truncateStoredLabel
} from './recurrence';

describe('truncateStoredLabel', () => {
	it('laisse intact un libellé à la borne exacte', () => {
		const label = 'a'.repeat(STORED_LABEL_MAX_CHARS);

		expect(truncateStoredLabel(label)).toBe(label);
	});

	it('tronque un libellé d’un caractère de trop', () => {
		expect(truncateStoredLabel('a'.repeat(STORED_LABEL_MAX_CHARS + 1))).toBe(
			'a'.repeat(STORED_LABEL_MAX_CHARS)
		);
	});

	/**
	 * The bound counts UTF-16 code units, not code points. MySQL's `varchar(191)` counts code
	 * points, so a code-point cap would look "more correct" — but the backup validator bounds the
	 * same column with zod's `.max(191)`, which counts code units, so 191 astral characters
	 * (`.length` 382) would be written happily and then refused on the way back in. The UTF-16
	 * bound is the stricter of the two and satisfies both.
	 */
	it('borne en unités UTF-16, ce que le validateur de sauvegarde compte aussi', () => {
		const astral = '🙂'.repeat(STORED_LABEL_MAX_CHARS);
		expect(astral.length).toBe(STORED_LABEL_MAX_CHARS * 2);

		expect(truncateStoredLabel(astral).length).toBeLessThanOrEqual(STORED_LABEL_MAX_CHARS);
	});

	/** A cut landing inside a surrogate pair would leave a lone high surrogate: a malformed string. */
	it('ne coupe jamais au milieu d’une paire de surrogates', () => {
		// 190 BMP characters then an emoji, so a naive slice at 191 lands inside the pair.
		const label = `${'a'.repeat(STORED_LABEL_MAX_CHARS - 1)}🙂`;
		const truncated = truncateStoredLabel(label);

		expect(truncated).toHaveLength(STORED_LABEL_MAX_CHARS - 1);
		expect(truncated).toBe(truncated.toWellFormed());
		expect(label.slice(0, STORED_LABEL_MAX_CHARS)).not.toBe(
			label.slice(0, STORED_LABEL_MAX_CHARS).toWellFormed()
		);
	});
});

describe('normalizeStoredRecurringLabel', () => {
	it('normalise la forme TRONQUÉE, pas le libellé complet', () => {
		const label = `Assurance habitation ${'x'.repeat(200)}`;

		expect(normalizeStoredRecurringLabel(label)).toBe(
			normalizeRecurringLabel(truncateStoredLabel(label))
		);
		// The two genuinely differ past the bound — which is the whole reason both sides of the
		// stream-identity fallback have to call this one.
		expect(normalizeStoredRecurringLabel(label)).not.toBe(normalizeRecurringLabel(label));
	});

	it('coïncide avec normalizeRecurringLabel en deçà de la borne', () => {
		expect(normalizeStoredRecurringLabel('CB ABONNEMENT NETFLIX 0712')).toBe(
			normalizeRecurringLabel('CB ABONNEMENT NETFLIX 0712')
		);
	});
});
