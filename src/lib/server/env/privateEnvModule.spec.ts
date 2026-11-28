import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from './settings';

// SvelteKit 3 builds `$env/dynamic/private` from the names `src/env.ts` declares, and from nothing
// else: with no declaration the module is empty and every `env.NAME` reads undefined while the
// code still type-checks (#1336). Under SvelteKit 2 the module carried every variable the mode
// loaded. Separates: a module that hands the app the values `.env.test` sets, and one that hands
// it nothing, or hands it a name the registry does not declare.
const fileValues = new Map(
	readFileSync(new URL('../../../../.env.test', import.meta.url), 'utf8')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const)
);

describe('the private env module under SvelteKit 3', () => {
	it('reads every registered setting .env.test sets, at the value it sets', () => {
		// The PUBLIC_ prefix never reached the private module in SvelteKit 2 either; the code reads
		// PUBLIC_INSTANCE from process.env.
		const checked = [...fileValues].filter(
			([name]) => name in SETTINGS && !name.startsWith('PUBLIC_') && process.env[name] === undefined
		);
		// The figure the assertion stands on: without it an empty file passes.
		expect(checked.length).toBeGreaterThanOrEqual(8);
		expect(Object.fromEntries(checked.map(([name]) => [name, env[name]]))).toEqual(
			Object.fromEntries(checked)
		);
	});
});
