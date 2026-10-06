import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';
import { error, redirect, type Cookies } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';
import { isTransientWriteConflict, withConcurrentWriteRetry } from '$lib/server/database/upsert';
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
	// `v5.0.0-7.2.4`, « terminates the current session token », at sign-in (#249). `/login`'s load
	// sends a signed-in visitor away, but its action never looks, so a POST from a browser that
	// still holds a live cookie would otherwise leave that session live for every copy of it.
	// Revoked BEFORE the new session is created, so a failure in between fails closed: the browser
	// is signed out and signs in again, rather than the old token surviving the sign-in.
	await revokeSessionToken(cookies.get(SESSION_COOKIE));

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

type TransactionClient = Parameters<Parameters<(typeof prisma)['$transaction']>[0]>[0];

/** Prisma's interactive-transaction budget, for a change that runs long (a restore). */
type TransactionOptions = { maxWait?: number; timeout?: number };

/** The session this request arrived on, as the hook resolved it and as the browser presented it. */
function liveSession(sessionId: string, presented: string) {
	return {
		id: sessionId,
		tokenHash: hashSessionToken(presented),
		revokedAt: null,
		expiresAt: { gt: new Date() }
	};
}

/** A session that ended before its change could commit: the request is sent to sign in. */
const sessionEnded = () => redirect(303, '/login');

/**
 * Commits a re-authenticated change TOGETHER with a new token for the session that made it
 * (`v5.0.0-7.2.4`, #249, R3 on #841). Every action in `REAUTH_FACTORS` that keeps its session writes
 * through this, and so does the forced password change: a copy of the cookie taken before the change
 * stops working when it commits, and the browser that made the request is handed the new token.
 *
 * THE ROW IS KEPT, ONLY ITS TOKEN CHANGES. Same id, so the per-session re-authentication counter
 * (#879), the session list and `/logout` keep their subject; same `expiresAt`, so rotating never
 * extends the absolute lifetime (`v5.0.0-7.3.2`), which the session-lifetime chantier rules on.
 *
 * THE ROTATION IS THE LAST STATEMENT OF THE CHANGE'S OWN TRANSACTION, a compare-and-set on the token
 * presented that refuses a row revoked or expired since the hook resolved it. So the change and the
 * new token commit together or not at all: a session revoked from another device, or logged out
 * from another tab, before the commit rolls the change back and is sent to sign in; one revoked
 * after it is revoked with its new token, since a revocation names the row; and two requests on one
 * cookie cannot both commit. Rotating any earlier, at the re-authentication, left the whole
 * of the action's work as a window in which a logout could not find the session (the contradiction
 * pass on #249). A re-authentication whose action is then refused changes nothing, the token included.
 *
 * A request the same browser sends with the old token while this response is in flight (another
 * tab, a hover preload) is served as signed out, and `handleAuth` leaves the cookie alone, so the
 * new one arrives intact whatever the order. What stays, both inside that one round trip and both
 * the owner racing themselves: a response that never reaches the browser (a native form submitted
 * twice, a proxy timing out a long restore) leaves it holding a token that no longer resolves, and
 * its owner signs in again; and a logout sent from another tab with the replaced token finds no
 * session, so it ends nothing. Closing either needs the previous token kept on the row. The busy
 * state that would prevent the double submit is #883's.
 */
export async function commitWithRotatedToken<T>(
	user: Pick<AuthUser, 'sessionId'>,
	cookies: Cookies,
	change: (tx: TransactionClient) => Promise<T>,
	options?: TransactionOptions
): Promise<T> {
	const presented = cookies.get(SESSION_COOKIE);
	if (!presented) throw sessionEnded();
	const token = createSessionToken();

	// Retried WHOLE when the engine aborts it: two sessions of one account revoking each other at
	// once lock the two rows in opposite orders, and PostgreSQL or MariaDB answers one side with a
	// deadlock. Run again, that side's compare-and-set sees the other's revocation and is sent to
	// sign in, which is the answer it should have had; without the retry it was a 500.
	const { result, expiresAt } = await withConcurrentWriteRetry(
		() => rotateWithin(user.sessionId, presented, token, change, options),
		isTransientWriteConflict
	);

	cookies.set(SESSION_COOKIE, token, getSessionCookieOptions(expiresAt));
	return result;
}

/** One attempt of `commitWithRotatedToken`: the change, then the compare-and-set, one transaction. */
function rotateWithin<T>(
	sessionId: string,
	presented: string,
	token: string,
	change: (tx: TransactionClient) => Promise<T>,
	options?: TransactionOptions
): Promise<{ result: T; expiresAt: Date }> {
	return prisma.$transaction(async (tx) => {
		const result = await change(tx);
		// The update is the ONLY place the session is judged live: a read ahead of it with the same
		// predicate would answer first in every test and leave this one unexercised (break B11).
		const { count } = await tx.session.updateMany({
			where: liveSession(sessionId, presented),
			data: { tokenHash: hashSessionToken(token) }
		});
		// Thrown inside the transaction, so the change above is rolled back with it.
		if (count !== 1) throw sessionEnded();
		// `expiresAt` has no writer after `createSession`: the value read here is the row's own.
		const { expiresAt } = await tx.session.findUniqueOrThrow({
			where: { id: sessionId },
			select: { expiresAt: true }
		});
		return { result, expiresAt };
	}, options);
}

/**
 * The same guarantee for the one re-authenticated change that ends its own session, deleting the
 * account: the session is claimed (revoked by the same compare-and-set) as the transaction's FIRST
 * statement, since the change itself deletes the row a later check would read. A session that ended
 * before the claim deletes nothing. The caller clears the cookie.
 */
export async function commitEndingSession<T>(
	user: Pick<AuthUser, 'sessionId'>,
	cookies: Cookies,
	change: (tx: TransactionClient) => Promise<T>
): Promise<T> {
	const presented = cookies.get(SESSION_COOKIE);
	if (!presented) throw sessionEnded();

	// Retried whole on an engine abort, for the reason `commitWithRotatedToken` gives.
	return withConcurrentWriteRetry(
		() =>
			prisma.$transaction(async (tx) => {
				const { count } = await tx.session.updateMany({
					where: liveSession(user.sessionId, presented),
					data: { revokedAt: new Date() }
				});
				if (count !== 1) throw sessionEnded();
				return change(tx);
			}),
		isTransientWriteConflict
	);
}

/**
 * Ends the session this request arrived on, by its ROW, which is what `/logout` means. By the row and
 * not by the token presented: a logout that started before a concurrent re-authentication committed
 * carries a token that no longer matches once it has, and a match on the token would then end
 * nothing while the other tab's response signed the browser back in (the contradiction pass on #249).
 */
export async function revokeSession(sessionId: string): Promise<void> {
	await prisma.session.updateMany({
		where: { id: sessionId, revokedAt: null },
		data: { revokedAt: new Date() }
	});
}

/**
 * Revokes every live session of the account except the one this request arrived on: « log out
 * other sessions », and every password change. Identified by the session's ID, never by comparing
 * token hashes: the request's own token is replaced in the same transaction, and a predicate written
 * against a token hash revokes the caller's own session the moment the two orders meet (measured on
 * #249, CONTEXT.md « Session, and its token »).
 */
export function revokeSessionsOtherThan(
	client: TransactionClient,
	user: Pick<AuthUser, 'id' | 'sessionId'>
) {
	return client.session.updateMany({
		where: { userId: user.id, revokedAt: null, id: { not: user.sessionId } },
		data: { revokedAt: new Date() }
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
