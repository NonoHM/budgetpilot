import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { getRegistrationMode } from '$lib/server/auth/registration';

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
 * creation. It now fails at startup like its two siblings, via the same side-effect
 * import from hooks.server.ts.
 *
 * Scoped to admin_only on purpose: in "open" mode the token is genuinely unused, so
 * requiring it there would be noise.
 */
if (getRegistrationMode() === 'admin_only' && !env.BOOTSTRAP_TOKEN?.trim()) {
	throw new Error(
		'BOOTSTRAP_TOKEN is required when REGISTRATION_MODE=admin_only (the default): without it, every account creation is rejected as an invalid token. Set it in your environment (generate one with `openssl rand -base64 32`), or set REGISTRATION_MODE=open if you deliberately want self-service registration.'
	);
}

/**
 * Constant-time comparison of a submitted token against BOOTSTRAP_TOKEN.
 *
 * Kept a plain exported function (never inlined in the /register route) so it can be
 * tested in isolation, per the architecture posture on sensitive logic. The boot guard
 * above makes the empty-expected-value branch unreachable in admin_only mode, but it
 * stays as a defensive fail-closed for "open" mode and for direct unit calls.
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
