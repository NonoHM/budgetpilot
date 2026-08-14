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
