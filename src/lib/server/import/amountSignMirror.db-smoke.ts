import { describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { parseCsvTransactionRows } from './csv';
import { readImportFile } from './file';
import {
	createImportBatch,
	persistImportedTransactions,
	resolveImportBucketAccount
} from './persist';

/**
 * # A ROW THE MEMBER ANSWERED, MIRRORING A ROW ALREADY STORED, against a real engine (#1207 C2c-S1).
 *
 * Before the sign question existed, an unsigned statement imported every row as income. The
 * direction is part of the duplicate key, so re-importing that statement and answering « Money out »
 * matched none of the stored rows, and the batch totals are mirrored (credit then debit), so the
 * duplicate-statement guard stayed silent too: both copies were stored (contradiction pass F1).
 *
 * Owner ruling, 2026-11-06: such a row is SKIPPED and REPORTED, never inserted and never rewriting
 * the stored one. Only rows whose direction came from the answer are checked: a signed statement can
 * carry a purchase and its same-day refund of the same amount, and both are real.
 *
 * The « before » import is the parse under « Money in », which reads exactly as the old default did.
 */

const UNSIGNED = [
	'date;libelle;montant',
	'24/06/2026;CB A;24,90',
	'22/06/2026;CB B;39,99',
	'21/06/2026;CB C;12,00'
].join('\n');
const PURCHASE_AND_REFUND = [
	'date;libelle;montant',
	'24/06/2026;CB A;-24,90',
	'24/06/2026;CB A;24,90'
].join('\n');

async function rowsOf(text: string) {
	const file = new File([new TextEncoder().encode(text)], 'statement.csv', { type: 'text/csv' });
	return (await readImportFile(file, { maxBytes: 256_000 })).rows;
}

async function freshUser(tag: string) {
	const user = await prisma.user.create({
		data: {
			email: `amount-sign-mirror-${tag}-${Date.now()}@example.test`,
			passwordHash: 'x',
			role: 'USER'
		}
	});
	const bucket = await resolveImportBucketAccount({
		userId: user.id,
		name: `sign mirror ${tag}`,
		source: 'csv'
	});
	return { userId: user.id, accountId: bucket.accountId };
}

async function importOnce(
	who: { userId: string; accountId: string },
	text: string,
	amountSign?: 'out' | 'in',
	replacesBatchId?: string
) {
	const result = parseCsvTransactionRows(await rowsOf(text), {
		maxBytes: 256_000,
		sourceName: 'statement.csv',
		...(amountSign ? { amountSign } : {})
	});
	const batchId = await createImportBatch({
		userId: who.userId,
		accountId: who.accountId,
		source: 'csv',
		fileName: 'statement.csv',
		profile: 'generic',
		rowCount: result.summary.totalRows,
		invalidRows: result.summary.invalidRows,
		period: result.summary.period,
		dateOrder: result.summary.dateOrder ?? null
	});
	const written = await persistImportedTransactions({
		userId: who.userId,
		accountId: who.accountId,
		importBatchId: batchId,
		source: 'csv',
		transactions: result.transactions,
		parseDuplicateRows: result.summary.duplicateRows,
		...(replacesBatchId ? { replacesBatchId } : {})
	});
	return {
		batchId,
		parsed: result.transactions.length,
		imported: written.importedRows,
		mirrored: written.mirrorRows
	};
}

async function storedOf(userId: string) {
	const rows = await prisma.transaction.findMany({ where: { userId }, select: { type: true } });
	return { rows: rows.length, income: rows.filter((row) => row.type === 'income').length };
}

describe('a re-imported unsigned statement answered « Money out »', () => {
	/** Separates « mirror skipped and counted » from « both copies stored » (F1's measured shape). */
	it('skips every row that mirrors a stored one and says how many', async () => {
		expect.assertions(3);
		const who = await freshUser('reimport');

		await importOnce(who, UNSIGNED, 'in');
		const second = await importOnce(who, UNSIGNED, 'out');

		expect(second.imported).toBe(0);
		expect(second.mirrored).toBe(3);
		expect(await storedOf(who.userId)).toEqual({ rows: 3, income: 3 });
	});
});

describe('a correction that replaces the batch it mirrors (final-code pass F1)', () => {
	/**
	 * Separates « the batch being replaced is not a mirror » from « its rows skip the new ones »,
	 * after which the consented delete of the old batch leaves those rows stored ZERO times. The
	 * collision guard excludes that batch for the same reason (`excludeBatchId`).
	 */
	it('writes the answered rows when the stored mirrors belong to the batch being replaced', async () => {
		expect.assertions(2);
		const who = await freshUser('correction');

		const first = await importOnce(who, UNSIGNED, 'in');
		const second = await importOnce(who, UNSIGNED, 'out', first.batchId);

		expect(second.imported).toBe(3);
		expect(second.mirrored).toBe(0);
	});
});

describe('what the mirror check does not touch', () => {
	/** A signed file was not answered, so its same-day refund is a second real row. */
	it('keeps a purchase and its same-day refund from a signed file', async () => {
		expect.assertions(2);
		const who = await freshUser('refund');

		const result = await importOnce(who, PURCHASE_AND_REFUND);

		expect(result.imported).toBe(2);
		expect(await storedOf(who.userId)).toEqual({ rows: 2, income: 1 });
	});
});
