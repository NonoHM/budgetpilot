import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from './persist';
import type { ImportedTransaction } from './types';
import { writeImport } from './writeImport';
import { deleteImportBatch } from './deleteBatch';

/**
 * D3: the write step owns its failures. Against a REAL engine, because every figure here is
 * decided by the database: what a row loop has already committed when it throws, and whether a
 * `where` clause names the user. A unit spec's fake decides what `findFirst` returns, so « the
 * query was scoped » and « the fake returned nothing » are the same green there.
 *
 * Two halves.
 *
 * #660, the count. `persistImportedTransactions` writes each row outside a transaction on purpose
 * (one duplicate would otherwise abort a PostgreSQL import), so rows commit one by one. The
 * batch's `importedRows` used to be an accumulator written once after the loop, and a throw
 * skipped the write: the history said « Importé 0 » over rows sitting in the ledger. The throw
 * used here is a répartition `replaceSplits` refuses, chosen because it fires on all three engines
 * and fires AFTER its parent row committed, which is the one place an accumulator and the ledger
 * disagree by a row: the accumulator never counts the parent, the ledger holds it.
 *
 * #596, ownership. Both references this function is handed, `accountId` and `importBatchId`, are
 * resolved with `userId` in the same where clause, so a foreign reference writes nothing and is
 * refused as not-found. Each test isolates ONE clause: its fixture satisfies every other clause, so
 * removing the clause under test is the only change that lets the foreign write through.
 */

let userA = '';
let userB = '';

beforeAll(async () => {
	const stamp = Date.now();
	userA = (
		await prisma.user.create({
			data: { email: `d3-write-a-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
		})
	).id;
	userB = (
		await prisma.user.create({
			data: { email: `d3-write-b-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
		})
	).id;
});

function row(id: string, label: string, amountCents = -1000): ImportedTransaction {
	return {
		id,
		date: '2026-08-01',
		label,
		amountCents,
		category: 'Alimentation',
		source: 'csv',
		metadata: { type: amountCents < 0 ? 'expense' : 'income', reference: '', notes: '' }
	};
}

/** A répartition of ONE part, which `replaceSplits` refuses on count, after the parent landed. */
function rowWithRefusedSplit(id: string, label: string): ImportedTransaction {
	return { ...row(id, label), splitParts: [{ category: 'Loisirs', amountCents: -1000 }] };
}

async function bucketOf(userId: string, name: string): Promise<string> {
	const bucket = await resolveImportBucketAccount({
		userId,
		name: `${name}-${Date.now()}-${Math.random()}`,
		source: 'csv'
	});
	return bucket.accountId;
}

/**
 * A batch row written DIRECTLY, never through `createImportBatch`, so a test can build the one
 * combination of owner and account it needs to isolate a single clause. `createImportBatch` now
 * refuses those combinations itself, which is exactly why it cannot build them.
 */
async function rawBatch(userId: string, accountId: string): Promise<string> {
	const batch = await prisma.importBatch.create({
		data: {
			userId,
			accountId,
			source: 'csv',
			fileName: 'd3.csv',
			profile: 'maison',
			rowCount: 2,
			invalidRows: 0
		}
	});
	return batch.id;
}

async function attempt(input: Parameters<typeof persistImportedTransactions>[0]) {
	try {
		await persistImportedTransactions(input);
		return null;
	} catch (caught) {
		return caught as Error & { failure?: unknown };
	}
}

describe('#660: the batch count is what the ledger holds, whatever threw', () => {
	it('records 3 on the batch when the third row throws after its parent committed', async () => {
		expect.assertions(3);
		const accountId = await bucketOf(userA, 'd3-count');
		const importBatchId = await createImportBatch({
			userId: userA,
			accountId,
			source: 'csv',
			fileName: 'count.csv',
			profile: 'maison',
			rowCount: 4,
			invalidRows: 0,
			period: { from: null, to: null }
		});

		const caught = await attempt({
			userId: userA,
			accountId,
			importBatchId,
			source: 'csv',
			transactions: [
				row('c1', 'SUPERETTE FICTIVE 1'),
				row('c2', 'SUPERETTE FICTIVE 2'),
				rowWithRefusedSplit('c3', 'SUPERETTE FICTIVE 3'),
				row('c4', 'SUPERETTE FICTIVE 4')
			]
		});

		// CALIBRATION: the fixture throws, and three rows are in the ledger (two plain rows and the
		// parent of the refused répartition). Without both, the figure below is about the fixture.
		expect(caught).not.toBeNull();
		expect(await prisma.transaction.count({ where: { userId: userA, importBatchId } })).toBe(3);
		// THE figure: 0 before D3 (the accumulator's write was skipped), 2 with an accumulator
		// written in a `finally` (it never counted the parent), 3 only when it is read from the ledger.
		const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: importBatchId } });
		expect(batch.importedRows).toBe(3);
	});

	it('throws an ImportWriteError naming the 3 rows that landed, not the raw cause', async () => {
		expect.assertions(2);
		const accountId = await bucketOf(userA, 'd3-throw');
		const importBatchId = await createImportBatch({
			userId: userA,
			accountId,
			source: 'csv',
			fileName: 'throw.csv',
			profile: 'maison',
			rowCount: 4,
			invalidRows: 0,
			period: { from: null, to: null }
		});

		const caught = await attempt({
			userId: userA,
			accountId,
			importBatchId,
			source: 'csv',
			transactions: [
				row('t1', 'EPICERIE FICTIVE 1'),
				row('t2', 'EPICERIE FICTIVE 2'),
				rowWithRefusedSplit('t3', 'EPICERIE FICTIVE 3'),
				row('t4', 'EPICERIE FICTIVE 4')
			]
		});

		expect(caught?.name).toBe('ImportWriteError');
		expect(caught?.failure).toEqual({ kind: 'failed', landedRows: 3 });
	});
});

describe('#596: a foreign reference writes nothing and is refused as not-found', () => {
	it('refuses another user’s accountId (the bucket read names userId)', async () => {
		expect.assertions(3);
		const foreignAccount = await bucketOf(userB, 'd3-foreign-account');
		// A's batch, filed on B's account, written raw: the batch clause is satisfied (A owns it, and
		// it names the account posted), so the BUCKET read is the only clause that can refuse.
		const importBatchId = await rawBatch(userA, foreignAccount);

		const caught = await attempt({
			userId: userA,
			accountId: foreignAccount,
			importBatchId,
			source: 'csv',
			transactions: [row('fa1', 'CAFE FICTIF 1'), row('fa2', 'CAFE FICTIF 2')]
		});

		expect(await prisma.transaction.count({ where: { accountId: foreignAccount } })).toBe(0);
		expect(caught?.name).toBe('ImportWriteError');
		expect(caught?.failure).toEqual({ kind: 'not-found' });
	});

	it('refuses another user’s importBatchId (the batch read names userId)', async () => {
		expect.assertions(3);
		const accountId = await bucketOf(userA, 'd3-foreign-batch');
		// B's batch, filed on A's account: the account clause is satisfied, so `userId` on the batch
		// read is the only clause that can refuse.
		const foreignBatch = await rawBatch(userB, accountId);

		const caught = await attempt({
			userId: userA,
			accountId,
			importBatchId: foreignBatch,
			source: 'csv',
			transactions: [row('fb1', 'KIOSQUE FICTIF 1'), row('fb2', 'KIOSQUE FICTIF 2')]
		});

		expect(await prisma.transaction.count({ where: { importBatchId: foreignBatch } })).toBe(0);
		expect(caught?.name).toBe('ImportWriteError');
		expect(caught?.failure).toEqual({ kind: 'not-found' });
	});

	it('refuses the user’s own batch when it is filed on another of their accounts', async () => {
		expect.assertions(3);
		const filedOn = await bucketOf(userA, 'd3-filed-on');
		const postedTo = await bucketOf(userA, 'd3-posted-to');
		const importBatchId = await rawBatch(userA, filedOn);

		const caught = await attempt({
			userId: userA,
			accountId: postedTo,
			importBatchId,
			source: 'csv',
			transactions: [row('fc1', 'LIBRAIRIE FICTIVE 1')]
		});

		expect(await prisma.transaction.count({ where: { importBatchId } })).toBe(0);
		expect(caught?.name).toBe('ImportWriteError');
		expect(caught?.failure).toEqual({ kind: 'not-found' });
	});

	it('createImportBatch refuses another user’s accountId and writes no batch', async () => {
		expect.assertions(3);
		const foreignAccount = await bucketOf(userB, 'd3-create-foreign');

		let caught: (Error & { failure?: unknown }) | null = null;
		try {
			await createImportBatch({
				userId: userA,
				accountId: foreignAccount,
				source: 'csv',
				fileName: 'foreign.csv',
				profile: 'maison',
				rowCount: 1,
				invalidRows: 0,
				period: { from: null, to: null }
			});
		} catch (error) {
			caught = error as Error & { failure?: unknown };
		}

		expect(await prisma.importBatch.count({ where: { accountId: foreignAccount } })).toBe(0);
		expect(caught?.name).toBe('ImportWriteError');
		expect(caught?.failure).toEqual({ kind: 'not-found' });
	});
});

describe('#662: the repair the partial-import sentence names works', () => {
	it('deleting the partial import leaves none of its rows, and the next run lands all 4', async () => {
		expect.assertions(4);
		const accountId = await bucketOf(userA, 'd3-repair');
		const fileName = `repair-${Date.now()}.csv`;
		const batch = {
			userId: userA,
			accountId,
			source: 'csv',
			fileName,
			profile: 'maison',
			rowCount: 4,
			invalidRows: 0,
			period: { from: null, to: null }
		};

		const failed = await writeImport({
			batch,
			transactions: [
				row('r1', 'MARCHE FICTIF 1'),
				row('r2', 'MARCHE FICTIF 2'),
				rowWithRefusedSplit('r3', 'MARCHE FICTIF 3'),
				row('r4', 'MARCHE FICTIF 4')
			],
			parseDuplicateRows: 0
		});
		// The sentence's own premise: three rows landed, and the screen is told so.
		expect(failed).toEqual({ ok: false, failure: { kind: 'partly-saved', landedRows: 3 } });

		// « Supprimez-le dans Imports »: the delete `/imports` performs.
		const partial = await prisma.importBatch.findFirstOrThrow({
			where: { userId: userA, fileName },
			select: { id: true }
		});
		expect(await deleteImportBatch(userA, partial.id)).toBe(true);

		// « puis réessayez »: the corrected file lands every row, and none is miscounted as a
		// duplicate of a row the delete removed.
		const retried = await writeImport({
			batch,
			transactions: [
				row('r1', 'MARCHE FICTIF 1'),
				row('r2', 'MARCHE FICTIF 2'),
				row('r3', 'MARCHE FICTIF 3'),
				row('r4', 'MARCHE FICTIF 4')
			],
			parseDuplicateRows: 0
		});
		expect(retried.ok && retried.persisted.importedRows).toBe(4);
		expect(await prisma.transaction.count({ where: { userId: userA, accountId } })).toBe(4);
	});
});
