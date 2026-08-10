import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anonymizeDetailText } from '$lib/server/transactions/anonymize';
import { hashFingerprint } from '$lib/server/import/utils/safety';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { computeDedupeKeyHash } from './dedupeKey';
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
const replaceSplitsMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/db', () => ({ prisma: prismaMock }));
vi.mock('$lib/server/categorization/rules', () => ({
	applyCategoryRules: applyCategoryRulesMock
}));
// Mocked so this spec can state WHICH path an imported répartition takes. The claim is not "parts
// end up in the table" — a `createMany` would do that too, and would bypass the sum invariant that
// makes every per-category figure in the app add up. The claim is that the import goes through the
// service, so replacing the call with a direct write turns these tests red rather than green.
vi.mock('$lib/server/transactions/splits', () => ({
	replaceSplits: replaceSplitsMock
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
		// import announcing "compte import csv" must land on the existing bucket. Ordered
		// oldest-first because Account is the one name-keyed table with no unique constraint on
		// its key, so more than one row can match and an unordered findFirst would be free to
		// answer differently on each call under PostgreSQL.
		expect(prismaMock.account.findFirst).toHaveBeenCalledWith({
			where: {
				userId: 'user-1',
				nameKey: computeNameKey('Compte import CSV'),
				source: 'csv'
			},
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
		prismaMock.category.findFirst.mockResolvedValue(null);
		prismaMock.transaction.findFirst.mockResolvedValue(null);
		// resolveCategoryByName is one upsert keyed on the folded name.
		prismaMock.category.upsert.mockImplementation(
			async ({ create }: { create: { name: string } }) => ({
				id: `category-${create.name}`
			})
		);
		prismaMock.transaction.create.mockImplementation(
			async ({ data }: { data: { label: string } }) => ({ id: `tx-${data.label}` })
		);
		prismaMock.importBatch.update.mockResolvedValue({});
		applyCategoryRulesMock.mockResolvedValue(0);
		replaceSplitsMock.mockResolvedValue({ ok: true });
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

	it('looks the duplicate up by hash and writes both deduplication columns', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses' })]
		});

		// The raw key is kept for traceability, but the comparison runs on the hash: on an
		// accent-insensitive collation the raw one treats two different transactions as one.
		expect(prismaMock.transaction.findFirst).toHaveBeenCalledWith({
			where: { userId: 'user-1', dedupeKeyHash: computeDedupeKeyHash('dedupe-1') }
		});
		expect(prismaMock.transaction.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					dedupeKey: 'dedupe-1',
					dedupeKeyHash: computeDedupeKeyHash('dedupe-1')
				})
			})
		);
	});

	it('skips the row whose hash already exists, without creating anything', async () => {
		prismaMock.transaction.findFirst.mockResolvedValueOnce({ id: 'existing' });

		const result = await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses' })]
		});

		expect(result.duplicateRows).toBe(1);
		expect(prismaMock.transaction.create).not.toHaveBeenCalled();
	});

	it('leaves both deduplication columns null when the source provides no key', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [
				baseTransaction({
					label: 'Sans cle',
					metadata: { reference: '', notes: '', type: 'expense', deduplicationKey: '' }
				})
			]
		});

		expect(prismaMock.transaction.findFirst).not.toHaveBeenCalled();
		expect(prismaMock.transaction.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ dedupeKey: null, dedupeKeyHash: null })
			})
		);
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

	it('counts a P2002 as a duplicate when a row carrying the same hash does exist', async () => {
		const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
		prismaMock.transaction.create.mockRejectedValueOnce(p2002);
		// Pre-check finds nothing, then a concurrent request inserts the same row before this
		// one lands: an ordinary race, and the row genuinely is a duplicate.
		prismaMock.transaction.findFirst.mockResolvedValueOnce(null);
		prismaMock.transaction.findFirst.mockResolvedValueOnce({ id: 'inserted-meanwhile' });

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

	it('rethrows a P2002 that no row with the same hash explains, rather than dropping the row', async () => {
		const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
		prismaMock.transaction.create.mockRejectedValueOnce(p2002);
		// Nothing carries this hash before or after the conflict, so the constraint rejected a
		// transaction the app considers new: the database's equality disagrees with ours, which
		// is what an accent-insensitive collation or a prefix-only index does. Counting it as a
		// duplicate would drop a real transaction and say nothing.
		prismaMock.transaction.findFirst.mockResolvedValue(null);

		await expect(
			persistImportedTransactions({
				userId: 'user-1',
				accountId: 'account-1',
				importBatchId: 'batch-1',
				source: 'csv',
				transactions: [baseTransaction({ label: 'Courses' })]
			})
		).rejects.toThrow('Unique constraint failed');
	});

	it('rethrows a P2002 on a row carrying no deduplication key, rather than calling it a duplicate', async () => {
		const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
		prismaMock.transaction.create.mockRejectedValueOnce(p2002);

		// No key means no hash, and a NULL never conflicts on @@unique([userId, dedupeKeyHash])
		// on any provider. So this conflict is a constraint the code did not anticipate, and
		// counting it as a duplicate would drop a real transaction and report it as one the user
		// already had.
		await expect(
			persistImportedTransactions({
				userId: 'user-1',
				accountId: 'account-1',
				importBatchId: 'batch-1',
				source: 'csv',
				transactions: [
					baseTransaction({
						label: 'Sans cle',
						metadata: { reference: '', notes: '', type: 'expense', deduplicationKey: '' }
					})
				]
			})
		).rejects.toBe(p2002);
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

	it('resolves the category with a single upsert on the folded key', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses', category: 'Alimentation' })]
		});

		// One upsert keyed on the folded name, so an import announcing "alimentation" reuses an
		// existing "Alimentation" instead of creating a second category, and two concurrent
		// imports of a new one cannot both insert. `update` is empty: an existing category keeps
		// the spelling the user chose.
		expect(prismaMock.category.upsert).toHaveBeenCalledWith({
			where: {
				userId_nameKey: { userId: 'user-1', nameKey: computeNameKey('Alimentation') }
			},
			update: {},
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

	describe('an imported répartition', () => {
		function importSplit(splitParts: Array<{ category: string; amountCents: number }> | undefined) {
			return persistImportedTransactions({
				userId: 'user-1',
				accountId: 'account-1',
				importBatchId: 'batch-1',
				source: 'csv',
				transactions: [baseTransaction({ label: 'Leroy Merlin', amountCents: -8000, splitParts })]
			});
		}

		it('goes through replaceSplits, resolving each part’s category by NAME', async () => {
			expect.assertions(2);

			await importSplit([
				{ category: 'Bricolage', amountCents: -5000 },
				{ category: 'Jardin', amountCents: -3000 }
			]);

			expect(replaceSplitsMock).toHaveBeenCalledTimes(1);
			expect(replaceSplitsMock.mock.calls[0][2]).toEqual([
				{ categoryId: 'category-Bricolage', amountCents: 5000 },
				{ categoryId: 'category-Jardin', amountCents: 3000 }
			]);
		});

		/**
		 * The magnitudes above are the whole test, not a detail of it.
		 *
		 * `persistTransaction` stores `Math.abs(amountCents)` on the parent and puts the direction in
		 * `type`, while `replaceSplits` requires every part to carry the PARENT ROW's sign. Passing
		 * the file's signed amounts through unchanged sums to −80,00 € against a stored +80,00 €
		 * parent and is refused — on every expense, which is most of what anyone imports.
		 */
		it('is refused loudly rather than imported without its parts', async () => {
			expect.assertions(1);

			replaceSplitsMock.mockResolvedValue({ ok: false, reason: 'sum' });

			await expect(
				importSplit([
					{ category: 'Bricolage', amountCents: -5000 },
					{ category: 'Jardin', amountCents: -3000 }
				])
			).rejects.toThrow(/replaceSplits: sum/);
		});

		/**
		 * ORDER, not merely both calls. `applyCategoryRules` deliberately skips a row that has parts
		 * (`splits: { none: {} }`), which protects an imported répartition only for as long as the
		 * parts are already there when the rules run. Write them afterwards and every rule is free to
		 * overwrite the parent's category on exactly the transactions D1 says it must not touch — and
		 * a test asserting only that both functions were called would report that as working.
		 */
		it('writes the parts BEFORE the rules engine gets to see the row', async () => {
			expect.assertions(1);

			const order: string[] = [];
			replaceSplitsMock.mockImplementation(async () => {
				order.push('splits');
				return { ok: true };
			});
			applyCategoryRulesMock.mockImplementation(async () => {
				order.push('rules');
				return 0;
			});

			await importSplit([
				{ category: 'Bricolage', amountCents: -5000 },
				{ category: 'Jardin', amountCents: -3000 }
			]);

			expect(order).toEqual(['splits', 'rules']);
		});

		it('leaves the service untouched for an ordinary row', async () => {
			expect.assertions(2);

			const result = await importSplit(undefined);

			expect(result.importedRows).toBe(1);
			expect(replaceSplitsMock).not.toHaveBeenCalled();
		});
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
