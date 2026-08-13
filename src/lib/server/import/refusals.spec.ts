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
		// 29 here: 28 from Task 1, plus `transaction-invalid`, appended in Task 2.
		expect(CSV_REFUSAL_CODES.length).toBeGreaterThanOrEqual(29);

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
