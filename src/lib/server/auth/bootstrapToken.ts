import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getRegistrationMode, isSelfRegistrationOpen } from '$lib/server/auth/registration';

/**
 * BOOTSTRAP_TOKEN gates /register while registration is closed (admin_only): the very
 * first account, and any account an admin creates afterwards without going through an
 * invitation link.
 *
 * Boot guard: a missing or blank token used to be SILENT — isBootstrapTokenValid()
 * returns false on an empty expected value, so every single registration was rejected as
 * "invalid token" with nothing in the logs and no crash, leaving the instance impossible
 * to bootstrap for a reason no message ever named. Unlike RATE_LIMIT_HASH_SECRET and
 * TOTP_ENCRYPTION_KEY, which crash loudly, this one just quietly bricked account
 * creation.
 *
 * It now fails at startup instead — but ONLY while the failure it describes is still
 * reachable, i.e. while the self-service bootstrap path is live and the blank token is
 * the only thing blocking it. Once the instance has been claimed, the same blank value
 * simply means "no new account can be created without an invitation link", which is a
 * legitimate way to run a finished single-user instance: crashing there would take a
 * working deployment offline over a variable it no longer needs. That case gets a warning
 * instead, so it stays visible without being fatal.
 *
 * The predicate is `isSelfRegistrationOpen()`, deliberately reused rather than
 * re-derived: it is already the definition of "the bootstrap path is still open"
 * (`open` mode, an empty user table, OR only the pre-auth BACKFILL user left to claim).
 * Counting ADMIN rows instead LOOKS equivalent and is not — the migration seeds the
 * backfill user with role ADMIN, so an un-claimed upgraded instance would have passed
 * an admin-count check while /register stayed locked behind the blank token, with the
 * backfill account unable to log in (its passwordHash is a sentinel) and therefore no
 * admin panel and no invitation link. That is the original silent-brick bug, in the one
 * state where it is unrecoverable.
 *
 * Scoped to admin_only on purpose: in "open" mode the token is genuinely unused, so
 * requiring it there would be noise.
 *
 * Called from hooks.server.ts's `init` hook rather than as an import side effect: it
 * needs the database, and module-level code also runs during SvelteKit's postbuild
 * analysis, where no database exists. `init` runs once per server start, before the
 * first request is served (adapter-node awaits it before listening, so the socket never
 * opens on a throw). Under `vite dev` SvelteKit swallows the rejection differently: it
 * turns every request into a 500 instead of a boot crash — still fail-closed, no route
 * is ever served in a degraded state.
 */
export async function assertBootstrapTokenConfigured(): Promise<void> {
	if (getRegistrationMode() !== 'admin_only') return;
	if (env.BOOTSTRAP_TOKEN?.trim()) return;

	if (!(await isSelfRegistrationOpen())) {
		console.warn(
			'[budgetpilot] BOOTSTRAP_TOKEN is empty while REGISTRATION_MODE=admin_only: no new account can be created except through an invitation link generated from the admin panel. Set a token if you want /register to work.'
		);
		return;
	}

	throw new Error(
		'BOOTSTRAP_TOKEN is required to create the first account when REGISTRATION_MODE=admin_only (the default): without it, every account creation is rejected as an invalid token and this instance cannot be bootstrapped. Set it in your environment (generate one with `openssl rand -base64 32`), or set REGISTRATION_MODE=open if you deliberately want self-service registration.'
	);
}

/**
 * Constant-time comparison of a submitted token against BOOTSTRAP_TOKEN.
 *
 * Kept a plain exported function (never inlined in the /register route) so it can be
 * tested in isolation, per the architecture posture on sensitive logic. The
 * empty-expected-value branch stays as a defensive fail-closed: the boot guard above
 * deliberately lets a blank token through once an admin exists, and "open" mode never
 * checks it at all.
 */
export function isBootstrapTokenValid(value: string): boolean {
	const expected = env.BOOTSTRAP_TOKEN;
	if (!expected || !value) return false;
	const expectedBuf = Buffer.from(expected);
	const valueBuf = Buffer.from(value);
	// timingSafeEqual requires buffers of the same length: we always compare against a
	// buffer of the expected length (the real token if the sizes match, otherwise a
	// dummy buffer) to never leak the length via an early short-circuit.
	const lengthsMatch = valueBuf.length === expectedBuf.length;
	const comparand = lengthsMatch ? valueBuf : Buffer.alloc(expectedBuf.length);
	return timingSafeEqual(expectedBuf, comparand) && lengthsMatch;
}
