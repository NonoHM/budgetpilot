import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from './csv';

/**
 * A statement whose amounts are written as magnitudes, with the direction carried by a separate
 * column. A common French bank export shape, and a common accounting software export shape.
 *
 * MEASURED ON main AT 2dc895a, BEFORE THIS FIX: zero refusals, three valid rows,
 * totalDebitCents 0, totalCreditCents 191489. All three rows imported as income, so the user's
 * spending read 0,00 EUR against 64,89 EUR actually spent.
 *
 * The test below reproduces that measurement rather than merely failing: a red run that does not
 * bring the original figures back has verified nothing about the defect it claims to fix.
 */
const SIGN_INDICATOR_FILE = [
	'date;libelle;montant;sens',
	'24/06/2026;CARREFOUR MARKET;24,90;D',
	'22/06/2026;ORANGE SA;39,99;D',
	'21/06/2026;VIR RECU M. BERTIN SALAIRE;1850,00;C'
].join('\n');

describe('a statement carrying its direction in a separate column', () => {
	it('is refused, naming the column that holds the direction', () => {
		const result = parseCsvTransactions(SIGN_INDICATOR_FILE, { profile: 'auto' });

		expect(result.transactions).toHaveLength(0);
		expect(result.invalidRows).toEqual([
			{
				scope: { kind: 'header' },
				fact: { code: 'amount-sign-in-separate-column', column: 'sens' }
			}
		]);
		// The two figures the defect produced, pinned at zero here. Without them this test passes
		// against any refusal at all, including one for an unrelated reason.
		expect(result.summary.totalCreditCents).toBe(0);
		expect(result.summary.totalDebitCents).toBe(0);
	});
});

/**
 * #1323. One signed amount used to switch the detector off, so an UNSIGNED amount marked `D`
 * beside it imported as income: row A of the issue's file, 24,90 stored as money in. MEASURED ON
 * main AT 651d1f5, BEFORE THIS FIX: zero refusals, totalCreditCents 12490, totalDebitCents 300.
 * The sign and the indicator are two answers to one question, and here they disagree, so the file
 * is refused (AGENTS.md « Code style », a file proving two contradictory answers).
 */
describe('a statement whose signs and direction column disagree (#1323)', () => {
	function refusal(file: string) {
		const result = parseCsvTransactions(file, { profile: 'auto' });
		return {
			invalidRows: result.invalidRows,
			credit: result.summary.totalCreditCents,
			debit: result.summary.totalDebitCents
		};
	}
	const refused = {
		invalidRows: [
			{
				scope: { kind: 'header' },
				fact: { code: 'amount-sign-against-indicator', column: 'sens' }
			}
		],
		credit: 0,
		debit: 0
	};

	// Separates: an unsigned amount marked debit (refused) from one that agrees (imports, below).
	it('is refused when an unsigned amount is marked as a debit', () => {
		expect(
			refusal(
				[
					'date;libelle;montant;sens',
					'13/01/2026;A;24,90;D',
					'14/01/2026;B;-3,00;D',
					'15/01/2026;C;100,00;C'
				].join('\n')
			)
		).toEqual(refused);
	});

	// Separates: a negative amount marked credit, the mirror disagreement, from an agreeing file.
	it('is refused when a negative amount is marked as a credit', () => {
		expect(
			refusal(
				[
					'date;libelle;montant;sens',
					'13/01/2026;A;-24,90;D',
					'14/01/2026;B;-3,00;C',
					'15/01/2026;C;100,00;C'
				].join('\n')
			)
		).toEqual(refused);
	});

	// Pass F1. Separates: a constant column judged in a signed file (refused) from one skipped as a
	// marker. A month with no credit, same bank as above.
	it('is refused when the column is constant and an unsigned amount sits beside its « D »', () => {
		expect(
			refusal(
				[
					'date;libelle;montant;sens',
					'13/01/2026;A;-3,00;D',
					'14/01/2026;B;24,90;D',
					'15/01/2026;C;-60,00;D'
				].join('\n')
			)
		).toEqual(refused);
	});

	// Pass F2. Separates: the column judged over the rows that are stored (refused) from one judged
	// over every line, where the shifted cell `-12,00` is not a token and switched the check off.
	it('is refused when one wrong-width row shifts a non-token into the column', () => {
		expect(
			refusal(
				[
					'date;libelle;montant;sens',
					'13/01/2026;A;-3,00;D',
					'14/01/2026;B;24,90;D',
					'15/01/2026;C;100,00;C',
					'16/01/2026;RESTO; PARIS;-12,00;D'
				].join('\n')
			)
		).toEqual(refused);
	});

	// Pass 2, F-A. Separates: the column judged over rows with an amount (refused) from one where a
	// zero-amount row's `N`, refused on its own line, switched the check off.
	it('is refused when a zero-amount row carries a non-token in the column', () => {
		expect(
			refusal(
				[
					'date;libelle;montant;sens',
					'13/01/2026;A;-3,00;D',
					'14/01/2026;B;24,90;D',
					'15/01/2026;C;100,00;C',
					'16/01/2026;Info;0,00;N',
					'17/01/2026;Paiement;;EN COURS'
				].join('\n')
			)
		).toEqual(refused);
	});

	// Pass F2, second door. Separates the same two populations through an undated balance footer.
	it('is refused when an undated footer carries a non-token in the column', () => {
		expect(
			refusal(
				[
					'date;libelle;montant;sens',
					'13/01/2026;A;-3,00;D',
					'14/01/2026;B;24,90;D',
					'15/01/2026;C;100,00;C',
					'Solde au 15/01/2026;;1234,56;Créditeur'
				].join('\n')
			)
		).toEqual(refused);
	});
});

/**
 * This change NARROWS what imports, so the tests above cannot fail for the reason worth being
 * afraid of: a detector that refused every file would satisfy every one of them. These are the
 * half that can, and they are the direction the change is not moving in.
 */
describe('files that must still import', () => {
	// `amountSign` is the member's answer for a file whose amounts carry no sign (#1207 C2c-S1):
	// since then such a file is asked about rather than imported as income, so the « still imports »
	// cases below pass the answer the member would give and assert the rows follow it.
	function importedTypes(file: string, amountSign?: 'out' | 'in'): string[] {
		const result = parseCsvTransactions(file, {
			profile: 'auto',
			...(amountSign ? { amountSign } : {})
		});
		expect(result.invalidRows).toEqual([]);
		// The presence half beside the emptiness assertion above: a parse that produced no
		// transaction at all satisfies "no refusals" perfectly.
		expect(result.transactions.length).toBeGreaterThan(0);
		return result.transactions.map((transaction) => transaction.metadata.type);
	}

	it('signs its own amounts, so an indicator column beside them decides nothing', () => {
		expect(
			importedTypes(
				[
					'date;libelle;montant;sens',
					'24/06/2026;CARREFOUR MARKET;-24,90;D',
					'21/06/2026;VIR RECU M. BERTIN SALAIRE;1850,00;C'
				].join('\n')
			)
		).toEqual(['expense', 'income']);
	});

	it('reads accounting parentheses as a signed amount, so an indicator column decides nothing (#1285)', () => {
		expect(
			importedTypes(
				[
					'date;libelle;montant;sens',
					'24/06/2026;CARREFOUR MARKET;(24,90);D',
					'21/06/2026;VIR RECU M. BERTIN SALAIRE;1850,00;C'
				].join('\n')
			)
		).toEqual(['expense', 'income']);
	});

	it('is all positive with no indicator column, which imports as income once answered « in »', () => {
		expect(
			importedTypes(
				[
					'date;libelle;montant',
					'24/06/2026;SALAIRE JUIN;1850,00',
					'24/05/2026;SALAIRE MAI;1850,00'
				].join('\n'),
				'in'
			)
		).toEqual(['income', 'income']);
	});

	it('carries free text in a column named like an indicator, which is not the vocabulary', () => {
		// Not refused by THIS detector, and no longer imported as income either: no amount is
		// negative, so the member is asked. These rows mix both directions, which no file-wide answer
		// expresses; designating the column itself is #1284.
		const result = parseCsvTransactions(
			[
				'date;libelle;montant;sens',
				'24/06/2026;CARREFOUR MARKET;24,90;sortie de caisse',
				'21/06/2026;VIR RECU SALAIRE;1850,00;entree'
			].join('\n'),
			{ profile: 'auto' }
		);
		expect(result.invalidRows.map((row) => row.fact.code)).toEqual(['ambiguous-amount-sign']);
	});

	it('carries a constant indicator, which is a marker rather than a direction', () => {
		// A column reading "D" on every line carries no direction for this detector to read, and
		// widening it to catch the case is what makes it refuse files that import correctly. Until
		// #1207 (C2c-S1) these two rows of spending imported as income; now no amount is negative, so
		// the member is asked, and answering « out » reads them as what they are.
		expect(
			importedTypes(
				[
					'date;libelle;montant;sens',
					'24/06/2026;CARREFOUR MARKET;24,90;D',
					'22/06/2026;ORANGE SA;39,99;D'
				].join('\n'),
				'out'
			)
		).toEqual(['expense', 'expense']);
	});
});
