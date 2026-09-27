import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `docs/explanation/confidentiality-guards.md` is the single description of which guard owns which
 * class of private data. A page like that drifts the day a guard is renamed or a class loses its
 * owner, and nothing re-reads it. This test does:
 *
 * - every repository path the page names in code formatting exists in the tree, so a renamed or
 *   deleted guard reddens here instead of leaving the page pointing at nothing;
 * - every row of the classification table names at least one existing guard or an issue number
 *   for what no guard catches, so a class cannot sit on the page with no owner and no issue.
 *
 * BREAK-CHECKED (2026-09-26), each clause separately, restored from a pre-break copy:
 * - a guard path in the table renamed to one that does not exist: the path test goes red naming
 *   it. Separates a page whose paths resolve from one pointing at a deleted file.
 * - a row's guard cell and its last cell blanked: the ownership test goes red naming the class.
 *   Separates a table where every class has an owner or an issue from one with an orphan.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PAGE = 'docs/explanation/confidentiality-guards.md';
const text = readFileSync(`${REPO_ROOT}${PAGE}`, 'utf8');

/** The rows of the first table under the classification heading, split into trimmed cells. */
function classificationRows() {
	const start = text.indexOf('## Four classes of data');
	const section = text.slice(start, text.indexOf('\n## ', start + 1));
	return section
		.split('\n')
		.filter((line) => line.startsWith('|'))
		.slice(2) // header and separator
		.map((line) =>
			line
				.slice(1, -1)
				.split('|')
				.map((cell) => cell.trim())
		);
}

/** Code-formatted words that look like repository paths: a slash or a leading dot, no spaces. */
function pathsIn(fragment: string) {
	return [...fragment.matchAll(/`([^`\s]+)`/g)]
		.map((match) => match[1])
		.filter((word) => /^[.\w-]+(?:\/[\w.-]+)+$|^\.[\w.-]+$/.test(word));
}

describe('the confidentiality guards page matches the tree', () => {
	const rows = classificationRows();

	it('reads a classification table of four classes', () => {
		expect(rows.map((row) => row[0])).toEqual([
			'Secret',
			'Private reference',
			'Personal or statement-derived data',
			'Image metadata'
		]);
	});

	it('names only paths that exist', () => {
		const paths = pathsIn(text);
		// Calibration: the page names well over a handful of paths; zero would mean the extraction
		// stopped matching, not that the page names none.
		expect(paths.length).toBeGreaterThan(10);
		const missing = paths.filter((path) => !existsSync(`${REPO_ROOT}${path}`));
		expect(missing, `${PAGE} names paths that do not exist`).toEqual([]);
	});

	it('gives every class a guard that exists, or an issue for what none catches', () => {
		expect(rows.length).toBeGreaterThan(0);
		const orphans = rows
			.filter((row) => {
				const guards = pathsIn(row[2] ?? '').filter((path) => existsSync(`${REPO_ROOT}${path}`));
				const issue = /#\d+/.test(row[4] ?? '');
				return guards.length === 0 && !issue;
			})
			.map((row) => row[0]);
		expect(orphans, 'classes with no existing guard and no issue').toEqual([]);
	});
});
