import { describe, expect, it } from 'vitest';
import { parseCsvTransactions } from '../csv';

const BANQUE_POPULAIRE_HEADER =
	'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation';

function parseBanquePopulaireLine(line: string) {
	return parseCsvTransactions(`${BANQUE_POPULAIRE_HEADER}\n${line}`);
}

/**
 * `normalizeFirstValidDate` tries `Date operation`, then `Date de comptabilisation`, then
 * `Date de valeur`, in that order (`banque-populaire.ts:112-116`), and returns the first that
 * normalises to a valid ISO date. The narrowing that refuses a date cell carrying two dates
 * (#366) is a narrowing of `normalizeDate`, not of this loop: a row whose `Date operation` is
 * now unreadable does not get refused here, it falls through and imports under
 * `Date de comptabilisation` instead. That fall-through is what the function is FOR — a real
 * Banque Populaire statement carries three genuinely different dates — but nothing else in this
 * suite proves it end to end through a real profile, so this file does.
 */
describe('a Banque Populaire row falls through to the next readable date column', () => {
	it('lands on Date de comptabilisation once Date operation is unreadable', () => {
		expect.assertions(3);

		// `Date operation` (11th field) carries a période range and is refused by the #366
		// narrowing. `Date de comptabilisation` (1st field) is a plain, valid date and is what
		// the row lands on. Measured, not assumed: this is the exact behaviour observed running
		// the loop, not a value chosen to make the test pass.
		const result = parseBanquePopulaireLine(
			'24/06/2026;LIBRAIRIE GIBERT;PAIEMENT CB LIBRAIRIE GIBERT;REF010;;Carte bancaire;Loisirs;Culture;15,90;;01/06/2026 au 30/06/2026;25/06/2026;0'
		);

		expect(result.invalidRows).toHaveLength(0);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].date).toBe('2026-06-24');
	});

	it('the control: lands on Date operation when it is readable', () => {
		expect.assertions(2);

		// Same row shape, `Date operation` now a plain valid date. It is the first candidate and
		// wins immediately, so `Date de comptabilisation`'s different date is never consulted.
		const result = parseBanquePopulaireLine(
			'24/06/2026;LIBRAIRIE GIBERT;PAIEMENT CB LIBRAIRIE GIBERT;REF011;;Carte bancaire;Loisirs;Culture;15,90;;23/06/2026;25/06/2026;0'
		);

		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].date).toBe('2026-06-23');
	});
});
