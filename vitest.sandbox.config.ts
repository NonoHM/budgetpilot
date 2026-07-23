import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Opt-in Enable Banking SANDBOX validation harness (bank-sync step 4c) — performs
 * REAL network calls to the provider using the credentials in .env. Deliberately a
 * separate config: the normal suite (npm run test:unit) never matches
 * *.sandbox-validation.ts and stays 100% offline.
 *
 * Run with: npm run test:sandbox
 */
export default defineConfig({
	resolve: {
		alias: { $lib: resolve(import.meta.dirname, 'src/lib') }
	},
	test: {
		environment: 'node',
		include: ['src/**/*.sandbox-validation.ts'],
		setupFiles: ['./vitest.sandbox.setup.ts'],
		// Real network + real ASPSP latency.
		testTimeout: 30_000,
		expect: { requireAssertions: true }
	}
});
