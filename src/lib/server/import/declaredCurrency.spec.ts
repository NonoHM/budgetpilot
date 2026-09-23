import { describe, expect, it } from 'vitest';
import { csvProfileParsers } from './registry';
import { parseCsvTransactions } from './csv';
import { parseRows } from './utils/csv';
import { declaredCurrencyRefusal } from './declaredCurrency';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { REVOLUT_HEADERS } from './profiles/revolut';
import { MAISON_V2_HEADER } from './profiles/maison-v2';
import { MAISON_V3_HEADER } from './profiles/maison-v3';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import type { ColumnMappingInput } from './mapping/model';

/**
 * #600, at the parse: a currency the file DECLARES leaves the parse on every row it was read from.
 *
 * The comparison with the destination happens later, at the routes and again in
 * `persistImportedTransactions` (see `declaredCurrency.ts`), and it can only compare what the parse
 * hands it. A profile that reads a currency column and does not pass it on would make every check
 * downstream green on a file that declared EUR, which is the defect #600 names moved one layer up.
 */

/**
 * One fixture per REGISTRY ENTRY, in registry order, each a file that entry matches.
 *
 * `currencyNative` says whether the entry's own header already carries a currency column. When it
 * does not, the test appends one, and the question it asks is whether the entry can still be
 * handed that file at all. The coverage assertion below is what binds a future entry: a new
 * registry entry with no fixture here fails on the length before anything else runs.
 */
const FIXTURE_PER_ENTRY: Array<{
	header: string;
	row: string;
	delimiter: string;
	currencyNative: boolean;
}> = [
	{
		header: BANQUE_POPULAIRE_HEADERS.join(';'),
		row: '01/08/2026;SUPERETTE;PAIEMENT CB SUPERETTE;REF001;;Carte;Alimentation;Courses;-8,40;;01/08/2026;01/08/2026;',
		delimiter: ';',
		currencyNative: false
	},
	{
		header: REVOLUT_HEADERS.join(','),
		row: 'CARD_PAYMENT,Current,2026-06-03 09:21:00,2026-06-03 09:21:00,Boulangerie Mercier,-4.20,0.00,EUR,TERMINÉ,1200.00',
		delimiter: ',',
		currencyNative: true
	},
	{
		header: MAISON_V3_HEADER,
		row: '2026-06-12;Leroy Merlin;Maison;-80.00;expense;spending;csv;-80.00;1/1;Maison;Compte courant',
		delimiter: ';',
		currencyNative: false
	},
	{
		header: MAISON_V2_HEADER,
		row: '2026-06-12;Leroy Merlin;Maison;-80.00;expense;spending;csv;-80.00;1/1;Maison',
		delimiter: ';',
		currencyNative: false
	},
	{
		header: 'date;libelle;categorie;montant;type;nature;source_bancaire',
		row: '2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv',
		delimiter: ';',
		currencyNative: false
	},
	{
		header: 'date,label,amount',
		row: '2026-06-03,Boulangerie Mercier,-4.20',
		delimiter: ',',
		currencyNative: false
	}
];

/** The fixture as a file that declares EUR: as written when the header already has a currency
 *  column, with a `currency` column appended when it does not. */
function declaringFile(fixture: (typeof FIXTURE_PER_ENTRY)[number]): string {
	return fixture.currencyNative
		? `${fixture.header}\n${fixture.row}`
		: `${fixture.header}${fixture.delimiter}currency\n${fixture.row}${fixture.delimiter}EUR`;
}

const ENTRIES = csvProfileParsers.map((parser, index) => ({ index, profile: parser.profile }));

describe('every registered profile that can be handed a declaring file carries the declaration out', () => {
	/** Separates « every registry entry has a fixture » from « an entry was added unnoticed ». */
	it('carries one fixture per registry entry', () => {
		expect.assertions(1);
		expect(FIXTURE_PER_ENTRY.length).toBe(csvProfileParsers.length);
	});

	/** Separates « the fixture was written for this entry » from « it falls through to a later one ».
	 *  Without it `generic`, which matches everything, would stand in for any stale fixture. */
	it.each(ENTRIES)('entry $index ($profile) matches its own fixture', ({ index }) => {
		expect.assertions(1);
		const cells = parseRows(`${FIXTURE_PER_ENTRY[index].header}\n`)[0].cells;
		expect(csvProfileParsers[index].matches(cells)).toBe(true);
	});

	/**
	 * THE PROPERTY, classified per entry rather than listed by hand. Either the entry cannot be
	 * handed a file declaring a currency (its header check refuses the extra column, so the file
	 * falls through to a later entry that CAN see it), or it parses that file and every row it
	 * produces declares `EUR`. A future entry that reads a currency column and drops it fails the
	 * second branch; the row count keeps that branch from passing over an empty parse.
	 *
	 * Separates « the declaration leaves the parse » from « it is read, checked against EUR, and
	 * forgotten », which is what `generic`, `mapped` and `revolut` did before #600.
	 */
	it.each(ENTRIES)(
		'entry $index ($profile) passes a declared currency on, or cannot see one',
		({ index }) => {
			expect.assertions(2);
			const rows = parseRows(declaringFile(FIXTURE_PER_ENTRY[index]));
			const entry = csvProfileParsers[index];

			if (!entry.matches(rows[0].cells)) {
				// Cannot be handed the file. Asserted rather than skipped, so the branch taken is a claim.
				expect(entry.matches(rows[0].cells)).toBe(false);
				expect(FIXTURE_PER_ENTRY[index].currencyNative).toBe(false);
				return;
			}

			const result = entry.parse({
				rows,
				warnings: [],
				categorizationRules: [],
				dateOrder: 'day-first'
			});
			expect(result.transactions.length).toBeGreaterThan(0);
			expect(result.transactions.map((transaction) => transaction.declaredCurrency)).toEqual(
				result.transactions.map(() => 'EUR')
			);
		}
	);

	/**
	 * The calibration of the classification above: the two registry entries that read a currency
	 * today must take the second branch. Separates « the property holds » from « every entry took
	 * the vacuous branch », which a broken fixture would produce.
	 */
	it('generic and revolut are the entries that parse a declaring file', () => {
		expect.assertions(1);
		const parsing = ENTRIES.filter(({ index }) =>
			csvProfileParsers[index].matches(parseRows(declaringFile(FIXTURE_PER_ENTRY[index]))[0].cells)
		).map(({ profile }) => profile);
		expect(parsing).toEqual(['revolut', 'generic']);
	});

	/**
	 * `mapped` has no registry entry (see `profiles/mapped.ts`), so it is asserted by name. Separates
	 * « a designated file's `Devise` column is carried out » from « read, accepted, dropped ».
	 */
	it('mapped carries the declaration out', () => {
		expect.assertions(2);
		const mapping: ColumnMappingInput = {
			matchBy: 'name',
			dateColumn: 'poste_1',
			labelColumn: 'poste_2',
			amountColumn: 'poste_3',
			categoryColumn: null,
			dateIndex: null,
			labelIndex: null,
			amountIndex: null,
			categoryIndex: null,
			columnCount: 4
		};
		const result = parseCsvTransactions(
			[
				'poste_1,poste_2,poste_3,Devise',
				'2026-06-03,Boulangerie,-4.20,EUR',
				'2026-06-14,Salaire,1850.00,eur'
			].join('\n'),
			{ profile: 'mapped', columnMapping: mapping }
		);
		expect(result.transactions).toHaveLength(2);
		// `eur` is accepted by the case-insensitive check and carried as the code, not as the cell.
		expect(result.transactions.map((transaction) => transaction.declaredCurrency)).toEqual([
			'EUR',
			'EUR'
		]);
	});

	/**
	 * A blank cell is not a declaration, which is the file-evidence rule's « exhibits nothing ».
	 * Separates « the blank row carries nothing » from « it inherits its neighbour's value ».
	 */
	it('leaves a row with a blank currency cell undeclared', () => {
		expect.assertions(1);
		const result = parseCsvTransactions(
			['date,label,amount,currency', '2026-06-03,A,-4.20,EUR', '2026-06-04,B,-1.00,'].join('\n')
		);
		expect(result.transactions.map((transaction) => transaction.declaredCurrency)).toEqual([
			'EUR',
			undefined
		]);
	});

	/** No column at all: the default applies by design (#600's ruling), so nothing is declared. */
	it('declares nothing for a file with no currency column', () => {
		expect.assertions(2);
		const result = parseCsvTransactions(['date,label,amount', '2026-06-03,A,-4.20'].join('\n'));
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].declaredCurrency).toBeUndefined();
	});
});

describe('declaredCurrencyRefusal: the one comparison', () => {
	/** Separates « a contradicted declaration is refused, naming both » from « accepted ». */
	it('refuses a declaration the destination contradicts, naming both currencies', () => {
		expect.assertions(1);
		expect(declaredCurrencyRefusal([{ declaredCurrency: 'EUR' }], { currency: 'USD' })).toEqual({
			code: 'declared-currency-mismatch',
			declared: 'EUR',
			destination: 'USD'
		});
	});

	/** Separates « compared with the destination » from « refused whenever anything is declared ». */
	it('accepts a declaration the destination agrees with', () => {
		expect.assertions(1);
		expect(declaredCurrencyRefusal([{ declaredCurrency: 'EUR' }], { currency: 'EUR' })).toBeNull();
	});

	/** Separates « the absent declaration takes the default » from « refused for saying nothing ». */
	it('accepts a file that declares nothing, whatever the destination', () => {
		expect.assertions(1);
		expect(
			declaredCurrencyRefusal([{}, { declaredCurrency: undefined }], { currency: 'USD' })
		).toBeNull();
	});

	/** Separates « any declaring row decides » from « only the first row is read ». */
	it('refuses when a later row declares and the first does not', () => {
		expect.assertions(1);
		expect(
			declaredCurrencyRefusal([{}, { declaredCurrency: 'EUR' }], { currency: 'USD' })?.declared
		).toBe('EUR');
	});

	/** The declared value is untrusted bytes on its way to a page: bounded like every refusal cell. */
	it('bounds the declared value it names', () => {
		expect.assertions(1);
		const fact = declaredCurrencyRefusal([{ declaredCurrency: 'X'.repeat(500) }], {
			currency: 'USD'
		});
		expect(fact?.declared.length).toBeLessThanOrEqual(67);
	});

	/** The sentence as read, compared whole (AGENTS.md: a substring passes over a doubled tail). */
	it('renders one sentence naming both currencies and the repair', () => {
		expect.assertions(1);
		expect(
			refusalLabel({ code: 'declared-currency-mismatch', declared: 'EUR', destination: 'USD' })
		).toBe('Ce relevé est en EUR, ce compte en USD. Choisissez un compte en EUR.');
	});
});
