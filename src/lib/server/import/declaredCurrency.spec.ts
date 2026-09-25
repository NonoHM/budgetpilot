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
import { CURRENCY_COLUMNS, isKnownCurrencyCode } from './currencyDeclaration';
import { N26_LEGACY_HEADERS, REAL_HEADERS } from './profiles/realHeaders.fixture';

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

/**
 * THE DECLARATION IS A FACT ABOUT THE FILE, read off every row (contradiction pass F2).
 *
 * AGENTS.md: a property that changes how values are read is decided by looking at every value it
 * ranges over. A row refused for its date or its amount still said which currency the file is in,
 * and reading the declaration only off the rows that survived let a file whose one declaring row
 * failed file its other rows under the account's currency. MEASURED before this: that file into a
 * USD account returned 200 and stored `["USD"]`.
 */
describe('the file declares a currency on every row it wrote one, surviving or not', () => {
	/** Separates « read off every row » from « read off the rows that became transactions ». */
	it('keeps the declaration of a row refused for its date', () => {
		expect.assertions(2);
		const result = parseCsvTransactions(
			['date,label,amount,currency', 'not-a-date,A,-4.20,EUR', '2026-06-14,B,1850.00,'].join('\n')
		);
		// The calibration of the fixture: the declaring row really is the one refused.
		expect(result.transactions.map((transaction) => transaction.declaredCurrency)).toEqual([
			undefined
		]);
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
	});

	/** Separates « nothing declared » from « an empty column read as a declaration ». */
	it('declares nothing when every currency cell is blank', () => {
		expect.assertions(1);
		const result = parseCsvTransactions(
			['date,label,amount,currency', '2026-06-03,A,-4.20,', '2026-06-14,B,1850.00,'].join('\n')
		);
		expect(result.summary.declaredCurrencies).toEqual([]);
	});

	/** Revolut's column is read the same way: a row refused for its date still declares. */
	it('keeps the declaration of a Revolut row refused for its date', () => {
		expect.assertions(2);
		const result = parseCsvTransactions(
			[
				REVOLUT_HEADERS.join(','),
				'CARD_PAYMENT,Current,not-a-date,not-a-date,A,-4.20,0.00,EUR,TERMINÉ,1200.00'
			].join('\n')
		);
		expect(result.transactions).toEqual([]);
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
	});
});

/**
 * EVERY DECLARING COLUMN, on every row (contradiction pass F3).
 *
 * `currency` and `devise` are both names a file may declare its currency under, and only the first
 * one present used to be read. MEASURED through the route before this: `currency` blank and
 * `devise` reading EUR, into a USD account, stored `["USD","USD"]`.
 *
 * A row whose two columns DISAGREE is refused on that row, as `unsupported-currency` naming the
 * value the profile does not accept: the same refusal, at the same scope, as a row whose one
 * column names that currency. A file-scoped refusal was the alternative, and it would stop a file
 * mixing euro rows with one foreign row from importing its euro rows, which it does today.
 */
describe('both currency columns are read on every row', () => {
	const BOTH = 'date,label,amount,currency,devise';

	/** Separates « the second column is read » from « only the first one present is ». */
	it('takes the declaration from devise when currency is blank', () => {
		expect.assertions(2);
		const result = parseCsvTransactions([BOTH, '2026-06-03,A,-4.20,,EUR'].join('\n'));
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
		expect(result.transactions.map((transaction) => transaction.declaredCurrency)).toEqual(['EUR']);
	});

	/** Separates « a disagreement refuses the row » from « the first column wins silently ». */
	it('refuses a row whose two columns disagree, naming the value it cannot hold', () => {
		expect.assertions(2);
		const result = parseCsvTransactions([BOTH, '2026-06-03,A,-4.20,EUR,GBP'].join('\n'));
		expect(result.transactions).toEqual([]);
		expect(result.invalidRows.map((refusal) => refusal.fact)).toEqual([
			{ code: 'unsupported-currency', currency: 'GBP' }
		]);
	});

	/** The calibration: two columns that agree, in any case, are one declaration. */
	it('accepts a row whose two columns agree', () => {
		expect.assertions(2);
		const result = parseCsvTransactions([BOTH, '2026-06-03,A,-4.20,EUR,eur'].join('\n'));
		expect(result.transactions).toHaveLength(1);
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
	});

	/** The designated door reads the same two columns (`mapped.ts`). */
	it('mapped reads devise when currency is blank', () => {
		expect.assertions(1);
		const result = parseCsvTransactions(
			['poste_1,poste_2,poste_3,Currency,Devise', '2026-06-03,A,-4.20,,EUR'].join('\n'),
			{
				profile: 'mapped',
				columnMapping: {
					matchBy: 'name',
					dateColumn: 'poste_1',
					labelColumn: 'poste_2',
					amountColumn: 'poste_3',
					categoryColumn: null,
					dateIndex: null,
					labelIndex: null,
					amountIndex: null,
					categoryIndex: null,
					columnCount: 5
				}
			}
		);
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
	});
});

/**
 * EVERY WAY A FILE CAN DECLARE A CURRENCY (contradiction passes F1 and, second pass, F1 again).
 *
 * A declaration is not only a `currency` column. An amount column NAMED for its currency declares
 * it for every row under it, and on the designated path ANY header can be the amount. The first
 * fix listed one spelling (`amount (eur)`), and the second contradiction pass MEASURED what that
 * missed: N26's legacy French and German exports, `Montant (EUR)` and `Betrag (EUR)`, designated
 * or remembered, filed into a USD account stored `["USD","USD"]` while `Amount (EUR)` was refused.
 *
 * So the rule, not a list: an amount header whose text ends with a parenthesised ISO 4217 code
 * declares that currency (`amountHeaderCurrency`); a parenthesis that is not a code (`(TTC)`)
 * declares nothing. The headers below are the RECORDED ones, taken by exact name from the real
 * header fixtures, so the test does not share the rule's own pattern.
 */
describe('every way a file can declare a currency is read, on both doors that read it', () => {
	const COLUMN_FORMS = CURRENCY_COLUMNS.map((column) => ({
		form: `a ${column} column`,
		header: `date,label,amount,${column}`,
		row: '2026-06-03,A,-4.20,EUR'
	}));

	/** Unquoted cells of a recorded header row. */
	const cellsOf = (header: string) => header.split(',').map((cell) => cell.replace(/^"|"$/g, ''));
	const n26Legacy = (name: string) => N26_LEGACY_HEADERS.find(([label]) => label === name)![1];
	/** The recorded amount headers named for their currency: N26 current, and legacy EN, DE, FR. */
	const RECORDED = [
		{
			source: 'N26',
			header: REAL_HEADERS.find(([name]) => name === 'N26')![1],
			date: 'Booking Date',
			label: 'Partner Name',
			amount: 'Amount (EUR)'
		},
		{
			source: 'N26 legacy EN',
			header: n26Legacy('N26 legacy EN'),
			date: 'Date',
			label: 'Payee',
			amount: 'Amount (EUR)'
		},
		{
			source: 'N26 legacy DE',
			header: n26Legacy('N26 legacy DE'),
			date: 'Datum',
			label: 'Empfänger',
			amount: 'Betrag (EUR)'
		},
		{
			source: 'N26 legacy FR',
			header: n26Legacy('N26 legacy FR'),
			date: 'Date',
			label: 'Bénéficiaire',
			amount: 'Montant (EUR)'
		}
	];

	/** One data row for a recorded header: the three designated cells filled, the rest blank. */
	function recordedFile(entry: (typeof RECORDED)[number], amount = '-4.20') {
		const cells = cellsOf(entry.header);
		const row = cells.map((cell) =>
			cell === entry.date
				? '2026-06-03'
				: cell === entry.label
					? 'Boulangerie Mercier'
					: cell === entry.amount
						? amount
						: ''
		);
		return [entry.header, row.map((cell) => `"${cell}"`).join(',')].join('\n');
	}

	function designated(content: string, date: string, label: string, amount: string) {
		return parseCsvTransactions(content, {
			profile: 'mapped',
			columnMapping: {
				matchBy: 'name',
				dateColumn: date,
				labelColumn: label,
				amountColumn: amount,
				categoryColumn: null,
				dateIndex: null,
				labelIndex: null,
				amountIndex: null,
				categoryIndex: null,
				columnCount: cellsOf(content.split('\n')[0]).length
			}
		});
	}

	/** The population is what it claims: each recorded header really carries its amount cell. */
	it('finds every recorded amount header in its fixture', () => {
		expect.assertions(1);
		expect(RECORDED.map((entry) => cellsOf(entry.header).includes(entry.amount))).toEqual(
			RECORDED.map(() => true)
		);
	});

	/** Separates « this column declares, through the generic door » from « read and dropped ». */
	it.each(COLUMN_FORMS)('generic reads $form as a declaration', ({ header, row }) => {
		expect.assertions(2);
		const result = parseCsvTransactions([header, row].join('\n'));
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
		expect(result.transactions.map((transaction) => transaction.declaredCurrency)).toEqual(['EUR']);
	});

	/** The same columns through a DESIGNATION. */
	it.each(COLUMN_FORMS)('mapped reads $form as a declaration', ({ header, row }) => {
		expect.assertions(1);
		const [date, label, amount] = header.split(',');
		expect(
			designated([header, row].join('\n'), date, label, amount).summary.declaredCurrencies
		).toEqual(['EUR']);
	});

	/** Separates « the generic alias named for its currency declares » from « only a column does ». */
	it('generic reads the amount (eur) alias as a declaration', () => {
		expect.assertions(2);
		const result = parseCsvTransactions(
			['date,label,amount (eur)', '2026-06-03,A,-4.20'].join('\n')
		);
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
		expect(result.transactions.map((transaction) => transaction.declaredCurrency)).toEqual(['EUR']);
	});

	/**
	 * Separates « every recorded amount header named for its currency declares, whatever its
	 * language » from « only the one spelling in the alias table does », which is what the second
	 * contradiction pass measured through the route: `Montant (EUR)` and `Betrag (EUR)` stored USD.
	 */
	it.each(RECORDED)('mapped reads $source ($amount) as declaring EUR', (entry) => {
		expect.assertions(2);
		const result = designated(recordedFile(entry), entry.date, entry.label, entry.amount);
		expect(result.transactions).toHaveLength(1);
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
	});

	/** Separates « a parenthesised CURRENCY CODE declares » from « any parenthesis does ». */
	it('reads a parenthesis that is not a currency code as no declaration', () => {
		expect.assertions(2);
		const result = designated(
			['Date,Libelle,Montant (TTC)', '2026-06-03,A,-4.20'].join('\n'),
			'Date',
			'Libelle',
			'Montant (TTC)'
		);
		expect(result.transactions).toHaveLength(1);
		expect(result.summary.declaredCurrencies).toEqual([]);
	});

	/**
	 * The codes this rule depends on, pinned: the runtime's ISO 4217 table is what separates `(EUR)`
	 * from `(TTC)`, and a Node release that changed it would otherwise move the rule silently.
	 */
	it('knows EUR, USD and GBP as currency codes, and TTC and HT as not', () => {
		expect.assertions(1);
		expect(['EUR', 'USD', 'GBP', 'TTC', 'HT'].map(isKnownCurrencyCode)).toEqual([
			true,
			true,
			true,
			false,
			false
		]);
	});

	/** A header naming another currency is that currency's declaration, refused on every row. */
	it('refuses every row under an amount header declaring a currency the import does not hold', () => {
		expect.assertions(2);
		const result = designated(
			['Date,Label,Amount (USD)', '2026-06-03,A,-4.20'].join('\n'),
			'Date',
			'Label',
			'Amount (USD)'
		);
		expect(result.transactions).toEqual([]);
		expect(result.invalidRows.map((refusal) => refusal.fact)).toEqual([
			{ code: 'unsupported-currency', currency: 'USD' }
		]);
	});

	/**
	 * N26, as it exports. `Original Currency` is the currency of a foreign card payment's ORIGINAL
	 * amount, not the account's, so a row reading `USD` there is not a declaration and not refused.
	 * Separates « the amount header declares » from « any header containing "currency" does ».
	 */
	it('reads N26 as declaring EUR, and its Original Currency as nothing', () => {
		expect.assertions(3);
		const [, header] = REAL_HEADERS.find(([name]) => name === 'N26')!;
		const result = parseCsvTransactions(
			[
				header,
				'"2026-06-03","2026-06-03","Boulangerie Mercier","","MasterCard Payment","","Main Account","-4.20","","",""',
				'"2026-06-04","2026-06-04","Librairie","","MasterCard Payment","","Main Account","-9.10","-10.00","USD","1.0989"'
			].join('\n')
		);
		expect(result.transactions).toHaveLength(2);
		expect(result.summary.declaredCurrencies).toEqual(['EUR']);
		expect(result.invalidRows).toEqual([]);
	});
});

describe('declaredCurrencyRefusal: the one comparison', () => {
	/** Separates « a contradicted declaration is refused, naming both » from « accepted ». */
	it('refuses a declaration the destination contradicts, naming both currencies', () => {
		expect.assertions(1);
		expect(declaredCurrencyRefusal(['EUR'], { currency: 'USD' })).toEqual({
			code: 'declared-currency-mismatch',
			declared: 'EUR',
			destination: 'USD'
		});
	});

	/** Separates « compared with the destination » from « refused whenever anything is declared ». */
	it('accepts a declaration the destination agrees with', () => {
		expect.assertions(1);
		expect(declaredCurrencyRefusal(['EUR'], { currency: 'EUR' })).toBeNull();
	});

	/** Separates « the absent declaration takes the default » from « refused for saying nothing ». */
	it('accepts a file that declares nothing, whatever the destination', () => {
		expect.assertions(1);
		expect(declaredCurrencyRefusal([undefined, ''], { currency: 'USD' })).toBeNull();
	});

	/** Separates « any declaring row decides » from « only the first row is read ». */
	it('refuses when a later row declares and the first does not', () => {
		expect.assertions(1);
		expect(declaredCurrencyRefusal([undefined, 'EUR'], { currency: 'USD' })?.declared).toBe('EUR');
	});

	/** The declared value is untrusted bytes on its way to a page: bounded like every refusal cell. */
	it('bounds the declared value it names', () => {
		expect.assertions(1);
		const fact = declaredCurrencyRefusal(['X'.repeat(500)], {
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
