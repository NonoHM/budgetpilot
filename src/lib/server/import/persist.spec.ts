import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anonymizeDetailText } from '$lib/server/transactions/anonymize';
import { hashFingerprint } from '$lib/server/import/utils/safety';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { computeDedupeKeyHash } from './dedupeKey';
import { assignDedupeKeys } from './dedupeRecompute';
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
		findUniqueOrThrow: vi.fn(),
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
	findImportBucketAccount,
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
			type: 'expense'
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
		//
		// The select carries the denomination and the provider mapping as well as the id, and
		// spelled out rather than compared against the constant the implementation uses, because
		// a test importing that constant would assert it against itself. Dropping `currency` here
		// would put an undefined into a deduplication key through the read-only lookup next door,
		// and nothing else would notice.
		expect(prismaMock.account.findFirst).toHaveBeenCalledWith({
			where: {
				userId: 'user-1',
				nameKey: computeNameKey('Compte import CSV'),
				source: 'csv'
			},
			orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
			select: {
				id: true,
				currency: true,
				exponent: true,
				providerAccountId: true,
				bankConnectionId: true
			}
		});
	});

	it('creates a new account with created: true, defaulting the denomination and links to null', async () => {
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
				exponent: 2,
				netWorthAccountId: null,
				// Create-only, like the links around it. A bucket born with a null institution keeps
				// the boot backfill's pending predicate true and makes the once-only pass run on
				// every start, so the field is written at creation rather than left to it.
				institution: null,
				bankConnectionId: null,
				providerAccountId: null,
				providerCashAccountType: null
			}
		});
	});

	it('applies netWorthAccountId/bankConnectionId/denomination when provided on creation', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce(null);
		prismaMock.account.upsert.mockResolvedValueOnce({ id: 'account-3' });

		await resolveImportBucketAccount({
			userId: 'user-1',
			name: 'Compte import CSV',
			source: 'mock_connector',
			denomination: { currency: 'USD', exponent: 2 },
			netWorthAccountId: 'nwa-1',
			bankConnectionId: 'conn-1'
		});

		expect(prismaMock.account.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					currency: 'USD',
					// The pair travels together: a caller cannot supply one without the other, and
					// this asserts the exponent lands rather than being dropped on the way through.
					exponent: 2,
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
			select: {
				id: true,
				currency: true,
				exponent: true,
				providerAccountId: true,
				bankConnectionId: true
			}
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
});

/**
 * The read-only half of the bucket resolution.
 *
 * The deduplication key carries the `Account.id` a row lands on, and `findCollidingBatch` compares
 * keys against the database BEFORE anything is written. So the collision check needs the bucket,
 * and it must not bring one into being: creating it there would make the import summary report a
 * destination-account choice as "ignored" on a run the user then cancelled, because that sentence
 * is derived from whether the bucket was created.
 *
 * One definition of each lookup, composed the same way in both entry points. Two copies of the
 * folded-name rule is how the read path and the write path quietly stop agreeing about which
 * bucket a run lands on.
 */
describe('findImportBucketAccount', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('answers with the bucket resolveImportBucketAccount would have found, folded name and all', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce({
			id: 'account-1',
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			bankConnectionId: null
		});

		const found = await findImportBucketAccount({
			userId: 'user-1',
			name: 'compte import csv',
			source: 'csv'
		});

		expect(found).toEqual({
			accountId: 'account-1',
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null,
			bankConnectionId: null
		});
		expect(prismaMock.account.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					userId: 'user-1',
					nameKey: computeNameKey('Compte import CSV'),
					source: 'csv'
				},
				orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
			})
		);
	});

	it('answers null for a bucket that does not exist, and creates nothing', async () => {
		// The whole reason this is separable, and the reason the empty answer is EXACT rather
		// than lenient: a bucket with no rows has no keys for the collision check to find.
		prismaMock.account.findFirst.mockResolvedValueOnce(null);

		const found = await findImportBucketAccount({
			userId: 'user-1',
			name: 'Compte import CSV',
			source: 'csv'
		});

		expect(found).toBe(null);
		expect(prismaMock.account.upsert).not.toHaveBeenCalled();
		expect(prismaMock.account.update).not.toHaveBeenCalled();
	});

	it('caps the name before folding it, like the resolver does', async () => {
		// A bucket created from a long provider name was stored capped, so its nameKey is the
		// capped one. Folding the uncapped name here would miss the bucket that exists, and the
		// collision check would then compare keys against an account id no row carries.
		prismaMock.account.findFirst.mockResolvedValueOnce(null);
		const longName = 'A'.repeat(200);

		await findImportBucketAccount({ userId: 'user-1', name: longName, source: 'csv' });

		expect(prismaMock.account.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ nameKey: computeNameKey('A'.repeat(120)) })
			})
		);
	});

	it('prefers the provider account mapping over the name, like the resolver does', async () => {
		prismaMock.account.findFirst.mockResolvedValueOnce({
			id: 'account-by-provider',
			currency: 'GBP',
			exponent: 2,
			providerAccountId: 'provider-acc-1',
			bankConnectionId: 'conn-1'
		});

		const found = await findImportBucketAccount({
			userId: 'user-1',
			name: 'Compte courant',
			source: 'enablebanking',
			providerAccountId: 'provider-acc-1'
		});

		expect(found?.accountId).toBe('account-by-provider');
		expect(found?.currency).toBe('GBP');
		expect(prismaMock.account.findFirst).toHaveBeenCalledTimes(1);
	});

	it('answers null when a provider account has no bucket yet, even if the NAME is taken', async () => {
		// The resolver disambiguates that name into a NEW bucket rather than reusing the one
		// holding it, so the bucket this run lands on does not exist yet. Answering with the
		// name-holder would point the collision check at another account's rows.
		prismaMock.account.findFirst.mockResolvedValueOnce(null);

		const found = await findImportBucketAccount({
			userId: 'user-1',
			name: 'Compte courant',
			source: 'enablebanking',
			providerAccountId: 'provider-acc-2'
		});

		expect(found).toBe(null);
		expect(prismaMock.account.findFirst).toHaveBeenCalledTimes(1);
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
			accountId: 'account-1',
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
			accountId: 'account-1',
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

	// THE ENFORCEMENT THAT REPLACES THE COMPILER'S.
	//
	// `ImportBatch.accountId` is NULLABLE in the datamodel, because a legacy row genuinely carries
	// null until the boot backfill reaches it. That honesty costs the enumeration a required column
	// gave for free: the typechecker no longer names every writer. So the requirement moves up one
	// level, onto `CreateImportBatchInput`, where it is still compile-time enforced for the three
	// production callers and is asserted here on the VALUE rather than on the shape.
	//
	// Asserted through the fake deliberately, and the fake is the reason this test exists at all: a
	// hand-written mock is not typechecked against the real model, so it would have accepted a
	// `create` with no `accountId` for ever while the real client refused it. The type says who
	// must pass one; this says the one they passed is the one that gets written.
	it('writes the account the caller named, so a new batch is never unfiled', async () => {
		prismaMock.importBatch.create.mockResolvedValueOnce({ id: 'batch-3' });

		await createImportBatch({
			userId: 'user-1',
			accountId: 'account-42',
			source: 'banque_populaire',
			fileName: 'releve.csv',
			profile: 'banque-populaire',
			rowCount: 1,
			invalidRows: 0,
			period: { from: null, to: null }
		});

		expect(prismaMock.importBatch.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ accountId: 'account-42' })
		});
	});
});

describe('persistImportedTransactions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The bucket every row of an import lands in. Deliberately NOT the application default: a
		// transaction takes its denomination from the account it lands in, and a euro-at-2 bucket
		// cannot tell that apart from the default.
		prismaMock.account.findUniqueOrThrow.mockResolvedValue({ currency: 'GBP', exponent: 2 });
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
						type: 'expense'
					}
				}),
				baseTransaction({
					label: 'Salaire',
					amountCents: 250050,
					metadata: {
						reference: 'REF002',
						notes: '',
						type: 'income'
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

	// The bucket's denomination, not the application default. `Account.currency` has been writable
	// to a non-euro value since bank sync existed, so stamping every imported row EUR would make
	// them positively assert something false, which is the defect the migration goes out of its way
	// to avoid for rows that already exist.
	it('denominates an imported row by the bucket it lands in', async () => {
		expect.assertions(2);

		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [
				baseTransaction({
					label: 'Corner Shop',
					amountCents: -1234,
					metadata: {
						reference: '',
						notes: '',
						type: 'expense'
					}
				})
			]
		});

		// `providerAccountId` joined this read when key construction moved here: a bank row keys
		// on the provider's per-account entry reference, scoped by that account, so the key
		// cannot be built without it.
		expect(prismaMock.account.findUniqueOrThrow).toHaveBeenCalledWith({
			where: { id: 'account-1' },
			select: { currency: true, exponent: true, providerAccountId: true }
		});
		expect(prismaMock.transaction.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ currency: 'GBP', exponent: 2 })
			})
		);
	});

	it('looks the duplicate up by hash and writes both deduplication columns', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Courses' })]
		});

		// The key is no longer handed in on the transaction: it is built here, from the row and
		// the bucket. So the expectation is built by calling the same function rather than by
		// naming a string, which is the only form that cannot drift from what was written.
		const key = assignDedupeKeys([
			{
				id: 'only',
				source: 'csv',
				accountId: 'account-1',
				date: '2026-06-01',
				label: 'Courses',
				amountCents: -4210,
				type: 'expense',
				currency: 'GBP',
				exponent: 2,
				providerAccountId: null,
				entryReference: 'REF001',
				keyed: true
			}
		]).get('only')!;

		// The raw key is kept for traceability, but the comparison runs on the hash: on an
		// accent-insensitive collation the raw one treats two different transactions as one.
		expect(prismaMock.transaction.findFirst).toHaveBeenCalledWith({
			where: { userId: 'user-1', dedupeKeyHash: computeDedupeKeyHash(key) }
		});
		expect(prismaMock.transaction.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					dedupeKey: key,
					dedupeKeyHash: computeDedupeKeyHash(key)
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

	it('leaves both deduplication columns null when the row cannot be keyed', async () => {
		// This test's original premise is gone and the replacement is deliberate. It used to say
		// "when the source provides no key", because a profile handed the key in and could hand in
		// an empty one. Keys are built here now, so every imported row gets one and no profile can
		// produce a keyless row by omission.
		//
		// What is still worth pinning is the invariant underneath: a row with no DIRECTION cannot
		// be keyed, and the two columns must then go null TOGETHER. A raw key with no hash is
		// invisible to every duplicate check, which is the import re-importing itself; a hash with
		// no raw key loses the traceability the column exists for.
		//
		// The direction is required by the type, so this is reachable only from an untyped caller
		// or a restored row. Reaching it by force is the point: the guard has to hold where the
		// type system is not there to help.
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [
				baseTransaction({
					label: 'Sans direction',
					metadata: { reference: '', notes: '', type: undefined as unknown as 'expense' }
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

	it('writes ONLY the denomination from the bucket, never the whole bucket row', async () => {
		// A runtime failure the type checker and this mocked suite both missed, caught by an e2e
		// import: the bucket read was widened to carry `providerAccountId` for the key, and
		// `persistTransaction` spreads that object into `transaction.create`. Prisma rejects an
		// unknown argument at run time and the whole import dies with
		// "Unknown argument `providerAccountId`".
		//
		// A mock cannot model a predicate it does not have, so asserting "the create succeeded"
		// is worth nothing here. The claim has to be about the KEYS of the payload.
		prismaMock.account.findUniqueOrThrow.mockResolvedValue({
			currency: 'EUR',
			exponent: 2,
			providerAccountId: 'prov-1'
		});

		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-bank',
			importBatchId: 'batch-1',
			source: 'enablebanking',
			transactions: [baseTransaction()]
		});

		const data = (prismaMock.transaction.create.mock.calls[0][0] as { data: object }).data;
		expect(data).not.toHaveProperty('providerAccountId');
		expect(data).toMatchObject({ currency: 'EUR', exponent: 2 });
	});

	it('keys every imported row, so a profile cannot produce a keyless one by omission', async () => {
		// The counterpart to the test above, and the reason its premise was removed. Under the old
		// contract a profile that forgot to set `deduplicationKey` wrote a row invisible to every
		// duplicate check, which re-imports itself on the next upload with nothing to report it.
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Une' }), baseTransaction({ label: 'Deux' })]
		});

		const written = prismaMock.transaction.create.mock.calls.map(
			(call) => (call[0] as { data: { dedupeKey: string | null } }).data.dedupeKey
		);
		expect(written.filter(Boolean)).toHaveLength(2);
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
						metadata: { reference: '', notes: '', type: 'expense' }
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

/**
 * Key construction moved from the seven parse-time call sites to here, and this block is why.
 *
 * The CSV path cannot know its `accountId` at parse time: `routes/import/+page.server.ts` derives
 * the bucket's `source` from the DETECTED profile, so the bucket is resolved after the parse and a
 * parser cannot be handed the id the key needs.
 *
 * And the ordinal has to become a property of stored rows. MEASURED
 * (`occurrenceGap.db-smoke.ts`): a profile builds its fingerprint before `validateTransaction`
 * runs, so a row refused afterwards consumes an ordinal no stored row carries, and three identical
 * rows whose middle one is refused store ordinals {0, 2}. A recompute numbering stored rows densely
 * would then change an already-stored row's key, which is exactly what the restore and the
 * migration must not do.
 */
describe('persistImportedTransactions builds the deduplication key', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		prismaMock.account.findUniqueOrThrow.mockResolvedValue({
			currency: 'EUR',
			exponent: 2,
			providerAccountId: null
		});
		prismaMock.category.findFirst.mockResolvedValue(null);
		prismaMock.transaction.findFirst.mockResolvedValue(null);
		prismaMock.category.upsert.mockImplementation(
			async ({ create }: { create: { name: string } }) => ({ id: `category-${create.name}` })
		);
		prismaMock.transaction.create.mockImplementation(
			async ({ data }: { data: { label: string } }) => ({ id: `tx-${data.label}` })
		);
		prismaMock.importBatch.update.mockResolvedValue({});
		applyCategoryRulesMock.mockResolvedValue(0);
		replaceSplitsMock.mockResolvedValue({ ok: true });
	});

	/** Every `dedupeKey` this run wrote, in the order the rows were written. */
	function writtenKeys(): Array<string | null> {
		return prismaMock.transaction.create.mock.calls.map(
			(call) => (call[0] as { data: { dedupeKey: string | null } }).data.dedupeKey
		);
	}

	it('writes the key the recompute would give the row it just wrote', async () => {
		// The single claim that makes the migration and the restore affordable: import and
		// recompute are the same function, so they cannot disagree. The expectation is BUILT by
		// calling the recompute over the row as stored, never by retyping the string: a retyped
		// oracle asserts the copy.
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [baseTransaction({ label: 'Café Fictif', amountCents: -250 })]
		});

		const expected = assignDedupeKeys([
			{
				id: 'only',
				source: 'csv',
				accountId: 'account-1',
				date: '2026-06-01',
				label: 'Café Fictif',
				amountCents: -250,
				type: 'expense',
				currency: 'EUR',
				exponent: 2,
				providerAccountId: null,
				entryReference: null,
				keyed: true
			}
		]).get('only');

		expect(writtenKeys()).toEqual([expected]);
	});

	it('numbers two identical rows in one file 0 and 1', async () => {
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [
				baseTransaction({ label: 'Café Fictif', amountCents: -250 }),
				baseTransaction({ label: 'Café Fictif', amountCents: -250 })
			]
		});

		const keys = writtenKeys();
		expect(keys[0]).not.toBe(keys[1]);
		expect(keys.map((key) => key?.split('|').at(-1))).toEqual(['0', '1']);
	});

	it('does not let a row refused after parsing consume an ordinal', async () => {
		// The ordinal is now handed out over the rows BEING WRITTEN, so a row the parser reached
		// and refused is simply not here and cannot shift the row beside it. Refused rows never
		// reach this function, so the fixture is the two survivors, and the claim is that the
		// second is ordinal 1 rather than the 2 the parse-time counter gave it.
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'csv',
			transactions: [
				baseTransaction({ label: 'Café Fictif', amountCents: -250 }),
				baseTransaction({ label: 'Café Fictif', amountCents: -250 })
			]
		});

		expect(writtenKeys().map((key) => key?.split('|').at(-1))).toEqual(['0', '1']);
	});

	it('gives a bank row with an entry reference the provider key and no ordinal', async () => {
		prismaMock.account.findUniqueOrThrow.mockResolvedValue({
			currency: 'EUR',
			exponent: 2,
			providerAccountId: 'prov-1'
		});

		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-bank',
			importBatchId: 'batch-1',
			source: 'enablebanking',
			transactions: [
				baseTransaction({
					label: 'Supérette Générale',
					amountCents: -250,
					metadata: { reference: 'E42', notes: '', type: 'expense' }
				})
			]
		});

		expect(writtenKeys()).toEqual(['v3|enablebanking|prov-1|E42']);
	});

	it('folds a bank row without an entry reference the way the connector folded it', async () => {
		// The source-conditional fold, at the write path. enablebanking strips accents before
		// keying while storing the raw label, so a recompute of this row must reach the same
		// string. A CSV-only fixture measures an identity here and can never fail.
		prismaMock.account.findUniqueOrThrow.mockResolvedValue({
			currency: 'EUR',
			exponent: 2,
			providerAccountId: 'prov-1'
		});

		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-bank',
			importBatchId: 'batch-1',
			source: 'enablebanking',
			transactions: [
				baseTransaction({
					label: 'Supérette Générale',
					amountCents: -250,
					metadata: { reference: '', notes: '', type: 'expense' }
				})
			]
		});

		expect(writtenKeys()[0]).toContain('superette generale');
	});

	it('takes the source the rows will be STORED with, not the one the parser put on them', async () => {
		// A Revolut file parses into transactions carrying `source: 'csv'` while the batch stores
		// them as 'revolut'. The recompute reads the STORED value, so the key must be built from
		// it or the two would disagree on every Revolut row.
		await persistImportedTransactions({
			userId: 'user-1',
			accountId: 'account-1',
			importBatchId: 'batch-1',
			source: 'revolut',
			transactions: [baseTransaction({ label: 'Tesco', amountCents: -1230, source: 'csv' })]
		});

		const created = prismaMock.transaction.create.mock.calls[0][0] as {
			data: { source: string; dedupeKey: string };
		};
		expect(created.data.source).toBe('revolut');
		expect(created.data.dedupeKey).toBe(
			assignDedupeKeys([
				{
					id: 'only',
					source: 'revolut',
					accountId: 'account-1',
					date: '2026-06-01',
					label: 'Tesco',
					amountCents: -1230,
					type: 'expense',
					currency: 'EUR',
					exponent: 2,
					providerAccountId: null,
					entryReference: null,
					keyed: true
				}
			]).get('only')
		);
	});
});
