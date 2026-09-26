import { describe, expect, it } from 'vitest';
import { importWriteFailureLabel } from './importWriteLabel';
import { refusalLabel } from './refusalLabel';

/**
 * The sentence each write failure shows, compared WHOLE: a substring assertion passes over a
 * doubled tail or a wrong plural, and the plural is the one thing here that differs by a count.
 * The server project pins the locale to French (`vitest.server.setup.ts`), so the anchors are
 * French.
 */
describe('importWriteFailureLabel', () => {
	it('says nothing was saved, and to try again', () => {
		expect(importWriteFailureLabel({ kind: 'nothing-saved' })).toBe(
			"L'import n'a pas abouti et aucune transaction n'a été enregistrée. Réessayez."
		);
	});

	it('names one saved transaction in the singular', () => {
		expect(importWriteFailureLabel({ kind: 'partly-saved', landedRows: 1 })).toBe(
			"L'import s'est arrêté après 1 transaction enregistrée. Supprimez-le dans Imports, puis réessayez."
		);
	});

	it('names several saved transactions in the plural', () => {
		expect(importWriteFailureLabel({ kind: 'partly-saved', landedRows: 39 })).toBe(
			"L'import s'est arrêté après 39 transactions enregistrées. Supprimez-le dans Imports, puis réessayez."
		);
	});

	it('says transactions may have been saved when the count is unknown', () => {
		expect(importWriteFailureLabel({ kind: 'maybe-saved' })).toBe(
			"L'import s'est arrêté et des transactions ont pu être enregistrées. Vérifiez dans Imports avant de réessayer."
		);
	});

	it('renders the currency backstop exactly as the routes render their own refusal', () => {
		// Called, not retyped: the two screens must say the same sentence for the same fact.
		const fact = {
			code: 'declared-currency-mismatch' as const,
			declared: 'USD',
			destination: 'EUR'
		};
		expect(importWriteFailureLabel({ kind: 'currency', fact })).toBe(refusalLabel(fact));
	});
});
