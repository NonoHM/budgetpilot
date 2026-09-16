import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { parseCsvTransactions } from './csv';
import { createImportBatch, resolveImportBucketAccount } from './persist';

/**
 * # THE APPLIED READING REACHES THE ROW, against a real engine on all three.
 *
 * ## Why this is a db-smoke and not a unit test
 *
 * `createImportBatch` is typed against the generated Prisma client, and a hand written mock is not.
 * This repository has the measurement that makes that distinction load bearing: a required field
 * over a nullable column typechecked as `string` and returned `null`, and the compile time answer
 * was the one that was wrong. A mocked `prisma.importBatch.create` would accept a `dateOrder` the
 * database never stores and would go green for ever.
 *
 * So the claim is asserted where it can be false: write a batch, read the row back through the
 * client, compare.
 *
 * ## What it is really guarding
 *
 * `ImportBatch.dateOrder` shipped on all three engines on 2026-08-22 and NOTHING WROTE IT until
 * 2026-09-16, so every row on every install was null while the column's own docstring described a
 * behaviour that did not happen. The gap lasted a month because no test asserted the write and the
 * schema comment read as if it were already true.
 *
 * ## MariaDB is why the null case is asserted explicitly
 *
 * MySQL and MariaDB are accent and case insensitive by default on string comparison, so a test that
 * only checked "the stored value equals what we sent" could pass on a value that differs from the
 * one intended. The two readings here differ in more than case, and the null case is asserted as
 * `toBeNull` rather than as a string comparison, which no collation can soften.
 */

const HEADER = 'date,label,amount';
/** 24 cannot be a month, so this file PROVES day-first and the stored value is not a default. */
const PROVES_DAY_FIRST = '24/06/2026,Cafe Fictif,-2.50';
/** 24 in the second position proves month-first, which is the value a default would never produce. */
const PROVES_MONTH_FIRST = '06/24/2026,Cafe Fictif,-2.50';

let userId = '';
let accountId = '';

beforeAll(async () => {
	const user = await prisma.user.create({
		data: { email: `date-order-batch-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
	const bucket = await resolveImportBucketAccount({
		userId,
		name: 'date order batch',
		source: 'csv'
	});
	accountId = bucket.accountId;
});

async function writeBatch(csv: string | null) {
	const summaryOrder =
		csv === null ? null : (parseCsvTransactions(`${HEADER}\n${csv}`).summary.dateOrder ?? null);
	const id = await createImportBatch({
		userId,
		accountId,
		source: 'csv',
		fileName: 'statement.csv',
		profile: 'generic',
		rowCount: 1,
		invalidRows: 0,
		period: { from: null, to: null },
		dateOrder: summaryOrder
	});
	const row = await prisma.importBatch.findFirstOrThrow({
		where: { id, userId },
		select: { dateOrder: true }
	});
	return { sent: summaryOrder, stored: row.dateOrder };
}

describe('the reading an import applied is stored on its batch', () => {
	/**
	 * Separates « the applied reading reached the row » from « the column is still never written ».
	 * That second state is what every install was in for a month, and nothing failed.
	 */
	it('stores day-first when the file proved it', async () => {
		expect.assertions(2);
		const { sent, stored } = await writeBatch(PROVES_DAY_FIRST);
		expect(sent).toBe('day-first');
		expect(stored).toBe('day-first');
	});

	/**
	 * Separates « the stored value is the one the parse decided » from « the stored value is the
	 * default that happens to agree ». Only a month-first file can tell those apart, because
	 * day-first IS the default: a writer that stored a constant would pass the test above.
	 */
	it('stores month-first when the file proved that instead', async () => {
		expect.assertions(2);
		const { sent, stored } = await writeBatch(PROVES_MONTH_FIRST);
		expect(sent).toBe('month-first');
		expect(stored).toBe('month-first');
	});

	/**
	 * Separates « no reading was recorded » from « a reading was invented for a caller that has
	 * none ». The provider sync path parses no CSV and takes no such decision, and a value there
	 * would claim a decision that was never made.
	 */
	it('stores null when the caller took no reading at all', async () => {
		expect.assertions(1);
		const { stored } = await writeBatch(null);
		expect(stored).toBeNull();
	});
});
