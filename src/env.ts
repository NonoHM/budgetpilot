import { defineEnvVars } from '@sveltejs/kit/env';
import { SETTINGS } from '$lib/server/env/settings';

/**
 * SvelteKit 3 puts into `$env/dynamic/private` (and `$app/env/private`) only the names this file
 * declares; an undeclared name reads undefined at runtime while the code still type-checks (#1336).
 * Declared from the registry, so `settingsDrift.spec.ts`, which fails on any by-name read the
 * registry does not list, keeps this file complete.
 *
 * The schema hands back what the environment holds, unset included, as SvelteKit 2 did: without one
 * a variable is required. Validation stays in the readers, which carry the refusals operators see.
 * `PUBLIC_` names are left out: SvelteKit 2 never put them in the private module either, and the
 * code reads `PUBLIC_INSTANCE` from `process.env`.
 */
export const variables = defineEnvVars(
	Object.fromEntries(
		Object.keys(SETTINGS)
			.filter((name) => !name.startsWith('PUBLIC_'))
			.map((name) => [name, { schema: (value: string | undefined) => value }])
	)
);
