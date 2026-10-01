import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIRECT_BYPASSES } from '$lib/server/auth/redirectBypasses';

/**
 * Every way out of signing in, asked about every bypass in the shared corpus.
 *
 * `SIGN_IN_EXITS` is the registry: each entry drives a route handler exactly as SvelteKit would,
 * with the bypass in the query string, and returns the target the visitor is sent to next. The
 * structural half of "every exit goes through the one definition" is
 * `src/lib/server/security/redirect-param.spec.ts`, which fails when any other production file
 * names the parameter; this file is the behavioural half, and it fails when an exit that does go
 * through it is handed the wrong value or ignores the answer.
 */

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
});

const db = vi.hoisted(() => ({
	prisma: {
		user: { count: vi.fn(async () => 1), findUnique: vi.fn(), updateMany: vi.fn() },
		session: { create: vi.fn() },
		category: { findMany: vi.fn(), createMany: vi.fn() },
		categoryNatureMapping: { findMany: vi.fn(), createMany: vi.fn() },
		recoveryCode: { findMany: vi.fn(), updateMany: vi.fn() }
	}
}));

const rateLimit = vi.hoisted(() => ({
	isLoginRateLimited: vi.fn(async () => false),
	recordFailedLoginAttempt: vi.fn(async () => undefined),
	isMfaRateLimited: vi.fn(async () => false),
	recordMfaAttempt: vi.fn(async () => undefined)
}));

const mfaChallenge = vi.hoisted(() => ({
	createMfaChallenge: vi.fn(async () => undefined),
	readMfaChallenge: vi.fn(),
	consumeMfaChallenge: vi.fn(async () => undefined)
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/auth/rateLimit', () => rateLimit);
vi.mock('$lib/server/auth/mfaChallenge', () => mfaChallenge);

const { hashPassword } = await import('$lib/server/auth');
const { encryptTotpSecret, generateTotpSecretBase32 } = await import('$lib/server/auth/totp');
const OTPAuth = await import('otpauth');
const login = await import('./+page.server');
const verifyTotp = await import('./verify-totp/+page.server');

const PASSWORD = 'mot-de-passe-long';
const passwordHash = await hashPassword(PASSWORD);

type Handler = (event: Record<string, unknown>) => Promise<unknown>;

function urlWith(path: string, redirectTo: string): URL {
	const url = new URL(`http://localhost${path}`);
	url.searchParams.set('redirectTo', redirectTo);
	return url;
}

function postEvent(url: URL, fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		cookies: { set: vi.fn() },
		getClientAddress: () => '127.0.0.1',
		request: new Request(url, { method: 'POST', body }),
		url
	};
}

/** The `Location` a handler throws, or a failure naming what it did instead. */
async function locationOf(run: () => Promise<unknown>): Promise<string> {
	try {
		const returned = await run();
		throw new Error(`the handler returned instead of redirecting: ${JSON.stringify(returned)}`);
	} catch (thrown) {
		const location = (thrown as { location?: unknown }).location;
		if (typeof location !== 'string') throw thrown;
		return location;
	}
}

interface SignInExit {
	readonly name: string;
	/** Runs the exit with `redirectTo` in its query string; returns where the visitor goes next. */
	readonly target: (redirectTo: string) => Promise<string>;
}

const SIGN_IN_EXITS: readonly SignInExit[] = [
	{
		name: '/login load, for a visitor already signed in',
		target: (redirectTo) =>
			locationOf(() =>
				(login.load as unknown as Handler)({
					locals: { user: { id: 'user-a' } },
					url: urlWith('/login', redirectTo)
				})
			)
	},
	{
		name: '/login action, password only',
		target: (redirectTo) => {
			db.prisma.user.findUnique.mockResolvedValue({
				id: 'user-a',
				passwordHash,
				totpEnabled: false
			});
			return locationOf(() =>
				(login.actions.default as unknown as Handler)(
					postEvent(urlWith('/login', redirectTo), { email: 'a@example.test', password: PASSWORD })
				)
			);
		}
	},
	{
		name: '/login action, handing over to the second factor',
		target: async (redirectTo) => {
			db.prisma.user.findUnique.mockResolvedValue({
				id: 'user-a',
				passwordHash,
				totpEnabled: true
			});
			const location = await locationOf(() =>
				(login.actions.default as unknown as Handler)(
					postEvent(urlWith('/login', redirectTo), { email: 'a@example.test', password: PASSWORD })
				)
			);
			// The hand-over itself must stay on /login/verify-totp; what it carries is the target.
			const handedOver = new URL(location, 'http://localhost');
			expect(handedOver.pathname).toBe('/login/verify-totp');
			return handedOver.searchParams.get('redirectTo') ?? '<absent>';
		}
	},
	{
		name: '/login/verify-totp action',
		target: (redirectTo) => {
			const secret = generateTotpSecretBase32();
			const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
			mfaChallenge.readMfaChallenge.mockResolvedValue({ id: 'challenge-1', userId: 'user-a' });
			db.prisma.user.findUnique.mockResolvedValue({
				id: 'user-a',
				totpEnabled: true,
				totpSecretEncrypted: encryptTotpSecret(secret)
			});
			return locationOf(() =>
				(verifyTotp.actions.default as unknown as Handler)(
					postEvent(urlWith('/login/verify-totp', redirectTo), { code })
				)
			);
		}
	}
];

beforeEach(() => {
	db.prisma.user.updateMany.mockResolvedValue({ count: 0 });
	db.prisma.session.create.mockResolvedValue({ id: 'session-a' });
});

for (const exit of SIGN_IN_EXITS) {
	describe(exit.name, () => {
		for (const bypass of REDIRECT_BYPASSES) {
			it(`sends the visitor to / for ${bypass.name}`, async () => {
				expect(await exit.target(bypass.value)).toBe('/');
			});
		}

		// The positive control: an exit that ignored the parameter would pass every case above.
		it('sends the visitor to the internal path they asked for', async () => {
			expect(await exit.target('/transactions?period=2026-01')).toBe(
				'/transactions?period=2026-01'
			);
		});
	});
}
