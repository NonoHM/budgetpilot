import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRedirect, type Cookies } from '@sveltejs/kit';
import { createSession, hashPassword, readSessionUser, SESSION_COOKIE } from '$lib/server/auth';
import { REAUTH_FIELDS } from '$lib/domain/reauthFields';
import { ATTRIBUTE, EVENT } from '$lib/server/logging/names';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';
import {
	chat,
	closeFakeHosts,
	envFor,
	fakeHost,
	stringRequest,
	tags,
	version
} from '../insights/fakeModelHost.fixture';

/**
 * #986, against a real engine and a real model host socket: AISVS 1.0 C9.6.1, « Verify that a
 * manual kill-switch mechanism exists to immediately halt AI model inference and outputs. », and
 * C12.4.3, « Verify that kill-switch activations and override commands are logged. »
 *
 * THE STARTING FIGURE, measured on main before the switch existed: a generation in flight ran to
 * its end whatever an admin did, because nothing in the app could reach it; `LLM_ENABLED` is read
 * once per call, before the socket opens. The rulings (owner, 2026-10-12): the halt is a database row
 * that survives a restart; it is set and lifted from /admin; halting asks for no password, lifting
 * asks for re-authentication; each change writes one typed event naming the admin by pseudonym.
 *
 * Every step is the one the application performs: the admin actions are the route's own, driven with
 * `locals.user` resolved by `readSessionUser` as the hook does, and the door is `requestLocalModel`.
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

const logged = vi.hoisted(() => [] as { event: string; attributes: Record<string, unknown> }[]);
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: (event: { event: string; attributes: Record<string, unknown> }) => {
		logged.push(event);
	}
}));

const { requestLocalModel } = await import('../insights/local-llm');
const { haltInference, liftInferenceHalt, readInferenceHalt } = await import('./inferenceHalt');
const { logUserPseudonym } = await import('$lib/server/logging/pseudonym');

const PASSWORD = 'halt-smoke-password';
const created: string[] = [];
let addressCounter = 0;

async function seedAccount(tag: string, role: 'ADMIN' | 'USER') {
	const user = await prisma.user.create({
		data: {
			email: `halt-smoke-${tag}-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: await hashPassword(PASSWORD),
			role
		},
		select: { id: true, email: true }
	});
	created.push(user.id);
	return user;
}

function browser(presented: string | undefined) {
	let written: string | null = null;
	const cookies = {
		get: (name: string) => (name === SESSION_COOKIE ? (written ?? presented) : undefined),
		set: (name: string, value: string) => {
			if (name === SESSION_COOKIE) written = value;
		},
		delete: () => {}
	} as unknown as Cookies;
	return { cookies, written: () => written };
}

async function signIn(userId: string): Promise<string> {
	const minted = browser(undefined);
	await createSession(userId, minted.cookies);
	return minted.written() ?? '';
}

/** The session row a token resolves to, so a test can revoke it after the hook resolved it. */
async function sessionIdOf(token: string): Promise<string> {
	return (await readSessionUser(token))?.sessionId ?? '';
}

function formOf(fields: Record<string, string>): FormData {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return form;
}

/** The admin route's action, as the request a browser presenting `token` makes. */
async function post(
	action: string,
	token: string,
	fields: Record<string, string> = {},
	resolved?: Awaited<ReturnType<typeof readSessionUser>>
) {
	const { actions } = await import('../../../routes/admin/+page.server');
	const run = (actions as Record<string, (event: unknown) => Promise<unknown>>)[action];
	const request = browser(token);
	addressCounter += 1;
	const event = {
		cookies: request.cookies,
		getClientAddress: () => `203.0.113.${addressCounter}`,
		request: new Request('http://localhost/admin', { method: 'POST', body: formOf(fields) }),
		locals: { user: resolved ?? (await readSessionUser(token)) },
		url: new URL('http://localhost/admin')
	};
	try {
		return await run(event);
	} catch (thrown) {
		if (isRedirect(thrown)) return { redirect: thrown.location };
		throw thrown;
	}
}

/** The admin page's own load, as the same browser. */
async function loadAdmin(token: string) {
	const { load } = await import('../../../routes/admin/+page.server');
	return (await (load as (event: unknown) => Promise<unknown>)({
		locals: { user: await readSessionUser(token) },
		url: new URL('http://localhost/admin')
	})) as { inferenceHalt: { haltedAt: Date; haltedByEmail: string | null } | null };
}

/** A host whose generation never finishes on its own, recording whether the client hung up. */
async function holdingHost() {
	const seen = { chatClosedByClient: false };
	const holding = (req: IncomingMessage, res: ServerResponse) => {
		res.on('close', () => {
			if (!res.writableEnded) seen.chatClosedByClient = true;
		});
		// 60 s: far past any budget this file waits, so only an abort ends it inside the test.
		setTimeout(() => {
			if (!res.destroyed) res.writeHead(200).end('{}');
		}, 60_000).unref();
		void req;
	};
	const host = await fakeHost({
		'/api/version': version,
		'/api/tags': tags(),
		'/api/chat': holding
	});
	return { host, seen };
}

async function answeringHost() {
	return fakeHost({
		'/api/version': version,
		'/api/tags': tags(),
		'/api/chat': chat(JSON.stringify({ text: 'ok' }))
	});
}

/**
 * The secrets the route's pseudonyms and re-authentication read, set on the CURRENT module graph:
 * the restart test below starts a fresh one, whose `$env` stub is empty again.
 */
async function setSecrets() {
	const current = (await import('$env/dynamic/private')).env;
	current.RATE_LIMIT_HASH_SECRET = 'e5'.repeat(32);
	current.TOTP_ENCRYPTION_KEY = 'f6'.repeat(32);
}

beforeAll(setSecrets);

afterEach(async () => {
	await closeFakeHosts();
	// The one delete path the lift itself uses (design note F6a): no test-only writer ships.
	await liftInferenceHalt(prisma);
	logged.length = 0;
});

afterAll(async () => {
	await prisma.user.deleteMany({ where: { id: { in: created } } });
});

describe('the instance-wide halt at the model door (#986, AISVS C9.6.1)', () => {
	// Separates a halted instance from a running one at the door: before any socket opens, so the
	// model host sees nothing, and not charged, because no generation started.
	it('refuses a new call while halted, before any socket, and charges nothing', async () => {
		const admin = await seedAccount('door', 'ADMIN');
		const token = await signIn(admin.id);
		const host = await answeringHost();

		const halted = await post('haltInference', token);
		expect(halted).not.toHaveProperty('status');

		const result = await requestLocalModel(stringRequest(10), envFor(host));
		expect({ result, hits: host.hits }).toEqual({
			result: { unavailable: true, failureCode: 'halted', notCharged: true },
			hits: {}
		});
	});

	// Separates « halts new calls » from « halts inference »: the generation already running is the
	// one C9.6.1's « immediately » is about. The host holds it for 60 s, so an answer inside 5 s is
	// the abort, and the host seeing the connection closed is the client having hung up rather than
	// merely having stopped waiting.
	it('aborts a generation already running, at once, and the host sees the hang-up', async () => {
		const admin = await seedAccount('inflight', 'ADMIN');
		const token = await signIn(admin.id);
		const { host, seen } = await holdingHost();

		const pending = requestLocalModel(stringRequest(10), envFor(host, { LLM_TIMEOUT_MS: '60000' }));
		await vi.waitFor(() => expect(host.hits['/api/chat']).toBe(1), { timeout: 5_000 });

		const haltedAt = Date.now();
		await post('haltInference', token);
		const result = await pending;
		const tookMs = Date.now() - haltedAt;

		expect(result).toEqual({ unavailable: true, failureCode: 'halted' });
		expect(tookMs, `answered ${tookMs} ms after the halt`).toBeLessThan(5_000);
		await vi.waitFor(() => expect(seen.chatClosedByClient).toBe(true), { timeout: 2_000 });
	});

	// Separates a halt held in memory from one held in the database: a restart is a fresh module
	// graph, so nothing the first one remembered survives except the row.
	it('stays halted across a restart', async () => {
		const admin = await seedAccount('restart', 'ADMIN');
		await post('haltInference', await signIn(admin.id));
		const host = await answeringHost();

		vi.resetModules();
		await setSecrets();
		const restarted = await import('../insights/local-llm');
		const result = await restarted.requestLocalModel(stringRequest(10), envFor(host));

		expect({ result, hits: host.hits }).toEqual({
			result: { unavailable: true, failureCode: 'halted', notCharged: true },
			hits: {}
		});
	});

	it('lets the next call through once an admin lifts it with their password', async () => {
		const admin = await seedAccount('lift', 'ADMIN');
		const token = await signIn(admin.id);
		await post('haltInference', token);
		const host = await answeringHost();

		const lifted = await post('liftInferenceHalt', token, { [REAUTH_FIELDS.password]: PASSWORD });
		expect(lifted).not.toHaveProperty('status');

		const result = await requestLocalModel(stringRequest(10), envFor(host));
		expect(result?.value).toEqual({ text: 'ok' });
	});
});

describe('who may halt and lift (#986, ASVS v5.0.0-8.2.1)', () => {
	// Separates « lifting asks for the admin's password » from « lifting needs an admin session »:
	// the session alone must not switch the capability back on (owner ruling, 2026-10-12).
	it('refuses a lift without the password, says why, and the halt stays', async () => {
		const admin = await seedAccount('lift-nopass', 'ADMIN');
		const token = await signIn(admin.id);
		await post('haltInference', token);

		const refused = await post('liftInferenceHalt', token, {
			[REAUTH_FIELDS.password]: 'not-the-password'
		});

		expect(refused).toEqual({
			status: 400,
			data: { haltError: m.reauth_error_password() }
		});
		expect(await readInferenceHalt()).not.toBeNull();
	});

	// The halt asks for nothing but an admin session: it only removes a capability, and an admin in
	// an incident must not be slowed by a password prompt.
	it('halts with an admin session alone, and records who and when', async () => {
		const admin = await seedAccount('who', 'ADMIN');
		const token = await signIn(admin.id);
		const before = Date.now();

		await post('haltInference', token);

		const page = await loadAdmin(token);
		expect(page.inferenceHalt?.haltedByEmail).toBe(admin.email);
		expect(page.inferenceHalt?.haltedAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
	});

	it('refuses a member who is not an admin, for both actions', async () => {
		const admin = await seedAccount('member-admin', 'ADMIN');
		const member = await seedAccount('member', 'USER');
		const memberToken = await signIn(member.id);

		await expect(post('haltInference', memberToken)).rejects.toMatchObject({ status: 403 });
		expect(await readInferenceHalt()).toBeNull();

		await post('haltInference', await signIn(admin.id));
		await expect(
			post('liftInferenceHalt', memberToken, { [REAUTH_FIELDS.password]: PASSWORD })
		).rejects.toMatchObject({ status: 403 });
		expect(await readInferenceHalt()).not.toBeNull();
	});

	// Separates a halt that belongs to an account from one that belongs to the instance: deleting
	// the admin who pressed it must not switch inference back on.
	it('stays halted when the admin who halted is deleted', async () => {
		const admin = await seedAccount('deleted', 'ADMIN');
		await post('haltInference', await signIn(admin.id));

		await prisma.user.delete({ where: { id: admin.id } });

		const halt = await readInferenceHalt();
		expect(halt).not.toBeNull();
		expect(halt?.haltedByEmail).toBeNull();
	});

	// A second press keeps the first record: who halted, and since when, is the fact an operator
	// reads during an incident, and a later press would overwrite it.
	it('keeps the first halt when an admin halts again', async () => {
		const first = await seedAccount('first', 'ADMIN');
		const second = await seedAccount('second', 'ADMIN');
		await post('haltInference', await signIn(first.id));
		const was = await readInferenceHalt();

		await post('haltInference', await signIn(second.id));

		expect(await readInferenceHalt()).toEqual(was);
	});

	// Design pass F2, by FORCED interleaving (a gate holds the lift's transaction open), so it proves
	// the order is handled, not that it happens unaided. Separates a halt that waits for the lift to
	// commit and then creates its row from one that reads the row the lift has deleted but not yet
	// committed, reports « already halted », and leaves the instance running once the lift commits:
	// what Prisma's emulated upsert does on MySQL.
	it('a halt pressed while a lift is committing is not lost', async () => {
		const first = await seedAccount('race-first', 'ADMIN');
		const second = await seedAccount('race-second', 'ADMIN');
		await haltInference(first.id);

		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		let deleted!: () => void;
		const deletedSignal = new Promise<void>((resolve) => (deleted = resolve));
		const lift = prisma.$transaction(async (tx) => {
			await liftInferenceHalt(tx);
			deleted();
			await gate;
		});
		await deletedSignal;
		const halt = haltInference(second.id);
		await new Promise((resolve) => setTimeout(resolve, 200));
		open();
		const [created] = await Promise.all([halt, lift]);

		expect({ created, halted: (await readInferenceHalt()) !== null }).toEqual({
			created: true,
			halted: true
		});
	});
});

describe('each change is one typed event (#986, AISVS C12.4.3)', () => {
	// Compared as the whole list of AI events, so a missing line, a doubled one, or one naming the
	// wrong account each fail; the pseudonym is the production function's, never a copy.
	it('logs a halt, a refused lift and a lift, naming the admin by pseudonym', async () => {
		const admin = await seedAccount('log', 'ADMIN');
		const token = await signIn(admin.id);

		await post('haltInference', token);
		await post('haltInference', token);
		await post('liftInferenceHalt', token, { [REAUTH_FIELDS.password]: 'wrong' });
		await post('liftInferenceHalt', token, { [REAUTH_FIELDS.password]: PASSWORD });

		const who = { [ATTRIBUTE.userPseudonym]: logUserPseudonym(admin.id) };
		const ai = logged.filter(
			(line) => line.event === EVENT.aiInferenceHalted || line.event === EVENT.aiInferenceResumed
		);
		expect(ai).toEqual([
			{ event: EVENT.aiInferenceHalted, attributes: who },
			{ event: EVENT.aiInferenceResumed, attributes: who }
		]);
	});

	// Design pass F3. Separates a release logged after its commit from one logged inside the
	// transaction: the session is revoked after the hook resolved it, so the commit rolls the delete
	// back, and a line written inside the change would record a lift that never happened.
	it('logs nothing for a lift rolled back by a session revoked mid-request', async () => {
		const admin = await seedAccount('log-rollback', 'ADMIN');
		const token = await signIn(admin.id);
		await post('haltInference', token);
		const resolved = await readSessionUser(token);
		await prisma.session.update({
			where: { id: await sessionIdOf(token) },
			data: { revokedAt: new Date() }
		});
		logged.length = 0;

		const answer = await post(
			'liftInferenceHalt',
			token,
			{ [REAUTH_FIELDS.password]: PASSWORD },
			resolved
		);

		expect({
			answer,
			halted: (await readInferenceHalt()) !== null,
			resumed: logged.filter((line) => line.event === EVENT.aiInferenceResumed).length
		}).toEqual({ answer: { redirect: '/login' }, halted: true, resumed: 0 });
	});
});
