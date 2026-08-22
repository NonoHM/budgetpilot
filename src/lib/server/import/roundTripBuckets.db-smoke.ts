import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { buildTransactionsCsv } from '$lib/server/transactions/exportCsv';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { MAISON_V3_HEADER, readMaisonV3Account } from './profiles/maison-v3';
import { parseCsvTransactions } from './csv';
import { parseRows } from './utils/csv';
import { persistImportedTransactions, resolveImportBucketAccount } from './persist';

/**
 * The round trip a user actually performs: import a statement, export, re-import.
 *
 * ## WHAT THIS FILE USED TO MEASURE, AND WHY THE FIGURES ARE QUOTED RATHER THAN DELETED
 *
 * It was written as a MEASUREMENT of a defect rather than as a guard, and it asserted the defect's
 * figures so that they could not drift unnoticed. Its own console line printed:
 *
 *     [round-trip] re-import of own export: imported=1 duplicate=0, buckets=2, rows=2
 *
 * One bank statement in, one export out, and the re-import produced a SECOND transaction in a
 * SECOND account. The reason was one line: the export's header was byte-identical to
 * `MAISON_V2_HEADER`, so BudgetPilot's own file was read back by the `maison-v2` profile, which
 * buckets as `csv`, while the rows had arrived through `banque-populaire`, which buckets
 * elsewhere. The v3 deduplication key carries the `Account.id`, so two buckets are two keys and
 * nothing matched. `docs/getting-started.md` advertises this round trip, so it was not a path a
 * user had to go looking for.
 *
 * The figures are quoted rather than dropped because a file that quietly starts asserting the
 * opposite of what it asserted yesterday records nothing. Those are what it measured; the
 * assertions below are what it measures now, and the difference is the whole of E1-b.
 *
 * ## WHAT IT MEASURES NOW: imported=0 duplicate=1, buckets=1, rows=1
 *
 * The export writes `MAISON_V3_HEADER`, whose last column NAMES the account the rows came from, so
 * the re-import can land back on the account the rows left instead of in a fresh CSV bucket. Same
 * account, same content, therefore the same key: the row is recognised as the duplicate it is.
 *
 * ## The lookup below is the test's own, and that is stated rather than disguised
 *
 * `resolveStatementAccount`'s rank 2 is not wired yet (see its own comment). What IS wired is the
 * READER, `readMaisonV3Account`, the single place the account column is interpreted and what
 * rank 2 will call, so the file's answer is not re-derived here, only resolved. The resolution
 * itself, one `nameKey` lookup, is unambiguous in this fixture because at the moment it runs the
 * user holds exactly one account. IT IS NOT UNAMBIGUOUS IN GENERAL: the three CSV buckets share
 * the literal name `Compte import CSV` and differ by `source`, so rank 2 has a disambiguation to
 * make that this file deliberately does not model.
 */

const BP_HEADER = BANQUE_POPULAIRE_HEADERS.join(';');
const BP_ROW =
	'01/08/2026;SUPERETTE;PAIEMENT CB SUPERETTE;REF001;;Carte;Alimentation;Courses;-8,40;;01/08/2026;01/08/2026;';

/** The literal `routes/import/+page.server.ts` uses for all three CSV sources. Kept rather than
 *  made distinctive: the sequence this file measures is the one the application performs. */
const BUCKET_NAME = 'Compte import CSV';

let userId = '';

beforeAll(async () => {
	const user = await prisma.user.create({
		data: { email: `roundtrip-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
});

/**
 * One import, into an account the CALLER decides.
 *
 * The destination used to be resolved in here from `(name, source)`, which is what made step 3
 * unable to land anywhere but a fresh `csv` bucket however the file was read. Lifting it to the
 * caller is what lets step 3 follow the file instead.
 */
async function importFile(
	body: string,
	{ source, fileName, accountId }: { source: string; fileName: string; accountId: string }
) {
	const parsed = parseCsvTransactions(body, { sourceName: fileName });
	expect(parsed.invalidRows, `${fileName} must parse`).toStrictEqual([]);
	const batch = await prisma.importBatch.create({
		data: {
			userId,
			source,
			fileName,
			profile: parsed.summary.profile,
			rowCount: parsed.summary.totalRows
		}
	});
	const result = await persistImportedTransactions({
		userId,
		accountId,
		importBatchId: batch.id,
		source,
		transactions: parsed.transactions
	});
	return { profile: parsed.summary.profile, ...result };
}

describe('re-importing BudgetPilot own export after a bank-profile import', () => {
	it('lands the export back on the account it came from, so nothing is imported twice', async () => {
		// 10 here plus one per importFile call, which asserts its own fixture parsed.
		expect.assertions(12);

		// 1. The bank statement, through the profile that recognises it.
		const bucket = await resolveImportBucketAccount({
			userId,
			name: BUCKET_NAME,
			source: 'banque_populaire'
		});
		const first = await importFile(`${BP_HEADER}\n${BP_ROW}\n`, {
			source: 'banque_populaire',
			fileName: 'releve.csv',
			accountId: bucket.accountId
		});
		expect(first.profile).toBe('banque-populaire');
		expect(first.importedRows).toBe(1);

		// 2. The user exports their transactions. This is the download route's own function.
		const stored = await prisma.transaction.findMany({
			where: { userId },
			include: { category: true, splits: { include: { category: true } } }
		});
		const exported = buildTransactionsCsv(
			stored.map((row) => ({
				date: row.date,
				label: row.label,
				categoryName: row.category.name,
				amountCents: Number(row.amountCents),
				type: row.type,
				natureManual: row.natureManual,
				manualCategory: row.manualCategory,
				source: row.source,
				splits: []
			})) as never,
			// No nature mapping and no category filter: this measures the round trip, not the
			// nature derivation, and a filtered export is a view of the screen rather than a
			// backup (see exportCsv.ts).
			new Map(),
			undefined,
			{ accountName: BUCKET_NAME }
		);

		// Separates « the export writes the version the parser reads today » from « it still writes
		// the version 2 header », which is the state that sent the re-import into another bucket.
		expect(exported.split('\r\n')[0]).toBe(MAISON_V3_HEADER);

		// 3. The user re-imports it, which docs/getting-started.md advertises. The destination comes
		//    from the FILE now, through the one reader that interprets that column.
		const named = readMaisonV3Account(parseRows(exported));
		// Separates « the file names the account its rows came from » from « the column is present
		// and empty », which is what an export written by a caller with no account produces and
		// which would send this import straight back into a second bucket.
		expect(named).toBe(BUCKET_NAME);
		const destination = await prisma.account.findFirst({
			where: { userId, nameKey: computeNameKey(named as string) },
			select: { id: true }
		});
		// The companion figure for the lookup: it found something, and what it found is the account
		// the statement was imported into rather than a bucket created along the way.
		expect(destination?.id).toBe(bucket.accountId);

		const second = await importFile(exported, {
			source: 'csv',
			fileName: 'budgetpilot-export.csv',
			accountId: destination?.id as string
		});
		// `maison` rather than a per-version name: `CsvImportProfile` has one member for the family
		// and the summary a user reads says « maison ». Either way `getImportSource` buckets it as
		// `csv`, which is exactly what the account column now overrides.
		expect(second.profile).toBe('maison');

		// THE FIGURES. Was imported=1 duplicate=0, buckets=2, rows=2 (see the docstring).
		expect(second.importedRows).toBe(0);
		expect(second.duplicateRows).toBe(1);
		// Both counts, not one: `imported=0` alone is also what a re-import that refused every row
		// would report, and that would leave the row count right and the duplicate count at zero.
		expect(await prisma.account.count({ where: { userId } })).toBe(1);
		expect(await prisma.transaction.count({ where: { userId } })).toBe(1);
	});
});
