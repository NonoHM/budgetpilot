import { existsSync } from 'node:fs';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { buildDeduplicationKey } from '$lib/server/import/utils/safety';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { computeDedupeKeyHash } from '$lib/server/import/dedupeKey';
import { fingerprintFor } from '$lib/server/import/mapping/fingerprint';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportInvalidRowDetail } from './+page.server';

const db = vi.hoisted(() => {
	type Account = {
		id: string;
		userId: string;
		name: string;
		source: string;
		currency: string;
		netWorthAccountId?: string | null;
		providerAccountId?: string | null;
	};
	type NetWorthAccount = {
		id: string;
		userId: string;
		name: string;
		type: string;
		balanceCents: number;
		deletedAt: Date | null;
		createdAt: Date;
	};
	type Category = { id: string; userId: string; name: string };
	type ColumnMappingRow = {
		id: string;
		userId: string;
		fingerprint: string;
		matchBy: string;
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
		lastUsedAt: Date | null;
	};
	type ColumnMappingWhere = { userId?: string; fingerprint: { in: string[] } };
	type ColumnMappingUpdateArgs = {
		where: { id: string; userId: string };
		data: { useCount: { increment: number }; lastUsedAt: Date };
	};
	type Batch = {
		id: string;
		userId: string;
		source: string;
		fileName?: string | null;
		profile: string;
		rowCount: number;
		importedRows: number;
		duplicateRows: number;
		invalidRows: number;
		periodStart?: Date | null;
		periodEnd?: Date | null;
		// Stamped by the fake rather than by the production code, which lets Prisma default it. The
		// collision payload reports WHEN the other import happened, so a batch without one would be
		// a shape the page cannot draw.
		createdAt?: Date;
	};
	type Rule = {
		id: string;
		pattern: string;
		targetCategory: string;
		type: string | null;
		active: boolean;
		createdAt: Date;
	};
	type Transaction = {
		id: string;
		accountId: string;
		categoryId: string;
		importBatchId: string;
		userId: string;
		date: Date;
		label: string;
		amountCents: number;
		type: string;
		source: string;
		notes: string | null;
		manualCategory: string | null;
		natureManual: string | null;
		dedupeKey: string | null;
		dedupeKeyHash: string | null;
		metadataJson: string | null;
	};
	type AccountUpsertArgs = {
		where: { userId_name_source: { userId: string; name: string; source: string } };
		create: Omit<Account, 'id'>;
		update: Record<string, never>;
	};
	type BatchCreateArgs = {
		data: Partial<Omit<Batch, 'id'>> & Pick<Batch, 'userId' | 'source' | 'rowCount'>;
	};
	type CategoryUpsertArgs = {
		where: { userId_nameKey: { userId: string; nameKey: string } };
		create: Omit<Category, 'id'>;
	};
	type TransactionFindFirstArgs = { where: { userId: string; dedupeKeyHash: string } };
	type TransactionCountArgs = {
		where: { userId: string; dedupeKeyHash?: { in: string[] } };
	};
	type TransactionGroupByArgs = {
		where: { userId: string; importBatchId?: { in: string[] } };
	};
	type BatchFindManyWhere = {
		userId: string;
		periodStart?: { lte?: Date };
		periodEnd?: { gte?: Date };
	};
	type TransactionCreateArgs = {
		data: Omit<Transaction, 'id' | 'manualCategory'> & { manualCategory?: string | null };
	};

	const state = {
		accounts: [] as Account[],
		categories: [] as Category[],
		batches: [] as Batch[],
		rules: [] as Rule[],
		transactions: [] as Transaction[],
		netWorthAccounts: [] as NetWorthAccount[],
		columnMappings: [] as ColumnMappingRow[],
		nextId: 1
	};

	function id(prefix: string) {
		const value = `${prefix}-${state.nextId}`;
		state.nextId += 1;
		return value;
	}

	return {
		state,
		reset() {
			// Iterated rather than named one by one. A hand-written list is a list of what its
			// author knew about, and cleanup is where such a list is least likely to be re-read:
			// a table added to `state` and forgotten here survives into the next test, where it
			// reads as a guard that failed to fire rather than as leftover state. Measured on the
			// backup spec's fake, which had exactly this shape.
			for (const value of Object.values(state)) {
				if (Array.isArray(value)) value.length = 0;
			}
			state.nextId = 1;
		},
		prisma: {
			netWorthAccount: {
				findMany: vi.fn(async ({ where }: { where: { userId: string; deletedAt: null } }) =>
					state.netWorthAccounts
						.filter((account) => account.userId === where.userId && account.deletedAt === null)
						.map((account) => ({ ...account, updatedAt: account.createdAt }))
				)
			},
			account: {
				upsert: vi.fn(async ({ where, create }: AccountUpsertArgs) => {
					const found = state.accounts.find(
						(account) =>
							account.userId === where.userId_name_source.userId &&
							account.name === where.userId_name_source.name &&
							account.source === where.userId_name_source.source
					);
					if (found) return found;
					const account = { id: id('account'), ...create };
					state.accounts.push(account);
					return account;
				}),
				findMany: vi.fn(
					async ({
						where
					}: {
						where: { userId: string; name: string; source: { in: string[] } };
					}) =>
						state.accounts.filter(
							(account) =>
								account.userId === where.userId &&
								account.name === where.name &&
								where.source.in.includes(account.source)
						)
				),
				findUnique: vi.fn(
					async ({
						where
					}: {
						where: { userId_name_source: { userId: string; name: string; source: string } };
					}) =>
						state.accounts.find(
							(account) =>
								account.userId === where.userId_name_source.userId &&
								account.name === where.userId_name_source.name &&
								account.source === where.userId_name_source.source
						) ?? null
				),
				// Two distinct lookups share findFirst: the bank-sync one keyed on
				// providerAccountId, and the bucket-name one keyed on the folded nameKey.
				findFirst: vi.fn(
					async ({
						where
					}: {
						where: {
							userId: string;
							source: string;
							nameKey?: string;
							providerAccountId?: string;
						};
					}) =>
						state.accounts.find(
							(account) =>
								account.userId === where.userId &&
								account.source === where.source &&
								(where.nameKey === undefined
									? true
									: computeNameKey(account.name) === where.nameKey) &&
								(where.providerAccountId === undefined
									? true
									: account.providerAccountId === where.providerAccountId)
						) ?? null
				)
			},
			importBatch: {
				/**
				 * The candidate lookup for the collision check (server/import/collision.ts).
				 *
				 * Modelled rather than stubbed, because a stub returning `[]` would make every
				 * collision test pass by never finding a candidate, which is the "fake that cannot
				 * model the predicate" failure this file's rules warn about. The period clause is
				 * applied here exactly as the real query states it, so removing it from the production
				 * code changes what this fake returns.
				 */
				findMany: vi.fn(async ({ where }: { where: BatchFindManyWhere }) =>
					state.batches
						.filter((batch) => batch.userId === where.userId)
						.filter((batch) => batch.periodStart !== null && batch.periodEnd !== null)
						.filter((batch) =>
							where.periodStart?.lte
								? new Date(batch.periodStart as unknown as string) <= where.periodStart.lte
								: true
						)
						.filter((batch) =>
							where.periodEnd?.gte
								? new Date(batch.periodEnd as unknown as string) >= where.periodEnd.gte
								: true
						)
						.map((batch) => ({
							id: batch.id,
							fileName: batch.fileName,
							createdAt: batch.createdAt ?? new Date(0),
							periodStart: new Date(batch.periodStart as unknown as string),
							periodEnd: new Date(batch.periodEnd as unknown as string)
						}))
				),
				create: vi.fn(async ({ data }: BatchCreateArgs) => {
					const batch = {
						id: id('batch'),
						fileName: null,
						profile: 'generic',
						importedRows: 0,
						duplicateRows: 0,
						invalidRows: 0,
						periodStart: null,
						periodEnd: null,
						// Ordered by the fake so two batches created in one test are distinguishable, and
						// present at all because the collision payload reports when the other run happened.
						createdAt: new Date(Date.UTC(2026, 0, 1 + state.batches.length)),
						...data
					};
					state.batches.push(batch);
					return batch;
				}),
				update: vi.fn(async ({ where, data }) => {
					const batch = state.batches.find((item) => item.id === where.id);
					if (!batch) throw new Error('batch not found');
					Object.assign(batch, data);
					return batch;
				})
			},
			categorizationRule: {
				findMany: vi.fn(async () => state.rules.filter((rule) => rule.active))
			},
			// A fake that NARROWS on a predicate it does not model, never one that approximates it.
			// A `where` this does not understand throws, because a fake that silently ignores a
			// clause makes every assertion about scoping pass vacuously, and the clause being
			// ignored here would be `userId`.
			columnMapping: {
				findFirst: vi.fn(async ({ where }: { where: ColumnMappingWhere }) => {
					// FAITHFUL, not strict, and the difference was measured. An earlier version threw
					// on any where that was not exactly `{userId, fingerprint}`, which sounds like the
					// fake-must-fail-loudly rule and defeated the break-check that matters: dropping
					// `userId` from the production query then reddened every test in this file with
					// "unmodelled where" before reaching the one assertion about cross-user scoping.
					// Red on the wrong gate is not a result.
					//
					// So an ABSENT clause is modelled as absent, which is what Prisma does, and the
					// loud throw is kept for a clause this cannot express at all.
					const keys = Object.keys(where).sort();
					const unmodelled = keys.filter((key) => key !== 'userId' && key !== 'fingerprint');
					if (unmodelled.length > 0 || where.fingerprint === undefined)
						throw new Error(`columnMapping.findFirst: unmodelled where ${keys.join(',')}`);
					const wanted = where.fingerprint.in;
					return (
						state.columnMappings.find(
							(row) =>
								(where.userId === undefined || row.userId === where.userId) &&
								wanted.includes(row.fingerprint)
						) ?? null
					);
				}),
				updateMany: vi.fn(async ({ where, data }: ColumnMappingUpdateArgs) => {
					const rows = state.columnMappings.filter(
						(row) => row.id === where.id && row.userId === where.userId
					);
					for (const row of rows) {
						row.useCount += data.useCount.increment;
						row.lastUsedAt = data.lastUsedAt;
					}
					return { count: rows.length };
				})
			},
			categoryRule: {
				findMany: vi.fn(async () =>
					state.rules
						.filter((rule) => rule.active && rule.id.startsWith('category-rule'))
						.map((rule) => ({
							id: rule.id,
							name: rule.pattern,
							matchText: rule.pattern,
							targetCategory: rule.targetCategory,
							enabled: true
						}))
				)
			},
			category: {
				findFirst: vi.fn(async ({ where }: { where: { userId: string; nameKey: string } }) => {
					return (
						state.categories.find(
							(category) =>
								category.userId === where.userId && computeNameKey(category.name) === where.nameKey
						) ?? null
					);
				}),
				// #161: `applyCategoryRules` runs at the end of an import and resolves each rule's
				// target against the user's categories, so the import path reads this too.
				findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
					const keys = Object.keys(where);
					if (keys.length !== 1 || keys[0] !== 'userId') {
						throw new Error(
							`category.findMany fake does not model where: ${JSON.stringify(where)}`
						);
					}
					return state.categories
						.filter((category) => category.userId === where.userId)
						.map((category) => ({ name: category.name }));
				}),
				upsert: vi.fn(async ({ where, create }: CategoryUpsertArgs) => {
					// Keyed on the folded name, matching the unique constraint the real table
					// carries: two spellings of one category resolve to the same row.
					const found = state.categories.find(
						(category) =>
							category.userId === where.userId_nameKey.userId &&
							computeNameKey(category.name) === where.userId_nameKey.nameKey
					);
					if (found) return found;
					const category = { id: id('category'), ...create };
					state.categories.push(category);
					return category;
				})
			},
			transaction: {
				/**
				 * T3 of the collision rule: how many incoming fingerprints already exist.
				 *
				 * Faithful to the real clause, hashes included. A fake answering a constant would
				 * decide the term it is supposed to observe.
				 */
				count: vi.fn(async ({ where }: TransactionCountArgs) => {
					const hashes = where.dedupeKeyHash?.in ?? [];
					return state.transactions.filter(
						(transaction) =>
							transaction.userId === where.userId &&
							transaction.dedupeKeyHash !== null &&
							hashes.includes(transaction.dedupeKeyHash as string)
					).length;
				}),
				/**
				 * T2's aggregation, grouped on (importBatchId, type) exactly as the production query
				 * asks for it. Amounts are magnitudes with the direction in `type`, which is what the
				 * write path stores, so summing here is summing the same thing.
				 */
				groupBy: vi.fn(async ({ where }: TransactionGroupByArgs) => {
					const wanted = where.importBatchId?.in ?? [];
					const buckets = new Map<string, { count: number; sum: number }>();
					for (const transaction of state.transactions) {
						if (transaction.userId !== where.userId) continue;
						if (!wanted.includes(transaction.importBatchId as string)) continue;
						const key = `${transaction.importBatchId}|${transaction.type}`;
						const bucket = buckets.get(key) ?? { count: 0, sum: 0 };
						bucket.count += 1;
						bucket.sum += transaction.amountCents as number;
						buckets.set(key, bucket);
					}
					return [...buckets.entries()].map(([key, bucket]) => {
						const [importBatchId, type] = key.split('|');
						return {
							importBatchId,
							type,
							_count: { _all: bucket.count },
							_sum: { amountCents: bucket.sum }
						};
					});
				}),
				findFirst: vi.fn(async ({ where }: TransactionFindFirstArgs) => {
					// Matched on the hash, like the real duplicate pre-check: the raw key is the
					// comparison that column exists to replace.
					return (
						state.transactions.find(
							(transaction) =>
								transaction.userId === where.userId &&
								transaction.dedupeKeyHash === where.dedupeKeyHash
						) ?? null
					);
				}),
				create: vi.fn(async ({ data }: TransactionCreateArgs) => {
					if (
						data.dedupeKey &&
						state.transactions.some((transaction) => transaction.dedupeKey === data.dedupeKey)
					) {
						const error = new Error('Unique constraint failed') as Error & { code: string };
						error.code = 'P2002';
						throw error;
					}
					const transaction = { id: id('transaction'), manualCategory: null, ...data };
					state.transactions.push(transaction);
					return transaction;
				}),
				findMany: vi.fn(async ({ where }) => {
					return state.transactions.filter(
						(transaction) =>
							transaction.userId === where.userId &&
							transaction.manualCategory === null &&
							(!where.id?.in || where.id.in.includes(transaction.id))
					);
				}),
				updateMany: vi.fn(async ({ where, data }) => {
					const ids = where.id?.in ?? (where.id ? [where.id] : []);
					let count = 0;
					for (const transaction of state.transactions) {
						if (!ids.includes(transaction.id)) continue;
						if (transaction.userId !== where.userId) continue;
						if (transaction.manualCategory !== where.manualCategory) continue;
						if ('natureManual' in where && transaction.natureManual !== where.natureManual)
							continue;
						transaction.manualCategory = data.manualCategory;
						if ('natureManual' in data) transaction.natureManual = data.natureManual;
						count += 1;
					}
					return { count };
				})
			}
		}
	};
});

vi.mock('$lib/server/db', () => ({ prisma: db.prisma }));

const { actions, load } = await import('./+page.server');
const testUser = { id: 'user-a', email: 'a@example.test', role: 'USER' as const };

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const BANQUE_POPULAIRE_HEADER =
	'Date de comptabilisation;Libelle simplifie;Libelle operation;Reference;Informations complementaires;Type operation;Categorie;Sous categorie;Debit;Credit;Date operation;Date de valeur;Pointage operation';

const BANQUE_POPULAIRE_VALID_ROW =
	'24/06/2026;CARREFOUR;PAIEMENT CB CARREFOUR;REF001;;Carte bancaire;Courses;Supermarché;42,90;;23/06/2026;24/06/2026;0';

const AUCHAN_ROW =
	'23/06/2026;AUCHAN;AUCHAN 0065 SC 78MAUREPAS;80FDBFG;220626 CB****2593-;Carte bancaire;Alimentation;Hyper/supermarche;-38,46;;23/06/2026;23/06/2026;0';
const REVOLUT_HEADER =
	'Type,Produit,Date de début,Date de fin,Description,Montant,Frais,Devise,État,Solde';
const MAISON_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';

describe('/import load', () => {
	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
	});

	it('hasAllImportBucketsExisting: false quand aucun bucket CSV n’existe encore pour cet utilisateur', async () => {
		const result = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/import')
		} as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
	});

	it('hasAllImportBucketsExisting reste false quand SEUL un des trois profils a déjà un bucket (régression F7 : le sélecteur doit rester visible pour un profil jamais importé)', async () => {
		db.state.accounts.push({
			id: 'account-existing',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'revolut',
			currency: 'EUR'
		});

		const result = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/import')
		} as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
	});

	it("hasAllImportBucketsExisting: false pour un bucket d'un autre utilisateur (pas de fuite cross-user)", async () => {
		db.state.accounts.push({
			id: 'account-other-user',
			userId: 'user-b',
			name: 'Compte import CSV',
			source: 'csv',
			currency: 'EUR'
		});

		const result = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/import')
		} as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
	});

	it('hasAllImportBucketsExisting: false quand deux des trois profils ont un bucket mais pas le troisième (csv + revolut, pas banque_populaire)', async () => {
		db.state.accounts.push(
			{
				id: 'account-csv',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'csv',
				currency: 'EUR'
			},
			{
				id: 'account-revolut',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'revolut',
				currency: 'EUR'
			}
		);

		const result = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/import')
		} as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
		expect(db.prisma.account.findMany).toHaveBeenCalledWith({
			where: {
				userId: testUser.id,
				name: 'Compte import CSV',
				source: { in: ['csv', 'revolut', 'banque_populaire'] }
			},
			select: { source: true }
		});
	});

	it('hasAllImportBucketsExisting: true quand les trois profils (csv, revolut, banque_populaire) ont déjà un bucket', async () => {
		db.state.accounts.push(
			{
				id: 'account-csv',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'csv',
				currency: 'EUR'
			},
			{
				id: 'account-revolut',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'revolut',
				currency: 'EUR'
			},
			{
				id: 'account-bp',
				userId: testUser.id,
				name: 'Compte import CSV',
				source: 'banque_populaire',
				currency: 'EUR'
			}
		);

		const result = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/import')
		} as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(true);
	});

	it('hasAllImportBucketsExisting: false pour un bucket manuel (source différente, non-import)', async () => {
		db.state.accounts.push({
			id: 'account-manual',
			userId: testUser.id,
			name: 'Compte manuel',
			source: 'manual',
			currency: 'EUR'
		});

		const result = (await load({
			locals: { user: testUser },
			url: new URL('http://localhost/import')
		} as never)) as {
			hasAllImportBucketsExisting: boolean;
		};

		expect(result.hasAllImportBucketsExisting).toBe(false);
	});
});

describe('/import actions', () => {
	it('detects the format and ignores any profile the client tries to send', async () => {
		expect.assertions(4);

		// The page offers no profile selector, and this is the PROPERTY behind that rather than
		// the wording: the server hardcodes `profile: 'auto'` and never reads a profile from the
		// form, so a hand crafted POST cannot pick one either. Guarding the copy would go stale
		// the moment somebody rephrases it; guarding this does not.
		const honest = await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${AUCHAN_ROW}`);
		// A DIFFERENT amount, so the second run is not deduplicated against the first. Without
		// this the forged run imports 0 rows for a reason that has nothing to do with profiles,
		// and the test would fail while the app was behaving correctly.
		const forged = await runImportWithFileAndFields(
			`${BANQUE_POPULAIRE_HEADER}\n${AUCHAN_ROW.replace('-38,46', '-51,20')}`,
			{ profile: 'maison' }
		);

		// The presence half: detection really did run and really did produce a result, so the
		// equality below is not two identical failures agreeing with each other.
		expect(getImportResult(honest).profile).toBe('banque-populaire');
		expect(getImportResult(honest).importedRows).toBe(1);
		expect(getImportResult(forged).profile).toBe('banque-populaire');
		expect(getImportResult(forged).importedRows).toBe(1);
	});

	beforeEach(() => {
		db.reset();
		vi.clearAllMocks();
	});

	it('refuse un import sans fichier', async () => {
		expect.assertions(2);

		const result = await runImport(new FormData());

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Sélectionnez un fichier de relevé à importer.');
	});

	it('rejects an unsupported file', async () => {
		expect.assertions(2);

		const formData = new FormData();
		formData.set('csvFile', new File(['not csv'], 'export.txt', { type: 'text/plain' }));

		const result = await runImport(formData);

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Le fichier doit utiliser l’extension .csv ou .xlsx.');
	});

	it('importe un CSV Banque Populaire valide', async () => {
		expect.assertions(7);

		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`
		);

		expect(result.importResult.profile).toBe('banque-populaire');
		expect(result.importResult.totalRows).toBe(1);
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.invalidRows).toBe(0);
		expect(result.importResult.totalDebitCents).toBe(4_290);
		expect(db.state.transactions).toHaveLength(1);
		expect(db.state.transactions[0]).toMatchObject({
			label: 'CARREFOUR',
			amountCents: 4_290,
			type: 'expense',
			source: 'banque_populaire'
		});
	});

	it('imports AUCHAN Debit -38,46 as a 3846-cent expense', async () => {
		expect.assertions(7);

		await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${AUCHAN_ROW}`);
		const transaction = db.state.transactions[0];
		const metadata = JSON.parse(transaction.metadataJson ?? '{}') as {
			reference?: string;
			csvFields?: Record<string, string>;
		};

		expect(transaction.label).toBe('AUCHAN');
		expect(transaction.amountCents).toBe(3_846);
		expect(transaction.type).toBe('expense');
		expect(transaction.notes).toContain('AUCHAN 0065 SC 78MAUREPAS');
		expect(metadata.reference).toBe('80FDBFG');
		expect(metadata.csvFields?.['Libelle operation']).toBe('AUCHAN 0065 SC 78…');
		expect(metadata.csvFields?.['Informations complementaires']).not.toContain('2593');
	});

	it('creates the category if it is absent', async () => {
		expect.assertions(2);

		await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${AUCHAN_ROW}`);

		// Without a categorization rule, the persisted category is 'Non catégorisé'.
		// The BP operation type ('Alimentation') is in metadata.banquePopulaireCategory.
		expect(db.state.categories).toHaveLength(1);
		expect(db.state.categories[0].name).toBe(UNCLASSIFIED_CATEGORY);
	});

	it('importe normalement une ligne Banque Populaire Transaction exclue / Virement interne', async () => {
		expect.assertions(6);

		await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n` +
				'22/06/2026;+M PAUL PAUL;VIR M PAUL PAUL;REFVIR;Vir. vers Compte Cheque-;Virement recu;Transaction exclue;Virement interne;;+150,00;20/06/2026;20/06/2026;0'
		);
		const transaction = db.state.transactions[0];
		const metadata = JSON.parse(transaction.metadataJson ?? '{}') as {
			banquePopulaireCategory?: string;
			subcategory?: string;
		};

		expect(db.state.transactions).toHaveLength(1);
		expect(transaction.categoryId).toBe(db.state.categories[0].id);
		// Without a rule, category is 'Non catégorisé'. The BP operation type stays in metadata.
		expect(db.state.categories[0].name).toBe(UNCLASSIFIED_CATEGORY);
		expect(transaction.type).toBe('income');
		expect(metadata.banquePopulaireCategory).toBe('Transaction exclue');
		expect(metadata.subcategory).toBe('Virement interne');
	});

	it('applies a categorization rule during import', async () => {
		expect.assertions(2);

		db.state.rules.push({
			id: 'rule-auchan',
			pattern: 'AUCHAN',
			targetCategory: 'Alimentation',
			type: 'expense',
			active: true,
			createdAt: new Date()
		});
		await runImportWithFile('date;label;amount;category\n2026-06-01;AUCHAN COURSES;-42,10;Autre');

		expect(db.state.categories[0].name).toBe('Alimentation');
		expect(db.state.transactions[0].type).toBe('expense');
	});

	it('applies a rule that recategorizes a transaction', async () => {
		expect.assertions(2);

		db.state.rules.push({
			id: 'rule-revolut',
			pattern: 'REVOLUT',
			targetCategory: 'Virement interne',
			type: 'expense',
			active: true,
			createdAt: new Date()
		});
		await runImportWithFile('date;label;amount;category\n2026-06-01;REVOLUT;-30;Autre');

		expect(db.state.categories[0].name).toBe('Virement interne');
		expect(db.state.transactions[0].type).toBe('expense');
	});

	it('applies a user rule as manualCategory during import', async () => {
		expect.assertions(2);

		// The target has to be one of the user's own categories, which is a precondition this test
		// always had and never stated. Since #161 a CategoryRule whose target resolves to nothing is
		// paused, precisely so a deleted category's name cannot be written back onto transactions,
		// and `applyCategoryRules` writes `manualCategory` as free text without ever creating a
		// Category row. Unlike the two CategorizationRule tests above, nothing in this path would
		// bring "Abonnements" into existence.
		db.state.categories.push({
			id: 'category-abonnements',
			userId: testUser.id,
			name: 'Abonnements'
		});
		db.state.rules.push({
			id: 'category-rule-patreon',
			pattern: 'patreon',
			targetCategory: 'Abonnements',
			type: null,
			active: true,
			createdAt: new Date()
		});
		await runImportWithFile('date;label;amount;category\n2026-06-01;PATREON EUROPE;-8,00;Autre');

		expect(db.state.transactions[0].manualCategory).toBe('Abonnements');
		expect(db.state.transactions[0].userId).toBe(testUser.id);
	});

	it('creates an enriched ImportBatch on import', async () => {
		expect.assertions(5);

		await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`);

		expect(db.state.batches).toHaveLength(1);
		expect(db.state.batches[0]).toMatchObject({
			fileName: 'export.csv',
			profile: 'banque-populaire',
			rowCount: 1,
			importedRows: 1
		});
		expect(db.state.batches[0].periodStart).toBeInstanceOf(Date);
		expect(db.state.transactions[0].importBatchId).toBe(db.state.batches[0].id);
		expect(db.prisma.importBatch.update).toHaveBeenCalled();
	});

	it('ignores duplicates on a second import of the same CSV', async () => {
		expect.assertions(4);

		await runImportWithFile(`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`);
		const second = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`
		);

		expect(db.state.transactions).toHaveLength(1);
		expect(second.importResult.importedRows).toBe(0);
		expect(second.importResult.duplicateRows).toBe(1);
		expect(second.importResult.totalDebitCents).toBe(0);
	});

	it('ne persiste pas les lignes invalides', async () => {
		expect.assertions(6);

		const invalidRow =
			'24/06/2026;VIDE;VIDE;REFBAD;;Carte bancaire;Autre;;;;24/06/2026;24/06/2026;0';
		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${invalidRow}`
		);
		const importResult = getImportResult(result);

		expect(importResult.totalRows).toBe(2);
		expect(importResult.importedRows).toBe(1);
		expect(importResult.invalidRows).toBe(1);
		// The code rather than the sentence, and the scope rather than a bare number: this now
		// proves WHICH guard refused the row and that the refusal is about a real line, where the
		// French substring could have come from any producer of that wording.
		expect(importResult.invalidRowDetails[0]).toMatchObject({
			scope: { kind: 'row', line: 3 },
			fact: { code: 'debit-credit-empty' },
			field: 'Debit/Credit',
			profile: 'banque-populaire'
		});
		expect(importResult.invalidRowDetails[0].preview).not.toContain('REFBAD');
		expect(db.state.transactions).toHaveLength(1);
	});

	it('limits the returned invalid line list to 20', async () => {
		expect.assertions(3);

		const invalidRows = Array.from(
			{ length: 21 },
			(_, index) =>
				`24/06/2026;VIDE${index};VIDE${index};REFBAD${index};;Carte bancaire;Autre;;;;24/06/2026;24/06/2026;0`
		).join('\n');
		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${invalidRows}`
		);
		const importResult = getImportResult(result);

		expect(importResult.invalidRows).toBe(21);
		expect(importResult.invalidRowDetails).toHaveLength(20);
		expect(importResult.hiddenInvalidRowsCount).toBe(1);
	});

	it('anonymizes previews and does not return raw banking data', async () => {
		expect.assertions(5);

		const sensitiveInvalidRow =
			'23/06/2026;AUCHAN;AUCHAN 0065 SC 78MAUREPAS;80FDBFG;220626 CB****2593-;Carte bancaire;Alimentation;Hyper/supermarche;;;23/06/2026;23/06/2026;0';
		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${sensitiveInvalidRow}`
		);
		const preview = getImportResult(result).invalidRowDetails[0].preview;

		expect(preview).toContain('AUCHAN');
		expect(preview).toContain('CB****');
		expect(preview).not.toContain('AUCHAN 0065 SC 78MAUREPAS');
		expect(preview).not.toContain('80FDBFG');
		expect(preview).not.toContain('2593');
	});

	it('truncates each preview cell to 18 characters', async () => {
		expect.assertions(3);

		const longPlainTextRow =
			'23/06/2026;VIDE;Restaurant du coin bien sympa sans chiffres;REFBAD;;Carte bancaire;Autre;;;;23/06/2026;23/06/2026;0';
		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${longPlainTextRow}`
		);
		const preview = getImportResult(result).invalidRowDetails[0].preview;
		const cells = preview.split(' | ');

		expect(cells.some((cell) => cell === 'Restaurant du coi…')).toBe(true);
		expect(cells.every((cell) => cell.length <= 18)).toBe(true);
		expect(preview).not.toContain('Restaurant du coin bien sympa sans chiffres');
	});

	it('does not log raw banking data during diagnostics', async () => {
		expect.assertions(2);

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const sensitiveInvalidRow =
			'23/06/2026;AUCHAN;AUCHAN 0065 SC 78MAUREPAS;80FDBFG;220626 CB****2593-;Carte bancaire;Alimentation;Hyper/supermarche;;;23/06/2026;23/06/2026;0';

		await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}\n${sensitiveInvalidRow}`
		);

		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		logSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it('no longer references the /demo route', () => {
		expect.assertions(1);

		expect(existsSync(resolve(root, 'src/routes/demo/+page.svelte'))).toBe(false);
	});

	it('does not break the generic import', async () => {
		expect.assertions(6);

		const result = await runImportWithFile(
			'date;label;amount;category\n2026-06-01;Salaire;2500,50;Revenus\n2026-06-02;Courses;-42,10;Alimentation'
		);

		expect(result.importResult.profile).toBe('generic');
		expect(result.importResult.importedRows).toBe(2);
		expect(result.importResult.totalCreditCents).toBe(250_050);
		expect(result.importResult.totalDebitCents).toBe(4_210);
		expect(db.state.transactions[0]).toMatchObject({
			amountCents: 250_050,
			type: 'income',
			source: 'csv'
		});
		expect(db.state.transactions[1]).toMatchObject({
			amountCents: 4_210,
			type: 'expense',
			source: 'csv'
		});
	});

	it('imports a Revolut CSV and keeps the detected profile', async () => {
		expect.assertions(10);

		const result = await runImportWithFile(
			`${REVOLUT_HEADER}\nPaiement par carte,Valeur actuelle,2026-05-01 02:52:44,2026-05-01 05:37:37,Patreon,-7.80,0.00,EUR,TERMINÉ,114.00`
		);
		const metadata = JSON.parse(db.state.transactions[0].metadataJson ?? '{}') as {
			revolutFeeCents?: number;
			revolutCurrency?: string;
			revolutState?: string;
			csvFields?: Record<string, string>;
		};

		expect(result.importResult.profile).toBe('revolut');
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.totalDebitCents).toBe(780);
		expect(db.state.batches[0].source).toBe('revolut');
		expect(db.state.transactions[0]).toMatchObject({
			label: 'Patreon',
			amountCents: 780,
			type: 'expense',
			source: 'revolut'
		});
		expect(metadata.revolutFeeCents).toBe(0);
		expect(metadata.revolutCurrency).toBe('EUR');
		expect(metadata.revolutState).toBe('TERMINÉ');
		expect(metadata.csvFields?.Frais).toBeUndefined();
		expect(metadata.csvFields?.Description).toBeUndefined();
	});

	it('importe un XLSX Revolut en colonnes', async () => {
		expect.assertions(6);

		const result = await runImportWithXlsxFile([
			REVOLUT_HEADER.split(','),
			[
				'Paiement par carte',
				'Valeur actuelle',
				'2026-05-01 02:52:44',
				'2026-05-01 05:37:37',
				'Patreon',
				'-7.80',
				'0.00',
				'EUR',
				'TERMINÉ',
				'114.00'
			]
		]);

		expect(result.importResult.profile).toBe('revolut');
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.totalDebitCents).toBe(780);
		expect(db.state.batches[0].fileName).toBe('export.xlsx');
		expect(db.state.transactions[0]).toMatchObject({
			label: 'Patreon',
			amountCents: 780,
			type: 'expense',
			source: 'revolut'
		});
		expect(db.state.transactions[0].metadataJson).toContain('TERMINÉ');
	});

	it('imports an XLSX Revolut CSV disguised with repaired mojibake', async () => {
		expect.assertions(5);

		const result = await runImportWithXlsxFile(
			[
				['Type,Produit,Date de dÃ©but,Date de fin,Description,Montant,Frais,Devise,Ã‰tat,Solde'],
				[
					'Ajout de fonds,Valeur actuelle,2026-05-04 18:52:52,2026-05-04 18:53:06,Recharge via *2593,60.00,0.00,EUR,TERMINÃ‰,73.98'
				]
			],
			'revolut.xlsx'
		);
		const metadata = JSON.parse(db.state.transactions[0].metadataJson ?? '{}') as {
			revolutState?: string;
		};

		expect(result.importResult.profile).toBe('revolut');
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.totalCreditCents).toBe(6_000);
		expect(db.state.transactions[0].type).toBe('income');
		expect(metadata.revolutState).toBe('TERMINÉ');
	});

	it('imports a valid maison line and writes natureManual to DB', async () => {
		expect.assertions(4);

		const result = await runImportWithFile(
			`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`
		);

		expect(result.importResult.profile).toBe('maison');
		expect(result.importResult.importedRows).toBe(1);
		expect(db.state.transactions[0].amountCents).toBe(4_210);
		expect(db.state.transactions[0].natureManual).toBe('spending');
	});

	it('links a newly-created bucket to a valid, owned, linkable net worth account', async () => {
		expect.assertions(2);

		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-1');
		await runImport(formData);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].netWorthAccountId).toBe('nwa-1');
	});

	it('regression F7: an existing revolut bucket does not block linking on a first-ever banque_populaire import (distinct sources, distinct buckets)', async () => {
		expect.assertions(4);

		db.state.accounts.push({
			id: 'account-revolut',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'revolut',
			currency: 'EUR',
			netWorthAccountId: null
		});
		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-1');
		const result = await runImport(formData);
		const importResult = getImportResult(result);

		expect(db.state.accounts).toHaveLength(2);
		const banquePopulaireAccount = db.state.accounts.find(
			(account) => account.source === 'banque_populaire'
		);
		expect(banquePopulaireAccount?.netWorthAccountId).toBe('nwa-1');
		expect(
			db.state.accounts.find((account) => account.source === 'revolut')?.netWorthAccountId
		).toBeNull();
		expect(importResult?.netWorthLinkStatus).toBe('applied');
	});

	it('reports netWorthLinkStatus "ignored" when a destination is selected but a bucket for this exact profile already exists', async () => {
		expect.assertions(2);

		db.state.accounts.push({
			id: 'account-bp',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'banque_populaire',
			currency: 'EUR',
			netWorthAccountId: null
		});
		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-1');
		const result = await runImport(formData);
		const importResult = getImportResult(result);

		expect(
			db.state.accounts.find((account) => account.source === 'banque_populaire')?.netWorthAccountId
		).toBeNull();
		expect(importResult?.netWorthLinkStatus).toBe('ignored');
	});

	it('rejects a net worth account id belonging to another user, without any write', async () => {
		expect.assertions(4);

		db.state.netWorthAccounts.push({
			id: 'nwa-foreign',
			userId: 'someone-else',
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-foreign');
		const result = await runImport(formData);

		expect(result.status).toBe(400);
		expect(result.data.error).toBe('Le compte de patrimoine sélectionné est invalide.');
		expect(db.state.accounts).toHaveLength(0);
		expect(db.state.transactions).toHaveLength(0);
	});

	it('rejects a nonexistent net worth account id, without any write', async () => {
		expect.assertions(3);

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-does-not-exist');
		const result = await runImport(formData);

		expect(result.status).toBe(400);
		expect(db.state.accounts).toHaveLength(0);
		expect(db.state.transactions).toHaveLength(0);
	});

	it('rejects a net worth account of a non-linkable type (real_estate/other)', async () => {
		expect.assertions(2);

		db.state.netWorthAccounts.push({
			id: 'nwa-house',
			userId: testUser.id,
			name: 'Maison',
			type: 'real_estate',
			balanceCents: 100_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-house');
		const result = await runImport(formData);

		expect(result.status).toBe(400);
		expect(db.state.accounts).toHaveLength(0);
	});

	it('does not change an already-linked bucket link on re-import, even with a different id submitted', async () => {
		expect.assertions(2);

		db.state.netWorthAccounts.push(
			{
				id: 'nwa-1',
				userId: testUser.id,
				name: 'Compte courant',
				type: 'checking',
				balanceCents: 10_000,
				deletedAt: null,
				createdAt: new Date()
			},
			{
				id: 'nwa-2',
				userId: testUser.id,
				name: 'Livret',
				type: 'savings',
				balanceCents: 5_000,
				deletedAt: null,
				createdAt: new Date()
			}
		);
		db.state.accounts.push({
			id: 'account-existing',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'banque_populaire',
			currency: 'EUR',
			netWorthAccountId: 'nwa-1'
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File([`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-2');
		await runImport(formData);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].netWorthAccountId).toBe('nwa-1');
	});

	it('keeps working exactly as before when netWorthAccountId is absent (backward compat)', async () => {
		expect.assertions(3);

		const result = await runImportWithFile(
			`${BANQUE_POPULAIRE_HEADER}\n${BANQUE_POPULAIRE_VALID_ROW}`
		);

		expect(result.importResult.importedRows).toBe(1);
		expect(db.state.accounts[0].netWorthAccountId).toBeNull();
		expect(result.importResult.netWorthLinkStatus).toBeNull();
	});

	it("maison and generic profiles share the same 'csv' bucket: a generic-created csv bucket makes a first maison import report netWorthLinkStatus 'ignored'", async () => {
		expect.assertions(3);

		db.state.accounts.push({
			id: 'account-csv-generic',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'csv',
			currency: 'EUR',
			netWorthAccountId: null
		});
		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File(
				[`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`],
				'export.csv',
				{ type: 'text/csv' }
			)
		);
		formData.set('netWorthAccountId', 'nwa-1');
		const result = await runImport(formData);
		const importResult = getImportResult(result);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].netWorthAccountId).toBeNull();
		expect(importResult?.netWorthLinkStatus).toBe('ignored');
	});

	it("maison and generic profiles share the same 'csv' bucket: a maison-created csv bucket makes a first generic import report netWorthLinkStatus 'ignored'", async () => {
		expect.assertions(3);

		db.state.accounts.push({
			id: 'account-csv-maison',
			userId: testUser.id,
			name: 'Compte import CSV',
			source: 'csv',
			currency: 'EUR',
			netWorthAccountId: null
		});
		db.state.netWorthAccounts.push({
			id: 'nwa-1',
			userId: testUser.id,
			name: 'Compte courant',
			type: 'checking',
			balanceCents: 10_000,
			deletedAt: null,
			createdAt: new Date()
		});

		const formData = new FormData();
		formData.set(
			'csvFile',
			new File(['date;label;amount;category\n2026-06-01;Salaire;2500,50;Revenus'], 'export.csv', {
				type: 'text/csv'
			})
		);
		formData.set('netWorthAccountId', 'nwa-1');
		const result = await runImport(formData);
		const importResult = getImportResult(result);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].netWorthAccountId).toBeNull();
		expect(importResult?.netWorthLinkStatus).toBe('ignored');
	});

	it('universal deduplication: a maison line identical to a transaction already imported via another profile is ignored', async () => {
		expect.assertions(3);

		// Transaction already in the database, previously imported through banque-populaire, seeded
		// with the key the CURRENT builder produces.
		//
		// This test's name claimed cross-profile deduplication and could not deliver it before the
		// key was unified: `maison` built `date|amount|label` while every other profile built
		// `date|label|amount|type|<category or reference>|scope`, so two profiles never produced the
		// same key for the same transaction and this only ever exercised maison against maison. One
		// builder for all five is what makes the claim true, and seeding through that builder is
		// what keeps this test honest about which claim it is making.
		const existingFingerprint = buildDeduplicationKey({
			date: '2026-06-01',
			label: 'Courses Auchan',
			amountCents: 4_210,
			type: 'expense',
			occurrence: 0
		});
		db.state.transactions.push({
			id: 'transaction-existing',
			accountId: 'account-existing',
			categoryId: 'category-existing',
			importBatchId: 'batch-existing',
			userId: testUser.id,
			date: new Date('2026-06-01T00:00:00.000Z'),
			label: 'Courses Auchan',
			amountCents: 4_210,
			type: 'expense',
			source: 'banque_populaire',
			notes: null,
			manualCategory: null,
			natureManual: null,
			dedupeKey: existingFingerprint,
			dedupeKeyHash: computeDedupeKeyHash(existingFingerprint),
			metadataJson: null
		});

		const result = await runImportWithFile(
			`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`
		);

		expect(db.state.transactions).toHaveLength(1);
		expect(result.importResult.importedRows).toBe(0);
		expect(result.importResult.duplicateRows).toBe(1);
	});

	/**
	 * BREAK MATRIX for the owner scoping, 2026-08-14. The break: drop `userId` from
	 * `readColumnMapping`'s where clause, which is how it would really arrive (the key is
	 * `(userId, fingerprint)`, the fingerprint is 64 hex characters, so it reads as unique on its
	 * own; it is not, because it is derived from a bank's PUBLIC column names).
	 *
	 * **One red in the whole unit suite**: `is invisible to another user`. 2627 green.
	 * `store.db-smoke.ts` adds two more against a real engine, and the two layers are not
	 * duplicates: the db-smoke proves the QUERY is scoped, this proves the scoped query is the one
	 * the ACTION calls.
	 *
	 * The first attempt at this break was RED ON THE WRONG GATE and is worth recording, because it
	 * looked like a result. The fake's `findFirst` threw on any where that was not exactly
	 * `{userId, fingerprint}`, so the break reddened every test in this file with "unmodelled
	 * where" before reaching the one assertion about scoping. The fake now models an absent clause
	 * as absent, which is what Prisma does, and keeps the loud throw for a clause it cannot express.
	 */
	/**
	 * The date wall, and the route that was pointed away from it.
	 *
	 * The rescue existed and was reachable only from a file NOTHING recognised. A file whose headers
	 * matched and whose values then failed ended on the same sentence with no way forward, and the
	 * two are indistinguishable from the outside. Nothing covered `offersDesignation` at any level
	 * before this block, which is why the routing could be wrong for a whole chantier.
	 */
	describe('the designation offer on a file that produced nothing', () => {
		// Headers a profile READS (`date`, `label`, `amount`), values it cannot: dots are not one of
		// the three accepted date forms. This is the blind session's own file, reduced.
		const RECOGNISED_HEADERS_UNREADABLE_DATES =
			'date,label,amount\n01/06/26,CARREFOUR MARKET,-24.90\n02/06/26,SALAIRE,2140.00';

		it('is offered when the headers matched and every value failed', async () => {
			const result = (await runImportWithFile(RECOGNISED_HEADERS_UNREADABLE_DATES)) as unknown as {
				data: { designation?: { headers: string[]; rowCount: number } };
			};

			expect(result.data.designation).toBeDefined();
			expect(result.data.designation?.headers).toEqual(['date', 'label', 'amount']);
			// The screen rests on the preview, so it is handed the rows it will draw.
			expect(result.data.designation?.rowCount).toBe(2);
		});

		it('names the expected date form beside the value that was rejected', async () => {
			const result = (await runImportWithFile(RECOGNISED_HEADERS_UNREADABLE_DATES)) as unknown as {
				// Typed from the production type, so the assertion below cannot drift from the shape
				// the action actually returns.
				data: { importResult: { invalidRowDetails: ImportInvalidRowDetail[] } };
			};

			const details = result.data.importResult.invalidRowDetails;
			expect(details).toHaveLength(2);
			expect(details[0].fact.code).toBe('invalid-date');
			// The refusal LABEL carries the accepted forms, and the row preview beside it carries the
			// value. Asserted through the production label function rather than against a retyped
			// string, so a catalogue edit that drops the forms turns this red.
			expect(refusalLabel(details[0].fact)).toMatch(/JJ\/MM\/AAAA/);
		});

		it('is not offered when every refusal is one no column can repair', async () => {
			// A currency the app does not hold is a fact about the money, not about which column
			// carries it. There is no column to name that would make this file importable, and
			// sending the user to designate ends with them believing the feature is broken.
			const foreign =
				'date,label,amount,currency\n2026-06-01,TESCO,-24.90,GBP\n2026-06-02,TESCO,-11.00,GBP';

			const result = (await runImportWithFile(foreign)) as unknown as {
				data: { designation?: unknown };
			};

			expect(result.data.designation).toBeUndefined();
		});

		it('is still offered when only SOME rows are beyond repair', async () => {
			// `every`, not `some`. One unusable currency among rows that failed on their dates is
			// still a file naming a column might rescue, and the earlier reading would have refused
			// the offer on the strength of the single row.
			const mixed =
				'date,label,amount,currency\n2026-06-01,TESCO,-24.90,GBP\n01/06/26,CARREFOUR,-11.00,EUR';

			const result = (await runImportWithFile(mixed)) as unknown as {
				data: { designation?: unknown };
			};

			expect(result.data.designation).toBeDefined();
		});

		it('is not offered to a file with no data row, which the screen cannot draw', async () => {
			const result = (await runImportWithFile('date,label,amount')) as unknown as {
				data: { designation?: unknown };
			};

			expect(result.data.designation).toBeUndefined();
		});
	});

	describe('a remembered column mapping at the import action', () => {
		// A file no alias table can read: `Jour`, `Intitule operation` and `Somme` are in no alias
		// list, so without a mapping this content is refused. That is what makes the two tests below
		// separate two states rather than one.
		const UNRECOGNISED = 'Jour;Intitule operation;Somme\n24/06/2026;CARREFOUR MARKET;-24,90';

		function rememberFor(userId: string) {
			const mapping = {
				matchBy: 'name' as const,
				dateColumn: 'jour',
				labelColumn: 'intitule operation',
				amountColumn: 'somme',
				categoryColumn: null,
				dateIndex: null,
				labelIndex: null,
				amountIndex: null,
				categoryIndex: null,
				columnCount: 3
			};
			const row = {
				id: `mapping-${userId}`,
				userId,
				fingerprint: fingerprintFor(['Jour', 'Intitule operation', 'Somme'], 'name'),
				...mapping,
				useCount: 0,
				lastUsedAt: null as Date | null
			};
			db.state.columnMappings.push(row);
			return row;
		}

		it('imports through the mapping and counts the use', async () => {
			const row = rememberFor(testUser.id);

			const result = await runImportWithFile(UNRECOGNISED);

			expect(result.importResult.importedRows).toBe(1);
			expect(db.state.transactions).toHaveLength(1);
			expect(db.state.transactions[0].label).toBe('CARREFOUR MARKET');
			// The count and the stamp, because the recap sentence reads both.
			expect(row.useCount).toBe(1);
			expect(row.lastUsedAt).not.toBeNull();
		});

		/**
		 * The seam the whole collision check exists for, at the level that can see it.
		 *
		 * Neither the rule's own spec nor a component test can. The rule was green throughout the
		 * blind session that doubled a user's finances, because nothing called it. What is asserted
		 * here is that the ACTION calls it, before it writes, and that nothing lands when it fires.
		 *
		 * Four columns rather than three, because the interesting move needs somewhere to move TO:
		 * a mapping is refused outright when two roles share one column (`roles-share-a-column`), so
		 * a three-column file cannot express "the label came from the wrong column".
		 */
		const FOUR_COLUMNS =
			'Jour;Intitule operation;Somme;Detail\n24/06/2026;CARREFOUR MARKET;-24,90;PAIEMENT CB 22/06';

		function rememberFourColumn(labelColumn: string) {
			const row = {
				id: `mapping-four-${labelColumn}`,
				userId: testUser.id,
				fingerprint: fingerprintFor(['Jour', 'Intitule operation', 'Somme', 'Detail'], 'name'),
				matchBy: 'name' as const,
				dateColumn: 'jour',
				labelColumn,
				amountColumn: 'somme',
				categoryColumn: null,
				dateIndex: null,
				labelIndex: null,
				amountIndex: null,
				categoryIndex: null,
				columnCount: 4,
				useCount: 0,
				lastUsedAt: null as Date | null
			};
			db.state.columnMappings.length = 0;
			db.state.columnMappings.push(row);
			return row;
		}

		it('refuses a statement re-read through a different label column, before writing', async () => {
			rememberFourColumn('intitule operation');
			await runImportWithFile(FOUR_COLUMNS);
			expect(db.state.transactions).toHaveLength(1);

			// The correction the user makes on `/import/columns`: the same file, with the label taken
			// from another column. Every fingerprint changes, so deduplication sees nothing it knows,
			// and the whole statement would import a second time.
			const corrected = rememberFourColumn('detail');

			const refused = (await runImportWithFile(FOUR_COLUMNS)) as unknown as {
				status?: number;
				data: { collision?: { transactionCount: number }; incoming?: { transactionCount: number } };
			};

			expect(refused.status).toBe(409);
			expect(refused.data.collision?.transactionCount).toBe(1);
			expect(refused.data.incoming?.transactionCount).toBe(1);
			// NOTHING was written. Not the transactions, not a second batch, and not a use against the
			// correspondance: a run the user is about to abandon leaves no trace of having happened.
			expect(db.state.transactions).toHaveLength(1);
			expect(db.state.batches).toHaveLength(1);
			expect(corrected.useCount).toBe(0);
		});

		it('writes the run once the user confirms it', async () => {
			rememberFourColumn('intitule operation');
			await runImportWithFile(FOUR_COLUMNS);
			rememberFourColumn('detail');

			const confirmed = await runImportWithFileAndFields(FOUR_COLUMNS, { confirmCollision: '1' });

			expect(confirmed.importResult.importedRows).toBe(1);
			expect(db.state.transactions).toHaveLength(2);
			expect(db.state.batches).toHaveLength(2);
		});

		it('says nothing when deduplication already covers the run', async () => {
			// The same file through the same columns, imported twice. Every fingerprint is recognised,
			// the summary reports one duplicate, and no question is asked: this is the run every user
			// performs, and a warning here is what makes a warning stop being read.
			rememberFourColumn('intitule operation');
			await runImportWithFile(FOUR_COLUMNS);

			const second = await runImportWithFile(FOUR_COLUMNS);

			expect(second.importResult.importedRows).toBe(0);
			expect(second.importResult.duplicateRows).toBe(1);
			expect(db.state.transactions).toHaveLength(1);
		});

		it('is invisible to another user, whose identical file is refused', async () => {
			// The fingerprint is derived from a bank's PUBLIC column names, so `user-b` designating
			// this shape produces the SAME fingerprint `user-a` would. Without the userId in the where
			// clause this file would import, which is the whole of the authorization control.
			const foreign = rememberFor('user-b');

			const result = await runImportWithFile(UNRECOGNISED);

			expect(db.state.transactions).toStrictEqual([]);
			expect(foreign.useCount).toBe(0);
			// The REASON, not merely that it was refused: this must fail for "no column mapped these
			// headers", the same way it does for a user who has designated nothing, and not through
			// some second guard that would mask a scoping bug behind a different sentence.
			expect(getImportResult(result).invalidRowDetails.map((row) => row.fact.code)).toStrictEqual([
				'missing-required-column',
				'missing-required-column',
				'missing-required-column'
			]);
		});

		it('falls through to today behaviour when the remembered columns are gone', async () => {
			// Plate state 3b at the route. The designation screen does not exist yet, so a bank that
			// renames a column must cost the user exactly what it costs them today and not more.
			rememberFor(testUser.id);

			const renamed = 'Jour;Libelle complet;Somme\n24/06/2026;CARREFOUR MARKET;-24,90';
			const result = await runImportWithFile(renamed);

			expect(db.state.transactions).toStrictEqual([]);
			// `missing-required-column`, which is the unmapped path speaking, NOT
			// `mapping-columns-missing`, which would mean the parser was handed a mapping that does
			// not fit. The difference is the whole of "falls through".
			expect(getImportResult(result).invalidRowDetails.map((row) => row.fact.code)).not.toContain(
				'mapping-columns-missing'
			);
		});
	});
});

async function runImportWithFile(content: string) {
	const formData = new FormData();
	formData.set('csvFile', new File([content], 'export.csv', { type: 'text/csv' }));
	return runImport(formData);
}

async function runImportWithFileAndFields(content: string, fields: Record<string, string>) {
	const formData = new FormData();
	formData.set('csvFile', new File([content], 'export.csv', { type: 'text/csv' }));
	for (const [key, value] of Object.entries(fields)) formData.set(key, value);
	return runImport(formData);
}

async function runImportWithXlsxFile(rows: string[][], fileName = 'export.xlsx') {
	const formData = new FormData();
	const bytes = buildXlsx(rows);
	const arrayBuffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(arrayBuffer).set(bytes);
	formData.set(
		'csvFile',
		new File([arrayBuffer], fileName, {
			type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		})
	);
	return runImport(formData);
}

async function runImport(formData: FormData) {
	const action = actions.default as (event: {
		locals: { user: typeof testUser };
		request: Request;
	}) => Promise<unknown>;
	return (await action({
		locals: { user: testUser },
		request: new Request('http://localhost/import', {
			method: 'POST',
			body: formData
		})
	})) as {
		status?: number;
		data: {
			error: string;
			importResult?: {
				fileName?: string;
				profile?: string;
				totalRows: number;
				importedRows: number;
				duplicateRows: number;
				invalidRows: number;
				totalDebitCents: number;
				totalCreditCents: number;
				invalidRowDetails: ImportInvalidRowDetail[];
				hiddenInvalidRowsCount: number;
				netWorthLinkStatus?: 'applied' | 'ignored' | null;
			};
		};
		importResult: {
			fileName?: string;
			profile?: string;
			totalRows: number;
			importedRows: number;
			duplicateRows: number;
			invalidRows: number;
			totalDebitCents: number;
			totalCreditCents: number;
			invalidRowDetails: ImportInvalidRowDetail[];
			hiddenInvalidRowsCount: number;
			netWorthLinkStatus?: 'applied' | 'ignored' | null;
		};
	};
}

function getImportResult(result: Awaited<ReturnType<typeof runImport>>) {
	return result.importResult ?? result.data.importResult;
}

function buildXlsx(rows: string[][]): Uint8Array {
	const files = new Map<string, string>([
		[
			'[Content_Types].xml',
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
				'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
				'<Default Extension="xml" ContentType="application/xml"/>' +
				'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
				'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
				'</Types>'
		],
		[
			'_rels/.rels',
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
				'</Relationships>'
		],
		[
			'xl/workbook.xml',
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
				'<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
				'</workbook>'
		],
		[
			'xl/_rels/workbook.xml.rels',
			'<?xml version="1.0" encoding="UTF-8"?>' +
				'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
				'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
				'</Relationships>'
		],
		['xl/worksheets/sheet1.xml', buildWorksheetXml(rows)]
	]);

	return zipStored(files);
}

function buildWorksheetXml(rows: string[][]): string {
	const sheetData = rows
		.map((row, rowIndex) => {
			const rowNumber = rowIndex + 1;
			const cells = row
				.map((value, columnIndex) => {
					const ref = `${columnName(columnIndex)}${rowNumber}`;
					return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
				})
				.join('');
			return `<row r="${rowNumber}">${cells}</row>`;
		})
		.join('');

	return (
		'<?xml version="1.0" encoding="UTF-8"?>' +
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		`<sheetData>${sheetData}</sheetData>` +
		'</worksheet>'
	);
}

function zipStored(files: Map<string, string>): Uint8Array {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const centralDirectory: Uint8Array[] = [];
	let offset = 0;

	for (const [name, content] of files) {
		const nameBytes = encoder.encode(name);
		const contentBytes = encoder.encode(content);
		const crc = crc32(contentBytes);
		const localHeader = concatBytes(
			u32(0x04034b50),
			u16(20),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(crc),
			u32(contentBytes.length),
			u32(contentBytes.length),
			u16(nameBytes.length),
			u16(0),
			nameBytes
		);
		chunks.push(localHeader, contentBytes);
		centralDirectory.push(
			concatBytes(
				u32(0x02014b50),
				u16(20),
				u16(20),
				u16(0),
				u16(0),
				u16(0),
				u16(0),
				u32(crc),
				u32(contentBytes.length),
				u32(contentBytes.length),
				u16(nameBytes.length),
				u16(0),
				u16(0),
				u16(0),
				u16(0),
				u32(0),
				u32(offset),
				nameBytes
			)
		);
		offset += localHeader.length + contentBytes.length;
	}

	const centralOffset = offset;
	const centralBytes = concatBytes(...centralDirectory);
	const end = concatBytes(
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(files.size),
		u16(files.size),
		u32(centralBytes.length),
		u32(centralOffset),
		u16(0)
	);

	return concatBytes(...chunks, centralBytes, end);
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const output = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

function u16(value: number): Uint8Array {
	return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
	return new Uint8Array([
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff
	]);
}

function columnName(index: number): string {
	let name = '';
	let current = index + 1;
	while (current > 0) {
		const remainder = (current - 1) % 26;
		name = String.fromCharCode(65 + remainder) + name;
		current = Math.floor((current - 1) / 26);
	}
	return name;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
