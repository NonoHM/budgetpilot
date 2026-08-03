import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `paraglide-js compile` compiles an INCOMPLETE catalogue without a single warning — measured,
 * not assumed. A key missing from a non-base locale's catalogue silently falls back to the base
 * locale at runtime, so a translator gap ships as a page in the wrong language with nothing red
 * anywhere. The other direction is just as real now that `baseLocale` is `en` while French is
 * the language this app is written in first: a key present in a NON-base catalogue but absent
 * from `en.json` compiles to the raw
 * bundle id as the rendered string (measured: `login_email_label` rendered literally, not
 * "Email"). `messages/fr.json` and `messages/en.json` are level at 1151 keys today by discipline
 * alone — nothing in the toolchain enforces it. This is that enforcement.
 *
 * The locale list is read from `project.inlang/settings.json` rather than hardcoded, so a third
 * locale added later is covered automatically instead of needing this file edited too.
 */

const SETTINGS_PATH = 'project.inlang/settings.json';

// Metadata, not a translatable message: every catalogue carries it and it is expected to be
// identical across locales, but it is not a `paraglide` message id and must not be compared as
// one.
const IGNORED_KEYS = new Set(['$schema']);

const MAX_LISTED_KEYS = 20;

function readSettings(): { locales: string[]; pathPattern: string } {
	const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
	const locales = raw.locales;
	const pathPattern = raw['plugin.inlang.messageFormat']?.pathPattern;
	if (!Array.isArray(locales) || locales.length === 0) {
		throw new Error(`${SETTINGS_PATH} has no usable "locales" array`);
	}
	if (typeof pathPattern !== 'string' || !pathPattern.includes('{locale}')) {
		throw new Error(`${SETTINGS_PATH} has no usable message-format pathPattern`);
	}
	return { locales, pathPattern };
}

function catalogueKeys(pathPattern: string, locale: string): Set<string> {
	const path = pathPattern.replace('{locale}', locale).replace(/^\.\//, '');
	const raw = JSON.parse(readFileSync(path, 'utf8'));
	return new Set(Object.keys(raw).filter((key) => !IGNORED_KEYS.has(key)));
}

function formatKeyList(keys: string[]): string {
	if (keys.length <= MAX_LISTED_KEYS) return keys.join(', ');
	const shown = keys.slice(0, MAX_LISTED_KEYS);
	return `${shown.join(', ')}, and ${keys.length - MAX_LISTED_KEYS} more`;
}

describe('locale catalogue parity', () => {
	const { locales, pathPattern } = readSettings();

	it('finds at least two locales to compare', () => {
		// Guards the input itself: if `settings.json` ever regressed to a single locale, every
		// pairwise assertion below would vacuously pass with nothing compared.
		expect(locales.length).toBeGreaterThanOrEqual(2);
	});

	const catalogues = new Map(locales.map((locale) => [locale, catalogueKeys(pathPattern, locale)]));

	it.each(locales)('%s catalogue is non-trivially large', (locale) => {
		// Guards against a catalogue read that silently resolves to an empty object (wrong path,
		// truncated file): every pairwise diff below would otherwise also pass vacuously.
		expect(catalogues.get(locale)!.size).toBeGreaterThan(100);
	});

	// Every pair, both directions — deliberately not special-cased to two locales, so this keeps
	// working the day a third one is added.
	const pairs: Array<[string, string]> = [];
	for (const a of locales) {
		for (const b of locales) {
			if (a !== b) pairs.push([a, b]);
		}
	}

	it.each(pairs)('every key in %s exists in %s', (from, to) => {
		const fromKeys = catalogues.get(from)!;
		const toKeys = catalogues.get(to)!;
		const missing = [...fromKeys].filter((key) => !toKeys.has(key)).sort();

		expect(
			missing,
			`${missing.length} key(s) present in "${from}" but missing from "${to}": ` +
				formatKeyList(missing)
		).toEqual([]);
	});
});
