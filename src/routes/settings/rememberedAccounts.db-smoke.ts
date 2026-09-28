import { beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { prisma } from '$lib/server/db';
import * as m from '$lib/paraglide/messages';

if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly.'
	);
}

/**
 * « Oublier » on a remembered account, THROUGH THE SETTINGS ROUTE ACTION a browser POST reaches.
 *
 * The object reference posted is a claim (AGENTS.md, « Security boundaries »): a row of another
 * user is refused as not-found and STAYS, on a real engine, where a dropped `userId` clause would
 * delete it. ASVS v5.0.0-8.2.2.
 */

// Explicit fixtures: `vitest.db.env-stub.ts` is empty on purpose, and the Settings module reaches
// the TOTP cipher at import.
env.TOTP_ENCRYPTION_KEY = 'c1'.repeat(32);
env.RATE_LIMIT_HASH_SECRET = 'b8'.repeat(32);
// Vite's build-time define, absent from this plugin-less config; the page reads it in `load` only.
(globalThis as Record<string, unknown>).__APP_VERSION__ = 'db-smoke';

let actions: typeof import('./+page.server').actions;

beforeAll(async () => {
	({ actions } = await import('./+page.server'));
});

type ActionOutcome = { status?: number; data?: Record<string, unknown> } & Record<string, unknown>;

async function forget(userId: string, id: string) {
	const body = new FormData();
	body.set('id', id);
	return (await actions.forgetRememberedAccount!({
		locals: { user: { id: userId } },
		request: new Request('http://localhost/settings?/forgetRememberedAccount', {
			method: 'POST',
			body
		})
	} as never)) as ActionOutcome;
}

async function seedRemembered(tag: string) {
	const stamp = `${Date.now()}-${Math.round(performance.now() * 1000)}`;
	const user = await prisma.user.create({
		data: { email: `forget-${tag}-${stamp}@example.test`, passwordHash: 'x', role: 'USER' }
	});
	const account = await prisma.account.create({
		data: { userId: user.id, name: 'Compte courant', currency: 'EUR', exponent: 2, source: 'csv' },
		select: { id: true }
	});
	const row = await prisma.rememberedAccount.create({
		data: {
			userId: user.id,
			identifierKey: `${tag}-${stamp}`.padEnd(64, '0'),
			fragment: '0185',
			accountId: account.id
		},
		select: { id: true }
	});
	return { userId: user.id, rowId: row.id };
}

describe('« Oublier » through the Settings route', () => {
	it("refuses another user's row as not-found, and the row stays", async () => {
		expect.assertions(3);
		const theirs = await seedRemembered('theirs');
		const mine = await seedRemembered('mine');

		const outcome = await forget(mine.userId, theirs.rowId);

		expect(outcome.status).toBe(404);
		expect(outcome.data?.rememberedAccountError).toBe(
			m.settings_remembered_accounts_error_not_found()
		);
		expect(await prisma.rememberedAccount.count({ where: { id: theirs.rowId } })).toBe(1);
	});

	it('forgets my own row', async () => {
		// The calibration of the refusal above: the same action DOES delete, so the 404 is the
		// scoping and not an action that deletes nothing.
		expect.assertions(2);
		const mine = await seedRemembered('own');

		const outcome = await forget(mine.userId, mine.rowId);

		expect(outcome.rememberedAccountSuccess).toBe(
			m.settings_remembered_accounts_success_forgotten()
		);
		expect(await prisma.rememberedAccount.count({ where: { id: mine.rowId } })).toBe(0);
	});

	it('answers a malformed id exactly as an unknown one', async () => {
		expect.assertions(1);
		const mine = await seedRemembered('empty');
		const outcome = await forget(mine.userId, '');
		expect(outcome.status).toBe(404);
	});
});
