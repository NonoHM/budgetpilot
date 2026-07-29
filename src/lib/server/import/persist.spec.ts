import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anonymizeDetailText } from '$lib/server/transactions/anonymize';
import { hashFingerprint } from '$lib/server/import/utils/safety';
import { computeNameKey } from '$lib/server/naming/nameKey';
import type { ImportedTransaction } from './types';

/**
 * Isolated unit tests for the shared import persistence module (bank-sync step 3
 * extraction). Prisma is mocked with plain vi.fn()s (not a fake in-memory DB) so each
 * test can assert exactly which call happened with which args — applyCategoryRules is
 * mocked too, so this spec never exercises the real rules engine.
 */
const prismaMock = vi.hoisted(() => ({
	account: {
		findUnique: vi.fn(),
		findFirst: vi.fn(),
		update: vi.fn(),
		upsert: vi.fn()
	},
	importBatch: {
		create: vi.fn(),
		update: vi.fn()
	},
	category: {
		findFirst: vi.fn(),
		upsert: vi.fn()
	},
	transaction: {
		findFirst: vi.fn(),
		create: vi.fn()
	}
}));

const applyCategoryRulesMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ prisma: prismaMock }));
vi.mock('$lib/server/categorization/rules', () => ({
	applyCategoryRules: applyCategoryRulesMock
}));

const {
	anonymizeImportCell,
	resolveImportBucketAccount,
	createImportBatch,
	persistImportedTransactions
} = await import('./persist');

function baseTransaction(overrides: Partial<ImportedTransaction> = {}): ImportedTransaction {
	return {
		id: 'ignored',
		date: '2026-06-01',
		label: 'Courses Auchan',
		amountCents: -4210,
		category: 'Alimentation',
		source: 'csv',
		metadata: {
			reference: 'REF001',
			notes: '',
			type: 'expense',
			deduplicationKey: 'dedupe-1'
		},
		...overrides
	} as ImportedTransaction;
}

describe('resolveImportBucketAccount', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// resolveCategoryByName probes for an existing folded match before upserting.
		prismaMock.category.findFirst.mockResolvedValue(null);
	});

	it('returns the existing account with created: false and never calls upsert', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce({ id: 'account-1' });

		const result = await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte import CSV',
			source: 'csv'
		});

		expect(result).toEqual({ accountId: 'account-1', created: false });
		expect(prismaMock.account.upsert).not.toHaveBeenCalled();
		// Matched on the folded name key, not on the raw (userId, name, source) tuple: an
		// import announcing "compte import csv" must land on the existing bucket.
		expect(prismaMock.account.findFirst).toHaveBeenCalledWith({
			where: {
				userId: 'user-1',
				nameKey: computeNameKey('Compte import CSV'),
				source: 'csv'
			},
			select: { id: true }
		});
	});

	it('creates a new account with created: true, defaulting currency to EUR and links to null', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce(null);
		prismaMock.account.upsert.mockResolvedValueOnce({ id: 'account-2' });

		const result = await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte import CSV',
			source: 'csv'
		});

		expect(result).toEqual({ accountId: 'account-2', created: true });
		expect(prismaMock.account.upsert).toHaveBeenCalledWith({
			where: {
				userId_name_source: { userId: 'user-1', name: 'Compte import CSV', source: 'csv' }
			},
			update: {},
			create: {
				userId: 'user-1',
				name: 'Compte import CSV',
				nameKey: computeNameKey('Compte import CSV'),
				source: 'csv',
				currency: 'EUR',
				netWorthAccountId: null,
				bankConnectionId: null,
				providerAccountId: null,
				providerCashAccountType: null
			}
		});
	});

	it('applies netWorthAccountId/bankConnectionId/currency when provided on creation', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce(null);
		prismaMock.account.upsert.mockResolvedValueOnce({ id: 'account-3' });

		await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte import CSV',
			source: 'mock_connector',
			currency: 'USD',
			netWorthAccountId: 'nwa-1',
			bankConnectionId: 'conn-1'
		});

		expect(prismaMock.account.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					currency: 'USD',
					netWorthAccountId: 'nwa-1',
					bankConnectionId: 'conn-1'
				})
			})
		);
	});

	it('resolves by (userId, source, providerAccountId) first, winning over the name lookup entirely', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce({
			id: 'account-by-provider',
			bankConnectionId: 'conn-1'
		});

		const result = await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte courant',
			source: 'enablebanking',
			providerAccountId: 'provider-acc-1'
		});

		expect(result).toEqual({ accountId: 'account-by-provider', created: false });
		expect(prismaMock.account.findFirst).toHaveBeenCalledWith({
			where: { userId: 'user-1', source: 'enablebanking', providerAccountId: 'provider-acc-1' },
			select: { id: true, bankConnectionId: true }
		});
		// The provider lookup is the only query: the name lookup never runs.
		expect(prismaMock.account.findFirst).toHaveBeenCalledTimes(1);
		expect(prismaMock.account.upsert).not.toHaveBeenCalled();
	});

	it('relinks an orphaned bucket (bankConnectionId null after a connection delete) to the new connection', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce({
			id: 'account-orphaned',
			bankConnectionId: null
		});
		prismaMock.account.update.mockResolvedValueOnce({});

		const result = await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte courant',
			source: 'enablebanking',
			bankConnectionId: 'conn-new',
			providerAccountId: 'provider-acc-1'
		});

		expect(result).toEqual({ accountId: 'account-orphaned', created: false });
		expect(prismaMock.account.update).toHaveBeenCalledWith({
			where: { id: 'account-orphaned' },
			data: { bankConnectionId: 'conn-new' }
		});
	});

	it('never overwrites a non-null bankConnectionId link on an existing bucket', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce({
			id: 'account-linked',
			bankConnectionId: 'conn-old'
		});

		const result = await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte courant',
			source: 'enablebanking',
			bankConnectionId: 'conn-new',
			providerAccountId: 'provider-acc-1'
		});

		expect(result).toEqual({ accountId: 'account-linked', created: false });
		expect(prismaMock.account.update).not.toHaveBeenCalled();
	});

	it('creates a new bucket under the exact requested name when providerAccountId lookup misses and the name is free', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce(null);
		prismaMock.account.findFirst.mockResolvedValueOnce(null);
		prismaMock.account.upsert.mockResolvedValueOnce({ id: 'account-new' });

		await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte courant',
			source: 'enablebanking',
			providerAccountId: 'provider-acc-1'
		});

		expect(prismaMock.account.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId_name_source: {
						userId: 'user-1',
						name: 'Compte courant',
						source: 'enablebanking'
					}
				},
				create: expect.objectContaining({
					name: 'Compte courant',
					providerAccountId: 'provider-acc-1'
				})
			})
		);
	});

	it('disambiguates with a hashed suffix (never the raw provider uid) when the name is already held by another bucket', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce(null);
		prismaMock.account.findFirst.mockResolvedValueOnce({ id: 'account-existing' });
		prismaMock.account.upsert.mockResolvedValueOnce({ id: 'account-disambiguated' });

		const result = await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte courant',
			source: 'enablebanking',
			providerAccountId: 'provider-acc-secret-uid'
		});

		const expectedName = `Compte courant · ${hashFingerprint('provider-acc-secret-uid').slice(0, 6)}`;
		expect(result).toEqual({ accountId: 'account-disambiguated', created: true });
		expect(prismaMock.account.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId_name_source: { userId: 'user-1', name: expectedName, source: 'enablebanking' }
				},
				create: expect.objectContaining({
					name: expectedName,
					providerAccountId: 'provider-acc-secret-uid'
				})
			})
		);
		const createCall = prismaMock.account.upsert.mock.calls[0][0] as {
			create: { name: string };
		};
		expect(createCall.create.name).not.toContain('provider-acc-secret-uid');
	});

	it('the CSV path (no providerAccountId) skips the provider lookup and resolves by name alone', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce({ id: 'account-csv' });

		const result = await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte import CSV',
			source: 'csv'
		});

		expect(result).toEqual({ accountId: 'account-csv', created: false });
		// A single query, and it is the name one: nothing looks up a provider account for a
		// CSV import.
		expect(prismaMock.account.findFirst).toHaveBeenCalledTimes(1);
		expect(prismaMock.account.findFirst.mock.calls[0][0].where).not.toHaveProperty(
			'providerAccountId'
		);
		expect(prismaMock.account.upsert).not.toHaveBeenCalled();
	});
});

describe('createImportBatch', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// resolveCategoryByName probes for an existing folded match before upserting.
		prismaMock.category.findFirst.mockResolvedValue(null);
	});

	it('maps period ISO strings to UTC-midnight Dates and returns the created batch id', async () => {
		prismaMock.importBatch.create.mockResolvedValueOnce({ id: 'batch-1' });

		const id = await createImportBatch({
			userId: 'user-1',
			source: 'csv',
			fileName: 'export.csv',
			profile: 'generic',
			rowCount: 2,
			invalidRows: 0,
			period: { from: '2026-06-01', to: '2026-06-30' }
		});

		expect(id).toBe('batch-1');
		expect(prismaMock.importBatch.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				periodStart: new Date('2026-06-01T00:00:00.000Z'),
				periodEnd: new Date('2026-06-30T00:00:00.000Z')
			})
		});
	});

	it('maps a null period to null dates', async () => {
		prismaMock.importBatch.create.mockResolvedValueOnce({ id: 'batch-2' });

		await createImportBatch({
			userId: 'user-1',
			source: 'csv',
			fileName: 'export.csv',
			profile: 'generic',
			rowCount: 0,
			invalidRows: 0,
			period: { from: null, to: null }
		});

		expect(prismaMock.importBatch.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ periodStart: null, periodEnd: null })
		});
	});
});

describe('persistImportedTransactions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// resolveCategoryByName probes for an existing folded match before upserting.
		prismaMock.category.findFirst.mockResolvedValue(null);
		prismaMock.transaction.findFirst.mockResolvedValue(null);
		prismaMock.category.upsert.mockImplementation(
			async ({ where }: { where: { userId_name: { userId: string; name: string } } }) => ({
				id: `category-${where.userId_name.name}`
			})
		);
		prismaMock.transaction.create.mockImplementation(
			async ({ data }: { data: { label: string } }) => ({ id: `tx-${data.label}` })
		);
		prismaMock.importBatch.update.mockResolvedValue({});
		applyCategoryRulesMock.mockResolvedValue(0);
	});

	it('imports valid rows, sums debit/credit cents as absolute values, and returns their ids', async () => {
		const result = await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [
				baseTransaction({
					label: 'Courses',
					amountCents: -4210,
					metadata: {
						reference: 'REF001',
						notes: '',
						type: 'expense',
						deduplicationKey: 'dedupe-courses'
					}
				}),
				baseTransaction({
					label: 'Salaire',
					amountCents: 250050,
					metadata: {
						reference: 'REF002',
						notes: '',
						type: 'income',
						deduplicationKey: 'dedupe-salaire'
					}
				})
			]
		});

		expect(result.importedRows).toBe(2);
		expect(result.duplicateRows).toBe(0);
		expect(result.importedDebitCents).toBe(4210);
		expect(result.importedCreditCents).toBe(250050);
		expect(result.importedTransactionIds).toEqual(['tx-Courses', 'tx-Salaire']);
	});

	it('calls applyCategoryRules with the userId and the imported ids', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses' })]
		});

		expect(applyCategoryRulesMock).toHaveBeenCalledWith('user-1', {
			transactionIds: ['tx-Courses']
		});
	});

	it('updates the ImportBatch with the final importedRows/duplicateRows counters', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses' })]
		});

		expect(prismaMock.importBatch.update).toHaveBeenCalledWith({
			where: { id: 'batch-1' },
			data: { importedRows: 1, duplicateRows: 0 }
		});
	});

	it('skips a row whose metadata.deduplicationKey already exists and counts it as a duplicate', async () => {
		prismaMock.transaction.findFirst.mockResolvedValueOnce({ id: 'existing-tx' });

		const result = await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses' })]
		});

		expect(result.importedRows).toBe(0);
		expect(result.duplicateRows).toBe(1);
		expect(result.importedTransactionIds).toEqual([]);
		expect(prismaMock.transaction.create).not.toHaveBeenCalled();
	});

	it('folds parseDuplicateRows into the returned duplicateRows count', async () => {
		const result = await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [],
			parseDuplicateRows: 3
		});

		expect(result.duplicateRows).toBe(3);
		expect(result.importedRows).toBe(0);
		expect(prismaMock.importBatch.update).toHaveBeenCalledWith({
			where: { id: 'batch-1' },
			data: { importedRows: 0, duplicateRows: 3 }
		});
	});

	it('counts a P2002 unique-constraint error from transaction.create as a duplicate, not a rethrow', async () => {
		const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
		prismaMock.transaction.create.mockRejectedValueOnce(p2002);

		const result = await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses' })]
		});

		expect(result.importedRows).toBe(0);
		expect(result.duplicateRows).toBe(1);
	});

	it('rethrows any error from transaction.create that is not a P2002 unique-constraint violation', async () => {
		prismaMock.transaction.create.mockRejectedValueOnce(new Error('database is on fire'));

		await expect(
			persistImportedTransactions({
				userId: 'user-1',
				accountId: 'account-1',
				importBatchId: 'batch-1',
				source: 'csv',
				transactions: [baseTransaction({ label: 'Courses' })]
			})
		).rejects.toThrow('database is on fire');
	});

	it('resolves the category by folded name before falling back to an upsert', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses', category: 'Alimentation' })]
		});

		// The folded probe comes first, so an import announcing "alimentation" reuses an
		// existing "Alimentation" instead of creating a second category.
		expect(prismaMock.category.findFirst).toHaveBeenCalledWith({
			where: { userId: 'user-1', nameKey: computeNameKey('Alimentation') },
			select: { id: true }
		});
		expect(prismaMock.category.upsert).toHaveBeenCalledWith({
			where: { userId_name: { userId: 'user-1', name: 'Alimentation' } },
			update: { nameKey: computeNameKey('Alimentation') },
			create: { userId: 'user-1', name: 'Alimentation', nameKey: computeNameKey('Alimentation') },
			select: { id: true }
		});
	});

	it('drops a csvField not on the allowlist and anonymizes an allowlisted one', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [
				baseTransaction({
					label: 'Courses',
					metadata: {
						reference: 'REF001',
						notes: '',
						type: 'expense',
						deduplicationKey: 'dedupe-courses',
						csvFields: {
							'Libelle simplifie': 'AUCHAN 0065 SC 78MAUREPAS',
							'Not on the allowlist': 'super secret raw column'
						}
					}
				})
			]
		});

		const call = prismaMock.transaction.create.mock.calls[0][0] as {
			data: { metadataJson: string };
		};
		const metadata = JSON.parse(call.data.metadataJson) as {
			csvFields: Record<string, string>;
		};

		expect(metadata.csvFields['Not on the allowlist']).toBeUndefined();
		expect(metadata.csvFields['Libelle simplifie']).toBe(
			anonymizeDetailText('AUCHAN 0065 SC 78MAUREPAS', 18)
		);
		expect(metadata.csvFields['Libelle simplifie']).toBe('AUCHAN 0065 SC 78…');
	});
});

describe('anonymizeImportCell', () => {
	it('masks card/reference digits like anonymizeDetailText at limit 18', () => {
		const raw = '220626 CB****2593-Reference REFBAD123456789';

		expect(anonymizeImportCell(raw)).toBe(anonymizeDetailText(raw, 18));
	});

	it('truncates a long plain-text value at 18 characters with an ellipsis', () => {
		const raw = 'Restaurant du coin bien sympa sans chiffres';

		const result = anonymizeImportCell(raw);

		expect(result).toBe('Restaurant du coi…');
		expect(result.length).toBeLessThanOrEqual(18);
	});
});
