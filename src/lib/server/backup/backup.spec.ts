import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fake in-memory Prisma covering the 8 `userId`-scoped tables of the backup,
 * faithful enough to exercise buildBackupExport() and restoreBackup() end to end
 * (create/createMany/findMany/deleteMany/upsert + sequential $transaction).
 */
const db = vi.hoisted(() => {
	type Row = Record<string, unknown> & { id: string; userId: string };

	const store = {
		users: [] as Array<{ id: string; email: string }>,
		accounts: [] as Row[],
		categories: [] as Row[],
		importBatches: [] as Row[],
		transactions: [] as Row[],
		monthlyBudgets: [] as Row[],
		categoryRules: [] as Row[],
		categorizationRules: [] as Row[],
		categoryNatureMappings: [] as Row[],
		netWorthAccounts: [] as Row[],
		netWorthSnapshots: [] as Row[],
		savingsGoals: [] as Row[],
		bankConnections: [] as Row[]
	};

	let counter = 0;
	function genId(prefix: string) {
		counter += 1;
		return `${prefix}-${counter}`;
	}

	function pick<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
		if (!select) return { ...row };
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(select)) {
			if (select[key]) out[key] = row[key];
		}
		return out;
	}

	function table(rows: Row[], prefix: string) {
		return {
			findMany: vi.fn(
				async ({
					where,
					select
				}: {
					where: { userId: string };
					select?: Record<string, boolean>;
				}) => rows.filter((row) => row.userId === where.userId).map((row) => pick(row, select))
			),
			create: vi.fn(
				async ({
					data,
					select
				}: {
					data: Record<string, unknown>;
					select?: Record<string, boolean>;
				}) => {
					const row = { id: genId(prefix), ...data } as Row;
					rows.push(row);
					return pick(row, select);
				}
			),
			createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
				const created = data.map((entry) => ({ id: genId(prefix), ...entry }) as Row);
				rows.push(...created);
				return { count: created.length };
			}),
			deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
				const before = rows.length;
				const remaining = rows.filter((row) => row.userId !== where.userId);
				rows.length = 0;
				rows.push(...remaining);
				return { count: before - rows.length };
			})
		};
	}

	const categoryTable = table(store.categories, 'category');
	const categoryUpsert = vi.fn(
		async ({
			where,
			update,
			create
		}: {
			where: { userId_nameKey: { userId: string; nameKey: string } };
			update: Record<string, unknown>;
			create: Record<string, unknown>;
		}) => {
			// Keyed on the folded name, matching the unique constraint the real table carries:
			// a file whose own "Non catégorisé" row differs only in case already holds this key.
			// Compared against the stored column, like the real index, rather than recomputing
			// it here (this fake is hoisted above the imports and has no app code available).
			const found = store.categories.find(
				(row) =>
					row.userId === where.userId_nameKey.userId && row.nameKey === where.userId_nameKey.nameKey
			);
			if (found) {
				Object.assign(found, update);
				return { ...found };
			}
			const row = { id: genId('category'), ...create } as Row;
			store.categories.push(row);
			return { ...row };
		}
	);

	return {
		store,
		reset() {
			store.users.length = 0;
			store.accounts.length = 0;
			store.categories.length = 0;
			store.importBatches.length = 0;
			store.transactions.length = 0;
			store.monthlyBudgets.length = 0;
			store.categoryRules.length = 0;
			store.categorizationRules.length = 0;
			store.categoryNatureMappings.length = 0;
			store.netWorthAccounts.length = 0;
			store.netWorthSnapshots.length = 0;
			store.savingsGoals.length = 0;
			store.bankConnections.length = 0;
			counter = 0;
		},
		prisma: {
			user: {
				findUniqueOrThrow: vi.fn(
					async ({
						where,
						select
					}: {
						where: { id: string };
						select?: Record<string, boolean>;
					}) => {
						const found = store.users.find((u) => u.id === where.id);
						if (!found) throw new Error('user not found');
						return pick(found, select);
					}
				)
			},
			account: table(store.accounts, 'account'),
			category: { ...categoryTable, upsert: categoryUpsert },
			importBatch: table(store.importBatches, 'batch'),
			transaction: table(store.transactions, 'transaction'),
			monthlyBudget: table(store.monthlyBudgets, 'budget'),
			categoryRule: table(store.categoryRules, 'category-rule'),
			categorizationRule: table(store.categorizationRules, 'categorization-rule'),
			categoryNatureMapping: table(store.categoryNatureMappings, 'nature-mapping'),
			netWorthAccount: table(store.netWorthAccounts, 'net-worth-account'),
			netWorthSnapshot: table(store.netWorthSnapshots, 'net-worth-snapshot'),
			savingsGoal: table(store.savingsGoals, 'savings-goal'),
			bankConnection: table(store.bankConnections, 'bank-connection'),
			// Second parameter mirrors the real client's interactive-transaction options, so
			// specs can assert what the caller asked for (see LONG_TRANSACTION_OPTIONS).
			$transaction: vi.fn(
				async (
					callback: (tx: unknown) => Promise<unknown>,
					_options?: { maxWait: number; timeout: number }
				) => callback(db.prisma)
			)
		}
	};
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { buildBackupExport } = await import('./export');
const { restoreBackup, BackupImportError } = await import('./import');
const { UNCLASSIFIED_CATEGORY } = await import('$lib/domain/categories');
const { LONG_TRANSACTION_OPTIONS } = await import('$lib/server/dbTransaction');

describe('buildBackupExport', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
	});

	it('strictly scopes exported data by userId, with no leak between users', async () => {
		expect.assertions(7);

		db.store.users.push(
			{ id: 'user-a', email: 'a@example.test' },
			{ id: 'user-b', email: 'b@example.test' }
		);
		db.store.accounts.push(
			{ id: 'acc-a', userId: 'user-a', name: 'Compte A', currency: 'EUR', source: 'manual' },
			{ id: 'acc-b', userId: 'user-b', name: 'Compte B', currency: 'EUR', source: 'manual' }
		);
		db.store.categories.push(
			{ id: 'cat-a', userId: 'user-a', name: 'Courses A' },
			{ id: 'cat-b', userId: 'user-b', name: 'Courses B' }
		);
		db.store.transactions.push(
			{
				id: 'tx-a',
				userId: 'user-a',
				accountId: 'acc-a',
				categoryId: 'cat-a',
				importBatchId: null,
				date: new Date('2026-06-01T00:00:00.000Z'),
				label: 'Achat A',
				amountCents: 1_000,
				type: 'expense',
				source: 'manual',
				notes: null,
				bankOperationType: null,
				manualCategory: null,
				natureManual: null,
				dedupeKey: null,
				metadataJson: null
			},
			{
				id: 'tx-b',
				userId: 'user-b',
				accountId: 'acc-b',
				categoryId: 'cat-b',
				importBatchId: null,
				date: new Date('2026-06-01T00:00:00.000Z'),
				label: 'Achat B secret',
				amountCents: 2_000,
				type: 'expense',
				source: 'manual',
				notes: null,
				bankOperationType: null,
				manualCategory: null,
				natureManual: null,
				dedupeKey: null,
				metadataJson: null
			}
		);

		const result = await buildBackupExport('user-a');

		expect(result.userEmail).toBe('a@example.test');
		expect(result.accounts).toEqual([
			{ id: 'acc-a', name: 'Compte A', currency: 'EUR', source: 'manual' }
		]);
		expect(result.categories).toEqual([{ id: 'cat-a', name: 'Courses A' }]);
		expect(result.transactions).toHaveLength(1);
		expect(result.transactions[0].label).toBe('Achat A');
		expect(JSON.stringify(result)).not.toContain('user-b');
		expect(JSON.stringify(result)).not.toContain('Achat B secret');
	});

	it('scope les comptes et snapshots de patrimoine par userId, sans fuite entre utilisateurs', async () => {
		expect.assertions(3);

		db.store.users.push(
			{ id: 'user-a', email: 'a@example.test' },
			{ id: 'user-b', email: 'b@example.test' }
		);
		db.store.netWorthAccounts.push(
			{
				id: 'nw-a',
				userId: 'user-a',
				name: 'Livret A',
				type: 'savings',
				balanceCents: 100_00,
				deletedAt: null
			},
			{
				id: 'nw-b',
				userId: 'user-b',
				name: 'Secret B',
				type: 'savings',
				balanceCents: 999_00,
				deletedAt: null
			}
		);
		db.store.netWorthSnapshots.push(
			{
				id: 'snap-a',
				userId: 'user-a',
				accountId: 'nw-a',
				type: 'savings',
				balanceCents: 100_00,
				capturedAt: new Date()
			},
			{
				id: 'snap-b',
				userId: 'user-b',
				accountId: 'nw-b',
				type: 'savings',
				balanceCents: 999_00,
				capturedAt: new Date()
			}
		);

		const result = await buildBackupExport('user-a');

		expect(result.netWorthAccounts).toEqual([
			{ id: 'nw-a', name: 'Livret A', type: 'savings', balanceCents: 100_00, deletedAt: null }
		]);
		expect(result.netWorthSnapshots).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain('Secret B');
	});

	it("scope les objectifs d'épargne par userId, sans fuite entre utilisateurs", async () => {
		expect.assertions(3);

		db.store.users.push(
			{ id: 'user-a', email: 'a@example.test' },
			{ id: 'user-b', email: 'b@example.test' }
		);
		db.store.savingsGoals.push(
			{
				id: 'goal-a',
				userId: 'user-a',
				name: 'Vacances',
				targetAmountCents: 100_000,
				netWorthAccountId: null,
				currentAmountCents: 50_000,
				startingBalanceCents: 0,
				targetDate: null,
				reachedAt: null,
				reachedBannerDismissedAt: null
			},
			{
				id: 'goal-b',
				userId: 'user-b',
				name: 'Secret objectif B',
				targetAmountCents: 999_00,
				netWorthAccountId: null,
				currentAmountCents: 0,
				startingBalanceCents: 0,
				targetDate: null,
				reachedAt: null,
				reachedBannerDismissedAt: null
			}
		);

		const result = await buildBackupExport('user-a');

		expect(result.savingsGoals).toHaveLength(1);
		expect(result.savingsGoals[0].name).toBe('Vacances');
		expect(JSON.stringify(result)).not.toContain('Secret objectif B');
	});

	it('inclut Account.netWorthAccountId dans les comptes exportés, sans fuite entre utilisateurs', async () => {
		expect.assertions(3);

		db.store.users.push(
			{ id: 'user-a', email: 'a@example.test' },
			{ id: 'user-b', email: 'b@example.test' }
		);
		db.store.netWorthAccounts.push(
			{
				id: 'nw-a',
				userId: 'user-a',
				name: 'Livret A',
				type: 'savings',
				balanceCents: 100_00,
				deletedAt: null
			},
			{
				id: 'nw-b',
				userId: 'user-b',
				name: 'Secret B',
				type: 'savings',
				balanceCents: 999_00,
				deletedAt: null
			}
		);
		db.store.accounts.push(
			{
				id: 'acc-a',
				userId: 'user-a',
				name: 'Compte A',
				currency: 'EUR',
				source: 'manual',
				netWorthAccountId: 'nw-a'
			},
			{
				id: 'acc-b',
				userId: 'user-b',
				name: 'Compte B',
				currency: 'EUR',
				source: 'manual',
				netWorthAccountId: 'nw-b'
			}
		);

		const result = await buildBackupExport('user-a');

		expect(result.accounts).toEqual([
			{
				id: 'acc-a',
				name: 'Compte A',
				currency: 'EUR',
				source: 'manual',
				netWorthAccountId: 'nw-a'
			}
		]);
		expect(result.accounts[0].netWorthAccountId).not.toBe('nw-b');
		expect(JSON.stringify(result)).not.toContain('nw-b');
	});

	it("ne fait pas fuiter le hash de mot de passe (select limité à l'email)", async () => {
		expect.assertions(1);

		db.store.users.push({ id: 'user-a', email: 'a@example.test' });

		await buildBackupExport('user-a');

		expect(db.prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
			where: { id: 'user-a' },
			select: { email: true }
		});
	});

	it('exporte uniquement des métadonnées non sensibles pour une connexion bancaire (jamais credentialsEncrypted/providerSessionId)', async () => {
		expect.assertions(3);

		db.store.users.push({ id: 'user-a', email: 'a@example.test' });
		db.store.bankConnections.push({
			id: 'bank-a',
			userId: 'user-a',
			provider: 'enablebanking',
			status: 'active',
			consentExpiresAt: new Date('2026-12-01T00:00:00.000Z'),
			lastSyncAt: null,
			credentialsEncrypted: 'iv:tag:super-secret',
			providerSessionId: 'session-super-secret'
		});

		const result = await buildBackupExport('user-a');

		expect(result.bankConnections).toEqual([
			{
				id: 'bank-a',
				provider: 'enablebanking',
				status: 'active',
				consentExpiresAt: '2026-12-01T00:00:00.000Z',
				lastSyncAt: null
			}
		]);
		expect(JSON.stringify(result)).not.toContain('super-secret');
		expect(db.prisma.bankConnection.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				select: {
					id: true,
					provider: true,
					status: true,
					aspspName: true,
					aspspCountry: true,
					consentExpiresAt: true,
					lastSyncAt: true
				}
			})
		);
	});

	it('scope les connexions bancaires exportées par userId, sans fuite entre utilisateurs', async () => {
		expect.assertions(2);

		db.store.users.push(
			{ id: 'user-a', email: 'a@example.test' },
			{ id: 'user-b', email: 'b@example.test' }
		);
		db.store.bankConnections.push(
			{
				id: 'bank-a',
				userId: 'user-a',
				provider: 'enablebanking',
				status: 'active',
				consentExpiresAt: null,
				lastSyncAt: null
			},
			{
				id: 'bank-b',
				userId: 'user-b',
				provider: 'secret-provider-b',
				status: 'active',
				consentExpiresAt: null,
				lastSyncAt: null
			}
		);

		const result = await buildBackupExport('user-a');

		expect(result.bankConnections).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain('secret-provider-b');
	});
});

describe('restoreBackup', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
	});

	function buildValidPayload() {
		return {
			formatVersion: 1 as const,
			exportedAt: new Date().toISOString(),
			userEmail: 'user-a@example.test',
			accounts: [
				{
					id: 'file-acc-1',
					name: 'Compte courant',
					currency: 'EUR',
					source: 'manual',
					netWorthAccountId: null as string | null
				}
			],
			categories: [{ id: 'file-cat-1', name: 'Courses' }],
			importBatches: [
				{
					id: 'file-batch-1',
					source: 'csv',
					fileName: 'releve.csv',
					profile: 'generic',
					rowCount: 1,
					importedRows: 1,
					duplicateRows: 0,
					invalidRows: 0,
					periodStart: null,
					periodEnd: null
				}
			],
			transactions: [
				{
					id: 'file-tx-1',
					accountId: 'file-acc-1',
					categoryId: 'file-cat-1',
					importBatchId: 'file-batch-1' as string | null,
					date: new Date('2026-06-15T00:00:00.000Z').toISOString(),
					label: 'Carrefour',
					amountCents: 4_200,
					type: 'expense' as const,
					source: 'csv',
					notes: null,
					bankOperationType: 'CB',
					manualCategory: null,
					natureManual: null,
					dedupeKey: 'dedupe-1',
					metadataJson: null
				}
			],
			monthlyBudgets: [{ id: 'file-budget-1', categoryName: 'Courses', amountCents: 30_000 }],
			categoryRules: [
				{
					id: 'file-rule-1',
					name: 'Règle courses',
					matchText: 'carrefour',
					targetCategory: 'Courses',
					targetNature: null,
					enabled: true
				}
			],
			categorizationRules: [
				{
					id: 'file-legacy-rule-1',
					pattern: 'carrefour',
					targetCategory: 'Courses',
					type: null,
					active: true
				}
			],
			categoryNatureMappings: [
				{ id: 'file-mapping-1', categoryName: 'Courses', nature: 'spending' as const }
			],
			netWorthAccounts: [
				{
					id: 'file-nw-acc-1',
					name: 'Livret A',
					type: 'savings' as const,
					balanceCents: 150_000,
					deletedAt: null as string | null
				}
			],
			netWorthSnapshots: [
				{
					id: 'file-nw-snap-1',
					accountId: 'file-nw-acc-1',
					type: 'savings' as const,
					balanceCents: 150_000,
					capturedAt: new Date('2026-06-01T00:00:00.000Z').toISOString()
				}
			],
			savingsGoals: [
				{
					id: 'file-goal-1',
					name: 'Vacances',
					targetAmountCents: 200_000,
					netWorthAccountId: 'file-nw-acc-1' as string | null,
					currentAmountCents: 150_000,
					startingBalanceCents: 0,
					targetDate: null as string | null,
					reachedAt: null as string | null,
					reachedBannerDismissedAt: null as string | null
				}
			],
			bankConnections: [] as Array<{
				id: string;
				provider: string;
				status: 'active' | 'expired' | 'revoked' | 'error';
				consentExpiresAt: string | null;
				lastSyncAt: string | null;
			}>
		};
	}

	it('runs the restore with a transaction budget sized for a non-local database', async () => {
		expect.assertions(3);

		await restoreBackup('user-a', buildValidPayload());

		// Prisma's defaults (maxWait 2s, timeout 5s) only ever fitted a local SQLite file:
		// the recreation phase issues one statement per parent row, so the round trips add
		// up as soon as the database is reached over a socket.
		const [, options] = db.prisma.$transaction.mock.calls[0];
		expect(options).toEqual(LONG_TRANSACTION_OPTIONS);

		// Guards the constant itself against a careless edit back under Prisma's defaults.
		expect(LONG_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(5_000);
		expect(LONG_TRANSACTION_OPTIONS.maxWait).toBeGreaterThan(2_000);
	});

	it('restores all tables with FKs remapped to newly generated ids', async () => {
		expect.assertions(9);

		const payload = buildValidPayload();

		await restoreBackup('user-a', payload);

		expect(db.store.accounts).toHaveLength(1);
		expect(db.store.categories.map((c) => c.name)).toEqual(
			expect.arrayContaining(['Courses', UNCLASSIFIED_CATEGORY])
		);
		expect(db.store.importBatches).toHaveLength(1);
		expect(db.store.transactions).toHaveLength(1);

		const [account] = db.store.accounts;
		const courses = db.store.categories.find((c) => c.name === 'Courses')!;
		const [batch] = db.store.importBatches;
		const [transaction] = db.store.transactions;

		// File ids must no longer appear: they've been regenerated.
		expect(account.id).not.toBe('file-acc-1');
		expect(courses.id).not.toBe('file-cat-1');

		// The transaction must point to the NEW ids, not the file's.
		expect(transaction.accountId).toBe(account.id);
		expect(transaction.categoryId).toBe(courses.id);
		expect(transaction.importBatchId).toBe(batch.id);
	});

	it('recreates budgets, rules and nature mappings for the user', async () => {
		expect.assertions(4);

		await restoreBackup('user-a', buildValidPayload());

		expect(db.store.monthlyBudgets).toHaveLength(1);
		expect(db.store.categoryRules).toHaveLength(1);
		expect(db.store.categorizationRules).toHaveLength(1);
		expect(db.store.categoryNatureMappings).toHaveLength(1);
	});

	it("purges and recreates only the restored user's data, without touching other users", async () => {
		expect.assertions(3);

		db.store.accounts.push({
			id: 'other-acc',
			userId: 'user-b',
			name: 'Compte B',
			currency: 'EUR',
			source: 'manual'
		});
		db.store.categories.push({ id: 'other-cat', userId: 'user-b', name: 'Autre' });

		await restoreBackup('user-a', buildValidPayload());

		expect(db.store.accounts.some((a) => a.userId === 'user-b' && a.id === 'other-acc')).toBe(true);
		expect(db.store.categories.some((c) => c.userId === 'user-b' && c.id === 'other-cat')).toBe(
			true
		);
		expect(db.store.accounts.every((a) => a.userId === 'user-a' || a.id === 'other-acc')).toBe(
			true
		);
	});

	it('guarantees the presence of "Non catégorisé" even if absent from the imported file', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		// No "Non catégorisé" category in the file.
		expect(payload.categories.some((c) => c.name === UNCLASSIFIED_CATEGORY)).toBe(false);

		await restoreBackup('user-a', payload);

		const unclassified = db.store.categories.filter(
			(c) => c.userId === 'user-a' && c.name === UNCLASSIFIED_CATEGORY
		);
		expect(unclassified).toHaveLength(1);
	});

	it('does not create a "Non catégorisé" duplicate if already present in the file', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.categories.push({ id: 'file-cat-unclassified', name: UNCLASSIFIED_CATEGORY });

		await restoreBackup('user-a', payload);

		const unclassified = db.store.categories.filter(
			(c) => c.userId === 'user-a' && c.name === UNCLASSIFIED_CATEGORY
		);
		expect(unclassified).toHaveLength(1);
	});

	it('preserves a defaultKey consistent with the canonical name', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.categories = [{ id: 'file-cat-1', name: 'Alimentation', defaultKey: 'food' } as never];
		payload.transactions[0].categoryId = 'file-cat-1';
		payload.monthlyBudgets[0].categoryName = 'Alimentation';

		await restoreBackup('user-a', payload);

		const category = db.store.categories.find(
			(c) => c.userId === 'user-a' && c.name === 'Alimentation'
		);
		expect(category?.defaultKey).toBe('food');
	});

	it('re-derives the defaultKey from the canonical name on a pre-i18n export (defaultKey absent)', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.categories = [{ id: 'file-cat-1', name: 'Alimentation' }];
		payload.transactions[0].categoryId = 'file-cat-1';
		payload.monthlyBudgets[0].categoryName = 'Alimentation';

		await restoreBackup('user-a', payload);

		const category = db.store.categories.find(
			(c) => c.userId === 'user-a' && c.name === 'Alimentation'
		);
		expect(category?.defaultKey).toBe('food');
	});

	it('neutralizes a forged defaultKey inconsistent with the name rather than rejecting the whole import', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		// defaultKey valid in the enum (so it passes Zod) but doesn't match this name:
		// an attempt to hijack the translated "Revenus" label onto a custom category.
		payload.categories = [
			{ id: 'file-cat-1', name: 'Compte piégé', defaultKey: 'income' } as never
		];
		payload.transactions[0].categoryId = 'file-cat-1';
		payload.monthlyBudgets[0].categoryName = 'Compte piégé';

		await restoreBackup('user-a', payload);

		const category = db.store.categories.find(
			(c) => c.userId === 'user-a' && c.name === 'Compte piégé'
		);
		expect(category?.name).toBe('Compte piégé');
		expect(category?.defaultKey).toBeNull();
	});

	it('rejects a transaction referencing an accountId absent from the file, before any write', async () => {
		expect.assertions(3);

		db.store.accounts.push({
			id: 'existing-acc',
			userId: 'user-a',
			name: 'Ancien compte',
			currency: 'EUR',
			source: 'manual'
		});

		const payload = buildValidPayload();
		payload.transactions[0].accountId = 'compte-inconnu-du-fichier';

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);

		expect(db.prisma.$transaction).not.toHaveBeenCalled();
		// The user's old data must not have been purged.
		expect(db.store.accounts.some((a) => a.id === 'existing-acc')).toBe(true);
	});

	it('rejects a transaction referencing a categoryId absent from the file, before any write', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.transactions[0].categoryId = 'categorie-inconnue-du-fichier';

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('rejects a transaction referencing an importBatchId absent from the file, before any write', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.transactions[0].importBatchId = 'batch-inconnu-du-fichier';

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('accepte une transaction sans importBatchId (null)', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.transactions[0].importBatchId = null;

		await restoreBackup('user-a', payload);

		expect(db.store.transactions[0].importBatchId).toBeNull();
	});

	it('restaure les comptes et snapshots de patrimoine avec les FKs remappées', async () => {
		expect.assertions(5);

		await restoreBackup('user-a', buildValidPayload());

		expect(db.store.netWorthAccounts).toHaveLength(1);
		expect(db.store.netWorthSnapshots).toHaveLength(1);

		const [account] = db.store.netWorthAccounts;
		const [snapshot] = db.store.netWorthSnapshots;

		expect(account.id).not.toBe('file-nw-acc-1');
		expect(snapshot.accountId).toBe(account.id);
		expect(snapshot.type).toBe('savings');
	});

	it("restaure un objectif d'épargne avec son netWorthAccountId remappé vers le nouveau NetWorthAccount", async () => {
		expect.assertions(3);

		await restoreBackup('user-a', buildValidPayload());

		expect(db.store.savingsGoals).toHaveLength(1);
		const [goal] = db.store.savingsGoals;
		const [account] = db.store.netWorthAccounts;

		expect(goal.netWorthAccountId).toBe(account.id);
		expect(goal.netWorthAccountId).not.toBe('file-nw-acc-1');
	});

	it("restaure un objectif d'épargne non lié (netWorthAccountId null)", async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.savingsGoals[0].netWorthAccountId = null;

		await restoreBackup('user-a', payload);

		expect(db.store.savingsGoals[0].netWorthAccountId).toBeNull();
	});

	it("rejette un objectif d'épargne référençant un compte de patrimoine inconnu du fichier, avant toute écriture", async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.savingsGoals[0].netWorthAccountId = 'compte-patrimoine-inconnu';

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("ne restaure pas d'objectifs d'épargne si le fichier n'en contient pas (compat rétroactive)", async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.savingsGoals = [];

		await restoreBackup('user-a', payload);

		expect(db.store.savingsGoals).toHaveLength(0);
	});

	it('restaure un compte de patrimoine soft-deleted avec son deletedAt', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.netWorthAccounts[0].deletedAt = new Date('2026-06-10T00:00:00.000Z').toISOString();

		await restoreBackup('user-a', payload);

		expect(db.store.netWorthAccounts[0].deletedAt).toEqual(new Date('2026-06-10T00:00:00.000Z'));
	});

	it('rejette un snapshot de patrimoine référençant un compte inconnu du fichier, avant toute écriture', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.netWorthSnapshots[0].accountId = 'compte-patrimoine-inconnu';

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("ne restaure pas de patrimoine si le fichier n'en contient pas (compat rétroactive)", async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.netWorthAccounts = [];
		payload.netWorthSnapshots = [];
		payload.savingsGoals = [];

		await restoreBackup('user-a', payload);

		expect(db.store.netWorthAccounts).toHaveLength(0);
		expect(db.store.netWorthSnapshots).toHaveLength(0);
	});

	it('restaure le lien Account.netWorthAccountId avec les FKs remappées vers le nouveau NetWorthAccount', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.accounts[0].netWorthAccountId = 'file-nw-acc-1';

		await restoreBackup('user-a', payload);

		const [account] = db.store.accounts;
		const [netWorthAccount] = db.store.netWorthAccounts;

		expect(account.netWorthAccountId).toBe(netWorthAccount.id);
		expect(account.netWorthAccountId).not.toBe('file-nw-acc-1');
	});

	it('restaure le lien Account.netWorthAccountId vers un compte de patrimoine soft-deleted', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.accounts[0].netWorthAccountId = 'file-nw-acc-1';
		payload.netWorthAccounts[0].deletedAt = new Date('2026-06-10T00:00:00.000Z').toISOString();

		await restoreBackup('user-a', payload);

		const [account] = db.store.accounts;
		const [netWorthAccount] = db.store.netWorthAccounts;
		expect(account.netWorthAccountId).toBe(netWorthAccount.id);
	});

	it('reste rétrocompatible avec un ancien fichier de backup sans netWorthAccountId sur les comptes', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		// Simule un fichier pré-lien : le champ est totalement absent de l'objet compte.
		payload.accounts = [
			{ id: 'file-acc-1', name: 'Compte courant', currency: 'EUR', source: 'manual' } as never
		];

		await restoreBackup('user-a', payload);

		const [account] = db.store.accounts;
		expect(account.netWorthAccountId).toBeNull();
	});

	it('restaure Account.netWorthAccountId à null quand le champ est explicitement null dans le fichier', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.accounts[0].netWorthAccountId = null;

		await restoreBackup('user-a', payload);

		const [account] = db.store.accounts;
		expect(account.netWorthAccountId).toBeNull();
	});

	it('relie plusieurs comptes au même NetWorthAccount (relation many-to-one)', async () => {
		expect.assertions(3);

		const payload = buildValidPayload();
		payload.accounts.push({
			id: 'file-acc-2',
			name: 'Compte épargne',
			currency: 'EUR',
			source: 'manual',
			netWorthAccountId: 'file-nw-acc-1'
		});
		payload.accounts[0].netWorthAccountId = 'file-nw-acc-1';

		await restoreBackup('user-a', payload);

		expect(db.store.accounts).toHaveLength(2);
		const [netWorthAccount] = db.store.netWorthAccounts;
		expect(db.store.accounts.every((a) => a.netWorthAccountId === netWorthAccount.id)).toBe(true);
		expect(new Set(db.store.accounts.map((a) => a.id)).size).toBe(2);
	});

	it('rejette un compte référençant un netWorthAccountId inconnu du fichier, avant toute écriture', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.accounts[0].netWorthAccountId = 'compte-patrimoine-inconnu';

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it('restaure une connexion bancaire avec un id régénéré et ses secrets recréés à NULL', async () => {
		expect.assertions(4);

		const payload = buildValidPayload();
		payload.bankConnections = [
			{
				id: 'file-bank-1',
				provider: 'enablebanking',
				status: 'expired',
				consentExpiresAt: null,
				lastSyncAt: new Date('2026-06-01T00:00:00.000Z').toISOString()
			}
		];

		await restoreBackup('user-a', payload);

		expect(db.store.bankConnections).toHaveLength(1);
		const [connection] = db.store.bankConnections;
		expect(connection.id).not.toBe('file-bank-1');
		expect(connection.credentialsEncrypted).toBeUndefined();
		expect(connection.providerSessionId).toBeUndefined();
	});

	it('rétrograde une connexion bancaire "active" en "expired" à la restauration (jamais fonctionnelle avec des secrets importés)', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.bankConnections = [
			{
				id: 'file-bank-1',
				provider: 'enablebanking',
				status: 'active',
				consentExpiresAt: null,
				lastSyncAt: null
			}
		];

		await restoreBackup('user-a', payload);

		expect(db.store.bankConnections[0].status).toBe('expired');
	});

	it('conserve un statut non-actif (revoked/error) tel quel à la restauration', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.bankConnections = [
			{
				id: 'file-bank-revoked',
				provider: 'enablebanking',
				status: 'revoked',
				consentExpiresAt: null,
				lastSyncAt: null
			},
			{
				id: 'file-bank-error',
				provider: 'enablebanking',
				status: 'error',
				consentExpiresAt: null,
				lastSyncAt: null
			}
		];

		await restoreBackup('user-a', payload);

		const statuses = db.store.bankConnections.map((c) => c.status).sort();
		expect(statuses).toEqual(['error', 'revoked']);
		expect(db.store.bankConnections).toHaveLength(2);
	});

	it('restaure le lien Account.bankConnectionId avec les FKs remappées vers la nouvelle BankConnection', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.bankConnections = [
			{
				id: 'file-bank-1',
				provider: 'enablebanking',
				status: 'active',
				consentExpiresAt: null,
				lastSyncAt: null
			}
		];
		payload.accounts[0] = { ...payload.accounts[0], bankConnectionId: 'file-bank-1' } as never;

		await restoreBackup('user-a', payload);

		const [account] = db.store.accounts;
		const [connection] = db.store.bankConnections;
		expect(account.bankConnectionId).toBe(connection.id);
		expect(account.bankConnectionId).not.toBe('file-bank-1');
	});

	it('reste rétrocompatible avec un ancien fichier de backup sans bankConnectionId sur les comptes', async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.accounts = [
			{ id: 'file-acc-1', name: 'Compte courant', currency: 'EUR', source: 'manual' } as never
		];

		await restoreBackup('user-a', payload);

		const [account] = db.store.accounts;
		expect(account.bankConnectionId).toBeNull();
	});

	it('rejette un compte référençant un bankConnectionId inconnu du fichier, avant toute écriture', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.accounts[0] = {
			...payload.accounts[0],
			bankConnectionId: 'connexion-inconnue'
		} as never;

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.prisma.$transaction).not.toHaveBeenCalled();
	});

	it("ne restaure pas de connexions bancaires si le fichier n'en contient pas (compat rétroactive, ancien backup sans bankConnections)", async () => {
		expect.assertions(1);

		const payload = buildValidPayload();
		payload.bankConnections = [];

		await restoreBackup('user-a', payload);

		expect(db.store.bankConnections).toHaveLength(0);
	});

	it("purge les connexions bancaires existantes de l'utilisateur restauré sans toucher celles d'un autre utilisateur", async () => {
		expect.assertions(2);

		db.store.bankConnections.push(
			{
				id: 'old-conn-a',
				userId: 'user-a',
				provider: 'old',
				status: 'active',
				consentExpiresAt: null,
				lastSyncAt: null
			},
			{
				id: 'conn-b',
				userId: 'user-b',
				provider: 'other',
				status: 'active',
				consentExpiresAt: null,
				lastSyncAt: null
			}
		);

		const payload = buildValidPayload();
		payload.bankConnections = [];

		await restoreBackup('user-a', payload);

		expect(db.store.bankConnections.some((c) => c.id === 'old-conn-a')).toBe(false);
		expect(db.store.bankConnections.some((c) => c.id === 'conn-b')).toBe(true);
	});
});
