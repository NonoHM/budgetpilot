import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { parseCsvTransactions } from './csv';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from './persist';
import { runStatementAccountBackfill } from './accountBackfill';

/**
 * THE PROPERTY THE WHOLE PIECE RESTS ON: promoting a bucket into a named account rewrites ZERO
 * deduplication keys.
 *
 * The v3 key carries `Account.id` verbatim (`dedupeRecompute.ts`, `contentFieldsOf`), and the
 * bucket already IS an `Account` row with a stable cuid. So the migration writes metadata only and
 * `runDedupeKeyRecompute` is never called. Had this been a new table with fresh ids, every stored
 * key would have become false and the duplication event this piece exists to prevent would have
 * been unavoidable.
 *
 * ## Why the control leg is not optional
 *
 * "Zero keys changed" and "the probe cannot see a key change" are the same output. The control
 * re-imports the identical file into the identical account id and requires `duplicate=1`, which
 * proves the probe can observe a PRESERVED perimeter. Without it a green run here would be
 * indistinguishable from a harness that read nothing, which is the failure this repository has
 * measured more often than any other.
 */

const BP_HEADER = BANQUE_POPULAIRE_HEADERS.join(';');
const BP_ROW =
	'01/08/2026;SUPERETTE;PAIEMENT CB SUPERETTE;REF001;;Carte;Alimentation;Courses;-8,40;;01/08/2026;01/08/2026;';
const BP_FILE = `${BP_HEADER}\n${BP_ROW}\n`;

let userId = '';
let accountId = '';

beforeAll(async () => {
	const user = await prisma.user.create({
		data: { email: `idsurvival-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
});

async function importInto(intoAccountId: string, fileName: string) {
	const parsed = parseCsvTransactions(BP_FILE, { sourceName: fileName });
	expect(parsed.invalidRows, `${fileName} must parse`).toStrictEqual([]);
	const importBatchId = await createImportBatch({
		userId,
		accountId: intoAccountId,
		source: 'banque_populaire',
		fileName,
		profile: parsed.summary.profile,
		rowCount: parsed.summary.totalRows,
		invalidRows: parsed.summary.invalidRows,
		period: parsed.summary.period
	});
	return persistImportedTransactions({
		userId,
		accountId: intoAccountId,
		importBatchId,
		source: 'banque_populaire',
		transactions: parsed.transactions
	});
}

describe('promoting a bucket into a named account', () => {
	it('rewrites zero stored keys, and the control proves the probe can see a preserved perimeter', async () => {
		// 7 here plus one per importInto call, each of which asserts its own fixture parsed.
		expect.assertions(9);

		const bucket = await resolveImportBucketAccount({
			userId,
			name: 'Compte import CSV',
			source: 'banque_populaire'
		});
		accountId = bucket.accountId;

		const first = await importInto(accountId, 'releve.csv');
		expect(first.importedRows).toBe(1);

		const stored = await prisma.transaction.findFirstOrThrow({
			where: { userId },
			select: { id: true, dedupeKey: true, dedupeKeyHash: true }
		});
		// The key carries the id VERBATIM. Asserted on the STORED string rather than rebuilt from
		// the source, so the two sides of this comparison do not come from one place.
		expect(stored.dedupeKey).toContain(accountId);

		// The state the backfill is pointed at, asserted rather than assumed: an unnamed bucket.
		const before = await prisma.account.findUniqueOrThrow({
			where: { id: accountId },
			select: { institution: true, name: true }
		});
		expect(before.institution).toBeNull();

		const result = await runStatementAccountBackfill({ prisma });
		expect(result.accountsNamed).toBeGreaterThanOrEqual(1);

		// It really did rename: otherwise "zero keys rewritten" would be true of a pass that did
		// nothing at all, which is the same output for the opposite reason.
		const after = await prisma.account.findUniqueOrThrow({
			where: { id: accountId },
			select: { institution: true, name: true }
		});
		expect(after).toStrictEqual({ institution: 'Banque Populaire', name: 'Banque Populaire' });

		const key = await prisma.transaction.findUniqueOrThrow({
			where: { id: stored.id },
			select: { dedupeKey: true, dedupeKeyHash: true }
		});
		expect(key.dedupeKey).toBe(stored.dedupeKey);

		// THE CONTROL LEG. Without it, "zero keys changed" and "the probe is broken" are one
		// output. Re-importing the identical file into the identical account id must be refused as
		// a duplicate, which is only possible if the key still describes the same perimeter.
		const control = await importInto(accountId, 'releve.csv');
		expect(control).toMatchObject({ importedRows: 0, duplicateRows: 1 });
	});

	it('files a batch that has no account into the one its own transactions name', async () => {
		expect.assertions(3);

		// A batch written the way every batch was written before this piece: no account. Its
		// transactions are what carry the answer, so it gets the ones already in the database.
		const orphan = await prisma.importBatch.create({
			data: {
				userId,
				source: 'banque_populaire',
				fileName: 'legacy.csv',
				profile: 'banque-populaire',
				rowCount: 1,
				invalidRows: 0
			},
			select: { id: true }
		});
		const moved = await prisma.transaction.updateMany({
			where: { userId },
			data: { importBatchId: orphan.id }
		});
		// Calibration on BOTH sides, and the second one is what the first attempt at this test was
		// missing: the batch is unfiled, AND it has rows to read an account from. A batch with no
		// transactions is unfillable by design and is asserted separately below, so a fixture that
		// accidentally built one would have failed here for a reason that is not the claim.
		expect(moved.count).toBeGreaterThanOrEqual(1);
		const unfiled = await prisma.importBatch.count({
			where: { userId, accountId: null, transactions: { some: {} } }
		});
		expect(unfiled).toBe(1);

		await runStatementAccountBackfill({ prisma });

		const filed = await prisma.importBatch.findUniqueOrThrow({
			where: { id: orphan.id },
			select: { accountId: true }
		});
		expect(filed.accountId).toBe(accountId);
	});

	// The convergence property, and it is the reason the pending predicate names `transactions`.
	// A batch whose rows have all been deleted has nothing to read an account from. Filing it into
	// an invented account would be silent and wrong; leaving it pending for ever would make the
	// boot gate run a pass that writes nothing on every single start. It stays honestly null and
	// stops being pending, which is what lets the walk terminate.
	it('leaves a batch with no transactions honestly unfiled, rather than looping on it', async () => {
		expect.assertions(3);

		const empty = await prisma.importBatch.create({
			data: {
				userId,
				source: 'csv',
				fileName: 'rows-all-deleted.csv',
				profile: 'generic',
				rowCount: 0,
				invalidRows: 0
			},
			select: { id: true }
		});
		expect(await prisma.transaction.count({ where: { importBatchId: empty.id } })).toBe(0);

		const pass = await runStatementAccountBackfill({ prisma });
		expect(pass.batchesFiled).toBe(0);

		const still = await prisma.importBatch.findUniqueOrThrow({
			where: { id: empty.id },
			select: { accountId: true }
		});
		expect(still.accountId).toBeNull();
	});

	it('is idempotent: a second pass writes nothing', async () => {
		expect.assertions(2);
		const second = await runStatementAccountBackfill({ prisma });
		expect(second.accountsNamed).toBe(0);
		expect(second.batchesFiled).toBe(0);
	});
});
