import { describe, expect, it } from 'vitest';
import { containsNulByte, readSourceBytes, searchableSourceFiles } from './sourceScan';

/**
 * No text file in this repository may contain a NUL byte, because one makes that file invisible to
 * every text search.
 *
 * ## Why this exists rather than a note
 *
 * `grep`, `rg` and `git grep` decide a file is binary by looking for a NUL in its first block, and
 * then print `binary file matches` with no lines, or nothing at all. A scope figure, an audit, a
 * worklist or a refactor built from a text search silently omits the file.
 *
 * This repository measured that once on `src/lib/server/naming/mergePlan.ts` (#175), wrote down
 * the habit ("when a grep returns zero for something you have reason to expect, calibrate it") and
 * wrote down the figure ("71 tracked files contain a NUL, 70 of them PNG screenshots").
 *
 * **Neither the habit nor the figure held.** On 2026-08-14 `mapping/fingerprint.ts` shipped with
 * two of them, in a comment reading "never a literal NUL byte", which took the tracked figure to 72
 * with nothing noticing. Four consecutive greps returning zero were read as facts about the file's
 * structure rather than about the search.
 *
 * So the note becomes a check. A recorded measurement is evidence about the day it was taken; this
 * runs on every push.
 */
describe('no source file is invisible to a text search', () => {
	const files = searchableSourceFiles();

	it('reads a real population, not an empty one', () => {
		// The absolute figure that separates "nothing offends" from "nothing was read". A scan whose
		// enumeration is wrong reports a perfectly clean tree, which is the failure mode this whole
		// file is about, one level up.
		//
		// Measured 2026-08-14: 662 of 813 tracked files. The floor is 600 rather than 662 because a
		// PR that deletes a dozen files is ordinary; what it must not survive is the enumeration
		// silently collapsing.
		expect(files.length).toBeGreaterThan(600);

		// A floor alone cannot see a whole CATEGORY vanishing, because 75 Svelte components going
		// missing still clears 600 comfortably. One presence assertion per extension that carries a
		// real population is what closes that band.
		for (const extension of ['.ts', '.svelte', '.md', '.json', '.yml', '.prisma']) {
			expect(
				files.filter((path) => path.endsWith(extension)).length,
				`no ${extension} file reached the scan`
			).toBeGreaterThan(0);
		}
	});

	it('can detect the thing it asserts is absent', () => {
		// The presence half, and it is not optional: an absence assertion whose detector cannot
		// detect passes on a tree full of offenders. Point the production predicate, not a retyped
		// copy of it, at bytes that really do carry a NUL.
		// Built from an ESCAPE rather than typed as the byte, because this spec file is itself in
		// the population it scans: a calibration fixture carrying a literal NUL would make the
		// guard fail on its own source, which is the one way to make a good check get deleted.
		const offending = Buffer.from('const separator = "a\u0000b";\n', 'utf8');
		const clean = Buffer.from('const separator = "a\\u0000b";\n', 'utf8');

		expect(containsNulByte(offending)).toBe(true);
		expect(containsNulByte(clean)).toBe(false);
	});

	it('finds none, and names any it finds', () => {
		const offenders = files.filter((path) => containsNulByte(readSourceBytes(path)));

		// Named rather than counted: "3 offenders" sends the next reader to a grep that cannot see
		// them, which is the joke this defect plays every time.
		expect(offenders).toEqual([]);
	});
});
