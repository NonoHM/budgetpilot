import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { resolveImportBucketAccount } from '$lib/server/import/persist';
import { writeImport } from '$lib/server/import/writeImport';
import type { ImportedTransaction } from '$lib/server/import/types';
import { load as importsLoad } from './+page.server';
import { load as importLoad } from '../import/+page.server';

/**
 * D3, contradiction pass item 1: the imported count a screen shows is the rows FILED under the batch,
 * never the stored `ImportBatch.importedRows` counter.
 *
 * The counter can disagree with its own ledger and nothing on the write path can fully prevent it:
 * a lost connection fails the count write together with the row that died (`persist.ts`, the
 * `landedRows: null` branch), every batch damaged before D3 keeps the default 0, and a restore
 * copies the counter as it was exported (`backup/import.ts`). So the damaged state is built here
 * directly, a counter at 0 over two filed rows, which is exactly what each of those paths leaves.
 *
 * Against a real engine because the figure is decided by the database: `_count` is a relation
 * aggregate, and a fake would decide it.
 */

let userId = '';

beforeAll(async () => {
	userId = (
		await prisma.user.create({
			data: { email: `d3-count-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
		})
	).id;
});

function row(id: string, label: string): ImportedTransaction {
	return {
		id,
		date: '2026-08-01',
		label,
		amountCents: -1000,
		category: 'Alimentation',
		source: 'csv',
		metadata: { type: 'expense', reference: '', notes: '' }
	};
}

/** A batch holding two rows whose stored counter says 0: what a lost connection or a restore leaves. */
async function damagedBatch(columnMappingId: string | null = null): Promise<string> {
	const bucket = await resolveImportBucketAccount({
		userId,
		name: `d3-count-${Date.now()}-${Math.random()}`,
		source: 'csv'
	});
	const fileName = `damaged-${Date.now()}-${Math.random()}.csv`;
	const written = await writeImport({
		batch: {
			userId,
			accountId: bucket.accountId,
			source: 'csv',
			fileName,
			profile: 'generic',
			rowCount: 2,
			invalidRows: 0,
			period: { from: '2026-08-01', to: '2026-08-01' },
			columnMappingId
		},
		transactions: [
			row(`${fileName}-1`, `COMPTE FICTIF A ${fileName}`),
			row(`${fileName}-2`, `COMPTE FICTIF B ${fileName}`)
		],
		parseDuplicateRows: 0
	});
	if (!written.ok) throw new Error('fixture write failed');
	await prisma.importBatch.update({ where: { id: written.batchId }, data: { importedRows: 0 } });
	return written.batchId;
}

describe('the imported count a screen shows is the rows filed under the batch', () => {
	it('/imports shows 2 for a batch whose stored counter says 0 over 2 filed rows', async () => {
		expect.assertions(2);
		const batchId = await damagedBatch();

		const data = (await importsLoad({
			locals: { user: { id: userId, email: 'x@example.test', role: 'USER' } },
			url: new URL('http://localhost/imports')
		} as never)) as { batches: Array<{ id: string; importedRows: number }> };
		const shown = data.batches.find((batch) => batch.id === batchId);

		// CALIBRATION: the damage is real, the counter does say 0.
		expect(
			(await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } })).importedRows
		).toBe(0);
		expect(shown?.importedRows).toBe(2);
	});

	it('the correction confirmation names 2 rows for the same damaged batch', async () => {
		expect.assertions(1);
		const mapping = await prisma.columnMapping.create({
			data: { userId, fingerprint: `d3-count-${Date.now()}`, columnCount: 3 }
		});
		const batchId = await damagedBatch(mapping.id);

		const data = (await importLoad({
			locals: { user: { id: userId, email: 'x@example.test', role: 'USER' } },
			url: new URL(`http://localhost/import?correct=${mapping.id}&batch=${batchId}`)
		} as never)) as { correction: { batchId: string | null; replacedRows: number } | null };

		expect(data.correction?.replacedRows).toBe(2);
	});
});
