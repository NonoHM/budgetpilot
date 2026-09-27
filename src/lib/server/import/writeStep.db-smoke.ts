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

describe('#596, one reference over: the correspondance a batch links to is the user’s', () => {
	async function mappingOf(userId: string): Promise<string> {
		const mapping = await prisma.columnMapping.create({
			data: { userId, fingerprint: `d3-${Date.now()}-${Math.random()}`, columnCount: 3 }
		});
		return mapping.id;
	}

	function batchInput(accountId: string, columnMappingId: string) {
		return {
			userId: userA,
			accountId,
			source: 'csv',
			fileName: `mapping-${columnMappingId}.csv`,
			profile: 'mapped',
			rowCount: 1,
			invalidRows: 0,
			period: { from: null, to: null },
			columnMappingId
		};
	}

	it('CALIBRATION: links the user’s own correspondance', async () => {
		expect.assertions(1);
		const own = await mappingOf(userA);
		const batchId = await createImportBatch(batchInput(await bucketOf(userA, 'd3-own-map'), own));

		const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
		expect(batch.columnMappingId).toBe(own);
	});

	it('refuses another user’s columnMappingId and writes no batch', async () => {
		expect.assertions(3);
		const foreign = await mappingOf(userB);

		let caught: (Error & { failure?: unknown }) | null = null;
		try {
			await createImportBatch(batchInput(await bucketOf(userA, 'd3-foreign-map'), foreign));
		} catch (error) {
			caught = error as Error & { failure?: unknown };
		}

		// Harm first: a batch of A's linked to B's correspondance would open B's recap from A's history.
		expect(await prisma.importBatch.count({ where: { columnMappingId: foreign } })).toBe(0);
		expect(caught?.name).toBe('ImportWriteError');
		expect(caught?.failure).toEqual({ kind: 'not-found' });
	});
});

/** The four rows every #662 test below writes, the third one a répartition refused after its parent landed. */
function statementWithRefusedSplit(prefix: string): ImportedTransaction[] {
	return [
		row(`${prefix}1`, `${prefix} FICTIF 1`),
		row(`${prefix}2`, `${prefix} FICTIF 2`),
		rowWithRefusedSplit(`${prefix}3`, `${prefix} FICTIF 3`),
		row(`${prefix}4`, `${prefix} FICTIF 4`)
	];
}

function batchFor(accountId: string, fileName: string) {
	return {
		userId: userA,
		accountId,
		source: 'csv',
		fileName,
		profile: 'maison',
		rowCount: 4,
		invalidRows: 0,
		period: { from: null, to: null }
	};
}

describe('#662: what the partial-import sentence tells the user to do', () => {
	it('a CORRECTED file lands all 4 rows once the partial import is deleted', async () => {
		expect.assertions(4);
		const accountId = await bucketOf(userA, 'd3-repair');
		const fileName = `repair-${Date.now()}.csv`;

		const failed = await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: statementWithRefusedSplit('MARCHE'),
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

		// A file whose cause is FIXED lands every row, none miscounted as a duplicate of a row the
		// delete removed. This measures a corrected file, not the literal retry: see the next test.
		const retried = await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: [
				row('MARCHE1', 'MARCHE FICTIF 1'),
				row('MARCHE2', 'MARCHE FICTIF 2'),
				row('MARCHE3', 'MARCHE FICTIF 3'),
				row('MARCHE4', 'MARCHE FICTIF 4')
			],
			parseDuplicateRows: 0
		});
		expect(retried.ok && retried.persisted.importedRows).toBe(4);
		expect(await prisma.transaction.count({ where: { userId: userA, accountId } })).toBe(4);
	});

	/**
	 * THE LITERAL INSTRUCTION, recorded rather than assumed. « Supprimez-le dans Imports, puis
	 * réessayez » with the SAME file, when the cause is in the file (here a répartition the write
	 * refuses): the retry stops at the same row with the same 3 landed. The sentence repairs a
	 * transient cause, a lost connection; a cause in the file needs the file changed, and the
	 * sentence cannot know which it was.
	 */
	it('the SAME file, retried after the delete, stops again after the same 3 rows', async () => {
		expect.assertions(3);
		const accountId = await bucketOf(userA, 'd3-literal');
		const fileName = `literal-${Date.now()}.csv`;

		const first = await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: statementWithRefusedSplit('HALLE'),
			parseDuplicateRows: 0
		});
		const partial = await prisma.importBatch.findFirstOrThrow({
			where: { userId: userA, fileName },
			select: { id: true }
		});
		await deleteImportBatch(userA, partial.id);
		const retried = await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: statementWithRefusedSplit('HALLE'),
			parseDuplicateRows: 0
		});

		expect(first).toEqual({ ok: false, failure: { kind: 'partly-saved', landedRows: 3 } });
		expect(retried).toEqual({ ok: false, failure: { kind: 'partly-saved', landedRows: 3 } });
		expect(await prisma.transaction.count({ where: { userId: userA, accountId } })).toBe(3);
	});
});

/**
 * D3 contradiction pass, item 2: a write that saved NOTHING leaves no batch behind. Before, the
 * batch created for it stayed in `/imports` reading « Importé 0 », once per retry. A row whose date
 * cannot be written fails before its insert on all three engines, so nothing lands.
 */
describe('#662: a write that saves nothing leaves no batch in the history', () => {
	function undatable(id: string, label: string): ImportedTransaction {
		return { ...row(id, label), date: 'pas-une-date' };
	}

	it('removes the batch when the first row fails before anything landed', async () => {
		expect.assertions(2);
		const accountId = await bucketOf(userA, 'd3-empty');
		const fileName = `empty-${Date.now()}.csv`;

		const outcome = await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: [undatable('e1', 'VIDE FICTIF 1'), row('e2', 'VIDE FICTIF 2')],
			parseDuplicateRows: 0
		});

		expect(await prisma.importBatch.count({ where: { userId: userA, fileName } })).toBe(0);
		expect(outcome).toEqual({ ok: false, failure: { kind: 'nothing-saved' } });
	});

	it('removes the batch the currency backstop refused before its first row', async () => {
		expect.assertions(2);
		const accountId = await bucketOf(userA, 'd3-currency');
		const fileName = `currency-${Date.now()}.csv`;

		const outcome = await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: [{ ...row('u1', 'DEVISE FICTIVE'), declaredCurrency: 'USD' }],
			parseDuplicateRows: 0
		});

		expect(await prisma.importBatch.count({ where: { userId: userA, fileName } })).toBe(0);
		expect(outcome.ok ? null : outcome.failure.kind).toBe('currency');
	});

	/**
	 * The literal « Réessayez » of the nothing-saved sentence, with a cause in the file: each retry
	 * fails the same way, and none of them leaves a batch. Separates « one empty batch per retry »
	 * (before) from « none ».
	 */
	it('leaves no batch after the SAME file is retried and fails again', async () => {
		expect.assertions(2);
		const accountId = await bucketOf(userA, 'd3-empty-retry');
		const fileName = `empty-retry-${Date.now()}.csv`;
		const statement = () => [undatable('x1', 'REPRISE FICTIVE 1'), row('x2', 'REPRISE FICTIVE 2')];

		await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: statement(),
			parseDuplicateRows: 0
		});
		const retried = await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: statement(),
			parseDuplicateRows: 0
		});

		expect(await prisma.importBatch.count({ where: { userId: userA, fileName } })).toBe(0);
		expect(retried).toEqual({ ok: false, failure: { kind: 'nothing-saved' } });
	});

	it('CALIBRATION: keeps the batch when rows did land', async () => {
		expect.assertions(1);
		const accountId = await bucketOf(userA, 'd3-kept');
		const fileName = `kept-${Date.now()}.csv`;

		await writeImport({
			batch: batchFor(accountId, fileName),
			transactions: statementWithRefusedSplit('GARDE'),
			parseDuplicateRows: 0
		});

		expect(await prisma.importBatch.count({ where: { userId: userA, fileName } })).toBe(1);
	});
});
