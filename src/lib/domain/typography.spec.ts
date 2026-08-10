import { describe, expect, it } from 'vitest';
import { formatPercent, labelledValue } from './typography';

/**
 * These assertions are ABSOLUTE per locale, never a comparison between the two, and that is the
 * point. « fr differs from en » would pass in a world where both render English spacing, which
 * is exactly the world this module was written to leave — see CLAUDE.md on comparative
 * assertions hiding a missing environment.
 *
 * The French separator is asserted as an ESCAPE, `\u00a0`, and the codepoint was read out of
 * the runtime rather than assumed: this Node's ICU emits U+00A0 NO-BREAK SPACE for `fr`
 * percentages, not the U+202F narrow one that the typographic rule is usually quoted as. The
 * first draft of this file asserted U+202F on that assumption and went red, which is the whole
 * argument for routing percentages through `Intl` instead of concatenating a space: the exact
 * character is not something to know, it is something to ask.
 *
 * Escapes rather than the literal characters, because U+00A0 and U+0020 are indistinguishable in
 * a diff and a future change from one to the other would otherwise read as no change at all.
 */
describe('formatPercent', () => {
	it('appends no space in English', () => {
		expect(formatPercent(86, 'en')).toBe('86%');
	});

	it('uses a narrow no-break space in French', () => {
		expect(formatPercent(86, 'fr')).toBe('86\u00a0%');
	});

	it('rounds to a whole percent', () => {
		expect(formatPercent(37.4, 'en')).toBe('37%');
	});

	it('takes a percentage, not a fraction', () => {
		expect(formatPercent(100, 'en')).toBe('100%');
	});
});

describe('labelledValue', () => {
	it('puts no space before the colon in English', () => {
		expect(labelledValue('Estimated balance on Aug 31', '€3,456.01', 'en')).toBe(
			'Estimated balance on Aug 31: €3,456.01'
		);
	});

	it('puts a space before the colon in French', () => {
		expect(labelledValue('Solde estimé au 31 août', '3 456,01 €', 'fr')).toBe(
			'Solde estimé au 31 août : 3 456,01 €'
		);
	});

	it('resolves a regional tag by its base language', () => {
		expect(labelledValue('A', 'B', 'fr-CA')).toBe('A : B');
		expect(labelledValue('A', 'B', 'en-GB')).toBe('A: B');
	});

	/**
	 * The failure mode a missing locale entry produces, pinned so it is a known default rather
	 * than a surprise: an unlisted locale gets English spacing, which looks deliberate on screen
	 * and is the reason adding a locale means revisiting this file.
	 */
	it('falls back to no space for a locale it does not know', () => {
		expect(labelledValue('A', 'B', 'de')).toBe('A: B');
	});
});
