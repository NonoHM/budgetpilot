import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';
import * as m from '../src/lib/paraglide/messages';
import { E2E_ENV } from './config';
import { expect, test } from './fixtures';
import { expectPrimaryUnobstructed } from './screen-geometry';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from './seed';

/**
 * The inactivity timeout as a visitor meets it (#221): a session unused for longer than
 * `BP_SESSION_IDLE_TIMEOUT_HOURS` ends, and the sign-in page says why rather than appearing with no
 * reason. Journey: sign in, use the app, go quiet past the timeout, come back.
 *
 * THE SESSION IS THIS TEST'S OWN. It signs in through the form on an empty context, and the row it
 * ages is found by the hash of the cookie the browser holds, so the suite's shared session is never
 * touched. The row is aged in the database the build reads, every date by the same amount and in
 * the text format the application writes (`2026-10-07T12:34:56.789+00:00`), rather than the clock
 * moved.
 *
 * Separates « the session ended for inactivity and the page says so » from « the session ended and
 * the page is silent » (the notice removed) and from « the session never ended » (the `expiresAt`
 * clause removed: the visitor stays on `/`).
 */

const SESSION_DB = 'e2e/.data/test.db';
// `SESSION_COOKIE` in `auth.ts`, which this node process cannot import (it opens Prisma). A rename
// fails loudly here: `ageOwnSession` throws rather than aging nothing.
const SESSION_COOKIE = 'budgetpilot_session';
// The e2e server's own timeout, from `.env.test`, which sets it below the 1-day lifetime there.
const IDLE_HOURS = Number(E2E_ENV.BP_SESSION_IDLE_TIMEOUT_HOURS);
if (!(IDLE_HOURS > 0))
	throw new Error('.env.test must set BP_SESSION_IDLE_TIMEOUT_HOURS for this spec');

async function signIn(page: Page): Promise<void> {
	await page.goto('/login');
	await page.getByLabel(m.login_email_label()).fill(E2E_USER_EMAIL);
	await page
		.getByRole('textbox', { name: m.login_password_label(), exact: false })
		.fill(E2E_USER_PASSWORD);
	await page.getByRole('button', { name: m.login_submit() }).click();
	await expect(page).not.toHaveURL(/\/login/);
}

/** The hash the `Session` row stores for the cookie this browser holds. */
async function ownTokenHash(page: Page): Promise<string> {
	const cookie = (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE);
	if (!cookie) throw new Error('ownTokenHash: the browser holds no session cookie');
	return createHash('sha256').update(cookie.value).digest('hex');
}

/** Whether the row with this token hash has been revoked; throws when there is no such row. */
function isRevoked(tokenHash: string): boolean {
	const db = new DatabaseSync(SESSION_DB, { readOnly: true });
	try {
		const row = db
			.prepare('SELECT "revokedAt" AS revokedAt FROM "Session" WHERE "tokenHash" = ?')
			.get(tokenHash) as { revokedAt: string | null } | undefined;
		if (!row) throw new Error('isRevoked: no session row carries this token hash');
		return row.revokedAt !== null;
	} finally {
		db.close();
	}
}

/** Moves the clock `hours` forward for the browser's own session; returns the rows changed. */
async function ageOwnSession(page: Page, hours: number): Promise<number> {
	const tokenHash = await ownTokenHash(page);
	const db = new DatabaseSync(SESSION_DB);
	try {
		const row = db
			.prepare(
				'SELECT "createdAt" AS c, "lastSeenAt" AS l, "expiresAt" AS e FROM "Session" WHERE "tokenHash" = ?'
			)
			.get(tokenHash) as { c: string; l: string; e: string } | undefined;
		if (!row) throw new Error('ageOwnSession: no session row carries this token hash');
		// Every date moves back by the same amount: the clock moving forward with no use.
		const back = (stored: string) =>
			new Date(new Date(stored).getTime() - hours * 3_600_000).toISOString().replace('Z', '+00:00');
		return Number(
			db
				.prepare(
					'UPDATE "Session" SET "createdAt" = ?, "lastSeenAt" = ?, "expiresAt" = ? WHERE "tokenHash" = ?'
				)
				.run(back(row.c), back(row.l), back(row.e), tokenHash).changes
		);
	} finally {
		db.close();
	}
}

test.use({ storageState: { cookies: [], origins: [] } });

for (const viewport of [
	{ width: 390, height: 844 },
	{ width: 1280, height: 800 }
]) {
	test(`a session unused past the timeout lands on sign-in with the reason (${viewport.width})`, async ({
		page
	}) => {
		await page.setViewportSize(viewport);
		await signIn(page);

		const sentence = m.login_notice_signed_out_idle();

		// Just inside the timeout the session still works, so the redirect below is the timeout's.
		expect(await ageOwnSession(page, IDLE_HOURS - 1)).toBe(1);
		await page.goto('/');
		await expect(page).toHaveURL(/\/$/);

		expect(await ageOwnSession(page, IDLE_HOURS + 1)).toBe(1);
		await page.goto('/');
		await expect(page).toHaveURL(/\/login/);
		await expect(page.getByRole('status').filter({ hasText: sentence })).toHaveText(sentence);
		await expectPrimaryUnobstructed(page, new RegExp(m.login_submit()));

		// Signing in again works, and revokes the session the browser presented, ended or not.
		const idle = await ownTokenHash(page);
		expect(isRevoked(idle)).toBe(false);
		await page.getByLabel(m.login_email_label()).fill(E2E_USER_EMAIL);
		await page
			.getByRole('textbox', { name: m.login_password_label(), exact: false })
			.fill(E2E_USER_PASSWORD);
		await page.getByRole('button', { name: m.login_submit() }).click();
		await expect(page).not.toHaveURL(/\/login/);
		expect(isRevoked(idle)).toBe(true);
	});
}

test('a visitor who was never signed in sees no reason', async ({ page }) => {
	await page.goto('/login');
	await expect(page.getByRole('button', { name: m.login_submit() })).toBeVisible();
	// The positive half is the journey above, on the same page and the same locator.
	await expect(page.getByRole('status')).toHaveCount(0);
});
