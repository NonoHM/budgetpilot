import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import type { ColumnMappingInput } from './mapping/model';
import { MAISON_V2_HEADER } from './profiles/maison-v2';

/**
 * #652: a control character reaching a stored `Transaction.label` throws `SQLSTATE 22021` on
 * PostgreSQL from inside `persist.ts`'s per-row write loop, which has no enclosing transaction —
 * rows already written stay committed while `ImportBatch.importedRows`, written once after the
 * loop, never advances past its `@default(0)`. See `controlCharacterPartialCommit.db-smoke.ts` for the
 * live, three-engine measurement.
 *
 * The fix is `sanitizeImportedText` stripping the class (`hasStrandedControlCharacter` /
 * `STRANDED_CONTROL_CHARACTER` in `utils/safety.ts`), which closes the crash for every caller.
 * This file asserts the ADDITIONAL, opt-in behaviour: every profile that builds a transaction
 * `label` refuses the row rather than silently importing an altered one, because the label is
 * the one figure a user reconciles against their own bank statement.
 *
 * One `it` per profile, per "the break-check must prove each caller separately": each profile
 * wires the check independently, so a single shared helper reddening for one profile says
 * nothing about the other four.
 */

const MAISON_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';
const BANQUE_POPULAIRE_HEADER =
	'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation';
const REVOLUT_HEADER =
	'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde';

const MAPPED_MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'jour',
	labelColumn: 'intitule operation',
	amountColumn: 'somme',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 3
};

describe('a control character in the label is refused, not silently stripped', () => {
	it('maison: refuses the row and produces no transaction', () => {
		expect.assertions(3);
		const result = parseCsvTransactions(
			`${MAISON_HEADER}\n2026-06-01;Courses\u0000Auchan;Alimentation;-42.10;expense;spending;csv`
		);
		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toStrictEqual({ code: 'control-character' });
	});

	it('maison-v2: refuses the row and produces no transaction', () => {
		expect.assertions(3);
		const result = parseCsvTransactions(
			`${MAISON_V2_HEADER}\n2026-06-12;Leroy\u0000Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison`
		);
		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toStrictEqual({ code: 'control-character' });
	});

	it('banque-populaire: refuses the row and produces no transaction', () => {
		expect.assertions(3);
		const result = parseCsvTransactions(
			`${BANQUE_POPULAIRE_HEADER}\n01/08/2026;SUPERETTE\u00003;PAIEMENT CB SUPERETTE;REF001;;Carte;Alimentation;Courses;-8,40;;01/08/2026;01/08/2026;`
		);
		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toStrictEqual({ code: 'control-character' });
	});

	it('revolut: refuses the row and produces no transaction', () => {
		expect.assertions(3);
		const result = parseCsvTransactions(
			`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Patreon\u00003,-7.80,0.00,EUR,TERMINÉ,114.00`
		);
		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toStrictEqual({ code: 'control-character' });
	});

	it('mapped (resolvedRows): refuses the row and produces no transaction', () => {
		expect.assertions(3);
		const result = parseCsvTransactions(
			'Jour;Intitule operation;Somme\n24/06/2026;CARREFOUR\u0000MARKET;-24,90',
			{ profile: 'mapped', columnMapping: MAPPED_MAPPING }
		);
		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toStrictEqual({ code: 'control-character' });
	});

	it('a label with no control character imports normally on every profile above', () => {
		expect.assertions(5);
		expect(
			parseCsvTransactions(
				`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`
			).transactions
		).toHaveLength(1);
		expect(
			parseCsvTransactions(
				`${MAISON_V2_HEADER}\n2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison`
			).transactions
		).toHaveLength(1);
		expect(
			parseCsvTransactions(
				`${BANQUE_POPULAIRE_HEADER}\n01/08/2026;SUPERETTE;PAIEMENT CB SUPERETTE;REF001;;Carte;Alimentation;Courses;-8,40;;01/08/2026;01/08/2026;`
			).transactions
		).toHaveLength(1);
		expect(
			parseCsvTransactions(
				`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Patreon,-7.80,0.00,EUR,TERMINÉ,114.00`
			).transactions
		).toHaveLength(1);
		expect(
			parseCsvTransactions('Jour;Intitule operation;Somme\n24/06/2026;CARREFOUR MARKET;-24,90', {
				profile: 'mapped',
				columnMapping: MAPPED_MAPPING
			}).transactions
		).toHaveLength(1);
	});
});
