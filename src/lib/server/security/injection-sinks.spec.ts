import { describe, expect, it } from 'vitest';
import { blockCommentRanges, isInComment, productionSourceFiles, readSource } from './sourceScan';

/**
 * Client-storage and injection-sink scan: check 10 of the Phase 5 automation inventory, covering
 * `v5.0.0-14.3.3` (nothing sensitive in browser storage), `v5.0.0-1.2.1` and `v5.0.0-1.2.3`
 * (output encoding for HTML and for dynamically built JavaScript), `v5.0.0-3.2.2` (text is rendered
 * as text), `v5.0.0-1.3.2` (no dynamic code execution) and `v5.0.0-1.2.9` (regex metacharacters
 * cannot be misinterpreted).
 *
 * Six rows from one scan, and every one of them is met by an ABSENCE. Svelte escapes interpolated
 * text by default, so `v5.0.0-1.2.1`, `1.2.3` and `3.2.2` all reduce to the same question: does
 * anything opt OUT of that default. The opt-outs are countable, and this counts them.
 *
 * WHAT WAS SPECIFIED AND WHY IT CHANGED, because this is the third mechanism in this phase that
 * did not survive contact with the code, and the pattern is worth more than the instance.
 *
 * The inventory said: assert zero `{@html}` AND zero inline `<script>` across `src/`. The first
 * half is right and is here. **The second cannot work: `<script` matches 76 files, because that is
 * how every Svelte component declares its own module.** A scan for it reports 76 offenders on a
 * codebase with no defect at all, so it would have been deleted by whoever met it first, taking the
 * `{@html}` half with it. What the row actually needs is covered elsewhere and is stated here so it
 * does not read as dropped: no `<script>` reaches rendered output except through SvelteKit's own
 * nonce-bearing tags, and the CSP that enforces that (`script-src` with no `'unsafe-inline'`) is
 * pinned by `src/hooks.server.spec.ts` and asserted on the wire by `e2e/security-headers.spec.ts`.
 *
 * `v5.0.0-1.2.9` also moved, in phrasing rather than in scope. The inventory framed the `new
 * RegExp(` ban as "so user patterns cannot leave `re2js`", which is a ReDoS argument. The
 * requirement is about METACHARACTERS being misinterpreted, and the same assertion answers it
 * better than the ReDoS framing does: **no production module constructs a RegExp from a string at
 * all**, so there is no site at which an unescaped metacharacter could be misread. User-authored
 * patterns are a deliberate feature and go through `re2js`, which is a different thing from data
 * accidentally reaching a regex engine.
 *
 * THE STRING-LITERAL FILTER IS DELIBERATELY NOT USED HERE, unlike in the crypto and outbound scans.
 * It is tuned for TypeScript, and a Svelte template is mostly markup: French copy carries
 * apostrophes (`l'utilisateur`) that open a quote the scanner would run to the end of the line to
 * close, swallowing anything after it on that line. That is the dangerous direction for an absence
 * scan, since it hides sinks rather than inventing them. Comments are filtered, which is enough:
 * the one `{@html}` anywhere in `src/` is a JSDoc line in `domain/normalize.ts` saying the caller
 * renders matched segments WITHOUT it, and that near-miss has its own test below.
 *
 * THE BREAK MATRIX, nine breaks against eight tests, read per test. Baseline 8/8. Five of the
 * breaks add a real sink to a real production file, one per family, so each is a defect somebody
 * could plausibly write; four attack the harness. Every one is red on the test aimed at, and one
 * green is the whole argument for how this file is built:
 *
 *  - `the {@html} pattern stops matching` (one character changed inside the regex): only the
 *    FIXTURE CONTROL red. The real assertion stays GREEN and reports a clean sweep, because a
 *    pattern that matches nothing finds no offenders, which is byte-for-byte the output of a
 *    codebase with no sinks. Nothing else in this file, and nothing in the rest of the suite, can
 *    tell those two apart. That is why the control is a test rather than a comment.
 *  - `the scan points at an empty tree`: only the population calibration red, every offender test
 *    green over zero files.
 *  - `the comment filter is disabled`: the filter's own test red, and the HTML assertion red with
 *    it, because `normalize.ts`'s prose about not using `{@html}` then reads as using it.
 *  - the five real sinks and `re2js is replaced`: one red each, on their own row.
 */

/**
 * NOTE FOR ANY SCANNER, HUMAN OR AUTOMATED, READING THIS FILE: the `fixture` strings below contain
 * `eval(`, `new Function(`, `document.write(`, `innerHTML =` and `insertAdjacentHTML(` deliberately.
 * They are inert string literals used to prove each detector can see its own sink, they are never
 * parsed, evaluated or inserted into a document, and this file is a spec that ships in no artifact.
 * A scan flagging them has demonstrated it works, which is the point of them existing.
 */
interface Sink {
	/** What the offender list calls it. */
	id: string;
	pattern: RegExp;
	/**
	 * A line that MUST match. This is the control, not documentation: an absence assertion is worth
	 * exactly what its ability to observe the presence is worth, and every pattern below is checked
	 * against its own fixture before any empty offender list is believed.
	 */
	fixture: string;
}

const BROWSER_STORAGE: Sink[] = [
	{ id: 'localStorage', pattern: /\blocalStorage\b/g, fixture: 'localStorage.setItem("k", v);' },
	{
		id: 'sessionStorage',
		pattern: /\bsessionStorage\b/g,
		fixture: 'const raw = sessionStorage.getItem("k");'
	},
	{ id: 'indexedDB', pattern: /\bindexedDB\b/g, fixture: 'const db = indexedDB.open("bp");' }
];

const HTML_INJECTION: Sink[] = [
	{ id: '{@html}', pattern: /\{@html\b/g, fixture: '<p>{@html userSuppliedMarkup}</p>' },
	{
		id: 'innerHTML assignment',
		pattern: /\b(?:inner|outer)HTML\s*=/g,
		fixture: 'node.innerHTML = value;'
	},
	{
		id: 'insertAdjacentHTML',
		pattern: /\binsertAdjacentHTML\s*\(/g,
		fixture: "node.insertAdjacentHTML('beforeend', value);"
	},
	{ id: 'document.write', pattern: /\bdocument\.write\s*\(/g, fixture: 'document.write(value);' }
];

const DYNAMIC_CODE: Sink[] = [
	{ id: 'eval', pattern: /(?<![.\w$])eval\s*\(/g, fixture: 'const result = eval(expression);' },
	{
		id: 'new Function',
		pattern: /\bnew\s+Function\s*\(/g,
		fixture: 'const f = new Function(src);'
	},
	{
		id: 'string-form timer',
		pattern: /\bset(?:Timeout|Interval)\s*\(\s*['"`]/g,
		fixture: 'setTimeout("doThing()", 10);'
	}
];

const REGEX_CONSTRUCTION: Sink[] = [
	{
		id: 'new RegExp',
		pattern: /\bnew\s+RegExp\s*\(/g,
		fixture: 'const re = new RegExp(userPattern);'
	}
];

const ALL_SINKS = [...BROWSER_STORAGE, ...HTML_INJECTION, ...DYNAMIC_CODE, ...REGEX_CONSTRUCTION];

/** Files naming a sink outside a comment, as `path (sink)`. */
function offendersFor(sinks: Sink[], files: string[] = productionSourceFiles()): string[] {
	const found: string[] = [];
	for (const path of files) {
		const source = readSource(path);
		const comments = blockCommentRanges(source);
		for (const sink of sinks) {
			const hit = [...source.matchAll(sink.pattern)].some(
				(match) => !isInComment(source, match.index, comments)
			);
			if (hit) found.push(`${path} (${sink.id})`);
		}
	}
	return found.sort();
}

describe('injection sinks and browser storage: the scan itself', () => {
	it('calibration: the scan reaches both halves of the tree', () => {
		expect.assertions(2);

		const files = productionSourceFiles();
		// A scan pointed at an empty or wrong directory reports zero offenders, which is the exact
		// output of a clean codebase. BOTH halves are floored separately, because the sinks split
		// cleanly between them: `{@html}` can only appear in a component and `eval` realistically
		// only in a module, so a scan that had lost one extension would still come back clean on
		// half the list. Measured 2026-08-13: 75 components and 155 modules, floored at 50 and 120
		// so ordinary growth or a deletion does not move them.
		expect(files.filter((path) => path.endsWith('.svelte')).length).toBeGreaterThan(50);
		expect(files.filter((path) => path.endsWith('.ts')).length).toBeGreaterThan(120);
	});

	// THE CONTROL THAT MAKES EVERY ABSENCE BELOW MEAN SOMETHING, and the one this phase has learned
	// to write first: point each detector at a real instance of what it looks for and require it to
	// report. A regex that has stopped matching, a typo in a character class, an escape that
	// silently changed meaning: all of them produce a clean sweep, and none of them is visible by
	// reading the pattern.
	it('control: every sink pattern DOES report its own fixture', () => {
		expect.assertions(1);

		const blind = ALL_SINKS.filter((sink) => !detects(sink)).map((sink) => sink.id);
		expect(blind, `patterns that cannot see their own sink: ${blind.join(', ')}`).toEqual([]);
	});

	// And the near-miss that exists for real, so the comment filter is exercised by the codebase
	// rather than only by a fixture. `domain/normalize.ts` explains that the caller renders matched
	// segments WITHOUT `{@html}`; a scan reading comments as code would report it as the one
	// offender in the tree.
	it('the comment filter separates a real sink from one named in prose', () => {
		expect.assertions(2);

		const source = readSource('src/lib/domain/normalize.ts');
		expect([...source.matchAll(/\{@html\b/g)]).toHaveLength(1);
		expect(offendersFor(HTML_INJECTION, ['src/lib/domain/normalize.ts'])).toEqual([]);
	});
});

/** Whether a pattern matches the line written to demonstrate it. */
function detects(sink: Sink): boolean {
	return new RegExp(sink.pattern.source, sink.pattern.flags).test(sink.fixture);
}

describe('v5.0.0-14.3.3: nothing is written to browser storage', () => {
	it('no module names localStorage, sessionStorage or indexedDB', () => {
		expect.assertions(1);

		// The strongest form the requirement admits. The row asks that browser storage holds nothing
		// sensitive; this asserts it holds NOTHING, which cannot be got wrong later by a judgement
		// call about what counts as sensitive. The session cookie, the row's own stated exception,
		// is HttpOnly and is not reachable from this API at all.
		const offenders = offendersFor(BROWSER_STORAGE);
		expect(offenders, `browser storage used: ${offenders.join(', ')}`).toEqual([]);
	});
});

describe('v5.0.0-1.2.1, v5.0.0-1.2.3, v5.0.0-3.2.2: nothing opts out of Svelte escaping', () => {
	it('no component renders unescaped HTML by any route', () => {
		expect.assertions(1);

		// `{@html}` is the framework's opt-out and the other three are the DOM's. Grouped because
		// they are one decision: everything the user sees is text unless somebody wrote one of these
		// four, and none of them is written.
		const offenders = offendersFor(HTML_INJECTION);
		expect(offenders, `unescaped HTML sinks: ${offenders.join(', ')}`).toEqual([]);
	});
});

describe('v5.0.0-1.3.2: no dynamic code execution', () => {
	it('no eval, no Function constructor, no string-form timer', () => {
		expect.assertions(1);

		const offenders = offendersFor(DYNAMIC_CODE);
		expect(offenders, `dynamic code execution: ${offenders.join(', ')}`).toEqual([]);
	});
});

describe('v5.0.0-1.2.9: no regex is built from a string', () => {
	it('no production module constructs a RegExp, so no metacharacter can be misread', () => {
		expect.assertions(1);

		// Measured, and the reason the assertion is phrased over CONSTRUCTION rather than over
		// escaping: there are 14 `new RegExp(` sites in this repository and every one is in a
		// `*.spec.ts`, which `productionSourceFiles` excludes. Literal regexes are unaffected; what
		// cannot happen is a pattern assembled from a string, which is the only place an unescaped
		// metacharacter has to be misread.
		const offenders = offendersFor(REGEX_CONSTRUCTION);
		expect(offenders, `RegExp built from a string: ${offenders.join(', ')}`).toEqual([]);
	});

	it('user-authored patterns go through re2js, which is a deliberate feature and not a sink', () => {
		expect.assertions(2);

		// The positive half. Without it, "no RegExp is constructed" would read as "this application
		// does not do regex", and the next person to add the feature would have no idea it exists.
		const source = readSource('src/lib/server/matching/regex.ts');
		expect(source).toContain("from 're2js'");
		expect(source).toContain('RE2JS.compile');
	});
});
