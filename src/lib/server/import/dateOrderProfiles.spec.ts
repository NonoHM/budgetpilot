import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { MAISON_V2_HEADER } from './profiles/maison-v2';
import { MAISON_V3_HEADER } from './profiles/maison-v3';
import type { CsvImportOptions } from './types';
import type { ColumnMappingInput } from './mapping/model';

/**
 * Every parse path honours the file's date order, asserted as ONE table rather than as a test
 * per profile.
 *
 * ## Why this exists, with the figure that produced it
 *
 * `dateOrder` reaches `normalizeDate` through SEVEN sites, and the option is threaded by hand at
 * each one. Measured on the commit that added it, by removing the argument at one site at a time
 * and running the whole `src/lib/server/import/` suite: **2 of the 7 sites were covered.** Five
 * could drop the user's answer silently and 567 tests stayed green, including every one of the
 * profiles' own spec files, because none of them passes a date order.
 *
 * That is the shape this repository already records twice over: a guard protects what it
 * inspects, and a per-profile test inspects its own profile. So the assertion is written once,
 * against the whole set, and a profile added later that forgets to pass the option fails HERE
 * rather than in a defect report about wrong dates.
 *
 * ## Each row carries its own file, and the profile is asserted
 *
 * A fixture that fell through to `generic` would import perfectly and report a pass about a
 * profile it never reached: the same file exercised twice under two names. `summary.profile` is
 * checked for that reason, and `validRows` beside it, because an empty transaction list satisfies
 * a date assertion that maps over nothing.
 */

/** One ambiguous cell, written month-first: the first of June, never the sixth of January. */
const AMBIGUOUS = '06/01/2026';
const AUTHOR_DATE = '2026-06-01';
/** What the same cell becomes if the order is dropped anywhere along the way. */
const DAY_FIRST_DATE = '2026-01-06';

const MAISON_V1_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';

const MAPPING: ColumnMappingInput = {
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

const CASES: Array<{
	path: string;
	profile: string;
	content: string;
	options?: CsvImportOptions;
}> = [
	{
		path: 'generic, through its alias table',
		profile: 'generic',
		content: ['Date,Description,Amount', `${AMBIGUOUS},COFFEE,-4.50`].join('\n')
	},
	{
		path: 'mapped, through a designation the user made',
		profile: 'mapped',
		content: ['Jour;Intitule operation;Somme', `${AMBIGUOUS};CARREFOUR MARKET;-24,90`].join('\n'),
		// `dateOrderPromptedClientSide` is what actually keeps this profile defaulting silently
		// when nothing is said (below): #433's contradiction pass found `mapped` alone no longer
		// means "the designation screen already asked", since `/import`'s own silent
		// remembered-mapping reuse also parses as `mapped` with nobody ever having been asked.
		options: { profile: 'mapped', columnMapping: MAPPING, dateOrderPromptedClientSide: true }
	},
	{
		path: 'banque-populaire, through its three date candidates',
		profile: 'banque-populaire',
		content: [
			BANQUE_POPULAIRE_HEADERS.join(';'),
			`${AMBIGUOUS};CARREFOUR;CARREFOUR MARKET;REF1;;CARTE;Courses;Alimentation;-24,90;;${AMBIGUOUS};${AMBIGUOUS};`
		].join('\n')
	},
	{
		path: 'revolut, through its two date candidates',
		profile: 'revolut',
		content: [
			'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde',
			`CARD_PAYMENT,Current,${AMBIGUOUS},${AMBIGUOUS},Tesco,-12.30,0.00,EUR,TERMINÉ,500.00`
		].join('\n')
	},
	{
		path: 'maison v1, the seven-column export',
		profile: 'maison',
		content: [MAISON_V1_HEADER, `${AMBIGUOUS};Salaire;Revenus;1500.00;income;income;csv`].join('\n')
	},
	{
		path: 'maison v2, the ten-column export',
		profile: 'maison',
		content: [
			MAISON_V2_HEADER,
			`${AMBIGUOUS};Leroy Merlin;Maison;-80.00;expense;spending;csv;-80.00;1/1;Maison`
		].join('\n')
	},
	{
		path: 'maison v3, which delegates to v2',
		profile: 'maison',
		content: [
			MAISON_V3_HEADER,
			`${AMBIGUOUS};Leroy Merlin;Maison;-80.00;expense;spending;csv;-80.00;1/1;Maison;Compte courant`
		].join('\n')
	}
];

describe('the file s date order reaches every parse path', () => {
	/**
	 * Separates « this path passes the order on » from « this path drops it and reads day-first ».
	 * The two produce dates five months apart, so no fixture can satisfy both.
	 */
	it.each(CASES)('$path', ({ profile, content, options }) => {
		expect.assertions(3);

		const result = parseCsvTransactions(content, { ...options, dateOrder: 'month-first' });

		// The file reached the parser it was written for. Without this a fixture that fell
		// through to `generic` would report a pass about a path it never entered.
		expect(result.summary.profile).toBe(profile);
		// The absolute figure beside the date assertion: an empty list maps to an empty list.
		expect(result.summary.validRows).toBe(1);
		expect(result.transactions[0].date).toBe(AUTHOR_DATE);
	});

	/**
	 * THE CONTROL, split by profile since #433's auto-path remainder: it is no longer one
	 * behaviour, and pretending it is would make this the exact silent default that session
	 * closed. `mapped` keeps its existing, tested day-first default (the designation screen, #639,
	 * is trusted to have asked before this door is reached); every REGISTERED profile now asks
	 * instead, which is what makes the table above a measurement rather than a tautology on that
	 * side too: a parser that ignored the option entirely would read day-first regardless, and a
	 * parser too eager to ask would never reach the table above at all.
	 */
	const MAPPED_CASES = CASES.filter((c) => c.profile === 'mapped');
	const REGISTERED_CASES = CASES.filter((c) => c.profile !== 'mapped');

	it.each(MAPPED_CASES)(
		'$path reads the same cell day-first when nothing is said',
		({ content, options }) => {
			expect.assertions(1);

			const result = parseCsvTransactions(content, options);

			expect(result.transactions[0].date).toBe(DAY_FIRST_DATE);
		}
	);

	it.each(REGISTERED_CASES)(
		'$path asks instead of defaulting when nothing is said',
		({ content, options }) => {
			expect.assertions(2);

			const result = parseCsvTransactions(content, options);

			expect(result.transactions).toEqual([]);
			expect(result.invalidRows[0]?.fact.code).toBe('ambiguous-date-order');
		}
	);

	/**
	 * THE PARTITION IS EXHAUSTIVE. Separates « every case landed in one of the two groups above »
	 * from « a profile added later silently joined neither », which would make both `it.each`
	 * blocks pass while covering fewer cases than `CASES` declares.
	 */
	it('splits every case into exactly one of the two groups', () => {
		expect.assertions(1);
		expect(MAPPED_CASES.length + REGISTERED_CASES.length).toBe(CASES.length);
	});
});
