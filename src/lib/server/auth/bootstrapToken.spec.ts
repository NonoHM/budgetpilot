import { beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted(() => ({
	env: {
		BOOTSTRAP_TOKEN: undefined as string | undefined
	}
}));
const registration = vi.hoisted(() => ({
	getRegistrationMode: vi.fn<() => 'admin_only' | 'open'>(),
	isSelfRegistrationOpen: vi.fn<() => Promise<boolean>>()
}));

vi.mock('$env/dynamic/private', () => privateEnv);
vi.mock('$lib/server/auth/registration', () => registration);

const { assertBootstrapTokenConfigured, isBootstrapTokenValid } = await import('./bootstrapToken');

describe('assertBootstrapTokenConfigured', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		privateEnv.env.BOOTSTRAP_TOKEN = undefined;
		registration.getRegistrationMode.mockReturnValue('admin_only');
		// Bootstrap path still open (empty database, or only the BACKFILL user left to
		// claim). Which states that covers is registration.spec.ts's job, not this one's:
		// the point here is that the guard asks THAT question and never re-derives it —
		// an ADMIN-row count would wrongly report the un-claimed BACKFILL instance as
		// bootstrapped, since the migration seeds that user with role ADMIN.
		registration.isSelfRegistrationOpen.mockResolvedValue(true);
	});

	it.each([undefined, '', '   ', '\t\n'])(
		'jette quand le bootstrap est encore possible et que le token est absent ou vide (%p)',
		async (value) => {
			expect.assertions(1);

			privateEnv.env.BOOTSTRAP_TOKEN = value;

			await expect(assertBootstrapTokenConfigured()).rejects.toThrow(
				/BOOTSTRAP_TOKEN is required to create the first account/
			);
		}
	);

	it("ne jette pas quand l'instance est déjà bootstrappée : elle reste démarrable", async () => {
		expect.assertions(2);

		registration.isSelfRegistrationOpen.mockResolvedValue(false);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		try {
			await expect(assertBootstrapTokenConfigured()).resolves.toBeUndefined();
			// Non fatal, mais jamais silencieux : plus aucune inscription n'est possible
			// sans lien d'invitation, l'opérateur doit pouvoir le voir.
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it('ne jette pas et ne touche pas la base quand le token est renseigné', async () => {
		expect.assertions(2);

		privateEnv.env.BOOTSTRAP_TOKEN = 'un-token-de-bootstrap';

		await expect(assertBootstrapTokenConfigured()).resolves.toBeUndefined();
		expect(registration.isSelfRegistrationOpen).not.toHaveBeenCalled();
	});

	it.each([undefined, ''])(
		'ne jette pas en mode open, où le token est réellement inutilisé (%p), sans requête base',
		async (value) => {
			expect.assertions(2);

			registration.getRegistrationMode.mockReturnValue('open');
			privateEnv.env.BOOTSTRAP_TOKEN = value;

			await expect(assertBootstrapTokenConfigured()).resolves.toBeUndefined();
			expect(registration.isSelfRegistrationOpen).not.toHaveBeenCalled();
		}
	);
});

describe('isBootstrapTokenValid', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registration.getRegistrationMode.mockReturnValue('admin_only');
		privateEnv.env.BOOTSTRAP_TOKEN = 'un-token-de-bootstrap';
	});

	it('accepte exactement le token attendu', () => {
		expect.assertions(1);

		expect(isBootstrapTokenValid('un-token-de-bootstrap')).toBe(true);
	});

	it.each([
		['un-token-de-bootstrap ', 'espace en fin'],
		['Un-Token-De-Bootstrap', 'casse différente'],
		['un-token-de-bootstra', 'plus court'],
		['un-token-de-bootstrapp', 'plus long'],
		['', 'chaîne vide']
	])('rejette une valeur qui ne correspond pas (%s, %s)', (candidate) => {
		expect.assertions(1);

		expect(isBootstrapTokenValid(candidate)).toBe(false);
	});

	it('fail-closed quand BOOTSTRAP_TOKEN est absent', () => {
		expect.assertions(2);

		privateEnv.env.BOOTSTRAP_TOKEN = undefined;

		expect(isBootstrapTokenValid('')).toBe(false);
		expect(isBootstrapTokenValid('nimporte-quoi')).toBe(false);
	});
});
