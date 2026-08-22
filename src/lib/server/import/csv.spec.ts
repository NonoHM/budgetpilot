import { describe, expect, it } from 'vitest';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { parseCsvTransactions, sanitizeImportedText } from './csv';
import { assignDedupeKeysForBatch } from './dedupeRecompute';

/**
 * The bucket a CSV run lands on. The key is no longer built at parse time, so a spec that wants to
 * talk about fingerprints asks the WRITE path what it would write, through the same function the
 * write path calls. Retyping the key format here instead would assert the copy.
 */
const CSV_BUCKET = {
	accountId: 'account-1',
	source: 'csv',
	currency: 'EUR',
	exponent: 2,
	providerAccountId: null
};

const BANQUE_POPULAIRE_HEADER =
	'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation';
const REVOLUT_HEADER =
	'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde';
const REVOLUT_MOJIBAKE_HEADER =
	'Type,Produit,Date de dÃ©but,Date de fin,Description,Montant,Frais,Devise,Ã‰tat,Solde';

function parseBanquePopulaireLine(line: string, sourceName?: string) {
	return parseCsvTransactions(`${BANQUE_POPULAIRE_HEADER}\n${line}`, { sourceName });
}

describe('parseCsvTransactions', () => {
	it('importe un CSV valide avec montant en centimes', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(
			'date;label;amount;category\n2026-06-01;Salaire;2500,50;Revenus\n01/06/2026;Courses;-42.10;Alimentation'
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(2);
		expect(result.transactions[0].amountCents).toBe(250_050);
		expect(result.transactions[1]).toMatchObject({
			date: '2026-06-01',
			amountCents: -4_210
		});
	});

	it('ignore une colonne inconnue au lieu de refuser tout le fichier', () => {
		expect.assertions(4);

		// This asserted the OPPOSITE until the alias table landed: one unrecognised column
		// refused the whole file, which is why no real bank statement imported.
		const unknownColumn = parseCsvTransactions(
			'date;label;amount;iban\n2026-06-01;Achat;-10;FR76...'
		);

		expect(unknownColumn.invalidRows).toStrictEqual([]);
		expect(unknownColumn.transactions).toHaveLength(1);
		expect(unknownColumn.transactions[0].label).toBe('Achat');
		// Dropped means DROPPED: the ignored column's value must not have been read into any
		// role. Without this, a resolver that silently took `iban` as the label would pass the
		// three assertions above.
		expect(JSON.stringify(unknownColumn.transactions[0])).not.toContain('FR76');
	});

	it('refuse un en-tête dupliqué, parce que la dernière colonne écraserait la première', () => {
		expect.assertions(2);

		// Kept for a sharper reason than ambiguity: `toRecord` assigns
		// `record[header] = row[index]`, so a later duplicate OVERWRITES an earlier one and the
		// last column silently wins. This refusal is the only thing making that unreachable.
		const duplicateHeader = parseCsvTransactions(
			'date;label;amount;label\n2026-06-01;Achat;-10;Autre'
		);

		expect(duplicateHeader.transactions).toStrictEqual([]);
		expect(duplicateHeader.invalidRows[0].fact).toStrictEqual({
			code: 'duplicate-column',
			column: 'label'
		});
	});

	it('imports two identical rows as two transactions, with different keys', () => {
		expect.assertions(4);

		// This test asserted the opposite until the key gained its occurrence ordinal: one
		// transaction and one duplicate. That was the defect rather than the contract. Two coffees
		// at the same price on the same day at the same merchant is ordinary, and collapsing them
		// dropped the second with nothing to report it, which is the failure direction nobody can
		// see. A duplicate is visible on the screen; a missing row is not.
		const duplicates = parseCsvTransactions(
			'date;label;amount;category\n2026-06-01;Achat;-10;Divers\n2026-06-01;Achat;-10;Divers'
		);

		expect(duplicates.transactions).toHaveLength(2);
		expect(duplicates.summary.duplicateRows).toBe(0);
		// The keys differ, which is what lets the database keep both rather than rejecting the
		// second on the unique constraint. Asserting only the count would pass on two rows sharing
		// one key, and the loss would move from the parser to the insert.
		const [first, second] = assignDedupeKeysForBatch(duplicates.transactions, CSV_BUCKET);
		expect(first).not.toBe(second);
		// The ordinals are 0 and 1, in file order, rather than merely different. Read from the
		// RIGHT: a label may contain the delimiter, so counting fields from the left measures
		// whether this fixture's label happens to have one.
		expect([first?.split('|').at(-1), second?.split('|').at(-1)]).toEqual(['0', '1']);
	});

	it('neutralizes labels compatible with a formula injection', () => {
		expect.assertions(5);

		expect(sanitizeImportedText('=IMPORTXML("https://example.test")')).toBe(
			'\'=IMPORTXML("https://example.test")'
		);
		expect(sanitizeImportedText('+150,00')).toBe("'+150,00");
		expect(sanitizeImportedText('-30,00')).toBe("'-30,00");
		expect(sanitizeImportedText('@cmd')).toBe("'@cmd");
		expect(sanitizeImportedText('Courses')).toBe('Courses');
	});

	it('applique les limites de taille et de lignes', () => {
		expect.assertions(2);

		expect(
			parseCsvTransactions('date,label,amount\n2026-06-01,A,-1', { maxBytes: 10 }).invalidRows[0]
		).toMatchObject({
			scope: { kind: 'file' },
			fact: { code: 'file-too-large' }
		});
		expect(
			parseCsvTransactions('date,label,amount\n2026-06-01,A,-1\n2026-06-02,B,-2', { maxRows: 1 })
				.invalidRows[0]
		).toEqual({
			scope: { kind: 'file' },
			fact: { code: 'too-many-rows', max: 1 }
		});
	});

	it('auto-detects the Banque Populaire profile', () => {
		expect.assertions(2);

		const result = parseBanquePopulaireLine(
			'24/06/2026;CARREFOUR;PAIEMENT CB CARREFOUR;REF001;;Carte bancaire;Courses;Supermarché;42,90;;23/06/2026;24/06/2026;0'
		);

		expect(result.summary.profile).toBe('banque-populaire');
		expect(result.invalidRows).toStrictEqual([]);
	});

	it('rejects an altered Banque Populaire header in forced profile mode', () => {
		expect.assertions(2);

		const alteredHeader = BANQUE_POPULAIRE_HEADER.replace('Libelle simplifie', 'Libellé simplifié');
		const result = parseCsvTransactions(
			`${alteredHeader}\n24/06/2026;A;A;REF001;;Carte bancaire;Autre;;10,00;;24/06/2026;24/06/2026;0`,
			{ profile: 'banque-populaire' }
		);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toEqual([
			{
				scope: { kind: 'header' },
				fact: { code: 'header-not-recognized', profile: 'Banque Populaire' }
			}
		]);
	});

	it('imports a Banque Populaire expense with a positive debit', () => {
		expect.assertions(3);

		const result = parseBanquePopulaireLine(
			'24/06/2026;CARREFOUR;PAIEMENT CB CARREFOUR;REF001;;Carte bancaire;Courses;Supermarché;42,90;;23/06/2026;24/06/2026;0'
		);

		expect(result.transactions[0].metadata.type).toBe('expense');
		expect(result.transactions[0].amountCents).toBe(4_290);
		expect(result.summary.totalDebitCents).toBe(4_290);
	});

	it('imports a Banque Populaire expense with a negative debit', () => {
		expect.assertions(2);

		const result = parseBanquePopulaireLine(
			'24/06/2026;AUCHAN;AUCHAN 0065 SC 78MAUREPAS;REFAUCHAN;220626 CB****0000-;Carte bancaire;Alimentation;Hyper/supermarche;-38,46;;23/06/2026;23/06/2026;0'
		);

		expect(result.transactions[0].metadata.type).toBe('expense');
		expect(result.transactions[0].amountCents).toBe(3_846);
	});

	it('imports a Banque Populaire income with a credit', () => {
		expect.assertions(3);

		const result = parseBanquePopulaireLine(
			'24/06/2026;SALAIRE;VIREMENT SALAIRE;REF002;;Virement;Revenus;Salaire;;1200,00;24/06/2026;24/06/2026;0'
		);

		expect(result.transactions[0].metadata.type).toBe('income');
		expect(result.transactions[0].amountCents).toBe(120_000);
		expect(result.summary.totalCreditCents).toBe(120_000);
	});

	it('imports a Banque Populaire credit with a plus sign', () => {
		expect.assertions(6);

		const result = parseBanquePopulaireLine(
			'22/06/2026;+M PAUL PAUL;VIR M PAUL PAUL;REFVIR;Vir. vers Compte Cheque-;Virement recu;Transaction exclue;Virement interne;;+150,00;20/06/2026;20/06/2026;0'
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions[0].metadata.type).toBe('income');
		expect(result.transactions[0].amountCents).toBe(15_000);
		expect(result.summary.totalCreditCents).toBe(15_000);
		expect(result.transactions[0].metadata.csvFields?.Credit).toBe('+150,00');
		expect(result.transactions[0].metadata.csvFields?.['Libelle simplifie']).toBe("'+M PAUL PAUL");
	});

	it('conserve et compte normalement les lignes Transaction exclue / Virement interne Banque Populaire', () => {
		expect.assertions(5);

		const result = parseBanquePopulaireLine(
			'22/06/2026;+M PAUL PAUL;VIR M PAUL PAUL;REFVIR;Vir. vers Compte Cheque-;Virement recu;Transaction exclue;Virement interne;;+150,00;20/06/2026;20/06/2026;0'
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
		expect(result.transactions[0].metadata.type).toBe('income');
		expect(result.transactions[0].metadata.banquePopulaireCategory).toBe('Transaction exclue');
	});

	it('imports a negative Banque Populaire credit with a warning', () => {
		expect.assertions(3);

		const result = parseBanquePopulaireLine(
			'24/06/2026;REMBOURSEMENT;REMBOURSEMENT;REFNEG;;Virement;Revenus;;;-1200,00;24/06/2026;24/06/2026;0'
		);

		expect(result.transactions[0].metadata.type).toBe('income');
		expect(result.transactions[0].amountCents).toBe(120_000);
		expect(result.warnings).toContain('Ligne 2: crédit négatif');
	});

	it('parses French Banque Populaire amount formats and formats with spaces', () => {
		expect.assertions(8);

		const comma = parseBanquePopulaireLine(
			'24/06/2026;A;A;REF001;;Carte bancaire;Autre;;42,90;;24/06/2026;24/06/2026;0'
		);
		const creditComma = parseBanquePopulaireLine(
			'24/06/2026;A;A;REF101;;Virement;Autre;;;150,00;24/06/2026;24/06/2026;0'
		);
		const creditPlus = parseBanquePopulaireLine(
			'24/06/2026;A;A;REF102;;Virement;Autre;;;+150,00;24/06/2026;24/06/2026;0'
		);
		const debitPlusSpace = parseBanquePopulaireLine(
			'24/06/2026;B;B;REF103;;Carte bancaire;Autre;;+1 234,56;;24/06/2026;24/06/2026;0'
		);
		const space = parseBanquePopulaireLine(
			'24/06/2026;B;B;REF002;;Carte bancaire;Autre;;1 234,56;;24/06/2026;24/06/2026;0'
		);
		const negativeSpace = parseBanquePopulaireLine(
			'24/06/2026;C;C;REF003;;Carte bancaire;Autre;;-1 234,56;;24/06/2026;24/06/2026;0'
		);
		const dot = parseBanquePopulaireLine(
			'24/06/2026;D;D;REF004;;Carte bancaire;Autre;;42.90;;24/06/2026;24/06/2026;0'
		);
		const creditPlusDot = parseBanquePopulaireLine(
			'24/06/2026;E;E;REF005;;Virement;Autre;;;+150.00;24/06/2026;24/06/2026;0'
		);

		expect(comma.transactions[0].amountCents).toBe(4_290);
		expect(creditComma.transactions[0].amountCents).toBe(15_000);
		expect(creditPlus.transactions[0].amountCents).toBe(15_000);
		expect(debitPlusSpace.transactions[0].amountCents).toBe(123_456);
		expect(space.transactions[0].amountCents).toBe(123_456);
		expect(negativeSpace.transactions[0].amountCents).toBe(123_456);
		expect(dot.transactions[0].amountCents).toBe(4_290);
		expect(creditPlusDot.transactions[0].amountCents).toBe(15_000);
	});

	it('imports a Banque Populaire debit with a minus sign', () => {
		expect.assertions(4);

		const result = parseBanquePopulaireLine(
			'22/06/2026;REVOLUT;REVOLUT TEST;REFREV;210626 CB****0000-30,00EUR;Carte bancaire;Banque et assurances;Banque et assurance - autre;-30,00;;22/06/2026;22/06/2026;0'
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions[0].metadata.type).toBe('expense');
		expect(result.transactions[0].amountCents).toBe(3_000);
		expect(result.summary.totalDebitCents).toBe(3_000);
	});

	it('imports a Banque Populaire debit with no sign', () => {
		expect.assertions(3);

		const result = parseBanquePopulaireLine(
			'22/06/2026;REVOLUT;REVOLUT TEST;REFREV;210626 CB****0000-30,00EUR;Carte bancaire;Banque et assurances;Banque et assurance - autre;30,00;;22/06/2026;22/06/2026;0'
		);

		expect(result.transactions[0].metadata.type).toBe('expense');
		expect(result.transactions[0].amountCents).toBe(3_000);
		expect(result.summary.totalDebitCents).toBe(3_000);
	});

	it('imports a negative Banque Populaire amount with spaces as an absolute value', () => {
		expect.assertions(2);

		const result = parseBanquePopulaireLine(
			'24/06/2026;C;C;REFSPACE;;Carte bancaire;Autre;;-1 234,56;;24/06/2026;24/06/2026;0'
		);

		expect(result.transactions[0].metadata.type).toBe('expense');
		expect(result.transactions[0].amountCents).toBe(123_456);
	});

	it('signale les lignes Banque Populaire invalides sans planter', () => {
		expect.assertions(6);

		const emptyAmounts = parseBanquePopulaireLine(
			'24/06/2026;VIDE;VIDE;REF001;;Carte bancaire;Autre;;;;24/06/2026;24/06/2026;0'
		);
		const ambiguousAmounts = parseBanquePopulaireLine(
			'24/06/2026;AMBIGU;AMBIGU;REF002;;Carte bancaire;Autre;;10,00;1,00;24/06/2026;24/06/2026;0'
		);

		expect(emptyAmounts.transactions).toHaveLength(0);
		expect(emptyAmounts.invalidRows[0]).toEqual({
			scope: { kind: 'row', line: 2 },
			fact: { code: 'debit-credit-empty' },
			field: 'Debit/Credit'
		});
		expect(emptyAmounts.summary.invalidRows).toBe(1);
		expect(ambiguousAmounts.transactions).toHaveLength(0);
		expect(ambiguousAmounts.invalidRows[0]).toEqual({
			scope: { kind: 'row', line: 2 },
			fact: { code: 'debit-credit-both' },
			field: 'Debit/Credit'
		});
		expect(ambiguousAmounts.summary.invalidRows).toBe(1);
	});

	it('reports an invalid generic date with a clear field', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			'date;label;amount;category\n2026-99-99;Courses;-42,10;Alimentation'
		);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toEqual({
			scope: { kind: 'row', line: 2 },
			fact: { code: 'invalid-date', column: 'date', value: '2026-99-99' },
			field: 'date'
		});
	});

	it('signale un nombre de colonnes incorrect avec un champ clair', () => {
		expect.assertions(2);

		const result = parseCsvTransactions('date;label;amount;category\n2026-06-01;Courses;-42,10');

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toEqual({
			scope: { kind: 'row', line: 2 },
			fact: { code: 'bad-column-count', expected: 4, actual: 3 },
			field: 'colonnes'
		});
	});

	it('ignores empty lines and keeps the source line number of errors', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			'date;label;amount;category\n\n2026-99-99;Courses;-42,10;Alimentation'
		);

		expect(result.summary.totalRows).toBe(1);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].scope).toEqual({ kind: 'row', line: 3 });
	});

	it('marks a Banque Populaire footer as an ignored line', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(`${BANQUE_POPULAIRE_HEADER}\nSolde au 24/06/2026;123,45`);

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows[0]).toEqual({
			scope: { kind: 'row', line: 2 },
			fact: { code: 'footer-ignored' },
			field: 'line'
		});
		// ZERO, and the line is still listed above. A footer is a line the parser read correctly and
		// had nothing to import from, so it is neither valid nor invalid: it leaves the partition by
		// leaving `totalRows` rather than by being called a failure.
		expect(result.summary.invalidRows).toBe(0);
		expect(result.summary.totalRows).toBe(0);
	});

	it('prefers Date operation over Date de comptabilisation', () => {
		expect.assertions(3);

		const result = parseBanquePopulaireLine(
			'24/06/2026;CARREFOUR;PAIEMENT CB CARREFOUR;REF001;;Carte bancaire;Courses;Supermarché;42,90;;23/06/2026;24/06/2026;0'
		);
		const dashDate = parseBanquePopulaireLine(
			'24/06/2026;CARREFOUR;PAIEMENT CB CARREFOUR;REF002;;Carte bancaire;Courses;Supermarché;42,90;;23-06-2026;24/06/2026;0'
		);
		const invalidOperationDate = parseBanquePopulaireLine(
			'22/06/2026;CARREFOUR;PAIEMENT CB CARREFOUR;REF003;;Carte bancaire;Courses;Supermarché;42,90;;99/99/2026;24/06/2026;0'
		);

		expect(result.transactions[0].date).toBe('2026-06-23');
		expect(dashDate.transactions[0].date).toBe('2026-06-23');
		expect(invalidOperationDate.transactions[0].date).toBe('2026-06-22');
	});

	it('uses Autre if the Banque Populaire category is absent', () => {
		expect.assertions(2);

		const result = parseBanquePopulaireLine(
			'24/06/2026;OPERATION;OPERATION;REF001;;Carte bancaire;;;10,00;;24/06/2026;24/06/2026;0'
		);

		// Without a categorization rule, category is always 'Non catégorisé'.
		// The BP operation type (fallback 'Autre') is kept in bankOperationType.
		expect(result.transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
		expect(result.transactions[0].metadata.bankOperationType).toBe('Autre');
	});

	it('neutralise les formules Banque Populaire sur les champs texte', () => {
		expect.assertions(3);

		const result = parseBanquePopulaireLine(
			'24/06/2026;=CMD|calc!A0;=DETAIL;REF004;;Carte bancaire;Autre;;10,00;;24/06/2026;24/06/2026;0'
		);

		expect(result.transactions[0].label).toBe("'=CMD|calc!A0");
		expect(result.transactions[0].metadata.notes).toContain("'=DETAIL");
		expect(result.transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
	});

	it('imports two identical Banque Populaire rows as two, no longer keyed on the reference', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(
			`${BANQUE_POPULAIRE_HEADER}\n` +
				'24/06/2026;A;A;REFDUP;;Carte bancaire;Autre;;10,00;;24/06/2026;24/06/2026;0\n' +
				'24/06/2026;A;A;REFDUP;;Carte bancaire;Autre;;10,00;;24/06/2026;24/06/2026;0'
		);

		expect(result.transactions).toHaveLength(2);
		expect(result.summary.duplicateRows).toBe(0);
		// The statement reference is NO LONGER in the key, and that is the point of this
		// assertion rather than an incidental consequence. Keying on it made the key depend on a
		// column the file may or may not carry: a bank that stops emitting the reference, or
		// leaves it blank on one row, produced a different key for a transaction already
		// imported. The two rows are now separated by their occurrence instead.
		const keys = assignDedupeKeysForBatch(result.transactions, CSV_BUCKET);
		expect(keys[0]).not.toContain('REFDUP');
		expect(keys.map((key) => key?.split('|').at(-1))).toEqual(['0', '1']);
	});

	it('importe l’exemple AUCHAN Banque Populaire complet', () => {
		expect.assertions(10);

		const result = parseBanquePopulaireLine(
			'23/06/2026;AUCHAN;AUCHAN 0065 SC 78MAUREPAS;80FDBFG;220626 CB****2593-;Carte bancaire;Alimentation;Hyper/supermarche;-38,46;;23/06/2026;23/06/2026;0',
			'Compte CSV'
		);
		const transaction = result.transactions[0];

		expect(transaction.label).toBe('AUCHAN');
		// Without a categorization rule, category is 'Non catégorisé'.
		// The BP operation type ('Alimentation') is preserved in metadata.banquePopulaireCategory.
		expect(transaction.category).toBe(UNCLASSIFIED_CATEGORY);
		expect(transaction.metadata.banquePopulaireCategory).toBe('Alimentation');
		expect(transaction.date).toBe('2026-06-23');
		expect(transaction.metadata.type).toBe('expense');
		expect(transaction.amountCents).toBe(3_846);
		expect(transaction.metadata.reference).toBe('80FDBFG');
		expect(transaction.metadata.subcategory).toBe('Hyper/supermarche');
		expect(transaction.metadata.notes).toContain('AUCHAN 0065 SC 78MAUREPAS');
		expect(transaction.metadata.notes).toContain('Carte bancaire');
	});

	it('keeps the generic import behavior in forced mode', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			'date;label;amount;category\n2026-06-01;Courses;-42.10;Alimentation',
			{
				profile: 'generic'
			}
		);

		expect(result.summary.profile).toBe('generic');
		expect(result.transactions[0].amountCents).toBe(-4_210);
		expect(result.transactions[0].metadata.type).toBe('expense');
	});

	it('does not deduplicate two generic lines from different categories', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			'date;label;amount;category\n2026-06-01;Achat;-10;Alimentation\n2026-06-01;Achat;-10;Loisirs',
			{ profile: 'generic' }
		);

		expect(result.transactions).toHaveLength(2);
		expect(result.invalidRows).toStrictEqual([]);
	});

	it('auto-detects a Revolut export with a normal header', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(
			`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Patreon,-7.80,0.00,EUR,TERMINÉ,114.00`
		);

		expect(result.summary.profile).toBe('revolut');
		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions[0].metadata.type).toBe('expense');
		expect(result.transactions[0].amountCents).toBe(780);
	});

	it('detects Revolut with a mojibake header and normalizes TERMINÉ', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(
			`${REVOLUT_MOJIBAKE_HEADER}\nAjout de fonds,Valeur actuelle,2026-05-04 18:52:52,2026-05-04 18:53:06,Recharge via *2593,60.00,0.00,EUR,TERMINÃ‰,73.98`
		);

		expect(result.summary.profile).toBe('revolut');
		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions[0].metadata.type).toBe('income');
		expect(result.transactions[0].amountCents).toBe(6_000);
	});

	it('utilise Date de fin Revolut si elle est valide', () => {
		expect.assertions(1);

		const result = parseCsvTransactions(
			`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-02 05:37:37,Patreon,-7.80,0.00,EUR,TERMINÉ,114.00`
		);

		expect(result.transactions[0].date).toBe('2026-05-02');
	});

	it('properly invalidates non-completed, non-EUR Revolut lines', () => {
		expect.assertions(6);

		const pending = parseCsvTransactions(
			`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Patreon,-7.80,0.00,EUR,EN ATTENTE,114.00`
		);
		const usd = parseCsvTransactions(
			`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Patreon,-7.80,0.00,USD,TERMINÉ,114.00`
		);

		expect(pending.transactions).toHaveLength(0);
		expect(pending.invalidRows[0]).toEqual({
			scope: { kind: 'row', line: 2 },
			fact: { code: 'state-not-completed', state: 'EN ATTENTE' },
			field: 'État'
		});
		expect(JSON.stringify(pending.invalidRows)).not.toContain('Patreon');
		expect(usd.transactions).toHaveLength(0);
		expect(usd.invalidRows[0]).toEqual({
			scope: { kind: 'row', line: 2 },
			fact: { code: 'unsupported-currency', currency: 'USD' },
			field: 'Devise'
		});
		expect(JSON.stringify(usd.invalidRows)).not.toContain('Patreon');
	});

	it('conserve les champs Revolut utiles en metadata sans ajouter les frais au montant', () => {
		expect.assertions(6);

		const result = parseCsvTransactions(
			`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Patreon,-7.80,1.20,EUR,TERMINÉ,114.00`
		);

		expect(result.transactions[0].amountCents).toBe(780);
		expect(result.summary.totalDebitCents).toBe(780);
		expect(result.transactions[0].metadata.revolutFeeCents).toBe(120);
		expect(result.transactions[0].metadata.csvFields?.Frais).toBe('1.20');
		expect(result.transactions[0].metadata.csvFields?.Description).toBeUndefined();
		expect(result.transactions[0].metadata.csvFields?.Montant).toBeUndefined();
	});

	it('neutralise les formules Revolut sur les champs texte', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			`${REVOLUT_HEADER}\n=TYPE,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,=CMD,-7.80,0.00,EUR,TERMINÉ,114.00`
		);

		expect(result.transactions[0].label).toBe("'=CMD");
		expect(result.transactions[0].metadata.csvFields?.Type).toBe("'=TYPE");
	});

	it('Revolut TRANSFER without a rule → category Non catégorisé, bankOperationType TRANSFER', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			`${REVOLUT_HEADER}\nTRANSFER,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Virement SEPA,-50.00,0.00,EUR,TERMINÉ,64.00`
		);

		expect(result.invalidRows).toStrictEqual([]);
		expect(result.transactions[0].category).toBe(UNCLASSIFIED_CATEGORY);
		expect(result.transactions[0].metadata.bankOperationType).toBe('TRANSFER');
	});

	it("BP with a matching rule → rule's category; BP without a rule → Non catégorisé", () => {
		expect.assertions(4);

		const result = parseCsvTransactions(
			`${BANQUE_POPULAIRE_HEADER}\n` +
				'24/06/2026;AUCHAN;AUCHAN COURSES;REFAU;;Carte bancaire;Alimentation;Hyper/supermarche;-38,46;;24/06/2026;24/06/2026;0\n' +
				'24/06/2026;CARREFOUR;CARREFOUR MARKET;REFCA;;Carte bancaire;Courses;Supermarché;-15,00;;24/06/2026;24/06/2026;0',
			{
				categorizationRules: [
					{
						id: 'rule-auchan',
						pattern: 'AUCHAN',
						targetCategory: 'Alimentation',
						type: 'expense' as const,
						active: true
					}
				]
			}
		);

		expect(result.transactions[0].label).toBe('AUCHAN');
		expect(result.transactions[0].category).toBe('Alimentation');
		expect(result.transactions[1].label).toBe('CARREFOUR');
		expect(result.transactions[1].category).toBe(UNCLASSIFIED_CATEGORY);
	});
});
