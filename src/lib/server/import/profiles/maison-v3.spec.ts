import { describe, expect, it, vi } from 'vitest';
import { parseCsvTransactions } from '../csv';
import { parseRows } from '../utils/csv';
import { MAISON_V2_HEADER } from './maison-v2';
import { MAISON_V3_HEADER, matchesMaisonV3Header, readMaisonV3Account } from './maison-v3';
import { buildTransactionsCsv, TRANSACTION_CSV_HEADER } from '$lib/server/transactions/exportCsv';
import type { TransactionRowForMapping } from '$lib/server/transactions/nature';
import type { TransactionNature } from '$lib/domain/transaction';

/**
 * « maison » version 3: version 2 plus the account the rows came from.
 *
 * Version 2 is NOT touched, for the reason version 1 was not touched when version 2 shipped: a
 * file a user exported last month is already on their disk, and an export format is a CONTRACT.
 * The second describe below is what proves it, and it is the one that must never be deleted as
 * redundant. Without it, the first is satisfiable by inferring an account for a v2 file, which is
 * exactly the silent misfiling this whole piece removes.
 *
 * Every assertion here names the two states it separates. A break-check proves a test CAN redden;
 * it does not prove it reddens for the reason it claims.
 */

const NO_MAPPINGS = new Map<string, TransactionNature>();

/** The account name the fixtures export under. A middle dot and spaces, because a bucket name in
 *  this application really is written that way and a name with no punctuation would not exercise
 *  the escaping the column shares with every other user text in the file. */
const ACCOUNT_NAME = 'BP · Compte courant';

function row(overrides: Partial<TransactionRowForMapping> = {}): TransactionRowForMapping {
	return {
		id: 'tx-1',
		date: new Date('2026-06-12T00:00:00.000Z'),
		label: 'Leroy Merlin',
		amountCents: 8000,
		type: 'expense',
		source: 'csv',
		manualCategory: null,
		natureManual: null,
		category: { name: 'Maison' },
		splits: [],
		...overrides
	} as TransactionRowForMapping;
}

describe('profil maison v3', () => {
	it('recognises the header the export writes, and that header is the versioned constant', () => {
		expect.assertions(2);

		const csv = buildTransactionsCsv([row()], NO_MAPPINGS, undefined, {
			accountName: ACCOUNT_NAME
		});

		// Separates « the export writes version 3 » from « the export still writes the version 2
		// header », which is the state this branch starts in.
		expect(csv.split('\r\n')[0]).toBe(MAISON_V3_HEADER);
		// The pin. Separates « the parser was told about the column the export gained » from « a
		// column was added to the export and the parser still recognises only the old shape », which
		// is a file the application produces and then refuses.
		expect(MAISON_V3_HEADER).toBe(TRANSACTION_CSV_HEADER);
	});

	it('reads the account its rows name, and the ten columns before it are unchanged', () => {
		expect.assertions(4);

		const csv = buildTransactionsCsv([row()], NO_MAPPINGS, undefined, {
			accountName: ACCOUNT_NAME
		});
		const parsed = parseCsvTransactions(csv);

		// Separates « recognised by a maison parser » from « fell through to generic, or was refused
		// as header-not-recognized ». Both of those also produce a result object.
		expect(parsed.summary.profile).toBe('maison');
		expect(parsed.invalidRows).toStrictEqual([]);
		// The absolute figure beside the emptiness above: an empty refusal list over an empty
		// transaction list is what a file nobody parsed looks like.
		expect(parsed.transactions).toHaveLength(1);
		// Separates « the account survived the round trip » from « the column is present but empty »,
		// which is what the export writes when it is not told an account.
		expect(readMaisonV3Account(parseRows(csv))).toBe(ACCOUNT_NAME);
	});

	it('carries the account WITHOUT shifting the ten columns before it', () => {
		expect.assertions(2);

		const csv = buildTransactionsCsv([row()], NO_MAPPINGS, undefined, {
			accountName: ACCOUNT_NAME
		});
		const [line] = csv.split('\r\n').slice(1);

		// The literal is the v2 line, byte for byte, plus one column. Separates « one column was
		// appended » from « the projection the v3 parser applies moved a column », which a
		// profile-level assertion cannot see because the parser would still regroup something.
		expect(line).toBe(
			`2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison;${ACCOUNT_NAME}`
		);
		expect(line.split(';')).toHaveLength(11);
	});

	// The correction to the design plate, kept as an assertion rather than a comment. `,Compte` is
	// what was written; `foldExactHeader` lowercases before comparing, so the capitalised form would
	// have PASSED ITS OWN TEST while reading as an inconsistency in the file the user opens.
	it('spells the new column the way every column before it is spelled', () => {
		expect.assertions(3);

		// Separates « consistent with the ten columns already there » from « accepted by the
		// comparator but capitalised », which no header test can tell apart on its own.
		expect(MAISON_V3_HEADER).toBe(MAISON_V3_HEADER.toLowerCase());
		// The absolute figure: a comparison of a string with its own lower case is vacuously true
		// for a string with no letters in it.
		expect(MAISON_V3_HEADER.split(';')).toHaveLength(11);
		// Unaccented, which `foldExactHeader` does NOT fold away, so an accented spelling would be
		// refused rather than silently accepted, and this is the assertion that says which one.
		expect(MAISON_V3_HEADER.normalize('NFD')).toBe(MAISON_V3_HEADER);
	});

	// « A frozen header can receive a VERSION; it can never receive a TOLERANCE. »
	it('refuses a header that merely STARTS WITH the version 3 one', () => {
		expect.assertions(3);

		const appended = `${MAISON_V3_HEADER};solde`;

		// Separates « the set of accepted constants grew » from « the comparator became a
		// starts-with test », which is the loosening the docstring forbids. Both accept a real v3
		// file, so only a file nobody designed can tell them apart.
		expect(matchesMaisonV3Header(appended.split(';'))).toBe(false);
		// The companion: the SAME comparator says yes to the constant it was given.
		expect(matchesMaisonV3Header(MAISON_V3_HEADER.split(';'))).toBe(true);
		// And the file itself is not read as ours. `generic` is the loose profile at the end of the
		// registry, and a third party appending their own column lands there rather than in maison.
		expect(
			parseCsvTransactions(`${appended}\n2026-06-12;x;Maison;-80.00;expense;;csv;-80.00;1/1;;;0`)
				.summary.profile
		).not.toBe('maison');
	});

	// The break-check that produced this test: disabling the header check inside
	// `readMaisonV3Account` left every other assertion in this file green, because a version 2 file
	// is ten columns wide and the account index is past its last cell. An ELEVEN-column file that is
	// not ours is the only fixture that can tell « reads OUR account column » from « reads the last
	// column of whatever it is handed ».
	it('reads the account column of OUR file, never the last column of somebody else file', () => {
		expect.assertions(3);

		const foreign = [
			'date;libelle;montant;devise;solde;reference;canal;pays;statut;frais;agence',
			'2026-08-01;Cafe Fictif;-2,50;EUR;100,00;R1;CB;FR;OK;0,00;Agence Centre',
			'2026-08-02;Boulangerie Fictive;-3,10;EUR;96,90;R2;CB;FR;OK;0,00;Agence Centre'
		].join('\n');

		// The fixture is exactly as wide as ours and its last column is CONSTANT: everything a
		// reader counting from the right would happily take, and « Agence Centre » is a branch name,
		// not an account.
		expect(parseRows(foreign)[0].cells).toHaveLength(11);
		expect(readMaisonV3Account(parseRows(foreign))).toBeNull();
		// The companion that makes the emptiness above mean something: the SAME reader, pointed at a
		// file whose header IS the version 3 constant, answers rather than returning null to
		// everything.
		expect(
			readMaisonV3Account(
				parseRows(
					buildTransactionsCsv([row()], NO_MAPPINGS, undefined, { accountName: ACCOUNT_NAME })
				)
			)
		).toBe(ACCOUNT_NAME);
	});

	it('refuses a row that is missing its account cell rather than reading it as a version 2 line', () => {
		expect.assertions(2);

		// Ten cells under an eleven-column header: a hand-edited file. Separates « short rows are
		// refused » from « short rows are quietly parsed by the version 2 parser this one delegates
		// to », which is what a projection that only trims long rows would do.
		const parsed = parseCsvTransactions(
			[
				MAISON_V3_HEADER,
				"2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison"
			].join('\n')
		);

		expect(parsed.transactions).toStrictEqual([]);
		expect(parsed.invalidRows).toHaveLength(1);
	});

	it('still round-trips when no account is named, which is what an unfitted caller produces', () => {
		expect.assertions(3);

		const csv = buildTransactionsCsv([row()], NO_MAPPINGS);
		const parsed = parseCsvTransactions(csv);

		// Separates « the column is present and blank » from « the column is absent », which would
		// make the file a v2 file wearing a v3 header and refuse every row on its column count.
		expect(csv.split('\r\n')[1].split(';')).toHaveLength(11);
		expect(parsed.transactions).toHaveLength(1);
		// A blank column names no account. Separates « no account » from « the empty string as an
		// account name », which would resolve to nothing and be reported as a missing account.
		expect(readMaisonV3Account(parseRows(csv))).toBeNull();
	});
});

/**
 * THIS IS THE ONE THAT STOPS THE FIRST BEING SATISFIED BY GUESSING.
 *
 * A file at the exact PREVIOUS header stays recognised and takes NO account by default. Without
 * it, the tests above are satisfiable by inferring an account for a v2 file too, which is the
 * silent misfiling this whole piece exists to remove.
 *
 * It is a GUARD: it passed before `maison-v3.ts` existed and it passes after, and saying so is the
 * point rather than an embarrassment. What it can catch is a later change, and the change it is
 * aimed at is the plausible one: teaching rank 2 to read « the last column » instead of « the
 * account column of a file whose header is the version 3 constant ».
 */
describe('a file at the exact previous header', () => {
	const V2_ROW = "2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison";
	const v2File = `${MAISON_V2_HEADER}\r\n${V2_ROW}`;

	it('stays recognised as maison, and names no account of its own', () => {
		expect.assertions(3);

		const parsed = parseCsvTransactions(v2File);

		// Separates « version 2 still parses » from « version 3 replaced it », which is the whole
		// contract with a file already on a user's disk.
		expect(parsed.summary.profile).toBe('maison');
		expect(parsed.transactions).toHaveLength(1);
		// Separates « no account is read from a v2 file » from « an account is read from one ».
		//
		// MEASURED, and it corrects what this comment said first: a v2 file is refused TWICE OVER,
		// and the header check is not the half doing the work here. The account column's index is 10,
		// which is past the last cell of a ten-column row, so the reader answers null even with its
		// header check disabled. A break-check pointed at that check came back green through this
		// assertion. The file that separates the two is eleven columns wide and NOT ours, and it has
		// its own test above.
		expect(readMaisonV3Account(parseRows(v2File))).toBeNull();
	});

	it('falls to rank 3 with no accountId in the answer', async () => {
		expect.assertions(3);

		const findMany = vi.fn().mockResolvedValue([]);
		vi.doMock('$lib/server/db', () => ({
			prisma: { importSourceSignature: { findMany }, account: { findFirst: vi.fn() } }
		}));
		const { resolveStatementAccount } = await import('../sourceSignature');

		const resolution = await resolveStatementAccount({
			userId: 'user-mine',
			rows: parseRows(v2File),
			accounts: [{ id: 'account-a', source: 'csv', archivedAt: null, discriminant: '4417' }]
		});

		// Separates « the file named nothing, so we ask » from « rank 1 or rank 2 answered », which
		// are the two states that decide whether the user is shown a statement or a question.
		expect(resolution.rank).toBe(3);
		expect('accountId' in resolution).toBe(false);
		// The companion figure: rank 3 with an empty candidate list is « never seen before », and it
		// is reached only because the memory was actually consulted.
		expect(findMany).toHaveBeenCalledTimes(1);

		vi.doUnmock('$lib/server/db');
		vi.resetModules();
	});
});
