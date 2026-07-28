import { beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted(() => ({
	env: {
		BOOTSTRAP_TOKEN: undefined as string | undefined
	}
}));
const registration = vi.hoisted(() => ({
	getRegistrationMode: vi.fn<() => 'admin_only' | 'open'>()
}));

vi.mock('$env/dynamic/private', () => privateEnv);
vi.mock('$lib/server/auth/registration', () => registration);

/**
 * The boot guard runs at module load, so every case has to re-import the module
 * with a fresh registry (vi.resetModules) after setting the environment.
 */
async function loadModule() {
	vi.resetModules();
	return import('./bootstrapToken');
}

describe('boot guard BOOTSTRAP_TOKEN', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		privateEnv.env.BOOTSTRAP_TOKEN = undefined;
		registration.getRegistrationMode.mockReturnValue('admin_only');
	});

	it.each([undefined, '', '   ', '\t\n'])(
		'jette au chargement en mode admin_only quand le token est absent ou vide (%p)',
		async (value) => {
			expect.assertions(1);

			privateEnv.env.BOOTSTRAP_TOKEN = value;

			await expect(loadModule()).rejects.toThrow(/BOOTSTRAP_TOKEN is required/);
		}
	);

	it('se charge normalement en mode admin_only quand le token est renseigné', async () => {
		expect.assertions(1);

		privateEnv.env.BOOTSTRAP_TOKEN = 'un-token-de-bootstrap';

		await expect(loadModule()).resolves.toBeDefined();
	});

	it.each([undefined, ''])(
		'ne jette pas en mode open, où le token est réellement inutilisé (%p)',
		async (value) => {
			expect.assertions(1);

			registration.getRegistrationMode.mockReturnValue('open');
			privateEnv.env.BOOTSTRAP_TOKEN = value;

			await expect(loadModule()).resolves.toBeDefined();
		}
	);
});

describe('isBootstrapTokenValid', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registration.getRegistrationMode.mockReturnValue('admin_only');
		privateEnv.env.BOOTSTRAP_TOKEN = 'un-token-de-bootstrap';
	});

	it('accepte exactement le token attendu', async () => {
		expect.assertions(1);

		const { isBootstrapTokenValid } = await loadModule();

		expect(isBootstrapTokenValid('un-token-de-bootstrap')).toBe(true);
	});

	it.each([
		['un-token-de-bootstrap ', 'espace en fin'],
		['Un-Token-De-Bootstrap', 'casse différente'],
		['un-token-de-bootstra', 'plus court'],
		['un-token-de-bootstrapp', 'plus long'],
		['', 'chaîne vide']
	])('rejette une valeur qui ne correspond pas (%s, %s)', async (candidate) => {
		expect.assertions(1);

		const { isBootstrapTokenValid } = await loadModule();

		expect(isBootstrapTokenValid(candidate)).toBe(false);
	});

	it('fail-closed quand BOOTSTRAP_TOKEN est absent (cas atteignable en mode open)', async () => {
		expect.assertions(2);

		registration.getRegistrationMode.mockReturnValue('open');
		privateEnv.env.BOOTSTRAP_TOKEN = undefined;

		const { isBootstrapTokenValid } = await loadModule();

		expect(isBootstrapTokenValid('')).toBe(false);
		expect(isBootstrapTokenValid('nimporte-quoi')).toBe(false);
	});
});
