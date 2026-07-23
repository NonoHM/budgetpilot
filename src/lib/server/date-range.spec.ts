import { describe, expect, it } from 'vitest';
import { parseDateRange } from './date-range';

const now = new Date('2026-06-25T10:00:00.000Z');

describe('parseDateRange', () => {
	it('retourne le mois courant par défaut', () => {
		expect.assertions(4);

		const range = parseDateRange(new URLSearchParams(), now);

		expect(range.key).toBe('this-month');
		expect(range.from).toEqual(new Date('2026-06-01T00:00:00.000Z'));
		expect(range.to).toEqual(new Date('2026-07-01T00:00:00.000Z'));
		expect(range.budgetMonth).toBe('2026-06');
	});

	it('retourne le mois dernier', () => {
		expect.assertions(3);

		const range = parseDateRange(new URLSearchParams('period=last-month'), now);

		expect(range.key).toBe('last-month');
		expect(range.fromDate).toBe('2026-05-01');
		expect(range.toDate).toBe('2026-05-31');
	});

	it('inclut les 30 derniers jours avec une borne haute exclusive', () => {
		expect.assertions(3);

		const range = parseDateRange(new URLSearchParams('period=last-30-days'), now);

		expect(range.from).toEqual(new Date('2026-05-27T00:00:00.000Z'));
		expect(range.to).toEqual(new Date('2026-06-26T00:00:00.000Z'));
		expect(range.label).toBe('30 derniers jours');
	});

	it('retourne une période all-time sans borne basse effective', () => {
		expect.assertions(5);

		const range = parseDateRange(new URLSearchParams('period=all-time'), now);

		expect(range.key).toBe('all-time');
		expect(range.from).toEqual(new Date(0));
		expect(range.to).toEqual(new Date('2026-06-26T00:00:00.000Z'));
		expect(range.label).toBe('Toujours');
		// Never a whole calendar month → the budget summary stays unavailable downstream.
		expect(range.comparisonMonth).toBeUndefined();
	});

	it("all-time n'a pas de borne de durée", () => {
		expect.assertions(1);

		const range = parseDateRange(new URLSearchParams('period=all-time'), now);
		const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;

		expect(days).toBeGreaterThan(731);
	});

	it('accepte une période personnalisée de plus de 731 jours (aucun plafond)', () => {
		expect.assertions(1);

		const range = parseDateRange(
			new URLSearchParams('period=custom&from=2020-01-01&to=2026-06-10'),
			now
		);

		expect(range.key).toBe('custom');
	});

	it('valide une période personnalisée', () => {
		expect.assertions(4);

		const range = parseDateRange(
			new URLSearchParams('period=custom&from=2026-05-20&to=2026-06-10'),
			now
		);

		expect(range.key).toBe('custom');
		expect(range.from).toEqual(new Date('2026-05-20T00:00:00.000Z'));
		expect(range.to).toEqual(new Date('2026-06-11T00:00:00.000Z'));
		expect(range.budgetMonth).toBe('2026-05');
	});

	it('refuse une période personnalisée invalide (from après to)', () => {
		expect.assertions(1);

		expect(() =>
			parseDateRange(new URLSearchParams('period=custom&from=2026-06-10&to=2026-06-01'), now)
		).toThrow();
	});
});
