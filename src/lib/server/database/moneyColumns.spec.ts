import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { moneyColumnsExtension } from './moneyColumns.ts';

/**
 * The three gates around the money-column seam, and why none of them is a typecheck.
 *
 * `moneyColumns.ts` narrows eight `BigInt` columns to `number` on read. Two shapes escape it, and
 * they escape in opposite ways:
 *
 * - **`aggregate`/`groupBy`** typecheck as `number` and return a `bigint`. MEASURED both ways. So
 *   `npm run check` reports CLEAN over a site that throws, and the typechecker cannot be the
 *   detector because the typechecker is the thing that is wrong.
 * - **`$queryRaw`** returns a `bigint` and typechecks as whatever the caller declares, so there is
 *   no compile-time signal at all.
 *
 * Both are therefore gated by reading the sources, which is the same move `injection-sinks.spec.ts`
 * makes and for the same reason. The run-time half lives in `moneyColumns.db-smoke.ts`, because
 * only a real client can show what an aggregate actually returns.
 */

const SCHEMA = 'prisma/schema.prisma';

/** Every `Model.field` the authored schema declares as `BigInt`. */
function bigIntColumns(): string[] {
	const found: string[] = [];
	let model = '';
	for (const line of readFileSync(SCHEMA, 'utf8').split('\n')) {
		const start = /^model (\w+) \{$/.exec(line);
		if (start) model = start[1];
		const field = /^\s+(\w+)\s+BigInt\b/.exec(line);
		if (field && model) found.push(`${model}.${field[1]}`);
	}
	return found.sort();
}

/** Every `Model.field` the extension narrows, as the extension itself declares them. */
function narrowedColumns(): string[] {
	return Object.entries(moneyColumnsExtension.result)
		.flatMap(([model, fields]) =>
			Object.keys(fields).map((field) => `${model[0].toUpperCase()}${model.slice(1)}.${field}`)
		)
		.sort();
}

/**
 * Production sources: the tree minus specs, fixtures and generated clients.
 *
 * `.mjs` is included, and that is not a detail. The operator scripts under `scripts/` are plain
 * Node with no typecheck behind them, so the compile error that catches a missing denomination in
 * a `.ts` file catches nothing there. Filtering to `.ts` and `.svelte` left `scripts/seed-dev.mjs`
 * invisible to every gate in this file at once.
 */
function productionSources(): Array<{ file: string; source: string }> {
	return execFileSync('git', ['ls-files', 'src', 'scripts'], { encoding: 'utf8' })
		.split('\n')
		.filter((file) => /\.(ts|mjs|svelte)$/.test(file))
		.filter((file) => !/\.spec\.ts$|\.db-smoke\.ts$|database\/generated\//.test(file))
		.map((file) => ({ file, source: readFileSync(file, 'utf8') }));
}

const MONEY_FIELDS = [
	'amountCents',
	'balanceCents',
	'targetAmountCents',
	'currentAmountCents',
	'startingBalanceCents'
];

describe('the money-column extension', () => {
	// Without this the literal below could drift from the schema in either direction, and both
	// directions are silent: a column the extension misses reads as `bigint` while typechecking as
	// `bigint` too, so nothing complains until something adds it to a number.
	it('narrows exactly the columns the schema declares as BigInt', () => {
		expect.assertions(2);

		expect(bigIntColumns()).toHaveLength(8);
		expect(narrowedColumns()).toEqual(bigIntColumns());
	});
});

/** The statements from `rawStatements` that name a money column. Shared by the gate and its own calibration. */
function namesAMoneyColumn(statements: string[]): string[] {
	return statements.filter((text) => MONEY_FIELDS.some((field) => text.includes(field)));
}

describe('the two shapes the extension does not reach', () => {
	it('wraps every production aggregate over a money column in a narrowing call', () => {
		expect.assertions(2);

		const aggregateReads = productionSources().flatMap(({ file, source }) =>
			source
				.split('\n')
				.map((line, index) => ({ file, line: index + 1, text: line }))
				.filter(({ text }) => /\b_(sum|avg|min|max)\.\w*[Cc]ents\b/.test(text))
		);

		// Calibration, and the reason this test can be believed: the repository HAS such reads. A
		// gate over an empty set passes by reporting nothing, which is what a broken matcher also
		// does.
		expect(aggregateReads.length).toBeGreaterThan(0);

		const unwrapped = aggregateReads
			.filter(({ text }) => !/\bto(Nullable)?MinorUnits\(/.test(text))
			.map(({ file, line, text }) => `${file}:${line} ${text.trim()}`);

		expect(unwrapped).toEqual([]);
	});

	// The hole `seed-dev.mjs` fell through. Every `.ts` create site is held by the typechecker,
	// because the columns are required and have no database default. A `.mjs` operator script has
	// no typechecker behind it at all, so the same omission is silent there until somebody runs the
	// script and Prisma refuses the insert.
	it('gives every money-bearing write in a plain-Node script a denomination', () => {
		expect.assertions(2);

		const MONEY_MODELS = [
			'transaction',
			'monthlyBudget',
			'netWorthAccount',
			'netWorthSnapshot',
			'savingsGoal',
			'account'
		];
		const writes = productionSources()
			.filter(({ file }) => file.endsWith('.mjs'))
			.flatMap(({ file, source }) =>
				source
					.split('\n')
					.map((text, index) => ({ file, line: index + 1, text }))
					.filter(({ text }) =>
						MONEY_MODELS.some(
							(model) => text.includes(`.${model}.create`) || text.includes(`.${model}.upsert`)
						)
					)
			);

		// Calibration on the label being counted, not one that travels with it: the repository HAS
		// such writes, so a matcher that found none would report this clean for the wrong reason.
		expect(writes.length).toBeGreaterThan(0);

		const undenominated = writes
			.filter(({ file, line, text }) => {
				const source = productionSources().find((entry) => entry.file === file)!.source;
				// The `data`/`create` object can be several lines below the call, so look at the
				// statement rather than the line: from the call to the end of its object literal.
				const window = source
					.split('\n')
					.slice(line - 1, line + 14)
					.join('\n');
				return !/DEFAULT_DENOMINATION|restoredDenomination|currency:/.test(window) && text;
			})
			.map(({ file, line }) => `${file}:${line}`);

		expect(undenominated).toEqual([]);
	});

	/**
	 * Every raw statement in a source, as its WHOLE text rather than the line the call sits on.
	 *
	 * Line-scoped was the first version and it could not have caught the thing it exists for. Every
	 * raw call in the tree today is a one-line `SELECT 1` or advisory-lock probe, so requiring the
	 * `$queryRaw` token and the column name on the same line happened to hold. The statement this
	 * gate is written against looks like this:
	 *
	 * ```ts
	 * const rows = await prisma.$queryRaw`
	 *   SELECT SUM("amountCents") AS total FROM "Transaction" WHERE "userId" = ${userId}
	 * `;
	 * ```
	 *
	 * The token and the column are on different lines, so the gate would have reported clean over
	 * exactly the shape its own docstring describes.
	 */
	function rawStatements(source: string): string[] {
		const found: string[] = [];
		const CALL = /\$(query|execute)Raw(Unsafe)?\b/g;
		// Comments stripped first, or this file's own docstring about `$queryRaw` and `amountCents`
		// is a finding. A gate that trips on prose describing it is a gate somebody suppresses the
		// first time it is inconvenient, and the calibration below keeps the stripping honest: the
		// probe carries no comments, so blinding the extractor here reddens there.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
		for (const match of code.matchAll(CALL)) {
			// From the call to the end of the tagged template or argument list. Generous rather than
			// exact: over-reading risks a false positive, which is loud, and under-reading risks a
			// false clean, which is the failure this whole file is about.
			found.push(code.slice(match.index, code.indexOf(';', match.index) + 1 || undefined));
		}
		return found;
	}

	it('has no production raw SQL naming a money column', () => {
		expect.assertions(3);

		const statements = productionSources().flatMap(({ file, source }) =>
			rawStatements(source).map((text) => ({ file, text }))
		);

		// Calibration one: the repository HAS raw statements, so an extractor that found none would
		// report this clean for the wrong reason.
		expect(statements.length).toBeGreaterThan(0);

		// Calibration two, and it is the half that actually discriminates. The first version
		// asserted only that raw calls exist, which says nothing about whether the FIELD matcher can
		// ever fire. Point it at a statement built to be found: if this stops matching, the gate
		// below is reporting about itself.
		const probe = [
			'await prisma.$queryRaw`',
			'  SELECT SUM("amountCents") AS total FROM "Transaction"',
			'`;'
		].join('\n');
		expect(namesAMoneyColumn(rawStatements(probe))).toHaveLength(1);

		// If this ever fails the answer is not to widen it. A raw read of a money column returns a
		// bigint through a seam no extension sees, and the caller's declared type will say
		// otherwise, so the new statement has to narrow explicitly.
		expect(
			statements.filter(({ text }) => MONEY_FIELDS.some((field) => text.includes(field)))
		).toEqual([]);
	});
});
