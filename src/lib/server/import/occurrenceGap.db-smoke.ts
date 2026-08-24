import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { parseCsvTransactions } from './csv';
import { persistImportedTransactions, resolveImportBucketAccount } from './persist';

/**
 * MEASUREMENT, run before the v3 key work, for a claim the design note rests on.
 *
 * The note says a v3 key can be rebuilt "from the row's own columns". One of its inputs is not a
 * column and is not derived from one: the occurrence ordinal is handed out by a per-parse counter
 * at the moment the fingerprint is built, and the row is validated AFTER that
 * (`profiles/resolvedRows.ts:191` builds the key, `:215` runs `validateTransaction`). So a row the
 * parser reached and then refused CONSUMES an ordinal that no stored row carries, and a recompute
 * that numbers stored rows densely gives an already-stored row a different key.
 *
 * `category` is the only refusal lever that leaves the group fields intact. The group is
 * (date, folded label, magnitude, type), so a too-long label or a too-large amount would move the
 * row into a different group and the fixture would measure nothing. `MAX_CATEGORY_LENGTH` is 60
 * (`domain/transaction.ts:77`) and the category is sanitised but never truncated
 * (`resolvedRows.ts:124`), so a long category refuses the row and changes no group field.
 *
 * Three identical rows, the SECOND carrying a category of 100 characters. What this measures is
 * the ordinals the two survivors are stored with.
 */

const HEADER = 'date;label;amount;category';
const LONG_CATEGORY = 'C'.repeat(100);
const ROW = '2026-08-01;Cafe Fictif;-2,50;Restaurants';
const REFUSED_ROW = `2026-08-01;Cafe Fictif;-2,50;${LONG_CATEGORY}`;

let userId = '';

beforeAll(async () => {
	const user = await prisma.user.create({
		data: { email: `occ-gap-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
});

/** The ordinal a stored key carries, read off the key rather than recomputed from the row. */
function ordinalOf(dedupeKey: string): number {
	// The ordinal is the LAST field, which is what makes the group a literal prefix of the key.
	// Reading it positionally is safe now for a reason that used to be an argument and is now a
	// property: every field is delimiter-encoded, so a label can never add a field boundary.
	return Number(dedupeKey.split('|').at(-1));
}

describe('a row refused after the fingerprint consumes an ordinal', () => {
	it('stores ordinals {0, 1}, because the ordinal is now handed out over the rows WRITTEN', async () => {
		expect.assertions(5);

		const parsed = parseCsvTransactions(`${HEADER}\n${ROW}\n${REFUSED_ROW}\n${ROW}\n`, {
			sourceName: 'occurrence-gap.csv'
		});

		// CALIBRATION, and every figure below is a fact about a broken fixture without it: the
		// file must produce exactly two transactions and exactly one refusal, and the refusal
		// must be the one this fixture is built to provoke.
		expect(parsed.transactions).toHaveLength(2);
		expect(parsed.invalidRows).toHaveLength(1);
		expect(JSON.stringify(parsed.invalidRows[0])).toContain('category-too-long');

		const bucket = await resolveImportBucketAccount({
			userId,
			name: 'occurrence gap',
			source: 'csv'
		});
		const batch = await prisma.importBatch.create({
			data: {
				userId,
				source: 'csv',
				fileName: 'occurrence-gap.csv',
				profile: 'generic',
				rowCount: 3
			}
		});
		const persisted = await persistImportedTransactions({
			userId,
			accountId: bucket.accountId,
			importBatchId: batch.id,
			source: 'csv',
			transactions: parsed.transactions,
			parseDuplicateRows: parsed.summary.duplicateRows
		});
		expect(persisted.importedRows).toBe(2);

		const stored = await prisma.transaction.findMany({
			where: { userId, accountId: bucket.accountId },
			select: { dedupeKey: true },
			orderBy: { id: 'asc' }
		});
		const ordinals = stored.map((row) => ordinalOf(row.dedupeKey ?? '')).sort((a, b) => a - b);
		console.log(
			`[occurrence-gap] stored rows: ${stored.length}, ordinals: ${JSON.stringify(ordinals)}`
		);

		// THIS ASSERTION WAS {0, 2} WHEN THIS FILE WAS WRITTEN, and the change to {0, 1} is the
		// deliverable rather than an adjustment. It measured the defect: the profile took its
		// ordinal from a per-parse counter when it built the fingerprint and validateTransaction
		// ran afterwards, so the refused row consumed an ordinal no stored row carried and a
		// recompute numbering stored rows densely would have re-keyed the survivor. The ordinal is
		// now handed out over the rows being WRITTEN, so a refused row never reaches it.
		expect(ordinals).toEqual([0, 1]);
	});
});
