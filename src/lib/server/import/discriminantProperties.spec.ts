import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ParsedCsvRow } from './types';
import {
	DISCRIMINANT_LENGTH,
	findDiscriminantColumn,
	type DiscriminantResult
} from './discriminant';

/**
 * The property `findDiscriminantColumn` exists to hold: a constant identifier column is found and
 * a varying one is REFUSED by name, never dropped into a silent `none`.
 *
 * ## The calibration runs first and it MUST FAIL
 *
 * A clean run of a property test proves nothing about the generator. MEASURED on this repository
 * 2026-08-22, in `dedupeKeyInjectivity.spec.ts`: the same shape of fuzz, pointed at the KNOWN
 * non-injective builder it replaced, came back GREEN at 5 000 runs, because the generator drew from
 * an alphabet that could not produce the colliding pair. So a broken predicate that ignores
 * constancy is run FIRST, and the draw that caught it is printed rather than asserted away. The
 * form that leg takes is itself a measurement, recorded above it: `it.fails` cannot do this job
 * here.
 *
 * The broken predicate reads the grammar OUT OF THE PRODUCTION FUNCTION, by asking it about a
 * one-column file whose single value is repeated. A grammar retyped here would let the calibration
 * pass for the wrong reason: narrower than the code, it would call every generated identifier
 * unmatched and report a clean refusal from a predicate that refuses everything.
 *
 * ## The file is generated as ONE unit
 *
 * A column cannot be both constant and varying, and drawing the values and the constancy separately
 * would let that tuple exist. The identifier column's values are drawn as a whole list, and the
 * noise around them is drawn to fit that list's length.
 *
 * ## The noise alphabet is calibrated too
 *
 * Every property below leans on the noise columns never qualifying. That is asserted, not assumed:
 * `a file of noise carries no identifier column` is the detector pointed at the absence it claims.
 */

/** Pinned, so a later clean run is comparable to this one rather than merely resembling it. */
const SEED = 20260822;
const RUNS = 500;

/**
 * French BBANs whose IBAN check digits are COMPUTED below rather than typed. The last one carries a
 * letter in the account number, which is legal in ISO 13616 and is the only thing that exercises
 * the checksum's letter expansion.
 *
 * Typing the check digits is how the plan's own multi-account fixture came to carry
 * `FR7630001007949876543210192`, which reads as an IBAN and verifies at 40 rather than 1.
 */
const BBANS = [
	'30001007941234567890185',
	'30001007949876543210192',
	'30001007945555555555512',
	'30004000031234567890143',
	'20041010050500013M02606'
];

/** The inverse of the check the production code runs: it verifies, this constructs. */
function ibanFor(country: string, bban: string): string {
	const expanded = `${bban}${country}00`.replace(/[A-Z]/g, (letter) =>
		String(letter.charCodeAt(0) - 55)
	);
	let remainder = 0;
	for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
	return `${country}${String(98 - remainder).padStart(2, '0')}${bban}`;
}

/**
 * Both branches of the grammar, in canonical form. The bare digit runs are the shape Boursorama's
 * `accountNum` really has (`profiles/realHeaders.fixture.ts` records `00012345678`).
 */
const IDENTIFIERS = [
	...BBANS.map((bban) => ibanFor('FR', bban)),
	'00012345678',
	'123456789',
	'98765432'
];

/**
 * Values that must never qualify: two date spellings, two labels, two amounts, a currency and the
 * empty cell. The amounts carry more than eight digits between them on purpose, so a grammar that
 * matched a SUBSTRING would be caught here rather than in production.
 */
const NOISE: fc.Arbitrary<string> = fc.constantFrom(
	'01/06/2026',
	'02/06/2026',
	'CARREFOUR MARKET',
	'VIREMENT SEPA RECU',
	'-1234,56',
	'12 345,67',
	'EUR',
	''
);

/** One identifier written three ways, all of which canonicalize to the same account. */
function spellingsOf(canonical: string): fc.Arbitrary<string> {
	return fc.constantFrom(
		canonical,
		canonical.toLowerCase(),
		canonical.replace(/(.{4})/g, '$1 ').trim()
	);
}

interface GeneratedFile {
	rows: ParsedCsvRow[];
	/** Where the drawn column was spliced in. */
	index: number;
	/** The canonical value of each data row's drawn cell, in row order. */
	canonical: string[];
}

/**
 * A whole file around one drawn column, so the column's shape and the file's shape cannot disagree.
 *
 * `rows[0]` is a header, because that is what `parseRows` returns and skipping it is the thing
 * `findDiscriminantColumn` has to get right.
 */
function fileAround(
	columnArb: fc.Arbitrary<Array<{ cell: string; canonical: string }>>
): fc.Arbitrary<GeneratedFile> {
	return columnArb.chain((column) =>
		fc.integer({ min: 0, max: 3 }).chain((otherColumns) =>
			fc.integer({ min: 0, max: otherColumns }).chain((index) =>
				fc
					.array(fc.array(NOISE, { minLength: otherColumns, maxLength: otherColumns }), {
						minLength: column.length,
						maxLength: column.length
					})
					.map((noise) => {
						const dataRows = column.map((drawn, row) => {
							const cells = [...noise[row]];
							cells.splice(index, 0, drawn.cell);
							return cells;
						});
						const header = dataRows[0].map((_, position) => `col${position}`);
						return {
							rows: [header, ...dataRows].map((cells, position) => ({
								cells,
								line: position + 1
							})),
							index,
							canonical: column.map((drawn) => drawn.canonical)
						};
					})
			)
		)
	);
}

/** One account, spelled freely, on one to five rows. */
const oneAccountColumn = fc
	.constantFrom(...IDENTIFIERS)
	.chain((canonical) =>
		fc
			.array(spellingsOf(canonical), { minLength: 1, maxLength: 5 })
			.map((cells) => cells.map((cell) => ({ cell, canonical })))
	);

/**
 * Two or more accounts, so the column is varying by CONSTRUCTION rather than by a filter. The
 * distinct set is drawn first and the extra rows are drawn from it, which is what lets a repeated
 * value appear without ever letting the column collapse to one account.
 */
const twoAccountColumn = fc
	.uniqueArray(fc.constantFrom(...IDENTIFIERS), { minLength: 2, maxLength: 3 })
	.chain((distinct) =>
		fc
			.array(fc.constantFrom(...distinct), { minLength: 0, maxLength: 3 })
			.chain((extra) =>
				fc.tuple(
					...[...distinct, ...extra].map((canonical) =>
						spellingsOf(canonical).map((cell) => ({ cell, canonical }))
					)
				)
			)
	) as fc.Arbitrary<Array<{ cell: string; canonical: string }>>;

const oneAccountFile = fileAround(oneAccountColumn);
const twoAccountFile = fileAround(twoAccountColumn);
const noiseOnlyFile = fileAround(
	fc
		.array(NOISE, { minLength: 1, maxLength: 5 })
		.map((cells) => cells.map((cell) => ({ cell, canonical: cell })))
);

/**
 * The production grammar, asked for rather than retyped: a value matches when a file whose only
 * column repeats it is `found`.
 */
function matchesGrammar(value: string): boolean {
	return (
		findDiscriminantColumn([
			{ cells: ['header'], line: 1 },
			{ cells: [value], line: 2 },
			{ cells: [value], line: 3 }
		]).kind === 'found'
	);
}

/** Ignores constancy: the first column whose every data value matches the grammar wins. */
function brokenFindDiscriminant(file: GeneratedFile): DiscriminantResult {
	const dataRows = file.rows.slice(1);
	const columnCount = dataRows.reduce((widest, row) => Math.max(widest, row.cells.length), 0);
	for (let index = 0; index < columnCount; index += 1) {
		const values = dataRows.map((row) => (row.cells[index] ?? '').trim());
		if (values.every((value) => value !== '' && matchesGrammar(value))) {
			return { kind: 'found', index, fragment: values[0].slice(-DISCRIMINANT_LENGTH) };
		}
	}
	return { kind: 'none' };
}

/**
 * **`it.fails` IS UNSOUND IN THIS REPOSITORY AND THE MEASUREMENT IS WHY THIS LEG IS SHAPED LIKE
 * THIS.** The obvious way to write a calibration is `it.fails(...)` around the property: the leg
 * passes because it fails, and a green file means the broken predicate was caught. Measured
 * 2026-08-22 by break-check, pointing this very property at the CORRECT function instead of the
 * broken one: the property then found nothing, the body printed `NOT CAUGHT ... total-draws=500`,
 * and the file still reported `3 passed | 1 expected fail` at exit 0.
 *
 * The cause is `vite.config.ts`'s `expect: { requireAssertions: true }`. A body that completes with
 * no assertion is failed by that setting, and `it.fails` accepts ANY failure, so an uncaught
 * calibration and a caught one are the same green. That is exactly the failure this file exists to
 * prevent, one level up: the detector that watches the detector was itself unfalsifiable.
 *
 * So the calibration is an ordinary `it` that CATCHES the property's throw and asserts the finding,
 * which is the form `dedupeKeyInjectivity.spec.ts` already uses. Break-checked in the same pass:
 * pointed at the correct function it goes red on `the property must reject the broken predicate`.
 */
describe('CALIBRATION: the property catches a predicate that ignores constancy', () => {
	it('rejects a predicate that ignores constancy, or nothing in this file measures anything', () => {
		expect.assertions(2);

		let draws = 0;
		let caughtAt: number | null = null;
		let rejected = false;
		try {
			fc.assert(
				fc.property(twoAccountFile, (file) => {
					draws += 1;
					const wrong = brokenFindDiscriminant(file).kind === 'found';
					if (wrong && caughtAt === null) caughtAt = draws;
					return !wrong;
				}),
				{ seed: SEED, numRuns: RUNS }
			);
		} catch {
			// The recorded draw is the report; the throw carries no more than it does.
			rejected = true;
		}

		// Printed rather than merely asserted: a calibration reporting a verdict and no figure cannot
		// be compared to a later run, and pinning the seed is what makes it comparable.
		console.log(
			`[discriminant-calibration] seed=${SEED} runs=${RUNS} rejected=${rejected} caught-at-draw=${caughtAt} total-draws=${draws}`
		);

		expect(rejected, 'the property must reject the broken predicate').toBe(true);
		expect(caughtAt, 'the generator must reach a file whose identifier column varies').not.toBe(
			null
		);
	});
});

describe('findDiscriminantColumn, as a property', () => {
	it('finds the column and exactly its last four characters, whenever one account is named', () => {
		fc.assert(
			fc.property(oneAccountFile, (file) => {
				const result = findDiscriminantColumn(file.rows);
				expect(result).toStrictEqual({
					kind: 'found',
					index: file.index,
					fragment: file.canonical[0].slice(-DISCRIMINANT_LENGTH)
				});
				expect(result.kind === 'found' && result.fragment.length).toBe(DISCRIMINANT_LENGTH);
			}),
			{ seed: SEED, numRuns: RUNS }
		);
	});

	it('refuses by name, and never answers found, whenever more than one account is named', () => {
		fc.assert(
			fc.property(twoAccountFile, (file) => {
				expect(findDiscriminantColumn(file.rows)).toStrictEqual({
					kind: 'multi-account',
					index: file.index
				});
			}),
			{ seed: SEED, numRuns: RUNS }
		);
	});

	// The noise alphabet every property above leans on, pointed at the absence it claims.
	it('carries no identifier column in a file made only of dates, labels and amounts', () => {
		fc.assert(
			fc.property(noiseOnlyFile, (file) => {
				expect(findDiscriminantColumn(file.rows)).toStrictEqual({ kind: 'none' });
			}),
			{ seed: SEED, numRuns: RUNS }
		);
	});
});
