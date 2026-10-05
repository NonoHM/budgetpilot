import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';
import { error, redirect, type Cookies } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';
import type { Role } from './database/types.ts';

export const SESSION_COOKIE = 'budgetpilot_session';
export const BACKFILL_USER_ID = 'local-backfill-user';
export const BACKFILL_USER_EMAIL = 'local-backfill@budgetpilot.local';
const MIN_PASSWORD_COST = 12;
const MAX_PASSWORD_COST = 15;
const configuredPasswordCost = Number(process.env.PASSWORD_HASH_COST ?? MIN_PASSWORD_COST);
const PASSWORD_COST =
	Number.isInteger(configuredPasswordCost) && configuredPasswordCost >= MIN_PASSWORD_COST
		? Math.min(configuredPasswordCost, MAX_PASSWORD_COST)
		: MIN_PASSWORD_COST;
const DEFAULT_SESSION_TTL_DAYS = 30;
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
/** Printable ASCII only, no control characters. See validateNewEmail() for why. */
const ASCII_ONLY_PATTERN = /^[\x20-\x7e]+$/;

export interface AuthUser {
	id: string;
	email: string;
	role: Role;
	forcePasswordChange: boolean;
	/**
	 * The `Session` row this request was authenticated by, set only by `readSessionUser`. It is what
	 * the re-authentication counter is keyed by (#879), so it comes from the row the hook resolved
	 * and never from anything the client posts. Never sent to the page: `+layout.server.ts` picks
	 * its fields.
	 */
	sessionId: string;
}

export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

export function validateEmail(value: string): string | null {
	const email = normalizeEmail(value);
	if (!email || email.length > 254 || CONTROL_CHAR_PATTERN.test(email)) return null;
	if (!EMAIL_PATTERN.test(email)) return null;
	return email;
}

/**
 * Same as `validateEmail()`, plus an ASCII-only rule. For the paths that CREATE an identity
 * (registration, admin invitation), never for the login lookup.
 *
 * `User.email` is unique-indexed, and on MySQL/MariaDB that index is read through the table's
 * collation, `utf8mb4_unicode_ci`, which is accent-insensitive: "café@example.com" and
 * "cafe@example.com" are one value there and two on SQLite and PostgreSQL. Verified against the
 * generated MySQL schema, where inserting the second raises a duplicate key error on
 * `User_email_key`. So which addresses count as the same account would be decided by the
 * database engine, which is the exact defect this whole multi-provider effort removes
 * everywhere else (see server/naming/nameKey.ts).
 *
 * `normalizeEmail()` already folds ASCII case, and a trim removes the trailing-space
 * difference, so restricting the rest to ASCII leaves no pair of distinct valid addresses that
 * any of the three collations can fold together. Addresses outside ASCII need SMTPUTF8
 * (RFC 6531), which this app does not implement.
 *
 * Deliberately NOT applied to login: an account registered with a non-ASCII address before this
 * rule existed must keep signing in, and locking the only user out of a self-hosted finance app
 * is worse than the narrow divergence that remains for such an install.
 */
export function validateNewEmail(value: string): string | null {
	const email = validateEmail(value);
	if (email === null || !ASCII_ONLY_PATTERN.test(email)) return null;
	return email;
}

/**
 * True when an address is a perfectly well-formed email that only the ASCII rule above rejects.
 *
 * Lets the two identity-creating routes say which rule was broken. "Email invalide" is accurate
 * but useless in front of an address that looks entirely normal to whoever typed it, and it is
 * the exact message an invitee sees when their invitation predates the ASCII rule and names a
 * non-ASCII address: unusable, with nothing pointing at the fix (the admin reissuing it).
 *
 * Safe to surface, and that is worth stating: the answer depends only on the string submitted,
 * never on what the database holds, so it cannot tell a caller whether an account exists.
 */
export function isNonAsciiEmail(value: string): boolean {
	return validateEmail(value) !== null && validateNewEmail(value) === null;
}

export function validatePassword(value: string): boolean {
	return value.length >= 12 && value.length <= 256;
}

// 16 random bytes -> ~22 base64url characters, comfortably above
// validatePassword()'s minimum: any size reduction must stay covered
// by the test that checks generateTemporaryPassword() via validatePassword().
export function generateTemporaryPassword(): string {
	return randomBytes(16).toString('base64url');
}

export async function hashPassword(password: string): Promise<string> {
	return bcrypt.hash(password, PASSWORD_COST);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
	return bcrypt.compare(password, passwordHash);
}

// Dummy hash used when the account doesn't exist, so the login flow takes
// a comparable response time whether an email exists or not (anti account enumeration).
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-safe-placeholder-password', PASSWORD_COST);

export async function verifyPasswordTimingSafe(
	password: string,
	passwordHash: string | undefined
): Promise<boolean> {
	return bcrypt.compare(password, passwordHash ?? DUMMY_PASSWORD_HASH);
}

export function hashSessionToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function createSessionToken(): string {
	return randomBytes(32).toString('base64url');
}

export function getSessionExpiresAt(): Date {
	const ttlDays = Number(process.env.SESSION_TTL_DAYS ?? DEFAULT_SESSION_TTL_DAYS);
	const safeTtlDays = Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : DEFAULT_SESSION_TTL_DAYS;
	return new Date(Date.now() + safeTtlDays * 24 * 60 * 60 * 1000);
}

// PUBLIC_INSTANCE is the ONE switch governing the Secure cookie flag, and it is
// fail-secure: anything other than an explicit "false" (unset, empty, "true", a typo)
// yields Secure cookies. Only a deliberate PUBLIC_INSTANCE=false drops the flag, which
// is what a LAN-only instance served over plain http:// needs — browsers reject a Secure
// cookie on http://192.168.x.x, so forcing it there makes login structurally impossible.
//
// NODE_ENV is deliberately NOT consulted: every Docker install runs with
// NODE_ENV=production, so keying off it forced Secure cookies on LAN deployments that
// cannot use them, with no way to opt out. The security posture describes PUBLIC_INSTANCE
// as the mechanism — this is that, and nothing else.
//
// process.env is read directly on purpose (rather than $env/dynamic/private, which would
// force every caller and every test off process.env). `vite dev` doesn't populate
// process.env from .env by itself, so vite.config.ts copies the loaded values across in
// development — see the comment there. Without that, a .env-only PUBLIC_INSTANCE=false
// was invisible in local dev while working under Docker.
export function areSecureCookiesEnabled(): boolean {
	return process.env.PUBLIC_INSTANCE !== 'false';
}

export function getSessionCookieOptions(expires: Date) {
	return {
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: areSecureCookiesEnabled(),
		path: '/',
		expires
	};
}

export async function createSession(userId: string, cookies: Cookies): Promise<void> {
	const token = createSessionToken();
	const expiresAt = getSessionExpiresAt();

	await prisma.session.create({
		data: {
			userId,
			tokenHash: hashSessionToken(token),
			expiresAt
		}
	});

	cookies.set(SESSION_COOKIE, token, getSessionCookieOptions(expiresAt));
}

/**
 * The query parameter carrying where a visitor goes once signed in. The three functions below are
 * its only reader and writers, so a route cannot redirect to it without the check;
 * `src/lib/server/security/redirect-param.spec.ts` fails when any other production line names it,
 * one comment quoting a measured response excepted.
 */
const REDIRECT_PARAM = 'redirectTo';

/** Where a sign-in with no usable target lands. */
const SAFE_DEFAULT = '/';

/** Clause 1. One leading slash and never two, then visible ASCII only: refuses absolute URLs,
 * `//host`, schemes with or without slashes, whitespace, control characters and non-ASCII. */
const SINGLE_SLASH_VISIBLE_ASCII = /^\/(?!\/)[\x21-\x7e]*$/;

/** Clause 2. A browser's URL parser reads a backslash as a slash, so `/\host` is `//host`. Read
 * over the whole value, query included: a target whose query carries a raw backslash, which the
 * parser leaves unencoded there, is refused, and that visitor lands on `/`. A loss accepted so that
 * the clause stays one test. */
const BACKSLASH = /\\/;

/** Clause 3. A dot segment, `%2e` included: resolved, `/.//host` collapses to `//host`. No producer
 * here emits one, since the paths it carries were already resolved by the parser. */
const DOT_SEGMENT = /\/(?:\.|%2e){1,2}(?=\/|$)/i;

/** Clause 4. An encoded slash or backslash. No route here has one in its path, and a decoder
 * downstream could turn either back into a separator. */
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

/** Clause 5. The path decodes. SvelteKit decodes every request path with `decodeURI` and answers
 * 400 to one that fails (`/%`, `/%zz`, an escape that is not UTF-8), so a target that does not
 * decode lands on an error page rather than on the default. */
function decoded(path: string): string | null {
	try {
		// The decoded value is RETURNED to the caller, never discarded. The production bundler treats
		// `decodeURI` as free of side effects and deleted a bare `decodeURI(path);` from this block,
		// so the build kept every undecodable path while vitest, which runs the source, refused it.
		// Measured 2026-10-01 (#842); `e2e/redirect-target.spec.ts` reads the build and sees it. No
		// predicate on the result either: a second "starts with /" here hid clause 1 from its break.
		return decodeURI(path);
	} catch {
		return null;
	}
}

/**
 * Anti open-redirect (CWE-601): returns `value` unchanged when it is an internal path, and `/`
 * otherwise. Never rewrites: a value is either sent as given or refused.
 *
 * Plain string clauses rather than a URL parser, so that `safeRedirect.spec.ts` can use the WHATWG
 * parser as an oracle that shares nothing with the rule it judges. Clauses 3, 4 and 5 read the
 * path only: the query of a legitimate target can carry `%2F` or `/../` as data.
 */
export function getSafeRedirect(value: string | null): string {
	if (!value || !SINGLE_SLASH_VISIBLE_ASCII.test(value)) return SAFE_DEFAULT;
	if (BACKSLASH.test(value)) return SAFE_DEFAULT;
	const path = value.split(/[?#]/, 1)[0];
	if (DOT_SEGMENT.test(path)) return SAFE_DEFAULT;
	if (ENCODED_SEPARATOR.test(path)) return SAFE_DEFAULT;
	if (decoded(path) === null) return SAFE_DEFAULT;
	return value;
}

/** Sends a visitor who has just signed in, or already was, to the target they asked for if safe. */
export function redirectAfterSignIn(url: URL): never {
	throw redirect(303, getSafeRedirect(url.searchParams.get(REDIRECT_PARAM)));
}

/** `/login`, remembering the page a signed-out visitor asked for. */
export function signInUrl(requested: URL): string {
	return `/login?${REDIRECT_PARAM}=${encodeURIComponent(requested.pathname + requested.search)}`;
}

/** The second-factor step, carrying the target forward already checked. */
export function secondFactorUrl(url: URL): string {
	const target = getSafeRedirect(url.searchParams.get(REDIRECT_PARAM));
	return `/login/verify-totp?${new URLSearchParams({ [REDIRECT_PARAM]: target })}`;
}

export function requireUser(user: AuthUser | null): AuthUser {
	if (!user) throw redirect(303, '/login');
	return user;
}

export function requireAdmin(user: AuthUser | null): AuthUser {
	const authUser = requireUser(user);
	if (authUser.role !== 'ADMIN') throw error(403, m.admin_error_forbidden());
	return authUser;
}

export async function readSessionUser(token: string | undefined): Promise<AuthUser | null> {
	if (!token) return null;

	const tokenHash = hashSessionToken(token);
	const session = await prisma.session.findUnique({
		where: { tokenHash },
		select: {
			id: true,
			tokenHash: true,
			expiresAt: true,
			revokedAt: true,
			user: {
				select: {
					id: true,
					email: true,
					role: true,
					forcePasswordChange: true
				}
			}
		}
	});
	if (!session || session.revokedAt || session.expiresAt <= new Date()) return null;
	if (!safeEqual(tokenHash, session.tokenHash)) return null;

	return { ...session.user, sessionId: session.id };
}

export async function revokeSessionToken(token: string | undefined): Promise<void> {
	if (!token) return;
	await prisma.session.updateMany({
		where: {
			tokenHash: hashSessionToken(token),
			revokedAt: null
		},
		data: {
			revokedAt: new Date()
		}
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
