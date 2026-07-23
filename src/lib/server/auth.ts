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
	if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
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

// PUBLIC_INSTANCE=true forces the Secure cookie flag independently of NODE_ENV: an
// explicit mechanism for an instance genuinely exposed on the Internet (requires HTTPS),
// rather than relying on a NODE_ENV that could be misconfigured in deployment.
export function areSecureCookiesEnabled(): boolean {
	return process.env.PUBLIC_INSTANCE === 'true' || process.env.NODE_ENV === 'production';
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
