import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as OTPAuth from 'otpauth';
import { isRedirect, type Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	commitWithRotatedToken,
	createSession,
	hashPassword,
	hashSessionToken,
	lifetimeEndsAt,
	readSessionUser,
	SESSION_COOKIE,
	verifyPassword
} from '$lib/server/auth';
import { REAUTH_FACTORS, type ReauthAction } from '$lib/server/auth/reauth';
import { encryptTotpSecret, generateTotpSecretBase32 } from '$lib/server/auth/totp';
import { buildBackupExport } from '$lib/server/backup/export';
import { REAUTH_FIELDS } from '$lib/domain/reauthFields';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { computeNameKey } from '$lib/server/naming/nameKey';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';

/**
 * S1b (#249, R3 on #841), against a real engine: `ASVS v5.0.0-7.2.4`, « a new session token on user
 * authentication, including re-authentication, and terminates the current session token ».
 *
 * THE FIGURE is the brief's: after a re-authentication succeeds, how many LIVE sessions still carry
 * the token hash the request arrived with. Measured on main before the change, 1 for every action
 * but `deleteAccount` (which deletes every session), so a copy of the cookie taken before the owner
 * changed their password kept working after it.
 *
 * ENUMERATED FROM THE REGISTRY. `CASES` is typed `Record<ReauthAction, Case>`, so an action added to
 * `REAUTH_FACTORS` without a case here is a compile error, and the first test asserts the key sets
 * agree at run time too. Every case drives the REAL route action with `locals.user` resolved by
 * `readSessionUser`, the call `handleAuth` makes, so the session rotated is the one the hook
 * resolved and not one this file chose.
 *
 * Every other test here reads a database outcome a unit spec's fake would decide for itself: whether
 * a conditional update matched (a session revoked, or rotated by a concurrent request, while this
 * one ran), and which session row a token resolves to afterwards.
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

const PASSWORD = 'rotation-smoke-password';
const NEW_PASSWORD = 'rotation-smoke-new-password';
const created: string[] = [];

let addressCounter = 0;
function freshAddress(): string {
	addressCounter += 1;
	return `203.0.113.${addressCounter}`;
}

interface WrittenCookie {
	value: string;
	expires: Date | undefined;
}

/**
 * The browser's side of one request: it PRESENTS `presented`, and records what the response writes.
 * `get` answers a cookie set during the request, as SvelteKit's does, so a route that reads the
 * cookie after rotating sees the new value.
 */
function browser(presented: string | undefined) {
	let written: WrittenCookie | null = null;
	let deleted = false;
	const cookies = {
		get: (name: string) => {
			if (name !== SESSION_COOKIE) return undefined;
			if (deleted) return undefined;
			return written ? written.value : presented;
		},
		set: (name: string, value: string, options: { expires?: Date }) => {
			if (name !== SESSION_COOKIE) return;
			written = { value, expires: options.expires };
			deleted = false;
		},
		delete: (name: string) => {
			if (name !== SESSION_COOKIE) return;
			written = null;
			deleted = true;
		}
	} as unknown as Cookies;
	return {
		cookies,
		written: () => written,
		deleted: () => deleted
	};
}

async function seedAccount(
	tag: string,
	options: { totpSecret?: string; role?: 'ADMIN' | 'USER'; forcePasswordChange?: boolean } = {}
) {
	const user = await prisma.user.create({
		data: {
			email: `rotation-smoke-${tag}-${crypto.randomUUID()}@budgetpilot.invalid`,
			passwordHash: await hashPassword(PASSWORD),
			role: options.role ?? 'USER',
			forcePasswordChange: options.forcePasswordChange ?? false,
			...(options.totpSecret
				? { totpEnabled: true, totpSecretEncrypted: encryptTotpSecret(options.totpSecret) }
				: {})
		},
		select: { id: true }
	});
	created.push(user.id);
	return user;
}

/** A session through the real write path, returned as its token and its row. */
async function mintSession(userId: string): Promise<{ token: string; id: string }> {
	const minted = browser(undefined);
	await createSession(userId, minted.cookies);
	const token = minted.written()?.value ?? '';
	const row = await prisma.session.findUniqueOrThrow({
		where: { tokenHash: hashSessionToken(token) },
		select: { id: true }
	});
	return { token, id: row.id };
}

/** Live sessions whose token hash is the one `token` hashes to: the figure. */
function liveSessionsCarrying(token: string): Promise<number> {
	return prisma.session.count({
		where: { tokenHash: hashSessionToken(token), revokedAt: null, expiresAt: { gt: new Date() } }
	});
}

function totpCode(secret: string): string {
	return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

type Route = 'settings' | 'admin';

interface Arranged {
	/** The account whose session re-authenticates. */
	callerId: string;
	/** The action's own fields, valid, plus the right secrets. */
	form: FormData;
	/**
	 * Whether the action's change reached the database, read from the rows it writes. Calibrated by
	 * the success test (true) before the revoked-session test relies on it (false).
	 */
	landed: () => Promise<boolean>;
}

/** Whether a session row has been revoked. */
async function revoked(sessionId: string): Promise<boolean> {
	const row = await prisma.session.findUnique({
		where: { id: sessionId },
		select: { revokedAt: true }
	});
	return row?.revokedAt != null;
}

/** Whether the account has a second factor enabled. */
async function totpEnabled(userId: string): Promise<boolean> {
	const row = await prisma.user.findUnique({
		where: { id: userId },
		select: { totpEnabled: true }
	});
	return row?.totpEnabled === true;
}

interface Case {
	route: Route;
	/** Whether the session survives the action. Only deleting one's own account ends it. */
	session: 'rotated' | 'ended';
	arrange: () => Promise<Arranged>;
}

function formOf(fields: Record<string, string | File>): FormData {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return form;
}

const secrets = (extra: Record<string, string> = {}) => ({
	[REAUTH_FIELDS.password]: PASSWORD,
	...extra
});

const CASES: Record<ReauthAction, Case> = {
	revokeSession: {
		route: 'settings',
		session: 'rotated',
		arrange: async () => {
			const user = await seedAccount('revoke-one');
			const other = await mintSession(user.id);
			return {
				callerId: user.id,
				form: formOf({ ...secrets(), sessionId: other.id }),
				landed: () => revoked(other.id)
			};
		}
	},
	revokeOtherSessions: {
		route: 'settings',
		session: 'rotated',
		arrange: async () => {
			const user = await seedAccount('revoke-others');
			const other = await mintSession(user.id);
			return { callerId: user.id, form: formOf(secrets()), landed: () => revoked(other.id) };
		}
	},
	changePassword: {
		route: 'settings',
		session: 'rotated',
		arrange: async () => {
			const user = await seedAccount('change-password');
			return {
				callerId: user.id,
				form: formOf({
					...secrets(),
					newPassword: NEW_PASSWORD,
					confirmPassword: NEW_PASSWORD
				}),
				landed: async () => {
					const row = await prisma.user.findUniqueOrThrow({
						where: { id: user.id },
						select: { passwordHash: true }
					});
					return verifyPassword(NEW_PASSWORD, row.passwordHash);
				}
			};
		}
	},
	deleteAccount: {
		route: 'settings',
		session: 'ended',
		arrange: async () => {
			const user = await seedAccount('delete-account');
			return {
				callerId: user.id,
				form: formOf({ ...secrets(), confirmation: m.settings_delete_confirmation_phrase() }),
				landed: async () => (await prisma.user.count({ where: { id: user.id } })) === 0
			};
		}
	},
	disableTotp: {
		route: 'settings',
		session: 'rotated',
		arrange: async () => {
			const secret = generateTotpSecretBase32();
			const user = await seedAccount('disable-totp', { totpSecret: secret });
			return {
				callerId: user.id,
				form: formOf(secrets({ [REAUTH_FIELDS.code]: totpCode(secret) })),
				landed: async () => !(await totpEnabled(user.id))
			};
		}
	},
	confirmTotpSetup: {
		route: 'settings',
		session: 'rotated',
		arrange: async () => {
			const user = await seedAccount('enrol-totp');
			const secret = generateTotpSecretBase32();
			return {
				callerId: user.id,
				form: formOf({
					...secrets({ [REAUTH_FIELDS.code]: totpCode(secret) }),
					secretBase32: secret
				}),
				landed: () => totpEnabled(user.id)
			};
		}
	},
	restoreData: {
		route: 'settings',
		session: 'rotated',
		arrange: async () => {
			const user = await seedAccount('restore');
			const backup = JSON.stringify(await buildBackupExport(user.id));
			const file = new File([backup], 'backup.json', { type: 'application/json' });
			return {
				callerId: user.id,
				form: formOf({ ...secrets(), backupFile: file }),
				// Every restore guarantees the « to classify » category, which this account, seeded
				// without defaults, does not have before one.
				landed: async () =>
					(await prisma.category.count({
						where: { userId: user.id, nameKey: computeNameKey(UNCLASSIFIED_CATEGORY) }
					})) > 0
			};
		}
	},
	deleteUser: {
		route: 'admin',
		session: 'rotated',
		arrange: async () => {
			const admin = await seedAccount('admin-delete', { role: 'ADMIN' });
			const target = await seedAccount('admin-delete-target');
			return {
				callerId: admin.id,
				form: formOf({ ...secrets(), targetUserId: target.id }),
				landed: async () => (await prisma.user.count({ where: { id: target.id } })) === 0
			};
		}
	},
	resetPassword: {
		route: 'admin',
		session: 'rotated',
		arrange: async () => {
			const admin = await seedAccount('admin-reset', { role: 'ADMIN' });
			const target = await seedAccount('admin-reset-target');
			return {
				callerId: admin.id,
				form: formOf({ ...secrets(), targetUserId: target.id }),
				landed: async () =>
					(
						await prisma.user.findUniqueOrThrow({
							where: { id: target.id },
							select: { forcePasswordChange: true }
						})
					).forcePasswordChange
			};
		}
	}
};

async function routeActions(route: Route): Promise<Record<string, unknown>> {
	if (route === 'settings') return (await import('../../../routes/settings/+page.server')).actions;
	return (await import('../../../routes/admin/+page.server')).actions;
}

/**
 * Runs `action` as the request a browser presenting `token` makes. A thrown redirect is the
 * action's answer, not a failure, so it is returned.
 */
async function post(
	route: Route,
	action: string,
	token: string,
	form: FormData,
	locals: { user: Awaited<ReturnType<typeof readSessionUser>> } | null = null
) {
	const actions = await routeActions(route);
	const run = actions[action] as (event: unknown) => Promise<unknown>;
	const request = browser(token);
	const event = {
		cookies: request.cookies,
		getClientAddress: () => freshAddress(),
		request: new Request(`http://localhost/${route}`, { method: 'POST', body: form }),
		locals: locals ?? { user: await readSessionUser(token) },
		url: new URL(`http://localhost/${route}`)
	};
	let answer: unknown;
	try {
		answer = await run(event);
	} catch (thrown) {
		if (!isRedirect(thrown)) throw thrown;
		answer = { redirect: thrown.location };
	}
	return { answer, ...request };
}

/** Whether an action's answer is its refusal: a `fail()` carries a status. */
function refused(answer: unknown): boolean {
	return typeof answer === 'object' && answer !== null && 'status' in answer;
}

beforeAll(() => {
	env.RATE_LIMIT_HASH_SECRET = 'e5'.repeat(32);
	env.TOTP_ENCRYPTION_KEY = 'f6'.repeat(32);
});

afterAll(async () => {
	// Sessions, recovery codes and attempt rows cascade from User or are keyed by a session hash.
	await prisma.user.deleteMany({ where: { id: { in: created } } });
});

describe('every re-authenticating action ends the token it arrived with (v5.0.0-7.2.4)', () => {
	it('has a case for exactly the actions in REAUTH_FACTORS', () => {
		expect.assertions(1);
		expect(Object.keys(CASES).sort()).toEqual(Object.keys(REAUTH_FACTORS).sort());
	});

	// Per action, three observations, each separating two states:
	// - live sessions carrying the PRESENTED hash afterwards: 1 « the copy still works » vs 0;
	// - the action succeeded: « rotated because it ran » vs « no live hash because it refused »,
	//   which is what makes the 0 able to mean anything;
	// - its change landed: the calibration of the probe the revoked-session test below relies on.
	for (const [action, testCase] of Object.entries(CASES)) {
		it(`${action}: no live session carries the token presented before it`, async () => {
			expect.assertions(3);
			const { callerId, form, landed } = await testCase.arrange();
			const caller = await mintSession(callerId);

			const { answer } = await post(testCase.route, action, caller.token, form);

			expect(refused(answer), JSON.stringify(answer)).toBe(false);
			expect(await liveSessionsCarrying(caller.token)).toBe(0);
			expect(await landed()).toBe(true);
		});
	}

	// Every action writes INSIDE the rotating commit, never beside it: on a session revoked after the
	// hook resolved it (another device, or a logout in another tab), the commit's compare-and-set
	// fails and the change rolls back with it. Separates « written inside the commit » from « written
	// in its own transaction, then a commit with nothing in it », which reads the same on success.
	for (const [action, testCase] of Object.entries(CASES)) {
		it(`${action}: on a session revoked mid-request, answered with /login and nothing written`, async () => {
			expect.assertions(2);
			const { callerId, form, landed } = await testCase.arrange();
			const caller = await mintSession(callerId);
			const resolved = await readSessionUser(caller.token);
			await prisma.session.update({ where: { id: caller.id }, data: { revokedAt: new Date() } });

			const { answer } = await post(testCase.route, action, caller.token, form, {
				user: resolved
			});

			expect(answer).toEqual({ redirect: '/login' });
			expect(await landed()).toBe(false);
		});
	}

	// The other half of « rotated »: the browser that re-authenticated is still signed in, on the
	// SAME session row, with the SAME lifetime. Separates « rotated » from « revoked » (the owner
	// would be signed out by their own password change), « rotated » from « a new session »
	// (which would reset the per-session counter of #879, drop the row from the session list and
	// restart the lifetime), and « rotated » from « extended » (the absolute lifetime of
	// `v5.0.0-7.3.2` counts from `createdAt`). The change is a use, so `expiresAt` may slide forward
	// within that lifetime (#221), never back.
	for (const [action, testCase] of Object.entries(CASES)) {
		if (testCase.session !== 'rotated') continue;
		it(`${action}: the response signs the browser into the same session, same lifetime`, async () => {
			expect.assertions(5);
			const { callerId, form } = await testCase.arrange();
			const caller = await mintSession(callerId);
			const before = await prisma.session.findUniqueOrThrow({
				where: { id: caller.id },
				select: { createdAt: true, expiresAt: true }
			});

			const { written } = await post(testCase.route, action, caller.token, form);
			const cookie = written();

			expect(cookie?.value).not.toBe(caller.token);
			expect((await readSessionUser(cookie?.value))?.sessionId).toBe(caller.id);
			const after = await prisma.session.findUniqueOrThrow({
				where: { id: caller.id },
				select: { createdAt: true, expiresAt: true }
			});
			expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
			expect(after.expiresAt.getTime()).toBeGreaterThanOrEqual(before.expiresAt.getTime());
			expect(cookie?.expires?.getTime()).toBe(lifetimeEndsAt(before.createdAt).getTime());
		});
	}

	it('deleteAccount: the cookie is cleared and no row is left to sign into', async () => {
		expect.assertions(2);
		const { callerId, form } = await CASES.deleteAccount.arrange();
		const caller = await mintSession(callerId);

		const { deleted } = await post('settings', 'deleteAccount', caller.token, form);

		expect(deleted()).toBe(true);
		expect(await prisma.session.count({ where: { userId: callerId } })).toBe(0);
	});
});

describe('a session that ended while the request ran commits nothing', () => {
	// The owner revokes the thief's session from another device after the hook resolved the thief's
	// request and before its re-authentication finished. Separates « the change is refused » from
	// « the change lands on a session that no longer exists »: the other session must stay live.
	it('revoked mid-request: answered with /login, and the other session is untouched', async () => {
		expect.assertions(3);
		const user = await seedAccount('revoked-mid-request');
		const thief = await mintSession(user.id);
		const owner = await mintSession(user.id);
		const resolved = await readSessionUser(thief.token);
		await prisma.session.update({ where: { id: thief.id }, data: { revokedAt: new Date() } });

		const { answer, written } = await post(
			'settings',
			'revokeOtherSessions',
			thief.token,
			formOf(secrets()),
			{ user: resolved }
		);

		expect(answer).toEqual({ redirect: '/login' });
		expect(written()).toBeNull();
		expect(await readSessionUser(owner.token)).not.toBeNull();
	});

	// Two tabs, one cookie, both re-authenticated at once. Separates « one rotation wins and the
	// other is sent to sign in » from « both write a token and the browser keeps whichever response
	// arrived last », which on main's absence of rotation reads as two successes.
	it('two concurrent re-authentications on one cookie: one rotates, the other is sent to /login', async () => {
		expect.assertions(3);
		const user = await seedAccount('concurrent');
		const caller = await mintSession(user.id);
		const resolved = await readSessionUser(caller.token);

		const [first, second] = await Promise.all([
			post('settings', 'revokeOtherSessions', caller.token, formOf(secrets()), { user: resolved }),
			post('settings', 'revokeOtherSessions', caller.token, formOf(secrets()), { user: resolved })
		]);
		const answers = [first, second];
		const winners = answers.filter((one) => one.written() !== null);

		expect(winners).toHaveLength(1);
		expect(answers.filter((one) => one.written() === null).map((one) => one.answer)).toEqual([
			{ redirect: '/login' }
		]);
		expect((await readSessionUser(winners[0]?.written()?.value))?.sessionId).toBe(caller.id);
	});
});

describe('a password change ends every token that existed before it', () => {
	// R3: « changePassword revokes all sessions including the caller's and issues a fresh one ». The
	// other device is revoked and the caller's own old token dies with it; the caller keeps a new one.
	it('changePassword: the other device is signed out, the caller is not', async () => {
		expect.assertions(3);
		const user = await seedAccount('change-password-others');
		const caller = await mintSession(user.id);
		const other = await mintSession(user.id);

		const { written } = await post(
			'settings',
			'changePassword',
			caller.token,
			formOf({ ...secrets(), newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
		);

		expect(await readSessionUser(other.token)).toBeNull();
		expect(await readSessionUser(caller.token)).toBeNull();
		expect((await readSessionUser(written()?.value))?.sessionId).toBe(caller.id);
	});

	// The fourth writer of `passwordHash` an account's own session reaches (#880 enumerates them).
	// It asks for no current password (#880 owns that), so this is rotation without re-authentication:
	// a token that predates the new password does not outlive it.
	it('force-password-change: the presented token dies and the browser keeps a new one', async () => {
		expect.assertions(6);
		const user = await seedAccount('forced', { forcePasswordChange: true });
		const caller = await mintSession(user.id);
		const other = await mintSession(user.id);
		const { actions } = await import('../../../routes/force-password-change/+page.server');
		const request = browser(caller.token);
		const form = formOf({ newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

		await expect(
			(actions.default as (event: unknown) => Promise<unknown>)({
				cookies: request.cookies,
				request: new Request('http://localhost/force-password-change', {
					method: 'POST',
					body: form
				}),
				locals: { user: await readSessionUser(caller.token) }
			})
		).rejects.toSatisfy((thrown: unknown) => isRedirect(thrown) && thrown.location === '/');

		expect(await liveSessionsCarrying(caller.token)).toBe(0);
		expect((await readSessionUser(request.written()?.value))?.sessionId).toBe(caller.id);
		// The other device is revoked by the session id, against a real engine: a token-hash
		// predicate here would revoke the caller's own, already rotated, row instead of sparing it.
		expect(await readSessionUser(other.token)).toBeNull();
		const after = await prisma.user.findUniqueOrThrow({
			where: { id: user.id },
			select: { passwordHash: true, forcePasswordChange: true }
		});
		expect(after.forcePasswordChange).toBe(false);
		expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
	});
});

describe('the token changes with the change, and only with it', () => {
	// The rotation is part of the change's commit, so a re-authentication whose action then refuses
	// (an id that is not the caller's, a backup that does not parse) changes nothing, the token
	// included. Recorded as the decision on #249: rotating at the proof instead left the action's
	// whole work as a window in which a logout could not find the session. Separates « rotated with
	// the change » from « rotated at the proof ».
	it('revokeSession on an unknown id: 404, nothing written, the presented token still live', async () => {
		expect.assertions(3);
		const user = await seedAccount('refused-after');
		const caller = await mintSession(user.id);

		const { answer, written } = await post(
			'settings',
			'revokeSession',
			caller.token,
			formOf({ ...secrets(), sessionId: 'no-such-session' })
		);

		expect(answer).toMatchObject({ status: 404 });
		expect(written()).toBeNull();
		expect(await liveSessionsCarrying(caller.token)).toBe(1);
	});

	// The rotation is the LAST statement of the change's transaction. Here the revocation is written
	// by the change itself, through its own transaction, which is the one placement that is ordered
	// the same way on every engine: a write from outside cannot be scheduled into the middle of the
	// transaction deterministically. Separates « rotation last: the revocation is seen and the change
	// rolls back » from « rotation first: the compare-and-set passes before the revocation, and the
	// change commits for a session that is over ». The stand-in revocation rolls back with the change,
	// so whether the session survives is not asserted: that is an artefact of where it was written.
	it('a revocation that lands during the change rolls the change back', async () => {
		expect.assertions(3);
		const user = await seedAccount('revoked-during');
		await prisma.user.update({ where: { id: user.id }, data: { aiInsightsEnabled: true } });
		const caller = await mintSession(user.id);
		const request = browser(caller.token);

		await expect(
			commitWithRotatedToken({ sessionId: caller.id }, request.cookies, async (tx) => {
				await tx.user.update({ where: { id: user.id }, data: { aiInsightsEnabled: false } });
				await tx.session.update({ where: { id: caller.id }, data: { revokedAt: new Date() } });
			})
		).rejects.toSatisfy((thrown: unknown) => isRedirect(thrown) && thrown.location === '/login');

		const after = await prisma.user.findUniqueOrThrow({
			where: { id: user.id },
			select: { aiInsightsEnabled: true }
		});
		expect(after.aiInsightsEnabled).toBe(true);
		expect(request.written()).toBeNull();
	});

	// The calibration of the test above: the same change on a live session commits, rotates and
	// hands the browser the new token. Without it, « rolled back » could be a change that never runs.
	it('the same change on a live session commits and rotates', async () => {
		expect.assertions(3);
		const user = await seedAccount('live-during');
		await prisma.user.update({ where: { id: user.id }, data: { aiInsightsEnabled: true } });
		const caller = await mintSession(user.id);
		const request = browser(caller.token);

		await commitWithRotatedToken({ sessionId: caller.id }, request.cookies, async (tx) => {
			await tx.user.update({ where: { id: user.id }, data: { aiInsightsEnabled: false } });
		});

		const after = await prisma.user.findUniqueOrThrow({
			where: { id: user.id },
			select: { aiInsightsEnabled: true }
		});
		expect(after.aiInsightsEnabled).toBe(false);
		expect(await liveSessionsCarrying(caller.token)).toBe(0);
		expect((await readSessionUser(request.written()?.value))?.sessionId).toBe(caller.id);
	});

	// Two sessions of one account revoking each other at once lock the two rows in opposite orders.
	// PostgreSQL and MariaDB abort one side as a deadlock; retried whole, its compare-and-set sees the
	// other's revocation and it is sent to sign in. Separates « one commits, the other is sent to
	// /login » from « the other answers a 500 » (the second contradiction pass on #249). A gate holds
	// each change until both have taken their first lock, which is what makes the deadlock certain on
	// the two server engines; SQLite runs the two one after the other, the gate gives up after a
	// second, and the answer must be the same.
	it('two sessions revoking each other at once: one commits, the other is sent to /login', async () => {
		expect.assertions(3);
		const user = await seedAccount('mutual-revoke');
		const first = await mintSession(user.id);
		const second = await mintSession(user.id);
		let arrived = 0;
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
			setTimeout(resolve, 1000);
		});
		const revokeTheOther = (mine: { id: string; token: string }, theirs: { id: string }) =>
			commitWithRotatedToken({ sessionId: mine.id }, browser(mine.token).cookies, async (tx) => {
				await tx.session.updateMany({
					where: { id: theirs.id, revokedAt: null },
					data: { revokedAt: new Date() }
				});
				arrived += 1;
				if (arrived >= 2) open();
				await gate;
			});

		const outcomes = await Promise.allSettled([
			revokeTheOther(first, second),
			revokeTheOther(second, first)
		]);

		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
		expect(
			outcomes
				.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
				.map(({ reason }) => (isRedirect(reason) ? reason.location : String(reason)))
		).toEqual(['/login']);
		expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
	});
});

describe('a logout ends the session, whatever token it carries', () => {
	// Two tabs on one cookie. Tab B's logout was resolved by the hook BEFORE tab A's re-authenticated
	// change committed, then reaches its handler after: its token no longer matches any row. Separates
	// « logout by the session's id: the session ends, and A's new cookie signs into nothing » from
	// « logout by the token: it ends nothing, and A's response signs the browser back in » (the
	// contradiction pass on #249).
	it('a logout resolved before a rotation still ends the session after it', async () => {
		expect.assertions(4);
		const user = await seedAccount('logout-race');
		const caller = await mintSession(user.id);
		const tabB = await readSessionUser(caller.token);

		const tabA = await post('settings', 'revokeOtherSessions', caller.token, formOf(secrets()));
		const rotated = tabA.written()?.value;
		expect((await readSessionUser(rotated))?.sessionId).toBe(caller.id);

		const { POST } = await import('../../../routes/logout/+server');
		const logout = browser(caller.token);
		await expect(
			(POST as (event: unknown) => Promise<unknown>)({
				cookies: logout.cookies,
				locals: { user: tabB }
			})
		).rejects.toSatisfy((thrown: unknown) => isRedirect(thrown) && thrown.location === '/login');

		expect(logout.deleted()).toBe(true);
		expect(await readSessionUser(rotated)).toBeNull();
	});
});

describe('signing in ends the session the browser already held (v5.0.0-7.2.4, « terminates »)', () => {
	// `/login` redirects a signed-in visitor on GET, but its action never looks: a POST from a
	// browser that still holds a live cookie mints a second session and leaves the first one live.
	// Separates « the presented token is terminated » from « replaced in the browser only ».
	it('a sign-in over a live cookie leaves no live session carrying the old token', async () => {
		expect.assertions(3);
		const user = await prisma.user.findUniqueOrThrow({
			where: { id: (await seedAccount('sign-in-over')).id },
			select: { id: true, email: true }
		});
		const held = await mintSession(user.id);
		const { actions } = await import('../../../routes/login/+page.server');
		const request = browser(held.token);

		await expect(
			(actions.default as (event: unknown) => Promise<unknown>)({
				cookies: request.cookies,
				getClientAddress: () => freshAddress(),
				request: new Request('http://localhost/login', {
					method: 'POST',
					body: formOf({ email: user.email, password: PASSWORD })
				}),
				url: new URL('http://localhost/login')
			})
		).rejects.toSatisfy((thrown: unknown) => isRedirect(thrown));

		expect(await liveSessionsCarrying(held.token)).toBe(0);
		expect(await readSessionUser(request.written()?.value)).not.toBeNull();
	});
});
