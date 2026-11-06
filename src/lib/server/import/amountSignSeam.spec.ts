import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';
import type { ColumnMappingInput } from './mapping/model';

/**
 * An amount column that never carries a minus sign does not say which rows are money out (#1207,
 * decision record #1206: « amount sign when the file does not prove it » gets a forcing step).
 *
 * Measured before this change (`docs/superpowers/2026-11-06-1207c/sign.out.txt`, re-run with the
 * command in `sign.measure.ts`): three card payments written as magnitudes imported as 76,89 of
 * INCOME and 0 of spending, with no refusal. So did #320's own shape with a constant « D » column.
 * A wrong figure that renders like a right one.
 *
 * Every date below has a day above 12, so the date order is proven and cannot be the question.
 */

const UNSIGNED = [
	'date;libelle;montant',
	'24/06/2026;CB A;24,90',
	'22/06/2026;CB B;39,99',
	'21/06/2026;CB C;12,00'
].join('\n');
const CONSTANT_MARKER = [
	'date;libelle;montant;sens',
	'24/06/2026;CB A;24,90;D',
	'22/06/2026;CB B;39,99;D',
	'21/06/2026;CB C;12,00;D'
].join('\n');
const SIGNED = [
	'date;libelle;montant',
	'24/06/2026;CB A;-24,90',
	'22/06/2026;SALAIRE;1850,00',
	'21/06/2026;CB C;-12,00'
].join('\n');

const POSITIONAL: ColumnMappingInput = {
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
};

describe('an unsigned amount column is asked about, never defaulted to income', () => {
	/** Separates « the file asks » from « it imports as income under the old default ». */
	it('refuses with ambiguous-amount-sign, naming the column and a sample cell', () => {
		expect.assertions(5);

		const result = parseCsvTransactions(UNSIGNED);

		expect(result.transactions).toEqual([]);
		expect(result.summary.validRows).toBe(0);
		expect(result.summary.fileLevelRefusals).toBe(1);
		expect(result.invalidRows).toHaveLength(1);
		expect(result.invalidRows[0].fact).toEqual({
			code: 'ambiguous-amount-sign',
			column: 2,
			sample: '24,90'
		});
	});

	/** Separates « money out reads every row as spending » from « the answer is ignored ». */
	it('reads every row as money out once the member answers out', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(UNSIGNED, { amountSign: 'out' });

		expect(result.summary.validRows).toBe(3);
		expect(result.summary.totalDebitCents).toBe(7689);
		expect(result.summary.totalCreditCents).toBe(0);
	});

	/** Separates « money in reads every row as income » from « both answers mean the same ». */
	it('reads every row as money in once the member answers in', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(UNSIGNED, { amountSign: 'in' });

		expect(result.summary.totalDebitCents).toBe(0);
		expect(result.summary.totalCreditCents).toBe(7689);
	});

	/**
	 * THE ANSWER IS THE DIRECTION THE RULES SEE (pass F2). Separates « the answer is applied where the
	 * row is typed, before categorisation » from « rows are retyped afterwards », where a rule for
	 * spending never fires because the row it read was still income.
	 */
	it('lets a spending rule categorise a row the member answered as money out', () => {
		expect.assertions(1);

		const result = parseCsvTransactions(UNSIGNED, {
			amountSign: 'out',
			categorizationRules: [
				{ id: 'rule-cb', pattern: 'CB', targetCategory: 'Courses', type: 'expense', active: true }
			]
		});

		expect(result.transactions.map((transaction) => transaction.category)).toEqual([
			'Courses',
			'Courses',
			'Courses'
		]);
	});

	/** #320's constant marker: a column naming no direction proves nothing, so it asks too. */
	it('asks when a constant marker column sits beside the unsigned amounts', () => {
		expect.assertions(1);

		const result = parseCsvTransactions(CONSTANT_MARKER);

		expect(result.invalidRows[0]?.fact.code).toBe('ambiguous-amount-sign');
	});

	/** EVERY DOOR: the mapped parse has no exemption a caller can claim, as for the date (#1200). */
	it('asks on the mapped door too', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(UNSIGNED.split('\n').slice(1).join('\n'), {
			profile: 'mapped',
			columnMapping: POSITIONAL,
			hasHeaderRow: false
		});

		expect(result.transactions).toEqual([]);
		expect(result.invalidRows[0]?.fact).toEqual({
			code: 'ambiguous-amount-sign',
			column: 2,
			sample: '24,90'
		});
	});
});

describe('what does not move', () => {
	/** One minus sign anywhere proves the file signs its amounts: no question, no answer needed. */
	it('imports a signed file without asking', () => {
		expect.assertions(3);

		const result = parseCsvTransactions(SIGNED);

		expect(result.invalidRows).toEqual([]);
		expect(result.summary.totalDebitCents).toBe(3690);
		expect(result.summary.totalCreditCents).toBe(185000);
	});

	/**
	 * THE VERDICT READS ROWS CARRYING A DATED AMOUNT, not every cell (note pass 2, 1a). Separates « a
	 * negative footer with no readable date does not prove the column signed » from « any negative
	 * cell anywhere settles it », under which this file, three unsigned card payments and a closing
	 * total, imported all three as income with nothing said.
	 */
	it('asks about unsigned rows even when an undated footer carries a negative total', () => {
		expect.assertions(1);

		const result = parseCsvTransactions(`${UNSIGNED}\nTotal;;-76,89`);

		expect(result.invalidRows.map((row) => row.fact.code)).toContain('ambiguous-amount-sign');
	});

	/**
	 * A DATE WHOSE ONLY FAULT IS ITS YEAR IS STILL A DATE (#758). Separates « a row with a readable
	 * date proves the sign, even when its year cannot be stored » from « any refused date reading
	 * drops the row », under which this signed file's one payment, dated year 0000, was set aside and
	 * the salary beside it was asked about (gates run, `yearRange.db-smoke.ts`).
	 */
	it('counts a negative row whose year is out of range as proof that the file signs', () => {
		expect.assertions(1);

		const result = parseCsvTransactions(
			[
				'date,label,amount',
				'0000-01-16,Boulangerie,-4.20',
				'2026-06-14,Virement salaire,1850.00'
			].join('\n')
		);

		expect(result.invalidRows.map((row) => row.fact.code)).toEqual(['date-out-of-range']);
	});

	/**
	 * THE COST OF THE LINE ABOVE, stated and pinned (pass F3 decided the strict way, AGENTS.md: the
	 * false negative wins). A signed file whose only negative row has an impossible date is ASKED, the
	 * safe direction, and the screen opens the step from this refusal.
	 */
	it('asks about a signed file whose only negative row has an impossible date', () => {
		expect.assertions(1);

		const result = parseCsvTransactions(
			['date;libelle;montant', '31/02/2026;CB A;-24,90', '22/06/2026;SALAIRE;1850,00'].join('\n')
		);

		expect(result.invalidRows.map((row) => row.fact.code)).toContain('ambiguous-amount-sign');
	});

	/**
	 * An answer cannot flip a file that proves its own signs: the file wins, as for the date.
	 * « out », the one answer that changes a row when wrongly applied: « in » leaves a signed file's
	 * figures as they are either way, so it separated nothing (break B5 stayed green on it).
	 */
	it('ignores an answer on a signed file', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(SIGNED, { amountSign: 'out' });

		expect(result.summary.totalDebitCents).toBe(3690);
		expect(result.summary.totalCreditCents).toBe(185000);
	});

	/** A known bank format fixes the column's meaning: Revolut signs, so all-positive is income. */
	it('does not ask on a Revolut export whose rows are all positive', () => {
		expect.assertions(2);

		const result = parseCsvTransactions(
			[
				'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde',
				'TOPUP,Current,2026-08-01 10:00:00,2026-08-01 10:00:00,Top up,50.00,0.00,EUR,TERMINÉ,550.00'
			].join('\n')
		);

		expect(result.summary.profile).toBe('revolut');
		expect(result.summary.totalCreditCents).toBe(5000);
	});
});
