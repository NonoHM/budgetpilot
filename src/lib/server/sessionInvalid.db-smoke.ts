import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import {
	createSession,
	createSessionToken,
	deadSessionReason,
	hashSessionToken,
	lifetimeEndsAt,
	readSessionUser,
	SESSION_COOKIE,
	sessionEndedByInactivity
} from '$lib/server/auth';
import { SETTINGS } from '$lib/server/env/settings';
import { prisma } from '$lib/server/db';

/**
 * Why a presented session cookie no longer works (L3, #250): `deadSessionReason`, which the hook
 * logs as `session.invalid`, against a real engine.
 *
 * WHY A DB-SMOKE. Each reason is a predicate over `revokedAt` and `expiresAt`, and liveness is a
 * `where` clause the ENGINE evaluates on columns whose stored format differs by engine (SQLite keeps
 * text). A unit test's fake decides what `findUnique` returns, so it would pass with any clause
 * removed. Same reasoning as `auth/sessionIdle.db-smoke.ts`, whose fixtures this follows.
 *
 * THE FIVE FIXTURES, one per answer: no row (`unknown`), a revoked row, a row ended by the
 * inactivity timeout (`idle`), a row ended at its lifetime (`expired`), and a live row (null). Each
 * row is written through the real `createSession`, then its dates are moved; no formula of the
 * application is copied except through calling `lifetimeEndsAt`, the definition itself.
 *
 * WHICH TWO STATES EACH SEPARATES:
 *  - revoked: `revokedAt` read at all, versus a reader judging only `expiresAt` (the row is
 *    otherwise live, so a reader ignoring `revokedAt` answers null).
 *  - revoked over an ended row: `revoked` takes precedence over `idle` (the row is also past an
 *    idle `expiresAt`).
 *  - idle: past the timeout with most of the lifetime left, versus `expired`.
 *  - expired: `expiresAt` EXACTLY at `lifetimeEndsAt(createdAt)`, the single value where `<` and
 *    `<=` disagree, so an `idle` rule written with `<=` answers `idle` here and fails.
 *  - live: null, versus a reader that answers a reason for every row it finds.
 * `sessionEndedByInactivity` is asserted to agree with `reason === 'idle'` on every fixture, the
 * duplicated-predicate rule: two spellings of one rule must agree over the inputs that tell them
 * apart.
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

/** A session through the real write path: its token and its row id. */
async function mintSession(): Promise<{ token: string; id: string }> {
	let token = '';
	const cookies = {
		get: () => undefined,
		set: (name: string, value: string) => {
			if (name === SESSION_COOKIE) token = value;
		}
	} as unknown as Cookies;
	await createSession(userId, cookies);
	const found = await prisma.session.findUniqueOrThrow({
		where: { tokenHash: hashSessionToken(token) },
		select: { id: true }
	});
	return { token, id: found.id };
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

type Fixture = 'unknown' | 'revoked' | 'revokedAndIdle' | 'idle' | 'expired' | 'live';

/** Each fixture's token, after its row is in the state named. */
async function fixture(kind: Fixture): Promise<string> {
	// Minted, never stored: a well-formed token no row has.
	if (kind === 'unknown') return createSessionToken();

	const { token, id } = await mintSession();
	if (kind === 'revoked') {
		await prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
	}
	if (kind === 'revokedAndIdle') {
		await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);
		await prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
	}
	if (kind === 'idle') await travel(id, DEFAULT_IDLE_MS + MINUTE_MS);
	if (kind === 'expired') {
		// Created a lifetime and a day ago, stopped exactly at its lifetime's end: what
		// `slidingExpiresAt` writes for a session used until its ceiling.
		const createdAt = new Date(Date.now() - SETTINGS[TTL].default * DAY_MS - DAY_MS);
		await prisma.session.update({
			where: { id },
			data: { createdAt, lastSeenAt: createdAt, expiresAt: lifetimeEndsAt(createdAt) }
		});
	}
	return token;
}

beforeEach(async () => {
	for (const name of [IDLE, TTL]) {
		settingsBefore[name] = process.env[name];
		delete process.env[name];
	}
	const user = await prisma.user.create({
		data: {
			email: `invalid-smoke-${crypto.randomUUID()}@budgetpilot.invalid`,
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

describe('deadSessionReason: why a presented cookie no longer works', () => {
	it('no token has no reason', async () => {
		expect(await deadSessionReason(undefined)).toBeNull();
	});

	// The fixture premise first, in its own test: the live row resolves, so the null below is about
	// a live session and not about a row the reader cannot find.
	it('the live fixture resolves to its user', async () => {
		const token = await fixture('live');
		expect((await readSessionUser(token))?.id).toBe(userId);
	});

	it('a live session has no reason', async () => {
		const token = await fixture('live');
		expect(await deadSessionReason(token)).toBeNull();
	});

	it('a token no row has is unknown, with no user', async () => {
		const token = await fixture('unknown');
		expect(await deadSessionReason(token)).toEqual({ reason: 'unknown' });
	});

	it('a revoked session is revoked, with its user', async () => {
		const token = await fixture('revoked');
		expect(await deadSessionReason(token)).toEqual({ reason: 'revoked', userId });
	});

	it('a revoked session that also went unused is revoked, not idle', async () => {
		const token = await fixture('revokedAndIdle');
		expect(await deadSessionReason(token)).toEqual({ reason: 'revoked', userId });
	});

	it('a session unused past the timeout is idle, with its user', async () => {
		const token = await fixture('idle');
		expect(await deadSessionReason(token)).toEqual({ reason: 'idle', userId });
	});

	it('a session stopped exactly at its lifetime is expired, with its user', async () => {
		const token = await fixture('expired');
		expect(await deadSessionReason(token)).toEqual({ reason: 'expired', userId });
	});
});

/**
 * The two spellings of « ended by inactivity » over ONE table, each in its own test so neither figure
 * goes unobserved while the other is red. Both read the same expected column, which is the agreement.
 * A loop over a non-uniform set, so each kind is its own case.
 */
const ENDED_BY_INACTIVITY = [
	['unknown', false],
	['revoked', false],
	['revokedAndIdle', false],
	['idle', true],
	['expired', false],
	['live', false]
] as const;

// One rule since L3: `sessionEndedByInactivity` reads `deadSessionReason`. Each reader is still held
// to the table, so a change to the wrapper's comparison fails here on its own.
describe('the idle rule, through both readers, on every fixture', () => {
	it.each(ENDED_BY_INACTIVITY)('%s: deadSessionReason says idle is %s', async (kind, idle) => {
		const token = await fixture(kind);
		expect((await deadSessionReason(token))?.reason === 'idle').toBe(idle);
	});

	it.each(ENDED_BY_INACTIVITY)('%s: sessionEndedByInactivity is %s', async (kind, idle) => {
		const token = await fixture(kind);
		expect(await sessionEndedByInactivity(token)).toBe(idle);
	});
});
