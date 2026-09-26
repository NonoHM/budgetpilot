import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import { csvProfileParsers } from './registry';
import { BANQUE_POPULAIRE_HEADERS } from './profiles/banque-populaire';
import { REVOLUT_HEADERS } from './profiles/revolut';
import { MAISON_V2_HEADER } from './profiles/maison-v2';
import { MAISON_V3_HEADER } from './profiles/maison-v3';
import type { ColumnMappingInput } from './mapping/model';

/**
 * The date order is DERIVED from the file at the one door, and the option is an override.
 *
 * ## The fixture, and the two independent signals it carries
 *
 * A Chase statement: month-first, and `Posting Date` is deliberately absent from the alias table
 * (`columnAliases.ts`, with a DO NOT ADD beside it), so this file reaches the parser only through
 * a designation the user made. That is not a curiosity, it is the centre of #433: the designation
 * screen exists because the bank was not recognised, an unrecognised bank is disproportionately
 * not European, and not European is where month-first lives.
 *
 * Measured on `main` before this change, and both figures move for different reasons:
 *
 * - **3 rows in, 2 out, 1 refused `invalid-date`**, because `08/15/2026` read day-first is day 8
 *   of month 15, which is not a date. The rows that PROVE the order were being discarded one at
 *   a time. The derivation converts them into the proof that settles the file.
 * - **The two survivors displaced 146 and 145 days**, silently, with a correct-looking summary.
 *
 * So a change that fixed only the refusal or only the dates cannot turn this green.
 */

const CHASE_HEADER = 'Posting Date,Description,Amount';
/** `08/15/2026` puts 15 second, which no month can be: the column RESOLVES month-first. */
const CHASE_RESOLVING = [
	CHASE_HEADER,
	'06/01/2026,STARBUCKS,-4.50',
	'07/02/2026,WHOLE FOODS,-61.20',
	'08/15/2026,PAYROLL,2400.00'
].join('\n');

const CHASE_MAPPING: ColumnMappingInput = {
	matchBy: 'name',
	dateColumn: 'Posting Date',
	labelColumn: 'Description',
	amountColumn: 'Amount',
	categoryColumn: null,
	dateIndex: null,
	labelIndex: null,
	amountIndex: null,
	categoryIndex: null,
	columnCount: 3
};

/** A mapping pointing at a column this file does not have. */
const ABSENT_COLUMN_MAPPING: ColumnMappingInput = { ...CHASE_MAPPING, dateColumn: 'Trade Date' };

function mapped(content: string, mapping: ColumnMappingInput = CHASE_MAPPING) {
	return parseCsvTransactions(content, { profile: 'mapped', columnMapping: mapping });
}

describe('the date order is read off the file at the single door', () => {
	/**
	 * Separates "the column's own proof decided the file" from "the file was read day-first and
	 * its resolving rows thrown away". The two differ in the refusal count AND in the dates.
	 */
	it('reads a designated month-first column month-first, and keeps the row that proved it', () => {
		expect.assertions(4);

		const result = mapped(CHASE_RESOLVING);

		expect(result.summary.validRows).toBe(3);
		expect(result.summary.invalidRows).toBe(0);
		expect(result.summary.fileLevelRefusals).toBe(0);
		expect(result.transactions.map((transaction) => transaction.date)).toEqual([
			'2026-06-01',
			'2026-07-02',
			'2026-08-15'
		]);
	});

	/**
	 * THE CONTROL for the test above, and it is what makes those dates a measurement rather than
	 * a coincidence. Separates "the fixture is ambiguous and the derivation decided it" from "the
	 * fixture reads the same either way", which would let a parser ignoring the whole mechanism
	 * pass. Same three cells, read under the order this file does NOT prove.
	 */
	it('reads the same three cells 146 and 145 days earlier under the order the file denies', () => {
		expect.assertions(1);

		const dayFirst = ['06/01/2026', '07/02/2026'].map((cell) => {
			const [day, month, year] = cell.split('/');
			return `${year}-${month}-${day}`;
		});

		expect(dayFirst).toEqual(['2026-01-06', '2026-02-07']);
	});

	/**
	 * Separates "a file proving both readings is refused as a file" from "it is read under one of
	 * them and the other's rows are refused one by one". `06/24/2026` and `24/06/2026` each prove
	 * the opposite order, so no single reading fits.
	 */
	it('refuses a column that proves both readings, naming one cell of each', () => {
		expect.assertions(4);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '24/06/2026,A,-1.00', '06/24/2026,B,-2.00'].join('\n')
		);

		expect(result.transactions).toEqual([]);
		expect(result.summary.fileLevelRefusals).toBe(1);
		expect(result.summary.totalRows).toBe(2);
		expect(result.invalidRows[0].fact).toEqual({
			code: 'mixed-date-order',
			dayFirst: '24/06/2026',
			monthFirst: '06/24/2026'
		});
	});

	/**
	 * Separates "the cells this refusal names are bounded and sanitised" from "a user's own upload
	 * decides what goes into the page's data".
	 *
	 * `AMBIGUOUS_DATE_PATTERN` ends in `([\s\S]*)`, so the evidence a verdict carries is the WHOLE
	 * trimmed cell, not the ten characters of the date. Measured before this assertion existed: a
	 * 5,010 character cell reached the refusal fact at 5,010 characters, and `24/06/2026` followed
	 * by a tab and a spreadsheet formula reached it raw. Bounded only by the file size cap, which
	 * is 256,000 bytes.
	 *
	 * `refusalCellValue` is the repository's answer and its docstring names this exact hazard:
	 * sanitise AND bound, « use this for anything lifted from a cell, never `sanitizeImportedText`
	 * alone ». Every other refusal in this directory already goes through it; this one is the new
	 * one and had to join them.
	 */
	it('bounds and sanitises the cells the mixed refusal names', () => {
		expect.assertions(3);

		const blob = 'A'.repeat(5000);
		const result = parseCsvTransactions(
			[
				'Date,Description,Amount',
				`"24/06/2026\t=cmd|'/c calc'!A1",A,-1.00`,
				`06/24/2026${blob},B,-2.00`
			].join('\n')
		);

		const fact = result.invalidRows[0].fact;
		expect(fact.code).toBe('mixed-date-order');
		if (fact.code !== 'mixed-date-order') return;
		// 64 plus the three-character ellipsis `refusalCellValue` appends.
		expect(fact.monthFirst.length).toBeLessThanOrEqual(67);
		// The tab is collapsed to a single space rather than carried into the page's data.
		expect(fact.dayFirst).toBe("24/06/2026 =cmd|'/c calc'!A1");
	});

	/**
	 * Separates "a resolved column is read and nothing is asked" from "any file touching the new
	 * machinery acquires a refusal". A file that settles its own order has no question in it.
	 */
	it('asks nothing of a file that resolves its own order', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '24/06/2026,A,-1.00', '06/01/2026,B,-2.00'].join('\n')
		);

		expect(result.summary.fileLevelRefusals).toBe(0);
		expect(result.summary.validRows).toBe(2);
		expect(result.transactions.map((t) => t.date)).toEqual(['2026-06-24', '2026-01-06']);
	});

	/**
	 * Separates "an ISO column is untouched by the verdict and by the override" from "the new
	 * machinery reaches a file it has nothing to say about". ISO 8601 carries its own order, so
	 * both readings of this file are the same file and an override has nothing to apply to.
	 */
	it('leaves an ISO column alone, override or not', () => {
		expect.assertions(2);

		const iso = ['Date,Description,Amount', '2026-06-01,A,-1.00', '2026-08-15,B,-2.00'].join('\n');
		const plain = parseCsvTransactions(iso);
		const overridden = parseCsvTransactions(iso, { dateOrder: 'month-first' });

		expect(plain.transactions.map((t) => t.date)).toEqual(['2026-06-01', '2026-08-15']);
		expect(overridden.transactions.map((t) => t.date)).toEqual(
			plain.transactions.map((t) => t.date)
		);
	});

	/**
	 * Separates "a headerless file's FIRST LINE counts as evidence" from "it is skipped as a title
	 * row". The user's answer about a title row is honoured when gathering the cells, for the same
	 * reason `parseImportRows` honours it when counting rows: a headerless file's first line is a
	 * transaction.
	 *
	 * The fixture puts the ONLY resolving cell on line one. Skip it and the column reads ambiguous,
	 * so the file takes the day-first default, `08/15/2026` becomes day 8 of month 15 and is
	 * refused, and the survivor lands five months early. Two figures move, not one.
	 *
	 * ## Written because a break showed nothing could see this
	 *
	 * Added after the seam-coverage measurement for this change: removing the `hasHeaderRow` clause
	 * from the cell gather left the whole `src/lib/server/import/` suite green at 620 passed. So
	 * this assertion was written against the BROKEN version first and watched to fail, rather than
	 * written against working code and assumed to bite.
	 */
	it('reads the first line of a headerless file as evidence, not as a title row', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(
			['08/15/2026,PAYROLL,2400.00', '06/01/2026,COFFEE,-4.50'].join('\n'),
			{
				profile: 'mapped',
				hasHeaderRow: false,
				columnMapping: {
					matchBy: 'position',
					dateColumn: null,
					labelColumn: null,
					amountColumn: null,
					categoryColumn: null,
					dateIndex: 0,
					labelIndex: 1,
					amountIndex: 2,
					categoryIndex: null,
					columnCount: 3
				}
			}
		);

		expect(result.summary.validRows).toBe(2);
		expect(result.summary.invalidRows).toBe(0);
		expect(result.transactions.map((transaction) => transaction.date)).toEqual([
			'2026-08-15',
			'2026-06-01'
		]);
	});

	/**
	 * Separates "a declaration pointing at an absent column returns nothing" from "it throws, or
	 * reads a neighbouring column". The file then reaches its ORDINARY refusal, which is the one
	 * that can tell the user what to do about it.
	 */
	it('does not crash when a declaration names a column this file does not have', () => {
		expect.assertions(2);

		const result = mapped(CHASE_RESOLVING, ABSENT_COLUMN_MAPPING);

		expect(result.transactions).toEqual([]);
		expect(result.invalidRows.map((refusal) => refusal.fact.code)).toEqual([
			'mapping-columns-missing'
		]);
	});
});

/**
 * Every registered parser declares at least one date column against a header it matches.
 *
 * ## What this can and cannot do, stated rather than implied
 *
 * A required `dateColumns` member makes OMISSION unrepresentable: a registry entry without one is
 * a compile error and no discipline is involved. It does NOT make a LIE unrepresentable, because
 * `dateColumns: () => []` typechecks and silently switches the derivation off for that profile,
 * which is #587's shape exactly. This test is what narrows that gap, and it is a test rather than
 * a type, so it is « likely to be noticed » and not « impossible ». Do not read it as the first.
 *
 * The coverage assertion is the part that binds a FUTURE profile: a new registry entry with no
 * header beside it fails on the length before anything else runs, so the fixture cannot be
 * forgotten, and once it exists the emptiness assertion has something real to run against.
 *
 * A `sampleHeader` field ON the registry entry was considered and rejected: `generic` matches
 * everything, so its sample would be a fiction, and a fixture stored in the registry configures a
 * derivable thing, which fails one rule to patch another.
 */
const HEADER_PER_ENTRY: string[][] = [
	BANQUE_POPULAIRE_HEADERS,
	REVOLUT_HEADERS,
	MAISON_V3_HEADER.split(';'),
	MAISON_V2_HEADER.split(';'),
	'date;libelle;categorie;montant;type;nature;source_bancaire'.split(';'),
	['Date', 'Description', 'Amount']
];

describe('every registered profile declares its date columns', () => {
	/**
	 * Separates "every registry entry has a header to be tested against" from "a profile was
	 * added and this file did not notice". Red here means add the new profile's header below.
	 */
	it('carries one header per registry entry', () => {
		expect.assertions(1);
		expect(HEADER_PER_ENTRY.length).toBe(csvProfileParsers.length);
	});

	/**
	 * Separates "this header reaches the entry it was written for" from "it falls through to a
	 * later one". Without it, `generic` (whose match returns true for everything) would silently
	 * stand in for any entry whose fixture stopped matching.
	 */
	it.each(csvProfileParsers.map((parser, index) => ({ index, profile: parser.profile })))(
		'entry $index ($profile) matches its own header',
		({ index }) => {
			expect.assertions(1);
			expect(csvProfileParsers[index].matches(HEADER_PER_ENTRY[index])).toBe(true);
		}
	);

	/**
	 * Separates "this profile declares a real date column" from "it declares an empty list and
	 * the derivation silently does not apply to it".
	 */
	it.each(csvProfileParsers.map((parser, index) => ({ index, profile: parser.profile })))(
		'entry $index ($profile) declares at least one date column',
		({ index }) => {
			expect.assertions(1);
			expect(csvProfileParsers[index].dateColumns(HEADER_PER_ENTRY[index]).length).toBeGreaterThan(
				0
			);
		}
	);
});

/**
 * # THE APPLIED ORDER LEAVES THE PARSER, so the batch can record what it did
 *
 * `ImportBatch.dateOrder` has existed on all three engines since 2026-08-22 and nothing has ever
 * written it: every row on every install carries NULL, while the column's own docstring describes
 * a behaviour that does not happen. The reason it could not be written is here rather than in the
 * route: the decision is taken at the door and was not carried out of it, so no caller had the
 * value to store.
 *
 * Plate 7l's summary line is what makes this load bearing rather than tidy. « Dates lues jour puis
 * mois, Date operation » is a statement about what THIS import did, and a line with no stored
 * source would be recomputed at read time from a file nobody kept.
 */
describe('the order the parse applied, carried out of the door', () => {
	/**
	 * Separates « the summary reports the order the parse APPLIED » from « the summary reports the
	 * default ». A file proving month-first is the only case where the two differ without an
	 * explicit answer, which is why the proof is the fixture.
	 */
	it('reports the order a file proved, not the default', () => {
		expect.assertions(2);

		const dayFirst = parseCsvTransactions(
			['date,label,amount', '24/06/2026,CARREFOUR,-24.90'].join('\n')
		);
		const monthFirst = parseCsvTransactions(
			['date,label,amount', '06/24/2026,CARREFOUR,-24.90'].join('\n')
		);

		expect(dayFirst.summary.dateOrder).toBe('day-first');
		expect(monthFirst.summary.dateOrder).toBe('month-first');
	});

	/**
	 * Separates « the user's answer reached the stored fact » from « the answer changed the dates
	 * and was then forgotten ». An ambiguous file is the only one an answer can settle, so a
	 * summary that reported the default here would record a decision the import did not take.
	 */
	it('reports an explicit answer on the file that answer settles', () => {
		expect.assertions(2);

		const answered = parseCsvTransactions(
			['date,label,amount', '03/04/2026,CARREFOUR,-24.90'].join('\n'),
			{ dateOrder: 'month-first' }
		);

		expect(answered.summary.dateOrder).toBe('month-first');
		// The planted positive: the answer really did move the date, so the field is not merely
		// echoing the option back.
		expect(answered.transactions[0]?.date).toBe('2026-03-04');
	});
});

/**
 * # THE DISCLOSURE FIRES ON A CHOICE, NEVER ON ARITHMETIC. Plate 7l.
 *
 * « Dates lues jour puis mois — Date operation » states a proof, so it must appear only where
 * there was something to choose: a proven column is arithmetic and disclosing it every month is
 * noise (7l), and a defaulted column was never chosen by anyone, so a sentence claiming a reading
 * "was applied" beside a day-first fallback nobody answered would be the exact silent-default #433
 * is about, wearing a summary line instead of a refusal.
 */
describe('the summary discloses a chosen reading, never a proven or defaulted one', () => {
	/**
	 * THE ONE CASE THAT DISCLOSES. Separates « the column and the reading both reach the summary »
	 * from « only the applied order does », which the two tests above already cover: this is the
	 * new field, not `dateOrder` again.
	 */
	it('discloses the header and the reading when an ambiguous column was answered', () => {
		expect.assertions(1);

		const answered = parseCsvTransactions(
			['date,label,amount', '03/04/2026,CARREFOUR,-24.90'].join('\n'),
			{ dateOrder: 'month-first' }
		);

		expect(answered.summary.dateOrderDisclosure).toStrictEqual({
			kind: 'answered',
			header: 'date',
			order: 'month-first'
		});
	});

	/**
	 * #619. Separates « the file's proof won and the summary says the answer was not applied »
	 * from « the proof won in silence », which is what this test asserted until #619: an answer
	 * the file contradicts was discarded with nothing on screen. The proof still wins; the
	 * disclosure names the reading applied and the cell that proves it, bounded like every cell a
	 * summary shows.
	 */
	it('discloses an answer the file overruled, with the proving cell', () => {
		expect.assertions(2);

		const proven = parseCsvTransactions(
			['date,label,amount', '24/06/2026,CARREFOUR,-24.90'].join('\n'),
			{ dateOrder: 'month-first' }
		);

		expect(proven.summary.dateOrder).toBe('day-first');
		expect(proven.summary.dateOrderDisclosure).toStrictEqual({
			kind: 'overruled',
			order: 'day-first',
			proof: '24/06/2026'
		});
	});

	/**
	 * The proving cell is UNTRUSTED text on its way to the page, and `AMBIGUOUS_DATE_PATTERN` keeps
	 * the whole trimmed cell, not the ten characters of its date. Separates « bounded like every
	 * refusal cell » from « the upload chooses how much of itself the summary serialises »: a
	 * 600-character cell must not reach the disclosure at 600 characters.
	 */
	it('bounds the proving cell it discloses', () => {
		expect.assertions(2);

		const proven = parseCsvTransactions(
			['date,label,amount', `24/06/2026 ${'x'.repeat(600)},CARREFOUR,-24.90`].join('\n'),
			{ dateOrder: 'month-first' }
		);
		const disclosure = proven.summary.dateOrderDisclosure;
		const proof = disclosure?.kind === 'overruled' ? disclosure.proof : '';

		expect(proof.startsWith('24/06/2026')).toBe(true);
		expect(proof.length).toBeLessThanOrEqual(80);
	});

	/**
	 * Separates « a proven column with an agreeing answer discloses nothing » from « any answer on
	 * a proven file discloses ». A proven column is arithmetic and disclosing it every month is
	 * noise (7l); only a DISAGREEMENT is news.
	 */
	it('discloses nothing when the file proved the order the answer gave', () => {
		expect.assertions(2);

		const proven = parseCsvTransactions(
			['date,label,amount', '24/06/2026,CARREFOUR,-24.90'].join('\n'),
			{ dateOrder: 'day-first' }
		);

		expect(proven.summary.dateOrder).toBe('day-first');
		expect(proven.summary.dateOrderDisclosure).toBeUndefined();
	});

	/**
	 * Separates « nothing to decide discloses nothing » from « any applied order discloses ». An
	 * ISO column carries no ambiguous grammar at all, so there was never a question in it.
	 */
	it('discloses nothing when there was nothing to decide', () => {
		expect.assertions(1);

		const iso = parseCsvTransactions(
			['date,label,amount', '2026-06-01,CARREFOUR,-24.90'].join('\n')
		);

		expect(iso.summary.dateOrderDisclosure).toBeUndefined();
	});

	/**
	 * THE CASE THIS RULE EXISTS TO REFUSE. An ambiguous column with no answer still applies the
	 * day-first default on `mapped` (unchanged behaviour, asserted in
	 * `columns/page.server.spec.ts`), and it must not disclose a "reading" nobody chose: that would
	 * state a decision as a fact when it is the exact silent default #433 names.
	 *
	 * `profile: 'mapped'` alone is pinned rather than left to `auto`'s own resolution,
	 * deliberately: a registered profile no longer silently defaults here once the auto path can
	 * ask (task 2 of #433's remainder), and this test is about the one profile that still does.
	 * `dateOrderPromptedClientSide: true` is what actually keeps it defaulting since the
	 * contradiction pass found `mapped` alone no longer means that on its own — see
	 * `dateOrderSeam.spec.ts`'s own "a mapped parse asks unless..." block for the case that
	 * distinguishes the two `mapped` callers.
	 */
	it('discloses nothing when an ambiguous column silently defaulted on the mapped path', () => {
		expect.assertions(2);

		const defaulted = parseCsvTransactions(
			['date,label,amount', '03/04/2026,CARREFOUR,-24.90'].join('\n'),
			{
				profile: 'mapped',
				dateOrderPromptedClientSide: true,
				columnMapping: {
					matchBy: 'name',
					dateColumn: 'date',
					labelColumn: 'label',
					amountColumn: 'amount',
					categoryColumn: null,
					dateIndex: null,
					labelIndex: null,
					amountIndex: null,
					categoryIndex: null,
					columnCount: 3
				}
			}
		);

		expect(defaulted.summary.dateOrder).toBe('day-first');
		expect(defaulted.summary.dateOrderDisclosure).toBeUndefined();
	});
});

/**
 * # THE AUTO PATH ASKS, #433'S REMAINDER. `/import` has no designation screen to ask through, so
 * the door itself asks for exactly the population `#639`'s UI cannot reach: a RECOGNISED profile
 * (`parser` truthy) whose date column is ambiguous and carries no answer.
 *
 * `mapped` is excluded by construction rather than by a second condition: `parser` is null
 * exactly when the profile is `mapped`, which is the same variable the door already reads to
 * choose which parser runs. `columns/page.server.spec.ts:682`'s baseline is the reason it must
 * stay excluded — that test locks the silent default on the path #639's client-side screen
 * already covers.
 */
describe('a registered profile asks instead of silently defaulting on an ambiguous column', () => {
	/**
	 * THE ONE CASE THIS SESSION EXISTS TO CHANGE. Separates « the file is refused, asking » from
	 * « it imports silently under the default », which is what #433's remainder names.
	 */
	it('refuses with ambiguous-date-order, naming the column and a sample cell', () => {
		expect.assertions(5);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '06/01/2026,COFFEE,-4.50'].join('\n')
		);

		expect(result.transactions).toEqual([]);
		expect(result.summary.validRows).toBe(0);
		expect(result.summary.fileLevelRefusals).toBe(1);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toEqual({
			code: 'ambiguous-date-order',
			column: 0,
			sample: '06/01/2026'
		});
	});

	/** THE REPOST. An explicit answer still settles an ambiguous column, exactly as before. */
	it('imports once an explicit answer settles the same column', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '06/01/2026,COFFEE,-4.50'].join('\n'),
			{ dateOrder: 'month-first' }
		);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].date).toBe('2026-06-01');
	});

	/**
	 * THE COMPLEMENT'S FIRST HALF. A proven column names its own position, so there is nothing to
	 * ask: separates « the new branch fires on any registered profile » from « it fires only where
	 * the verdict is genuinely ambiguous ».
	 */
	it('does not fire on a column that proves its own order', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '24/06/2026,COFFEE,-4.50'].join('\n')
		);

		expect(result.transactions).toHaveLength(1);
		expect(result.summary.fileLevelRefusals).toBe(0);
	});

	/** THE COMPLEMENT'S SECOND HALF. An ISO column has no ambiguous grammar to ask about. */
	it('does not fire when there is nothing to decide', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '2026-06-01,COFFEE,-4.50'].join('\n')
		);

		expect(result.transactions).toHaveLength(1);
		expect(result.summary.fileLevelRefusals).toBe(0);
	});

	/**
	 * THE MIXED CASE STILL REFUSES ITS OWN WAY. Separates « ambiguous and mixed are the same
	 * branch » from « mixed keeps its own refusal and its own repairable path » (`mixed-date-order`
	 * is not in `DESIGNATION_CANNOT_REPAIR`; `ambiguous-date-order` must be, checked at the route).
	 */
	it('leaves a column proving both readings on its own mixed-date-order refusal', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			['Date,Description,Amount', '24/06/2026,A,-1.00', '06/24/2026,B,-2.00'].join('\n')
		);

		expect(result.transactions).toEqual([]);
		expect(result.invalidRows[0].fact.code).toBe('mixed-date-order');
	});
});

/**
 * # `mapped` ALONE NO LONGER MEANS "ALREADY ASKED". #433's contradiction pass.
 *
 * `/import`'s own action ALSO parses with `profile: 'mapped'`, silently, whenever it reapplies a
 * `ColumnMapping` remembered from a PREVIOUS designation (`useMapping`, by header fingerprint) —
 * no screen opens for that reuse, and `ColumnMapping` carries no `dateOrder` field, so nothing was
 * ever asked or remembered about this file's reading. Only `/import/columns`, backed by the
 * designation screen (#639), sets `dateOrderPromptedClientSide`, and only that caller may keep the
 * silent default this door still gives it.
 */
describe('a mapped parse asks unless the caller was the screen that already could', () => {
	const MAPPING: ColumnMappingInput = {
		matchBy: 'name',
		dateColumn: 'date',
		labelColumn: 'label',
		amountColumn: 'amount',
		categoryColumn: null,
		dateIndex: null,
		labelIndex: null,
		amountIndex: null,
		categoryIndex: null,
		columnCount: 3
	};

	/**
	 * THE GAP ITSELF. Separates « a silent mapped reuse still defaults, forever » from « it now
	 * asks like a registered profile does », which is what closes it.
	 */
	it('asks when the mapped parse carries no client-prompted flag', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			['date,label,amount', '03/04/2026,CARREFOUR,-24.90'].join('\n'),
			{ profile: 'mapped', columnMapping: MAPPING }
		);

		expect(result.transactions).toEqual([]);
		expect(result.invalidRows[0]?.fact.code).toBe('ambiguous-date-order');
	});

	/**
	 * THE CONTRACT `columns/page.server.spec.ts:682` LOCKS, preserved. Separates « the flag
	 * suppresses the ask » from « the flag does nothing », which would make the two tests here
	 * identical and prove neither.
	 */
	it('keeps the silent default when the caller flags itself as already having asked', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			['date,label,amount', '03/04/2026,CARREFOUR,-24.90'].join('\n'),
			{ profile: 'mapped', columnMapping: MAPPING, dateOrderPromptedClientSide: true }
		);

		expect(result.transactions).toHaveLength(1);
		expect(result.summary.dateOrder).toBe('day-first');
	});
});
