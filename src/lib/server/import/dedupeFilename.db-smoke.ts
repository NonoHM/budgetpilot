import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { parseCsvTransactions } from './csv';
import { persistImportedTransactions, resolveImportBucketAccount } from './persist';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { MAISON_V2_HEADER } from './profiles/maison-v2';

/**
 * The duplicate-detection key must not depend on what the file is called.
 *
 * This runs against a real database because the filename only ever acted ACROSS files: within one
 * file every row carries the same name, so it cannot distinguish anything, and the in-memory
 * `seenFingerprints` set collapses identical rows identically on every profile. The behaviour that
 * differed was the second import, which is the `@@unique([userId, dedupeKeyHash])` constraint doing
 * the work, and that only exists in the database.
 *
 * Each profile's fixture carries a distinct label ON PURPOSE. Deduplication is per USER across
 * every account and profile (`@@unique([userId, dedupeKeyHash])`), and `maison` and `maison-v2`
 * build the same key from the same three fields, so identical fixtures collide with each other
 * rather than testing what this file is about.
 *
 * Measured before the fix: `generic`, `revolut` and `banque-populaire` imported the same statement
 * twice when it was renamed, because `buildDeduplicationKey` received the filename through a
 * parameter named `account`. The two maison profiles deduplicated correctly.
 */

const BP_HEADER = BANQUE_POPULAIRE_HEADERS.join(';');
const MAISON_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';

interface Profile {
	name: string;
	source: string;
	header: string;
	/** The same transaction, expected to deduplicate against itself across two filenames. */
	row: string;
	/** A DIFFERENT transaction, expected to import alongside it. See the presence half below. */
	distinctRow: string;
}

const PROFILES: Profile[] = [
	{
		name: 'generic',
		source: 'gen',
		header: 'date;label;amount;category',
		row: '2026-08-01;MonoprixGen;-8,40;Alimentation',
		// Different AMOUNT. It used to be a different category, which worked while the key carried
		// one; under the v2 key it does not, and the cost of that is pinned by its own test below
		// rather than papered over by this fixture.
		distinctRow: '2026-08-01;MonoprixGen;-19,90;Alimentation'
	},
	{
		name: 'revolut',
		source: 'rev',
		header: 'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde',
		row: 'CARD_PAYMENT,Current,2026-08-01 10:00:00,2026-08-01 10:00:00,Tesco,-12.30,0.00,EUR,TERMINÉ,500.00',
		// Different amount: the key carries it, so this is a second transaction.
		distinctRow:
			'CARD_PAYMENT,Current,2026-08-01 10:00:00,2026-08-01 10:00:00,Tesco,-19.90,0.00,EUR,TERMINÉ,480.10'
	},
	{
		name: 'banque-populaire',
		source: 'bp',
		header: BP_HEADER,
		row: '01/08/2026;MONOPRIX;PAIEMENT CB MONOPRIX;REF001;;Carte;Alimentation;Courses;-8,40;;01/08/2026;01/08/2026;',
		// Different AMOUNT. It used to be a different reference, for the same reason as generic's
		// category above, and it stopped working for the same reason.
		distinctRow:
			'01/08/2026;MONOPRIX;PAIEMENT CB MONOPRIX;REF001;;Carte;Alimentation;Courses;-19,90;;01/08/2026;01/08/2026;'
	},
	{
		name: 'maison',
		source: 'mai',
		header: MAISON_HEADER,
		row: '2026-08-01;MonoprixMai;Alimentation;-8,40;expense;spending;CB',
		// The amount is what has to differ, as for every profile since the key was unified.
		distinctRow: '2026-08-01;MonoprixMai;Alimentation;-19,90;expense;spending;CB'
	},
	{
		name: 'maison-v2',
		source: 'mv2',
		header: MAISON_V2_HEADER,
		row: '2026-08-01;MonoprixV2;Alimentation;-8,40;expense;spending;CB;-8,40;1/1;Alimentation',
		distinctRow:
			'2026-08-01;MonoprixV2;Alimentation;-19,90;expense;spending;CB;-19,90;1/1;Alimentation'
	}
];

let userId = '';

beforeAll(async () => {
	const user = await prisma.user.create({
		data: { email: `dedupe-fn-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
});

async function runImport(profile: Profile, body: string, fileName: string) {
	const parsed = parseCsvTransactions(`${profile.header}\n${body}\n`, { sourceName: fileName });
	// The parse must have succeeded, or every count below is a fact about a broken fixture rather
	// than about the deduplication key.
	expect(parsed.invalidRows, `${profile.name} refused its own fixture`).toStrictEqual([]);

	const bucket = await resolveImportBucketAccount({
		userId,
		name: `bucket-${profile.source}`,
		source: profile.source
	});
	const batch = await prisma.importBatch.create({
		data: { userId, source: profile.source, fileName, profile: profile.name, rowCount: 1 }
	});
	return persistImportedTransactions({
		userId,
		accountId: bucket.accountId,
		importBatchId: batch.id,
		source: profile.source,
		transactions: parsed.transactions,
		parseDuplicateRows: parsed.summary.duplicateRows
	});
}

describe.each(PROFILES)('$name: the deduplication key ignores the file name', (profile) => {
	it('imports the same statement once, whatever the file is called', async () => {
		// 5 here plus one per runImport call, which asserts its own fixture parsed.
		expect.assertions(7);

		const first = await runImport(profile, profile.row, 'releve-janvier.csv');
		// `releve (1).csv` is what a browser names a second download, which is what a user does
		// when they are not sure the first import worked.
		const second = await runImport(profile, profile.row, 'releve (1).csv');

		expect(first.importedRows).toBe(1);
		expect(first.duplicateRows).toBe(0);
		expect(second.importedRows).toBe(0);
		expect(second.duplicateRows).toBe(1);

		const rows = await prisma.transaction.count({
			where: { userId, account: { source: profile.source } }
		});
		expect(rows).toBe(1);
	});

	it('still imports a genuinely different transaction beside it', async () => {
		expect.assertions(4);

		// THE PRESENCE HALF, and it is the half that can actually fail. Dropping a component from
		// the key makes it wider, so a key that merged everything would satisfy the test above
		// perfectly: one row in, one row out, second import deduplicated. This is what separates
		// "the filename no longer counts" from "nothing counts any more".
		const distinct = await runImport(profile, profile.distinctRow, 'releve-fevrier.csv');

		expect(distinct.importedRows).toBe(1);
		expect(distinct.duplicateRows).toBe(0);

		const rows = await prisma.transaction.count({
			where: { userId, account: { source: profile.source } }
		});
		// Two now: the one from the test above, plus this one.
		expect(rows).toBe(2);
	});
});

/**
 * THE COST OF THE v2 KEY, PINNED RATHER THAN DISCOVERED.
 *
 * `category` and `reference` left the key so that it depends only on what every source
 * guarantees. The price is here: two transactions that differ ONLY in one of those fields, and
 * that arrive in two SEPARATE files, are now one transaction.
 *
 * Within one file they are still two, because the occurrence ordinal separates them. Across
 * files each import starts its own counter, so both are occurrence 0 and the keys match.
 *
 * This is written as a test rather than as a comment because it is a real narrowing and the next
 * reader deserves to meet it as an assertion. If it is ever judged unacceptable, the fix is NOT
 * to put the category back: that makes the key depend on which columns a file carries, and a
 * mapping correction would then rewrite every key the user has. The fix would be a stable
 * per-row identifier the file itself provides, which is what `entry_reference` already is on the
 * bank-sync path.
 */
describe('what the v2 key deliberately no longer separates', () => {
	it('treats two rows differing only by category, in two files, as one transaction', async () => {
		// 4 here plus one per runImport call, which asserts its own fixture parsed.
		expect.assertions(6);

		const profile: Profile = {
			name: 'generic',
			source: 'cost',
			header: 'date;label;amount;category',
			row: '2026-09-01;CostFixture;-4,20;Alimentation',
			distinctRow: '2026-09-01;CostFixture;-4,20;Transport'
		};

		const first = await runImport(profile, profile.row, 'a.csv');
		const second = await runImport(profile, profile.distinctRow, 'b.csv');

		expect(first.importedRows).toBe(1);
		expect(second.importedRows).toBe(0);
		expect(second.duplicateRows).toBe(1);

		const rows = await prisma.transaction.count({
			where: { userId, account: { source: profile.source } }
		});
		expect(rows).toBe(1);
	});

	it('keeps them apart when they arrive in the SAME file, which is what the ordinal buys', async () => {
		// 2 here plus one for the single runImport call.
		expect.assertions(3);

		const profile: Profile = {
			name: 'generic',
			source: 'cost2',
			header: 'date;label;amount;category',
			row: '2026-09-02;CostFixture2;-4,20;Alimentation\n2026-09-02;CostFixture2;-4,20;Transport',
			distinctRow: ''
		};

		const both = await runImport(profile, profile.row, 'together.csv');

		expect(both.importedRows).toBe(2);

		const rows = await prisma.transaction.count({
			where: { userId, account: { source: profile.source } }
		});
		expect(rows).toBe(2);
	});
});
