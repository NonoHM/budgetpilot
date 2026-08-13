import { describe, expect, it } from 'vitest';
import en from '../../../../messages/en.json';
import fr from '../../../../messages/fr.json';
import { CSV_REFUSAL_CODES } from './refusals';

const KEY = (code: string) => `import_refusal_${code.replaceAll('-', '_')}`;

describe('refusal catalogue coverage', () => {
	it('every code has a key in both locales, and the population is not empty', () => {
		expect.assertions(3);
		// The absolute figure: a run that checked nothing must not read as clean.
		// 28 here, and Task 2 raises it to 29 when it appends `transaction-invalid`.
		expect(CSV_REFUSAL_CODES.length).toBeGreaterThanOrEqual(28);

		const missingFr = CSV_REFUSAL_CODES.filter((c) => !(KEY(c) in fr));
		const missingEn = CSV_REFUSAL_CODES.filter((c) => !(KEY(c) in en));

		expect(missingFr).toStrictEqual([]);
		expect(missingEn).toStrictEqual([]);
	});
});
