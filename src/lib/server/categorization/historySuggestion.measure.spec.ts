import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMatchingCategoryRule } from './rules';
import { displayNameForDefaultRule, loadDefaultRuleCatalog } from './default-rules/catalog';
import {
	HISTORY_SUGGESTION_FLOOR,
	buildHistoryIndex,
	suggestFromHistory,
	type HistoryIndex
} from '$lib/domain/historySuggestion';

/**
 * # Measuring category suggestions on #1012's sets, month by month (#1014's first step)
 *
 * Month n is suggested from months before n only, never a random split, so no row is ever
 * suggested from its own future. The simulated member filed every earlier row to its gold
 * category, which makes the history figure an UPPER BOUND: a real member's history is partial.
 *
 * « Seen » means the merchant appeared in an earlier month. The merchant is defined HERE, from
 * the generator's format (the label minus its ` dd/mm` card suffix), and not by the production
 * key, so the split does not share a source with the code it measures.
 *
 * Each run refuses on zero rows read and carries a planted row whose answer is known, checked in
 * the same run. Figures are written to a file whose path is printed, because a reporter can
 * swallow console output.
 */

const GENERATOR = fileURLToPath(
	new URL('../../../../scripts/synthetic/make-categorization-sets.mjs', import.meta.url)
);

type Row = { date: string; label: string; expected: string };
type Stage = 'rules' | 'history';
type Cell = { rows: number; suggested: number; correct: number };
type Figures = Record<'seen' | 'unseen', Cell>;

const rules = loadDefaultRuleCatalog().map((entry) => ({
	name: displayNameForDefaultRule(entry),
	matchText: entry.match,
	targetCategory: entry.targetCategoryKey,
	isRegex: entry.isRegex,
	enabled: true
}));

const merchantOf = (label: string) => label.replace(/ \d{2}\/\d{2}$/, '');

function readSet(dir: string, name: string): Row[] {
	const [header, ...lines] = readFileSync(join(dir, name), 'utf8').trimEnd().split('\n');
	expect(header).toBe('date;label;amount;expected_category');
	return lines.map((line) => {
		const [date, label, , expected] = line.split(';');
		return { date, label, expected };
	});
}

function suggest(stages: Stage[], row: Row, history: HistoryIndex): string | null {
	for (const stage of stages) {
		if (stage === 'rules') {
			const rule = findMatchingCategoryRule({ label: row.label, manualCategory: null }, rules);
			if (rule) return rule.targetCategory;
		}
		if (stage === 'history') {
			const answer = suggestFromHistory(history, row.label);
			if (answer) return answer;
		}
	}
	return null;
}

function measure(rows: Row[], stages: Stage[]): Figures {
	if (rows.length === 0) throw new Error('measurement read zero rows');
	const figures: Figures = {
		seen: { rows: 0, suggested: 0, correct: 0 },
		unseen: { rows: 0, suggested: 0, correct: 0 }
	};
	const seenBefore = new Set<string>();
	const filed: Array<{ label: string; category: string; date: Date }> = [];
	const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
	for (const month of months) {
		const current = rows.filter((r) => r.date.startsWith(month));
		const history = buildHistoryIndex(filed);
		for (const row of current) {
			const cell = figures[seenBefore.has(merchantOf(row.label)) ? 'seen' : 'unseen'];
			cell.rows++;
			const answer = suggest(stages, row, history);
			if (answer === null) continue;
			cell.suggested++;
			if (answer === row.expected) cell.correct++;
		}
		for (const row of current) {
			seenBefore.add(merchantOf(row.label));
			filed.push({ label: row.label, category: row.expected, date: new Date(row.date) });
		}
	}
	return figures;
}

const ratio = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 10000) / 10000);
const report = (f: Figures) =>
	Object.fromEntries(
		(['seen', 'unseen'] as const).map((k) => [
			k,
			{
				...f[k],
				coverage: ratio(f[k].suggested, f[k].rows),
				precision: ratio(f[k].correct, f[k].suggested)
			}
		])
	);

describe('category suggestions measured on the synthetic sets (#1014)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'bp-1014-'));
	execFileSync(process.execPath, [GENERATOR, dir], { stdio: 'pipe' });
	const brands = readSet(dir, 'catalogue-brands.csv');
	const invented = readSet(dir, 'invented-merchants.csv');

	it('refuses a run that reads zero rows', () => {
		expect(() => measure([], ['rules'])).toThrow('zero rows');
	});

	it('prints the rules-alone baseline, with a planted row answered in the same run', () => {
		const planted: Row = { date: '2026-06-30', label: 'CB CARREFOUR 30/06', expected: 'food' };
		const plantedFigures = measure([planted], ['rules']);
		expect(plantedFigures.unseen).toEqual({ rows: 1, suggested: 1, correct: 1 });

		const out = {
			brands: { rows: brands.length, rules: report(measure(brands, ['rules'])) },
			invented: { rows: invented.length, rules: report(measure(invented, ['rules'])) }
		};
		const file = join(dir, 'figures.json');
		writeFileSync(file, JSON.stringify(out, null, 2));
		console.log(`#1014 figures: ${file}\n${JSON.stringify(out, null, 2)}`);
		expect(out.brands.rows).toBeGreaterThan(0);
		expect(out.invented.rows).toBeGreaterThan(0);
	});

	// The gate #1014 names: a suggestion is shown only where its measured precision reaches 0.90.
	// Read per set and per kind, because a pooled figure lets one set's ceiling hide the other's.
	it('history, after rules and alone, reaches the floor on seen merchants of both sets', () => {
		const planted: Row[] = [
			{ date: '2026-01-05', label: 'CB PLANTED ROW 05/01', expected: 'other' },
			{ date: '2026-02-05', label: 'CB PLANTED ROW 05/02', expected: 'other' }
		];
		expect(measure(planted, ['history']).seen).toEqual({ rows: 1, suggested: 1, correct: 1 });

		const out = {
			brands: {
				history: report(measure(brands, ['history'])),
				cascade: report(measure(brands, ['rules', 'history']))
			},
			invented: {
				history: report(measure(invented, ['history'])),
				cascade: report(measure(invented, ['rules', 'history']))
			}
		};
		const file = join(dir, 'figures-history.json');
		writeFileSync(file, JSON.stringify(out, null, 2));
		console.log(`#1014 figures: ${file}`);
		for (const set of [out.brands, out.invented]) {
			for (const stage of [set.history, set.cascade]) {
				expect(stage.seen.suggested).toBeGreaterThan(0);
				expect(stage.seen.precision).toBeGreaterThanOrEqual(HISTORY_SUGGESTION_FLOOR);
			}
		}
	});
});
