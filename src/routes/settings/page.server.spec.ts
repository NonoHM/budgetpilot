import { createCipheriv, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
	// The log pseudonyms (L3, #250) derive their keys from it, and refuse anything but 64 hex.
	process.env.RATE_LIMIT_HASH_SECRET ??= 'a1'.repeat(32);
});

const fs = vi.hoisted(() => ({
	existsSync: vi.fn(() => false)
}));

const tx = vi.hoisted(() => ({
	user: {
		update: vi.fn(),
		delete: vi.fn()
	},
	session: {
		updateMany: vi.fn(),
		deleteMany: vi.fn()
	},
	pendingMfaChallenge: {
		deleteMany: vi.fn(async () => ({ count: 0 }))
	},
	transaction: {
		deleteMany: vi.fn()
	},
	recoveryCode: {
		deleteMany: vi.fn(),
		createMany: vi.fn()
	}
}));

const db = vi.hoisted(() => ({
	prisma: {
		user: {
			findUnique: vi.fn(),
			findUniqueOrThrow: vi.fn(),
			update: vi.fn(),
			// The step a valid code records (#818): accepted. The engine's answer is
			// `totpSingleUse.db-smoke.ts`'s; here the action's outcome is what is tested.
			updateMany: vi.fn(async () => ({ count: 1 }))
		},
		session: {
			findMany: vi.fn(),
			findUnique: vi.fn(),
			findFirst: vi.fn(),
			updateMany: vi.fn()
		},
		recoveryCode: {
			deleteMany: vi.fn(),
			createMany: vi.fn(),
			// Read and spent only by a re-authentication that accepts a recovery code (#904). The
			// #904 describe gives them the sign-in route's semantics; elsewhere they answer nothing.
			findMany: vi.fn(),
			updateMany: vi.fn()
		},
		// The Comptes section's read. Defaulted to an empty list in every `beforeEach` rather than
		// left undefined: an absent mock makes the whole `load` throw, and every test in this file
		// then fails for a reason that has nothing to do with what it asserts.
		account: {
			findMany: vi.fn()
		},
		$transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
	}
}));

const netWorthService = vi.hoisted(() => ({
	readLinkableNetWorthAccounts: vi.fn(async () => [] as { id: string; name: string }[])
}));

const backupImport = vi.hoisted(() => {
	class BackupImportError extends Error {}
	return {
		restoreBackup: vi.fn(),
		BackupImportError
	};
});

// Mocked at the service boundary, not at Prisma: renameTag/recolorTag/deleteTag/
// listTagsWithCounts are already covered by server/tags/service.spec.ts, including the
// userId-scoping and the not-found-vs-another-user's-tag equivalence. This file only needs to
// prove the ACTION maps each service outcome to the right response, not re-derive the service's
// own guarantees.
const tagsService = vi.hoisted(() => ({
	listTagsWithCounts: vi.fn(),
	renameTag: vi.fn(),
	recolorTag: vi.fn(),
	deleteTag: vi.fn()
}));

// Same boundary, same reasoning: `store.db-smoke.ts` covers the userId scoping of
// `deleteColumnMapping` and `listColumnMappings` against a real database on all three engines,
// including a user naming another user's id. This file proves only that the ACTION maps each
// outcome to the right response and that the LOAD shapes the rows for the page.
const mappingStore = vi.hoisted(() => ({
	// Typed WIDE on purpose. `vi.fn(async () => [])` infers `never[]`, so a test that supplied a
	// realistic row would fail to compile against its own fixture, and the usual repair is to cast
	// the fixture — which is how a spec stops asserting the shape the page actually receives.
	listColumnMappings: vi.fn<() => Promise<Record<string, unknown>[]>>(async () => []),
	deleteColumnMapping: vi.fn<() => Promise<'deleted' | 'not-found'>>(async () => 'deleted'),
	resolveColumnMappingsPerUser: vi.fn<() => number>(() => 50)
}));

// The shared re-auth limiter is mocked here so this file tests the ORCHESTRATION (does each
// sensitive action check the limiter and record on a wrong secret), not the limiter's SQL, which
// lives in rateLimit.spec.ts. Default: never limited. Tests that need a tripped counter override
// isReauthRateLimited.mockResolvedValueOnce(true).
const rateLimit = vi.hoisted(() => ({
	isReauthRateLimited: vi.fn(async () => false),
	recordReauthAttempt: vi.fn(async () => {})
}));

vi.mock('node:fs', () => fs);
vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/backup/import', () => backupImport);
vi.mock('$lib/server/tags/service', () => tagsService);
vi.mock('$lib/server/auth/rateLimit', () => rateLimit);
vi.mock('$lib/server/import/mapping/store', () => mappingStore);
// #599: the remembered accounts. Their `userId` scoping is proven on three engines in
// `import/accountMemory.db-smoke.ts` and through this route in `rememberedAccounts.db-smoke.ts`;
// here only the load's wiring and the action's mapping of outcomes to responses.
const accountMemory = vi.hoisted(() => ({
	listRememberedAccounts: vi.fn<() => Promise<Record<string, unknown>[]>>(async () => []),
	forgetRememberedAccount: vi.fn<
		(userId: string, id: string) => Promise<'forgotten' | 'not-found'>
	>(async () => 'forgotten')
}));
vi.mock('$lib/server/import/accountMemory', () => accountMemory);
vi.mock('$lib/server/net-worth/service', () => netWorthService);
// Every line the route writes, through the one writer, captured instead of printed (#904 reads the
// decryption-failure line; the other tests ignore it).
const logWriter = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('$lib/server/logging', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/logging')>()),
	log: logWriter.log
}));
// The re-authentication helper runs for real; the spy only lets a test read the REASON it decided,
// which no response carries (#854 class 2: the screen gets one sentence whatever failed).
// The commit a re-authenticated change goes through rotates the session token in the same
// transaction (#249). The rotation is `sessionRotation.db-smoke.ts`'s, against a real engine, where
// every action in `REAUTH_FACTORS` is driven through this route. Here the commit runs the change on
// the fake transaction and rotates nothing, so the fake needs no session row to compare-and-set.
vi.mock('$lib/server/auth', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/auth')>();
	type Change = (client: typeof tx) => Promise<unknown>;
	return {
		...real,
		commitWithRotatedToken: vi.fn(async (_user: unknown, _cookies: unknown, change: Change) =>
			db.prisma.$transaction(change)
		),
		commitEndingSession: vi.fn(async (_user: unknown, _cookies: unknown, change: Change) =>
			db.prisma.$transaction(change)
		)
	};
});
vi.mock('$lib/server/auth/reauth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/auth/reauth')>();
	return { ...actual, reauthenticate: vi.fn(actual.reauthenticate) };
});

const { commitWithRotatedToken, hashPassword, SESSION_COOKIE } = await import('$lib/server/auth');
const reauth = await import('$lib/server/auth/reauth');
const { actions, load } = await import('./+page.server');

describe('/settings', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		delete process.env.LLM_ENABLED;
		fs.existsSync.mockReturnValue(false);
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
		// mockReset (not just clearAllMocks) so a mockResolvedValueOnce left UNCONSUMED by one test
		// cannot bleed a stale "true" into the next action's limiter check. clearAllMocks does not
		// drain the once-queue; only a reset does. Re-establish the default afterwards.
		rateLimit.isReauthRateLimited.mockReset();
		rateLimit.isReauthRateLimited.mockResolvedValue(false);
		rateLimit.recordReauthAttempt.mockReset();
		rateLimit.recordReauthAttempt.mockResolvedValue(undefined);
		mappingStore.listColumnMappings.mockResolvedValue([]);
		mappingStore.deleteColumnMapping.mockResolvedValue('deleted');
		mappingStore.resolveColumnMappingsPerUser.mockReturnValue(50);
		db.prisma.account.findMany.mockResolvedValue([]);
		netWorthService.readLinkableNetWorthAccounts.mockResolvedValue([]);
	});

	it('charge uniquement les sessions du user connecté sans exposer token hash ni passwordHash', async () => {
		expect.assertions(8);

		const token = 'session-courante';
		// expiresAt is compared against the real system clock (new Date()) by the source under
		// test, not a mocked one — must stay relative to "now" rather than a fixed calendar
		// date, or this becomes a time bomb once the real date passes it (a hardcoded
		// 2026-07-20 previously broke on/after 2026-07-21).
		const sessionCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			email: 'user-a@example.test',
			role: 'USER'
		});
		// Two rows, so « current » is decided rather than defaulted: the row the hook resolved
		// (`locals.user.sessionId`) is current and the other is not, whatever the cookie holds. The
		// cookie may already carry a token rotated earlier in this request (#249).
		// First the account's sessions, then which of them the engine judges live (#221). Which rows
		// the predicate keeps is asserted against a real engine in `auth/sessionIdle.db-smoke.ts`;
		// here the fake answers it, so this test reads only the mapping and the query's scope.
		db.prisma.session.findMany
			.mockResolvedValueOnce([
				{ id: 'session-a', createdAt: sessionCreatedAt, expiresAt: sessionExpiresAt },
				{ id: 'session-b', createdAt: sessionCreatedAt, expiresAt: sessionExpiresAt }
			])
			.mockResolvedValueOnce([{ id: 'session-a' }, { id: 'session-b' }]);

		const result = (await load(buildLoadEvent({ token }) as never)) as {
			account: { email: string; role: string };
			security: { authMode: string; runtime: string };
			sessions: Array<{
				id: string;
				createdAt: Date;
				expiresAt: Date;
				isCurrent: boolean;
				status: 'active' | 'revoked';
			}>;
		};

		expect(db.prisma.session.findMany).toHaveBeenCalledWith({
			where: { userId: 'user-a' },
			select: {
				id: true,
				createdAt: true,
				expiresAt: true
			},
			orderBy: { createdAt: 'desc' }
		});
		// The live query is scoped to the same account: another account's live session id cannot
		// mark a row here active.
		expect(db.prisma.session.findMany.mock.calls[1][0].where.userId).toBe('user-a');
		expect(result.account).toEqual({
			email: 'user-a@example.test',
			role: 'USER'
		});
		expect(result.sessions).toEqual([
			{
				id: 'session-a',
				createdAt: sessionCreatedAt,
				expiresAt: sessionExpiresAt,
				isCurrent: true,
				status: 'active'
			},
			{
				id: 'session-b',
				createdAt: sessionCreatedAt,
				expiresAt: sessionExpiresAt,
				isCurrent: false,
				status: 'active'
			}
		]);
		expect(result.security.authMode).toBe('locale');
		expect(result.security.runtime).toBe('local');
		expect(JSON.stringify(result)).not.toContain('tokenHash');
		expect(JSON.stringify(result)).not.toContain('passwordHash');
	});

	it('expose les préférences IA de l’utilisateur courant et l’état global du LLM', async () => {
		expect.assertions(1);

		vi.stubEnv('LLM_ENABLED', 'true');
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			email: 'user-a@example.test',
			role: 'USER',
			aiInsightsEnabled: false,
			aiIncludeLabels: true
		});
		db.prisma.session.findMany.mockResolvedValue([]);

		const result = (await load(buildLoadEvent({ token: 'session-courante' }) as never)) as {
			aiSettings: { insightsEnabled: boolean; includeLabels: boolean; llmGloballyEnabled: boolean };
		};

		expect(result.aiSettings).toEqual({
			insightsEnabled: false,
			includeLabels: true,
			llmGloballyEnabled: true
		});
	});

	it('expose les indicateurs de sécurité et marque les sessions qui ne sont plus actives pour l UI', async () => {
		expect.assertions(3);

		vi.stubEnv('LLM_ENABLED', 'true');
		fs.existsSync.mockReturnValue(true);
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			email: 'user-a@example.test',
			role: 'USER'
		});
		// Two sessions the engine no longer counts live (revoked, expired or idle: its predicate
		// decides, `auth/sessionIdle.db-smoke.ts`), so the live query returns neither.
		db.prisma.session.findMany
			.mockResolvedValueOnce([
				{
					id: 'session-revoquee',
					createdAt: new Date('2026-06-21T10:00:00.000Z'),
					expiresAt: new Date('2026-07-21T10:00:00.000Z')
				},
				{
					id: 'session-expiree',
					createdAt: new Date('2026-06-20T10:00:00.000Z'),
					expiresAt: new Date('2026-06-21T10:00:00.000Z')
				}
			])
			.mockResolvedValueOnce([]);

		const result = (await load(buildLoadEvent({ token: 'session-courante' }) as never)) as {
			security: {
				authMode: string;
				llmEnabled: boolean;
				runtime: string;
				latestSessionCreatedAt: Date | null;
			};
			sessions: Array<{
				createdAt: Date;
				expiresAt: Date;
				isCurrent: boolean;
				status: 'active' | 'revoked';
			}>;
		};

		expect(result.security).toEqual({
			authMode: 'locale',
			llmEnabled: true,
			runtime: 'docker',
			// The build's own version, from package.json through a Vite define. Asserted by shape
			// rather than by a literal: pinning the number here would redden on every release and be
			// bumped mechanically, which is a rubber stamp rather than a check. That it equals
			// package.json's version is asserted once, in appVersion.spec.ts.
			version: expect.stringMatching(/^\d+\.\d+\.\d+/),
			latestSessionCreatedAt: new Date('2026-06-21T10:00:00.000Z')
		});
		expect(result.sessions).toEqual([
			{
				id: 'session-revoquee',
				createdAt: new Date('2026-06-21T10:00:00.000Z'),
				expiresAt: new Date('2026-07-21T10:00:00.000Z'),
				isCurrent: false,
				status: 'revoked'
			},
			{
				id: 'session-expiree',
				createdAt: new Date('2026-06-20T10:00:00.000Z'),
				expiresAt: new Date('2026-06-21T10:00:00.000Z'),
				isCurrent: false,
				status: 'revoked'
			}
		]);
		expect(JSON.stringify(result)).not.toContain('tokenHash');
	});

	it('change le mot de passe, garde la session courante et révoque les autres sessions', async () => {
		expect.assertions(7);

		const oldPasswordHash = await hashPassword('mot-de-passe-actuel');
		db.prisma.user.findUnique.mockResolvedValue({ passwordHash: oldPasswordHash });
		tx.user.update.mockResolvedValue({ id: 'user-a' });
		tx.session.updateMany.mockResolvedValue({ count: 2 });

		const result = await runAction('changePassword', {
			token: 'session-courante',
			input: {
				currentPassword: 'mot-de-passe-actuel',
				newPassword: 'nouveau-mot-de-passe-solide',
				confirmPassword: 'nouveau-mot-de-passe-solide'
			}
		});

		expect(result).toEqual({ passwordSuccess: 'Mot de passe mis à jour.' });
		expect(db.prisma.user.findUnique).toHaveBeenCalledWith({
			where: { id: 'user-a' },
			select: { passwordHash: true, totpEnabled: true, totpSecretEncrypted: true }
		});
		expect(tx.user.update).toHaveBeenCalledWith({
			where: { id: 'user-a' },
			data: {
				passwordHash: expect.stringMatching(/^\$2[aby]\$/)
			}
		});
		expect(tx.user.update.mock.calls[0][0].data.passwordHash).not.toBe(
			'nouveau-mot-de-passe-solide'
		);
		// Spared by its ROW: the re-authentication has already rotated this session's token (#249),
		// so a hash comparison would revoke the caller's own session along with the others.
		expect(tx.session.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId: 'user-a',
					revokedAt: null,
					id: { not: 'session-a' }
				}
			})
		);
		expect(JSON.stringify(tx.user.update.mock.calls[0][0])).not.toContain('mot-de-passe-actuel');
		expect(JSON.stringify(result)).not.toContain('passwordHash');
	});

	it('refuse un nouveau mot de passe et sa confirmation qui ne correspondent pas', async () => {
		expect.assertions(4);

		db.prisma.user.findUnique.mockResolvedValue({
			passwordHash: await hashPassword('mot-de-passe-actuel')
		});

		const result = (await runAction('changePassword', {
			token: 'session-courante',
			input: {
				currentPassword: 'mot-de-passe-actuel',
				newPassword: 'nouveau-mot-de-passe-solide',
				confirmPassword: 'autre-mot-de-passe-different'
			}
		})) as { status: number; data: { passwordError: string } };

		expect(result.status).toBe(400);
		expect(result.data.passwordError).toBe('Impossible de mettre à jour le mot de passe.');
		expect(tx.user.update).not.toHaveBeenCalled();
		expect(tx.session.updateMany).not.toHaveBeenCalled();
	});

	it('refuse un nouveau mot de passe trop court (moins de 12 caractères)', async () => {
		expect.assertions(4);

		db.prisma.user.findUnique.mockResolvedValue({
			passwordHash: await hashPassword('mot-de-passe-actuel')
		});

		const result = (await runAction('changePassword', {
			token: 'session-courante',
			input: {
				currentPassword: 'mot-de-passe-actuel',
				newPassword: 'court12345',
				confirmPassword: 'court12345'
			}
		})) as { status: number; data: { passwordError: string } };

		expect(result.status).toBe(400);
		expect(result.data.passwordError).toBe('Impossible de mettre à jour le mot de passe.');
		expect(tx.user.update).not.toHaveBeenCalled();
		expect(tx.session.updateMany).not.toHaveBeenCalled();
	});

	it('refuse un mauvais ancien mot de passe avec un message générique', async () => {
		expect.assertions(4);

		db.prisma.user.findUnique.mockResolvedValue({
			passwordHash: await hashPassword('mot-de-passe-valide')
		});

		const result = (await runAction('changePassword', {
			token: 'session-courante',
			input: {
				currentPassword: 'mauvais-mot-de-passe',
				newPassword: 'nouveau-mot-de-passe-solide',
				confirmPassword: 'nouveau-mot-de-passe-solide'
			}
		})) as { status: number; data: { passwordError: string } };

		expect(result.status).toBe(400);
		expect(result.data.passwordError).toBe(m.reauth_error_password());
		expect(tx.user.update).not.toHaveBeenCalled();
		expect(tx.session.updateMany).not.toHaveBeenCalled();
	});

	it('révoque seulement les autres sessions du user courant', async () => {
		expect.assertions(2);

		tx.session.updateMany.mockResolvedValue({ count: 3 });
		db.prisma.user.findUnique.mockResolvedValue({
			passwordHash: await hashPassword('mot-de-passe-actuel')
		});

		const result = await runAction('revokeOtherSessions', {
			token: 'session-courante',
			input: { currentPassword: 'mot-de-passe-actuel' }
		});

		expect(result).toEqual({ sessionsSuccess: 'Les autres sessions ont été déconnectées.' });
		expect(tx.session.updateMany).toHaveBeenCalledWith({
			where: {
				userId: 'user-a',
				revokedAt: null,
				id: { not: 'session-a' }
			},
			data: {
				revokedAt: expect.any(Date)
			}
		});
	});

	describe('revokeSession', () => {
		beforeEach(async () => {
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash: await hashPassword('mot-de-passe-actuel')
			});
		});

		it('révoque une session ciblée appartenant au user courant', async () => {
			expect.assertions(3);

			db.prisma.session.findFirst.mockResolvedValue({ id: 'session-cible' });
			tx.session.updateMany.mockResolvedValue({ count: 1 });

			const result = await runAction('revokeSession', {
				token: 'session-courante',
				input: { sessionId: 'session-cible', currentPassword: 'mot-de-passe-actuel' }
			});

			expect(result).toEqual({ sessionsSuccess: 'La session a été révoquée.' });
			// R6 on #841: the owner is IN the lookup, never compared afterwards. The real-engine
			// half, with another account's session id, is `reauth.db-smoke.ts`.
			expect(db.prisma.session.findFirst).toHaveBeenCalledWith({
				where: { id: 'session-cible', userId: 'user-a' },
				select: { id: true }
			});
			expect(tx.session.updateMany).toHaveBeenCalledWith({
				where: { id: 'session-cible', userId: 'user-a', revokedAt: null },
				data: { revokedAt: expect.any(Date) }
			});
		});

		it('refuse une révocation sans sessionId fourni', async () => {
			expect.assertions(3);

			const result = (await runAction('revokeSession', {
				token: 'session-courante',
				input: {}
			})) as { status: number; data: { sessionsError: string } };

			expect(result.status).toBe(400);
			expect(typeof result.data.sessionsError).toBe('string');
			expect(tx.session.updateMany).not.toHaveBeenCalled();
		});

		it('refuse de révoquer une session appartenant à un autre utilisateur (404, aucune mutation)', async () => {
			expect.assertions(3);

			// What the scoped lookup returns for another account's id: nothing.
			db.prisma.session.findFirst.mockResolvedValue(null);

			const result = (await runAction('revokeSession', {
				token: 'session-courante',
				input: { sessionId: 'session-user-b', currentPassword: 'mot-de-passe-actuel' }
			})) as { status: number; data: { sessionsError: string } };

			expect(result.status).toBe(404);
			expect(typeof result.data.sessionsError).toBe('string');
			expect(tx.session.updateMany).not.toHaveBeenCalled();
		});

		it('refuse de révoquer la session courante via cette action dédiée', async () => {
			expect.assertions(3);

			// The current session is the row the hook resolved, `locals.user.sessionId`, and is
			// recognised by that id: its token hash changed when the re-authentication rotated it.
			db.prisma.session.findFirst.mockResolvedValue({ id: 'session-a' });

			const result = (await runAction('revokeSession', {
				token: 'session-courante',
				input: { sessionId: 'session-a', currentPassword: 'mot-de-passe-actuel' }
			})) as { status: number; data: { sessionsError: string } };

			expect(result.status).toBe(400);
			expect(typeof result.data.sessionsError).toBe('string');
			expect(tx.session.updateMany).not.toHaveBeenCalled();
		});
	});

	describe('deleteAccount (#220: phrase confirms intent, password/TOTP authenticate)', () => {
		async function deleteWith(input: Record<string, string>) {
			return invokeAction('deleteAccount', {
				cookies: buildCookies('session-courante'),
				request: buildRequest(input),
				locals: {
					user: { id: 'user-a', email: 'user-a@example.test', role: 'USER', sessionId: 'session-a' }
				}
			});
		}

		it('supprime le compte après phrase + mot de passe corrects (TOTP désactivé)', async () => {
			expect.assertions(8);

			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: false,
				totpSecretEncrypted: null
			});
			tx.session.deleteMany.mockResolvedValue({ count: 4 });
			tx.transaction.deleteMany.mockResolvedValue({ count: 7 });
			tx.user.delete.mockResolvedValue({ id: 'user-a' });
			const cookies = buildCookies('session-courante');

			await expect(
				invokeAction('deleteAccount', {
					cookies,
					request: buildRequest({
						confirmation: 'SUPPRIMER',
						currentPassword: 'mot-de-passe-long'
					}),
					locals: {
						user: {
							id: 'user-a',
							email: 'user-a@example.test',
							role: 'USER',
							sessionId: 'session-a'
						}
					}
				})
			).rejects.toMatchObject({ status: 303, location: '/login' });

			expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-a' } });
			expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'user-a' } });
			// Transactions BEFORE the user — see the same assertion in admin/page.server.spec.ts. A
			// bare user.delete relies on a cascade ORDER the engine chooses, and TransactionSplit is
			// RESTRICT on Category, so on PostgreSQL a user who has ever split a transaction could
			// not delete their own account at all.
			expect(tx.transaction.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-a' } });
			expect(tx.transaction.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
				tx.user.delete.mock.invocationCallOrder[0]
			);
			expect(cookies.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: '/' });
			expect(JSON.stringify(tx.user.delete.mock.calls[0][0])).not.toContain('user-b');
			// A correct secret is never recorded, so legitimate use cannot trip the limiter.
			expect(rateLimit.recordReauthAttempt).not.toHaveBeenCalled();
		});

		it('phrase correcte + MAUVAIS mot de passe : compte intact, tentative comptée', async () => {
			expect.assertions(4);

			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: false,
				totpSecretEncrypted: null
			});

			const result = (await deleteWith({
				confirmation: 'SUPPRIMER',
				currentPassword: 'mauvais-mot-de-passe'
			})) as { status: number; data: { deleteError: string } };

			expect(result.status).toBe(400);
			expect(result.data.deleteError).toBe(m.reauth_error_password());
			expect(tx.user.delete).not.toHaveBeenCalled();
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('session-a', '203.0.113.10');
		});

		it('phrase correcte + AUCUN mot de passe : refusé, compte intact', async () => {
			expect.assertions(3);

			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: false,
				totpSecretEncrypted: null
			});

			const result = (await deleteWith({ confirmation: 'SUPPRIMER' })) as {
				status: number;
				data: { deleteError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.deleteError).toBe(m.reauth_error_password());
			expect(tx.user.delete).not.toHaveBeenCalled();
		});

		it('TOTP activé, phrase + mot de passe corrects mais MAUVAIS code : compte intact', async () => {
			expect.assertions(3);

			const { generateTotpSecretBase32, encryptTotpSecret } = await import('$lib/server/auth/totp');
			const secretBase32 = generateTotpSecretBase32();
			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: true,
				totpSecretEncrypted: encryptTotpSecret(secretBase32)
			});

			const result = (await deleteWith({
				confirmation: 'SUPPRIMER',
				currentPassword: 'mot-de-passe-long',
				code: '000000'
			})) as { status: number; data: { deleteError: string } };

			expect(result.status).toBe(400);
			expect(tx.user.delete).not.toHaveBeenCalled();
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('session-a', '203.0.113.10');
		});

		it('TOTP activé, phrase + mot de passe + code corrects : supprime', async () => {
			expect.assertions(3);

			const { generateTotpSecretBase32, encryptTotpSecret } = await import('$lib/server/auth/totp');
			const OTPAuth = await import('otpauth');
			const secretBase32 = generateTotpSecretBase32();
			const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
			const code = totp.generate();
			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: true,
				totpSecretEncrypted: encryptTotpSecret(secretBase32)
			});
			tx.session.deleteMany.mockResolvedValue({ count: 1 });
			tx.transaction.deleteMany.mockResolvedValue({ count: 0 });
			tx.user.delete.mockResolvedValue({ id: 'user-a' });

			await expect(
				deleteWith({ confirmation: 'SUPPRIMER', currentPassword: 'mot-de-passe-long', code })
			).rejects.toMatchObject({ status: 303, location: '/login' });

			expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'user-a' } });
			expect(rateLimit.recordReauthAttempt).not.toHaveBeenCalled();
		});

		it('MAUVAISE phrase : erreur de confirmation, secret jamais vérifié ni compté', async () => {
			expect.assertions(4);

			const result = (await deleteWith({
				confirmation: 'NON',
				currentPassword: 'mot-de-passe-long'
			})) as { status: number; data: { deleteError: string } };

			expect(result.status).toBe(400);
			expect(result.data.deleteError).toBe('Confirmation obligatoire.');
			expect(tx.user.delete).not.toHaveBeenCalled();
			// Phrase is checked BEFORE the limiter: a mistyped confirmation must not burn an attempt,
			// nor even read the account, so the owner cannot lock themselves out by fumbling the word.
			expect(rateLimit.recordReauthAttempt).not.toHaveBeenCalled();
		});

		it('limiteur déclenché : refus immédiat, aucun accès au secret, aucune suppression', async () => {
			expect.assertions(5);

			rateLimit.isReauthRateLimited.mockResolvedValueOnce(true);

			const result = (await deleteWith({
				confirmation: 'SUPPRIMER',
				currentPassword: 'mot-de-passe-long'
			})) as { status: number; data: { deleteError: string } };

			expect(result.status).toBe(400);
			expect(result.data.deleteError).toBe('Trop de tentatives. Réessayez dans quelques minutes.');
			// Short-circuits before the expensive verify: findUnique is never reached.
			expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
			expect(tx.user.delete).not.toHaveBeenCalled();
			expect(rateLimit.isReauthRateLimited).toHaveBeenCalledWith('session-a');
		});
	});

	// The three siblings PRE-DATE #220: they already re-verified a secret with no counter. The sweep
	// wires them into the same limiter. These prove the gate reaches each one (short-circuits when
	// tripped) and that a wrong secret is counted.
	describe('re-auth limiter wiring on the pre-existing siblings (#220 sweep)', () => {
		it('changePassword : un mauvais mot de passe compte une tentative', async () => {
			expect.assertions(2);
			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({ passwordHash });

			const result = (await runAction('changePassword', {
				input: {
					currentPassword: 'faux',
					newPassword: 'nouveau-mot-de-passe',
					confirmPassword: 'nouveau-mot-de-passe'
				}
			})) as { status: number };

			expect(result.status).toBe(400);
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('session-a', '203.0.113.10');
		});

		it('changePassword : limiteur déclenché court-circuite avant la vérification', async () => {
			expect.assertions(2);
			rateLimit.isReauthRateLimited.mockResolvedValueOnce(true);

			const result = (await runAction('changePassword', {
				input: {
					currentPassword: 'x',
					newPassword: 'nouveau-mot-de-passe',
					confirmPassword: 'nouveau-mot-de-passe'
				}
			})) as { status: number; data: { passwordError: string } };

			expect(result.data.passwordError).toBe(
				'Trop de tentatives. Réessayez dans quelques minutes.'
			);
			expect(db.prisma.user.findUnique).not.toHaveBeenCalled();
		});

		it('disableTotp : un mauvais mot de passe compte une tentative', async () => {
			expect.assertions(2);
			const { generateTotpSecretBase32, encryptTotpSecret } = await import('$lib/server/auth/totp');
			const secretBase32 = generateTotpSecretBase32();
			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: true,
				totpSecretEncrypted: encryptTotpSecret(secretBase32)
			});

			const result = (await runAction('disableTotp', {
				input: { currentPassword: 'faux', code: '000000' }
			})) as { status: number };

			expect(result.status).toBe(400);
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('session-a', '203.0.113.10');
		});

		it('confirmTotpSetup : un mauvais mot de passe compte une tentative', async () => {
			expect.assertions(2);
			const { generateTotpSecretBase32 } = await import('$lib/server/auth/totp');
			const OTPAuth = await import('otpauth');
			const secretBase32 = generateTotpSecretBase32();
			const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
			const code = totp.generate();
			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({ passwordHash });

			const result = (await runAction('confirmTotpSetup', {
				input: { currentPassword: 'faux', secretBase32, code }
			})) as { status: number };

			expect(result.status).toBe(400);
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('session-a', '203.0.113.10');
		});
	});

	describe('updateAiInsightsEnabled / updateAiIncludeLabels', () => {
		it('active/désactive les conseils IA uniquement pour l’utilisateur courant', async () => {
			expect.assertions(3);

			db.prisma.user.update.mockResolvedValue({ id: 'user-a' });

			const result = await runAction('updateAiInsightsEnabled', {
				token: 'session-courante',
				input: { enabled: 'true' }
			});

			expect(result).toEqual({ aiSettingsSuccess: true });
			expect(db.prisma.user.update).toHaveBeenCalledWith({
				where: { id: 'user-a' },
				data: { aiInsightsEnabled: true }
			});
			expect(JSON.stringify(db.prisma.user.update.mock.calls[0][0])).not.toContain('user-b');
		});

		it('persiste la désactivation des conseils IA', async () => {
			expect.assertions(1);

			db.prisma.user.update.mockResolvedValue({ id: 'user-a' });

			await runAction('updateAiInsightsEnabled', {
				token: 'session-courante',
				input: { enabled: 'false' }
			});

			expect(db.prisma.user.update).toHaveBeenCalledWith({
				where: { id: 'user-a' },
				data: { aiInsightsEnabled: false }
			});
		});

		it('active/désactive l’inclusion des libellés uniquement pour l’utilisateur courant', async () => {
			expect.assertions(3);

			db.prisma.user.update.mockResolvedValue({ id: 'user-a' });

			const result = await runAction('updateAiIncludeLabels', {
				token: 'session-courante',
				input: { enabled: 'true' }
			});

			expect(result).toEqual({ aiSettingsSuccess: true });
			expect(db.prisma.user.update).toHaveBeenCalledWith({
				where: { id: 'user-a' },
				data: { aiIncludeLabels: true }
			});
			expect(JSON.stringify(db.prisma.user.update.mock.calls[0][0])).not.toContain('user-b');
		});

		it('ne fait jamais de mise à jour sans passer par l’id du user connecté (pas de userId client)', async () => {
			expect.assertions(1);

			db.prisma.user.update.mockResolvedValue({ id: 'user-a' });

			await runAction('updateAiIncludeLabels', {
				token: 'session-courante',
				input: { enabled: 'false', userId: 'user-b' }
			});

			expect(db.prisma.user.update).toHaveBeenCalledWith({
				where: { id: 'user-a' },
				data: { aiIncludeLabels: false }
			});
		});
	});

	describe('restoreData', () => {
		// #228 put re-authentication ahead of the parse, so every test below that reaches the parse
		// posts the right password. Without it they would all be refused by re-authentication, and a
		// test asserting that some OTHER refusal did not happen would stay green for that reason.
		beforeEach(async () => {
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash: await hashPassword(RESTORE_PASSWORD),
				totpEnabled: false,
				totpSecretEncrypted: null
			});
		});

		it('refuse un envoi sans fichier', async () => {
			expect.assertions(2);

			const result = (await runRestoreAction(new FormData())) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe('Sélectionnez un fichier de sauvegarde à restaurer.');
		});

		it('refuse un fichier trop volumineux sans même tenter de le parser', async () => {
			expect.assertions(3);

			const bigFile = buildBackupFile('x'.repeat(20_000_001), 'backup.json');

			const result = (await runRestoreAction(buildBackupFormData(bigFile))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toContain('trop volumineux');
			expect(backupImport.restoreBackup).not.toHaveBeenCalled();
		});

		/**
		 * #276. Added because the break-check found the hole: replacing the comparison in the action
		 * with `if (false)` left the whole of `parseBounds.spec.ts` GREEN. That file asserts the
		 * counter is correct and that it is called before `JSON.parse`, and neither of those is an
		 * assertion that its RESULT is acted on. A build computing the count and discarding it passed
		 * every test. This is the only thing that sees it.
		 *
		 * Asserted on the REASON, not on "it was refused": the byte cap, the malformed-JSON branch
		 * and the schema all refuse this file too, and three of those four refusals would send the
		 * user to the wrong place. The bomb here is deliberately WELL UNDER the 20 MB byte cap, so a
		 * refusal cannot be the size check firing.
		 */
		it('refuse une sauvegarde trop dense avant de la parser, en le disant', async () => {
			expect.assertions(4);

			// 2,000,001 values in about 3 MB: comfortably under the 20 MB cap, so the byte check
			// cannot be what refuses it, and one value over the default bound.
			const bomb = '[' + '{},'.repeat(1_000_000) + '{}]';
			const file = buildBackupFile(bomb);

			expect(bomb.length).toBeLessThan(20_000_000);

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toContain('trop d’entrées distinctes');
			expect(backupImport.restoreBackup).not.toHaveBeenCalled();
		});

		it('restaure une sauvegarde légitime de la même taille que la précédente', async () => {
			expect.assertions(2);

			// THE POSITIVE HALF, and without it the test above is satisfied by a bound that refuses
			// every backup. Same order of magnitude in bytes, real record density, must go through.
			const rows = Array.from({ length: 8_000 }, (_, i) => ({
				id: `cmsqeu119${String(i).padStart(11, '0')}xk`,
				accountId: 'cmsqeu10k00afw8klhoez9xgy',
				label: `CARTE 12/03 CARREFOUR MARKET ${String(i).padStart(6, '0')} FACTURE 4512`,
				amountCents: -100
			}));
			const legitimate = JSON.stringify({ formatVersion: 1, transactions: rows });
			expect(legitimate.length).toBeGreaterThan(1_000_000);

			const result = await runRestoreAction(buildBackupFormData(buildBackupFile(legitimate)));

			// It gets PAST the density bound. It is then refused by the schema, which is correct and
			// is a different refusal: this fixture is not a complete backup. The assertion is that
			// the density message is not what came back.
			expect(JSON.stringify(result)).not.toContain('trop d’entrées distinctes');
		});

		it('rejette un JSON mal formé sans appeler restoreBackup', async () => {
			expect.assertions(3);

			const file = buildBackupFile('{ ceci nest pas du json');

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe('Le fichier n’est pas un JSON valide.');
			expect(backupImport.restoreBackup).not.toHaveBeenCalled();
		});

		it('rejette un formatVersion différent de 1 sans appeler restoreBackup', async () => {
			expect.assertions(3);

			const file = buildBackupFile(JSON.stringify({ formatVersion: 2 }));

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe('Format de sauvegarde non supporté.');
			expect(backupImport.restoreBackup).not.toHaveBeenCalled();
		});

		it('rejette un payload incomplet/mal typé (échec du schéma) sans appeler restoreBackup', async () => {
			expect.assertions(3);

			const file = buildBackupFile(
				JSON.stringify({
					formatVersion: 1,
					exportedAt: 'pas-une-date',
					userEmail: 'user-a@example.test',
					accounts: [],
					categories: [],
					importBatches: [],
					transactions: [],
					monthlyBudgets: [],
					categoryRules: [],
					categorizationRules: [],
					categoryNatureMappings: []
				})
			);

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe('Fichier de sauvegarde invalide ou corrompu.');
			expect(backupImport.restoreBackup).not.toHaveBeenCalled();
		});

		/**
		 * #758: a backup whose date no engine stores faithfully is refused with THAT reason, not as
		 * « corrompu ». Such a file is not corrupt: an install on SQLite accepted a year 0000 row
		 * before #758 and exported it faithfully, and « corrompu » would send its owner looking for
		 * damage that is not there. Separates the range sentence from the generic one, and « refused
		 * before any write » from « restored ».
		 */
		it('rejette une sauvegarde portant une date hors plage, en le disant, sans appeler restoreBackup', async () => {
			expect.assertions(3);

			const file = buildBackupFile(
				JSON.stringify({
					formatVersion: 1,
					exportedAt: '0999-12-31T00:00:00.000Z',
					userEmail: 'user-a@example.test',
					accounts: [],
					categories: [],
					importBatches: [],
					transactions: [],
					monthlyBudgets: [],
					categoryRules: [],
					categorizationRules: [],
					categoryNatureMappings: []
				})
			);

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe(
				'Cette sauvegarde contient une date hors des années 1000 à 9999 (date d’export). Vos données n’ont pas été modifiées.'
			);
			expect(backupImport.restoreBackup).not.toHaveBeenCalled();
		});

		/**
		 * Two kinds of record can share one label: a net worth line and its snapshots are both
		 * « patrimoine ». The sentence names it once. Compared whole, so « (patrimoine, patrimoine) »
		 * is red: a substring assertion would pass straight over the doubled word.
		 */
		it('nomme une seule fois le patrimoine quand ses lignes et ses relevés sont hors plage', async () => {
			expect.assertions(2);

			const file = buildBackupFile(
				JSON.stringify({
					formatVersion: 1,
					exportedAt: new Date().toISOString(),
					userEmail: 'user-a@example.test',
					accounts: [],
					categories: [],
					importBatches: [],
					transactions: [],
					monthlyBudgets: [],
					categoryRules: [],
					categorizationRules: [],
					categoryNatureMappings: [],
					netWorthAccounts: [
						{
							id: 'nwa-1',
							name: 'Livret',
							type: 'savings',
							balanceCents: 100,
							deletedAt: '0026-05-01T00:00:00.000Z'
						}
					],
					netWorthSnapshots: [
						{
							id: 'nws-1',
							accountId: 'nwa-1',
							type: 'savings',
							balanceCents: 100,
							capturedAt: '0026-05-01T00:00:00.000Z'
						}
					]
				})
			);

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe(
				'Cette sauvegarde contient une date hors des années 1000 à 9999 (patrimoine). Vos données n’ont pas été modifiées.'
			);
		});

		it('rejette un payload contenant un champ non déclaré (ex. userId injecté) sans appeler restoreBackup', async () => {
			expect.assertions(3);

			const file = buildBackupFile(
				JSON.stringify({
					formatVersion: 1,
					exportedAt: new Date().toISOString(),
					userEmail: 'user-a@example.test',
					userId: 'user-b-vole',
					accounts: [],
					categories: [],
					importBatches: [],
					transactions: [],
					monthlyBudgets: [],
					categoryRules: [],
					categorizationRules: [],
					categoryNatureMappings: []
				})
			);

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe('Fichier de sauvegarde invalide ou corrompu.');
			expect(backupImport.restoreBackup).not.toHaveBeenCalled();
		});

		it('appelle restoreBackup avec le userId du user connecté, pas un userId venant du fichier', async () => {
			expect.assertions(4);

			backupImport.restoreBackup.mockResolvedValue(undefined);
			const file = buildBackupFile(JSON.stringify(buildValidBackupPayload()));

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				restoreSuccess: string;
			};

			expect(result).toEqual({
				restoreSuccess: 'Vos données ont été restaurées à partir de la sauvegarde.'
			});
			expect(backupImport.restoreBackup).toHaveBeenCalledTimes(1);
			expect(backupImport.restoreBackup.mock.calls[0][0]).toBe('user-a');
			// #249: the restore commits through the rotating commit, for the caller's own session, with
			// the restore's transaction budget passed through. Separates « restored and rotated in one
			// commit » from « restored in a plain transaction », which leaves the presented token live.
			const commit = (
				backupImport.restoreBackup.mock.calls[0] as unknown as [
					string,
					unknown,
					(change: () => Promise<void>, options: { timeout: number }) => Promise<void>
				]
			)[2];
			await commit(async () => {}, { timeout: 1 });
			expect(commitWithRotatedToken).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: 'session-a' }),
				expect.anything(),
				expect.any(Function),
				{ timeout: 1 }
			);
		});

		it('remonte une BackupImportError (incohérence référentielle) en erreur 400 sans planter', async () => {
			expect.assertions(2);

			backupImport.restoreBackup.mockRejectedValue(
				new backupImport.BackupImportError(
					'Transaction "tx-1" référence un compte inconnu du fichier.'
				)
			);
			const file = buildBackupFile(JSON.stringify(buildValidBackupPayload()));

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe(
				'Transaction "tx-1" référence un compte inconnu du fichier.'
			);
		});

		it('laisse remonter une erreur inattendue (non BackupImportError) au lieu de la masquer', async () => {
			expect.assertions(1);

			backupImport.restoreBackup.mockRejectedValue(new Error('panne disque'));
			const file = buildBackupFile(JSON.stringify(buildValidBackupPayload()));

			await expect(runRestoreAction(buildBackupFormData(file))).rejects.toThrow('panne disque');
		});

		it('catche un conflit d’unicité Prisma (doublon de catégorie) avec un message clair, sans fuite de détail brut', async () => {
			expect.assertions(3);

			const prismaUniqueError = Object.assign(
				new Error('Unique constraint failed on the fields: (`userId`,`name`)'),
				{
					code: 'P2002'
				}
			);
			backupImport.restoreBackup.mockRejectedValue(prismaUniqueError);
			const file = buildBackupFile(JSON.stringify(buildValidBackupPayload()));

			const result = (await runRestoreAction(buildBackupFormData(file))) as {
				status: number;
				data: { restoreError: string };
			};

			expect(result.status).toBe(400);
			expect(result.data.restoreError).toBe(
				"Le fichier contient un doublon de catégorie. Import annulé, vos données n'ont pas été modifiées."
			);
			expect(result.data.restoreError).not.toContain('P2002');
		});
	});

	describe('startTotpSetup / confirmTotpSetup / disableTotp', () => {
		it('startTotpSetup ne persiste rien : renvoie un secret et un QR sans écrire en DB', async () => {
			expect.assertions(3);

			const result = (await runAction('startTotpSetup', {})) as {
				totpSetupPending: { secretBase32: string; qrDataUrl: string };
			};

			expect(result.totpSetupPending.secretBase32.length).toBeGreaterThan(0);
			expect(result.totpSetupPending.qrDataUrl).toMatch(/^data:image\//);
			expect(db.prisma.user.update).not.toHaveBeenCalled();
		});

		it('confirmTotpSetup active le TOTP et renvoie 10 codes de récupération affichés une seule fois', async () => {
			expect.assertions(6);

			const { generateTotpSecretBase32 } = await import('$lib/server/auth/totp');
			const OTPAuth = await import('otpauth');
			const secretBase32 = generateTotpSecretBase32();
			const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
			// Read once: the step asserted below is the one this code was generated for.
			const now = Date.now();
			const code = totp.generate({ timestamp: now });
			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({ passwordHash });

			const result = (await runAction('confirmTotpSetup', {
				input: { currentPassword: 'mot-de-passe-long', secretBase32, code }
			})) as { totpEnableSuccess: boolean; recoveryCodes: string[] };

			expect(result.totpEnableSuccess).toBe(true);
			expect(result.recoveryCodes).toHaveLength(10);
			expect(new Set(result.recoveryCodes).size).toBe(10);

			const updateArgs = tx.user.update.mock.calls[0][0];
			expect(updateArgs.data.totpEnabled).toBe(true);
			expect(updateArgs.data.totpSecretEncrypted).not.toContain(secretBase32);
			// #818: the confirming code's step, written in the same update as the secret.
			expect(updateArgs.data.totpLastUsedStep).toBe(Math.floor(now / 30_000));
		});

		it('confirmTotpSetup rejette un code invalide sans activer le TOTP, et renvoie un QR frais pour réessayer', async () => {
			expect.assertions(3);

			const { generateTotpSecretBase32 } = await import('$lib/server/auth/totp');
			const secretBase32 = generateTotpSecretBase32();
			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({ passwordHash });

			const result = (await runAction('confirmTotpSetup', {
				input: { currentPassword: 'mot-de-passe-long', secretBase32, code: '000000' }
			})) as unknown as {
				status: number;
				data: { totpSetupError: string; totpSetupPending?: { secretBase32: string } };
			};

			expect(result.status).toBe(400);
			expect(tx.user.update).not.toHaveBeenCalled();
			expect(result.data.totpSetupPending?.secretBase32).toBe(secretBase32);
		});

		it('confirmTotpSetup rejette un mauvais mot de passe sans activer le TOTP', async () => {
			expect.assertions(2);

			const { generateTotpSecretBase32 } = await import('$lib/server/auth/totp');
			const OTPAuth = await import('otpauth');
			const secretBase32 = generateTotpSecretBase32();
			const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
			const code = totp.generate();
			const passwordHash = await hashPassword('mot-de-passe-long');
			db.prisma.user.findUnique.mockResolvedValue({ passwordHash });

			const result = (await runAction('confirmTotpSetup', {
				input: { currentPassword: 'mauvais-mot-de-passe', secretBase32, code }
			})) as unknown as { status: number; data: { totpSetupError: string } };

			expect(result.status).toBe(400);
			expect(tx.user.update).not.toHaveBeenCalled();
		});

		it('disableTotp désactive le TOTP et supprime les codes de récupération sur mot de passe + code valides', async () => {
			expect.assertions(3);

			const { generateTotpSecretBase32, encryptTotpSecret } = await import('$lib/server/auth/totp');
			const OTPAuth = await import('otpauth');
			const secretBase32 = generateTotpSecretBase32();
			const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
			const code = totp.generate();
			const passwordHash = await hashPassword('mot-de-passe-long');

			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: true,
				totpSecretEncrypted: encryptTotpSecret(secretBase32)
			});

			const result = (await runAction('disableTotp', {
				input: { currentPassword: 'mot-de-passe-long', code }
			})) as { totpDisableSuccess: string };

			expect(result.totpDisableSuccess).toBeTruthy();
			expect(tx.user.update.mock.calls[0][0].data).toMatchObject({
				totpEnabled: false,
				totpSecretEncrypted: null
			});
			expect(tx.recoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-a' } });
		});

		it('disableTotp rejette un mauvais mot de passe sans désactiver le TOTP', async () => {
			expect.assertions(2);

			const { generateTotpSecretBase32, encryptTotpSecret } = await import('$lib/server/auth/totp');
			const secretBase32 = generateTotpSecretBase32();
			const passwordHash = await hashPassword('mot-de-passe-long');

			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: true,
				totpSecretEncrypted: encryptTotpSecret(secretBase32)
			});

			const result = (await runAction('disableTotp', {
				input: { currentPassword: 'mauvais-mot-de-passe', code: '123456' }
			})) as { status: number; data: { totpDisableError: string } };

			expect(result.status).toBe(400);
			expect(tx.user.update).not.toHaveBeenCalled();
		});
	});

	describe('tag management', () => {
		it('loads the tag list scoped to the current user through listTagsWithCounts', async () => {
			expect.assertions(2);

			db.prisma.user.findUniqueOrThrow.mockResolvedValue({
				email: 'user-a@example.test',
				role: 'USER'
			});
			db.prisma.session.findMany.mockResolvedValue([]);
			tagsService.listTagsWithCounts.mockResolvedValue([
				{ id: 'tag-000001', name: 'Portugal', colorToken: 'lagoon', transactionCount: 3 }
			]);

			const result = (await load(buildLoadEvent({ token: 'session-courante' }) as never)) as {
				tags: Array<{ id: string; name: string; colorToken: string; transactionCount: number }>;
			};

			expect(tagsService.listTagsWithCounts).toHaveBeenCalledWith('user-a');
			expect(result.tags).toEqual([
				{ id: 'tag-000001', name: 'Portugal', colorToken: 'lagoon', transactionCount: 3 }
			]);
		});

		describe('renameTag', () => {
			it('renames on ok', async () => {
				expect.assertions(2);

				tagsService.renameTag.mockResolvedValue('ok');

				const result = await runAction('renameTag', {
					token: 'session-courante',
					input: { id: 'tag-000001', newName: 'Portugal 2026' }
				});

				expect(tagsService.renameTag).toHaveBeenCalledWith('user-a', 'tag-000001', 'Portugal 2026');
				expect(result).toEqual({ tagsSuccess: 'Étiquette renommée.' });
			});

			it('rejects a malformed id without calling the service', async () => {
				expect.assertions(2);

				const result = (await runAction('renameTag', {
					token: 'session-courante',
					input: { id: '', newName: 'Portugal' }
				})) as { status: number; data: { tagsError: string } };

				expect(result.status).toBe(400);
				expect(tagsService.renameTag).not.toHaveBeenCalled();
			});

			it('reports a duplicate name as 400', async () => {
				expect.assertions(2);

				tagsService.renameTag.mockResolvedValue('duplicate');

				const result = (await runAction('renameTag', {
					token: 'session-courante',
					input: { id: 'tag-000001', newName: 'Portugal' }
				})) as { status: number; data: { tagsError: string } };

				expect(result.status).toBe(400);
				expect(result.data.tagsError).toBe('Ce nom existe déjà.');
			});

			it('reports an empty normalized name as 400', async () => {
				expect.assertions(2);

				tagsService.renameTag.mockResolvedValue('empty-name');

				const result = (await runAction('renameTag', {
					token: 'session-courante',
					input: { id: 'tag-000001', newName: '   ' }
				})) as { status: number; data: { tagsError: string } };

				expect(result.status).toBe(400);
				expect(result.data.tagsError).toBe('Nom invalide (1–60 caractères).');
			});

			it('reports not-found as a generic 404, not distinguishing "gone" from "not yours"', async () => {
				expect.assertions(4);

				tagsService.renameTag.mockResolvedValue('not-found');

				const neverExisted = (await runAction('renameTag', {
					token: 'session-courante',
					input: { id: 'tag-never-existed', newName: 'Portugal' }
				})) as { status: number; data: { tagsError: string } };
				const belongsToSomeoneElse = (await runAction('renameTag', {
					token: 'session-courante',
					input: { id: 'tag-owned-by-user-b', newName: 'Portugal' }
				})) as { status: number; data: { tagsError: string } };

				expect(neverExisted.status).toBe(404);
				expect(belongsToSomeoneElse.status).toBe(404);
				expect(neverExisted.data.tagsError).toBe('Étiquette introuvable.');
				// Byte-identical to the "never existed" response: no id-dependent branching, no
				// enumeration of which case it is.
				expect(belongsToSomeoneElse).toEqual(neverExisted);
			});
		});

		describe('recolorTag', () => {
			it('recolors on ok', async () => {
				expect.assertions(2);

				tagsService.recolorTag.mockResolvedValue('ok');

				const result = await runAction('recolorTag', {
					token: 'session-courante',
					input: { id: 'tag-000001', colorToken: 'azure' }
				});

				expect(tagsService.recolorTag).toHaveBeenCalledWith('user-a', 'tag-000001', 'azure');
				expect(result).toEqual({ tagsSuccess: 'Couleur mise à jour.' });
			});

			it('rejects a malformed id without calling the service', async () => {
				expect.assertions(2);

				const result = (await runAction('recolorTag', {
					token: 'session-courante',
					input: { id: '', colorToken: 'azure' }
				})) as { status: number; data: { tagsError: string } };

				expect(result.status).toBe(400);
				expect(tagsService.recolorTag).not.toHaveBeenCalled();
			});

			// Unreachable from the UI, which only ever submits one of the palette swatches. Tested
			// anyway: the UI is not the enforcement, the service's closed-set check is.
			it('rejects a colour outside the closed palette, even though the UI cannot send one', async () => {
				expect.assertions(2);

				tagsService.recolorTag.mockResolvedValue('invalid-color');

				const result = (await runAction('recolorTag', {
					token: 'session-courante',
					input: { id: 'tag-000001', colorToken: '#ff0000' }
				})) as { status: number; data: { tagsError: string } };

				expect(result.status).toBe(400);
				expect(result.data.tagsError).toBe('Couleur invalide.');
			});

			it('reports not-found as a generic 404, not distinguishing "gone" from "not yours"', async () => {
				expect.assertions(1);

				tagsService.recolorTag.mockResolvedValue('not-found');

				const neverExisted = await runAction('recolorTag', {
					token: 'session-courante',
					input: { id: 'tag-never-existed', colorToken: 'azure' }
				});
				const belongsToSomeoneElse = await runAction('recolorTag', {
					token: 'session-courante',
					input: { id: 'tag-owned-by-user-b', colorToken: 'azure' }
				});

				expect(belongsToSomeoneElse).toEqual(neverExisted);
			});
		});

		describe('deleteTag', () => {
			it('deletes on ok', async () => {
				expect.assertions(2);

				tagsService.deleteTag.mockResolvedValue('ok');

				const result = await runAction('deleteTag', {
					token: 'session-courante',
					input: { id: 'tag-000001' }
				});

				expect(tagsService.deleteTag).toHaveBeenCalledWith('user-a', 'tag-000001');
				expect(result).toEqual({ tagsSuccess: 'Étiquette supprimée.' });
			});

			it('rejects a malformed id without calling the service', async () => {
				expect.assertions(2);

				const result = (await runAction('deleteTag', {
					token: 'session-courante',
					input: { id: '' }
				})) as { status: number; data: { tagsError: string } };

				expect(result.status).toBe(400);
				expect(tagsService.deleteTag).not.toHaveBeenCalled();
			});

			it('reports not-found as a generic 404, not distinguishing "gone" from "not yours"', async () => {
				expect.assertions(1);

				tagsService.deleteTag.mockResolvedValue('not-found');

				const neverExisted = await runAction('deleteTag', {
					token: 'session-courante',
					input: { id: 'tag-never-existed' }
				});
				const belongsToSomeoneElse = await runAction('deleteTag', {
					token: 'session-courante',
					input: { id: 'tag-owned-by-user-b' }
				});

				expect(belongsToSomeoneElse).toEqual(neverExisted);
			});
		});
	});

	/**
	 * #326 — the remembered correspondances, and the escape hatch the cap owes.
	 *
	 * The store's userId scoping is asserted against a REAL database in `store.db-smoke.ts`
	 * (including Bob naming Alice's id, on all three engines). What only this level can show is
	 * that the route hands the store the CALLER's id rather than one from the request, and that
	 * each outcome becomes the right response.
	 */
	describe('remembered column mappings', () => {
		it('loads them scoped to the current user, shaped for the page', async () => {
			expect.assertions(3);

			mappingStore.listColumnMappings.mockResolvedValue([
				{
					id: 'm1',
					matchBy: 'name',
					dateColumn: 'date operation',
					labelColumn: 'libelle',
					amountColumn: 'montant',
					categoryColumn: null,
					dateIndex: null,
					labelIndex: null,
					amountIndex: null,
					categoryIndex: null,
					columnCount: 4,
					useCount: 3,
					lastUsedAt: new Date('2026-08-15T10:00:00Z'),
					createdAt: new Date('2026-08-01T10:00:00Z'),
					_count: { importBatches: 2 }
				}
			]);

			db.prisma.user.findUniqueOrThrow.mockResolvedValue({
				email: 'user-a@example.test',
				role: 'USER'
			});
			db.prisma.session.findMany.mockResolvedValue([]);
			tagsService.listTagsWithCounts.mockResolvedValue([]);

			const result = (await load(buildLoadEvent({ token: 'session-courante' }) as never)) as {
				columnMappings: Array<Record<string, unknown>>;
			};

			// The CALLER's id, never one read off the request.
			expect(mappingStore.listColumnMappings).toHaveBeenCalledWith('user-a');
			expect(result.columnMappings).toHaveLength(1);
			// `_count.importBatches` flattened onto the view the confirmation reads.
			expect(result.columnMappings[0]).toMatchObject({
				id: 'm1',
				matchBy: 'name',
				columns: { date: 'date operation', label: 'libelle', amount: 'montant' },
				importBatchCount: 2
			});
		});

		it('carries the cap so the list can say how many of how many', async () => {
			expect.assertions(1);

			mappingStore.resolveColumnMappingsPerUser.mockReturnValue(50);
			db.prisma.account.findMany.mockResolvedValue([]);
			netWorthService.readLinkableNetWorthAccounts.mockResolvedValue([]);
			db.prisma.user.findUniqueOrThrow.mockResolvedValue({
				email: 'user-a@example.test',
				role: 'USER'
			});
			db.prisma.session.findMany.mockResolvedValue([]);
			tagsService.listTagsWithCounts.mockResolvedValue([]);

			const result = (await load(buildLoadEvent({ token: 'session-courante' }) as never)) as {
				columnMappingCap: number;
			};

			expect(result.columnMappingCap).toBe(50);
		});

		it('forgets one, passing the caller id and not a client-supplied one', async () => {
			expect.assertions(2);

			const result = await runAction('deleteColumnMapping', {
				token: 'session-courante',
				input: { id: 'mapping-1' }
			});

			expect(mappingStore.deleteColumnMapping).toHaveBeenCalledWith('user-a', 'mapping-1');
			expect(result).toMatchObject({ columnMappingSuccess: expect.any(String) });
		});

		it('refuses an empty id before it reaches the store', async () => {
			expect.assertions(2);

			const result = await runAction('deleteColumnMapping', {
				token: 'session-courante',
				input: { id: '  ' }
			});

			expect(mappingStore.deleteColumnMapping).not.toHaveBeenCalled();
			expect(result.status).toBe(400);
		});

		/**
		 * The direction this change is NOT moving in.
		 *
		 * A mapping that is not the caller's must be indistinguishable from one that never
		 * existed, or the response answers "does this id exist" for an id the caller does not own.
		 * The store returns `not-found` for both; this asserts the route does not then invent a
		 * difference in its own reply.
		 */
		it("answers the same for another user's mapping as for one that never existed", async () => {
			expect.assertions(1);

			mappingStore.deleteColumnMapping.mockResolvedValue('not-found');

			const neverExisted = await runAction('deleteColumnMapping', {
				token: 'session-courante',
				input: { id: 'mapping-never-existed' }
			});
			const belongsToSomeoneElse = await runAction('deleteColumnMapping', {
				token: 'session-courante',
				input: { id: 'mapping-owned-by-user-b' }
			});

			expect(belongsToSomeoneElse).toEqual(neverExisted);
		});
	});

	describe('the remembered accounts (#599)', () => {
		it('hands the page the rows listed for the CALLER', async () => {
			expect.assertions(2);
			accountMemory.listRememberedAccounts.mockResolvedValue([
				{ id: 'ra-1', fragment: '0185', accountName: 'Compte joint', useCount: 3 }
			]);
			db.prisma.session.findMany.mockResolvedValue([]);
			tagsService.listTagsWithCounts.mockResolvedValue([]);

			const result = (await load(buildLoadEvent({ token: 'session-courante' }) as never)) as {
				rememberedAccounts: Array<Record<string, unknown>>;
			};

			expect(accountMemory.listRememberedAccounts).toHaveBeenCalledWith('user-a');
			expect(result.rememberedAccounts).toHaveLength(1);
		});

		it('forgets one with the caller id, and says so', async () => {
			expect.assertions(2);
			accountMemory.forgetRememberedAccount.mockResolvedValue('forgotten');

			const result = await runAction('forgetRememberedAccount', {
				token: 'session-courante',
				input: { id: 'remembered-1' }
			});

			expect(accountMemory.forgetRememberedAccount).toHaveBeenCalledWith('user-a', 'remembered-1');
			expect(result).toMatchObject({
				rememberedAccountSuccess: m.settings_remembered_accounts_success_forgotten()
			});
		});

		it('answers not-found, and never reaches the store, for an empty id', async () => {
			expect.assertions(2);

			const result = await runAction('forgetRememberedAccount', {
				token: 'session-courante',
				input: { id: '  ' }
			});

			expect(accountMemory.forgetRememberedAccount).not.toHaveBeenCalled();
			expect(result.status).toBe(404);
		});
	});
});

/**
 * S1 (#253, #228, R3 on #841): every settings action in `REAUTH_FACTORS`, driven through the REAL
 * action with every refusal reason its factors allow.
 *
 * ENUMERATED FROM THE REGISTRY. The cases below are keyed by action name and a test asserts the key
 * set equals the registry's settings half, so an action added to `REAUTH_FACTORS` without a case
 * here, or a case for an action that no longer re-authenticates, fails the first test rather than
 * leaving a row unexercised.
 *
 * Per action and reason, four observations, each separating two states:
 * - the helper's REASON, read off the spy: « refused because the code was wrong » vs « refused
 *   for some other reason that happens to look the same on screen »;
 * - the sentence equals `reauthRefusalMessage` for that outcome, and one sentence per action
 *   across reasons (#854 class 2): « generic » vs « names the factor that failed »;
 * - nothing was written: « refused » vs « refused after the write already happened »;
 * - an attempt was recorded for a wrong factor and not for a missing one.
 * The calibration case (the right secrets) is what makes « nothing was written » able to fail:
 * the same request with the right password and code DOES reach the write.
 */
describe('S1: each re-authenticating settings action, through the real action', () => {
	const PASSWORD = 'mot-de-passe-du-compte';
	let passwordHash = '';
	let storedSecret = '';
	let storedSecretEncrypted = '';
	const enrollingSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

	async function totpCode(secretBase32: string, offsetSteps = 0): Promise<string> {
		const OTPAuth = await import('otpauth');
		const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
		return totp.generate({ timestamp: Date.now() + offsetSteps * 30_000 });
	}

	/** Six digits outside the ±1 window: ten steps ahead is never accepted. */
	async function wrongCode(secretBase32: string): Promise<string> {
		return totpCode(secretBase32, 10);
	}

	type SettingsReauthAction = Exclude<
		keyof typeof reauth.REAUTH_FACTORS,
		'deleteUser' | 'resetPassword'
	>;

	interface Case {
		/** The action's own fields, valid, so only the credentials decide. */
		fields: () => Record<string, string> | Promise<Record<string, string>>;
		/** Whose code the form carries: the stored secret, or the one being enrolled. */
		codeFrom: 'stored' | 'enrolling';
		errorKey: string;
		/** Every write the action would make. None may be called on a refusal. */
		writes: () => Array<{ mock: { calls: unknown[] } }>;
		/** Runs the action; restoreData posts a file, the rest a plain form. */
		post?: (fields: Record<string, string>) => Promise<unknown>;
		/**
		 * The account the action runs against has no second factor. Only enrolment needs it: it is
		 * refused on an account that already has one (the contradiction pass on S1).
		 */
		withoutTotp?: true;
	}

	const CASES: Record<SettingsReauthAction, Case> = {
		revokeSession: {
			fields: () => ({ sessionId: 'session-cible' }),
			codeFrom: 'stored',
			errorKey: 'sessionsError',
			writes: () => [tx.session.updateMany, db.prisma.session.findFirst]
		},
		revokeOtherSessions: {
			fields: () => ({}),
			codeFrom: 'stored',
			errorKey: 'sessionsError',
			writes: () => [tx.session.updateMany]
		},
		changePassword: {
			fields: () => ({
				newPassword: 'nouveau-mot-de-passe-solide',
				confirmPassword: 'nouveau-mot-de-passe-solide'
			}),
			codeFrom: 'stored',
			errorKey: 'passwordError',
			writes: () => [tx.user.update, tx.session.updateMany]
		},
		deleteAccount: {
			fields: () => ({ confirmation: 'SUPPRIMER' }),
			codeFrom: 'stored',
			errorKey: 'deleteError',
			writes: () => [tx.user.delete, tx.session.deleteMany, tx.transaction.deleteMany]
		},
		disableTotp: {
			fields: () => ({}),
			codeFrom: 'stored',
			errorKey: 'totpDisableError',
			writes: () => [tx.user.update, tx.recoveryCode.deleteMany]
		},
		confirmTotpSetup: {
			fields: () => ({ secretBase32: enrollingSecret }),
			codeFrom: 'enrolling',
			errorKey: 'totpSetupError',
			writes: () => [tx.user.update, tx.recoveryCode.createMany],
			withoutTotp: true
		},
		restoreData: {
			fields: () => ({}),
			codeFrom: 'stored',
			errorKey: 'restoreError',
			writes: () => [backupImport.restoreBackup],
			post: (fields) => {
				const formData = new FormData();
				formData.set('backupFile', buildBackupFile(JSON.stringify(buildValidBackupPayload())));
				for (const [key, value] of Object.entries(fields)) formData.set(key, value);
				return invokeAction('restoreData', {
					cookies: buildCookies('session-courante'),
					request: new Request('http://localhost/settings', { method: 'POST', body: formData }),
					locals: {
						user: {
							id: 'user-a',
							email: 'user-a@example.test',
							role: 'USER',
							sessionId: 'session-a'
						}
					}
				});
			}
		}
	};

	type Credentials = { password?: string; code?: string };

	async function post(action: SettingsReauthAction, credentials: Credentials) {
		const testCase = CASES[action];
		if (testCase.withoutTotp) {
			db.prisma.user.findUnique.mockResolvedValue({
				passwordHash,
				totpEnabled: false,
				totpSecretEncrypted: null
			});
		}
		const fields: Record<string, string> = { ...(await testCase.fields()) };
		if (credentials.password !== undefined) fields.currentPassword = credentials.password;
		if (credentials.code !== undefined) fields.code = credentials.code;
		if (testCase.post) return testCase.post(fields);
		return runAction(action, { token: 'session-courante', input: fields });
	}

	async function credentialsFor(
		action: SettingsReauthAction,
		reason: 'right' | 'wrong-password' | 'missing-password' | 'missing-totp' | 'wrong-totp'
	): Promise<Credentials> {
		const secret = CASES[action].codeFrom === 'enrolling' ? enrollingSecret : storedSecret;
		const asksCode = reauth.REAUTH_FACTORS[action] !== 'password';
		const rightCode = asksCode ? await totpCode(secret) : undefined;
		switch (reason) {
			case 'right':
				return { password: PASSWORD, code: rightCode };
			case 'wrong-password':
				return { password: 'pas-le-bon', code: rightCode };
			case 'missing-password':
				return { code: rightCode };
			case 'missing-totp':
				return { password: PASSWORD };
			case 'wrong-totp':
				return { password: PASSWORD, code: await wrongCode(secret) };
		}
	}

	function reasonsFor(action: SettingsReauthAction) {
		return reauth.REAUTH_FACTORS[action] === 'password'
			? (['wrong-password', 'missing-password'] as const)
			: (['wrong-password', 'missing-password', 'missing-totp', 'wrong-totp'] as const);
	}

	const ACTIONS = Object.keys(CASES) as SettingsReauthAction[];
	const ROWS = ACTIONS.flatMap((action) =>
		reasonsFor(action).map((reason) => [action, reason] as const)
	);

	beforeAll(async () => {
		passwordHash = await hashPassword(PASSWORD);
		const { generateTotpSecretBase32, encryptTotpSecret } = await import('$lib/server/auth/totp');
		storedSecret = generateTotpSecretBase32();
		storedSecretEncrypted = encryptTotpSecret(storedSecret);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
		rateLimit.isReauthRateLimited.mockReset();
		rateLimit.isReauthRateLimited.mockResolvedValue(false);
		rateLimit.recordReauthAttempt.mockReset();
		rateLimit.recordReauthAttempt.mockResolvedValue(undefined);
		// One account with a second factor, so every TOTP reason is reachable on every action that
		// asks for one. The password-only actions must ignore it.
		db.prisma.user.findUnique.mockResolvedValue({
			passwordHash,
			totpEnabled: true,
			totpSecretEncrypted: storedSecretEncrypted
		});
		db.prisma.session.findFirst.mockResolvedValue({ id: 'autre-session' });
		tx.session.updateMany.mockResolvedValue({ count: 1 });
		backupImport.restoreBackup.mockResolvedValue(undefined);
	});

	it('has a case for exactly the settings half of REAUTH_FACTORS, each an action of this route', () => {
		const settingsHalf = Object.keys(reauth.REAUTH_FACTORS).filter((name) => name in actions);

		expect(ACTIONS.sort()).toEqual(settingsHalf.sort());
		// The rest of the registry is the admin route's, covered in admin/page.server.spec.ts.
		expect(Object.keys(reauth.REAUTH_FACTORS).filter((name) => !(name in actions))).toEqual([
			'deleteUser',
			'resetPassword'
		]);
	});

	it.each(ACTIONS)('calibration: %s with the right secrets reaches its write', async (action) => {
		const outcome = post(action, await credentialsFor(action, 'right'));
		// deleteAccount answers with its redirect to /login; the others return.
		await outcome.catch((thrown: { status?: number }) => {
			if (thrown?.status !== 303) throw thrown;
		});

		// Enrolment's success also carries the judged code's step (#818), for the enabling write.
		await expect(vi.mocked(reauth.reauthenticate).mock.results[0]?.value).resolves.toEqual(
			action === 'confirmTotpSetup' ? { ok: true, totpStep: expect.any(Number) } : { ok: true }
		);
		const written = CASES[action].writes().some((write) => write.mock.calls.length > 0);
		expect(written).toBe(true);
	});

	it.each(ROWS)('%s refuses %s with its reason, one sentence, and no write', async (a, r) => {
		const action = a as SettingsReauthAction;
		const reason = r as (typeof ROWS)[number][1];

		const result = (await post(action, await credentialsFor(action, reason))) as {
			status: number;
			data: Record<string, string>;
		};

		const decided = await vi.mocked(reauth.reauthenticate).mock.results[0]?.value;
		expect(decided).toMatchObject({ ok: false, reason });
		expect(result.status).toBe(400);
		expect(result.data[CASES[action].errorKey]).toBe(reauth.reauthRefusalMessage(decided));
		for (const write of CASES[action].writes()) expect(write.mock.calls).toEqual([]);
		expect(rateLimit.recordReauthAttempt).toHaveBeenCalledTimes(reason.startsWith('wrong') ? 1 : 0);
	});

	// Class 2 across reasons, compared to EACH OTHER rather than to a literal (#854, « What would
	// close this », point 2): a sentence that differed by reason would tell a stolen session which
	// factor it got right.
	it.each(ACTIONS)('%s says the same sentence whatever failed', async (action) => {
		const sentences = new Set<string>();
		for (const reason of reasonsFor(action)) {
			vi.clearAllMocks();
			db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
			const result = (await post(action, await credentialsFor(action, reason))) as {
				data: Record<string, string>;
			};
			sentences.add(result.data[CASES[action].errorKey]);
		}

		expect(sentences.size).toBe(1);
	});

	// The contradiction pass on S1, through the real action: the right password and a valid code
	// from a secret the CALLER chose, on an account that already has a second factor. Before the
	// fix this replaced the factor and returned fresh recovery codes. Separates « refused, nothing
	// written » from « the factor and the recovery codes taken over with the password alone ».
	it('confirmTotpSetup over an existing second factor is refused and writes nothing', async () => {
		const result = (await runAction('confirmTotpSetup', {
			token: 'session-courante',
			input: {
				secretBase32: enrollingSecret,
				currentPassword: PASSWORD,
				code: await totpCode(enrollingSecret)
			}
		})) as { status: number; data: Record<string, unknown> };

		await expect(vi.mocked(reauth.reauthenticate).mock.results[0]?.value).resolves.toMatchObject({
			ok: false,
			reason: 'totp-already-enabled'
		});
		expect(result.status).toBe(400);
		expect(result.data.totpSetupError).toBe(m.settings_mfa_error_already_enabled());
		expect(result.data.recoveryCodes).toBeUndefined();
		for (const write of CASES.confirmTotpSetup.writes()) expect(write.mock.calls).toEqual([]);
	});
});

/**
 * #904: the account has two-factor on and its stored secret no longer decrypts (the encryption key
 * was rotated). The settings page must say so rather than show a factor it can no longer check, and
 * `disableTotp` accepts the password plus a RECOVERY CODE in that state and only in that state
 * (owner ruling 2026-10-08). The re-authentication runs for real; the account row and the limiter
 * are this file's fakes, and the recovery-code rows are `unusedRecoveryCodes` below.
 */
describe('#904: settings with a stored secret that does not decrypt', () => {
	const PASSWORD = 'mot-de-passe-du-compte';
	const RECOVERY_CODE = 'ABCDE-12345';
	let passwordHash = '';
	let recoveryCodeHash = '';
	let totp: typeof import('$lib/server/auth/totp');

	beforeAll(async () => {
		totp = await import('$lib/server/auth/totp');
		passwordHash = await hashPassword(PASSWORD);
		recoveryCodeHash = await totp.hashRecoveryCode(RECOVERY_CODE);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		db.prisma.$transaction.mockImplementation(async (callback) => callback(tx));
		rateLimit.isReauthRateLimited.mockReset();
		rateLimit.isReauthRateLimited.mockResolvedValue(false);
		rateLimit.recordReauthAttempt.mockReset();
		rateLimit.recordReauthAttempt.mockResolvedValue(undefined);
		db.prisma.user.updateMany.mockResolvedValue({ count: 1 });
		db.prisma.session.findMany.mockResolvedValue([]);
		tagsService.listTagsWithCounts.mockResolvedValue([]);
		mappingStore.listColumnMappings.mockResolvedValue([]);
		mappingStore.resolveColumnMappingsPerUser.mockReturnValue(50);
		db.prisma.account.findMany.mockResolvedValue([]);
		netWorthService.readLinkableNetWorthAccounts.mockResolvedValue([]);
		unusedRecoveryCodes([{ id: 'code-1', codeHash: recoveryCodeHash }]);
	});

	/**
	 * The account's unused recovery codes, with the semantics of the only spender in the tree
	 * (`login/verify-totp`'s): a read of the caller's unused rows, then a conditional update by id.
	 * A clause the fake cannot model throws; an absent one is no filter, as in Prisma, and every row
	 * here is the caller's.
	 */
	function unusedRecoveryCodes(rows: Array<{ id: string; codeHash: string }>) {
		db.prisma.recoveryCode.findMany.mockImplementation(
			async (args: { where?: Record<string, unknown> }) => {
				const unmodelled = Object.keys(args?.where ?? {}).filter(
					(key) => key !== 'userId' && key !== 'usedAt'
				);
				if (unmodelled.length > 0) {
					throw new Error(`recoveryCode fake: cannot model where.${unmodelled.join(', where.')}`);
				}
				return rows;
			}
		);
		db.prisma.recoveryCode.updateMany.mockImplementation(
			async (args: { where?: { id?: unknown } }) => {
				if (typeof args?.where?.id !== 'string') {
					throw new Error('recoveryCode fake: cannot model an update not keyed by one id');
				}
				return { count: rows.some((row) => row.id === args.where?.id) ? 1 : 0 };
			}
		);
	}

	function unreadableSecret(): string {
		return ciphertextUnderAnotherKey(totp.generateTotpSecretBase32());
	}

	function readableSecret(): string {
		return totp.encryptTotpSecret(totp.generateTotpSecretBase32());
	}

	async function mfaFor(factor: { totpEnabled: boolean; totpSecretEncrypted: string | null }) {
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			email: 'user-a@example.test',
			role: 'USER',
			aiInsightsEnabled: false,
			aiIncludeLabels: false
		});
		// The factor columns are read by `readFactorState`, not by the load's own select.
		db.prisma.user.findUnique.mockResolvedValue(factor);
		const result = (await load(buildLoadEvent({ token: 'session-courante' }) as never)) as {
			mfa: unknown;
		};
		return result.mfa;
	}

	// Calibration of the fixture: the tests below are only about an UNREADABLE secret if it fails at
	// decryption under the application's key while the application's own ciphertext decrypts.
	it('calibration: the fixture fails at decryption, where the application ciphertext decrypts', () => {
		const secret = totp.generateTotpSecretBase32();
		let unreadable: string;
		try {
			totp.decryptTotpSecret(ciphertextUnderAnotherKey(secret));
			unreadable = 'decrypted';
		} catch (caught) {
			unreadable = (caught as Error).message;
		}
		expect({
			unreadable,
			readable: totp.decryptTotpSecret(totp.encryptTotpSecret(secret)) === secret
		}).toEqual({ unreadable: 'Unsupported state or unable to authenticate data', readable: true });
	});

	// Separates « a factor the server can no longer check » from « a working factor »: today both
	// read `{ enabled: true }`, and the page offers a disable that no code can pass.
	it('load reports the factor as unreadable when its stored secret is under another key', async () => {
		expect(await mfaFor({ totpEnabled: true, totpSecretEncrypted: unreadableSecret() })).toEqual({
			status: 'unreadable'
		});
	});

	it('load reports the factor as enabled when its stored secret decrypts', async () => {
		expect(await mfaFor({ totpEnabled: true, totpSecretEncrypted: readableSecret() })).toEqual({
			status: 'enabled'
		});
	});

	it('load reports the factor as disabled when the account has none', async () => {
		expect(await mfaFor({ totpEnabled: false, totpSecretEncrypted: null })).toEqual({
			status: 'disabled'
		});
	});

	// A page view is not an attempt to authenticate, so it writes no `crypt_decrypt_fail` (the
	// contradiction pass on the design note: a line per GET of /settings, per affected user, after a
	// key change). The event is written where a code is JUDGED, which `reauth.spec.ts` and the
	// sign-in spec assert. The calibration is a line written through the same module the route
	// imports, so a zero here cannot come from a capture that sees nothing.
	it('load writes no line in any state, where the capture sees a line written through the module', async () => {
		const { log } = await import('$lib/server/logging');
		log({ event: 'session_logout', attributes: {} } as never);
		const calibration = logWriter.log.mock.calls.length;
		logWriter.log.mockClear();

		await mfaFor({ totpEnabled: true, totpSecretEncrypted: unreadableSecret() });
		const unreadable = logWriter.log.mock.calls.length;
		await mfaFor({ totpEnabled: true, totpSecretEncrypted: readableSecret() });
		const readable = logWriter.log.mock.calls.length - unreadable;

		expect({ calibration, unreadable, readable }).toEqual({
			calibration: 1,
			unreadable: 0,
			readable: 0
		});
	});

	// The ruling's one way out. Separates « two-factor turned off with the password and a recovery
	// code » from today's `missing-totp`, which leaves an owner whose key was rotated unable to
	// disable a factor nothing can check.
	it('disableTotp with an unreadable secret, the right password and a valid recovery code turns two-factor off', async () => {
		db.prisma.user.findUnique.mockResolvedValue({
			passwordHash,
			totpEnabled: true,
			totpSecretEncrypted: unreadableSecret()
		});

		await runAction('disableTotp', {
			token: 'session-courante',
			input: { currentPassword: PASSWORD, code: RECOVERY_CODE }
		});

		expect(
			tx.user.update.mock.calls.map(([args]) => (args as { data: Record<string, unknown> }).data)
		).toEqual([
			{ totpEnabled: false, totpSecretEncrypted: null, totpEnabledAt: null, totpLastUsedStep: null }
		]);
	});

	// A pin of the ruling's « only in that state »: against a READABLE secret a recovery code is not
	// a re-authentication factor (#886 stays separate). Separates « refused as a missing code, no
	// recovery code read or spent » from a recovery-code path that does not check the secret first.
	it('disableTotp with a readable secret refuses the same recovery code, reading and spending none', async () => {
		db.prisma.user.findUnique.mockResolvedValue({
			passwordHash,
			totpEnabled: true,
			totpSecretEncrypted: readableSecret()
		});

		const result = await runAction('disableTotp', {
			token: 'session-courante',
			input: { currentPassword: PASSWORD, code: RECOVERY_CODE }
		});

		expect({
			decided: await vi.mocked(reauth.reauthenticate).mock.results[0]?.value,
			status: result.status,
			codesRead: db.prisma.recoveryCode.findMany.mock.calls.length,
			codesSpent: db.prisma.recoveryCode.updateMany.mock.calls.length,
			factorWrites: tx.user.update.mock.calls.length
		}).toEqual({
			decided: { ok: false, reason: 'missing-totp', asked: 'password-and-code' },
			status: 400,
			codesRead: 0,
			codesSpent: 0,
			factorWrites: 0
		});
	});
});

/**
 * A stored secret in the production format (`iv:authTag:ciphertext`, base64url) that does NOT
 * decrypt under the application's key: AES-256-GCM under another 32-byte key, as a rotated
 * `TOTP_ENCRYPTION_KEY` leaves every enrolled secret. Built here rather than by mocking
 * `decryptSecret`, so it is the real decryption that fails, at the authentication tag.
 */
function ciphertextUnderAnotherKey(plaintext: string): string {
	const anotherKey = Buffer.from('e7'.repeat(32), 'hex');
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', anotherKey, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join(':');
}

function buildCookies(token: string | undefined) {
	return {
		get: vi.fn((name: string) => (name === SESSION_COOKIE ? token : undefined)),
		delete: vi.fn()
	};
}

function buildRequest(input: Record<string, string>) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(input)) formData.set(key, value);

	return new Request('http://localhost/settings', {
		method: 'POST',
		body: formData
	});
}

function buildLoadEvent({ token }: { token?: string }) {
	return {
		cookies: buildCookies(token),
		locals: {
			user: { id: 'user-a', email: 'user-a@example.test', role: 'USER', sessionId: 'session-a' }
		}
	};
}

async function runAction(
	name: keyof typeof actions,
	{
		token,
		input = {}
	}: {
		token?: string;
		input?: Record<string, string>;
	}
) {
	return (await invokeAction(name, {
		cookies: buildCookies(token),
		getClientAddress: () => '203.0.113.10',
		request: buildRequest(input),
		locals: {
			user: { id: 'user-a', email: 'user-a@example.test', role: 'USER', sessionId: 'session-a' }
		}
	})) as {
		status?: number;
		data?: Record<string, string>;
		passwordSuccess?: string;
		sessionsSuccess?: string;
	};
}

async function invokeAction(
	name: keyof typeof actions,
	event: {
		cookies: ReturnType<typeof buildCookies>;
		getClientAddress?: () => string;
		request: Request;
		locals: {
			user: { id: string; email: string; role: 'USER'; sessionId: string };
		};
	}
) {
	return (actions[name] as unknown as (input: typeof event) => Promise<unknown>)({
		getClientAddress: () => '203.0.113.10',
		...event
	});
}

function buildBackupFile(content: string, name = 'backup.json'): File {
	// Real content (not a spoofed size): FormData clones the underlying Blob,
	// so only the actual content size triggers the limit server-side.
	return new File([content], name, { type: 'application/json' });
}

const RESTORE_PASSWORD = 'mot-de-passe-de-restauration';

function buildBackupFormData(file: File): FormData {
	const formData = new FormData();
	formData.set('backupFile', file);
	formData.set('currentPassword', RESTORE_PASSWORD);
	return formData;
}

function buildValidBackupPayload() {
	return {
		formatVersion: 1,
		exportedAt: new Date().toISOString(),
		userEmail: 'user-a@example.test',
		accounts: [],
		categories: [],
		importBatches: [],
		transactions: [],
		monthlyBudgets: [],
		categoryRules: [],
		categorizationRules: [],
		categoryNatureMappings: []
	};
}

async function runRestoreAction(formData: FormData) {
	return invokeAction('restoreData', {
		cookies: buildCookies('session-courante'),
		request: new Request('http://localhost/settings', { method: 'POST', body: formData }),
		locals: {
			user: { id: 'user-a', email: 'user-a@example.test', role: 'USER', sessionId: 'session-a' }
		}
	});
}
