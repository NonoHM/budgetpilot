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

/** Production sources: the tree minus specs, fixtures and generated clients. */
function productionSources(): Array<{ file: string; source: string }> {
	return execFileSync('git', ['ls-files', 'src', 'scripts'], { encoding: 'utf8' })
		.split('\n')
		.filter((file) => /\.(ts|svelte)$/.test(file))
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

	it('has no production raw SQL naming a money column', () => {
		expect.assertions(2);

		const rawFiles = productionSources().filter(({ source }) =>
			/\$(query|execute)Raw(Unsafe)?\b/.test(source)
		);

		// Same calibration. Every raw call in the tree today is an advisory lock or a privilege
		// probe, and a matcher that found none of those would report this clean for the wrong
		// reason.
		expect(rawFiles.length).toBeGreaterThan(0);

		const naming = rawFiles
			.flatMap(({ file, source }) =>
				source
					.split('\n')
					.map((text, index) => ({ file, line: index + 1, text }))
					.filter(
						({ text }) =>
							/\$(query|execute)Raw(Unsafe)?\b/.test(text) &&
							MONEY_FIELDS.some((field) => text.includes(field))
					)
			)
			.map(({ file, line }) => `${file}:${line}`);

		// If this ever fails the answer is not to widen it. A raw read of a money column returns a
		// bigint through a seam no extension sees, and the caller's declared type will say
		// otherwise, so the new statement has to narrow explicitly.
		expect(naming).toEqual([]);
	});
});
