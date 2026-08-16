/**
 * The date wall, closed on every profile rather than on three of four.
 *
 * ## What this file is for
 *
 * A blind usability session uploaded a statement whose dates read `01.06.2026`. Every row was
 * refused, the refusal named the problem and not the remedy, and the session ended with the
 * tester repairing the bank's own export in a text editor, one character per date.
 *
 * #362 put the accepted forms into `import_refusal_invalid_date`. It reached the three profiles
 * that emit `invalid-date` and missed the fourth: `banque-populaire` never checked the value
 * `normalizeFirstValidDate` handed back, so an unreadable date fell through to
 * `validateTransaction` and surfaced as « date ISO invalide » — a violation code with no column,
 * no field and no expected form. Measured through the route at 1280 before this file existed:
 * eight rows, eight identical sentences, an empty « Champ » column, and no way forward.
 *
 * ## Why it is one file across four profiles rather than four additions to four specs
 *
 * The defect is that the profiles DISAGREED, and a disagreement is not visible from inside any
 * one of them. Each profile's own spec asserted its own behaviour and every one of them passed.
 * That is the seam class the guide already names: every level correct, the assembly not.
 *
 * So the table below is the contract, and adding a profile without adding a row here leaves the
 * new profile free to invent a fifth sentence.
 */
import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import type { CsvRefusal } from './refusals';
import { MAISON_V2_HEADER } from './profiles/maison-v2';

/**
 * A value no profile can read, and a realistic one: a two-digit year.
 *
 * It is deliberately NOT `01.06.2026`, which is what the blind session's bank wrote. That form
 * is now ACCEPTED (`utils/dottedDate.spec.ts` carries the widening and the argument for it), so
 * using it here would make every assertion below pass on a file that imports perfectly.
 */
const UNREADABLE = '01/06/26';

/**
 * One file per profile, each carrying exactly one data row, whose ONLY defect is the date.
 *
 * Every other cell is deliberately valid: a fixture that fails for two reasons cannot say which
 * refusal the parser reached first, and the whole point here is which refusal the user reads.
 */
const PROFILES: Array<{ profile: string; column: string; value?: string; content: string }> = [
	{
		profile: 'generic',
		column: 'date',
		content: `date,label,amount\n${UNREADABLE},Mercerie Lafayette,-45.20`
	},
	{
		// The SAME profile through a column the file does not call `date`.
		//
		// It is here because the row above cannot see the difference: its date column is called
		// `date`, so `columns.date === 'date'` and a break replacing the resolved name with the
		// literal leaves it green. Measured — that break passed all sixteen assertions until this
		// row existed. `dateop` is Boursorama's spelling and is in the alias table already.
		profile: 'generic',
		column: 'dateop',
		content: `dateop,label,amount\n${UNREADABLE},Mercerie Lafayette,-45.20`
	},
	{
		profile: 'maison',
		column: 'date',
		content: `date;libelle;categorie;montant;type;nature;source_bancaire\n${UNREADABLE};Mercerie Lafayette;Alimentation;-45.20;expense;spending;Banque Lafayette`
	},
	{
		profile: 'maison',
		column: 'date',
		content: `${MAISON_V2_HEADER}\n${UNREADABLE};Mercerie Lafayette;Alimentation;-45.20;expense;spending;Banque Lafayette;-45.20;1/1;Alimentation`
	},
	{
		profile: 'revolut',
		column: 'Date de fin',
		// The WHOLE cell, timestamp included. Revolut writes a datetime, and trimming it to the
		// date half would show the user something their file does not contain.
		value: `${UNREADABLE} 09:12:00`,
		content: `Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde\nCARD_PAYMENT,Current,${UNREADABLE} 09:12:00,${UNREADABLE} 09:12:00,Mercerie Lafayette,-45.20,0.00,EUR,TERMINÉ,1204.80`
	},
	{
		profile: 'banque-populaire',
		column: 'Date operation',
		content:
			'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation\n' +
			`${UNREADABLE};MERCERIE LAFAYETTE;PAIEMENT CB MERCERIE LAFAYETTE;REF000100;CARTE 4512;Carte;Alimentation;Courses;-45,20;;${UNREADABLE};${UNREADABLE};`
	}
];

describe('an unreadable date, on every profile that can read one', () => {
	it.each(PROFILES)(
		'$profile refuses it as invalid-date, naming the column and the value',
		({ profile, column, value, content }) => {
			expect.assertions(4);

			const result = parseCsvTransactions(content);

			expect(result.summary.profile).toBe(profile);
			expect(result.transactions).toHaveLength(0);
			expect(result.invalidRows).toHaveLength(1);
			// `field` is the column, not the literal `date`. It is what the summary table prints
			// under « Champ », and a Boursorama file's date column is called `dateop`: telling
			// someone to look at « date » points at a column their file does not contain.
			expect(result.invalidRows[0]).toEqual({
				scope: { kind: 'row', line: 2 },
				fact: { code: 'invalid-date', column, value: value ?? UNREADABLE },
				field: column
			} satisfies CsvRefusal);
		}
	);

	/**
	 * The assertion the four rows above cannot make individually.
	 *
	 * `banque-populaire` reached `transaction-invalid` before this, which rendered « date ISO
	 * invalide » — a different sentence for the same event, and the one the session actually met.
	 * Asserting the SET has one element is what fails if a fifth profile invents a sixth wording.
	 */
	it('says the same thing on all of them', () => {
		expect.assertions(2);

		const codes = new Set(
			PROFILES.map((p) => {
				const [refusal] = parseCsvTransactions(p.content).invalidRows;
				return refusal.fact.code;
			})
		);

		expect(codes).toEqual(new Set(['invalid-date']));
		expect(codes.has('transaction-invalid')).toBe(false);
	});

	/**
	 * The direction this change is NOT moving in.
	 *
	 * Everything above makes the app refuse more legibly. The loss lives on the other side: a date
	 * the app DOES accept must still import, and `normalizeFirstValidDate`'s whole job on
	 * `banque-populaire` is to fall back through three columns. A guard added after it could
	 * refuse a row whose first date column is blank and whose second is perfectly readable.
	 */
	it('still falls back to a later date column when the first is empty', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation\n' +
				';MERCERIE LAFAYETTE;PAIEMENT CB MERCERIE LAFAYETTE;REF000100;CARTE 4512;Carte;Alimentation;Courses;-45,20;;;01/06/2026;'
		);

		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].date).toBe('2026-06-01');
	});

	/** The same, one level up: a wholly valid statement is untouched by the guard. */
	it('leaves a readable banque-populaire statement importing', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation\n' +
				'01/06/2026;MERCERIE LAFAYETTE;PAIEMENT CB MERCERIE LAFAYETTE;REF000100;CARTE 4512;Carte;Alimentation;Courses;-45,20;;01/06/2026;01/06/2026;\n' +
				'03/06/2026;SALAIRE;VIREMENT SEPA SALAIRE;REF000101;PAUL MERCIER;Virement;Revenus;Salaire;;2450,00;03/06/2026;03/06/2026;'
		);

		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(2);
	});
});
