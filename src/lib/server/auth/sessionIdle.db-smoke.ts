import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRedirect, type Cookies } from '@sveltejs/kit';
import {
	applySessionSettings,
	commitWithRotatedToken,
	createSession,
	hashSessionToken,
	lastSeenRefreshMs,
	lifetimeEndsAt,
	readSessionUser,
	revokeSession,
	SESSION_COOKIE,
	sessionEndedByInactivity
} from '$lib/server/auth';
import { SETTINGS } from '$lib/server/env/settings';
import { prisma } from '$lib/server/db';

/**
 * The inactivity timeout (#221, ruled on #919) against a real engine: `ASVS v5.0.0-7.3.1`, « an
 * inactivity timeout », beside the absolute lifetime of `v5.0.0-7.3.2`. A session stops working at
 * its `expiresAt`: the timeout after its last recorded use, never past its lifetime, written at
 * sign-in and at each use (sliding expiration).
 *
 * WHY A DB-SMOKE. Liveness is a `where` clause the ENGINE evaluates, on columns whose stored format
 * differs by engine (SQLite keeps text). A unit test's fake decides what `findUnique` returns, so it
 * would pass with the clause removed.
 *
 * TIME PASSES BY `travel`, which shifts every date on the row back by the same amount: the clock
 * moving forward with no use. No formula of the application is copied here, and nothing runs while
 * the clock moves, which is also what a stopped app looks like. Every refusal is preceded by the same
 * session resolving, so a reader that resolves nothing cannot pass.
 *
 * Breaks, each separately, are listed in the PR: each clause of `liveSessionWhere`,
 * `slidingExpiresAt`'s two bounds, the use recorded, the rotation's slide, the startup step, and the
 * sign-in page's reason.
 */

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

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const IDLE = 'BP_SESSION_IDLE_TIMEOUT_HOURS';
const TTL = 'SESSION_TTL_DAYS';
const DEFAULT_IDLE_MS = SETTINGS[IDLE].default * HOUR_MS;

let userId = '';
const settingsBefore: Record<string, string | undefined> = {};

/** The browser's side of one request: it presents `presented` and keeps what the response writes. */
function browser(presented: string | undefined) {
	let written: { value: string; expires?: Date } | undefined;
	const cookies = {
		get: (name: string) => (name === SESSION_COOKIE ? (written?.value ?? presented) : undefined),
		set: (name: string, value: string, options: { expires?: Date }) => {
			if (name === SESSION_COOKIE) written = { value, expires: options.expires };
		}
	} as unknown as Cookies;
	return { cookies, written: () => written };
}

/** A session through the real write path: its token, its row id and its cookie's expiry. */
async function mintSession(): Promise<{ token: string; id: string; cookieExpires?: Date }> {
	const minted = browser(undefined);
	await createSession(userId, minted.cookies);
	const token = minted.written()?.value ?? '';
	const found = await prisma.session.findUniqueOrThrow({
		where: { tokenHash: hashSessionToken(token) },
		select: { id: true }
	});
	return { token, id: found.id, cookieExpires: minted.written()?.expires };
}

async function row(id: string) {
	return prisma.session.findUniqueOrThrow({
		where: { id },
		select: { createdAt: true, lastSeenAt: true, expiresAt: true }
	});
}

/** The clock moves forward `ms` with no use: every date on the row moves back by the same amount. */
async function travel(id: string, ms: number) {
	const dates = await row(id);
	const back = (date: Date) => new Date(date.getTime() - ms);
	await prisma.session.update({
		where: { id },
		data: {
			createdAt: back(dates.createdAt),
			lastSeenAt: back(dates.lastSeenAt),
			expiresAt: back(dates.expiresAt)
		}
	});
}

/** 1.2.0's `readSessionUser`, which reads `revokedAt` and `expiresAt` and nothing else: the oracle
 * for a rollback, written out because it is the code that would then run. */
async function liveUnder120(token: string): Promise<boolean> {
	const count = await prisma.session.count({
		where: { tokenHash: hashSessionToken(token), revokedAt: null, expiresAt: { gt: new Date() } }
	});
	return count === 1;
}

const live = async (token: string) => (await readSessionUser(token)) !== null;

beforeEach(async () => {
	for (const name of [IDLE, TTL]) {
		settingsBefore[name] = process.env[name];
		delete process.env[name];
	}
	const user = await prisma.user.create({
		data: {
			email: `idle-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: 'db-smoke-not-a-real-hash'
		},
		select: { id: true }
	});
	userId = user.id;
});

afterEach(async () => {
	for (const name of [IDLE, TTL]) {
		if (settingsBefore[name] === undefined) delete process.env[name];
		else process.env[name] = settingsBefore[name];
	}
	await prisma.user.deleteMany({ where: { id: userId } });
});

describe('v5.0.0-7.3.1 and 7.3.2: when a session stops working', () => {
	it('a new session stops one timeout after sign-in, and its cookie lives to the end of the lifetime', async () => {
		expect.assertions(3);

		const { id, cookieExpires } = await mintSession();
		const dates = await row(id);

		// Read back from the row: the round trip is what catches an engine storing the wrong precision.
		expect(dates.expiresAt.getTime() - dates.createdAt.getTime()).toBe(DEFAULT_IDLE_MS);
		expect(dates.lastSeenAt.getTime()).toBe(dates.createdAt.getTime());
		// The browser keeps the cookie past the timeout, so the sign-in page can still give the reason.
		expect(cookieExpires?.getTime()).toBe(lifetimeEndsAt(dates.createdAt).getTime());
	});

	it('a use slides it: used just inside the timeout, it works one more timeout from that use', async () => {
		expect.assertions(3);

		const { token, id } = await mintSession();
		await travel(id, DEFAULT_IDLE_MS - MINUTE_MS);
		expect(await live(token)).toBe(true);

		// Without the slide, the session would have stopped a minute after this second stretch began.
		await travel(id, DEFAULT_IDLE_MS - MINUTE_MS);
		expect(await live(token)).toBe(true);
		await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);
		expect(await live(token)).toBe(false);
	});

	it('unused past the timeout it stops, with most of its lifetime left', async () => {
		expect.assertions(2);

		const { token, id } = await mintSession();
		await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);

		expect(lifetimeEndsAt((await row(id)).createdAt).getTime()).toBeGreaterThan(Date.now());
		expect(await live(token)).toBe(false);
	});

	it('reads BP_SESSION_IDLE_TIMEOUT_HOURS: at 1 hour, 59 minutes works and 61 do not', async () => {
		expect.assertions(2);

		process.env[IDLE] = '1';
		const { token, id } = await mintSession();

		await travel(id, 59 * MINUTE_MS);
		expect(await live(token)).toBe(true);

		// 61 minutes after that use: far inside the 168-hour default, so a reader ignoring the setting
		// would still resolve it.
		await travel(id, 61 * MINUTE_MS);
		expect(await live(token)).toBe(false);
	});

	it('never works past its lifetime, however often it is used', async () => {
		expect.assertions(3);

		process.env[TTL] = '1';
		const { token, id } = await mintSession();
		await travel(id, 23 * HOUR_MS);
		expect(await live(token)).toBe(true);

		// Used an hour ago, but its day is over.
		await travel(id, 2 * HOUR_MS);
		expect(await live(token)).toBe(false);
		expect(await sessionEndedByInactivity(token)).toBe(false);
	});
});

describe('a use is recorded at most once per interval', () => {
	it('a request inside the interval writes nothing', async () => {
		expect.assertions(2);

		const { token, id } = await mintSession();
		await travel(id, lastSeenRefreshMs(DEFAULT_IDLE_MS) - MINUTE_MS);
		const before = await row(id);

		expect(await live(token)).toBe(true);
		expect(await row(id)).toEqual(before);
	});

	it('at a 1-hour timeout the interval is 5 minutes: after 4 nothing is written, after 6 it is', async () => {
		expect.assertions(4);

		process.env[IDLE] = '1';
		const { token, id } = await mintSession();

		await travel(id, 4 * MINUTE_MS);
		const at4 = await row(id);
		expect(await live(token)).toBe(true);
		expect(await row(id)).toEqual(at4);

		// An hourly interval would leave this one alone and sign out a user active at minutes 59 and
		// 61, which is why the interval follows the timeout (ruled on #221).
		await travel(id, 2 * MINUTE_MS);
		const at6 = await row(id);
		expect(await live(token)).toBe(true);
		expect((await row(id)).expiresAt.getTime()).toBeGreaterThan(at6.expiresAt.getTime());
	});
});

describe('rotation (commitWithRotatedToken)', () => {
	it('a re-authenticated change is a use: it slides expiresAt and keeps the lifetime', async () => {
		expect.assertions(3);

		const { token, id } = await mintSession();
		await travel(id, 2 * HOUR_MS);
		const before = await row(id);

		const request = browser(token);
		const startedAt = Date.now();
		await commitWithRotatedToken({ sessionId: id }, request.cookies, async () => undefined);

		const after = await row(id);
		expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
		expect(after.expiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + DEFAULT_IDLE_MS - 1_000);
		expect(request.written()?.expires?.getTime()).toBe(lifetimeEndsAt(before.createdAt).getTime());
	});

	it('a session that stopped working before its change committed is sent to sign in, and the change rolls back', async () => {
		expect.assertions(3);

		const { token, id } = await mintSession();
		expect(await live(token)).toBe(true);

		await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);
		let committed = false;
		const outcome = await commitWithRotatedToken(
			{ sessionId: id },
			browser(token).cookies,
			async (tx) => {
				await tx.user.update({ where: { id: userId }, data: { forcePasswordChange: true } });
				committed = true;
			}
		).catch((thrown: unknown) => thrown);

		expect(isRedirect(outcome) && outcome.location).toBe('/login');
		const user = await prisma.user.findUniqueOrThrow({
			where: { id: userId },
			select: { forcePasswordChange: true }
		});
		expect(committed && user.forcePasswordChange).toBe(false);
	});
});

/**
 * THE PROPERTY THE OWNER RULED (#221, 2026-10-07): a sign-in that stopped working never works
 * again, whatever the timeout or the lifetime is changed to, and on 1.2.0. Written before the design
 * that makes it true, and red against the sweep it replaced: a session idle since the last sweep
 * came back.
 */
describe('an ended sign-in never comes back (ruled on #221)', () => {
	it('A: unused past the timeout, it is refused, and 1.2.0 refuses it too, with no process running in between', async () => {
		expect.assertions(4);

		const { token, id } = await mintSession();
		await travel(id, DEFAULT_IDLE_MS - MINUTE_MS);
		expect(await live(token)).toBe(true);

		await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);
		expect(await live(token)).toBe(false);
		expect(await liveUnder120(token)).toBe(false);
		expect(await sessionEndedByInactivity(token)).toBe(true);
	});

	it('B: raising the timeout afterwards does not bring it back', async () => {
		expect.assertions(3);

		const { token, id } = await mintSession();
		await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);
		expect(await live(token)).toBe(false);

		process.env[IDLE] = '720';
		expect(await live(token)).toBe(false);
		expect(await liveUnder120(token)).toBe(false);
	});

	it('C: a timeout lowered at startup ends it at once, and raising it back does not revive it', async () => {
		expect.assertions(4);

		const { token, id } = await mintSession();
		await travel(id, 2 * HOUR_MS);
		expect(await liveUnder120(token)).toBe(true);

		process.env[IDLE] = '1';
		await applySessionSettings(new Date());
		expect(await live(token)).toBe(false);
		expect(await liveUnder120(token)).toBe(false);

		delete process.env[IDLE];
		expect(await live(token)).toBe(false);
	});

	it('D: the startup step leaves a session within the settings alone, and never extends one', async () => {
		expect.assertions(2);

		const { token, id } = await mintSession();
		await travel(id, 2 * HOUR_MS);
		const before = await row(id);

		// Raised: the settings now allow more than the row holds. Only a use may extend it.
		process.env[IDLE] = '720';
		await applySessionSettings(new Date());
		expect(await row(id)).toEqual(before);
		expect(await live(token)).toBe(true);
	});

	it('E: a lifetime lowered at startup ends a session past it at once, and raising it back does not revive it', async () => {
		expect.assertions(3);

		const { token, id } = await mintSession();
		// Two days old, inside its 7-day timeout: only the lifetime can end it.
		await travel(id, 2 * DAY_MS);
		expect(await liveUnder120(token)).toBe(true);

		process.env[TTL] = '1';
		await applySessionSettings(new Date());
		expect(await live(token)).toBe(false);

		delete process.env[TTL];
		expect(await live(token)).toBe(false);
	});
});

describe('sessionEndedByInactivity: what the sign-in page may say', () => {
	it('is true exactly when the timeout stopped the session', async () => {
		expect.assertions(2);

		const { token, id } = await mintSession();
		expect(await sessionEndedByInactivity(token)).toBe(false);

		await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);
		expect(await sessionEndedByInactivity(token)).toBe(true);
	});

	it('is false for a session a person revoked, idle or not', async () => {
		expect.assertions(2);

		const { token, id } = await mintSession();
		await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);
		expect(await sessionEndedByInactivity(token)).toBe(true);

		// Ended on purpose by its row, as `/logout` and Settings do: the page must not say inactivity.
		await revokeSession(id);
		expect(await sessionEndedByInactivity(token)).toBe(false);
	});

	it('is false with no cookie or a token never issued', async () => {
		expect.assertions(2);

		expect(await sessionEndedByInactivity(undefined)).toBe(false);
		expect(await sessionEndedByInactivity('never-issued-token')).toBe(false);
	});
});

describe('Settings, Sessions: « Active » is the same predicate', () => {
	it('lists a session that stopped for inactivity as not active, beside a live one', async () => {
		expect.assertions(1);

		const current = await mintSession();
		const forgotten = await mintSession();
		await travel(forgotten.id, DEFAULT_IDLE_MS + MINUTE_MS);

		const { load } = await import('../../../routes/settings/+page.server');
		const user = await readSessionUser(current.token);
		const data = (await (load as (event: unknown) => Promise<unknown>)({
			locals: { user }
		})) as { sessions: { id: string; status: string }[] };

		// Both rows, each with its status: a reader that lists nothing would pass an absence check.
		const status = Object.fromEntries(data.sessions.map((entry) => [entry.id, entry.status]));
		expect(status).toEqual({ [current.id]: 'active', [forgotten.id]: 'revoked' });
	});
});
