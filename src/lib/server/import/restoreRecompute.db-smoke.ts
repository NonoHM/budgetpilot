import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { buildBackupExport } from '$lib/server/backup/export';
import { restoreBackup } from '$lib/server/backup/import';
import { backupExportSchema } from '$lib/server/backup/schema';
import { parseCsvTransactions } from './csv';
import { persistImportedTransactions, resolveImportBucketAccount } from './persist';

/**
 * The restore recomputes the deduplication key, and this measures both legs of that claim against
 * a real database and the REAL export path.
 *
 * Two legs rather than one, because a real install carries two shapes of stored key and the change
 * is a no-op for only one of them.
 *
 * - **Leg A, rows this build wrote.** The multiset of recomputed keys equals the multiset of
 *   stored keys. Exact, and it is what makes wiring the restore safe before the version changes.
 * - **Leg B, rows a v1-era install wrote.** Their keys CHANGE, deliberately: a v1 key embedded the
 *   uploaded file's name, so it matches nothing a current import produces and the row deduplicates
 *   against nothing. The claim is that the restore rewrites it to what a fresh import of the same
 *   statement produces, which is measured by re-importing that statement and expecting 0 new rows.
 *   `utils/safety.ts` calls this backfill impossible; it is impossible from the old KEY and routine
 *   from the ROW.
 *
 * Leg B runs FIRST. Leg A passing tells you the harness works, and a harness that only ever ran
 * the passing leg is reporting about itself.
 */

const HEADER = 'date;label;amount;category';
const BODY = [
	'2026-08-01;Supérette Générale;-8,40;Alimentation',
	'2026-08-02;Café Noir;-2,50;Restaurants',
	// Two identical rows: the ordinal is the field most likely to move under a recompute.
	'2026-08-03;Café Noir;-2,50;Restaurants',
	'2026-08-03;Café Noir;-2,50;Restaurants'
].join('\n');

let userId = '';

async function importStatement(): Promise<{ imported: number; duplicates: number }> {
	const parsed = parseCsvTransactions(`${HEADER}\n${BODY}\n`, { sourceName: 'releve.csv' });
	expect(parsed.invalidRows, 'the fixture must parse').toStrictEqual([]);
	const bucket = await resolveImportBucketAccount({
		userId,
		name: 'Compte import CSV',
		source: 'csv'
	});
	const batch = await prisma.importBatch.create({
		data: {
			userId,
			source: 'csv',
			fileName: 'releve.csv',
			profile: 'generic',
			rowCount: 4
		}
	});
	const result = await persistImportedTransactions({
		userId,
		accountId: bucket.accountId,
		importBatchId: batch.id,
		source: 'csv',
		transactions: parsed.transactions
	});
	return { imported: result.importedRows, duplicates: result.duplicateRows };
}

async function storedKeys(): Promise<string[]> {
	const rows = await prisma.transaction.findMany({
		where: { userId },
		select: { dedupeKey: true },
		orderBy: { id: 'asc' }
	});
	return rows.map((row) => row.dedupeKey ?? '(null)').sort();
}

/** Export through the real path, then restore it back over the same user. */
async function exportAndRestore(): Promise<void> {
	const exported = await buildBackupExport(userId);
	// Through the validator, so this exercises the contract a real restore goes through rather
	// than an object shaped by this file.
	const payload = backupExportSchema.parse(JSON.parse(JSON.stringify(exported)));
	await restoreBackup(userId, payload);
}

beforeAll(async () => {
	const user = await prisma.user.create({
		data: { email: `restore-recompute-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
});

describe('LEG B: a v1-era key is rewritten to what a fresh import produces', () => {
	it('imports 0 new rows after the restore, where today it would import all four again', async () => {
		// 6 here plus one per importStatement call, which asserts its own fixture parsed.
		expect.assertions(8);

		const first = await importStatement();
		expect(first.imported).toBe(4);

		// Overwrite every key with the v1 shape: `date|label|magnitude|type|reference|FILENAME`.
		// That is what an install predating the v2 change actually holds, and it is why the record
		// called the backfill impossible: the filename cannot be separated out of the old key.
		const rows = await prisma.transaction.findMany({
			where: { userId },
			select: { id: true, date: true, label: true, amountCents: true, type: true }
		});
		for (const row of rows) {
			const v1 = [
				row.date.toISOString().slice(0, 10),
				row.label.toLowerCase(),
				Math.abs(Number(row.amountCents)),
				row.type,
				'',
				'releve.csv'
			].join('|');
			await prisma.transaction.update({
				where: { id: row.id },
				data: { dedupeKey: v1, dedupeKeyHash: null }
			});
		}
		const beforeRestore = await storedKeys();
		expect(beforeRestore.every((key) => key.endsWith('releve.csv'))).toBe(true);

		await exportAndRestore();

		const afterRestore = await storedKeys();
		expect(afterRestore.some((key) => key.endsWith('releve.csv'))).toBe(false);
		expect(afterRestore).toHaveLength(4);

		// The claim: the rewritten keys are the ones a fresh import of the same statement builds,
		// so re-importing it now adds nothing. Before this change all four would import again.
		const again = await importStatement();
		expect(again.imported).toBe(0);
		expect(again.duplicates).toBe(4);
	});
});

describe('LEG A: a key this build wrote survives a restore byte for byte', () => {
	it('restores the same multiset of keys it exported', async () => {
		// 3 here plus one from importStatement, which asserts its own fixture parsed.
		expect.assertions(4);

		// A fresh user, so leg B's rows are not in view.
		const user = await prisma.user.create({
			data: { email: `restore-noop-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
		});
		const previous = userId;
		userId = user.id;
		try {
			await importStatement();
			const before = await storedKeys();
			expect(before).toHaveLength(4);

			await exportAndRestore();

			const after = await storedKeys();
			expect(after).toEqual(before);
			// And the ordinals still separate the two identical rows, which is the property the
			// multiset comparison alone would not distinguish from four copies of one key.
			expect(new Set(after).size).toBe(4);
		} finally {
			userId = previous;
		}
	});
});
