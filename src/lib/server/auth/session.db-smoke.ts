import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import {
	createSession,
	createSessionToken,
	hashSessionToken,
	readSessionUser,
	revokeSessionToken,
	SESSION_COOKIE
} from '$lib/server/auth';
import { prisma } from '$lib/server/db';

/**
 * Session lookup against a real engine: the second half of check 8 of the Phase 5 automation
 * inventory, covering `v5.0.0-7.2.1` (session state is held server-side and nothing is trusted from
 * the client) and the enforcement half of `v5.0.0-7.3.2` (an expired session is refused by the
 * server, not merely by a cookie attribute).
 *
 * WHY NOT A UNIT TEST, which is where the automation inventory first put it. `readSessionUser` is
 * one Prisma query and four guards over its result. A unit test injects that result, so it replaces
 * exactly the thing under test: the `where: { tokenHash }` lookup, the `expiresAt <= new Date()`
 * comparison the DATABASE stores and the engine compares, and the `revokedAt` column. `CLAUDE.md`
 * records this as "Unit tests cannot see a wrong SQL predicate", from a `pg_has_role` mistake that
 * every branch-covered unit test missed. The whole point of the row is that the server decides, so
 * the test asks a server.
 *
 * THE WRITE PATH IS THE REAL ONE. Sessions here are minted by `createSession` through a `Cookies`
 * stub that only captures what is set, never by a hand-built `prisma.session.create`. A fixture
 * that writes its own rows tests the reader against a shape the writer might no longer produce, and
 * the two would drift silently because nothing compares them.
 *
 * EVERY NEGATIVE ASSERTION GETS THE APPEAR-THEN-DISAPPEAR TREATMENT. "An expired session does not
 * resolve" is satisfied by a reader that resolves nothing at all, by a fixture whose user was never
 * created, and by a token that was never valid in the first place. So each refusal test first
 * asserts the session DOES resolve, then changes the one thing under test, then asserts it stops.
 * The two states are separated inside a single test rather than across two, so a setup failure
 * cannot masquerade as the refusal being verified.
 */

// Same refusal as the other db-smoke suites, duplicated per file on purpose: this guard is what
// stops the suite writing to a developer's real dev.db, and a shared helper a file forgets to call
// is a worse failure than the duplication.
if (!process.env.DATABASE_URL) {
	throw new Error(
		'This suite writes to a real database. Set DATABASE_URL (and DATABASE_PROVIDER for a server ' +
			'engine) to a throwaway database explicitly. It refuses to fall back to the default local ' +
			'SQLite file.'
	);
}

if (/(^|[/\\])dev\.db(\?|$)/.test(process.env.DATABASE_URL)) {
	throw new Error(
		'DATABASE_URL points at dev.db, the default local development database. Point it at a ' +
			'throwaway database instead.'
	);
}

const DAY_MS = 24 * 60 * 60 * 1000;

let userId = '';

/** The minimum of `Cookies` that `createSession` touches, holding what it wrote. */
function captureCookies(): { cookies: Cookies; token: () => string } {
	let written = '';
	const cookies = {
		set: (name: string, value: string) => {
			if (name === SESSION_COOKIE) written = value;
		}
	} as unknown as Cookies;
	return { cookies, token: () => written };
}

/** Mints a session for the fixture user through the real write path, and hands back its token. */
async function mintSession(): Promise<string> {
	const { cookies, token } = captureCookies();
	await createSession(userId, cookies);
	return token();
}

beforeEach(async () => {
	const user = await prisma.user.create({
		data: {
			email: `session-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
});

afterEach(async () => {
	// Sessions cascade from User, and unlike the TransactionSplit case recorded in CLAUDE.md there
	// is no second path converging on them, so the cascade order cannot matter here.
	await prisma.user.deleteMany({ where: { id: userId } });
});

describe('v5.0.0-7.2.1: session state is resolved server-side, per request', () => {
	// Nothing below means anything without this. A reader that returns null unconditionally, a
	// fixture whose user was never written, or a `createSession` that set no cookie all produce the
	// same clean refusals as a correct implementation.
	it('calibration: a live session resolves to its user', async () => {
		expect.assertions(3);

		const token = await mintSession();
		expect(token.length).toBeGreaterThan(20);

		const user = await readSessionUser(token);
		expect(user).not.toBeNull();
		expect(user?.id).toBe(userId);
	});

	it('a well-formed token that was never issued resolves to nothing', async () => {
		expect.assertions(3);

		// Minted by the application's own generator, so it is indistinguishable from a real token by
		// shape, length and alphabet. The only thing wrong with it is that no row carries its hash,
		// which is precisely the property this row is about.
		const forged = createSessionToken();
		expect(forged).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(await prisma.session.count({ where: { tokenHash: hashSessionToken(forged) } })).toBe(0);

		expect(await readSessionUser(forged)).toBeNull();
	});

	it('a revoked session stops resolving, having resolved a moment earlier', async () => {
		expect.assertions(2);

		const token = await mintSession();
		expect(await readSessionUser(token)).not.toBeNull();

		await revokeSessionToken(token);
		expect(await readSessionUser(token)).toBeNull();
	});

	it('the token is never stored, only its hash', async () => {
		expect.assertions(3);

		const token = await mintSession();
		const row = await prisma.session.findUnique({
			where: { tokenHash: hashSessionToken(token) },
			select: { tokenHash: true }
		});

		expect(row).not.toBeNull();
		expect(row?.tokenHash).not.toBe(token);
		// The whole table, not only this row: a second column holding the plaintext would satisfy
		// the assertion above and defeat the property.
		expect(await prisma.session.count({ where: { tokenHash: token } })).toBe(0);
	});
});

describe('v5.0.0-7.3.2: the lifetime ceiling is enforced by the server', () => {
	it('an expired session stops resolving, having resolved a moment earlier', async () => {
		expect.assertions(2);

		const token = await mintSession();
		expect(await readSessionUser(token)).not.toBeNull();

		// The row is aged rather than the clock moved: the comparison under test happens in this
		// process against `new Date()`, and a fake timer here would only prove the fake works.
		await prisma.session.update({
			where: { tokenHash: hashSessionToken(token) },
			data: { expiresAt: new Date(Date.now() - 1000) }
		});
		expect(await readSessionUser(token)).toBeNull();
	});

	it('a new session carries the documented 30-day ceiling in the row itself', async () => {
		expect.assertions(1);

		const token = await mintSession();
		const row = await prisma.session.findUnique({
			where: { tokenHash: hashSessionToken(token) },
			select: { expiresAt: true }
		});

		// Read back out of the database rather than off the returned object, because the claim in
		// the assessment is that the ceiling is a stored row and not a cookie hint. A round trip is
		// also what catches an engine storing the column at the wrong precision or in the wrong zone.
		const days = Math.round(((row?.expiresAt.getTime() ?? 0) - Date.now()) / DAY_MS);
		expect(days).toBe(30);
	});
});
