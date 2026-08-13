import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.TOTP_ENCRYPTION_KEY ??=
		'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.slice(0, 64);
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
			update: vi.fn()
		},
		session: {
			findMany: vi.fn(),
			findUnique: vi.fn(),
			updateMany: vi.fn()
		},
		recoveryCode: {
			deleteMany: vi.fn(),
			createMany: vi.fn()
		},
		$transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
	}
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

const { hashPassword, hashSessionToken, SESSION_COOKIE } = await import('$lib/server/auth');
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
	});

	it('charge uniquement les sessions du user connecté sans exposer token hash ni passwordHash', async () => {
		expect.assertions(7);

		const token = 'session-courante';
		const currentTokenHash = hashSessionToken(token);
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
		db.prisma.session.findMany.mockResolvedValue([
			{
				id: 'session-1',
				tokenHash: currentTokenHash,
				createdAt: sessionCreatedAt,
				expiresAt: sessionExpiresAt,
				revokedAt: null
			}
		]);

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
				tokenHash: true,
				createdAt: true,
				expiresAt: true,
				revokedAt: true
			},
			orderBy: { createdAt: 'desc' }
		});
		expect(result.account).toEqual({ email: 'user-a@example.test', role: 'USER' });
		expect(result.sessions).toEqual([
			{
				id: 'session-1',
				createdAt: sessionCreatedAt,
				expiresAt: sessionExpiresAt,
				isCurrent: true,
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

	it('expose les indicateurs de sécurité et marque les sessions expirées ou révoquées pour l UI', async () => {
		expect.assertions(3);

		vi.stubEnv('LLM_ENABLED', 'true');
		fs.existsSync.mockReturnValue(true);
		db.prisma.user.findUniqueOrThrow.mockResolvedValue({
			email: 'user-a@example.test',
			role: 'USER'
		});
		db.prisma.session.findMany.mockResolvedValue([
			{
				tokenHash: 'session-revoquee',
				createdAt: new Date('2026-06-21T10:00:00.000Z'),
				expiresAt: new Date('2026-07-21T10:00:00.000Z'),
				revokedAt: new Date('2026-06-22T10:00:00.000Z')
			},
			{
				tokenHash: 'session-expiree',
				createdAt: new Date('2026-06-20T10:00:00.000Z'),
				expiresAt: new Date('2026-06-21T10:00:00.000Z'),
				revokedAt: null
			}
		]);

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
			latestSessionCreatedAt: new Date('2026-06-21T10:00:00.000Z')
		});
		expect(result.sessions).toEqual([
			{
				createdAt: new Date('2026-06-21T10:00:00.000Z'),
				expiresAt: new Date('2026-07-21T10:00:00.000Z'),
				isCurrent: false,
				status: 'revoked'
			},
			{
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
		const currentTokenHash = hashSessionToken('session-courante');
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
			select: { passwordHash: true }
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
		expect(tx.session.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId: 'user-a',
					revokedAt: null,
					tokenHash: { not: currentTokenHash }
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
		expect(result.data.passwordError).toBe('Impossible de mettre à jour le mot de passe.');
		expect(tx.user.update).not.toHaveBeenCalled();
		expect(tx.session.updateMany).not.toHaveBeenCalled();
	});

	it('révoque seulement les autres sessions du user courant', async () => {
		expect.assertions(2);

		const currentTokenHash = hashSessionToken('session-courante');
		db.prisma.session.updateMany.mockResolvedValue({ count: 3 });

		const result = await runAction('revokeOtherSessions', {
			token: 'session-courante'
		});

		expect(result).toEqual({ sessionsSuccess: 'Les autres sessions ont été déconnectées.' });
		expect(db.prisma.session.updateMany).toHaveBeenCalledWith({
			where: {
				userId: 'user-a',
				revokedAt: null,
				tokenHash: { not: currentTokenHash }
			},
			data: {
				revokedAt: expect.any(Date)
			}
		});
	});

	describe('revokeSession', () => {
		it('révoque une session ciblée appartenant au user courant', async () => {
			expect.assertions(2);

			db.prisma.session.findUnique.mockResolvedValue({
				userId: 'user-a',
				tokenHash: 'autre-session-hash'
			});
			db.prisma.session.updateMany.mockResolvedValue({ count: 1 });

			const result = await runAction('revokeSession', {
				token: 'session-courante',
				input: { sessionId: 'session-cible' }
			});

			expect(result).toEqual({ sessionsSuccess: 'La session a été révoquée.' });
			expect(db.prisma.session.updateMany).toHaveBeenCalledWith({
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
			expect(db.prisma.session.updateMany).not.toHaveBeenCalled();
		});

		it('refuse de révoquer une session appartenant à un autre utilisateur (404, aucune mutation)', async () => {
			expect.assertions(3);

			db.prisma.session.findUnique.mockResolvedValue({
				userId: 'user-b',
				tokenHash: 'session-hash-user-b'
			});

			const result = (await runAction('revokeSession', {
				token: 'session-courante',
				input: { sessionId: 'session-user-b' }
			})) as { status: number; data: { sessionsError: string } };

			expect(result.status).toBe(404);
			expect(typeof result.data.sessionsError).toBe('string');
			expect(db.prisma.session.updateMany).not.toHaveBeenCalled();
		});

		it('refuse de révoquer la session courante via cette action dédiée', async () => {
			expect.assertions(3);

			const currentTokenHash = hashSessionToken('session-courante');
			db.prisma.session.findUnique.mockResolvedValue({
				userId: 'user-a',
				tokenHash: currentTokenHash
			});

			const result = (await runAction('revokeSession', {
				token: 'session-courante',
				input: { sessionId: 'session-courante-id' }
			})) as { status: number; data: { sessionsError: string } };

			expect(result.status).toBe(400);
			expect(typeof result.data.sessionsError).toBe('string');
			expect(db.prisma.session.updateMany).not.toHaveBeenCalled();
		});
	});

	describe('deleteAccount (#220: phrase confirms intent, password/TOTP authenticate)', () => {
		async function deleteWith(input: Record<string, string>) {
			return invokeAction('deleteAccount', {
				cookies: buildCookies('session-courante'),
				request: buildRequest(input),
				locals: {
					user: { id: 'user-a', email: 'user-a@example.test', role: 'USER' }
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
					locals: { user: { id: 'user-a', email: 'user-a@example.test', role: 'USER' } }
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
			expect(result.data.deleteError).toBe('Mot de passe ou code incorrect.');
			expect(tx.user.delete).not.toHaveBeenCalled();
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('user-a', '203.0.113.10');
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
			expect(result.data.deleteError).toBe('Mot de passe ou code incorrect.');
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
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('user-a', '203.0.113.10');
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
			expect.assertions(4);

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
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('user-a', '203.0.113.10');
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
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('user-a', '203.0.113.10');
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
			expect(rateLimit.recordReauthAttempt).toHaveBeenCalledWith('user-a', '203.0.113.10');
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
			expect.assertions(3);

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
			expect.assertions(5);

			const { generateTotpSecretBase32 } = await import('$lib/server/auth/totp');
			const OTPAuth = await import('otpauth');
			const secretBase32 = generateTotpSecretBase32();
			const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
			const code = totp.generate();
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
});

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
			user: { id: 'user-a', email: 'user-a@example.test', role: 'USER' }
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
			user: { id: 'user-a', email: 'user-a@example.test', role: 'USER' }
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
			user: { id: string; email: string; role: 'USER' };
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

function buildBackupFormData(file: File): FormData {
	const formData = new FormData();
	formData.set('backupFile', file);
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
			user: { id: 'user-a', email: 'user-a@example.test', role: 'USER' }
		}
	});
}
