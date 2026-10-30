import { describe, expect, it } from 'vitest';
import { buildTransactionsCsv, TRANSACTION_CSV_HEADER } from './exportCsv';
import type { TransactionRowForMapping } from './nature';
import type { TransactionNature } from '$lib/domain/transaction';

/**
 * The export half of the round trip (OD-2 option b).
 *
 * Split out of `routes/transactions/export/+server.ts` so the CSV a user downloads can be handed
 * straight to the REAL parser in `round-trip.spec.ts`. That is the whole reason this module exists
 * as a module: a round-trip test whose "expected CSV" is retyped by the test proves the test agrees
 * with itself, which is the oracle mistake CLAUDE.md records.
 */

const NO_MAPPINGS = new Map<string, TransactionNature>();

/** `categorie_parent`, by index rather than by `.at(-1)`. It stopped being the last column when v3
 *  appended `compte`, and `.at(-1)` followed the move silently: the assertions below would have
 *  gone on reading « the last column » and reported about the account instead. */
const PARENT_CATEGORY_COLUMN = 9;

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
	};
}

// Deliberately assertion-free: an `expect` in a helper called a varying number of times per test
// makes every `expect.assertions(n)` a puzzle. The header is pinned once, in its own test.
function bodyOf(csv: string): string[] {
	return csv.split('\r\n').slice(1);
}

describe('buildTransactionsCsv', () => {
	it('leads with the versioned header, which is the thing maison-v2 recognises', () => {
		expect.assertions(1);

		expect(buildTransactionsCsv([row()], NO_MAPPINGS).split('\r\n')[0]).toBe(
			TRANSACTION_CSV_HEADER
		);
	});

	it('emits one line per allocation, so a répartition is N lines and an ordinary row is one', () => {
		expect.assertions(2);

		const plain = bodyOf(buildTransactionsCsv([row()], NO_MAPPINGS));
		const split = bodyOf(
			buildTransactionsCsv(
				[
					row({
						splits: [
							{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
							{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
						]
					})
				],
				NO_MAPPINGS
			)
		);

		expect(plain).toHaveLength(1);
		expect(split).toHaveLength(2);
	});

	it('carries the parent total and the position on EVERY line, which is what lets the parser regroup them', () => {
		expect.assertions(2);

		const [first, second] = bodyOf(
			buildTransactionsCsv(
				[
					row({
						splits: [
							{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
							{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
						]
					})
				],
				NO_MAPPINGS
			)
		);

		// montant = the PART, montant_total = the PARENT, both signed as expenses.
		// The trailing `;` is the v3 `compte` column, empty because no account was named. The header
		// is frozen, so the column exists on every line whether or not it has a value: a line one
		// cell short of its own header is refused by the parser as `bad-column-count`.
		expect(first).toBe(
			"2026-06-12;Leroy Merlin;Bricolage;'-50.00;expense;spending;csv;'-80.00;1/2;Maison;"
		);
		expect(second).toBe(
			"2026-06-12;Leroy Merlin;Jardin;'-30.00;expense;spending;csv;'-80.00;2/2;Maison;"
		);
	});

	// §2.2's restoration value. Nothing else in the file carries it: a correctly-split transaction
	// has a zero remainder, so the parent's own category appears in NO allocation, and a round trip
	// without this column silently replaces it with whichever part came first.
	it('states the PARENT category even when no allocation carries it', () => {
		expect.assertions(2);

		const [first] = bodyOf(
			buildTransactionsCsv(
				[
					row({
						category: { name: 'Maison' },
						splits: [
							{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
							{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
						]
					})
				],
				NO_MAPPINGS
			)
		);

		expect(first.split(';')[PARENT_CATEGORY_COLUMN]).toBe('Maison');
		expect(first.split(';')[2]).toBe('Bricolage');
	});

	it('unsplit rows say 1/1 and repeat themselves, so every line has the same shape', () => {
		expect.assertions(1);

		expect(bodyOf(buildTransactionsCsv([row()], NO_MAPPINGS))[0]).toBe(
			"2026-06-12;Leroy Merlin;Maison;'-80.00;expense;spending;csv;'-80.00;1/1;Maison;"
		);
	});

	// OD-4: each part's nature comes from its OWN category. A file stating the parent's nature on
	// every line would be a per-category export whose natures disagree with the app's own reports.
	it('resolves nature per part, not once for the parent', () => {
		expect.assertions(2);

		const mappings = new Map<string, TransactionNature>([['jardin', 'transfer']]);
		const [first, second] = bodyOf(
			buildTransactionsCsv(
				[
					row({
						splits: [
							{ amountCents: 5000, position: 0, category: { name: 'Bricolage' } },
							{ amountCents: 3000, position: 1, category: { name: 'Jardin' } }
						]
					})
				],
				mappings
			)
		);

		expect(first.split(';')[5]).toBe('spending');
		expect(second.split(';')[5]).toBe('transfer');
	});

	it('escapes and de-fangs every column, including the two new ones', () => {
		expect.assertions(3);

		const [line] = bodyOf(
			buildTransactionsCsv([row({ label: 'A;B"C', category: { name: '=SUM(A1)' } })], NO_MAPPINGS)
		);

		expect(line).toContain('"A;B""C"');
		// The formula guard applies to the parent-category column too — it is the same user text,
		// reaching the same spreadsheet, and a guard applied to one copy and not the other is the
		// fix-the-instance shape.
		// Counted from the END rather than through `PARENT_CATEGORY_COLUMN`, and the reason is the
		// fixture: this label carries a `;` inside its quotes, so a naive split has more pieces than
		// the file has columns and every index past the label is wrong. Counting from the right works
		// because every field after the label is delimiter-free by its own grammar, with ONE
		// exception, `compte`, which is an account name and may carry anything. It is empty here,
		// which is why `-2` lands on the parent category.
		expect(line.split(';').at(-2)).toBe("'=SUM(A1)");
		expect(line.split(';').at(-1)).toBe('');
	});

	/**
	 * #594. THE ANCHOR SEES THE FIRST CODE UNIT, THE SPREADSHEET SEES THE FIRST CHARACTER IT KEEPS.
	 *
	 * Measured rather than reasoned, on LibreOffice 26.8 against a file this function produced: a
	 * label of U+0000 followed by `=1+1` imports as `value-type="float" value="2"` carrying
	 * `table:formula="of:=1+1"`. LibreOffice DISCARDS the NUL, which promotes the `=` to first
	 * position, so the anchored test here never saw the character the consumer did.
	 *
	 * Every assertion below names the two states it separates, because « the guard fired » and
	 * « the guard fired for the reason claimed » are the same green otherwise.
	 */
	describe('the leading character a spreadsheet actually keeps (#594)', () => {
		/** The field a label lands in, with the header's own name rather than a counted index. */
		function labelFieldOf(label: string): string {
			const [line] = bodyOf(buildTransactionsCsv([row({ label })], NO_MAPPINGS));
			return line.split(';')[1];
		}

		it('guards a formula hidden behind a leading NUL, which the spreadsheet discards', () => {
			expect.assertions(1);

			// Separates « the guard reads the first character a consumer keeps » from « the guard
			// reads the first code unit present », which is what shipped.
			expect(labelFieldOf('\u0000=1+1')).toBe("'\u0000=1+1");
		});

		it('guards one hidden behind a zero-width space, the same defect without a control byte', () => {
			expect.assertions(1);

			expect(labelFieldOf('\u200B=1+1')).toBe("'\u200B=1+1");
		});

		it('still leaves an ordinary label completely alone', () => {
			expect.assertions(2);

			// The planted negative. If this ever gains an apostrophe the fix has become a regression,
			// and the two assertions below would not say so on their own.
			expect(labelFieldOf('Leroy Merlin')).toBe('Leroy Merlin');
			expect(labelFieldOf('Étude de Maître Blanc')).toBe('Étude de Maître Blanc');
		});

		it('still guards a bare negative amount, which 161 cells of the corpus open with', () => {
			expect.assertions(2);

			// Measured on `scripts/synthetic/`: 161 of 1 759 cells open with `-` and NONE is a
			// formula. A fix that stopped quoting them would be a visible regression on every
			// French statement, so it is asserted here rather than inherited from `safety.spec.ts`.
			// Quoted since F8, because it holds a comma (RFC 4180 2.6); the guard is unchanged.
			expect(labelFieldOf('-39,90')).toBe(`"'-39,90"`);
			expect(bodyOf(buildTransactionsCsv([row()], NO_MAPPINGS))[0].split(';')[3]).toBe("'-80.00");
		});
	});

	/**
	 * F8, a variant of GHSA-mf96-r88r-98rw. A READER SPLITTING ON ANOTHER CHARACTER STARTS A CELL
	 * INSIDE OUR FIELD, and the leading guard never looks there.
	 *
	 * Measured on LibreOffice 26.8.1.1 against files this function produced, one separator forced
	 * per run: `Courses,=1+1` is a live formula for a comma, tab, space, pipe or colon reader, and a
	 * line break inside a field is live for all five. Quoting cannot help, because a reader honours
	 * a quote only at the start of ITS OWN cell, and our quote opens a `;` cell. Scope ruled by the
	 * owner: comma, tab, CR, LF. A space, pipe or colon reader is the documented residual.
	 */
	describe('a cell a reader starts inside the field (F8)', () => {
		function fieldsOf(label: string, accountName?: string): string {
			return bodyOf(
				buildTransactionsCsv([row({ label })], NO_MAPPINGS, undefined, { accountName })
			)[0];
		}

		it('guards a formula after an inner comma, and quotes the field per RFC 4180 2.6', () => {
			expect.assertions(1);

			// Separates « the guard reads every cell start a comma reader makes » from « the guard
			// reads the field's first character only », which is what shipped.
			expect(fieldsOf('Courses,=1+1').split(';')[1]).toBe(`"Courses,'=1+1"`);
		});

		it('quotes a field holding a comma even when nothing in it needs a guard', () => {
			expect.assertions(1);

			// Separates the RFC 4180 2.6 quoting clause from the guard clause above: no apostrophe
			// can appear here, so only the quoting can turn this red.
			expect(fieldsOf('CB 12,50 EUR').split(';')[1]).toBe('"CB 12,50 EUR"');
		});

		it('guards a formula after an inner tab', () => {
			expect.assertions(1);

			expect(fieldsOf('Courses\t=1+1').split(';')[1]).toBe("Courses\t'=1+1");
		});

		it('guards a formula after a line feed and after a carriage return, which start a row for every reader', () => {
			expect.assertions(2);

			// Each separates « a line break is a cell start » from « only a delimiter is », for the
			// one character the other assertion does not cover.
			expect(fieldsOf('x\n=1+1,y').split(';')[1]).toBe(`"x\n'=1+1,y"`);
			expect(fieldsOf('x\r=1+1').split(';')[1]).toBe(`"x\r'=1+1"`);
		});

		it('reads the cell the way the leading guard does, so a NUL behind the comma does not hide it', () => {
			expect.assertions(1);

			// Separates « the inner guard calls the single definition » from « it tests the next
			// code unit », which would let the #594 bypass back in one cell later.
			expect(fieldsOf('a,\u0000=1+1').split(';')[1]).toBe(`"a,'\u0000=1+1"`);
		});

		it('guards every inner cell, not only the first', () => {
			expect.assertions(1);

			expect(fieldsOf('a,=1,=2').split(';')[1]).toBe(`"a,'=1,'=2"`);
		});

		it('reaches the account column too, which is free text like the label', () => {
			expect.assertions(1);

			expect(fieldsOf('Leroy Merlin', 'Joint,=1+1').split(';').at(-1)).toBe(`"Joint,'=1+1"`);
		});

		it('leaves the ruled residual alone: a starter after a space is an ordinary label', () => {
			expect.assertions(1);

			// The planted negative. A guard after a space would put an apostrophe into labels like
			// this one, which is why the owner ruled space out of scope.
			expect(fieldsOf('VIR - LOYER').split(';')[1]).toBe('VIR - LOYER');
		});
	});

	// PR5: a filtered export must read like the screen it came from, which means emitting only the
	// allocations the filter matched — never a répartition's OTHER parts, which the screen never
	// showed under that filter either.
	describe('with a categoryFilter (PR5)', () => {
		const SPLIT_THREE_WAYS = row({
			category: { name: 'Maison' },
			splits: [
				{ amountCents: 5_000, position: 0, category: { name: 'Bricolage' } },
				{ amountCents: 2_000, position: 1, category: { name: 'Jardin' } },
				{ amountCents: 1_000, position: 2, category: { name: 'Loisirs' } }
			]
		});

		it('emits only the matching line for a fully unrelated filter, unaffected by it', () => {
			expect.assertions(1);

			const lines = bodyOf(buildTransactionsCsv([row()], NO_MAPPINGS, 'Maison'));
			expect(lines).toHaveLength(1);
		});

		it('drops the non-matching lines but keeps `part` stating the TRUE, full count', () => {
			expect.assertions(2);

			const lines = bodyOf(buildTransactionsCsv([SPLIT_THREE_WAYS], NO_MAPPINGS, 'Jardin'));

			expect(lines).toHaveLength(1);
			// `2/3`: the true position AND the true total, not `1/1` — a file claiming a complete
			// one-part répartition would silently corrupt a re-import (see the module docstring).
			expect(lines[0].split(';')[8]).toBe('2/3');
		});

		it('folds the category name, like every other category read in the app', () => {
			expect.assertions(1);

			const lines = bodyOf(buildTransactionsCsv([SPLIT_THREE_WAYS], NO_MAPPINGS, 'JARDIN'));
			expect(lines).toHaveLength(1);
		});

		it('emits nothing extra for an unsplit row whose own category matches', () => {
			expect.assertions(2);

			const lines = bodyOf(buildTransactionsCsv([row()], NO_MAPPINGS, 'Maison'));
			expect(lines).toHaveLength(1);
			expect(lines[0].split(';')[8]).toBe('1/1');
		});

		it('is a strict no-op when undefined, unaffected by an empty string, and identical to the two-argument call', () => {
			expect.assertions(2);

			const withoutFilter = buildTransactionsCsv([SPLIT_THREE_WAYS], NO_MAPPINGS);
			const withUndefined = buildTransactionsCsv([SPLIT_THREE_WAYS], NO_MAPPINGS, undefined);
			const withEmpty = buildTransactionsCsv([SPLIT_THREE_WAYS], NO_MAPPINGS, '');

			expect(withUndefined).toBe(withoutFilter);
			expect(withEmpty).toBe(withoutFilter);
		});
	});
});
