import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '$lib/server/db';
import { buildTransactionsCsv } from '$lib/server/transactions/exportCsv';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { parseCsvTransactions } from './csv';
import { persistImportedTransactions, resolveImportBucketAccount } from './persist';

/**
 * MEASUREMENT: how does a user actually meet the cross-profile change v3 introduces?
 *
 * v3 puts the `Account.id` in the key, a CSV bucket is per PROFILE, and the profile decides the
 * bucket (`getImportSource`: `banque-populaire`, `revolut`, everything else `csv`). So the same
 * transaction read through two profiles is two accounts and imports twice, where the previous key
 * absorbed the second silently.
 *
 * The question this file answers is whether that needs a deliberate act nobody performs, or arrives
 * on a sequence the application advertises. It is the second, and the reason is one line:
 * `TRANSACTION_CSV_HEADER` is byte-identical to `MAISON_V2_HEADER`, so BudgetPilot's OWN export is
 * read back by the `maison-v2` profile, which buckets as `csv`. Rows that arrived through
 * `banque-populaire` are in a different bucket.
 *
 * `docs/getting-started.md` advertises the round trip and `round-trip.spec.ts` guards it as a
 * contract, so this is not a path a user has to go looking for.
 */

const BP_HEADER = BANQUE_POPULAIRE_HEADERS.join(';');
const BP_ROW =
	'01/08/2026;SUPERETTE;PAIEMENT CB SUPERETTE;REF001;;Carte;Alimentation;Courses;-8,40;;01/08/2026;01/08/2026;';

let userId = '';

beforeAll(async () => {
	const user = await prisma.user.create({
		data: { email: `roundtrip-${Date.now()}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	userId = user.id;
});

async function importFile(body: string, profileSource: string, fileName: string) {
	const parsed = parseCsvTransactions(body, { sourceName: fileName });
	expect(parsed.invalidRows, `${fileName} must parse`).toStrictEqual([]);
	const bucket = await resolveImportBucketAccount({
		userId,
		name: 'Compte import CSV',
		source: profileSource
	});
	const batch = await prisma.importBatch.create({
		data: {
			userId,
			source: profileSource,
			fileName,
			profile: parsed.summary.profile,
			rowCount: parsed.summary.totalRows
		}
	});
	const result = await persistImportedTransactions({
		userId,
		accountId: bucket.accountId,
		importBatchId: batch.id,
		source: profileSource,
		transactions: parsed.transactions
	});
	return { profile: parsed.summary.profile, ...result };
}

describe('re-importing BudgetPilot own export after a bank-profile import', () => {
	it('measures the sequence a user actually performs', async () => {
		// 6 here plus one per importFile call, which asserts its own fixture parsed.
		expect.assertions(8);

		// 1. The bank statement, through the profile that recognises it.
		const first = await importFile(`${BP_HEADER}\n${BP_ROW}\n`, 'banque_populaire', 'releve.csv');
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
			new Map()
		);

		// The header the export writes is the header maison-v2 matches on. That single fact is
		// what makes this sequence reachable rather than contrived.
		expect(exported.split('\r\n')[0]).toBe(
			'date;libelle;categorie;montant;type;nature;source_bancaire;montant_total;part;categorie_parent'
		);

		// 3. The user re-imports it, which docs/getting-started.md advertises.
		const second = await importFile(exported, 'csv', 'budgetpilot-export.csv');
		//  rather than  because this row carries no répartition. Either way it is a
		// maison-family profile, and getImportSource buckets both as .
		expect(second.profile).toBe('maison');

		// THE FIGURE. 0 imported / 1 duplicate is the previous behaviour; 1 imported / 0 duplicate
		// is v3 separating the two buckets.
		console.log(
			`[round-trip] re-import of own export: imported=${second.importedRows} duplicate=${second.duplicateRows}, ` +
				`buckets=${await prisma.account.count({ where: { userId } })}, ` +
				`rows=${await prisma.transaction.count({ where: { userId } })}`
		);
		expect(second.importedRows).toBe(1);
		expect(second.duplicateRows).toBe(0);
	});
});
