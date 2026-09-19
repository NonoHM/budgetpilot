import { describe, expect, it } from 'vitest';
import { guardFormulaLead, needsFormulaGuard } from './formulaGuard';
import { sanitizeImportedText } from '$lib/server/import/utils/safety';
import { buildTransactionsCsv } from '$lib/server/transactions/exportCsv';
import type { TransactionNature } from '$lib/domain/transaction';
import type { TransactionRowForMapping } from '$lib/server/transactions/nature';

/**
 * The rule, and the proof that every clause of it is load bearing.
 *
 * Each clause is broken separately in the break-check recorded in the PR, because a guard that
 * reddens for one break reads exactly like a guard that reddens, and only the second break says
 * which clause did the work. The two clauses answer different questions: clause one is what a
 * consumer EXECUTES, clause two is what a consumer DISCARDS first.
 */

/**
 * The corpus every claim below is driven from.
 *
 * **Both expectations are written out by hand rather than computed.** `guarded` could have been
 * derived from `needsFormulaGuard` and `afterImport` from `guardFormulaLead`, and either would
 * have made the table an identity: a comparison whose two sides come from one source passes
 * always and detects never. `afterImport` in particular is the whole value of the second suite
 * below, because it is the only oracle here that `sanitizeImportedText` cannot satisfy by
 * agreeing with itself.
 */
const CORPUS: Array<{ value: string; guarded: boolean; afterImport: string; why: string }> = [
	{ value: 'Leroy Merlin', guarded: false, afterImport: 'Leroy Merlin', why: 'an ordinary label' },
	{
		value: 'Étude de Maître Blanc',
		guarded: false,
		afterImport: 'Étude de Maître Blanc',
		why: 'accents are not a lead character'
	},
	{
		value: 'CARREFOUR MARKET',
		guarded: false,
		afterImport: 'CARREFOUR MARKET',
		why: 'the shape most of the corpus has'
	},
	{ value: '', guarded: false, afterImport: '', why: 'nothing to guard' },
	{
		value: '\u0000',
		guarded: false,
		afterImport: '\u0000',
		why: 'ignorable all the way down, no formula behind it'
	},
	{
		value: '\u0000Courses',
		guarded: false,
		afterImport: '\u0000Courses',
		why: 'a hidden character in front of something safe'
	},
	{
		value: '=SUM(A1:A9)',
		guarded: true,
		afterImport: "'=SUM(A1:A9)",
		why: 'clause one, the case that always worked'
	},
	{ value: '+150,00', guarded: true, afterImport: "'+150,00", why: 'clause one' },
	{
		value: '-39,90',
		guarded: true,
		afterImport: "'-39,90",
		why: 'clause one, and 154 corpus cells open this way'
	},
	{ value: '@cmd', guarded: true, afterImport: "'@cmd", why: 'clause one' },
	{
		value: '\t=cmd',
		guarded: true,
		afterImport: "'=cmd",
		why: 'clause one at export; at import trim removes the tab first'
	},
	{ value: '\r=cmd', guarded: true, afterImport: "'=cmd", why: 'clause one at export, same' },
	// THE ONLY TWO CASES CLAUSE ONE DECIDES ALONE, and they were absent until a break-check said
	// so: with a SAFE character behind it, clause two strips the tab (it is Cc) and sees nothing
	// dangerous, so clause one is the whole answer. Removing clause one, or removing \t and \r
	// from the class, reddened NOTHING before these two lines existed. At import they are not
	// guarded at all, because trim gets there first, and that asymmetry is the point.
	{
		value: '\tCourses',
		guarded: true,
		afterImport: 'Courses',
		why: 'clause one alone, ASVS names tab explicitly'
	},
	{ value: '\rCourses', guarded: true, afterImport: 'Courses', why: 'clause one alone' },
	{
		value: '\u0000=1+1',
		guarded: true,
		afterImport: "'\u0000=1+1",
		why: 'clause two, #594, measured live in LibreOffice'
	},
	{
		value: '\u200B=1+1',
		guarded: true,
		afterImport: "'\u200B=1+1",
		why: 'clause two, zero width space'
	},
	{
		value: '\u202E=1+1',
		guarded: true,
		afterImport: "'\u202E=1+1",
		why: 'clause two, right-to-left override'
	},
	{
		value: '\u00A0=1+1',
		guarded: true,
		afterImport: "'=1+1",
		why: 'clause two at export; at import the NBSP is whitespace and trim removes it'
	},
	{
		value: '\uFEFF=1+1',
		guarded: true,
		afterImport: "'=1+1",
		why: 'clause two at export; the BOM is whitespace to trim'
	},
	{
		value: '\uFF1D1+1',
		guarded: true,
		afterImport: "'\uFF1D1+1",
		why: 'clause two, fullwidth equals folds to = under NFKC'
	},
	{ value: '\uFF0B1', guarded: true, afterImport: "'\uFF0B1", why: 'clause two, fullwidth plus' },
	{ value: '\uFE621', guarded: true, afterImport: "'\uFE621", why: 'clause two, small plus sign' },
	{
		value: "'=1+1",
		guarded: false,
		afterImport: "'=1+1",
		why: 'already guarded, and a second apostrophe is damage'
	}
];

describe('needsFormulaGuard', () => {
	it('decides every case of the corpus the way the corpus says, with both answers present', () => {
		expect.assertions(CORPUS.length + 2);

		// The denominator, asserted rather than trusted. A corpus that drifted to all-true or
		// all-false would make every decision below unfalsifiable while still passing.
		expect(CORPUS.filter((entry) => entry.guarded)).toHaveLength(16);
		expect(CORPUS.filter((entry) => !entry.guarded)).toHaveLength(7);

		for (const entry of CORPUS) {
			expect(needsFormulaGuard(entry.value), `${entry.why}: ${JSON.stringify(entry.value)}`).toBe(
				entry.guarded
			);
		}
	});

	/**
	 * THE CANARY FOR THE ONE THING THIS MODULE READS FROM OUTSIDE ITSELF.
	 *
	 * `\p{Cf}` and `String.prototype.normalize` resolve against the RUNTIME's Unicode tables, and
	 * `sanitizeImportedText` stores the answer, which then enters the deduplication key. So a Node
	 * upgrade that assigns one more code point to Cf silently changes what a later import stores
	 * for an input that has not changed. Nothing else in the repository would notice.
	 *
	 * The figure is therefore pinned rather than described. When it moves, read the diff of the
	 * Unicode version before changing the number: measured 2026-09-19 on node 24.18.0 /
	 * unicode 17.0 / icu 78.3. Driven through the PUBLIC function rather than by re-testing the
	 * private class, so the pin is on the behaviour and not on a spelling.
	 */
	it('guards a population of a pinned size, so a Unicode table change is red and not silent', () => {
		expect.assertions(2);

		let scanned = 0;
		let guarded = 0;
		for (let codePoint = 0; codePoint <= 0x2ffff; codePoint += 1) {
			if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
			scanned += 1;
			if (needsFormulaGuard(`${String.fromCodePoint(codePoint)}=cmd`)) guarded += 1;
		}

		// The denominator beside the finding, so a scan that read nothing cannot report a zero.
		expect(scanned).toBe(194_560);
		expect(guarded).toBe(176);
	});

	it('never alters the value it guards, because a round trip has to restore the same label', () => {
		expect.assertions(2);

		expect(guardFormulaLead('\u0000=1+1')).toBe("'\u0000=1+1");
		expect(guardFormulaLead('Leroy Merlin')).toBe('Leroy Merlin');
	});

	it('is idempotent, so a label already carrying a guard never gains a second one', () => {
		expect.assertions(CORPUS.length);

		// The stored labels this runs over in production are a mixture: some were guarded on the
		// way in, some were written by a restore and never sanitised at all. Applying the guard to
		// an already-guarded value must be a no-op or the export doubles the apostrophe on every
		// download.
		for (const entry of CORPUS) {
			const once = guardFormulaLead(entry.value);
			expect(guardFormulaLead(once), entry.why).toBe(once);
		}
	});
});

/**
 * THE TWO CALLERS, DRIVEN THROUGH THEIR OWN PUBLIC ENTRY POINTS.
 *
 * Not « the callers agree with each other »: after this refactor both call one function, so a
 * spec comparing them to each other would have a single source on both sides and pass always.
 * What is asserted instead is that each PIPELINE produces the hand-written expectation, which a
 * caller that retyped the condition would fail the first time the two definitions diverged.
 *
 * The residual risk is not disagreement, it is a THIRD copy appearing, which is #587's shape.
 * That is not defended by a source scan here, deliberately: #587's own guard recognised one
 * spelling in one file type and missed the same defect wrapped differently, so a scan would buy a
 * green rather than a guarantee. Two public pipelines over one hand-written table is what is
 * claimed, and nothing more.
 */
describe('every caller of the rule produces the expected text', () => {
	const NO_MAPPINGS = new Map<string, TransactionNature>();

	function exportedLabelField(label: string): string {
		const csv = buildTransactionsCsv(
			[
				{
					id: 'tx-1',
					date: new Date('2026-06-12T00:00:00.000Z'),
					label,
					amountCents: 8000,
					type: 'expense',
					source: 'csv',
					manualCategory: null,
					natureManual: null,
					category: { name: 'Maison' },
					splits: []
				} satisfies TransactionRowForMapping
			],
			NO_MAPPINGS
		);
		const field = csv.split('\r\n')[1].split(';')[1];
		// The quoting wraps the guard, so it has to come off before the lead can be read. That the
		// quoting itself is correct is asserted in `exportCsv.spec.ts`, not assumed here.
		return field.startsWith('"') ? field.slice(1, -1).replace(/""/g, '"') : field;
	}

	it('the export writer guards exactly the values the rule names', () => {
		expect.assertions(CORPUS.length);

		for (const entry of CORPUS) {
			const expected = entry.guarded ? `'${entry.value}` : entry.value;
			expect(exportedLabelField(entry.value), entry.why).toBe(expected);
		}
	});

	it('the import sanitiser produces the hand-written text for every case', () => {
		expect.assertions(CORPUS.length);

		// `afterImport` is written out per case rather than computed from the guard, because
		// `sanitizeImportedText` trims and collapses whitespace BEFORE guarding and the two
		// therefore disagree on purpose: a leading tab, NBSP or BOM is guarded at export and
		// removed at import. Deriving the expectation would have hidden exactly that.
		for (const entry of CORPUS) {
			expect(sanitizeImportedText(entry.value), entry.why).toBe(entry.afterImport);
		}
	});
});
