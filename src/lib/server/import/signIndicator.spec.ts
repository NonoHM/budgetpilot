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
 * This change NARROWS what imports, so the tests above cannot fail for the reason worth being
 * afraid of: a detector that refused every file would satisfy every one of them. These are the
 * half that can, and they are the direction the change is not moving in.
 */
describe('files that must still import', () => {
	function importedTypes(file: string): string[] {
		const result = parseCsvTransactions(file, { profile: 'auto' });
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

	it('is all positive with no indicator column, which is an ordinary income-only statement', () => {
		expect(
			importedTypes(
				[
					'date;libelle;montant',
					'24/06/2026;SALAIRE JUIN;1850,00',
					'24/05/2026;SALAIRE MAI;1850,00'
				].join('\n')
			)
		).toEqual(['income', 'income']);
	});

	it('carries free text in a column named like an indicator, which is not the vocabulary', () => {
		expect(
			importedTypes(
				[
					'date;libelle;montant;sens',
					'24/06/2026;CARREFOUR MARKET;24,90;sortie de caisse',
					'21/06/2026;VIR RECU SALAIRE;1850,00;entree'
				].join('\n')
			)
		).toEqual(['income', 'income']);
	});

	it('carries a constant indicator, which is a marker rather than a direction', () => {
		// Honest rather than desirable: these two rows are spending and they import as income,
		// because a column reading "D" on every line carries no direction to read. Widening the
		// vocabulary or dropping the two-token condition to catch this is what makes the detector
		// start refusing files that would have imported correctly. The column mapping path closes
		// it properly, by asking the user.
		expect(
			importedTypes(
				[
					'date;libelle;montant;sens',
					'24/06/2026;CARREFOUR MARKET;24,90;D',
					'22/06/2026;ORANGE SA;39,99;D'
				].join('\n')
			)
		).toEqual(['income', 'income']);
	});
});
