import { describe, expect, it } from 'vitest';
import { EnableBankingConnector } from './enablebanking';
import { MockBankConnector } from './mock';
import { getBankConnector } from './registry';

describe('getBankConnector', () => {
	it('résout le connecteur mock via son identifiant', () => {
		const connector = getBankConnector('mock');
		expect(connector).toBeInstanceOf(MockBankConnector);
		expect(connector?.id).toBe('mock');
	});

	it('résout le connecteur enablebanking via son identifiant', () => {
		const connector = getBankConnector('enablebanking');
		expect(connector).toBeInstanceOf(EnableBankingConnector);
		expect(connector?.id).toBe('enablebanking');
	});

	it('retourne null pour un identifiant de provider inconnu', () => {
		expect(getBankConnector('unknown-provider')).toBeNull();
	});

	it('retourne null pour une chaîne vide', () => {
		expect(getBankConnector('')).toBeNull();
	});
});

describe('EnableBankingConnector (registry resolution)', () => {
	const connector = new EnableBankingConnector();

	it('expose un id et un displayName stables', () => {
		expect(connector.id).toBe('enablebanking');
		expect(connector.displayName).toBe('Enable Banking');
	});
});
