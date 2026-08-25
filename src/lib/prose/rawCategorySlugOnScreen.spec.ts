import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A category name a reader meets goes through `categoryDisplayName`, always.
 *
 * `UNCLASSIFIED_CATEGORY` is the technical slug `uncategorized` (domain/categories.ts). It is
 * stored so that "unclassified" is a real row a transaction can point at, and it must never reach a
 * screen: `categoryDisplayName` is the one function that turns it into « Non catégorisé », and
 * since #162 that is its ONLY job, because every other category name is shown exactly as stored.
 *
 * ## Why this is a sweep and not four repaired render sites
 *
 * Measured on 0.14.0, on a running instance, across nine routes: the slug was visible on THREE of
 * them through THREE unrelated mechanisms — a label composed server-side by `anonymizeLabel`, a
 * row sub-line on /upcoming-bills, and the system row on /categories. Each had its own tests and
 * each was green. Nothing in the tree connected them, so fixing the reported one would have left
 * the other two shipping with the report closed. This file is what makes the fourth impossible
 * rather than merely absent.
 *
 * Sibling of `emDashesInProse.spec.ts` and built to the same three rules that make a source scan
 * worth anything here: read the file set a fresh clone has (`git ls-files`), state HOW MANY FILES
 * were read beside any clean verdict, and prove the detector can fire before believing that it
 * found nothing.
 *
 * ## What it does NOT claim
 *
 * It reads Svelte templates, not the running DOM, so it cannot see a raw slug composed in a
 * `.ts` file and handed to a page already-composed. That hole is real and it is exactly how the
 * /reports instance arrived; it is covered instead at its source, by
 * `server/reports/monthly.spec.ts`, which pins `anonymizeLabel`. Two guards, named apart on
 * purpose: a scan that claimed both surfaces while reading one of them would be the confident-zero
 * failure this repository keeps recording.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * An expression that yields a category NAME as stored. Deliberately a small closed list rather than
 * anything matching /categor/i: a pattern that matches more than it can justify gets loosened the
 * first time it fires on something legitimate, and a loosened guard guards nothing.
 */
const CATEGORY_ACCESSORS = [
	/\.category\b/,
	/\.categoryName\b/,
	/\.dominantCategory\b/,
	/\.targetCategory\b/,
	/\bcat\.name\b/
];

/**
 * Positions where an interpolation is READ BY A HUMAN: template text, and the attributes that
 * carry an accessible name. An accessible name is text a reader meets in exactly the sense this
 * rule is about — the /categories nature selects reached a screen reader with the raw slug while
 * the visible cell beside them had been repaired, which is the half a purely visual audit misses.
 */
const VISIBLE_ATTRIBUTES = [
	'label',
	'ariaLabel',
	'aria-label',
	'expandAriaLabel',
	'categoryLabel',
	'dominantCategory',
	'title',
	'placeholder',
	'alt'
];

/** Component props whose value is a LIST rendered as text by the component receiving it. */
const VISIBLE_LIST_PROPS = ['parts'];

export interface RawCategoryFinding {
	line: number;
	expression: string;
}

/**
 * Every visible interpolation in one Svelte template that reads a category name without putting it
 * through `categoryDisplayName`.
 *
 * Text position is recognised as a mustache whose nearest preceding non-whitespace character is
 * `>`, which is what a template's own text node looks like and what an attribute value never does.
 * That is a heuristic and it is stated as one: it is why the calibration below feeds it both a
 * caught shape and an uncaught one rather than asserting a count.
 */
/**
 * The part of an expression that is actually PRINTED. For a top-level ternary that is its two
 * branches; for anything else it is the whole expression. Split on the first top-level `?` so a
 * nested call's own punctuation cannot move the boundary.
 */
function renderedPart(expression: string): string {
	let depth = 0;
	for (let i = 0; i < expression.length; i += 1) {
		const char = expression[i];
		if (char === '(' || char === '[' || char === '{') depth += 1;
		else if (char === ')' || char === ']' || char === '}') depth -= 1;
		// `?.` and `??` are not ternaries.
		else if (
			char === '?' &&
			depth === 1 &&
			expression[i + 1] !== '.' &&
			expression[i + 1] !== '?'
		) {
			return expression.slice(i + 1);
		}
	}
	return expression;
}

/**
 * The template half of a `.svelte` file, with every `<script>` body blanked to spaces of the same
 * length so reported line numbers still point at the real file.
 *
 * Script bodies are excluded rather than scanned, and that is a boundary rather than a shortcut: a
 * script body is TypeScript, where `{` opens an object literal or a block and the text-position
 * heuristic below means nothing. Scanning it would report on `const key = row.category` — a
 * comparison, printed nowhere. The cost is stated in this file's header: a string composed in a
 * script body and printed later is invisible here, which is why /upcoming-bills' mobile sub-line is
 * covered by its own page spec at both widths instead.
 */
function templateOnly(source: string): string {
	return source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (block) =>
		block.replace(/[^\n]/g, ' ')
	);
}

export function findRawCategoryRenders(rawSource: string): RawCategoryFinding[] {
	const source = templateOnly(rawSource);
	const findings: RawCategoryFinding[] = [];
	const attributePattern = new RegExp(
		`\\b(?:${[...VISIBLE_ATTRIBUTES, ...VISIBLE_LIST_PROPS].join('|')})\\s*=\\s*\\{`
	);

	// Interpolations are matched with a brace counter rather than a regex: a Svelte expression
	// nests braces (object literals, nested calls), and `\{[^}]*\}` stops at the first inner one,
	// which reads the head of an expression and reports on a fragment of it.
	for (let index = 0; index < source.length; index += 1) {
		if (source[index] !== '{') continue;

		let depth = 0;
		let end = index;
		for (; end < source.length; end += 1) {
			if (source[end] === '{') depth += 1;
			else if (source[end] === '}') {
				depth -= 1;
				if (depth === 0) break;
			}
		}
		if (depth !== 0) continue;

		const expression = source.slice(index, end + 1);
		const before = source.slice(0, index);
		// In TEXT position when the last tag delimiter behind us CLOSED a tag. Comparing against the
		// immediately preceding character is not the same question and was measurably weaker: it saw
		// `>{cat.name}` and missed `· {row.category}`, the second interpolation on a line, which is
		// the exact shape /upcoming-bills' desktop sub-line had. Caught by breaking that site on
		// purpose and reading which tests went red.
		const isTextPosition = before.lastIndexOf('>') > before.lastIndexOf('<');
		const isVisibleAttribute = attributePattern.test(before.slice(-40) + '{');

		// Advance past the whole matched mustache whatever the verdict, so a NESTED brace is never
		// examined as an interpolation of its own. Without this the object literal inside
		// `onclick={() => (editing = { categoryName: budget.categoryName })}` was read as a separate
		// expression, and the `>` of the arrow function made it look like text position — four false
		// positives on /budgets, on a page whose visible label three lines up is correctly wrapped.
		index = end;

		if (!isTextPosition && !isVisibleAttribute) continue;
		// A Svelte BLOCK or TAG, not an interpolation. `{#each rows as row (row.category)}` sits in
		// text position and reads a category, and renders neither: the key is an identity, the `{#if}`
		// is a condition, `{@const}` is an assignment. The first draft of this guard reported all nine
		// of them and every one was a false positive — which is the loosening pressure this file's own
		// comment warns about, arriving before the guard had ever been committed.
		if (/^\{\s*[#:/@]/.test(expression)) continue;
		// Only the BRANCHES of a ternary are rendered. `{filters.category ? activeLabel : m.all()}`
		// reads the accessor to CHOOSE, and prints a label that is already resolved.
		if (!CATEGORY_ACCESSORS.some((pattern) => pattern.test(renderedPart(expression)))) continue;
		if (expression.includes('categoryDisplayName')) continue;

		findings.push({
			line: before.split('\n').length,
			expression: expression.replace(/\s+/g, ' ').slice(0, 90)
		});
	}

	return findings;
}

/**
 * Sites that read a category accessor in a visible position and are CORRECT as they are, each with
 * the reason written here rather than counted. Allowlisted by path and expression fragment, so
 * adding a tenth is a decision somebody records rather than a number that quietly goes up.
 */
const ALLOWED: Array<{ path: string; contains: string; why: string }> = [
	{
		path: 'src/lib/components/splits/SplitBadge.svelte',
		contains: 'part.category',
		why: 'The component renders what it is given. Its `parts` prop is documented as carrying display names already resolved by the caller, and all four callers now do.'
	}
];

function trackedSvelteFiles(): string[] {
	return execFileSync('git', ['ls-files', 'src/**/*.svelte'], {
		cwd: REPO_ROOT,
		encoding: 'utf8'
	})
		.split('\n')
		.filter(Boolean);
}

describe('a category name a reader meets goes through categoryDisplayName', () => {
	/**
	 * Separates "no file renders a raw category" from "no file was read". Those two produce the
	 * identical empty offender list, and this repository has shipped the second one reading as the
	 * first more than once.
	 *
	 * 94 is the count MEASURED when this guard was written, cross-checked four ways (`git ls-files
	 * 'src/**' + '*.svelte'`, the same glob without the double star, `find`, and a filtered
	 * `git ls-files src`) because a glob's behaviour is not its spelling — see CLAUDE.md on `*`
	 * crossing a slash. The bound is 80 rather than 94: an equality would redden every time
	 * somebody adds a component, which is a rule about file counts, not about category names. The
	 * first draft of this line carried 137, a number nobody had run, and the assertion itself is
	 * what caught it.
	 */
	it('reads a non-empty set of tracked templates, so a clean result cannot mean an empty list', () => {
		expect.assertions(1);

		expect(trackedSvelteFiles().length).toBeGreaterThan(80);
	});

	/**
	 * Prove the detector can detect, before believing any absence. Both directions, because a
	 * detector that fires on everything and one that fires on nothing report the same empty list
	 * once the tree is clean.
	 */
	it('fires on a raw render and stays silent on a wrapped one', () => {
		expect.assertions(10);

		const raw = '<td class="px-5 py-2.5 font-medium">{cat.name}</td>';
		const wrapped = '<td class="px-5 py-2.5 font-medium">{categoryDisplayName(cat.name)}</td>';
		const rawAccessibleName = '<IconButton label={m.rename_aria({ name: cat.name })} />';
		// A category accessor that is an IDENTIFIER, not text: the value posted back to the server,
		// which must stay the stored name. See CLAUDE.md, "join on an identifier, never on displayed
		// text" — this is the case the guard must NOT flag, or the fix it demands loses data.
		const postedIdentifier = '<input type="hidden" name="categoryName" value={cat.name} />';

		// Control flow, not text: the key of a keyed `#each` is an identity, never something printed.
		const blockTag = '<ul>{#each rows as row (row.category)}<li>x</li>{/each}</ul>';
		// A ternary whose CONDITION reads the accessor and whose branches print resolved labels.
		const ternaryCondition = '<span>{filters.category ? activeLabel : m.all()}</span>';
		// The same shape with a RAW branch, which must still fire — otherwise the two rules above
		// would have bought silence rather than precision.
		const ternaryRawBranch = '<span>{row.split ? row.category : m.none()}</span>';

		expect(findRawCategoryRenders(raw)).toHaveLength(1);
		expect(findRawCategoryRenders(wrapped)).toHaveLength(0);
		expect(findRawCategoryRenders(rawAccessibleName)).toHaveLength(1);
		expect(findRawCategoryRenders(postedIdentifier)).toHaveLength(0);
		expect(findRawCategoryRenders(blockTag)).toHaveLength(0);
		expect(findRawCategoryRenders(ternaryCondition)).toHaveLength(0);
		expect(findRawCategoryRenders(ternaryRawBranch)).toHaveLength(1);
		// Not the first thing after a tag. This is the shape the first heuristic missed.
		expect(findRawCategoryRenders('<span>{kindLabel(row)} · {row.category}</span>')).toHaveLength(
			1
		);
		// A handler that ASSIGNS a category is not one that prints it. The arrow's `>` is why this
		// case needs its own calibration: it is what made the nested literal look like text.
		expect(
			findRawCategoryRenders(
				'<b onclick={() => (editing = { categoryName: b.categoryName })}>x</b>'
			)
		).toHaveLength(0);
		// A script body is not a template, and is deliberately not read.
		expect(
			findRawCategoryRenders('<script>const k = { text: row.category };</script><b>x</b>')
		).toHaveLength(0);
	});

	it('finds none in any tracked template', () => {
		expect.assertions(2);

		const files = trackedSvelteFiles();
		const offenders = files.flatMap((path) =>
			findRawCategoryRenders(readFileSync(`${REPO_ROOT}${path}`, 'utf8'))
				.filter(
					(finding) =>
						!ALLOWED.some(
							(entry) => entry.path === path && finding.expression.includes(entry.contains)
						)
				)
				.map((finding) => `${path}:${finding.line} ${finding.expression}`)
		);

		// The absolute figure beside the emptiness assertion, so the zero above is a finding rather
		// than a silence.
		expect(files.length).toBeGreaterThan(80);
		expect(offenders).toEqual([]);
	});
});
