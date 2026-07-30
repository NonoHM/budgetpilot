import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcrypt';
import { error, redirect, type Cookies } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';
import type { Role } from '@prisma/client';

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

// Anti open-redirect: only accepts a clean relative path ("//" would be interpreted
// as a protocol-relative URL by the browser). Shared between /login and
// /login/verify-totp — do not duplicate, this decision is security-sensitive.
export function getSafeRedirect(value: string | null): string {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
	return value;
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

	return session.user;
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
