import { describe, expect, it } from 'vitest';
import en from '../../../../messages/en.json';
import fr from '../../../../messages/fr.json';
import { CSV_REFUSAL_CODES } from './refusals';
import { TRANSACTION_VALIDATION_CODES } from '$lib/domain/transaction';

const KEY = (code: string) => `import_refusal_${code.replaceAll('-', '_')}`;
const TX_KEY = (code: string) => `import_refusal_tx_${code.replaceAll('-', '_')}`;

describe('refusal catalogue coverage', () => {
	it('every code has a key in both locales, and the population is not empty', () => {
		expect.assertions(3);
		// The absolute figure: a run that checked nothing must not read as clean.
		// 36 here: 28 from the original vocabulary, `transaction-invalid` from the domain
		// conversion, the four file level codes (`file-too-large`, `file-empty`,
		// `too-many-rows`, `header-not-recognized`), `ambiguous-column-mapping` from the
		// alias table, `amount-sign-in-separate-column` for a file whose amounts are magnitudes
		// with the direction in a sibling column, `too-many-columns` for the bound the
		// designation screen needs, and `amount-split-across-columns` for a file whose money is
		// split across a debit and a credit column (#343).
		//
		// EXACT, not a floor. This was `toBeGreaterThanOrEqual(33)`, which is satisfied by a
		// tree that has DELETED a code and added two, and by any future count above 33: an
		// assertion with slack has a blind band the size of its slack. The count is knowable,
		// so every change to it should be deliberate enough to edit this line.
		expect(CSV_REFUSAL_CODES).toHaveLength(39);

		const missingFr = CSV_REFUSAL_CODES.filter((c) => !(KEY(c) in fr));
		const missingEn = CSV_REFUSAL_CODES.filter((c) => !(KEY(c) in en));

		expect(missingFr).toStrictEqual([]);
		expect(missingEn).toStrictEqual([]);
	});

	it('every TransactionValidationCode has an import_refusal_tx_ key in both locales', () => {
		expect.assertions(3);
		// The absolute figure: a run that checked nothing must not read as clean.
		expect(TRANSACTION_VALIDATION_CODES.length).toBeGreaterThanOrEqual(11);

		const missingFr = TRANSACTION_VALIDATION_CODES.filter((c) => !(TX_KEY(c) in fr));
		const missingEn = TRANSACTION_VALIDATION_CODES.filter((c) => !(TX_KEY(c) in en));

		expect(missingFr).toStrictEqual([]);
		expect(missingEn).toStrictEqual([]);
	});
});
