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
		bankConnections: [] as Row[],
		recurringStreamActions: [] as Row[],
		tags: [] as Row[],
		transactionTags: [] as Row[],
		transactionSplits: [] as Row[],
		columnMappings: [] as Row[]
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

	/**
	 * TransactionTag has no `userId` column and no surrogate `id` (see the model comment in
	 * schema.prisma), so the generic `table()` helper above cannot serve it: that one filters on
	 * `where.userId`, and the real query reaches ownership through `where.transaction.userId`.
	 *
	 * The stored rows still carry a `userId` here, purely so a spec can express which user a link
	 * belongs to. The fake deliberately REFUSES a `where.userId` filter rather than honouring it:
	 * that column does not exist, the real engine would reject the query, and a fake that quietly
	 * accepted it would let a wrong query pass every test and fail only in production.
	 */
	// Mirrors transactionTagTable: TransactionSplit has no userId column either, so the fake
	// refuses a `userId` in the where clause exactly as the real schema would make impossible.
	// That refusal is the point — it is what makes the export spec able to prove the query scopes
	// through BOTH relations rather than through a column that does not exist.
	function transactionSplitTable() {
		const rows = store.transactionSplits;
		return {
			findMany: vi.fn(
				async ({
					where,
					select
				}: {
					where: {
						transaction?: { userId: string };
						category?: { userId: string };
						transactionId?: string;
					};
					select?: Record<string, boolean>;
					orderBy?: unknown;
				}) => {
					if ('userId' in where) {
						throw new Error(
							'TransactionSplit has no userId column; scope through `transaction: { userId }`'
						);
					}
					return rows
						.filter((row) => (where.transaction ? row.userId === where.transaction.userId : true))
						.filter((row) =>
							where.category ? row.categoryOwnerId === where.category.userId : true
						)
						.filter((row) =>
							where.transactionId ? row.transactionId === where.transactionId : true
						)
						.map((row) => pick(row, select));
				}
			),
			createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
				const created = data.map((entry) => {
					const owner = store.transactions.find((row) => row.id === entry.transactionId);
					const category = store.categories.find((row) => row.id === entry.categoryId);
					return {
						...entry,
						id: genId('split'),
						userId: owner?.userId,
						categoryOwnerId: category?.userId
					} as Row;
				});
				rows.push(...created);
				return { count: created.length };
			}),
			deleteMany: vi.fn(async ({ where }: { where: { transactionId?: string } }) => {
				const before = rows.length;
				const remaining = rows.filter(
					(row) => !(where.transactionId === undefined || row.transactionId === where.transactionId)
				);
				rows.length = 0;
				rows.push(...remaining);
				return { count: before - rows.length };
			})
		};
	}

	function transactionTagTable() {
		const rows = store.transactionTags;
		return {
			findMany: vi.fn(
				async ({
					where,
					select
				}: {
					where: {
						transaction?: { userId: string };
						tag?: { userId: string };
						transactionId?: string;
					};
					select?: Record<string, boolean>;
				}) => {
					if ('userId' in where) {
						throw new Error(
							'TransactionTag has no userId column; scope through `transaction: { userId }`'
						);
					}
					return rows
						.filter((row) => (where.transaction ? row.userId === where.transaction.userId : true))
						.filter((row) => (where.tag ? row.userId === where.tag.userId : true))
						.filter((row) =>
							where.transactionId ? row.transactionId === where.transactionId : true
						)
						.map((row) => pick(row, select));
				}
			),
			createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
				// No generated id: the primary key is (transactionId, tagId). The `userId` written
				// here is the fake's own bookkeeping, derived from the link's transaction, exactly
				// as the real query derives ownership through the relation.
				const created = data.map((entry) => {
					const owner = store.transactions.find((row) => row.id === entry.transactionId);
					return { ...entry, userId: owner?.userId } as Row;
				});
				rows.push(...created);
				return { count: created.length };
			}),
			deleteMany: vi.fn(
				async ({ where }: { where: { transactionId?: string; tagId?: { in: string[] } } }) => {
					const before = rows.length;
					const remaining = rows.filter(
						(row) =>
							!(
								(where.transactionId === undefined || row.transactionId === where.transactionId) &&
								(where.tagId === undefined || where.tagId.in.includes(row.tagId as string))
							)
					);
					rows.length = 0;
					rows.push(...remaining);
					return { count: before - rows.length };
				}
			),
			count: vi.fn(
				async ({ where }: { where?: { transaction?: { userId: string } } } = {}) =>
					rows.filter((row) =>
						where?.transaction ? row.userId === where.transaction.userId : true
					).length
			)
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
			// Iterates the store rather than listing its tables by hand. The hand-written version
			// omitted `columnMappings` the day that table was added, and the symptom was a row
			// surviving into the next test, where it read as a refusal that had failed to refuse:
			// the assertion was about the store's contents and the cause was two tests away. A
			// table added later cannot be forgotten by a loop.
			for (const table of Object.values(store)) table.length = 0;
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
			columnMapping: table(store.columnMappings, 'column-mapping'),
			transaction: table(store.transactions, 'transaction'),
			monthlyBudget: table(store.monthlyBudgets, 'budget'),
			categoryRule: table(store.categoryRules, 'category-rule'),
			categorizationRule: table(store.categorizationRules, 'categorization-rule'),
			categoryNatureMapping: table(store.categoryNatureMappings, 'nature-mapping'),
			netWorthAccount: table(store.netWorthAccounts, 'net-worth-account'),
			netWorthSnapshot: table(store.netWorthSnapshots, 'net-worth-snapshot'),
			savingsGoal: table(store.savingsGoals, 'savings-goal'),
			bankConnection: table(store.bankConnections, 'bank-connection'),
			recurringStreamAction: table(store.recurringStreamActions, 'recurring-action'),
			tag: table(store.tags, 'tag'),
			transactionTag: transactionTagTable(),
			transactionSplit: transactionSplitTable(),
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
// MAX_PORTABLE_STRING is deliberately NOT imported here: the seam fixture below uses the literal
// 191, and importing the constant is what made an earlier version of that fixture unfalsifiable.
const { MAX_ANCHOR_IDS, MAX_ANCHOR_CELL_CHARS, backupExportSchema } = await import('./schema');
const { computeNameKey } = await import('$lib/server/naming/nameKey');
const { MAX_TAGS_PER_TRANSACTION } = await import('$lib/domain/tags');
type TagColorToken = import('$lib/domain/tags').TagColorToken;
const { UNCLASSIFIED_CATEGORY } = await import('$lib/domain/categories');
const { LONG_TRANSACTION_OPTIONS } = await import('$lib/server/dbTransaction');
const m = await import('$lib/paraglide/messages');

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

	it('scope les actions de flux récurrents par userId, sans fuite entre utilisateurs', async () => {
		expect.assertions(3);

		db.store.users.push(
			{ id: 'user-a', email: 'a@example.test' },
			{ id: 'user-b', email: 'b@example.test' }
		);
		const action = (id: string, userId: string, label: string) => ({
			id,
			userId,
			kind: 'IGNORE',
			direction: 'expense',
			normalizedLabel: label.toLowerCase(),
			label,
			anchorTransactionIds: JSON.stringify([`tx-${userId}`]),
			dueDate: new Date('2026-08-15T00:00:00.000Z'),
			createdAt: new Date('2026-07-31T00:00:00.000Z'),
			updatedAt: new Date('2026-07-31T00:00:00.000Z')
		});
		db.store.recurringStreamActions.push(
			action('action-a', 'user-a', 'EDF'),
			action('action-b', 'user-b', 'Secret action B')
		);

		const result = await buildBackupExport('user-a');

		expect(result.recurringStreamActions).toHaveLength(1);
		expect(result.recurringStreamActions[0].label).toBe('EDF');
		expect(JSON.stringify(result)).not.toContain('Secret action B');
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

	it('exports tags scoped by userId, with no leak between users', async () => {
		expect.assertions(2);

		db.store.users.push({ id: 'user-a', email: 'a@example.test' });
		db.store.tags.push(
			{ id: 'tag-a', userId: 'user-a', name: 'Portugal', colorToken: 'clay' },
			{ id: 'tag-b', userId: 'user-b', name: 'Autre', colorToken: 'ochre' }
		);

		const result = await buildBackupExport('user-a');

		expect(result.tags).toEqual([{ id: 'tag-a', name: 'Portugal', colorToken: 'clay' }]);
		// The other user's tag name is free text about their own life. Assert on the whole
		// serialized payload, not just the tags array, so a leak through any other key is caught.
		expect(JSON.stringify(result)).not.toContain('Autre');
	});

	it('exports transaction-tag pairs only for the requesting user', async () => {
		expect.assertions(2);

		db.store.users.push({ id: 'user-a', email: 'a@example.test' });
		db.store.transactionTags.push(
			{ id: 'link-a', userId: 'user-a', transactionId: 'tx-a', tagId: 'tag-a' },
			{ id: 'link-b', userId: 'user-b', transactionId: 'tx-b', tagId: 'tag-b' }
		);

		const result = await buildBackupExport('user-a');

		expect(result.transactionTags).toEqual([{ transactionId: 'tx-a', tagId: 'tag-a' }]);
		expect(JSON.stringify(result)).not.toContain('tx-b');
	});

	it('reaches transaction-tag pairs through the relation, never a userId column', async () => {
		expect.assertions(1);

		db.store.users.push({ id: 'user-a', email: 'a@example.test' });

		await buildBackupExport('user-a');

		// TransactionTag has no userId column. The fake throws on `where.userId`, so this asserts
		// the shape the real engine would accept rather than trusting the query to be right.
		expect(db.prisma.transactionTag.findMany.mock.calls[0][0].where).toEqual({
			transaction: { userId: 'user-a' },
			tag: { userId: 'user-a' }
		});
	});
});

describe('restoreBackup', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
	});

	function buildValidPayload() {
		return {
			// Empty by default: the mapping restore path has its own tests, and every other test
			// here would otherwise carry a mapping it says nothing about.
			columnMappings: [] as Array<{
				fingerprint: string;
				matchBy: 'name' | 'position';
				dateColumn: string | null;
				labelColumn: string | null;
				amountColumn: string | null;
				categoryColumn: string | null;
				dateIndex: number | null;
				labelIndex: number | null;
				amountIndex: number | null;
				categoryIndex: number | null;
				columnCount: number;
				useCount: number;
			}>,
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
			}>,
			recurringStreamActions: [] as Array<{
				id: string;
				kind: 'IGNORE' | 'PAID' | 'EXCLUDE';
				direction: 'income' | 'expense';
				normalizedLabel: string;
				label: string;
				anchorTransactionIds: string;
				dueDate: string | null;
				createdAt: string;
				updatedAt: string;
			}>,
			tags: [] as Array<{ id: string; name: string; colorToken: TagColorToken }>,
			transactionTags: [] as Array<{ transactionId: string; tagId: string }>,
			transactionSplits: [] as Array<{
				id: string;
				transactionId: string;
				categoryId: string;
				amountCents: number;
				position: number;
				note: string | null;
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

	/**
	 * A mapping arriving through a restore is the `replaceSplits`/`createMany` shape again, and it
	 * is more dangerous than that one was: a bad split is one wrong transaction, a bad mapping
	 * decides which column is money on every future import of that shape.
	 *
	 * The zod schema cannot catch any of the three below. It bounds the SHAPE of a mapping; these
	 * are facts about the RELATIONSHIP between its fields, and only the shared validator sees them.
	 */
	function payloadWithMapping(overrides: Record<string, unknown> = {}) {
		return {
			...buildValidPayload(),
			columnMappings: [
				{
					fingerprint: 'a'.repeat(64),
					matchBy: 'name' as const,
					dateColumn: 'date operation',
					labelColumn: 'libelle complet',
					amountColumn: 'montant',
					categoryColumn: 'categorie banque',
					dateIndex: null,
					labelIndex: null,
					amountIndex: null,
					categoryIndex: null,
					columnCount: 15,
					useCount: 0,
					...overrides
				}
			]
		};
	}

	it('restores a valid column mapping', async () => {
		expect.assertions(2);

		await restoreBackup('user-a', payloadWithMapping());

		// The presence half for the three refusals below: without it, a restore that dropped every
		// mapping on the floor would satisfy all of them.
		expect(db.store.columnMappings).toHaveLength(1);
		expect(db.store.columnMappings[0].labelColumn).toBe('libelle complet');
	});

	it('refuses a mapping whose category column repeats a required role', async () => {
		expect.assertions(2);

		// The hand-edited backup. On the form path this is unreachable, because the selector does
		// not offer a column another role holds; on this path there is no selector, which is why
		// the check has to be here and not only there.
		await expect(
			restoreBackup('user-a', payloadWithMapping({ categoryColumn: 'libelle complet' }))
		).rejects.toThrow();
		expect(db.store.columnMappings).toHaveLength(0);
	});

	it('refuses a mapping carrying both names and indices', async () => {
		expect.assertions(1);

		await expect(restoreBackup('user-a', payloadWithMapping({ dateIndex: 0 }))).rejects.toThrow();
	});

	it('refuses two mappings sharing one fingerprint before writing either', async () => {
		expect.assertions(2);

		const payload = payloadWithMapping();
		payload.columnMappings.push({ ...payload.columnMappings[0] });

		// Refused by name rather than by the unique constraint firing mid-restore, which on
		// PostgreSQL aborts the enclosing transaction and takes the whole restore with it.
		await expect(restoreBackup('user-a', payload)).rejects.toThrow();
		expect(db.store.columnMappings).toHaveLength(0);
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

	it('RESTORES A PRE-#162 BACKUP, defaultKey and all, without writing the key', async () => {
		expect.assertions(3);

		// THE COMPATIBILITY GUARANTEE, and the reason `backupCategorySchema` still declares the
		// field. Every file written before #162 carries a `defaultKey`, and that object is
		// `.strict()`: dropping the field from the schema would turn it into an unrecognised key
		// and make every installed user's existing backup un-restorable in one release.
		//
		// So it is accepted and ignored. The category arrives under the name the file gives it,
		// which since #162 is the name it will display under, and nothing writes the column.
		const payload = buildValidPayload();
		payload.categories = [{ id: 'file-cat-1', name: 'Alimentation', defaultKey: 'food' } as never];
		payload.transactions[0].categoryId = 'file-cat-1';
		payload.monthlyBudgets[0].categoryName = 'Alimentation';

		await restoreBackup('user-a', payload);

		const category = db.store.categories.find(
			(c) => c.userId === 'user-a' && c.name === 'Alimentation'
		);
		expect(category).toBeDefined();
		expect(category?.name).toBe('Alimentation');
		expect(category?.defaultKey).toBeUndefined();
	});

	it('restores a file with no defaultKey at all, which is what this version writes', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.categories = [{ id: 'file-cat-1', name: 'Alimentation' }];
		payload.transactions[0].categoryId = 'file-cat-1';
		payload.monthlyBudgets[0].categoryName = 'Alimentation';

		await restoreBackup('user-a', payload);

		const category = db.store.categories.find(
			(c) => c.userId === 'user-a' && c.name === 'Alimentation'
		);
		expect(category?.name).toBe('Alimentation');
		expect(category?.defaultKey).toBeUndefined();
	});

	it('cannot be made to display a name nobody wrote, whatever defaultKey the file forges', async () => {
		expect.assertions(2);

		// This used to be a SANITISATION test: a `defaultKey` valid in the enum but inconsistent
		// with the name ("Compte piégé" + "income") would have displayed the row as "Revenus", so
		// the importer neutralised the key rather than rejecting the whole file.
		//
		// The attack it defended against no longer exists, and that is worth an assertion rather
		// than a deletion. No column decides how a category is displayed any more, so a forged
		// key cannot make a row claim a name: the row shows what the file called it, full stop.
		const payload = buildValidPayload();
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
		expect(category?.defaultKey).toBeUndefined();
	});

	// THE STAMP, which nothing asserted. Replacing `restoredDenomination(row)` with
	// `DEFAULT_DENOMINATION` at all seven sites was green across the whole suite: the columns are
	// required, so `npm run check` catches a MISSING spread and nothing catches a WRONG one. The
	// failure that hides behind that is silent, because every fixture in this file is euros.
	//
	// So the fixture is deliberately not euros. A KWD account at exponent 3 is the case where
	// "took the file's value" and "took the application default" produce different rows.
	it("writes the file's own denomination, not the application default", async () => {
		expect.assertions(4);

		const payload = buildValidPayload();
		payload.accounts[0].currency = 'KWD';
		(payload.accounts[0] as { exponent?: number }).exponent = 3;
		(payload.transactions[0] as { currency?: string }).currency = 'KWD';
		(payload.transactions[0] as { exponent?: number }).exponent = 3;

		await restoreBackup('user-a', payload);

		const account = db.store.accounts.find((entry) => entry.userId === 'user-a');
		expect(account?.currency).toBe('KWD');
		expect(account?.exponent).toBe(3);
		const transaction = db.store.transactions.find((entry) => entry.userId === 'user-a');
		expect(transaction?.currency).toBe('KWD');
		expect(transaction?.exponent).toBe(3);
	});

	// The other half of the same stamp, and the reason the `??` in `restoredDenomination` is a fact
	// rather than a guess: a file written before the columns existed could only have held euros at
	// exponent 2, because that is the only thing the schema of the day could express.
	it('stamps a file written before the columns existed as euros at exponent 2', async () => {
		expect.assertions(3);

		const payload = buildValidPayload();
		expect(payload.transactions[0]).not.toHaveProperty('currency');

		await restoreBackup('user-a', payload);

		const transaction = db.store.transactions.find((entry) => entry.userId === 'user-a');
		expect(transaction?.currency).toBe('EUR');
		expect(transaction?.exponent).toBe(2);
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

	const anchoredAction = (anchors: string[], id = 'file-action-1') => ({
		id,
		kind: 'IGNORE' as const,
		direction: 'expense' as const,
		normalizedLabel: 'carrefour',
		label: 'Carrefour',
		anchorTransactionIds: JSON.stringify(anchors),
		dueDate: new Date('2026-08-15T00:00:00.000Z').toISOString(),
		createdAt: new Date('2026-07-31T00:00:00.000Z').toISOString(),
		updatedAt: new Date('2026-07-31T00:00:00.000Z').toISOString()
	});

	/**
	 * The security property of this model. Anchors are transaction ids inside a JSON cell, so
	 * nothing at the database level rewrites them the way a foreign key column gets rewritten:
	 * an id left exactly as the file wrote it would, after a restore into another account, name
	 * a row belonging to somebody else.
	 */
	it("remappe les ids d'ancrage d'une action vers les transactions recréées", async () => {
		expect.assertions(4);

		const payload = buildValidPayload();
		payload.recurringStreamActions = [anchoredAction(['file-tx-1'])];

		await restoreBackup('user-a', payload);

		expect(db.store.recurringStreamActions).toHaveLength(1);

		const [transaction] = db.store.transactions;
		const [action] = db.store.recurringStreamActions;

		expect(transaction.id).not.toBe('file-tx-1');
		expect(action.anchorTransactionIds).toBe(JSON.stringify([transaction.id]));
		expect(action.userId).toBe('user-a');
	});

	/**
	 * Dropping an unmappable anchor degrades the action to label-based matching, which is what
	 * the fallback exists for. Keeping it would leave a foreign id in the user's own row.
	 */
	it("laisse tomber un id d'ancrage sans correspondance dans le fichier", async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.recurringStreamActions = [anchoredAction(['file-tx-1', 'tx-from-another-user'])];

		await restoreBackup('user-a', payload);

		const [transaction] = db.store.transactions;
		const [action] = db.store.recurringStreamActions;

		expect(action.anchorTransactionIds).toBe(JSON.stringify([transaction.id]));
		expect(action.anchorTransactionIds).not.toContain('tx-from-another-user');
	});

	it('tolère un anchorTransactionIds illisible sans faire échouer la restauration', async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.recurringStreamActions = [{ ...anchoredAction([]), anchorTransactionIds: 'not json' }];

		await restoreBackup('user-a', payload);

		expect(db.store.recurringStreamActions).toHaveLength(1);
		expect(db.store.recurringStreamActions[0].anchorTransactionIds).toBe('[]');
	});

	it("ne restaure pas d'actions si le fichier n'en contient pas (compat rétroactive)", async () => {
		expect.assertions(2);

		await restoreBackup('user-a', buildValidPayload());

		expect(db.store.recurringStreamActions).toHaveLength(0);
		// Every transaction still goes through the bulk path when nothing is anchored.
		expect(db.prisma.transaction.create).not.toHaveBeenCalled();
	});

	it("purge les actions existantes de l'utilisateur restauré sans toucher celles d'un autre utilisateur", async () => {
		expect.assertions(2);

		db.store.recurringStreamActions.push(
			{ id: 'old-action-a', userId: 'user-a', kind: 'PAID' },
			{ id: 'action-b', userId: 'user-b', kind: 'PAID' }
		);

		await restoreBackup('user-a', buildValidPayload());

		expect(db.store.recurringStreamActions.some((a) => a.id === 'old-action-a')).toBe(false);
		expect(db.store.recurringStreamActions.some((a) => a.id === 'action-b')).toBe(true);
	});

	/** A second transaction on the same account/category, so a payload can hold both kinds. */
	const withSecondTransaction = (payload: ReturnType<typeof buildValidPayload>) => {
		payload.transactions.push({
			...payload.transactions[0],
			id: 'file-tx-2',
			label: 'Leclerc',
			dedupeKey: 'dedupe-2'
		});
		return payload;
	};

	/**
	 * The split between the bulk path and the per-row path is the one place a duplicate insert or
	 * a silently dropped row can live, and a one-transaction fixture cannot express it: with a
	 * single transaction, a regression that drops every unanchored row still goes green.
	 */
	it('crée les transactions ancrées une par une et les autres en bloc, sans doublon ni perte', async () => {
		expect.assertions(6);

		const payload = withSecondTransaction(buildValidPayload());
		payload.recurringStreamActions = [anchoredAction(['file-tx-1'])];

		await restoreBackup('user-a', payload);

		expect(db.store.transactions).toHaveLength(2);
		expect(db.store.transactions.map((t) => t.label).sort()).toEqual(['Carrefour', 'Leclerc']);

		// Exactly one bulk call carrying exactly the unanchored row, and exactly one per-row call.
		expect(db.prisma.transaction.createMany).toHaveBeenCalledTimes(1);
		const [bulkCall] = db.prisma.transaction.createMany.mock.calls;
		expect(bulkCall[0].data).toHaveLength(1);
		expect(bulkCall[0].data[0].label).toBe('Leclerc');
		expect(db.prisma.transaction.create).toHaveBeenCalledTimes(1);
	});

	/**
	 * Two actions naming the same transaction. The anchored set is a Set precisely so the loop
	 * cannot create that row twice; without it both actions would also remap to different ids.
	 */
	it('crée une seule fois une transaction ancrée par deux actions, et les deux pointent dessus', async () => {
		expect.assertions(4);

		const payload = withSecondTransaction(buildValidPayload());
		payload.recurringStreamActions = [
			anchoredAction(['file-tx-1'], 'file-action-1'),
			anchoredAction(['file-tx-1', 'file-tx-2'], 'file-action-2')
		];

		await restoreBackup('user-a', payload);

		expect(db.store.transactions).toHaveLength(2);
		expect(db.prisma.transaction.create).toHaveBeenCalledTimes(2);

		const shared = db.store.transactions.find((t) => t.label === 'Carrefour')!;
		const [first, second] = db.store.recurringStreamActions;

		expect(first.anchorTransactionIds).toBe(JSON.stringify([shared.id]));
		expect(JSON.parse(second.anchorTransactionIds as string)[0]).toBe(shared.id);
	});

	/**
	 * Distinct from the unparseable-cell case: the cell parses fine, every id in it simply has no
	 * entry in the map. Exercises the lookup, not the parser.
	 */
	it("écrit '[]' quand aucun id d'ancrage n'existe dans le fichier, sans lever", async () => {
		expect.assertions(3);

		const payload = buildValidPayload();
		payload.recurringStreamActions = [anchoredAction(['ghost-1', 'ghost-2'])];

		await expect(restoreBackup('user-a', payload)).resolves.toBeUndefined();

		expect(db.store.recurringStreamActions[0].anchorTransactionIds).toBe('[]');
		// Nothing was anchored, so nothing left the bulk path.
		expect(db.prisma.transaction.create).not.toHaveBeenCalled();
	});

	it("régénère l'id de l'action au lieu de reprendre celui du fichier", async () => {
		expect.assertions(2);

		const payload = buildValidPayload();
		payload.recurringStreamActions = [anchoredAction(['file-tx-1'])];

		await restoreBackup('user-a', payload);

		expect(db.store.recurringStreamActions[0].id).not.toBe('file-action-1');
		expect(db.store.recurringStreamActions[0].id).toBeTruthy();
	});

	/**
	 * The check that would have caught the bound being enforced on the way in only.
	 *
	 * This column is the one a restore REWRITES: each file id becomes a freshly generated 25-char
	 * cuid, so the cell written can be larger than the cell that was validated. Nothing
	 * re-validates it before the insert, and the export route serializes with a bare
	 * `JSON.stringify` without running the schema — so an oversized cell would leave the system
	 * and be refused on the way back in, telling the user their own export is corrupt.
	 */
	it("borne le nombre d'ancres ÉCRITES, pas seulement celles lues", async () => {
		expect.assertions(4);

		// The bound the write path relies on: a full cell of real cuids still fits the schema.
		expect(MAX_ANCHOR_IDS * 28 + 2).toBeLessThanOrEqual(MAX_ANCHOR_CELL_CHARS);
		const worstCase = JSON.stringify(Array.from({ length: MAX_ANCHOR_IDS }, () => 'c'.repeat(25)));
		expect(worstCase.length).toBeLessThanOrEqual(MAX_ANCHOR_CELL_CHARS);

		// And the property itself: more anchors in the file than the cap yields exactly the cap.
		const payload = buildValidPayload();
		const overflow = MAX_ANCHOR_IDS + 50;
		payload.transactions = Array.from({ length: overflow }, (_, index) => ({
			...payload.transactions[0],
			id: `file-tx-${index}`,
			dedupeKey: `dedupe-${index}`
		}));
		payload.recurringStreamActions = [
			anchoredAction(payload.transactions.map((transaction) => transaction.id))
		];

		await restoreBackup('user-a', payload);

		const written = db.store.recurringStreamActions[0].anchorTransactionIds as string;
		expect(JSON.parse(written)).toHaveLength(MAX_ANCHOR_IDS);
		expect(written.length).toBeLessThanOrEqual(MAX_ANCHOR_CELL_CHARS);
	});
});

/**
 * Minimal restorable payload for the tag cases: one account, one category, one transaction, and
 * empty everything else. Separate from the `buildValidPayload` inside the restoreBackup describe
 * above, which carries net-worth and savings fixtures these cases do not need and whose noise
 * would make a failure harder to read.
 */
function buildTagRestorePayload() {
	return {
		// Empty for the same reason as buildValidPayload's: this fixture is about tags.
		columnMappings: [] as Array<{
			fingerprint: string;
			matchBy: 'name' | 'position';
			dateColumn: string | null;
			labelColumn: string | null;
			amountColumn: string | null;
			categoryColumn: string | null;
			dateIndex: number | null;
			labelIndex: number | null;
			amountIndex: number | null;
			categoryIndex: number | null;
			columnCount: number;
			useCount: number;
		}>,
		formatVersion: 1 as const,
		exportedAt: new Date('2026-08-02T00:00:00.000Z').toISOString(),
		userEmail: 'a@example.test',
		accounts: [{ id: 'file-acc-1', name: 'Compte courant', currency: 'EUR', source: 'manual' }],
		categories: [{ id: 'file-cat-1', name: 'Courses' }],
		importBatches: [],
		transactions: [
			{
				id: 'file-tx-1',
				accountId: 'file-acc-1',
				categoryId: 'file-cat-1',
				importBatchId: null,
				date: new Date('2026-06-15T00:00:00.000Z').toISOString(),
				label: 'Carrefour',
				amountCents: -4_200,
				type: 'expense' as const,
				source: 'manual',
				notes: null,
				bankOperationType: null,
				manualCategory: null,
				natureManual: null,
				dedupeKey: null,
				metadataJson: null
			}
		],
		monthlyBudgets: [],
		categoryRules: [],
		categorizationRules: [],
		categoryNatureMappings: [],
		netWorthAccounts: [],
		netWorthSnapshots: [],
		savingsGoals: [],
		bankConnections: [],
		recurringStreamActions: [],
		tags: [] as Array<{ id: string; name: string; colorToken: TagColorToken }>,
		transactionTags: [] as Array<{ transactionId: string; tagId: string }>,
		transactionSplits: [] as Array<{
			id: string;
			transactionId: string;
			categoryId: string;
			amountCents: number;
			position: number;
			note: string | null;
		}>
	};
}

describe('restoreBackup with tags', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
		db.store.users.push({ id: 'user-a', email: 'a@example.test' });
	});

	function payloadWithTag() {
		const payload = buildTagRestorePayload();
		payload.tags = [{ id: 'file-clay', name: 'Portugal', colorToken: 'olive' }];
		payload.transactionTags = [{ transactionId: payload.transactions[0].id, tagId: 'file-clay' }];
		return payload;
	}

	it('recreates tags with regenerated ids and relinks them to the new transactions', async () => {
		expect.assertions(6);

		await restoreBackup('user-a', payloadWithTag());

		const tag = db.store.tags.find((row) => row.userId === 'user-a');
		expect(tag).toBeDefined();
		// The file's id must never survive: Transaction.id and Tag.id are global primary keys, so
		// a hand-edited export naming another user's id would otherwise turn a restore into a
		// cross-account collision.
		expect(tag!.id).not.toBe('file-clay');
		expect(tag!.name).toBe('Portugal');
		expect(tag!.colorToken).toBe('olive');
		// nameKey is recomputed, never read from the file.
		expect(tag!.nameKey).toBe(computeNameKey('Portugal'));

		const transaction = db.store.transactions.find((row) => row.userId === 'user-a');
		const link = db.store.transactionTags[0];
		expect(link).toEqual(
			expect.objectContaining({ transactionId: transaction!.id, tagId: tag!.id })
		);
	});

	it('purges the previous user tags before restoring', async () => {
		expect.assertions(2);

		db.store.tags.push({ id: 'old-tag', userId: 'user-a', name: 'Ancien', colorToken: 'clay' });

		await restoreBackup('user-a', payloadWithTag());

		expect(db.store.tags.filter((row) => row.userId === 'user-a')).toHaveLength(1);
		expect(db.store.tags.find((row) => row.id === 'old-tag')).toBeUndefined();
	});

	it('leaves another user tags untouched', async () => {
		expect.assertions(1);

		db.store.tags.push({ id: 'other-tag', userId: 'user-b', name: 'Autre', colorToken: 'ochre' });

		await restoreBackup('user-a', buildTagRestorePayload());

		expect(db.store.tags.find((row) => row.id === 'other-tag')).toBeDefined();
	});

	it('purges tags with a userId-scoped deleteMany, and never touches the join table directly', async () => {
		expect.assertions(2);

		await restoreBackup('user-a', payloadWithTag());

		expect(db.prisma.tag.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-a' } });
		// TransactionTag is deliberately absent from the purge list: it has no userId to scope a
		// deleteMany by, and it cascades from BOTH parents. This pins the ABSENCE, so a future
		// edit adding a purge line here goes red and has to justify itself.
		//
		// That the cascade actually fires is a DATABASE claim, and this fake has no cascades, so
		// it structurally cannot prove it. Asserting it here would only prove the fake. The real
		// assertion runs against all three engines in backup/volume.db-smoke.ts.
		expect(db.prisma.transactionTag.deleteMany).not.toHaveBeenCalled();
	});

	it('folds two file tags with the same normalized name onto one row, without a duplicate link', async () => {
		expect.assertions(2);

		const payload = buildTagRestorePayload();
		payload.tags = [
			{ id: 'file-clay', name: 'Portugal', colorToken: 'olive' },
			{ id: 'file-ochre', name: 'PORTUGAL', colorToken: 'azure' }
		];
		payload.transactionTags = [
			{ transactionId: payload.transactions[0].id, tagId: 'file-clay' },
			{ transactionId: payload.transactions[0].id, tagId: 'file-ochre' }
		];

		await restoreBackup('user-a', payload);

		// One tag, and crucially ONE link: both file tags remap to the same row, so an
		// undeduplicated insert would violate the composite primary key.
		expect(db.store.tags.filter((row) => row.userId === 'user-a')).toHaveLength(1);
		expect(db.store.transactionTags).toHaveLength(1);
	});

	it('cannot collide with another user rows whose real ids match the ids in the file', async () => {
		expect.assertions(4);

		// The forbidden thing, attempted rather than argued. Tag.id and Transaction.id are GLOBAL
		// primary keys, so a hand-edited export can name an id that really belongs to somebody
		// else. Seed exactly that: user-b owns rows whose ids are the ones user-a's file uses.
		//
		// Reasoning that the code is safe is not evidence here. The previous version of this file
		// asserted only that the restored id differs from the file's, which is true even if the
		// collision were catastrophic.
		db.store.tags.push({
			id: 'file-clay',
			userId: 'user-b',
			name: 'Le tag de B',
			colorToken: 'ochre'
		});
		db.store.transactions.push({
			id: 'file-tx-1',
			userId: 'user-b',
			label: 'La transaction de B',
			amountCents: -999
		});

		await restoreBackup('user-a', payloadWithTag());

		// User B's rows are untouched: not deleted by the purge, not overwritten by the restore.
		expect(db.store.tags.find((row) => row.id === 'file-clay')?.userId).toBe('user-b');
		expect(db.store.transactions.find((row) => row.id === 'file-tx-1')?.userId).toBe('user-b');
		// And nothing user A restored points at either of them.
		const restoredTagIds = db.store.tags
			.filter((row) => row.userId === 'user-a')
			.map((row) => row.id);
		expect(restoredTagIds).not.toContain('file-clay');
		expect(db.store.transactionTags.every((link) => link.userId === 'user-a')).toBe(true);
	});

	it('rejects a pair naming a tag absent from the payload, before any write', async () => {
		expect.assertions(2);

		const payload = buildTagRestorePayload();
		payload.transactionTags = [
			{ transactionId: payload.transactions[0].id, tagId: 'file-tag-missing' }
		];

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	it('rejects a pair naming a transaction absent from the payload, before any write', async () => {
		expect.assertions(2);

		const payload = buildTagRestorePayload();
		payload.tags = [{ id: 'file-clay', name: 'Portugal', colorToken: 'olive' }];
		payload.transactionTags = [{ transactionId: 'file-tx-missing', tagId: 'file-clay' }];

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	/**
	 * THE PER-TRANSACTION CAP.
	 *
	 * `schema.ts` bounds the array RELATIVELY, at transactions x MAX_TAGS_PER_TRANSACTION, which
	 * says nothing about the DISTRIBUTION — piling 11 onto one transaction while the others carry
	 * none sits well under any such ceiling. The restore is the only write path that does not go
	 * through `setTransactionTags`, so until this check existed nothing applied the cap to an
	 * uploaded payload. Exact analogue of the split count bounds asserted further down.
	 *
	 * Each case asserts the payload is under the RELATIVE ceiling first. Without that, a refusal
	 * here is indistinguishable from `schema.ts` catching the same file for a different reason —
	 * the two-guards-in-sequence shape, where the green conceals which one is load-bearing.
	 */
	/**
	 * Adds sibling transactions so the payload can sit UNDER the relative ceiling while still
	 * over-loading one row. Without them the fixture's single transaction makes every such payload
	 * exceed `transactions x MAX` as well, and the two guards become indistinguishable.
	 */
	function withSiblingTransactions(payload: ReturnType<typeof buildTagRestorePayload>, n: number) {
		const template = payload.transactions[0];
		for (let i = 0; i < n; i += 1) {
			payload.transactions.push({ ...template, id: `file-tx-sibling-${i}` });
		}
		return payload;
	}

	function payloadWithTagsOnOneTransaction(count: number) {
		const payload = withSiblingTransactions(buildTagRestorePayload(), 3);
		payload.tags = Array.from({ length: count }, (_, i) => ({
			id: `file-tag-${i}`,
			name: `Tag ${i}`,
			colorToken: 'olive' as const
		}));
		payload.transactionTags = payload.tags.map((tag) => ({
			transactionId: payload.transactions[0].id,
			tagId: tag.id
		}));
		return payload;
	}

	it('refuses more tags on one transaction than a write path could ever put there', async () => {
		expect.assertions(3);

		const payload = payloadWithTagsOnOneTransaction(MAX_TAGS_PER_TRANSACTION + 1);
		// Under the relative ceiling only because the fixture holds several transactions: this is
		// the distribution the array bound cannot see.
		expect(payload.transactionTags.length).toBeLessThanOrEqual(
			payload.transactions.length * MAX_TAGS_PER_TRANSACTION
		);

		await expect(restoreBackup('user-a', payload)).rejects.toThrow(
			m.settings_backup_error_tag_count({
				id: payload.transactions[0].id,
				max: MAX_TAGS_PER_TRANSACTION
			})
		);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	it('accepts exactly the cap, so the bound is off-by-one correct', async () => {
		expect.assertions(1);

		await restoreBackup('user-a', payloadWithTagsOnOneTransaction(MAX_TAGS_PER_TRANSACTION));

		expect(db.store.transactionTags).toHaveLength(MAX_TAGS_PER_TRANSACTION);
	});

	it('counts what will be STORED, not what the file spells: folded names collapse first', async () => {
		expect.assertions(2);

		// MAX + 1 file tags, but two of them fold to one name, so the restore stores MAX links. A
		// check counting raw links would refuse this — a legal file, since the same fold is what
		// the accepted "folds two file tags onto one row" case above relies on.
		const payload = payloadWithTagsOnOneTransaction(MAX_TAGS_PER_TRANSACTION + 1);
		payload.tags[MAX_TAGS_PER_TRANSACTION].name = payload.tags[0].name.toUpperCase();

		await restoreBackup('user-a', payload);

		expect(db.store.tags.filter((row) => row.userId === 'user-a')).toHaveLength(
			MAX_TAGS_PER_TRANSACTION
		);
		expect(db.store.transactionTags).toHaveLength(MAX_TAGS_PER_TRANSACTION);
	});

	it('spreads the same links across transactions without refusing', async () => {
		expect.assertions(2);

		// The same total that was refused above, distributed legally. Proves the check reads the
		// distribution rather than the array length — a guard on the total would fail this.
		const payload = withSiblingTransactions(buildTagRestorePayload(), 3);
		const perTransaction = MAX_TAGS_PER_TRANSACTION;
		payload.tags = Array.from({ length: perTransaction }, (_, i) => ({
			id: `file-tag-${i}`,
			name: `Tag ${i}`,
			colorToken: 'olive' as const
		}));
		payload.transactionTags = payload.transactions.flatMap((transaction) =>
			payload.tags.map((tag) => ({ transactionId: transaction.id, tagId: tag.id }))
		);
		expect(payload.transactionTags.length).toBeGreaterThan(MAX_TAGS_PER_TRANSACTION);

		await restoreBackup('user-a', payload);

		expect(db.store.transactionTags).toHaveLength(payload.transactionTags.length);
	});
});

describe('backup with transaction splits', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
		db.store.users.push({ id: 'user-a', email: 'a@example.test' });
	});

	it('exports parts only for the requesting user, scoping through BOTH relations', async () => {
		expect.assertions(3);

		db.store.transactionSplits.push(
			{
				id: 'split-a',
				userId: 'user-a',
				categoryOwnerId: 'user-a',
				transactionId: 'tx-a',
				categoryId: 'cat-a',
				amountCents: -6000,
				position: 0,
				note: 'courses'
			},
			// Same owning transaction, but a category belonging to somebody else. Impossible
			// through the write path and the whole reason the second conjunct exists: with only
			// `transaction: { userId }` this row would be exported, naming a categoryId absent
			// from the `categories` array, and the user's own export would never restore again.
			{
				id: 'split-cross',
				userId: 'user-a',
				categoryOwnerId: 'user-b',
				transactionId: 'tx-a',
				categoryId: 'cat-b',
				amountCents: -2000,
				position: 1,
				note: null
			},
			{
				id: 'split-b',
				userId: 'user-b',
				categoryOwnerId: 'user-b',
				transactionId: 'tx-b',
				categoryId: 'cat-b',
				amountCents: -100,
				position: 0,
				note: 'autre'
			}
		);

		const result = await buildBackupExport('user-a');

		expect(result.transactionSplits).toEqual([
			{
				id: 'split-a',
				transactionId: 'tx-a',
				categoryId: 'cat-a',
				amountCents: -6000,
				position: 0,
				note: 'courses'
			}
		]);
		expect(JSON.stringify(result)).not.toContain('tx-b');
		expect(JSON.stringify(result)).not.toContain('cat-b');
	});

	function buildSplitRestorePayload() {
		const payload = buildTagRestorePayload();
		payload.categories = [
			{ id: 'file-cat-1', name: 'Alimentation' },
			{ id: 'file-cat-2', name: 'Maison' }
		];
		payload.transactions[0].amountCents = -8000;
		payload.transactionSplits = [
			{
				id: 'file-split-1',
				transactionId: payload.transactions[0].id,
				categoryId: 'file-cat-1',
				amountCents: -6000,
				position: 0,
				note: 'courses'
			},
			{
				id: 'file-split-2',
				transactionId: payload.transactions[0].id,
				categoryId: 'file-cat-2',
				amountCents: -2000,
				position: 1,
				note: null
			}
		];
		return payload;
	}

	/**
	 * TWO transactions, of OPPOSITE sign, each with its own valid répartition.
	 *
	 * Every other fixture in this file carries exactly one transaction, which makes "each part is
	 * checked against ITS OWN parent" correct by inspection and never once observed: with a single
	 * parent, a lookup that collapsed to "whichever amount the map returns" would behave
	 * identically. The second transaction is an income precisely so that collapse cannot pass —
	 * under a single shared parent amount, one of the two répartitions is necessarily wrong-signed.
	 */
	function buildTwoSplitRestorePayload() {
		const payload = buildSplitRestorePayload();
		const expense = payload.transactions[0];
		const income = { ...expense, id: 'file-tx-2', label: 'Salaire', amountCents: 8000 };
		// The builder's `type` is a literal 'expense', so the field is widened to write 'income'
		// through it. Nothing about what the restore receives changes.
		(income as { type: string }).type = 'income';
		payload.transactions = [expense, income];
		payload.transactionSplits = [
			...payload.transactionSplits,
			{
				id: 'file-split-3',
				transactionId: 'file-tx-2',
				categoryId: 'file-cat-1',
				amountCents: 5000,
				position: 0,
				note: null
			},
			{
				id: 'file-split-4',
				transactionId: 'file-tx-2',
				categoryId: 'file-cat-2',
				amountCents: 3000,
				position: 1,
				note: null
			}
		];
		return payload;
	}

	it('restores an expense and an income répartition from the same file, each summing to its own parent', async () => {
		expect.assertions(3);

		await restoreBackup('user-a', buildTwoSplitRestorePayload());

		const parents = db.store.transactions.filter((row) => row.userId === 'user-a');
		const restored = db.store.transactionSplits.filter((row) => row.userId === 'user-a');
		expect(restored).toHaveLength(4);

		// Grouped by the REGENERATED parent id, so this says nothing about which file row it came
		// from and everything about which parent it now belongs to.
		const sumFor = (transactionId: string) =>
			restored
				.filter((row) => row.transactionId === transactionId)
				.reduce((sum, row) => sum + (row.amountCents as number), 0);
		const expense = parents.find((row) => row.amountCents === -8000)!;
		const income = parents.find((row) => row.amountCents === 8000)!;
		expect(sumFor(expense.id)).toBe(-8000);
		expect(sumFor(income.id)).toBe(8000);
	});

	// WHICH transaction the refusal names is the assertion, not that a refusal happened. Only the
	// SECOND répartition is forged, and the first is left legal and of the opposite sign, so a
	// refusal naming the first would be a false sentence.
	//
	// WHAT THIS DOES NOT CATCH, measured rather than assumed: collapsing the lookup onto
	// `payload.transactions[0].amountCents` leaves this test GREEN, because the message is built
	// from the SPLIT's own `transactionId` and the forged part is opposite-signed under either
	// parent. The test above — an income and an expense répartition both surviving — is the one
	// that goes red on that collapse, and it was watched doing so. Recorded here so neither test
	// is credited with the other's coverage.
	it('names the transaction whose own part carries the wrong sign, not the other one', async () => {
		expect.assertions(4);

		const payload = buildTwoSplitRestorePayload();
		payload.transactionSplits[2].amountCents = 13_000;
		payload.transactionSplits[3].amountCents = -5_000;
		// Still sums to its own parent, so nothing but the sign rule can refuse it.
		expect(
			payload.transactionSplits[2].amountCents + payload.transactionSplits[3].amountCents
		).toBe(8000);

		const error = await restoreBackup('user-a', payload).catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(BackupImportError);
		expect((error as Error).message).toBe(
			m.settings_backup_error_split_amount({ id: 'file-tx-2' })
		);
		// The first transaction's répartition is untouched and legal, so naming it would be a false
		// sentence sending the user to the wrong rows.
		expect((error as Error).message).not.toContain('file-tx-1');
	});

	// The COMBINATION, in the restored artifact, rather than each half alone. Per-leg checks pass
	// while the whole is broken: the parts can survive and no longer sum, which is the one state
	// the write path can never produce and the only one that makes every per-category total wrong.
	it('restores parts intact AND still summing to their parent', async () => {
		expect.assertions(4);

		await restoreBackup('user-a', buildSplitRestorePayload());

		const restored = db.store.transactionSplits.filter((row) => row.userId === 'user-a');
		expect(restored).toHaveLength(2);

		const parent = db.store.transactions.find((row) => row.userId === 'user-a');
		expect(parent).toBeDefined();
		// Both ids are the regenerated ones, never the file's.
		expect(restored.every((row) => row.transactionId === parent!.id)).toBe(true);
		expect(restored.reduce((sum, row) => sum + (row.amountCents as number), 0)).toBe(
			parent!.amountCents
		);
	});

	// THE FOUR REFUSALS BELOW ASSERT THEIR OWN SENTENCE, not merely that a refusal happened. Four
	// checks stand within a dozen lines of each other over the same payload, and each of them can
	// catch another's case for the wrong reason: a part naming an absent transaction would still be
	// refused if its check moved below the per-part loop — by that loop, under « les parts doivent
	// être du même signe », which is false and sends the user looking at signs rather than at a
	// dangling id. `toBeInstanceOf(BackupImportError)` stays green through every one of those
	// swaps, so it cannot tell four guards from one.
	it('refuses a payload whose parts do not sum to their parent, before any write', async () => {
		expect.assertions(2);

		const payload = buildSplitRestorePayload();
		payload.transactionSplits[1].amountCents = -1900;

		await expect(restoreBackup('user-a', payload)).rejects.toThrow(
			m.settings_backup_error_split_sum_mismatch({ id: 'file-tx-1' })
		);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	it('refuses a single-part répartition, which no write path can produce', async () => {
		expect.assertions(2);

		const payload = buildSplitRestorePayload();
		payload.transactionSplits = [payload.transactionSplits[0]];
		payload.transactionSplits[0].amountCents = -8000;

		await expect(restoreBackup('user-a', payload)).rejects.toThrow(
			m.settings_backup_error_split_count({ id: 'file-tx-1' })
		);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	it('refuses a part naming a transaction absent from the payload', async () => {
		expect.assertions(2);

		const payload = buildSplitRestorePayload();
		payload.transactionSplits[0].transactionId = 'file-tx-missing';

		await expect(restoreBackup('user-a', payload)).rejects.toThrow(
			m.settings_backup_error_unknown_split_transaction({ id: 'file-tx-missing' })
		);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	it('refuses a part naming a category absent from the payload', async () => {
		expect.assertions(2);

		const payload = buildSplitRestorePayload();
		payload.transactionSplits[0].categoryId = 'file-cat-missing';

		await expect(restoreBackup('user-a', payload)).rejects.toThrow(
			m.settings_backup_error_unknown_split_category({ id: 'file-cat-missing' })
		);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	// Pins the ABSENCE of a purge line, exactly as the transactionTags test above does, and for the
	// same reason: TransactionSplit has no userId to scope a deleteMany by, so it must die with its
	// transaction. A future edit adding a purge line here goes red and has to justify itself.
	//
	// It does NOT assert that the cascade fires. That is a DATABASE claim and this fake has no
	// cascades, so asserting it here would only prove the fake — the trap the tag test already
	// names. The real assertion runs against all three engines in the db-smoke suite.
	//
	// One thing this fake CAN prove, and it is the half that is not about cascades: the purge
	// deletes transactions BEFORE categories. Category deliberately does not cascade to parts, so
	// the reverse order would fail on the foreign key for every account that has ever used a
	// répartition — on a real engine, during a restore, with the user's data already deleted.
	it('never purges parts directly, and deletes transactions before categories', async () => {
		expect.assertions(3);

		await restoreBackup('user-a', buildSplitRestorePayload());

		expect(db.prisma.transactionSplit.deleteMany).not.toHaveBeenCalled();

		const transactionPurge = db.prisma.transaction.deleteMany.mock.invocationCallOrder[0];
		const categoryPurge = db.prisma.category.deleteMany.mock.invocationCallOrder[0];
		expect(transactionPurge).toBeDefined();
		expect(transactionPurge).toBeLessThan(categoryPurge);
	});

	// THE SUM IS NOT THE WHOLE INVARIANT, and this fixture is the proof: −130,00 € and +50,00 €
	// under a −80,00 € parent sum EXACTLY, count 2, both categories present, so every other check
	// in assertReferentialIntegrity passes. Measured on a real instance before the guard existed:
	// the restore was accepted and /reports expenseCents went 21450 → 31450, because every
	// per-category reader takes Math.abs(allocation.amountCents) and Σ|parts| is 180,00 € for an
	// 80,00 € transaction.
	//
	// The REASON is asserted, not merely that a refusal happened: the sum and count checks stand
	// one line away and refuse plenty of neighbouring payloads, so a test that only asserted
	// "rejected" could not tell this guard from either of them — and if the sum check were the one
	// firing, the user would be told their parts do not add up, which is false and sends them
	// looking at the wrong number.
	it('refuses a part whose sign is opposite the parent, even though the parts sum exactly', async () => {
		expect.assertions(3);

		const payload = buildSplitRestorePayload();
		payload.transactionSplits[0].amountCents = -13_000;
		payload.transactionSplits[1].amountCents = 5_000;
		expect(
			payload.transactionSplits[0].amountCents + payload.transactionSplits[1].amountCents
		).toBe(payload.transactions[0].amountCents);

		await expect(restoreBackup('user-a', payload)).rejects.toThrow(
			m.settings_backup_error_split_amount({ id: 'file-tx-1' })
		);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	// Zero is reachable through the real parse path — the zod schema's `int()` accepts it — and it
	// allocates money to a category while saying nothing about where any went.
	it('refuses a zero-valued part, naming the transaction', async () => {
		expect.assertions(2);

		const payload = buildSplitRestorePayload();
		payload.transactionSplits[0].amountCents = -8_000;
		payload.transactionSplits[1].amountCents = 0;

		await expect(restoreBackup('user-a', payload)).rejects.toThrow(
			m.settings_backup_error_split_amount({ id: 'file-tx-1' })
		);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	// THE POSITIVE CONTROL, and it is an INCOME, deliberately. A sign rule refusing everything is
	// indistinguishable from a sign rule working, and the sign that would have gone untested is the
	// one an expense-shaped fixture never reaches. A salary split across two categories is a legal
	// répartition and must still restore.
	it('restores an income répartition whose parts are all positive', async () => {
		expect.assertions(2);

		const payload = buildSplitRestorePayload();
		// The builder's `type` is a literal 'expense', so widening it here is what lets the parent
		// be a coherent income rather than a positive expense.
		const parent = payload.transactions[0] as { amountCents: number; type: string };
		parent.amountCents = 8_000;
		parent.type = 'income';
		payload.transactionSplits[0].amountCents = 6_000;
		payload.transactionSplits[1].amountCents = 2_000;

		await restoreBackup('user-a', payload);

		const restored = db.store.transactionSplits.filter((row) => row.userId === 'user-a');
		expect(restored).toHaveLength(2);
		expect(restored.reduce((sum, row) => sum + (row.amountCents as number), 0)).toBe(8_000);
	});

	it('refuses a negative part under a positive parent, the mirror of the expense case', async () => {
		expect.assertions(2);

		const payload = buildSplitRestorePayload();
		const parent = payload.transactions[0] as { amountCents: number; type: string };
		parent.amountCents = 8_000;
		parent.type = 'income';
		payload.transactionSplits[0].amountCents = 13_000;
		payload.transactionSplits[1].amountCents = -5_000;

		await expect(restoreBackup('user-a', payload)).rejects.toThrow(
			m.settings_backup_error_split_amount({ id: 'file-tx-1' })
		);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});
});

describe('transaction splits — the upper bound, which inspection alone had covered', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
		db.store.users.push({ id: 'user-a', email: 'a@example.test' });
	});

	// The lower bound (a single part) was tested; this one was not, and a check that has never
	// been seen to fail is not yet a check. Twenty-one parts summing exactly to the parent, so
	// nothing but the count can refuse it.
	it('refuses more parts than any write path can produce, even when they sum exactly', async () => {
		expect.assertions(2);

		const payload = buildTagRestorePayload();
		payload.categories = [{ id: 'file-cat-1', name: 'Alimentation' }];
		payload.transactions[0].amountCents = -2100;
		payload.transactionSplits = Array.from({ length: 21 }, (_, index) => ({
			id: `file-split-${index}`,
			transactionId: payload.transactions[0].id,
			categoryId: 'file-cat-1',
			amountCents: -100,
			position: index,
			note: null
		}));

		await expect(restoreBackup('user-a', payload)).rejects.toBeInstanceOf(BackupImportError);
		expect(db.store.transactions.filter((row) => row.userId === 'user-a')).toHaveLength(0);
	});

	it('accepts exactly the ceiling, so the bound refuses nothing legal', async () => {
		expect.assertions(2);

		const payload = buildTagRestorePayload();
		payload.categories = [{ id: 'file-cat-1', name: 'Alimentation' }];
		payload.transactions[0].amountCents = -2000;
		payload.transactionSplits = Array.from({ length: 20 }, (_, index) => ({
			id: `file-split-${index}`,
			transactionId: payload.transactions[0].id,
			categoryId: 'file-cat-1',
			amountCents: -100,
			position: index,
			note: null
		}));

		await restoreBackup('user-a', payload);

		const restored = db.store.transactionSplits.filter((row) => row.userId === 'user-a');
		expect(restored).toHaveLength(20);
		expect(restored.reduce((sum, row) => sum + (row.amountCents as number), 0)).toBe(-2000);
	});
});

/**
 * THE SEAM: a real export must satisfy the validator its own restore runs.
 *
 * `buildBackupExport` and `restoreBackup` are both heavily tested above, and neither test touches
 * the other's half. Every restore test in this file, and the real-database one in
 * `volume.db-smoke.ts`, builds its payload BY HAND; `schema-properties.spec.ts` seeds from
 * `schema.spec.ts`'s fixture and says so. So the exporter's output has never been handed to the
 * schema, and the schema has never been handed anything the exporter produced.
 *
 * The type system pins the SHAPE and cannot pin the VALUES. `BackupExport` is
 * `z.infer<typeof backupExportSchema>` and `buildBackupExport` returns it, so a missing key or a
 * wrong type fails `npm run check`. The bounds are not types: `.min(1)`, `.max(191)`,
 * `.length(64)` on a fingerprint, and the two `superRefine` ceilings that read a sibling key are
 * all runtime facts about values, and nothing compares them against what the write paths permit.
 *
 * The repository already knows this class. `MAX_ANCHOR_IDS` in schema.ts exists because a remapped
 * anchor cell can grow past what was validated on the way in and "leave through an export that
 * never runs this schema, and be rejected on the way back in, the user is told their own export is
 * corrupt". That is one column, reasoned about by hand. This is the general case.
 *
 * Seeded AT the bounds rather than with tidy values, because a fixture of short strings would pass
 * against a schema bounded at anything. 191 is MAX_PORTABLE_STRING, the narrowest width any
 * provider gives a String column, and it is the number a write path would have to exceed for a
 * user's own export to become unrestorable.
 *
 * SEEN RED BEFORE BEING TRUSTED, and the two attempts are both worth recording.
 *
 * With `MAX_PORTABLE_STRING` narrowed by one, to 190, this fails naming 18 fields `too_big`. That
 * is the class it guards: the validator's bounds and the values a supported engine can legally
 * store, disagreeing.
 *
 * The FIRST break attempt was dropping a `toISOString()` from export.ts, and it stayed green. That
 * is correct rather than a gap in this test: `JSON.stringify` serializes a Date to an ISO string,
 * the export route stringifies before the file is written, and the restore parses JSON, so the
 * production path is genuinely immune to it. A break that reddens nothing because the defect
 * cannot reach the user is a break aimed at the wrong thing.
 */
describe('the export and restore seam', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
	});

	/**
	 * 191 as a LITERAL, deliberately not `MAX_PORTABLE_STRING`.
	 *
	 * The first version of this helper derived its length from the schema's own constant, and was
	 * unfalsifiable: narrowing the bound narrowed the fixture with it, so the test stayed green
	 * through the exact change it exists to catch. Measured, not reasoned about: with the constant
	 * lowered to 190 the suite reported 0 failed.
	 *
	 * 191 is a fact about MySQL, not about this schema. It is `varchar(191)`, the narrowest width
	 * any supported provider gives a String column with no native-type override, so it is what a
	 * row legally written on any engine may hold. The claim under test is that such a row survives
	 * an export and is accepted on the way back in, which is a claim about the DATABASE and the
	 * VALIDATOR agreeing. Expressing the fixture in the validator's own terms would have made it
	 * agree with itself.
	 */
	const atBound = (prefix: string) => prefix + 'x'.repeat(191 - prefix.length);

	function seedAccountAtTheBounds() {
		db.store.users.push({ id: 'user-a', email: 'a@example.test' });
		db.store.netWorthAccounts.push({
			id: 'nwa-1',
			userId: 'user-a',
			name: atBound('patrimoine-'),
			type: 'savings',
			balanceCents: 250_000,
			deletedAt: new Date('2026-03-01T12:00:00.000Z')
		});
		db.store.netWorthSnapshots.push({
			id: 'snap-1',
			userId: 'user-a',
			accountId: 'nwa-1',
			type: 'savings',
			balanceCents: 240_000,
			capturedAt: new Date('2026-05-01T12:00:00.000Z')
		});
		db.store.savingsGoals.push({
			id: 'goal-1',
			userId: 'user-a',
			name: atBound('objectif-'),
			targetAmountCents: 300_000,
			netWorthAccountId: 'nwa-1',
			currentAmountCents: 250_000,
			startingBalanceCents: 100_000,
			targetDate: new Date('2026-12-01T00:00:00.000Z'),
			reachedAt: null,
			reachedBannerDismissedAt: null,
			deletedAt: null
		});
		db.store.bankConnections.push({
			id: 'conn-1',
			userId: 'user-a',
			provider: atBound('provider-'),
			status: 'active',
			aspspName: 'Banque',
			aspspCountry: 'FR',
			consentExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
			lastSyncAt: new Date('2026-08-01T00:00:00.000Z')
		});
		db.store.accounts.push({
			id: 'acc-1',
			userId: 'user-a',
			name: atBound('compte-'),
			currency: 'EUR',
			source: atBound('source-'),
			netWorthAccountId: 'nwa-1',
			bankConnectionId: 'conn-1',
			providerAccountId: 'p'.repeat(500),
			providerCashAccountType: 'CACC'
		});
		db.store.categories.push(
			{ id: 'cat-1', userId: 'user-a', name: atBound('categorie-') },
			{ id: 'cat-2', userId: 'user-a', name: 'Loisirs' }
		);
		db.store.importBatches.push({
			id: 'batch-1',
			userId: 'user-a',
			source: atBound('src-'),
			fileName: 'f'.repeat(500),
			profile: atBound('profil-'),
			rowCount: 2,
			importedRows: 2,
			duplicateRows: 0,
			invalidRows: 0,
			periodStart: new Date('2026-01-01T00:00:00.000Z'),
			periodEnd: new Date('2026-01-31T00:00:00.000Z')
		});
		db.store.columnMappings.push({
			id: 'map-1',
			userId: 'user-a',
			fingerprint: 'a'.repeat(64),
			matchBy: 'name',
			dateColumn: 'd'.repeat(120),
			labelColumn: 'libelle',
			amountColumn: 'montant',
			categoryColumn: null,
			dateIndex: null,
			labelIndex: null,
			amountIndex: null,
			categoryIndex: null,
			columnCount: 4,
			useCount: 3
		});
		db.store.transactions.push({
			id: 'tx-1',
			userId: 'user-a',
			accountId: 'acc-1',
			categoryId: 'cat-1',
			importBatchId: 'batch-1',
			date: new Date('2026-01-15T00:00:00.000Z'),
			label: 'l'.repeat(2000),
			amountCents: -1_037,
			type: 'expense',
			source: atBound('src-'),
			notes: 'n'.repeat(10_000),
			bankOperationType: 'b'.repeat(500),
			manualCategory: atBound('manuelle-'),
			natureManual: 'spending',
			dedupeKey: 'd'.repeat(500),
			metadataJson: '{}'
		});
		// `userId` and `categoryOwnerId` are the fake's stand-ins for the two relation filters the
		// export scopes through (`transaction: { userId }` and `category: { userId }`). A row
		// without them is invisible to the export, which reads as "no parts" rather than as a
		// broken fixture.
		db.store.transactionSplits.push(
			{
				id: 'split-1',
				userId: 'user-a',
				categoryOwnerId: 'user-a',
				transactionId: 'tx-1',
				categoryId: 'cat-1',
				amountCents: -600,
				position: 0,
				note: atBound('note-')
			},
			{
				id: 'split-2',
				userId: 'user-a',
				categoryOwnerId: 'user-a',
				transactionId: 'tx-1',
				categoryId: 'cat-2',
				amountCents: -437,
				position: 1,
				note: null
			}
		);
		db.store.tags.push({
			id: 'tag-1',
			userId: 'user-a',
			name: atBound('tag-'),
			colorToken: 'clay' as TagColorToken
		});
		db.store.transactionTags.push({
			id: 'link-1',
			userId: 'user-a',
			transactionId: 'tx-1',
			tagId: 'tag-1'
		});
		db.store.monthlyBudgets.push({
			id: 'budget-1',
			userId: 'user-a',
			categoryName: atBound('categorie-'),
			amountCents: 30_000
		});
		db.store.categoryRules.push({
			id: 'rule-1',
			userId: 'user-a',
			name: atBound('regle-'),
			matchText: 'm'.repeat(500),
			targetCategory: atBound('cible-'),
			targetNature: 'spending',
			enabled: true
		});
		db.store.categorizationRules.push({
			id: 'legacy-1',
			userId: 'user-a',
			pattern: 'p'.repeat(500),
			targetCategory: atBound('cible-'),
			type: 'expense',
			active: true
		});
		db.store.categoryNatureMappings.push({
			id: 'nature-1',
			userId: 'user-a',
			categoryName: atBound('categorie-'),
			nature: 'spending'
		});
		db.store.recurringStreamActions.push({
			id: 'action-1',
			userId: 'user-a',
			kind: 'IGNORE',
			direction: 'expense',
			normalizedLabel: atBound('label-'),
			label: atBound('Label-'),
			anchorTransactionIds: JSON.stringify(['tx-1']),
			dueDate: null,
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			updatedAt: new Date('2026-01-02T00:00:00.000Z')
		});
	}

	it('produces an export that its own restore validator accepts', async () => {
		expect.assertions(2);
		seedAccountAtTheBounds();

		const exported = await buildBackupExport('user-a');
		// Through JSON, because that is what the file is. A Date surviving in memory and failing
		// only once serialized is exactly the regression this guards.
		const onTheWire = JSON.parse(JSON.stringify(exported));
		const parsed = backupExportSchema.safeParse(onTheWire);

		// The issues are in the message so a failure names the field rather than saying "false".
		expect(
			parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.code}`)
		).toEqual([]);
		expect(parsed.success).toBe(true);
	});

	it('restores the export it just produced into another account, intact', async () => {
		expect.assertions(4);
		seedAccountAtTheBounds();
		// Restored into a DIFFERENT user, which is what a backup is actually for: moving an account
		// to another instance. It also keeps the fake honest. Restoring over `user-a` would rely on
		// the purge removing the seeded parts, and the real purge does not delete them directly at
		// all: it has no `transactionSplit.deleteMany` because the rows cascade from Transaction,
		// and the fake models no cascades. Asserting through that would be asserting the fake.
		db.store.users.push({ id: 'user-b', email: 'b@example.test' });

		const exported = await buildBackupExport('user-a');
		const parsed = backupExportSchema.safeParse(JSON.parse(JSON.stringify(exported)));
		if (!parsed.success) throw new Error('the export did not validate, see the test above');

		await restoreBackup('user-b', parsed.data);
		const reExported = await buildBackupExport('user-b');

		// The seeded account is untouched, so a restore that wrote into the wrong user is visible
		// here rather than only as a missing row over there.
		expect((await buildBackupExport('user-a')).transactions).toHaveLength(1);

		// ABSOLUTE figures, not `exported.length`. A relation the fake does not model would make
		// both sides empty and `0 === 0` would report a round trip that carried nothing. That is
		// not hypothetical: the first version of this test asserted the relative form, both sides
		// were empty because the fixture omitted the fake's relation columns, and it passed.
		expect(reExported.transactions).toHaveLength(1);
		expect(reExported.transactionSplits).toHaveLength(2);
		// The money invariant, which is the one a restore must never quietly break.
		const partsTotal = reExported.transactionSplits.reduce(
			(sum, part) => sum + part.amountCents,
			0
		);
		expect(partsTotal).toBe(reExported.transactions[0].amountCents);
	});
});
