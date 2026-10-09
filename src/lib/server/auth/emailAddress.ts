// The stored form of an email and the check sign-in applies before looking one up. Their own module
// with no imports, so `scripts/log-pseudonym.mjs` finds an account from an email the way sign-in
// does rather than through a copy of the rule (#942). Re-exported by `auth.ts`.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * C0 and C7 control characters, rejected on every path including the login lookup.
 *
 * EMAIL_PATTERN's `[^\s@]` excludes whitespace but not NUL or the other control characters, so
 * "a\x00b@example.com" used to reach `prisma.user.findUnique`. PostgreSQL rejects a NUL inside a
 * text parameter at the protocol level, which turned a would-be "invalid credentials" into an
 * unhandled 500: an unauthenticated caller could tell the providers apart by it, and the throw
 * skipped the failed-attempt record that feeds the rate limiter. No legitimately registered
 * address can contain one, so rejecting them locks nobody out.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point here
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

/** The stored form: what sign-in and registration look an account up by. */
export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

export function validateEmail(value: string): string | null {
	const email = normalizeEmail(value);
	if (!email || email.length > 254 || CONTROL_CHAR_PATTERN.test(email)) return null;
	if (!EMAIL_PATTERN.test(email)) return null;
	return email;
}
