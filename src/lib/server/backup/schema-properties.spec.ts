import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { backupExportSchema } from './schema';

/**
 * Property-based coverage of the backup restore validator, the second attacker-facing parser in
 * this application. The payload is uploaded by the user, so every field in it is hostile input,
 * and `restoreBackup` deletes the account's existing rows before writing what the file says.
 *
 * THE PROPERTY: `safeParse` REFUSES, it does not raise. A zod schema that throws where it is
 * documented to return `{ success: false }` turns a refusal into a 500, and the route's only
 * handling of that path is the `safeParse` result.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER. `restoreBackup` needs a database and is exercised by the
 * db-smoke suites on all three engines. And the amplification measured on the route ABOVE this
 * validator is not pinned here: 20 MB of `[{},{},...]` under the 20,000,000-byte cap becomes
 * 800 MB resident inside `JSON.parse`, before `formatVersion` is read and long before this schema
 * runs (#276). A test asserting today's behaviour there would certify the defect rather than guard
 * anything, so it is filed rather than fixed green.
 *
 * That is also why the schema's strictness is not evidence about #276: a guard that runs after the
 * allocation that matters is not a guard for that allocation.
 *
 * CALIBRATION. The first version of this harness accepted NOTHING, seed payload included, because
 * the seed was written from memory of the export's shape rather than read off the fixture the
 * schema's own spec uses. A validator that refuses everything is indistinguishable from a
 * validator that refuses everything hostile, so the accepted count is asserted with a floor.
 */

/** Taken from `schema.spec.ts`'s `buildValidPayload`, not written from memory: the version that
 *  was written from memory was refused by the schema and made the whole harness vacuous. */
function seed(): Record<string, unknown> {
	return {
		formatVersion: 1,
		exportedAt: '2026-01-02T00:00:00.000Z',
		userEmail: 'user-a@example.test',
		accounts: [{ id: 'acc-1', name: 'Compte courant', currency: 'EUR', source: 'manual' }],
		categories: [{ id: 'cat-1', name: 'Courses' }],
		importBatches: [
			{
				id: 'batch-1',
				source: 'csv',
				fileName: 'releve.csv',
				profile: 'generic',
				rowCount: 1,
				importedRows: 1,
				duplicateRows: 0,
				invalidRows: 0,
				periodStart: null,
				periodEnd: null
			}
		],
		transactions: [
			{
				id: 'tx-1',
				accountId: 'acc-1',
				categoryId: 'cat-1',
				importBatchId: 'batch-1',
				date: '2026-06-15T00:00:00.000Z',
				label: 'Carrefour',
				amountCents: 4200,
				type: 'expense',
				source: 'csv',
				notes: null,
				bankOperationType: 'CB',
				manualCategory: null,
				natureManual: null,
				dedupeKey: 'dedupe-1',
				metadataJson: null
			}
		],
		monthlyBudgets: [{ id: 'budget-1', categoryName: 'Courses', amountCents: 30000 }],
		categoryRules: [
			{
				id: 'rule-1',
				name: 'Regle courses',
				matchText: 'carrefour',
				targetCategory: 'Courses',
				targetNature: null,
				enabled: true
			}
		],
		categorizationRules: [
			{
				id: 'legacy-rule-1',
				pattern: 'carrefour',
				targetCategory: 'Courses',
				type: null,
				active: true
			}
		],
		categoryNatureMappings: [{ id: 'mapping-1', categoryName: 'Courses', nature: 'spending' }],
		tags: [{ id: 'file-clay', name: 'Portugal', colorToken: 'clay' }],
		transactionTags: [],
		transactionSplits: []
	};
}

/** Arbitrary JSON, including the shapes a hand-edited backup carries. */
const anyJson = fc.letrec((tie) => ({
	value: fc.oneof(
		{ arbitrary: fc.constantFrom(null, true, false, 0, -1, 1e308, '', 'x'), weight: 6 },
		{ arbitrary: fc.string({ maxLength: 30 }), weight: 3 },
		{ arbitrary: fc.double(), weight: 2 },
		{ arbitrary: fc.array(tie('value'), { maxLength: 4 }), weight: 2 },
		{
			arbitrary: fc.dictionary(fc.string({ maxLength: 6 }), tie('value'), { maxKeys: 4 }),
			weight: 2
		}
	)
})).value;

/** One top-level key replaced: reaches the collection validators rather than the door. */
const mutatedRoot = fc
	.tuple(fc.constantFrom(...Object.keys(seed())), anyJson)
	.map(([key, value]) => ({ ...seed(), [key]: value }));

/** One leaf field replaced: reaches the per-field refinements, which is where a `.refine()` that
 *  assumes a string would raise rather than refuse. */
const mutatedTransaction = fc
	.tuple(
		fc.constantFrom(
			'id',
			'accountId',
			'date',
			'label',
			'amountCents',
			'type',
			'source',
			'dedupeKey',
			'metadataJson'
		),
		anyJson
	)
	.map(([key, value]) => {
		const payload = seed();
		const transactions = payload.transactions as Array<Record<string, unknown>>;
		return { ...payload, transactions: [{ ...transactions[0], [key]: value }] };
	});

const RUNS = 2000;
const FLOOR = 100;

describe('the backup validator under generated payloads', () => {
	it('refuses a hostile payload rather than raising, and still accepts valid ones', () => {
		expect.assertions(2);

		const throws: string[] = [];
		let accepted = 0;

		fc.assert(
			fc.property(
				fc.oneof(
					{ arbitrary: mutatedRoot, weight: 5 },
					{ arbitrary: mutatedTransaction, weight: 4 },
					{ arbitrary: anyJson, weight: 2 },
					{ arbitrary: fc.constant(seed()), weight: 1 }
				),
				(payload) => {
					try {
						if (backupExportSchema.safeParse(payload).success) accepted += 1;
					} catch (error) {
						throws.push(
							`${String(error).slice(0, 120)} <- ${JSON.stringify(payload).slice(0, 160)}`
						);
					}
					return true;
				}
			),
			{ numRuns: RUNS }
		);

		// Named rather than counted, so a failure says which payload and why.
		expect(throws).toStrictEqual([]);
		// The absolute figure beside the absence. Measured across 15 seeds at 2000 runs: the
		// accepted count ranges 290 to 354, minimum 290. The floor is 100, so an unlucky seed is
		// not a red build while a seed payload that stops matching the schema is. The version of
		// this harness whose seed was written from memory accepted ZERO and reported 30000 clean
		// refusals, which is what a perfectly strict validator also reports.
		expect(accepted).toBeGreaterThanOrEqual(FLOOR);
	});
});

describe('the harness can see what it is looking for', () => {
	it('the seed payload is accepted, so a refusal below is about the mutation', () => {
		expect.assertions(1);

		expect(backupExportSchema.safeParse(seed()).success).toBe(true);
	});

	it('a payload the schema must refuse is refused, with the field named', () => {
		expect.assertions(3);

		// The three refusals this validator exists for, each pointed at deliberately rather than
		// waited for: an unknown root key (a client-supplied `userId`), an unknown nested key
		// (an injected `passwordHash`), and a format version it does not speak.
		const injectedRoot = backupExportSchema.safeParse({ ...seed(), userId: 'user-b' });
		const injectedNested = backupExportSchema.safeParse({
			...seed(),
			accounts: [{ ...(seed().accounts as Array<Record<string, unknown>>)[0], passwordHash: 'x' }]
		});
		const wrongVersion = backupExportSchema.safeParse({ ...seed(), formatVersion: 2 });

		expect(injectedRoot.success).toBe(false);
		expect(injectedNested.success).toBe(false);
		expect(wrongVersion.success).toBe(false);
	});
});
