import { EnableBankingConnector } from './enablebanking';
import { MockBankConnector } from './mock';
import type { BankConnector } from './types';

/**
 * Connector lookup by BankConnection.provider. Mirrors the CSV profile registry's
 * pattern (import/registry.ts): one place resolving an identifier to an implementation.
 *
 * `env` must be threaded from the caller (the sync service resolves it from the route's
 * `$env/dynamic/private`): under `vite dev` the .env file never reaches process.env, so
 * a connector built without an explicit env would see bank sync as unconfigured in dev.
 */
export function getBankConnector(
	provider: string,
	options: { env?: NodeJS.ProcessEnv } = {}
): BankConnector | null {
	switch (provider) {
		case 'enablebanking':
			return new EnableBankingConnector({ env: options.env });
		case 'mock':
			return new MockBankConnector();
		default:
			return null;
	}
}
