import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMatchingCategoryRule } from './rules';
import { displayNameForDefaultRule, loadDefaultRuleCatalog } from './default-rules/catalog';

/**
 * # The two categorization sets of #1012, asserted against the production matcher.
 *
 * The sets exist to MEASURE category suggestions, so a set whose gold labels disagree with what
 * it claims is a measurement of the generator. Two claims are checked here, each through the
 * code that will consume the set rather than a restatement of it:
 *
 * - **Catalogue brands**: every label is categorized by the shipped catalogue, in its seeding
 *   order, to the row's expected category. Separates a brand set that reaches the rules stage
 *   from one whose labels the rules never see (or see as another brand).
 * - **Invented merchants**: no label matches any catalogue rule. Separates « a merchant nobody
 *   has seen » from a name that a rule (and so, plausibly, a model's memory) already knows.
 *
 * Determinism is asserted as two runs writing identical bytes, which is what lets a figure
 * quoted against the set be re-derived.
 */

const GENERATOR = fileURLToPath(
	new URL('../../../../scripts/synthetic/make-categorization-sets.mjs', import.meta.url)
);

const SECOND_YEAR = '2025-07';

type Row = { date: string; label: string; amount: string; expected: string };

function generate(): string {
	const dir = mkdtempSync(join(tmpdir(), 'bp-catsets-'));
	execFileSync(process.execPath, [GENERATOR, dir], { stdio: 'pipe' });
	return dir;
}

function read(dir: string, name: string): { bytes: string; rows: Row[] } {
	const bytes = readFileSync(join(dir, name), 'utf8');
	const [header, ...lines] = bytes.trimEnd().split('\n');
	expect(header).toBe('date;label;amount;expected_category');
	const rows = lines.map((line) => {
		const [date, label, amount, expected] = line.split(';');
		return { date, label, amount, expected };
	});
	return { bytes, rows };
}

const rules = loadDefaultRuleCatalog().map((entry) => ({
	name: displayNameForDefaultRule(entry),
	matchText: entry.match,
	targetCategory: entry.targetCategoryKey,
	isRegex: entry.isRegex,
	enabled: true
}));

let first: string;
let second: string;

beforeAll(() => {
	first = generate();
	second = generate();
}, 30_000);

describe.each(['catalogue-brands.csv', 'invented-merchants.csv'])('%s', (name) => {
	it('is byte-identical across two runs', () => {
		expect(read(first, name).bytes).toBe(read(second, name).bytes);
	});

	it('spans 24 months', () => {
		const { rows } = read(first, name);
		expect(new Set(rows.map((r) => r.date.slice(0, 7))).size).toBe(24);
		expect(rows.length).toBeGreaterThanOrEqual(1500);
	});

	// A history stage is measured per category on merchants it has met AND ones it has not, so
	// every category with two merchants or more carries both: one seen in both years, one first
	// seen in the second. Separates a set that can report the seen/unseen split per category from
	// one where a category is all seen (the income of the first draft, 2 merchants, 0 late).
	it('carries, per category, a merchant seen in both years and one new in the second', () => {
		const { rows } = read(first, name);
		const years = new Map<string, Set<boolean>>();
		for (const r of rows) {
			const key = r.expected + '|' + merchantOf(r.label);
			if (!years.has(key)) years.set(key, new Set());
			years.get(key)!.add(r.date >= SECOND_YEAR);
		}
		const byCategory = Map.groupBy([...years], ([key]) => key.split('|')[0]);
		const judged = [...byCategory].filter(([, merchants]) => merchants.length >= 2);
		// Every category of both sets has two merchants or more; a key function that collapsed
		// merchants would otherwise empty `judged` and leave `lacking` vacuously empty.
		expect(judged.length).toBe(13);
		const lacking = judged.flatMap(([category, merchants]) => {
			const both = merchants.filter(([, y]) => y.size === 2).length;
			const late = merchants.filter(([, y]) => y.size === 1 && y.has(true)).length;
			return [
				both ? [] : [`${category}: none seen in both years`],
				late ? [] : [`${category}: none new in year two`]
			].flat();
		});
		expect(lacking).toEqual([]);
	});
});

describe('catalogue brands', () => {
	it('is categorized by the shipped catalogue to every row’s expected category', () => {
		const { rows } = read(first, 'catalogue-brands.csv');
		const wrong = rows.filter(
			(r) => findMatchingCategoryRule({ label: r.label }, rules)?.targetCategory !== r.expected
		);
		expect(rows.length).toBeGreaterThan(0);
		expect(wrong.map((r) => `${r.label} -> ${r.expected}`)).toEqual([]);
	});

	it('uses every catalogue rule at least once', () => {
		const { rows } = read(first, 'catalogue-brands.csv');
		const hit = new Set(rows.map((r) => findMatchingCategoryRule({ label: r.label }, rules)?.name));
		expect(rules.filter((rule) => !hit.has(rule.name)).map((rule) => rule.name)).toEqual([]);
	});
});

describe('invented merchants', () => {
	it('carries no label that any catalogue rule matches', () => {
		const { rows } = read(first, 'invented-merchants.csv');
		const known = rows.filter((r) => findMatchingCategoryRule({ label: r.label }, rules));
		expect(rows.length).toBeGreaterThan(0);
		expect(known.map((r) => r.label)).toEqual([]);
	});
});

/** The merchant part of a generated label: the operation prefix and a trailing date dropped. */
function merchantOf(label: string): string {
	return label
		.replace(/^(CB|PRLV SEPA|VIR SEPA)\s+/, '')
		.replace(/\s+\d{2}\/\d{2}$/, '')
		.trim();
}
