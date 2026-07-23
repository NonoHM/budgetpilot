import { describe, expect, it } from 'vitest';
import { getBankProviderBaseUrl, getBankSyncRedirectUrl, isBankSyncEnabled } from './config';

describe('isBankSyncEnabled', () => {
	it('est désactivé par défaut (fail-safe) quand la variable est absente', () => {
		expect(isBankSyncEnabled({})).toBe(false);
	});

	it('est désactivé quand la variable vaut "false"', () => {
		expect(isBankSyncEnabled({ BANK_SYNC_ENABLED: 'false' })).toBe(false);
	});

	it('est désactivé pour une valeur mal cassée ("TRUE" en majuscules)', () => {
		expect(isBankSyncEnabled({ BANK_SYNC_ENABLED: 'TRUE' })).toBe(false);
	});

	it('est activé uniquement pour la valeur exacte "true"', () => {
		expect(isBankSyncEnabled({ BANK_SYNC_ENABLED: 'true' })).toBe(true);
	});
});

describe('getBankProviderBaseUrl', () => {
	it('accepte l’hôte par défaut (api.enablebanking.com) en https', () => {
		expect(getBankProviderBaseUrl('https://api.enablebanking.com', {})).toBe(
			'https://api.enablebanking.com'
		);
	});

	it('rejette l’hôte par défaut en http (jamais de carve-out http pour la banque)', () => {
		expect(getBankProviderBaseUrl('http://api.enablebanking.com', {})).toBeNull();
	});

	it('rejette un hôte non whitelisté', () => {
		expect(getBankProviderBaseUrl('https://evil.example', {})).toBeNull();
	});

	it('rejette localhost/127.0.0.1 quand ils ne sont pas explicitement listés', () => {
		expect(getBankProviderBaseUrl('https://127.0.0.1', {})).toBeNull();
		expect(getBankProviderBaseUrl('https://localhost', {})).toBeNull();
	});

	it('BANK_SYNC_ALLOWED_HOSTS remplace la liste par défaut (ne l’étend pas)', () => {
		const env = { BANK_SYNC_ALLOWED_HOSTS: 'custom-provider.example' };

		expect(getBankProviderBaseUrl('https://custom-provider.example', env)).toBe(
			'https://custom-provider.example'
		);
		// The default host is no longer allowed once the override is set.
		expect(getBankProviderBaseUrl('https://api.enablebanking.com', env)).toBeNull();
	});

	it('accepte plusieurs hôtes listés dans BANK_SYNC_ALLOWED_HOSTS', () => {
		const env = { BANK_SYNC_ALLOWED_HOSTS: 'a.example, b.example' };

		expect(getBankProviderBaseUrl('https://a.example', env)).toBe('https://a.example');
		expect(getBankProviderBaseUrl('https://b.example', env)).toBe('https://b.example');
	});

	it('retourne null pour une URL invalide', () => {
		expect(getBankProviderBaseUrl('pas-une-url', {})).toBeNull();
	});

	it('normalise un slash final dans le chemin', () => {
		expect(getBankProviderBaseUrl('https://api.enablebanking.com/', {})).toBe(
			'https://api.enablebanking.com'
		);
	});

	it('supprime la query string', () => {
		expect(getBankProviderBaseUrl('https://api.enablebanking.com?token=secret', {})).toBe(
			'https://api.enablebanking.com'
		);
	});

	it('supprime le hash', () => {
		expect(getBankProviderBaseUrl('https://api.enablebanking.com#fragment', {})).toBe(
			'https://api.enablebanking.com'
		);
	});

	it('supprime slash final, query et hash combinés', () => {
		expect(getBankProviderBaseUrl('https://api.enablebanking.com/path/?a=1#frag', {})).toBe(
			'https://api.enablebanking.com/path'
		);
	});
});

describe('getBankSyncRedirectUrl', () => {
	it('retourne null (fail-safe) quand BANK_SYNC_REDIRECT_ALLOWED_ORIGINS est absent', () => {
		expect(getBankSyncRedirectUrl('http://localhost:5173', {})).toBeNull();
	});

	it('retourne null pour une origine non whitelistée', () => {
		const env = { BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: 'http://localhost:5173' };
		expect(getBankSyncRedirectUrl('https://evil.example', env)).toBeNull();
	});

	it('retourne origin + le chemin de callback pour une origine exactement whitelistée', () => {
		const env = { BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: 'http://localhost:5173' };
		expect(getBankSyncRedirectUrl('http://localhost:5173', env)).toBe(
			'http://localhost:5173/imports/bank-connections/callback'
		);
	});

	it('tolère un slash final dans l’entrée de la liste (normalisation)', () => {
		const env = { BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: 'http://localhost:5173/' };
		expect(getBankSyncRedirectUrl('http://localhost:5173', env)).toBe(
			'http://localhost:5173/imports/bank-connections/callback'
		);
	});

	it('accepte plusieurs origines listées séparées par des virgules', () => {
		const env = {
			BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: 'http://localhost:5173, https://budget.example.com'
		};
		expect(getBankSyncRedirectUrl('https://budget.example.com', env)).toBe(
			'https://budget.example.com/imports/bank-connections/callback'
		);
	});

	it('rejette un schéma non http(s) (ex: javascript:)', () => {
		const env = { BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: 'javascript:alert(1)' };
		expect(getBankSyncRedirectUrl('javascript:alert(1)', env)).toBeNull();
	});

	it('rejette une origine dont seul le port diffère de l’entrée whitelistée', () => {
		const env = { BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: 'http://localhost:5173' };
		expect(getBankSyncRedirectUrl('http://localhost:9999', env)).toBeNull();
	});

	it('retourne null pour une origine malformée', () => {
		const env = { BANK_SYNC_REDIRECT_ALLOWED_ORIGINS: 'http://localhost:5173' };
		expect(getBankSyncRedirectUrl('not-a-url', env)).toBeNull();
	});
});
