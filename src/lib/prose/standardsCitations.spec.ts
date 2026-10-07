import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	SPELLINGS,
	calibrationFailure,
	citationResolves,
	findCitations,
	loadStandards,
	type Citation
} from '../../../scripts/standards-citations.mjs';
import { containsNulByte } from '../server/security/sourceScan';

/**
 * Every ASVS and AISVS identifier cited in a tracked file resolves against the tracked copy of its
 * standard (#650).
 *
 * WHY A GATE. An identifier with requirement text written to fit it is internally consistent, so
 * nothing else catches it: it reads exactly like a verified claim. #650 is the instance, an ASVS
 * number that never existed, quoted with a sentence invented to match it, inside a session whose
 * own prompt said to quote from the local file. The cite skill resolves BEFORE writing; this reads
 * what was written anyway.
 *
 * ONE SOURCE. The parse of both standards and the matcher for every spelling live in
 * `scripts/standards-citations.mjs`, which `.claude/skills/cite/scripts/resolve.mjs` also imports,
 * so the skill and the gate cannot disagree about what exists. This file keeps its OWN planted
 * sample and its own literal expectation of what the matcher finds in it, so the test and the
 * thing under test do not share a source.
 *
 * WHAT IS READ: every tracked file, minus the binary ones (a NUL byte, `containsNulByte`) and minus
 * the standards' own text, which is every file a `SHA256SUMS` under `docs/reference/standards/`
 * pins to upstream. That text is the reference, not a citation of it: AISVS's own RELEASE.md uses
 * an example identifier to explain its numbering. Our README and PROVENANCE files in the same
 * directories are not pinned, so they are read.
 *
 * THIS FILE IS IN THE POPULATION IT SCANS, so every unresolvable identifier below is assembled at
 * run time, and the allowlist names its identifier as bare digits, a form no spelling matches.
 *
 * BREAK-CHECKED on 2026-10-07, each clause separately, foreground, restored from a pre-break copy
 * in a `finally` and compared by sha256 afterwards:
 *
 * - (a) A real identifier in a tracked doc (`SECURITY.md`, `6.5.5` in its versioned form) changed
 *   to one the standard does not hold (`6.5.99`): only the tree test goes red, naming
 *   `SECURITY.md:144`, the text matched and its spelling. Separates a tree whose citations all
 *   exist from one carrying an invented one.
 * - (b) The `dateReading.ts` allowlist entry removed: only the tree test goes red, on line 77 of
 *   that file and nothing else. Separates a deliberate mention of a nonexistent identifier that is
 *   admitted by name from the same mention admitted by nothing.
 * - (c) A stale entry added (a path and line text that carry no unresolved citation): only the
 *   staleness test goes red, naming the entry. Separates an allowlist whose every entry still
 *   admits something from one carrying an entry that would silently admit a future slip.
 * - (d) The matcher replaced by one that matches nothing (`matchAll` over an empty pattern in
 *   `findCitations`): the floor goes red (0 resolved), the calibration goes red (nothing found),
 *   and the staleness test goes red (both entries admit nothing); the tree test stays GREEN, which
 *   is the whole reason the floor exists. Separates a scan that read the tree's citations from one
 *   that read none and reports a clean tree.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Deliberate mentions of an identifier that does not exist, admitted per LINE: the path, the
 * identifier, and a fragment of the line's text. A slip elsewhere in the same file is still caught.
 * An entry that admits nothing fails the staleness test, so a reworded line takes its entry with it.
 */
const ALLOWED_UNRESOLVED: readonly {
	path: string;
	standard: 'ASVS' | 'AISVS';
	id: string;
	lineIncludes: string;
	reason: string;
}[] = [
	{
		path: 'src/lib/domain/dateReading.ts',
		standard: 'ASVS',
		id: '5.1.4',
		lineIncludes: 'The identifier here was',
		reason:
			'The correction note for #650: it names the invented identifier this function first carried, ' +
			'so the correction itself is readable.'
	},
	{
		path: 'src/routes/import/columns/page.server.spec.ts',
		standard: 'ASVS',
		id: '5.1.4',
		lineIncludes: 'It read',
		reason: 'The same correction note for #650, at the second site that carried the identifier.'
	}
];

/** What a reader of a red run needs, printed with every finding. */
const HOW_TO_READ = [
	'Each line is file:line, the text matched, the standard, and the spelling that matched it.',
	'Check it with `node .claude/skills/cite/scripts/resolve.mjs <id>` (prefix aisvs: for AISVS).',
	'TRUE POSITIVE: the line means to cite that standard and resolve.mjs says NOT FOUND. The identifier',
	'is invented or mistyped: find the requirement in the tracked copy and correct it. If the line',
	'names a nonexistent identifier ON PURPOSE (a correction note), add an ALLOWED_UNRESOLVED entry',
	'with its reason in this file.',
	'ARTEFACT: the matched text is not a citation of that standard (a product version, a number that',
	'only looks like one). Then the spelling misread: narrow its pattern in',
	'scripts/standards-citations.mjs, never the allowlist.'
].join('\n');

/**
 * The planted sample, run through the same matcher and resolver in the same pass as the tree.
 * Unresolvable identifiers are assembled at run time; see the file comment.
 */
const join = (...parts: string[]) => parts.join('');
const CALIBRATION_TEXT = [
	// One resolvable and one unresolvable per spelling.
	join('a v5.0.0-', '8.2.2', ' and a v5.0.0-', '99.1.1', '.'),
	// The historical failure itself, the identifier #650 found.
	join('the row V', '8.2.2', ', and V', '5.1.4', ' which never existed'),
	join('a section V', '5.1', ' and none at V', '5.9', ';'),
	join('ASVS 5.0.0 ', '14.1.1', ' and ASVS 5.0 `', '14.1.99', '`'),
	join('`aisvs:', '9.2.1', '` and aisvs:C', '9.2.99'),
	join('v1.0-C', '9.2.1', ' and v1.0-C', '9.99.1'),
	join('AISVS C', '9.2', ' and AISVS 1.0 ', '99.1.1'),
	// A four-part slip is captured whole and fails, rather than read as its first three parts.
	join('v5.0.0-', '8.2.2.1'),
	// A list names the standard once. Words that are not a separator end it, so the last one is
	// read by its own spelling and not as part of the list.
	join(
		'(`v5.0.0-',
		'8.2.2',
		'`, `',
		'8.3.1',
		'`/',
		'8.4.1',
		' through ',
		'8.4.99',
		' and not V',
		'8.1.1)'
	),
	// Negatives: the tree carries each of these and none is a citation.
	'self-assessed against ASVS 5.0.0 Level 2, AISVS 1.0 is locked, Node 24.18.0, v1.2.3',
	join('V', '5.0.0-', '8.2.2', ' in capitals is one citation, not two')
].join('\n');

/** Written out by hand, so it does not share a source with the matcher. */
const EXPECTED_CALIBRATION = [
	{ line: 1, spelling: 'asvs-versioned', id: '8.2.2', resolves: true },
	{ line: 1, spelling: 'asvs-versioned', id: '99.1.1', resolves: false },
	{ line: 2, spelling: 'asvs-v-prefixed', id: '8.2.2', resolves: true },
	{ line: 2, spelling: 'asvs-v-prefixed', id: '5.1.4', resolves: false },
	{ line: 3, spelling: 'asvs-v-prefixed', id: '5.1', resolves: true },
	{ line: 3, spelling: 'asvs-v-prefixed', id: '5.9', resolves: false },
	{ line: 4, spelling: 'asvs-after-name', id: '14.1.1', resolves: true },
	{ line: 4, spelling: 'asvs-after-name', id: '14.1.99', resolves: false },
	{ line: 5, spelling: 'aisvs-colon', id: '9.2.1', resolves: true },
	{ line: 5, spelling: 'aisvs-colon', id: '9.2.99', resolves: false },
	{ line: 6, spelling: 'aisvs-versioned', id: '9.2.1', resolves: true },
	{ line: 6, spelling: 'aisvs-versioned', id: '9.99.1', resolves: false },
	{ line: 7, spelling: 'aisvs-after-name', id: '9.2', resolves: true },
	{ line: 7, spelling: 'aisvs-after-name', id: '99.1.1', resolves: false },
	{ line: 8, spelling: 'asvs-versioned', id: '8.2.2.1', resolves: false },
	{ line: 9, spelling: 'asvs-versioned', id: '8.2.2', resolves: true },
	{ line: 9, spelling: 'asvs-versioned+list', id: '8.3.1', resolves: true },
	{ line: 9, spelling: 'asvs-versioned+list', id: '8.4.1', resolves: true },
	{ line: 9, spelling: 'asvs-versioned+list', id: '8.4.99', resolves: false },
	{ line: 9, spelling: 'asvs-v-prefixed', id: '8.1.1', resolves: true },
	{ line: 11, spelling: 'asvs-versioned', id: '8.2.2', resolves: true }
];

type Located = Citation & { path: string; text: string; resolves: boolean };

/** Files whose bytes a `SHA256SUMS` under `docs/reference/standards/` pins to upstream. */
function upstreamCopies(tracked: string[]): Set<string> {
	const pinned = new Set<string>();
	for (const sums of tracked.filter((p) =>
		/^docs\/reference\/standards\/[^/]+\/SHA256SUMS$/.test(p)
	)) {
		const dir = sums.slice(0, -'SHA256SUMS'.length);
		for (const line of readFileSync(`${REPO_ROOT}${sums}`, 'utf8').split('\n')) {
			const name = line.trim().split(/\s+\*?/)[1];
			if (name) pinned.add(`${dir}${name}`);
		}
	}
	return pinned;
}

/** One pass: the tree and the planted sample through the same matcher and the same resolver. */
function scanTree() {
	const standards = loadStandards(REPO_ROOT);
	const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
		.split('\0')
		.filter(Boolean);
	const pinned = upstreamCopies(tracked);

	const locate = (path: string, text: string): Located[] => {
		const lines = text.split('\n');
		return findCitations(text).map((c) => ({
			...c,
			path,
			text: lines[c.line - 1],
			resolves: citationResolves(standards, c)
		}));
	};

	let filesRead = 0;
	let binarySkipped = 0;
	let upstreamSkipped = 0;
	const citations: Located[] = [];
	for (const path of tracked) {
		if (pinned.has(path)) {
			upstreamSkipped += 1;
			continue;
		}
		const bytes = readFileSync(`${REPO_ROOT}${path}`);
		if (containsNulByte(bytes)) {
			binarySkipped += 1;
			continue;
		}
		filesRead += 1;
		citations.push(...locate(path, bytes.toString('utf8')));
	}

	const admitted = (c: Located) =>
		ALLOWED_UNRESOLVED.some(
			(entry) =>
				entry.path === c.path &&
				entry.standard === c.standard &&
				entry.id === c.id &&
				c.text.includes(entry.lineIncludes)
		);
	const unresolved = citations.filter((c) => !c.resolves);

	return {
		calibrationFailure: calibrationFailure(standards),
		tracked: tracked.length,
		pinned: pinned.size,
		filesRead,
		binarySkipped,
		upstreamSkipped,
		citations,
		resolved: citations.filter((c) => c.resolves).length,
		offenders: unresolved.filter((c) => !admitted(c)),
		stale: ALLOWED_UNRESOLVED.filter(
			(entry) =>
				!unresolved.some(
					(c) =>
						entry.path === c.path &&
						entry.standard === c.standard &&
						entry.id === c.id &&
						c.text.includes(entry.lineIncludes)
				)
		),
		calibration: locate('<calibration>', CALIBRATION_TEXT)
	};
}

describe('every ASVS and AISVS citation in a tracked file resolves', () => {
	const scan = scanTree();

	// Printed rather than only asserted, so a reader of a green run can see what it read.
	const perSpelling = SPELLINGS.flatMap(({ name }) => [name, `${name}+list`])
		.map((name) => `${name} ${scan.citations.filter((c) => c.spelling === name).length}`)
		.join(', ');
	console.info(
		`standardsCitations: read ${scan.filesRead} of ${scan.tracked} tracked files ` +
			`(${scan.binarySkipped} binary, ${scan.upstreamSkipped} upstream copies skipped); ` +
			`${scan.citations.length} citations, ${scan.resolved} resolved; ${perSpelling}`
	);

	it('reads the standards and a real population, so a clean result cannot mean an empty one', () => {
		expect.assertions(4);

		expect(scan.calibrationFailure).toBeNull();
		// Measured 2026-10-07 on the commit that added this file: 1206 of 1324 tracked files read,
		// 365 of 367 citations resolved (the other 2 are the allowlisted lines), 40 upstream copies
		// skipped. The run prints the current figures. Each floor sits below its figure so an
		// ordinary edit does not move it; what it must not survive is the reading collapsing.
		expect(scan.filesRead).toBeGreaterThan(1000);
		expect(scan.resolved).toBeGreaterThan(300);
		// The exclusion is read from the SHA256SUMS files. Zero would mean their format moved and the
		// standards' own text is being read as citations.
		expect(scan.upstreamSkipped).toBeGreaterThan(30);
	});

	it('finds every planted citation, and resolves each one the way it was planted', () => {
		expect.assertions(1);

		expect(
			scan.calibration.map(({ line, spelling, id, resolves }) => ({ line, spelling, id, resolves }))
		).toEqual(EXPECTED_CALIBRATION);
	});

	it('finds no citation that does not resolve, outside the lines allowed by name', () => {
		expect.assertions(1);

		const offenders = scan.offenders.map(
			(c) => `${c.path}:${c.line}  ${c.raw}  (${c.standard}, spelling ${c.spelling})`
		);
		// Named in the message as well as the diff, because not every reporter prints the diff.
		expect(offenders, `\n${offenders.join('\n')}\n\n${HOW_TO_READ}\n`).toEqual([]);
	});

	it('carries no allowlist entry that admits nothing', () => {
		expect.assertions(1);

		expect(
			scan.stale.map(
				(entry) => `${entry.path}: ${entry.standard} ${entry.id} "${entry.lineIncludes}"`
			),
			'An entry whose line was reworded or removed: delete the entry, it would admit a future slip.'
		).toEqual([]);
	});
});
