import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadStandards } from '../../../scripts/standards-citations.mjs';

/**
 * `docs/reference/aisvs-map.md` gives EVERY AISVS 1.0 Level 1 and 2 requirement exactly one verdict
 * from a closed set, and its published counts are the counts of its own rows (#536).
 *
 * WHY A GATE AND NOT A READ. The citation gate (`standardsCitations.spec.ts`) checks that an
 * identifier EXISTS, not that a page is COMPLETE: a map with 140 rows, a wrong level, a requirement
 * text paraphrased to fit a verdict, or a verdict outside the set passes it. A partial map reads
 * exactly like coverage, which is the failure #536 names (« a map that quietly skips the requirements
 * nobody looked at »). And the map's counts are the starting and closing figures of the AI chain
 * (R16 on #841), so a count that drifts from the rows would be a false figure about security.
 *
 * WHAT IS ASSERTED, each separately so one red names its clause:
 * - the product section holds exactly the Level 1 and 2 rows of chapters C1 to C12, and the
 *   development section exactly those of Appendix C plus C9.2.1 applied to development (the owner's
 *   ruling of 2026-10-09 on #841, R17b), each once;
 * - each row's level and quoted requirement text equal the tracked standard's;
 * - each verdict is one of the six (R17a);
 * - each `partly` or `unmet` row names an issue, because R16's zero is « unmet + partly = 0 » and a
 *   deviation with no issue is one nobody will close;
 * - the counts table equals the counts of the rows.
 *
 * THE STANDARD IS READ THROUGH `loadStandards`, the same parse the citation gate and the cite skill
 * use, so the three cannot disagree about which rows exist. The page is parsed HERE, by this file's
 * own reader, so the map and the check of the map do not share a source.
 *
 * CALIBRATED IN THE SAME RUN: the validator is also handed the page with one row removed, one
 * verdict replaced, one issue cleared and one count changed, and must name each.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PAGE = 'docs/reference/aisvs-map.md';
const VERDICTS = ['met', 'partly', 'unmet', 'n/a', 'operator', 'exception'] as const;
type Verdict = (typeof VERDICTS)[number];
const COUNT_HEADER = ['Chapter', ...VERDICTS, 'total'];

/**
 * The exceptions the owner has ruled, per section (#841: R17b for development; none yet for the
 * product). An `exception` anywhere else is a way to lower the AI chain's figure without a ruling,
 * so it is refused here rather than trusted to review.
 */
const RULED_EXCEPTIONS: Record<'product' | 'development', readonly string[]> = {
	product: [],
	development: ['9.2.1', 'AC.4.1', 'AC.8.1']
};

interface Row {
	section: 'product' | 'development';
	id: string;
	level: string;
	text: string;
	verdict: string;
	issue: string;
	/** The chapter of the `###` heading the row sits under, or null for the development section. */
	heading: string | null;
}

interface ParsedPage {
	rows: Row[];
	counts: Map<string, number[]>;
	countHeader: string[] | null;
	duplicateCounts: string[];
	/** Every `C<n>.<n>.<n>` cited in the companion sections, which must be rows of this page. */
	companionIds: string[];
}

/** Splits a markdown table line on unescaped pipes. */
function cells(line: string): string[] {
	return line
		.trim()
		.replace(/^\||\|$/g, '')
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

function parsePage(page: string): ParsedPage {
	const rows: Row[] = [];
	const counts = new Map<string, number[]>();
	let countHeader: string[] | null = null;
	const duplicateCounts: string[] = [];
	const companionIds: string[] = [];
	let section: Row['section'] | null = null;
	let inCounts = false;
	let inCompanions = false;
	let heading: string | null = null;
	for (const line of page.split('\n')) {
		if (line.startsWith('## ')) {
			section = /^## Product rows/.test(line)
				? 'product'
				: /^## Development rows/.test(line)
					? 'development'
					: null;
			inCounts = /^## Counts/.test(line);
			inCompanions = /^## Related references/.test(line);
			heading = null;
			continue;
		}
		const chapter = /^### C(\d+) /.exec(line);
		if (chapter) heading = `C${chapter[1]}`;
		if (inCompanions) {
			for (const m of line.matchAll(/\bC(\d+\.\d+\.\d+)\b/g)) companionIds.push(m[1]);
			continue;
		}
		if (!line.startsWith('|')) continue;
		const c = cells(line);
		if (inCounts && c.length === 8 && !/^-+$/.test(c[1])) {
			if (c[0] === 'Chapter') countHeader = c;
			else if (counts.has(c[0])) duplicateCounts.push(c[0]);
			else counts.set(c[0], c.slice(1).map(Number));
			continue;
		}
		const head = /^AISVS (C(\d+(?:\.\d+)+)|AC\.\d+\.\d+): « (.*) »$/.exec(c[0] ?? '');
		if (!head || !section) continue;
		rows.push({
			section,
			id: head[2] ?? head[1],
			level: c[1],
			text: head[3],
			verdict: c[2],
			issue: c[5] ?? '',
			heading: section === 'product' ? heading : null
		});
	}
	return { rows, counts, countHeader, duplicateCounts, companionIds };
}

function chapterOf(row: Row): string {
	return row.section === 'development' ? 'Development' : `C${row.id.split('.')[0]}`;
}

/** Every defect the page carries, as sentences; empty when the page is complete and consistent. */
function validate(page: string): string[] {
	const standards = loadStandards(ROOT);
	const aisvs = standards.aisvs;
	if (!aisvs) return ['the tracked AISVS copy is missing (#601)'];
	const wanted = (prefix: 'C' | 'AC') =>
		[...aisvs]
			.filter(
				([id, r]) =>
					(r.level === '1' || r.level === '2') && id.startsWith('AC') === (prefix === 'AC')
			)
			.map(([id]) => id);
	const { rows, counts, countHeader, duplicateCounts, companionIds } = parsePage(page);
	const problems: string[] = [];
	if (countHeader?.join() !== COUNT_HEADER.join()) {
		problems.push(`counts: the header reads ${countHeader?.join('/') ?? 'nothing'}`);
	}
	for (const key of duplicateCounts) problems.push(`counts: ${key} published twice`);
	const onPage = new Set(rows.filter((r) => r.section === 'product').map((r) => r.id));
	for (const id of new Set(companionIds)) {
		if (!onPage.has(id)) problems.push(`companions: C${id} is not a row of this page`);
	}

	const check = (section: Row['section'], expected: string[]) => {
		const got = rows.filter((r) => r.section === section).map((r) => r.id);
		const missing = expected.filter((id) => !got.includes(id));
		const extra = got.filter((id) => !expected.includes(id));
		const twice = got.filter((id, i) => got.indexOf(id) !== i);
		if (missing.length) problems.push(`${section}: missing ${missing.join(', ')}`);
		if (extra.length) problems.push(`${section}: not a Level 1-2 row here ${extra.join(', ')}`);
		if (twice.length) problems.push(`${section}: listed twice ${twice.join(', ')}`);
	};
	check('product', wanted('C'));
	check('development', [...wanted('AC'), '9.2.1']);

	for (const row of rows) {
		const std = aisvs.get(row.id);
		if (!std) continue;
		if (std.level !== row.level)
			problems.push(`${row.id}: level ${row.level}, standard says ${std.level}`);
		if (std.text !== row.text) problems.push(`${row.id}: quoted text differs from the standard`);
		if (!VERDICTS.includes(row.verdict as Verdict))
			problems.push(`${row.id}: verdict « ${row.verdict} » is not one of the six`);
		if ((row.verdict === 'partly' || row.verdict === 'unmet') && !/#\d+/.test(row.issue)) {
			problems.push(`${row.id}: ${row.verdict} with no issue`);
		}
		if (row.verdict === 'exception' && !RULED_EXCEPTIONS[row.section].includes(row.id)) {
			problems.push(`${row.id}: an exception the owner has not ruled`);
		}
		if (row.section === 'product' && row.heading !== `C${row.id.split('.')[0]}`) {
			problems.push(`${row.id}: listed under ${row.heading ?? 'no chapter'}`);
		}
	}

	const computed = new Map<string, number[]>();
	for (const row of rows) {
		for (const key of [chapterOf(row), row.section === 'product' ? 'Product total' : null]) {
			if (!key) continue;
			const tally = computed.get(key) ?? [0, 0, 0, 0, 0, 0, 0];
			const index = VERDICTS.indexOf(row.verdict as Verdict);
			if (index >= 0) tally[index]++;
			tally[6]++;
			computed.set(key, tally);
		}
	}
	for (const [key, tally] of computed) {
		const published = counts.get(key);
		if (!published) problems.push(`counts: no line for ${key}`);
		else if (published.join() !== tally.join()) {
			problems.push(
				`counts: ${key} published ${published.join('/')}, rows give ${tally.join('/')}`
			);
		}
	}
	for (const key of counts.keys())
		if (!computed.has(key)) problems.push(`counts: ${key} has no rows`);
	return problems;
}

describe('the AISVS 1.0 map (#536)', () => {
	const page = readFileSync(`${ROOT}${PAGE}`, 'utf8');

	it('reads every row it must, so a clean result is about the page', () => {
		const { rows, counts } = parsePage(page);
		console.log(`aisvs-map: ${rows.length} rows read, ${counts.size} count lines read`);
		expect(rows.filter((r) => r.section === 'product')).toHaveLength(146);
		expect(rows.filter((r) => r.section === 'development')).toHaveLength(53);
	});

	it('is complete, quotes the standard, uses the six verdicts, files every deviation, and counts its own rows', () => {
		expect(validate(page)).toEqual([]);
	});

	describe('calibration: each defect is named', () => {
		const firstRow = page.split('\n').find((l) => l.startsWith('| AISVS C'))!;
		// Found and edited through `cells`, never by matching cell text: Prettier pads every column, so a
		// pattern such as `| unmet |` stops matching the moment the page is formatted.
		const unmetRow = page
			.split('\n')
			.find((l) => l.startsWith('| AISVS C') && cells(l)[2] === 'unmet')!;
		const rebuilt = (c: string[]) => `| ${c.join(' | ')} |`;

		it('a removed row', () => {
			expect(validate(page.replace(`${firstRow}\n`, ''))).toEqual(
				expect.arrayContaining([expect.stringMatching(/^product: missing /)])
			);
		});
		it('a verdict outside the set', () => {
			const changed = cells(unmetRow);
			changed[2] = 'fine';
			expect(validate(page.replace(unmetRow, rebuilt(changed)))).toEqual(
				expect.arrayContaining([expect.stringMatching(/is not one of the six$/)])
			);
		});
		it('a deviation with no issue', () => {
			const cleared = cells(unmetRow);
			cleared[5] = '';
			expect(validate(page.replace(unmetRow, `| ${cleared.join(' | ')} |`))).toEqual(
				expect.arrayContaining([expect.stringMatching(/unmet with no issue$/)])
			);
		});
		it('a level that is not the standard', () => {
			const changed = cells(firstRow);
			changed[1] = changed[1] === '1' ? '2' : '1';
			expect(validate(page.replace(firstRow, `| ${changed.join(' | ')} |`))).toEqual(
				expect.arrayContaining([expect.stringMatching(/: level \d, standard says \d$/)])
			);
		});
		it('a requirement paraphrased instead of quoted', () => {
			const paraphrased = firstRow.replace('« Verify that ', '« Check that ');
			expect(paraphrased).not.toBe(firstRow);
			expect(validate(page.replace(firstRow, paraphrased))).toEqual(
				expect.arrayContaining([expect.stringMatching(/: quoted text differs from the standard$/)])
			);
		});
		it('a count line published twice', () => {
			const line = page.split('\n').find((l) => l.startsWith('|') && cells(l)[0] === 'C1')!;
			expect(validate(page.replace(line, `${line}\n${line}`))).toEqual(
				expect.arrayContaining(['counts: C1 published twice'])
			);
		});
		it('a counts header whose columns are swapped', () => {
			const line = page.split('\n').find((l) => l.startsWith('|') && cells(l)[0] === 'Chapter')!;
			const swapped = cells(line);
			[swapped[2], swapped[3]] = [swapped[3], swapped[2]];
			expect(validate(page.replace(line, rebuilt(swapped)))).toEqual(
				expect.arrayContaining([expect.stringMatching(/^counts: the header reads /)])
			);
		});
		it('an exception the owner has not ruled', () => {
			const changed = cells(unmetRow);
			changed[2] = 'exception';
			expect(validate(page.replace(unmetRow, rebuilt(changed)))).toEqual(
				expect.arrayContaining([expect.stringMatching(/: an exception the owner has not ruled$/)])
			);
		});
		it('a row under another chapter heading', () => {
			const lines = page.split('\n');
			const c3 = lines.findIndex((l) => l.startsWith('### C3 '));
			const moved = lines.filter((l) => l !== firstRow);
			moved.splice(moved.findIndex((l) => l.startsWith('### C3 ')) + 4, 0, firstRow);
			expect(c3).toBeGreaterThan(0);
			expect(validate(moved.join('\n'))).toEqual(
				expect.arrayContaining([expect.stringMatching(/: listed under C3$/)])
			);
		});
		it('a companion table citing a row this page does not hold', () => {
			const line = page.split('\n').find((l) => /^\| R1 /.test(l))!;
			expect(validate(page.replace(line, line.replace(' |\n', ' |') + ' AISVS C4.1.3'))).toEqual(
				expect.arrayContaining(['companions: C4.1.3 is not a row of this page'])
			);
		});
		it('a published count that is not the rows', () => {
			const line = page
				.split('\n')
				.find((l) => l.startsWith('|') && cells(l)[0] === 'Product total')!;
			const changed = cells(line);
			changed[1] = String(Number(changed[1]) + 1);
			expect(validate(page.replace(line, `| ${changed.join(' | ')} |`))).toEqual(
				expect.arrayContaining([expect.stringMatching(/^counts: Product total published /)])
			);
		});
	});
});
