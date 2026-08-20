import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeNameKey } from '$lib/server/naming/nameKey';

const tx = vi.hoisted(() => ({
	netWorthAccount: {
		create: vi.fn(),
		updateMany: vi.fn(),
		update: vi.fn(),
		findFirst: vi.fn()
	},
	netWorthSnapshot: {
		create: vi.fn(),
		/**
		 * `updateNetWorthAccount` derives the account's CURRENT balance from the newest snapshot
		 * rather than from the form, so a backdated edit adds history instead of rewriting the
		 * present. That read is modelled here as "the snapshots written in this call, newest last",
		 * which is enough for every case in this file — none of them backdates.
		 *
		 * It cannot be modelled further, and the boundary matters: a mock cannot honour
		 * `orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]` against rows it does not store, so the
		 * behaviour that actually depends on the ordering — a backdated balance leaving the headline
		 * alone, and the headline agreeing with the curve — is asserted in
		 * `headlineAgreesWithCurve.db-smoke.ts` against all three real engines. Returning `null` here
		 * instead would be worse than useless: the `?? balanceCents` fallback would then reproduce
		 * exactly the OLD behaviour, and every test in this file would pass against the defect.
		 */
		findFirst: vi.fn()
	},
	account: {
		updateMany: vi.fn(),
		findFirst: vi.fn()
	}
}));

const db = vi.hoisted(() => ({
	prisma: {
		netWorthAccount: {
			findMany: vi.fn(),
			updateMany: vi.fn(),
			findFirst: vi.fn()
		},
		netWorthSnapshot: {
			findMany: vi.fn()
		},
		account: {
			updateMany: vi.fn(),
			findFirst: vi.fn()
		},
		$transaction: vi.fn()
	}
}));

const manualAccount = vi.hoisted(() => ({
	ensureManualAccount: vi.fn(),
	findManualAccount: vi.fn()
}));

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));
vi.mock('$lib/server/budget/dashboard', () => manualAccount);

const {
	createNetWorthAccount,
	deleteNetWorthAccount,
	getManualAccountNetWorthLink,
	linkBankAccountToNetWorth,
	readLinkableNetWorthAccounts,
	readNetWorthAccounts,
	readNetWorthSeries,
	recordSyncedBalance,
	setManualAccountNetWorthLink,
	updateNetWorthAccount
} = await import('./service');

const userId = 'user-1';

type TxMock = typeof tx;

beforeEach(() => {
	vi.clearAllMocks();
	db.prisma.$transaction.mockImplementation(async (cb: (tx: TxMock) => Promise<void>) => cb(tx));
	// No name conflict by default; individual tests override for the duplicate-name case.
	tx.netWorthAccount.findFirst.mockResolvedValue(null);
	// "The newest snapshot" = the last one this call wrote. See the fake's own comment for why
	// returning `null` here would make every test in this file pass against the old defect.
	tx.netWorthSnapshot.findFirst.mockImplementation(async () => {
		const writes = tx.netWorthSnapshot.create.mock.calls;
		if (writes.length === 0) return null;
		return { balanceCents: writes[writes.length - 1][0].data.balanceCents };
	});
});

describe('readNetWorthAccounts', () => {
	it('filtre par userId et exclut les comptes soft-deleted', async () => {
		db.prisma.netWorthAccount.findMany.mockResolvedValue([]);

		await readNetWorthAccounts(userId);

		expect(db.prisma.netWorthAccount.findMany).toHaveBeenCalledWith({
			where: { userId, deletedAt: null },
			orderBy: { createdAt: 'asc' },
			include: { _count: { select: { accounts: true } } }
		});
	});

	it('signale connected: true quand au moins un Account technique est lié', async () => {
		db.prisma.netWorthAccount.findMany.mockResolvedValue([
			{
				id: 'nw-1',
				name: 'Livret A',
				type: 'savings',
				balanceCents: 100_00,
				createdAt: new Date(),
				updatedAt: new Date(),
				_count: { accounts: 2 }
			},
			{
				id: 'nw-2',
				name: 'Maison',
				type: 'real_estate',
				balanceCents: 200_000_00,
				createdAt: new Date(),
				updatedAt: new Date(),
				_count: { accounts: 0 }
			}
		]);

		const result = await readNetWorthAccounts(userId);

		expect(result[0].connected).toBe(true);
		expect(result[1].connected).toBe(false);
	});

	it('resolves connected: false without throwing when _count is entirely absent from the row', async () => {
		db.prisma.netWorthAccount.findMany.mockResolvedValue([
			{
				id: 'nw-3',
				name: 'Compte sans _count',
				type: 'savings',
				balanceCents: 50_00,
				createdAt: new Date(),
				updatedAt: new Date()
				// no _count field at all (defensive edge case, not expected with the real `include`)
			}
		]);

		const result = await readNetWorthAccounts(userId);

		expect(result[0].connected).toBe(false);
	});
});

describe('readNetWorthSeries', () => {
	/**
	 * This test used to assert `netWorthAccount.findMany` was NOT called, on the reasoning that every
	 * snapshot carries its own type so the account list adds nothing. That reasoning was right about
	 * TYPE and wrong about CLOSURE: without the deletion dates, each account's last balance was
	 * carried forward at every later timestamp including the rightmost one, so a closed account kept
	 * contributing to « today » forever and the curve disagreed with the headline above it (measured:
	 * 10 900,00 € against 2 400,00 €). The assertion is inverted deliberately, not relaxed.
	 */
	it('lit tous les snapshots ET les dates de clôture, ordonnés, y compris pour les comptes supprimés', async () => {
		db.prisma.netWorthSnapshot.findMany.mockResolvedValue([]);
		db.prisma.netWorthAccount.findMany.mockResolvedValue([]);

		await readNetWorthSeries(userId);

		expect(db.prisma.netWorthSnapshot.findMany).toHaveBeenCalledWith({
			where: { userId },
			// The order is load-bearing, not cosmetic: `buildNetWorthTimeline` sorts stably, so two
			// snapshots at the same instant keep the order they arrive in and the last one wins.
			orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
			select: { accountId: true, type: true, balanceCents: true, capturedAt: true }
		});
		expect(db.prisma.netWorthAccount.findMany).toHaveBeenCalledWith({
			where: { userId, deletedAt: { not: null } },
			select: { id: true, deletedAt: true }
		});
	});
});

describe('createNetWorthAccount', () => {
	it('crée le compte scopé userId et un premier snapshot avec le même solde et type', async () => {
		tx.netWorthAccount.create.mockResolvedValue({ id: 'acc-00000001' });

		await createNetWorthAccount(userId, {
			name: 'Livret A',
			type: 'savings',
			balance: '1 000,00'
		});

		expect(tx.netWorthAccount.create).toHaveBeenCalledWith({
			data: {
				userId,
				name: 'Livret A',
				nameKey: computeNameKey('Livret A'),
				type: 'savings',
				balanceCents: 100_000
			}
		});
		expect(tx.netWorthSnapshot.create).toHaveBeenCalledWith({
			data: {
				userId,
				accountId: 'acc-00000001',
				type: 'savings',
				balanceCents: 100_000,
				capturedAt: expect.any(Date)
			}
		});
	});

	it('rejette un type inconnu sans toucher la base', async () => {
		await expect(
			createNetWorthAccount(userId, { name: 'X', type: 'crypto', balance: '10' })
		).rejects.toThrow();
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejette un solde invalide sans toucher la base', async () => {
		await expect(
			createNetWorthAccount(userId, { name: 'X', type: 'checking', balance: 'abc' })
		).rejects.toThrow();
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejette un nom déjà utilisé par un compte actif', async () => {
		tx.netWorthAccount.findFirst.mockResolvedValue({ id: 'acc-existing' });

		await expect(
			createNetWorthAccount(userId, { name: 'Livret A', type: 'savings', balance: '10' })
		).rejects.toThrow();
		expect(tx.netWorthAccount.create).not.toHaveBeenCalled();
	});

	it('accepte une date de valeur passée (backdating) via asOfDate', async () => {
		tx.netWorthAccount.create.mockResolvedValue({ id: 'acc-00000001' });

		await createNetWorthAccount(userId, {
			name: 'Livret A',
			type: 'savings',
			balance: '100',
			asOfDate: '2026-01-15'
		});

		expect(tx.netWorthSnapshot.create).toHaveBeenCalledWith({
			data: {
				userId,
				accountId: 'acc-00000001',
				type: 'savings',
				balanceCents: 10_000,
				capturedAt: new Date('2026-01-15T12:00:00.000Z')
			}
		});
	});

	it('rejette une asOfDate dans le futur', async () => {
		const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

		await expect(
			createNetWorthAccount(userId, {
				name: 'X',
				type: 'checking',
				balance: '10',
				asOfDate: future
			})
		).rejects.toThrow();
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejette une asOfDate malformée', async () => {
		await expect(
			createNetWorthAccount(userId, {
				name: 'X',
				type: 'checking',
				balance: '10',
				asOfDate: '15/01/2026'
			})
		).rejects.toThrow();
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});
});

describe('updateNetWorthAccount', () => {
	it("404 si le compte n'appartient pas à l'utilisateur ou est supprimé", async () => {
		tx.netWorthAccount.findFirst.mockResolvedValue(null);

		await expect(
			updateNetWorthAccount(userId, 'acc-00000001', { name: 'X', type: 'checking', balance: '10' })
		).rejects.toThrow();

		expect(tx.netWorthAccount.findFirst).toHaveBeenCalledWith({
			where: { id: 'acc-00000001', userId, deletedAt: null }
		});
		expect(tx.netWorthAccount.updateMany).not.toHaveBeenCalled();
	});

	it('scope la mise à jour par id ET userId, et crée un nouveau snapshot si le solde change', async () => {
		tx.netWorthAccount.findFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				'nameKey' in where
					? null
					: { id: 'acc-00000001', userId, type: 'savings', balanceCents: 50_000 }
		);

		await updateNetWorthAccount(userId, 'acc-00000001', {
			name: 'Livret A',
			type: 'savings',
			balance: '700'
		});

		// Two writes, and the split is the fix: `name` and `type` are what the account IS and are
		// written from the form, while `balanceCents` is a VERDICT ON THE PRESENT and is derived from
		// the newest snapshot. Written from the form, a backdated edit pushed a past balance into
		// "now" and the headline disagreed with the curve below it.
		expect(tx.netWorthAccount.updateMany).toHaveBeenCalledWith({
			where: { id: 'acc-00000001', userId },
			data: {
				name: 'Livret A',
				nameKey: computeNameKey('Livret A'),
				type: 'savings'
			}
		});
		expect(tx.netWorthAccount.updateMany).toHaveBeenCalledWith({
			where: { id: 'acc-00000001', userId },
			data: { balanceCents: 70_000 }
		});
		expect(tx.netWorthSnapshot.create).toHaveBeenCalledWith({
			data: {
				userId,
				accountId: 'acc-00000001',
				type: 'savings',
				balanceCents: 70_000,
				capturedAt: expect.any(Date)
			}
		});
	});

	it('ne crée pas de nouveau snapshot si ni le solde ni le type ne changent (renommage seul)', async () => {
		tx.netWorthAccount.findFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				'nameKey' in where
					? null
					: { id: 'acc-00000001', userId, type: 'savings', balanceCents: 50_000 }
		);

		await updateNetWorthAccount(userId, 'acc-00000001', {
			name: 'Nouveau nom',
			type: 'savings',
			balance: '500'
		});

		expect(tx.netWorthSnapshot.create).not.toHaveBeenCalled();
	});

	it('crée un nouveau snapshot si seul le type change (bug #1 : le signe doit changer explicitement)', async () => {
		tx.netWorthAccount.findFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				'nameKey' in where
					? null
					: { id: 'acc-00000001', userId, type: 'savings', balanceCents: 50_000 }
		);

		await updateNetWorthAccount(userId, 'acc-00000001', {
			name: 'Livret A',
			type: 'debt',
			balance: '500'
		});

		expect(tx.netWorthSnapshot.create).toHaveBeenCalledWith({
			data: {
				userId,
				accountId: 'acc-00000001',
				type: 'debt',
				balanceCents: 50_000,
				capturedAt: expect.any(Date)
			}
		});
	});

	it('rejette le renommage vers un nom déjà utilisé par un autre compte actif', async () => {
		tx.netWorthAccount.findFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) => {
				if ('name' in where) return { id: 'acc-other' };
				return { id: 'acc-00000001', userId, type: 'savings', balanceCents: 50_000 };
			}
		);

		await expect(
			updateNetWorthAccount(userId, 'acc-00000001', {
				name: 'Compte courant',
				type: 'savings',
				balance: '500'
			})
		).rejects.toThrow();
		expect(tx.netWorthAccount.updateMany).not.toHaveBeenCalled();
	});

	it('délie tous les Account (manuel ET buckets CSV) quand le type devient non-liable (checking -> real_estate)', async () => {
		tx.netWorthAccount.findFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				'nameKey' in where
					? null
					: { id: 'acc-00000001', userId, type: 'checking', balanceCents: 50_000 }
		);
		tx.account.updateMany.mockResolvedValue({ count: 2 });

		await updateNetWorthAccount(userId, 'acc-00000001', {
			name: 'Compte courant',
			type: 'real_estate',
			balance: '500'
		});

		expect(tx.account.updateMany).toHaveBeenCalledWith({
			where: { userId, netWorthAccountId: 'acc-00000001' },
			data: { netWorthAccountId: null }
		});
	});

	it('ne touche à aucun Account quand le type reste liable (savings -> debt)', async () => {
		tx.netWorthAccount.findFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				'nameKey' in where
					? null
					: { id: 'acc-00000001', userId, type: 'savings', balanceCents: 50_000 }
		);

		await updateNetWorthAccount(userId, 'acc-00000001', {
			name: 'Livret A',
			type: 'debt',
			balance: '500'
		});

		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});

	it(
		'délie quand même les Account quand le type change ENTRE deux types non-liables ' +
			"(real_estate -> other) : comportement documenté (no-op en pratique puisqu'aucun " +
			"Account n'a jamais pu être lié à un type non-liable, mais la condition du code " +
			'ne distingue pas ce cas — `type !== existing.type && !isLinkableNetWorthAccountType(type)`)',
		async () => {
			tx.netWorthAccount.findFirst.mockImplementation(
				async ({ where }: { where: Record<string, unknown> }) =>
					'nameKey' in where
						? null
						: { id: 'acc-00000001', userId, type: 'real_estate', balanceCents: 50_000 }
			);
			tx.account.updateMany.mockResolvedValue({ count: 0 });

			await updateNetWorthAccount(userId, 'acc-00000001', {
				name: 'Bien divers',
				type: 'other',
				balance: '500'
			});

			expect(tx.account.updateMany).toHaveBeenCalledWith({
				where: { userId, netWorthAccountId: 'acc-00000001' },
				data: { netWorthAccountId: null }
			});
		}
	);

	it('ne touche à aucun Account quand le type non-liable ne change pas (real_estate -> real_estate)', async () => {
		tx.netWorthAccount.findFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				'nameKey' in where
					? null
					: { id: 'acc-00000001', userId, type: 'real_estate', balanceCents: 50_000 }
		);

		await updateNetWorthAccount(userId, 'acc-00000001', {
			name: 'Maison',
			type: 'real_estate',
			balance: '600'
		});

		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});
});

describe('getManualAccountNetWorthLink', () => {
	it('renvoie le netWorthAccountId du compte manuel quand il est lié', async () => {
		manualAccount.findManualAccount.mockResolvedValue({
			id: 'account-manual',
			netWorthAccountId: 'acc-00000001'
		});

		const result = await getManualAccountNetWorthLink(userId);

		expect(result).toBe('acc-00000001');
		expect(manualAccount.findManualAccount).toHaveBeenCalledWith(userId);
	});

	it("renvoie null si le compte manuel n'a jamais été créé", async () => {
		manualAccount.findManualAccount.mockResolvedValue(null);

		const result = await getManualAccountNetWorthLink(userId);

		expect(result).toBeNull();
	});

	it("renvoie null si le compte manuel existe mais n'est lié à rien", async () => {
		manualAccount.findManualAccount.mockResolvedValue({
			id: 'account-manual',
			netWorthAccountId: null
		});

		const result = await getManualAccountNetWorthLink(userId);

		expect(result).toBeNull();
	});
});

describe('setManualAccountNetWorthLink', () => {
	it('crée le compte manuel si besoin (ensureManualAccount) puis le lie, scopé par id ET userId', async () => {
		db.prisma.netWorthAccount.findFirst.mockResolvedValue({ id: 'acc-00000001' });
		manualAccount.ensureManualAccount.mockResolvedValue({ id: 'account-manual' });
		db.prisma.account.updateMany.mockResolvedValue({ count: 1 });

		await setManualAccountNetWorthLink(userId, 'acc-00000001');

		expect(db.prisma.netWorthAccount.findFirst).toHaveBeenCalledWith({
			where: { id: 'acc-00000001', userId, deletedAt: null },
			select: { id: true }
		});
		expect(manualAccount.ensureManualAccount).toHaveBeenCalledWith(userId);
		expect(db.prisma.account.updateMany).toHaveBeenCalledWith({
			where: { id: 'account-manual', userId },
			data: { netWorthAccountId: 'acc-00000001' }
		});
	});

	it('délie le compte manuel quand netWorthAccountId vaut null, sans revalider aucune cible', async () => {
		manualAccount.ensureManualAccount.mockResolvedValue({ id: 'account-manual' });
		db.prisma.account.updateMany.mockResolvedValue({ count: 1 });

		await setManualAccountNetWorthLink(userId, null);

		expect(db.prisma.netWorthAccount.findFirst).not.toHaveBeenCalled();
		expect(db.prisma.account.updateMany).toHaveBeenCalledWith({
			where: { id: 'account-manual', userId },
			data: { netWorthAccountId: null }
		});
	});

	it("404 si l'id ciblé n'appartient pas à l'utilisateur ou est soft-deleted (défense en profondeur, F5)", async () => {
		db.prisma.netWorthAccount.findFirst.mockResolvedValue(null);

		await expect(setManualAccountNetWorthLink(userId, 'acc-other-user')).rejects.toThrow();
		expect(manualAccount.ensureManualAccount).not.toHaveBeenCalled();
		expect(db.prisma.account.updateMany).not.toHaveBeenCalled();
	});
});

describe('deleteNetWorthAccount', () => {
	it('soft-delete scopé par id ET userId (deletedAt renseigné, aucune ligne physiquement supprimée)', async () => {
		tx.netWorthAccount.updateMany.mockResolvedValue({ count: 1 });

		await deleteNetWorthAccount(userId, 'acc-00000001');

		expect(tx.netWorthAccount.updateMany).toHaveBeenCalledWith({
			where: { id: 'acc-00000001', userId, deletedAt: null },
			data: { deletedAt: expect.any(Date) }
		});
	});

	it("404 si aucune ligne mise à jour (compte d'un autre utilisateur ou déjà supprimé), sans délier quoi que ce soit", async () => {
		tx.netWorthAccount.updateMany.mockResolvedValue({ count: 0 });

		await expect(deleteNetWorthAccount(userId, 'acc-00000001')).rejects.toThrow();
		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});

	it('délie tous les Account technique pointant vers ce compte (manuel ET buckets CSV), pas seulement le lien manuel', async () => {
		tx.netWorthAccount.updateMany.mockResolvedValue({ count: 1 });
		tx.account.updateMany.mockResolvedValue({ count: 2 });

		await deleteNetWorthAccount(userId, 'acc-00000001');

		expect(tx.account.updateMany).toHaveBeenCalledWith({
			where: { userId, netWorthAccountId: 'acc-00000001' },
			data: { netWorthAccountId: null }
		});
	});

	it('cycle lié → soft-delete → recréation même nom : le nouveau compte démarre sans aucun lien hérité', async () => {
		// The soft-deleted account's Account rows are unlinked as part of the delete itself
		// (see test above); a later createNetWorthAccount with the same name gets a brand new
		// id and never touches Account rows at all, so nothing can inherit a stale connection.
		tx.netWorthAccount.updateMany.mockResolvedValue({ count: 1 });
		tx.account.updateMany.mockResolvedValue({ count: 1 });
		await deleteNetWorthAccount(userId, 'acc-00000001');
		expect(tx.account.updateMany).toHaveBeenCalledWith({
			where: { userId, netWorthAccountId: 'acc-00000001' },
			data: { netWorthAccountId: null }
		});

		tx.account.updateMany.mockClear();
		tx.netWorthAccount.create.mockResolvedValue({ id: 'acc-00000002' });
		await createNetWorthAccount(userId, { name: 'Livret A', type: 'savings', balance: '100' });

		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});
});

describe('linkBankAccountToNetWorth', () => {
	const bucketId = 'bucket-00000001';
	const targetId = 'nw-00000001';

	it('404 si le bucket ne résout à aucun Account possédé par cet utilisateur, sans toucher la base', async () => {
		tx.account.findFirst.mockResolvedValue(null);

		await expect(linkBankAccountToNetWorth(userId, bucketId, targetId)).rejects.toThrow();

		expect(tx.account.findFirst).toHaveBeenCalledWith({
			where: { id: bucketId, userId, bankConnectionId: { not: null } },
			select: { id: true }
		});
		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});

	it('404 si le bucket existe mais est un bucket CSV/manuel (bankConnectionId null)', async () => {
		// The where clause itself filters on bankConnectionId: { not: null }, so a CSV/manual
		// bucket never matches — Prisma returns null exactly like a nonexistent bucket.
		tx.account.findFirst.mockResolvedValue(null);

		await expect(linkBankAccountToNetWorth(userId, bucketId, targetId)).rejects.toThrow();
		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});

	it("404 si la cible n'existe pas, appartient à un autre utilisateur, ou est soft-deleted", async () => {
		tx.account.findFirst.mockResolvedValue({ id: bucketId });
		tx.netWorthAccount.findFirst.mockResolvedValue(null);

		await expect(linkBankAccountToNetWorth(userId, bucketId, targetId)).rejects.toThrow();

		expect(tx.netWorthAccount.findFirst).toHaveBeenCalledWith({
			where: { id: targetId, userId, deletedAt: null },
			select: { id: true, type: true }
		});
		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});

	it("404 si la cible est d'un type non liable (real_estate/other)", async () => {
		tx.account.findFirst.mockResolvedValue({ id: bucketId });
		tx.netWorthAccount.findFirst.mockResolvedValue({ id: targetId, type: 'real_estate' });

		await expect(linkBankAccountToNetWorth(userId, bucketId, targetId)).rejects.toThrow();
		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});

	it('409 (already synced) si un autre bucket synchronisé est déjà lié à cette cible', async () => {
		tx.account.findFirst.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) => {
				if ('bankConnectionId' in where && where.id === bucketId) return { id: bucketId };
				return { id: 'other-synced-bucket' };
			}
		);
		tx.netWorthAccount.findFirst.mockResolvedValue({ id: targetId, type: 'checking' });

		await expect(linkBankAccountToNetWorth(userId, bucketId, targetId)).rejects.toThrow();

		expect(tx.account.findFirst).toHaveBeenCalledWith({
			where: {
				userId,
				netWorthAccountId: targetId,
				bankConnectionId: { not: null },
				id: { not: bucketId }
			},
			select: { id: true }
		});
		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});

	it('ne considère pas un conflit le fait de relier le MÊME bucket à la cible où il est déjà lié', async () => {
		// The conflict lookup explicitly excludes `id: { not: bucketId }` — re-linking the same
		// bucket to its current target must succeed, not trip the D4 conflict check.
		tx.account.findFirst.mockResolvedValueOnce({ id: bucketId }).mockResolvedValueOnce(null);
		tx.netWorthAccount.findFirst.mockResolvedValue({ id: targetId, type: 'checking' });
		tx.account.updateMany.mockResolvedValue({ count: 1 });

		await linkBankAccountToNetWorth(userId, bucketId, targetId);

		expect(tx.account.updateMany).toHaveBeenCalledWith({
			where: { id: bucketId, userId },
			data: { netWorthAccountId: targetId }
		});
	});

	it("n'est pas gêné par un bucket CSV/manuel (bankConnectionId null) déjà lié à la même cible (seuls les buckets synchronisés comptent)", async () => {
		// The conflict query itself filters bankConnectionId: { not: null }, so a manual/CSV
		// bucket already pointing at the target never surfaces here regardless of mock shape —
		// simulate Prisma's own filtering by returning null.
		tx.account.findFirst.mockResolvedValueOnce({ id: bucketId }).mockResolvedValueOnce(null);
		tx.netWorthAccount.findFirst.mockResolvedValue({ id: targetId, type: 'checking' });
		tx.account.updateMany.mockResolvedValue({ count: 1 });

		await linkBankAccountToNetWorth(userId, bucketId, targetId);

		expect(tx.account.updateMany).toHaveBeenCalledWith({
			where: { id: bucketId, userId },
			data: { netWorthAccountId: targetId }
		});
	});

	it('lie le bucket synchronisé à une cible valide sans conflit, scopé par id ET userId', async () => {
		tx.account.findFirst.mockResolvedValueOnce({ id: bucketId }).mockResolvedValueOnce(null);
		tx.netWorthAccount.findFirst.mockResolvedValue({ id: targetId, type: 'savings' });
		tx.account.updateMany.mockResolvedValue({ count: 1 });

		await linkBankAccountToNetWorth(userId, bucketId, targetId);

		expect(tx.account.updateMany).toHaveBeenCalledWith({
			where: { id: bucketId, userId },
			data: { netWorthAccountId: targetId }
		});
	});

	it('délie (netWorthAccountId: null) un bucket synchronisé possédé, sans valider aucune cible', async () => {
		tx.account.findFirst.mockResolvedValue({ id: bucketId });
		tx.account.updateMany.mockResolvedValue({ count: 1 });

		await linkBankAccountToNetWorth(userId, bucketId, null);

		expect(tx.netWorthAccount.findFirst).not.toHaveBeenCalled();
		expect(tx.account.updateMany).toHaveBeenCalledWith({
			where: { id: bucketId, userId },
			data: { netWorthAccountId: null }
		});
	});

	it('404 si accountId est vide/invalide (normalizeId), sans toucher la base', async () => {
		await expect(linkBankAccountToNetWorth(userId, '   ', targetId)).rejects.toThrow();
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
		expect(tx.account.findFirst).not.toHaveBeenCalled();
		expect(tx.account.updateMany).not.toHaveBeenCalled();
	});
});

describe('recordSyncedBalance', () => {
	const netWorthAccountId = 'nw-00000001';
	const capturedAt = new Date('2026-07-20T10:00:00.000Z');

	it('writes both the account balance and a new snapshot when the balance differs', async () => {
		tx.netWorthAccount.findFirst.mockResolvedValue({
			id: netWorthAccountId,
			type: 'checking',
			balanceCents: 100_00
		});

		await recordSyncedBalance(userId, netWorthAccountId, 250_00, capturedAt);

		expect(tx.netWorthSnapshot.create).toHaveBeenCalledWith({
			data: {
				userId,
				accountId: netWorthAccountId,
				type: 'checking',
				balanceCents: 250_00,
				capturedAt
			}
		});
		// The account's balance is DERIVED from the newest snapshot rather than written from the
		// connector's figure, through the same helper the manual edit uses. Writing it directly is
		// what let a sync landing behind a same-day manual balance put a superseded figure in the
		// headline while the curve kept the user's, which is the disagreement this release closes.
		// Scoped by userId as well as by id, which the direct `update` was not.
		expect(tx.netWorthAccount.updateMany).toHaveBeenCalledWith({
			where: { id: netWorthAccountId, userId },
			data: { balanceCents: 250_00 }
		});
	});

	it('is a no-op (no account update, no snapshot) when the balance is unchanged', async () => {
		tx.netWorthAccount.findFirst.mockResolvedValue({
			id: netWorthAccountId,
			type: 'checking',
			balanceCents: 250_00
		});

		await recordSyncedBalance(userId, netWorthAccountId, 250_00, capturedAt);

		expect(tx.netWorthAccount.updateMany).not.toHaveBeenCalled();
		expect(tx.netWorthSnapshot.create).not.toHaveBeenCalled();
	});

	it('two consecutive calls with the same balanceCents only ever produce one snapshot row', async () => {
		tx.netWorthAccount.findFirst.mockResolvedValueOnce({
			id: netWorthAccountId,
			type: 'checking',
			balanceCents: 100_00
		});
		await recordSyncedBalance(userId, netWorthAccountId, 250_00, capturedAt);
		expect(tx.netWorthSnapshot.create).toHaveBeenCalledTimes(1);

		// Second call: the stored balance is now 250_00 (simulated by the mock resolving the
		// already-updated value), so it must be a no-op.
		tx.netWorthAccount.findFirst.mockResolvedValueOnce({
			id: netWorthAccountId,
			type: 'checking',
			balanceCents: 250_00
		});
		await recordSyncedBalance(userId, netWorthAccountId, 250_00, capturedAt);

		expect(tx.netWorthSnapshot.create).toHaveBeenCalledTimes(1);
		expect(tx.netWorthAccount.updateMany).toHaveBeenCalledTimes(1);
	});

	it('is a silent no-op when the netWorthAccountId does not belong to userId', async () => {
		tx.netWorthAccount.findFirst.mockResolvedValue(null);

		await expect(
			recordSyncedBalance('other-user', netWorthAccountId, 250_00, capturedAt)
		).resolves.toBeUndefined();

		expect(tx.netWorthAccount.findFirst).toHaveBeenCalledWith({
			where: { id: netWorthAccountId, userId: 'other-user', deletedAt: null },
			select: { id: true, type: true, balanceCents: true }
		});
		expect(tx.netWorthAccount.updateMany).not.toHaveBeenCalled();
		expect(tx.netWorthSnapshot.create).not.toHaveBeenCalled();
	});

	it('is a silent no-op for a soft-deleted account (excluded by the deletedAt: null filter)', async () => {
		// The where clause itself filters deletedAt: null, so Prisma returns null exactly like
		// a nonexistent account — simulate that filtering behavior.
		tx.netWorthAccount.findFirst.mockResolvedValue(null);

		await expect(
			recordSyncedBalance(userId, netWorthAccountId, 250_00, capturedAt)
		).resolves.toBeUndefined();

		expect(tx.netWorthAccount.updateMany).not.toHaveBeenCalled();
		expect(tx.netWorthSnapshot.create).not.toHaveBeenCalled();
	});

	it("uses the account's CURRENT type for the snapshot, not something passed in", async () => {
		tx.netWorthAccount.findFirst.mockResolvedValue({
			id: netWorthAccountId,
			type: 'savings',
			balanceCents: 0
		});

		await recordSyncedBalance(userId, netWorthAccountId, 500_00, capturedAt);

		expect(tx.netWorthSnapshot.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ type: 'savings' }) })
		);
	});
});

describe('readLinkableNetWorthAccounts', () => {
	it('returns only active, linkable-type accounts as {id, name}, scoped to the given userId', async () => {
		db.prisma.netWorthAccount.findMany.mockResolvedValue([
			{
				id: 'nw-1',
				name: 'Compte courant',
				type: 'checking',
				balanceCents: 100_00,
				createdAt: new Date(),
				updatedAt: new Date(),
				_count: { accounts: 1 }
			},
			{
				id: 'nw-2',
				name: 'Livret',
				type: 'savings',
				balanceCents: 200_00,
				createdAt: new Date(),
				updatedAt: new Date(),
				_count: { accounts: 0 }
			},
			{
				id: 'nw-3',
				name: 'PEA',
				type: 'investment',
				balanceCents: 300_00,
				createdAt: new Date(),
				updatedAt: new Date(),
				_count: { accounts: 0 }
			},
			{
				id: 'nw-4',
				name: 'Crédit auto',
				type: 'debt',
				balanceCents: -50_00,
				createdAt: new Date(),
				updatedAt: new Date(),
				_count: { accounts: 0 }
			},
			{
				id: 'nw-5',
				name: 'Maison',
				type: 'real_estate',
				balanceCents: 200_000_00,
				createdAt: new Date(),
				updatedAt: new Date(),
				_count: { accounts: 0 }
			},
			{
				id: 'nw-6',
				name: 'Autre',
				type: 'other',
				balanceCents: 1_00,
				createdAt: new Date(),
				updatedAt: new Date(),
				_count: { accounts: 0 }
			}
		]);

		const result = await readLinkableNetWorthAccounts(userId);

		expect(db.prisma.netWorthAccount.findMany).toHaveBeenCalledWith({
			where: { userId, deletedAt: null },
			orderBy: { createdAt: 'asc' },
			include: { _count: { select: { accounts: true } } }
		});
		expect(result).toEqual([
			{ id: 'nw-1', name: 'Compte courant' },
			{ id: 'nw-2', name: 'Livret' },
			{ id: 'nw-3', name: 'PEA' },
			{ id: 'nw-4', name: 'Crédit auto' }
		]);
	});

	it('returns an empty array when there is nothing to link', async () => {
		db.prisma.netWorthAccount.findMany.mockResolvedValue([]);

		expect(await readLinkableNetWorthAccounts(userId)).toEqual([]);
	});
});
