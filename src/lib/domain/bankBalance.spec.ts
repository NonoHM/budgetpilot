import { describe, expect, it } from 'vitest';
import { filterBalancesByCurrency, selectPreferredBalance } from './bankBalance';

describe('filterBalancesByCurrency', () => {
	it('keeps only candidates matching the account currency', () => {
		const candidates = [
			{ balanceType: 'CLBD', amountCents: 1000, currency: 'EUR' },
			{ balanceType: 'ITBD', amountCents: 2000, currency: 'USD' }
		];
		expect(filterBalancesByCurrency(candidates, 'EUR')).toEqual([
			{ balanceType: 'CLBD', amountCents: 1000, currency: 'EUR' }
		]);
	});

	it('drops every candidate when none matches the account currency', () => {
		const candidates = [{ balanceType: 'CLBD', amountCents: 1000, currency: 'USD' }];
		expect(filterBalancesByCurrency(candidates, 'EUR')).toEqual([]);
	});

	it('returns an empty array for an empty input', () => {
		expect(filterBalancesByCurrency([], 'EUR')).toEqual([]);
	});
});

describe('selectPreferredBalance', () => {
	it('returns null for an empty array', () => {
		expect(selectPreferredBalance([])).toBeNull();
	});

	it('picks CLBD over ITBD and XPCD when all three are present', () => {
		const candidates = [
			{ balanceType: 'XPCD', amountCents: 100, currency: 'EUR' },
			{ balanceType: 'ITBD', amountCents: 200, currency: 'EUR' },
			{ balanceType: 'CLBD', amountCents: 300, currency: 'EUR' }
		];
		expect(selectPreferredBalance(candidates)).toEqual({
			balanceType: 'CLBD',
			amountCents: 300,
			currency: 'EUR'
		});
	});

	it('picks ITBD over XPCD when CLBD is absent', () => {
		const candidates = [
			{ balanceType: 'XPCD', amountCents: 100, currency: 'EUR' },
			{ balanceType: 'ITBD', amountCents: 200, currency: 'EUR' }
		];
		expect(selectPreferredBalance(candidates)).toEqual({
			balanceType: 'ITBD',
			amountCents: 200,
			currency: 'EUR'
		});
	});

	it('picks XPCD when it is the only preferred type present', () => {
		const candidates = [
			{ balanceType: 'OTHR', amountCents: 50, currency: 'EUR' },
			{ balanceType: 'XPCD', amountCents: 100, currency: 'EUR' }
		];
		expect(selectPreferredBalance(candidates)).toEqual({
			balanceType: 'XPCD',
			amountCents: 100,
			currency: 'EUR'
		});
	});

	it('falls back to the first candidate when no preferred type is present', () => {
		const candidates = [
			{ balanceType: 'OTHR', amountCents: 50, currency: 'EUR' },
			{ balanceType: 'CLAV', amountCents: 75, currency: 'EUR' }
		];
		expect(selectPreferredBalance(candidates)).toEqual({
			balanceType: 'OTHR',
			amountCents: 50,
			currency: 'EUR'
		});
	});
});
