import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assignDedupeKeys, foldLabelForSource, type KeyableRow } from './dedupeRecompute';

/**
 * The key format is injective: two DIFFERENT field tuples never produce ONE key.
 *
 * ## Why a property rather than more examples
 *
 * The format this replaced was unambiguous by an ARGUMENT rather than by construction. Every field
 * after the label happened to be delimiter-free by its own grammar, so the boundaries were
 * recoverable from the right. That argument was never written down, it had to be re-derived to add
 * a field, and it did not hold for the provider branch, which joined two provider-supplied values
 * with a character both can contain. Examples cannot close that: the failure mode is a shape nobody
 * thought to write an example for.
 *
 * ## The calibration is the point, and it runs FIRST
 *
 * A clean run of a property test proves nothing about the generator. So the SAME property is
 * pointed at the builder this format replaced, and it MUST FAIL. If the calibrated leg comes back
 * green, the generator does not reach the shape that collides and the run below is a clean result
 * about nothing.
 *
 * **MEASURED, and it is why the generator looks the way it does.** A first version drew both
 * provider fields from a random six-character alphabet and the calibration came back GREEN at
 * 5 000 runs: the colliding pair needs two specific values in two specific fields across two
 * separate draws, and chance does not deliver that. The provider fields are now drawn from a small
 * set chosen to CONTAIN the colliding pair, `("a", "b:c")` against `("a:b", "c")`.
 *
 * ## What the generator refuses to produce, and why that is not a weakening
 *
 * A bucket is drawn WHOLE, so `source` and `providerAccountId` travel with `accountId`. An
 * `Account` has one source and one provider mapping, so a row cannot carry an account from one
 * bucket and a source from another. A first version drew them independently and reported a
 * collision on `(same account, different source)`, which the key does not distinguish and does not
 * need to, because the account determines the source. Generating impossible tuples turns a property
 * test into a report about the generator.
 *
 * The seed and the run count are pinned, so a later clean run is comparable to this one rather than
 * merely resembling it.
 */

/** Pinned, so this run is reproducible and a future one is comparable rather than similar. */
const SEED = 20260822;
const RUNS = 5000;

/**
 * Values chosen for what they DISTINGUISH rather than for what they read as: the field delimiter,
 * the escape character, the old provider delimiter, and the escape sequence the encoder emits. A
 * generator of ordinary merchant names would explore none of the shapes that can collide.
 */
const hostileText = fc.stringMatching(/^[ab|%:7c ]{0,6}$/);

/**
 * The pair the old provider key merged, plus the pieces around it. Small on purpose: with six
 * values in two fields the colliding combination is reached in a handful of draws instead of never.
 */
const providerField = fc.constantFrom('a', 'b:c', 'a:b', 'c', 'a|b', 'a%b');

/** A bucket is one row of `Account`, so these three fields cannot vary independently. */
const bucketArb = fc.oneof(
	fc.record({
		accountId: fc.constantFrom('acc-1', 'acc|1', 'acc%1', 'acc:1'),
		source: fc.constantFrom('csv', 'revolut', 'banque_populaire'),
		providerAccountId: fc.constant<string | null>(null)
	}),
	fc.record({
		accountId: fc.constantFrom('bank-1', 'bank|1'),
		source: fc.constantFrom('enablebanking', 'mock_connector'),
		providerAccountId: providerField.map((value): string | null => value)
	})
);

const tupleArb = fc.record({
	bucket: bucketArb,
	date: fc.constantFrom('2026-06-24', '2026-06-25'),
	label: hostileText,
	amountCents: fc.integer({ min: -500, max: 500 }),
	type: fc.constantFrom('income' as const, 'expense' as const),
	currency: fc.constantFrom('EUR', 'GBP'),
	exponent: fc.constantFrom(2, 3),
	entryReference: fc.option(providerField, { nil: null })
});

type Fields = {
	bucket: { accountId: string; source: string; providerAccountId: string | null };
	date: string;
	label: string;
	amountCents: number;
	type: 'income' | 'expense';
	currency: string;
	exponent: number;
	entryReference: string | null;
};

function toRow(fields: Fields): KeyableRow {
	return {
		id: 'only',
		source: fields.bucket.source,
		accountId: fields.bucket.accountId,
		date: fields.date,
		label: fields.label,
		amountCents: fields.amountCents,
		type: fields.type,
		currency: fields.currency,
		exponent: fields.exponent,
		providerAccountId: fields.bucket.providerAccountId,
		entryReference: fields.entryReference,
		keyed: true
	};
}

/**
 * What the tuple MEANS, as the key is supposed to distinguish it.
 *
 * BRANCH AWARE, and a first version was not, which the fuzz caught at once. A row carrying a
 * provider's per-account entry reference is identified by that reference and by nothing else: the
 * provider branch deliberately ignores the date, the label and the amount, because
 * `entry_reference` is the provider's own stable identifier within the account. Two such rows that
 * differ in content are the SAME transaction as far as this key is concerned, so an oracle
 * comparing their content reports a collision the format is supposed to produce.
 *
 * That is a property of the design and the design says so: it trusts the provider's promise that
 * the reference is immutable per account, and records that if the promise turns out to be false the
 * mitigation is to notice rather than to widen the key.
 *
 * The label is compared FOLDED, because the fold is part of the key's meaning: two labels that fold
 * together are one label, and comparing raw labels would report a collision the key must produce.
 */
function identity(fields: Fields): string {
	const reference = fields.entryReference?.trim() ?? '';
	if (fields.bucket.providerAccountId && reference) {
		return JSON.stringify([
			'provider',
			fields.bucket.source,
			fields.bucket.providerAccountId,
			reference
		]);
	}
	return JSON.stringify([
		'content',
		fields.date,
		foldLabelForSource(fields.bucket.source, fields.label),
		Math.abs(fields.amountCents),
		fields.type,
		fields.bucket.accountId,
		fields.currency,
		fields.exponent
	]);
}

/** The provider key as it was built BEFORE this format: two provider fields joined by a colon. */
function preFixProviderKey(fields: Fields): string | null {
	const reference = fields.entryReference?.trim() ?? '';
	if (!fields.bucket.providerAccountId || !reference) return null;
	return `${fields.bucket.source}:${fields.bucket.providerAccountId}:${reference}`;
}

/** Runs the injectivity property over `build`, returning the first collision or null. */
function findCollision(
	build: (fields: Fields) => string | null
): { key: string; left: string; right: string } | null {
	const seen = new Map<string, string>();
	let collision: { key: string; left: string; right: string } | null = null;

	// `fc.assert` throws on a failing property, and in the calibrated leg a failure is the expected
	// result, so the throw is caught in both and the finding is read off the recorded collision.
	try {
		fc.assert(
			fc.property(tupleArb, (fields) => {
				const key = build(fields as Fields);
				if (key === null) return true;
				const meaning = identity(fields as Fields);
				const previous = seen.get(key);
				if (previous !== undefined && previous !== meaning) {
					collision ??= { key, left: previous, right: meaning };
					return false;
				}
				seen.set(key, meaning);
				return true;
			}),
			{ seed: SEED, numRuns: RUNS, endOnFailure: true }
		);
	} catch {
		// The recorded collision is the report; the throw carries no more than it does.
	}

	return collision;
}

describe('CALIBRATION: the property finds the collision the old builder had', () => {
	it('fails against the colon-joined provider key, or nothing in this file measures anything', () => {
		expect.assertions(2);

		const collision = findCollision(preFixProviderKey);
		// Printed rather than merely asserted: a calibration that reports a verdict and no figure
		// cannot be compared to a later run, and the whole point of pinning the seed is that it can.
		console.log(
			`[fuzz-calibration] seed=${SEED} runs=${RUNS} collision=${JSON.stringify(collision)}`
		);

		// A green calibration means the generator never reached the colliding shape, and the run
		// below would be a clean result about nothing at all.
		expect(collision, 'the generator must reach the shape that collides').not.toBe(null);
		// Two different provider triples, one key: the defect in kind, rather than any disagreement
		// the oracle happened to notice.
		expect(collision!.left).not.toBe(collision!.right);
	});
});

describe('the current key format is injective', () => {
	it('never produces one key for two different field tuples', () => {
		expect.assertions(1);

		expect(findCollision((fields) => assignDedupeKeys([toRow(fields)]).get('only') ?? null)).toBe(
			null
		);
	});
});
