import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
	prisma: {
		savingsGoal: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn()
		},
		netWorthAccount: {
			findFirst: vi.fn()
		},
		netWorthSnapshot: {
			findMany: vi.fn()
		}
	}
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const {
	createSavingsGoal,
	deleteSavingsGoal,
	dismissReachedBanner,
	readSavingsGoalHistory,
	readSavingsGoals,
	updateSavingsGoal
} = await import('./service');

const userId = 'user-00000001';
const goalId = 'goal-00000001';

function makeGoal(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: goalId,
		userId,
		name: 'Vacances',
		targetAmountCents: 100_000,
		currentAmountCents: 0,
		startingBalanceCents: 0,
		targetDate: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		reachedAt: null,
		reachedBannerDismissedAt: null,
		netWorthAccountId: null,
		netWorthAccount: null,
		...overrides
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('readSavingsGoals', () => {
	it('filtre par userId et exclut les goals soft-deleted', async () => {
		db.prisma.savingsGoal.findMany.mockResolvedValue([]);

		await readSavingsGoals(userId);

		expect(db.prisma.savingsGoal.findMany).toHaveBeenCalledWith({
			where: { userId, deletedAt: null },
			orderBy: { createdAt: 'asc' },
			include: {
				netWorthAccount: {
					select: { id: true, name: true, balanceCents: true, deletedAt: true }
				}
			}
		});
	});

	it('écrit reachedAt une seule fois quand la cible est atteinte pour la première fois', async () => {
		db.prisma.savingsGoal.findMany.mockResolvedValue([
			makeGoal({ currentAmountCents: 100_000, reachedAt: null })
		]);

		const result = await readSavingsGoals(userId);

		expect(db.prisma.savingsGoal.update).toHaveBeenCalledTimes(1);
		expect(db.prisma.savingsGoal.update).toHaveBeenCalledWith({
			where: { id: goalId },
			data: { reachedAt: expect.any(Date) }
		});
		expect(result[0].status).toBe('reached');
		expect(result[0].reachedAt).not.toBeNull();
	});

	it("ne réécrit pas reachedAt lors d'une deuxième lecture (déjà non-null)", async () => {
		const alreadyReachedAt = new Date('2026-02-01T00:00:00.000Z');
		db.prisma.savingsGoal.findMany.mockResolvedValue([
			makeGoal({ currentAmountCents: 100_000, reachedAt: alreadyReachedAt })
		]);

		const result = await readSavingsGoals(userId);

		expect(db.prisma.savingsGoal.update).not.toHaveBeenCalled();
		expect(result[0].reachedAt).toBe(alreadyReachedAt.toISOString());
	});

	it('lit le solde live du compte lié plutôt que currentAmountCents figé', async () => {
		db.prisma.savingsGoal.findMany.mockResolvedValue([
			makeGoal({
				currentAmountCents: 10_000, // stale value stored on the goal
				netWorthAccountId: 'acc-1',
				netWorthAccount: { id: 'acc-1', name: 'Livret A', balanceCents: 42_000, deletedAt: null }
			})
		]);

		const result = await readSavingsGoals(userId);

		expect(result[0].currentAmountCents).toBe(42_000);
		expect(result[0].linkedAccount).toEqual({ id: 'acc-1', name: 'Livret A' });
		expect(result[0].linkStale).toBe(false);
	});

	it('resynchronise currentAmountCents avec le solde live du compte lié (write-on-read)', async () => {
		db.prisma.savingsGoal.findMany.mockResolvedValue([
			makeGoal({
				currentAmountCents: 10_000, // stale value stored on the goal
				netWorthAccountId: 'acc-1',
				netWorthAccount: { id: 'acc-1', name: 'Livret A', balanceCents: 42_000, deletedAt: null }
			})
		]);

		await readSavingsGoals(userId);

		expect(db.prisma.savingsGoal.update).toHaveBeenCalledWith({
			where: { id: goalId },
			data: { currentAmountCents: 42_000 }
		});
	});

	it("ne réécrit rien si le solde live du compte lié n'a pas changé", async () => {
		db.prisma.savingsGoal.findMany.mockResolvedValue([
			makeGoal({
				currentAmountCents: 42_000,
				netWorthAccountId: 'acc-1',
				netWorthAccount: { id: 'acc-1', name: 'Livret A', balanceCents: 42_000, deletedAt: null }
			})
		]);

		await readSavingsGoals(userId);

		expect(db.prisma.savingsGoal.update).not.toHaveBeenCalled();
	});

	it('retombe sur le dernier currentAmountCents connu si le compte lié est soft-deleted (linkStale)', async () => {
		db.prisma.savingsGoal.findMany.mockResolvedValue([
			makeGoal({
				currentAmountCents: 15_000,
				netWorthAccountId: 'acc-1',
				netWorthAccount: {
					id: 'acc-1',
					name: 'Livret A',
					balanceCents: 99_000,
					deletedAt: new Date('2026-03-01T00:00:00.000Z')
				}
			})
		]);

		const result = await readSavingsGoals(userId);

		expect(result[0].currentAmountCents).toBe(15_000);
		expect(result[0].linkedAccount).toBeNull();
		expect(result[0].linkStale).toBe(true);
	});
});

describe('readSavingsGoalHistory', () => {
	it('404 sur un id malformé sans toucher la base', async () => {
		await expect(readSavingsGoalHistory(userId, 'x')).rejects.toThrow();
		expect(db.prisma.savingsGoal.findFirst).not.toHaveBeenCalled();
	});

	it("404 si le goal n'appartient pas à l'utilisateur ou est supprimé", async () => {
		db.prisma.savingsGoal.findFirst.mockResolvedValue(null);

		await expect(readSavingsGoalHistory(userId, goalId)).rejects.toThrow();

		expect(db.prisma.savingsGoal.findFirst).toHaveBeenCalledWith({
			where: { id: goalId, userId, deletedAt: null },
			select: { netWorthAccountId: true }
		});
	});

	it('renvoie [] sans requêter les snapshots pour un goal en suivi manuel (pas de compte lié)', async () => {
		db.prisma.savingsGoal.findFirst.mockResolvedValue({ netWorthAccountId: null });

		const result = await readSavingsGoalHistory(userId, goalId);

		expect(result).toEqual([]);
		expect(db.prisma.netWorthSnapshot.findMany).not.toHaveBeenCalled();
	});

	it('lit les snapshots du compte lié, filtrés par userId', async () => {
		db.prisma.savingsGoal.findFirst.mockResolvedValue({ netWorthAccountId: 'acc-1' });
		db.prisma.netWorthSnapshot.findMany.mockResolvedValue([
			{ capturedAt: new Date('2026-01-01T00:00:00.000Z'), balanceCents: 1000 }
		]);

		const result = await readSavingsGoalHistory(userId, goalId);

		expect(db.prisma.netWorthSnapshot.findMany).toHaveBeenCalledWith({
			where: { userId, accountId: 'acc-1' },
			orderBy: { capturedAt: 'asc' },
			select: { capturedAt: true, balanceCents: true }
		});
		expect(result).toEqual([{ capturedAt: '2026-01-01T00:00:00.000Z', balanceCents: 1000 }]);
	});
});

describe('createSavingsGoal', () => {
	it('crée un goal en suivi manuel scopé userId, currentAmount = startingBalance', async () => {
		db.prisma.savingsGoal.create.mockResolvedValue({ id: goalId });

		const result = await createSavingsGoal(userId, {
			name: 'Vacances',
			targetAmount: '1000',
			trackingMode: 'manual',
			currentAmount: '250'
		});

		expect(result).toEqual({ id: goalId });
		expect(db.prisma.savingsGoal.create).toHaveBeenCalledWith({
			data: {
				userId,
				name: 'Vacances',
				targetAmountCents: 100_000,
				netWorthAccountId: null,
				currentAmountCents: 25_000,
				startingBalanceCents: 25_000,
				targetDate: null
			},
			select: { id: true }
		});
	});

	it('rejette un nom vide sans toucher la base', async () => {
		await expect(
			createSavingsGoal(userId, { name: '   ', targetAmount: '1000', trackingMode: 'manual' })
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
	});

	it('rejette un montant cible <= 0', async () => {
		await expect(
			createSavingsGoal(userId, { name: 'X', targetAmount: '0', trackingMode: 'manual' })
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
	});

	it('rejette un montant cible négatif', async () => {
		await expect(
			createSavingsGoal(userId, { name: 'X', targetAmount: '-100', trackingMode: 'manual' })
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
	});

	it('rejette un montant cible au-dessus de MAX_TARGET_AMOUNT_CENTS (1 000 000 000 centimes)', async () => {
		await expect(
			createSavingsGoal(userId, { name: 'X', targetAmount: '10000001', trackingMode: 'manual' })
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
	});

	it('accepte un montant cible juste sous MAX_TARGET_AMOUNT_CENTS', async () => {
		db.prisma.savingsGoal.create.mockResolvedValue({ id: goalId });

		await createSavingsGoal(userId, {
			name: 'X',
			targetAmount: '9999999.99',
			trackingMode: 'manual'
		});

		expect(db.prisma.savingsGoal.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ targetAmountCents: 999_999_999 }) })
		);
	});

	it('currentAmount absent = 0, sans appeler le parseur (pas de rejet sur une entrée vide)', async () => {
		db.prisma.savingsGoal.create.mockResolvedValue({ id: goalId });

		await createSavingsGoal(userId, { name: 'X', targetAmount: '1000', trackingMode: 'manual' });

		expect(db.prisma.savingsGoal.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ currentAmountCents: 0, startingBalanceCents: 0 })
			})
		);
	});

	it('currentAmount="0" accepté', async () => {
		db.prisma.savingsGoal.create.mockResolvedValue({ id: goalId });

		await createSavingsGoal(userId, {
			name: 'X',
			targetAmount: '1000',
			trackingMode: 'manual',
			currentAmount: '0'
		});

		expect(db.prisma.savingsGoal.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ currentAmountCents: 0 }) })
		);
	});

	it('rejette un currentAmount négatif', async () => {
		await expect(
			createSavingsGoal(userId, {
				name: 'X',
				targetAmount: '1000',
				trackingMode: 'manual',
				currentAmount: '-100'
			})
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
	});

	it('rejette un trackingMode inconnu', async () => {
		await expect(
			createSavingsGoal(userId, { name: 'X', targetAmount: '1000', trackingMode: 'auto' })
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
	});

	it('rejette targetDate malformée', async () => {
		await expect(
			createSavingsGoal(userId, {
				name: 'X',
				targetAmount: '1000',
				trackingMode: 'manual',
				targetDate: '01/01/2027'
			})
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
	});

	describe('linking validation (trackingMode=linked)', () => {
		it('lie le goal au compte cible et reprend son solde comme currentAmountCents', async () => {
			db.prisma.netWorthAccount.findFirst.mockResolvedValue({
				type: 'savings',
				balanceCents: 5_000
			});
			db.prisma.savingsGoal.create.mockResolvedValue({ id: goalId });

			await createSavingsGoal(userId, {
				name: 'Vacances',
				targetAmount: '1000',
				trackingMode: 'linked',
				netWorthAccountId: 'acc-00000001'
			});

			expect(db.prisma.netWorthAccount.findFirst).toHaveBeenCalledWith({
				where: { id: 'acc-00000001', userId, deletedAt: null },
				select: { type: true, balanceCents: true }
			});
			expect(db.prisma.savingsGoal.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					netWorthAccountId: 'acc-00000001',
					currentAmountCents: 5_000,
					startingBalanceCents: 5_000
				}),
				select: { id: true }
			});
		});

		it('rejette la liaison sans netWorthAccountId', async () => {
			await expect(
				createSavingsGoal(userId, { name: 'X', targetAmount: '1000', trackingMode: 'linked' })
			).rejects.toThrow();
			expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
		});

		it("rejette la liaison vers un compte d'un autre utilisateur (le lookup est scopé userId, donc il ressort introuvable)", async () => {
			db.prisma.netWorthAccount.findFirst.mockResolvedValue(null);

			await expect(
				createSavingsGoal(userId, {
					name: 'X',
					targetAmount: '1000',
					trackingMode: 'linked',
					netWorthAccountId: 'acc-other-user'
				})
			).rejects.toThrow();

			expect(db.prisma.netWorthAccount.findFirst).toHaveBeenCalledWith({
				where: { id: 'acc-other-user', userId, deletedAt: null },
				select: { type: true, balanceCents: true }
			});
			expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
		});

		it('rejette la liaison vers un compte soft-deleted (exclu par le deletedAt: null du lookup)', async () => {
			db.prisma.netWorthAccount.findFirst.mockResolvedValue(null);

			await expect(
				createSavingsGoal(userId, {
					name: 'X',
					targetAmount: '1000',
					trackingMode: 'linked',
					netWorthAccountId: 'acc-deleted'
				})
			).rejects.toThrow();
			expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
		});

		it('rejette la liaison vers un type non-liable (real_estate)', async () => {
			db.prisma.netWorthAccount.findFirst.mockResolvedValue({
				type: 'real_estate',
				balanceCents: 100_000
			});

			await expect(
				createSavingsGoal(userId, {
					name: 'X',
					targetAmount: '1000',
					trackingMode: 'linked',
					netWorthAccountId: 'acc-house'
				})
			).rejects.toThrow();
			expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
		});

		it('rejette la liaison vers un type non-liable (other)', async () => {
			db.prisma.netWorthAccount.findFirst.mockResolvedValue({
				type: 'other',
				balanceCents: 100_000
			});

			await expect(
				createSavingsGoal(userId, {
					name: 'X',
					targetAmount: '1000',
					trackingMode: 'linked',
					netWorthAccountId: 'acc-misc'
				})
			).rejects.toThrow();
			expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
		});

		it('rejette la liaison vers un compte de type debt (sémantique inversée, pas de sens pour un objectif)', async () => {
			db.prisma.netWorthAccount.findFirst.mockResolvedValue({
				type: 'debt',
				balanceCents: 100_000
			});

			await expect(
				createSavingsGoal(userId, {
					name: 'X',
					targetAmount: '1000',
					trackingMode: 'linked',
					netWorthAccountId: 'acc-debt'
				})
			).rejects.toThrow();
			expect(db.prisma.savingsGoal.create).not.toHaveBeenCalled();
		});
	});
});

describe('updateSavingsGoal', () => {
	it('404 sur un id malformé sans toucher la base', async () => {
		await expect(
			updateSavingsGoal(userId, 'x', { name: 'X', targetAmount: '1000', trackingMode: 'manual' })
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.findFirst).not.toHaveBeenCalled();
	});

	it("404 si le goal n'appartient pas à l'utilisateur ou est supprimé", async () => {
		db.prisma.savingsGoal.findFirst.mockResolvedValue(null);

		await expect(
			updateSavingsGoal(userId, goalId, { name: 'X', targetAmount: '1000', trackingMode: 'manual' })
		).rejects.toThrow();

		expect(db.prisma.savingsGoal.findFirst).toHaveBeenCalledWith({
			where: { id: goalId, userId, deletedAt: null }
		});
		expect(db.prisma.savingsGoal.updateMany).not.toHaveBeenCalled();
	});

	it('scope la mise à jour par id ET userId, et ne touche jamais startingBalanceCents', async () => {
		db.prisma.savingsGoal.findFirst.mockResolvedValue(makeGoal({ startingBalanceCents: 12_345 }));

		await updateSavingsGoal(userId, goalId, {
			name: 'Vacances 2',
			targetAmount: '2000',
			trackingMode: 'manual',
			currentAmount: '500'
		});

		expect(db.prisma.savingsGoal.updateMany).toHaveBeenCalledTimes(1);
		const call = db.prisma.savingsGoal.updateMany.mock.calls[0][0];
		expect(call.where).toEqual({ id: goalId, userId });
		expect(call.data).not.toHaveProperty('startingBalanceCents');
		expect(call.data).toEqual({
			name: 'Vacances 2',
			targetAmountCents: 200_000,
			netWorthAccountId: null,
			currentAmountCents: 50_000,
			targetDate: null
		});
	});

	it("rejette la re-liaison vers un compte d'un autre utilisateur", async () => {
		db.prisma.savingsGoal.findFirst.mockResolvedValue(makeGoal());
		db.prisma.netWorthAccount.findFirst.mockResolvedValue(null);

		await expect(
			updateSavingsGoal(userId, goalId, {
				name: 'X',
				targetAmount: '1000',
				trackingMode: 'linked',
				netWorthAccountId: 'acc-other-user'
			})
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.updateMany).not.toHaveBeenCalled();
	});

	it('rejette la re-liaison vers un type non-liable', async () => {
		db.prisma.savingsGoal.findFirst.mockResolvedValue(makeGoal());
		db.prisma.netWorthAccount.findFirst.mockResolvedValue({
			type: 'real_estate',
			balanceCents: 100_000
		});

		await expect(
			updateSavingsGoal(userId, goalId, {
				name: 'X',
				targetAmount: '1000',
				trackingMode: 'linked',
				netWorthAccountId: 'acc-house'
			})
		).rejects.toThrow();
		expect(db.prisma.savingsGoal.updateMany).not.toHaveBeenCalled();
	});
});

describe('deleteSavingsGoal', () => {
	it('404 sur un id malformé sans toucher la base', async () => {
		await expect(deleteSavingsGoal(userId, 'x')).rejects.toThrow();
		expect(db.prisma.savingsGoal.updateMany).not.toHaveBeenCalled();
	});

	it('soft-delete scopé par id ET userId (deletedAt renseigné, pas de suppression physique)', async () => {
		db.prisma.savingsGoal.updateMany.mockResolvedValue({ count: 1 });

		await deleteSavingsGoal(userId, goalId);

		expect(db.prisma.savingsGoal.updateMany).toHaveBeenCalledWith({
			where: { id: goalId, userId, deletedAt: null },
			data: { deletedAt: expect.any(Date) }
		});
	});

	it("404 si aucune ligne mise à jour (goal d'un autre utilisateur ou déjà supprimé)", async () => {
		db.prisma.savingsGoal.updateMany.mockResolvedValue({ count: 0 });

		await expect(deleteSavingsGoal(userId, goalId)).rejects.toThrow();
	});

	it('un goal soft-deleted disparaît de readSavingsGoals (filtré au niveau du findMany)', async () => {
		db.prisma.savingsGoal.updateMany.mockResolvedValue({ count: 1 });
		await deleteSavingsGoal(userId, goalId);

		db.prisma.savingsGoal.findMany.mockResolvedValue([]);
		const result = await readSavingsGoals(userId);

		expect(db.prisma.savingsGoal.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId, deletedAt: null } })
		);
		expect(result).toEqual([]);
	});
});

describe('dismissReachedBanner', () => {
	it('404 sur un id malformé sans toucher la base', async () => {
		await expect(dismissReachedBanner(userId, 'x')).rejects.toThrow();
		expect(db.prisma.savingsGoal.updateMany).not.toHaveBeenCalled();
	});

	it('scope par userId + id ET exige reachedAt déjà non-null', async () => {
		db.prisma.savingsGoal.updateMany.mockResolvedValue({ count: 1 });

		await dismissReachedBanner(userId, goalId);

		expect(db.prisma.savingsGoal.updateMany).toHaveBeenCalledWith({
			where: { id: goalId, userId, deletedAt: null, reachedAt: { not: null } },
			data: { reachedBannerDismissedAt: expect.any(Date) }
		});
	});

	it("404 si le goal n'est pas encore reached (aucune ligne matchée par reachedAt: { not: null })", async () => {
		db.prisma.savingsGoal.updateMany.mockResolvedValue({ count: 0 });

		await expect(dismissReachedBanner(userId, goalId)).rejects.toThrow();
	});

	it('404 si le goal appartient à un autre utilisateur', async () => {
		db.prisma.savingsGoal.updateMany.mockResolvedValue({ count: 0 });

		await expect(dismissReachedBanner('other-user', goalId)).rejects.toThrow();

		expect(db.prisma.savingsGoal.updateMany).toHaveBeenCalledWith({
			where: { id: goalId, userId: 'other-user', deletedAt: null, reachedAt: { not: null } },
			data: { reachedBannerDismissedAt: expect.any(Date) }
		});
	});
});
