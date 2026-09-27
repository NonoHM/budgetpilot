import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from './persist';
import type { ImportedTransaction } from './types';

/**
 * #652's measurement of the COUNTING BUG, not of the NUL, and since D3 (#660) its regression test:
 * the PostgreSQL branch below used to pin `importedRows` at 0 over two committed rows, and now pins
 * it at the ledger's own count. Kept deliberately narrow:
 * `persistImportedTransactions` is called directly with a hand-built `ImportedTransaction`, the
 * same way `banking/sync/service.ts` and `accountIdSurvival.db-smoke.ts` do, bypassing every CSV
 * profile's `hasStrandedControlCharacter` refusal on purpose — those refuse a control character
 * before it ever reaches this function, closing the CSV path this PR was written for.
 *
 * What this file proves is what is filed as a follow-up (`importedRows still discards its
 * accumulator on any future throw`): the write loop in `persist.ts` still has no enclosing
 * transaction, `ImportBatch.importedRows` is still written once after the loop from an in-memory
 * accumulator, and ANY caller that reaches `persistImportedTransactions` with unsanitised text —
 * a future connector, a bug in a profile's own check, a restore path — reproduces the identical
 * partial commit. The guard this PR ships narrows the reachable cause; it does not remove the
 * class. This file is the live measurement that decision rests on, kept rather than deleted so
 * the follow-up issue has something other than prose to point at.
 */

let userId = '';

beforeAll(async () => {
	const user = await prisma.user.create({
		data: { email: `nulpartial-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
});

function row(id: string, label: string, amountCents = 1000): ImportedTransaction {
	return {
		id,
		date: '2026-08-01',
		label,
		amountCents,
		category: 'Alimentation',
		source: 'csv',
		metadata: { type: 'expense', reference: '', notes: '' }
	};
}

async function freshAccount(name: string) {
	const bucket = await resolveImportBucketAccount({ userId, name, source: 'csv' });
	return bucket.accountId;
}

describe('#652 task 1 — mid-batch throw vs importedRows', () => {
	it('a label carrying U+0000 throws mid-loop; rows before it are already committed; importedRows stays 0', async () => {
		expect.assertions(3);
		const accountId = await freshAccount(`bucket-nul-${Date.now()}`);
		const importBatchId = await createImportBatch({
			userId,
			accountId,
			source: 'csv',
			fileName: 'nul.csv',
			profile: 'maison',
			rowCount: 4,
			invalidRows: 0,
			period: { from: null, to: null }
		});

		const transactions: ImportedTransaction[] = [
			row('r1', 'SUPERETTE 1'),
			row('r2', 'SUPERETTE 2'),
			row('r3', 'SUPERETTE\u00003'),
			row('r4', 'SUPERETTE 4')
		];

		let caught: unknown = null;
		try {
			await persistImportedTransactions({
				userId,
				accountId,
				importBatchId,
				source: 'csv',
				transactions
			});
		} catch (error) {
			caught = error;
		}

		const committedCount = await prisma.transaction.count({ where: { importBatchId } });
		const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: importBatchId } });

		// What each engine does with a NUL: PostgreSQL throws (SQLSTATE 22021), sqlite/MariaDB
		// store it and the loop completes normally. Report both shapes rather than assuming one.
		if (caught !== null) {
			console.error(
				`[TASK1-NUL] THREW: committed=${committedCount} importedRows=${batch.importedRows} message=${(caught as Error).message}`
			);
			expect(committedCount, 'rows before the throw are already committed').toBe(2);
			// #660: read from the ledger, so it says 2, not the `@default(0)` a skipped write left.
			expect(batch.importedRows, 'the counter is what the ledger holds').toBe(2);
			expect((caught as { failure?: unknown }).failure).toEqual({ kind: 'failed', landedRows: 2 });
		} else {
			console.error(
				`[TASK1-NUL] NO THROW: committed=${committedCount} importedRows=${batch.importedRows}`
			);
			expect(committedCount, 'this engine stores the NUL; all 4 rows land').toBe(4);
			expect(batch.importedRows, 'counter matches committed rows when nothing throws').toBe(4);
			expect(caught).toBeNull();
		}
	});

	it('a lone surrogate half in the label: same class as NUL or a new one', async () => {
		expect.assertions(3);
		const accountId = await freshAccount(`bucket-surrogate-${Date.now()}`);
		const importBatchId = await createImportBatch({
			userId,
			accountId,
			source: 'csv',
			fileName: 'surrogate.csv',
			profile: 'maison',
			rowCount: 2,
			invalidRows: 0,
			period: { from: null, to: null }
		});

		const transactions: ImportedTransaction[] = [
			row('s1', 'SUPERETTE 1'),
			// Lone high surrogate, no low surrogate following: invalid UTF-16, invalid once
			// re-encoded to UTF-8.
			row('s2', 'SUPERETTE \uD800 2')
		];

		let caught: unknown = null;
		try {
			await persistImportedTransactions({
				userId,
				accountId,
				importBatchId,
				source: 'csv',
				transactions
			});
		} catch (error) {
			caught = error;
		}
		const committedCount = await prisma.transaction.count({ where: { importBatchId } });
		const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: importBatchId } });
		console.error(
			`[TASK1-SURROGATE] threw=${caught !== null} committed=${committedCount} importedRows=${batch.importedRows}${caught ? ` message=${(caught as Error).message}` : ''}`
		);
		expect(caught !== null, 'did this engine throw on a lone surrogate').toBe(caught !== null);
		expect(committedCount).toBe(caught !== null ? 1 : 2);
		// #660: whatever this engine did, the counter is the ledger's count.
		expect(batch.importedRows).toBe(committedCount);
	});

	it('control: a dedupeKeyHash collision (against an already-stored row) is caught gracefully, never thrown past persistTransaction', async () => {
		expect.assertions(4);
		const accountId = await freshAccount(`bucket-dup-${Date.now()}`);

		// First pass stores one row for real.
		const firstBatchId = await createImportBatch({
			userId,
			accountId,
			source: 'csv',
			fileName: 'dup-1.csv',
			profile: 'maison',
			rowCount: 1,
			invalidRows: 0,
			period: { from: null, to: null }
		});
		const first = await persistImportedTransactions({
			userId,
			accountId,
			importBatchId: firstBatchId,
			source: 'csv',
			transactions: [row('d1', 'SAME LABEL', 500)]
		});
		expect(first.importedRows).toBe(1);

		// Second pass re-imports the identical row (same date+label+amount -> same dedupeKeyHash)
		// beside a genuinely new one. The pre-check at persist.ts:726 should find the stored row
		// and skip it as a duplicate, never reaching the unique-constraint throw path at all.
		const secondBatchId = await createImportBatch({
			userId,
			accountId,
			source: 'csv',
			fileName: 'dup-2.csv',
			profile: 'maison',
			rowCount: 2,
			invalidRows: 0,
			period: { from: null, to: null }
		});
		const second = await persistImportedTransactions({
			userId,
			accountId,
			importBatchId: secondBatchId,
			source: 'csv',
			transactions: [row('d2', 'SAME LABEL', 500), row('d3', 'DIFFERENT LABEL', 700)]
		});
		const committedCount = await prisma.transaction.count({ where: { accountId } });
		const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: secondBatchId } });
		expect(second.importedRows).toBe(1);
		expect(committedCount).toBe(2);
		expect(batch.importedRows).toBe(1);
	});
});
