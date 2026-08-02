import { describe, it, expect } from 'vitest';
import {
	TAG_COLOR_TOKENS,
	isTagColorToken,
	pickTagColorToken,
	normalizeTagName,
	MAX_TAG_NAME_LENGTH,
	MAX_TAGS_PER_TRANSACTION
} from './tags';
import { TAG_COLORS, TAG_TINT_COLORS, tagColorBgClass, tagTintBgClass } from './colors';

describe('tag colour tokens', () => {
	it('exposes exactly 9 distinct tokens', () => {
		expect(TAG_COLOR_TOKENS).toHaveLength(9);
		expect(new Set(TAG_COLOR_TOKENS).size).toBe(9);
	});

	it('maps every token to a distinct dot hex and a static background class', () => {
		const hexes = TAG_COLOR_TOKENS.map((token) => TAG_COLORS[token]);
		expect(new Set(hexes).size).toBe(TAG_COLOR_TOKENS.length);
		for (const token of TAG_COLOR_TOKENS) {
			expect(tagColorBgClass(token)).toBe(`bg-[${TAG_COLORS[token]}]`);
		}
	});

	it('maps every token to a distinct tint hex and a static background class', () => {
		const hexes = TAG_COLOR_TOKENS.map((token) => TAG_TINT_COLORS[token]);
		expect(new Set(hexes).size).toBe(TAG_COLOR_TOKENS.length);
		for (const token of TAG_COLOR_TOKENS) {
			expect(tagTintBgClass(token)).toBe(`bg-[${TAG_TINT_COLORS[token]}]`);
		}
	});

	it('accepts only real tokens', () => {
		expect(isTagColorToken('tag-1')).toBe(true);
		expect(isTagColorToken('tag-9')).toBe(true);
		expect(isTagColorToken('tag-10')).toBe(false);
		expect(isTagColorToken('#ff0000')).toBe(false);
		expect(isTagColorToken(null)).toBe(false);
		expect(isTagColorToken(3)).toBe(false);
	});

	it('assigns a token deterministically from the name key', () => {
		const first = pickTagColorToken('abc123');
		expect(pickTagColorToken('abc123')).toBe(first);
		expect(TAG_COLOR_TOKENS).toContain(first);
	});

	it('spreads across the palette rather than collapsing onto one token', () => {
		const seen = new Set(Array.from({ length: 200 }, (_, i) => pickTagColorToken(`key-${i}`)));
		expect(seen.size).toBeGreaterThan(1);
	});
});

describe('normalizeTagName', () => {
	it('trims surrounding whitespace', () => {
		expect(normalizeTagName('  Vacances  ')).toBe('Vacances');
	});

	it('collapses internal whitespace runs to a single space', () => {
		expect(normalizeTagName('Vacances   Portugal')).toBe('Vacances Portugal');
	});

	it('truncates at the maximum length', () => {
		expect(normalizeTagName('a'.repeat(200))).toHaveLength(MAX_TAG_NAME_LENGTH);
	});

	it('strips zero-width and control characters, which whitespace collapsing cannot see', () => {
		// A zero-width space is not matched by \s, so "Portu<ZWSP>gal" and "Portugal" would be two
		// tags whose difference nobody can see. That is precisely the failure the whitespace
		// collapse above exists to prevent, so the same rule has to cover this class too.
		expect(normalizeTagName('Portu\u200Bgal')).toBe('Portugal');
		expect(normalizeTagName('Portugal\u0007')).toBe('Portugal');
	});

	it('strips bidi overrides, which can spoof a name in a destructive confirmation', () => {
		// U+202E reverses rendering, so a tag can be made to display as a different name than the
		// one stored. The delete confirmation names the tag being destroyed, so a spoofable label
		// there is a real hazard rather than a cosmetic one.
		expect(normalizeTagName('Portugal\u202E')).toBe('Portugal');
	});

	it('returns an empty string for whitespace-only input', () => {
		expect(normalizeTagName('   ')).toBe('');
	});
});

describe('caps', () => {
	it('bounds a tag name at 60, matching MAX_MANUAL_CATEGORY_LENGTH', () => {
		expect(MAX_TAG_NAME_LENGTH).toBe(60);
	});

	it('bounds tags per transaction at 10', () => {
		expect(MAX_TAGS_PER_TRANSACTION).toBe(10);
	});
});

/**
 * WCAG relative luminance and contrast ratio, per the definitions in WCAG 2.1 (1.4.3 / 1.4.11).
 * Written out here rather than imported so the check has no dependency that could change under it.
 */
function relativeLuminance(hex: string): number {
	const channels = [1, 3, 5].map((offset) => {
		const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

/**
 * The ratios MEASURED in the Claude Design deliverable, one row per token, recorded rather than
 * recomputed against a target.
 *
 * The difference matters. A test asserting "every token clears 4.5:1" stays green while a token
 * drifts from 4.71 to 4.52, which is exactly the drift that would go unnoticed. Asserting the
 * measured number means ANY change to a hex goes red and has to be re-approved against the design.
 *
 * `zinc100` is the darkest surface a chip renders against and `tint` is its own tinted background,
 * so those two are the binding pair. `tint` is a text ratio (the name is written in the dot colour
 * on the tint) and must clear 4.5:1; `zinc100` is a non-text ratio (the 8px dot) and must clear 3:1.
 */
const MEASURED_CONTRAST: Record<
	string,
	{ white: number; zinc50: number; zinc100: number; tint: number }
> = {
	'tag-1': { white: 5.96, zinc50: 5.71, zinc100: 5.42, tint: 5.34 },
	'tag-2': { white: 5.89, zinc50: 5.65, zinc100: 5.36, tint: 5.29 },
	'tag-3': { white: 5.58, zinc50: 5.34, zinc100: 5.07, tint: 5.1 },
	'tag-4': { white: 5.13, zinc50: 4.91, zinc100: 4.67, tint: 4.71 },
	'tag-5': { white: 5.23, zinc50: 5.01, zinc100: 4.76, tint: 4.81 },
	'tag-6': { white: 5.62, zinc50: 5.39, zinc100: 5.11, tint: 5.1 },
	'tag-7': { white: 5.83, zinc50: 5.59, zinc100: 5.31, tint: 5.29 },
	'tag-8': { white: 5.95, zinc50: 5.7, zinc100: 5.42, tint: 5.4 },
	'tag-9': { white: 6.0, zinc50: 5.75, zinc100: 5.46, tint: 5.38 }
};

describe('tag palette accessibility', () => {
	const WHITE = '#ffffff';
	const ZINC_50 = '#fafafa';
	const ZINC_100 = '#f4f4f5';

	it('records a measured row for every token, and no stale row', () => {
		expect(Object.keys(MEASURED_CONTRAST).sort()).toEqual([...TAG_COLOR_TOKENS].sort());
	});

	it.each(TAG_COLOR_TOKENS)('%s still measures what the design measured', (token) => {
		const dot = TAG_COLORS[token];
		const measured = MEASURED_CONTRAST[token];

		expect(contrastRatio(dot, WHITE)).toBeCloseTo(measured.white, 1);
		expect(contrastRatio(dot, ZINC_50)).toBeCloseTo(measured.zinc50, 1);
		expect(contrastRatio(dot, ZINC_100)).toBeCloseTo(measured.zinc100, 1);
		expect(contrastRatio(dot, TAG_TINT_COLORS[token])).toBeCloseTo(measured.tint, 1);
	});

	it.each(TAG_COLOR_TOKENS)('%s clears WCAG AA text contrast (4.5:1) on its own tint', (token) => {
		expect(contrastRatio(TAG_COLORS[token], TAG_TINT_COLORS[token])).toBeGreaterThanOrEqual(4.5);
	});

	it.each(TAG_COLOR_TOKENS)(
		'%s clears WCAG AA non-text contrast (3:1) as a dot on the darkest surface it renders on',
		(token) => {
			expect(contrastRatio(TAG_COLORS[token], ZINC_100)).toBeGreaterThanOrEqual(3);
		}
	);
});
