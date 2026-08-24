import { existsSync } from 'node:fs';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { assignDedupeKeys } from '$lib/server/import/dedupeRecompute';
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
		archivedAt?: Date | null;
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
	type ColumnMappingWhere = { id?: string; userId?: string; fingerprint?: { in: string[] } };
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
		// The correspondance this import was read through, which is what the correction pairing is
		// resolved against.
		columnMappingId?: string | null;
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
		where: {
			userId: string;
			dedupeKeyHash?: { in: string[] };
			importBatchId?: string;
			OR?: unknown[];
		};
	};
	type TransactionGroupByArgs = {
		where: { userId: string; importBatchId?: { in: string[] } };
	};
	type BatchFindManyWhere = {
		userId: string;
		periodStart?: { lte?: Date };
		periodEnd?: { gte?: Date };
	};
	type BatchFindFirstWhere = {
		id?: string;
		userId?: string;
		columnMappingId?: string;
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
		// How many rows of the batch being corrected carry a split or a tag. Set per test rather
		// than derived, because this fake models neither table.
		userWorkCount: 0,
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
			// The loop covers TABLES. Scalars are not arrays, so each one has to be named here, and
			// the comment above is exactly the failure that applies to them: a scalar added to
			// `state` and forgotten here survives into the next test and reads as a guard that
			// failed to fire. Both defaults are stated rather than inferred.
			state.nextId = 1;
			state.userWorkCount = 0;
		},
		prisma: {
			netWorthAccount: {
				findMany: vi.fn(async ({ where }: { where: { userId: string; deletedAt: null } }) =>
					state.netWorthAccounts
						.filter((account) => account.userId === where.userId && account.deletedAt === null)
						.map((account) => ({ ...account, updatedAt: account.createdAt }))
				)
			},
			/**
			 * The source-signature memory the account offer reads. Empty, which is the first-import
			 * case: nothing has been memorised, so resolution answers rank 3 with no candidates and
			 * the row asks. Modelled rather than omitted because an absent model is not an empty
			 * table, it is a crash.
			 */
			importSourceSignature: {
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(async () => null)
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
				/**
				 * TWO call shapes reach this fake and it models both rather than matching neither.
				 *
				 * The load's probe asks `{ userId, source: { in: [...] }, archivedAt: null }`; the
				 * auto path's destination lookup asks `{ userId, source: <scalar>, archivedAt: null }`.
				 * The name left the first of those when the boot backfill started renaming buckets.
				 *
				 * It THROWS on a key it cannot model, which is the rule that makes this fake worth
				 * anything: Prisma treats an unknown `where` key as no filter at all, so a fake that
				 * quietly ignored one would report every account as a candidate and turn the
				 * ambiguity refusal into a pass. A fake must fail loudly on a predicate it cannot
				 * model and faithfully model an absent one.
				 */
				findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
					const modelled = new Set(['userId', 'name', 'source', 'archivedAt']);
					for (const key of Object.keys(where)) {
						if (!modelled.has(key)) {
							throw new Error(`account.findMany fake cannot model where.${key}`);
						}
					}
					return state.accounts.filter((account) => {
						if (account.userId !== where.userId) return false;
						if (where.name !== undefined && account.name !== where.name) return false;
						const source = where.source;
						if (typeof source === 'string' && account.source !== source) return false;
						if (
							source !== null &&
							typeof source === 'object' &&
							!(source as { in: string[] }).in.includes(account.source)
						) {
							return false;
						}
						if (where.archivedAt === null && (account.archivedAt ?? null) !== null) return false;
						return true;
					});
				}),
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
				// The bucket a persisted row is denominated by. Real rather than stubbed, because it
				// reads back a row this fake's own `upsert` created: a stub returning a constant
				// would assert the stub rather than that the bucket's pair reaches the transaction.
				findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
					const account = state.accounts.find((entry) => entry.id === where.id);
					if (!account) throw new Error(`no account ${where.id}`);
					return account;
				}),
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
				/**
				 * The correction pairing, resolved by `/import`'s load and by its action.
				 *
				 * Modelled clause by clause, and FAITHFUL rather than strict, which is the same
				 * distinction `columnMapping.findFirst` below records: an absent clause filters
				 * nothing, exactly as Prisma does, so dropping `userId` from the production query
				 * reddens the cross-user test rather than throwing "unmodelled where" in every test
				 * in this file before reaching it. A clause this cannot express at all still throws.
				 */
				findFirst: vi.fn(async ({ where }: { where: BatchFindFirstWhere }) => {
					const unmodelled = Object.keys(where).filter(
						(key) => !['id', 'userId', 'columnMappingId'].includes(key)
					);
					if (unmodelled.length > 0) {
						throw new Error(`importBatch.findFirst: unmodelled where ${unmodelled.join(',')}`);
					}
					return (
						state.batches.find(
							(batch) =>
								(where.id === undefined || batch.id === where.id) &&
								(where.userId === undefined || batch.userId === where.userId) &&
								(where.columnMappingId === undefined ||
									(batch.columnMappingId ?? null) === where.columnMappingId)
						) ?? null
					);
				}),
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
					const unmodelled = keys.filter(
						(key) => key !== 'userId' && key !== 'fingerprint' && key !== 'id'
					);
					if (unmodelled.length > 0)
						throw new Error(`columnMapping.findFirst: unmodelled where ${keys.join(',')}`);
					// The correction path looks a correspondance up BY ID rather than by fingerprint,
					// so `id` is modelled here as its own clause instead of the lookup being one shape.
					if (where.fingerprint === undefined) {
						return (
							state.columnMappings.find(
								(row) =>
									(where.userId === undefined || row.userId === where.userId) &&
									(where.id === undefined || row.id === where.id)
							) ?? null
						);
					}
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
					// TWO callers with two different WHEREs, and this fake models both rather than
					// approximating either. T3 counts recognised fingerprints; the correction load
					// counts the rows of one batch that carry a split or a tag, to decide whether the
					// control names a loss.
					//
					// The split-and-tag count is modelled as ZERO rather than thrown on, and that is a
					// choice with a reason: this fake's state holds no splits and no tags, so zero is
					// the faithful answer for every fixture it can build. `deleteBatch.db-smoke.ts` is
					// where the cascade is proved, against three real engines.
					if (where.OR) {
						return state.userWorkCount;
					}
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

	/**
	 * `?correct=<mapping>&batch=<batch>`, which is the pair that decides a deletion.
	 *
	 * Both ids come from the address bar and both are resolved against this user, but the third
	 * check is the one that is easy to leave out: the batch must be one that was READ THROUGH the
	 * correspondance it arrives beside. Without it a user could pair their own correspondance with
	 * any of their own batches and have the correction delete the wrong import, which is a data-loss
	 * bug rather than a tenancy one, and no amount of `userId` scoping catches it.
	 */
	/** The batch's own creation instant, which the control that deletes it now names. */
	const SEEDED_AT = new Date('2026-08-16T08:59:00.000Z');

	describe('the correction pair', () => {
		function seedCorrection() {
			db.state.columnMappings.push({
				id: 'mapping-1',
				userId: testUser.id,
				fingerprint: 'fp-1'
			} as (typeof db.state.columnMappings)[number]);
			db.state.batches.push({
				id: 'batch-1',
				userId: testUser.id,
				source: 'csv',
				profile: 'generic',
				rowCount: 3,
				importedRows: 3,
				duplicateRows: 0,
				invalidRows: 0,
				// The load reads this to NAME the batch on the control that deletes it, so a fixture
				// without one models a row Prisma cannot return: `createdAt` is non-nullable in the
				// schema. Left absent, every test in this block failed on `undefined.toISOString()`,
				// which is the mock's shape drifting from the route rather than a defect in either.
				createdAt: SEEDED_AT,
				columnMappingId: 'mapping-1'
			} as (typeof db.state.batches)[number]);
		}

		async function loadWith(search: string) {
			return (await load({
				locals: { user: testUser },
				url: new URL(`http://localhost/import${search}`)
			} as never)) as {
				correction: {
					mappingId: string;
					batchId: string | null;
					replacedAt: string | null;
					replacedRows: number;
					hasUserWork: boolean;
				} | null;
			};
		}

		it('resolves both ids when the batch really was read through that correspondance', async () => {
			seedCorrection();

			const result = await loadWith('?correct=mapping-1&batch=batch-1');

			expect(result.correction).toEqual({
				mappingId: 'mapping-1',
				batchId: 'batch-1',
				replacedAt: SEEDED_AT.toISOString(),
				// 3, which is what the seed above writes as `importedRows`. The confirmation of
				// Planche 5c names this number beside a different one, the rows about to be imported,
				// so a fixture where the two agreed could not tell them apart.
				replacedRows: 3,
				hasUserWork: false
			});
		});

		it('carries no timestamp when no batch resolved, so the control cannot half-render', async () => {
			// `replacedAt` and `batchId` are separate fields of one payload and the page gates the
			// control on both. Asserted together rather than trusting them to move together: a load that
			// returned a timestamp beside a null id would render « Supprimer l'import du 16 août » for an
			// import it cannot name, or nothing at all, depending on which field the page happened to read.
			seedCorrection();

			const result = await loadWith('?correct=mapping-1&batch=batch-of-nobody');

			expect(result.correction).toEqual({
				mappingId: 'mapping-1',
				batchId: null,
				replacedAt: null,
				replacedRows: 0,
				hasUserWork: false
			});
		});

		it('drops a batch that belongs to another user, and still corrects', async () => {
			seedCorrection();
			db.state.batches[0].userId = 'user-b';

			const result = await loadWith('?correct=mapping-1&batch=batch-1');

			// `batchId` null, and the correction itself survives. Refusing outright would fall through
			// to an ordinary import, reading the file through the very correspondance the user has just
			// declared wrong, which is a worse outcome than replacing nothing.
			expect(result.correction).toEqual({
				mappingId: 'mapping-1',
				batchId: null,
				replacedAt: null,
				replacedRows: 0,
				hasUserWork: false
			});
		});

		it('drops a batch of this user that was read through a DIFFERENT correspondance', async () => {
			// The fixture differs from the passing one in exactly the clause under test and in nothing
			// else: same user, same batch id, same correspondance id in the address bar. No amount of
			// userId scoping catches this one, and its consequence is a delete aimed at the wrong import.
			seedCorrection();
			db.state.batches[0].columnMappingId = 'mapping-2';

			const result = await loadWith('?correct=mapping-1&batch=batch-1');

			expect(result.correction).toEqual({
				mappingId: 'mapping-1',
				batchId: null,
				replacedAt: null,
				replacedRows: 0,
				hasUserWork: false
			});
		});

		it('corrects without replacing when the address bar names no batch', async () => {
			// The link's shape before this shipped, which a bookmark or a history entry still holds.
			seedCorrection();

			const result = await loadWith('?correct=mapping-1');

			expect(result.correction).toEqual({
				mappingId: 'mapping-1',
				batchId: null,
				replacedAt: null,
				replacedRows: 0,
				hasUserWork: false
			});
		});

		it('reports that the batch carries splits or tags, so the control can name the loss', async () => {
			// The owner's condition on the control: say nothing when there is nothing to lose, and
			// name it when there is. Counted server side, because the page cannot see the rows.
			seedCorrection();
			db.state.userWorkCount = 3;

			const result = await loadWith('?correct=mapping-1&batch=batch-1');

			expect(result.correction?.hasUserWork).toBe(true);
		});

		it('counts that work on the BATCH being replaced, scoped to this user', async () => {
			// Asserted on the clause, because Prisma treats a missing clause as no filter: a count
			// that dropped `importBatchId` would report another import's splits as this one's and the
			// control would warn about a loss that cannot occur.
			seedCorrection();

			await loadWith('?correct=mapping-1&batch=batch-1');

			const call = db.prisma.transaction.count.mock.calls.find(
				([args]: [{ where: { OR?: unknown[] } }]) => args.where.OR
			);
			expect(call?.[0].where).toMatchObject({ userId: testUser.id, importBatchId: 'batch-1' });
		});

		it('is null when the correspondance itself belongs to another user', async () => {
			seedCorrection();
			db.state.columnMappings[0].userId = 'user-b';

			const result = await loadWith('?correct=mapping-1&batch=batch-1');

			expect(result.correction).toBeNull();
		});
	});
});

describe('/import actions', () => {
	/**
	 * THE CONSENT THAT DECIDES A DELETE, and what a request that never expressed it gets.
	 *
	 * The control posts its answer through a hidden companion, because an unchecked box is simply
	 * absent from a submission. A hand crafted request can omit BOTH, and the question this asks is
	 * what the server then derives. Same class as the profile test below and the same assertion is
	 * owed: a hand crafted POST must not obtain a destructive default it never asked for.
	 *
	 * ASVS 5.0 **v5.0.0-2.2.1**, which asks for positive validation against an allow list of values
	 * for input used to make a business or security decision. This field decides a delete, and the
	 * fix is literally the row: test positively for 'true' rather than negatively against 'false'.
	 */
	it('does NOT consent to the delete when the answer is absent from the request', async () => {
		expect.assertions(3);

		const headers = ['Jour', 'Intitule operation', 'Somme', 'Detail'];
		db.state.columnMappings.push({
			id: 'mapping-consent',
			userId: testUser.id,
			fingerprint: fingerprintFor(headers, 'name'),
			matchBy: 'name' as const,
			dateColumn: 'jour',
			labelColumn: 'detail',
			amountColumn: 'somme',
			categoryColumn: null,
			dateIndex: null,
			labelIndex: null,
			amountIndex: null,
			categoryIndex: null,
			columnCount: 4,
			useCount: 0,
			lastUsedAt: null as Date | null
		} as (typeof db.state.columnMappings)[number]);
		db.state.batches.push({
			id: 'batch-consent',
			userId: testUser.id,
			source: 'csv',
			profile: 'generic',
			rowCount: 1,
			importedRows: 1,
			duplicateRows: 0,
			invalidRows: 0,
			columnMappingId: 'mapping-consent'
		} as (typeof db.state.batches)[number]);

		const forged = await runImportWithFileAndFields(
			`${headers.join(';')}\n24/06/2026;CARREFOUR MARKET;-24,90;PAIEMENT CB 22/06`,
			{ correctMappingId: 'mapping-consent', correctBatchId: 'batch-consent' }
		);

		// The presence half: the correction really was recognised, so the assertion below is not two
		// failures agreeing with each other.
		expect(forged.data.correction?.batchId).toBe('batch-consent');
		// And the answer it never gave is NO. The two failures are not symmetric: deriving "keep"
		// from a lost field leaves the user with two imports and a way to repair it, while deriving
		// "delete" destroys rows with no undo. Same degradation argument the write-then-delete
		// ordering rests on.
		expect(forged.data.correction?.deleteOldImport).toBe(false);
		/**
		 * THE SAME PRECONDITION, on the OTHER producer, and it needed its own assertion.
		 *
		 * There are two places that hand the screen a designation: the ordinary offer and this
		 * correction branch. A break-check on the first reddened nothing, because the offer test does
		 * not reach it, and a break on the second reddened one test: two producers, one guard, and the
		 * unguarded one is the branch the correction journey uses, which is where the header answer
		 * was lost in the first place.
		 *
		 * `readWithHeaderRow` resolves one direction because BOTH producers declare a header row. Both
		 * therefore say so here.
		 */
		expect(
			(forged as unknown as { data: { designation?: { detectedHeaderRow: boolean } } }).data
				.designation?.detectedHeaderRow
		).toBe(true);
	});

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

	it('no longer links a bucket when a net worth account is submitted on the import path', async () => {
		// SEPARATES: « the import path stopped reading the field » FROM « the field is still read and
		// still linked ». The field was applied only when the bucket was CREATED, and hard-coded to
		// null on the designation path, so it answered « which net worth line does this bucket feed »
		// on a screen asking « where does this file go ». One field, two jobs; it stops having either
		// here, and the link moves to the Comptes screen where the question is about an ACCOUNT.
		//
		// Asserted through the real action rather than on a shape, so a deletion that leaves the
		// wiring live cannot pass.
		//
		// CORRECTED FROM THE PLAN, and the correction is the reason this comment is long: the plan
		// wrote `expect(result).not.toHaveProperty('netWorthLinkStatus')`, and `result` is
		// `{ importResult: {...} }` — the field has never been a property of `result`, so that
		// assertion is green before the change and green after it. It separates nothing. The
		// negative is asserted one level down, where the field actually lives.
		expect.assertions(4);

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

		// Calibration beside the emptiness: the import still WORKED. A bucket that was never created
		// would also carry no link, and that is a different bug reading as this fix.
		expect(db.state.accounts).toHaveLength(1);
		expect(importResult?.importedRows).toBe(1);
		expect(db.state.accounts[0].netWorthAccountId).toBeNull();
		expect(importResult).not.toHaveProperty('netWorthLinkStatus');
	});

	/**
	 * MAISON AND GENERIC SHARE ONE `csv` BUCKET, and that is the subject these two tests keep.
	 *
	 * They used to read the sharing off `netWorthLinkStatus === 'ignored'`, which was an OBSERVABLE of
	 * it rather than the thing itself: the status said « ignored » precisely because the bucket the
	 * second profile wanted already existed. That field is gone with the destination control, and
	 * deleting these two tests alongside the eight that really were about the net worth link would
	 * have removed a live assertion about a live invariant while reading as part of a cleanup.
	 *
	 * So the invariant is asserted DIRECTLY now, and it is a stronger test than the one it replaces:
	 * both imports really run, rather than one running against a hand-seeded fixture account. A
	 * fixture cannot tell « the second import reused the first one's bucket » from « the second
	 * import found a row somebody put there », because in the old form nothing had put it there but
	 * the test.
	 */
	it("maison and generic profiles share one 'csv' bucket: a generic import then a maison import land on the same account", async () => {
		// SEPARATES: « the second profile reused the bucket the first created » FROM « each profile got
		// its own account ». Two accounts is what a per-PROFILE bucket would produce, and it is the
		// shape `getImportSource` deliberately does not produce: everything that is not Revolut or
		// Banque Populaire is source `csv`, maison included.
		expect.assertions(4);

		const generic = new FormData();
		generic.set(
			'csvFile',
			new File(['date;label;amount;category\n2026-06-01;Salaire;2500,50;Revenus'], 'generic.csv', {
				type: 'text/csv'
			})
		);
		await runImport(generic);

		const maison = new FormData();
		maison.set(
			'csvFile',
			new File(
				[`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`],
				'maison.csv',
				{ type: 'text/csv' }
			)
		);
		await runImport(maison);

		// The absolute figures beside the identity: both files really imported a row each. Two
		// transactions from one account and ZERO transactions from one account are the same
		// « one account » otherwise, and the second is a different bug.
		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].source).toBe('csv');
		expect(db.state.transactions).toHaveLength(2);
		expect(new Set(db.state.transactions.map((row) => row.accountId))).toStrictEqual(
			new Set([db.state.accounts[0].id])
		);
	});

	it("maison and generic profiles share one 'csv' bucket: the other order lands on the same account too", async () => {
		// SEPARATES: « the sharing is symmetric » FROM « whichever profile imports FIRST owns the
		// bucket and the other one makes its own ». The two orders are separate cases because the
		// bucket is CREATED on one of them and merely FOUND on the other, and only the found path can
		// get the lookup wrong.
		expect.assertions(4);

		const maison = new FormData();
		maison.set(
			'csvFile',
			new File(
				[`${MAISON_HEADER}\n2026-06-01;Courses Auchan;Alimentation;-42.10;expense;spending;csv`],
				'maison.csv',
				{ type: 'text/csv' }
			)
		);
		await runImport(maison);

		const generic = new FormData();
		generic.set(
			'csvFile',
			new File(['date;label;amount;category\n2026-06-01;Salaire;2500,50;Revenus'], 'generic.csv', {
				type: 'text/csv'
			})
		);
		await runImport(generic);

		expect(db.state.accounts).toHaveLength(1);
		expect(db.state.accounts[0].source).toBe('csv');
		expect(db.state.transactions).toHaveLength(2);
		expect(new Set(db.state.transactions.map((row) => row.accountId))).toStrictEqual(
			new Set([db.state.accounts[0].id])
		);
	});

	it('no longer deduplicates across import profiles, because v3 keys carry the account', async () => {
		expect.assertions(3);

		// THIS TEST ASSERTED THE OPPOSITE, and the inversion is a deliberate consequence of the v3
		// key rather than a regression that slipped through. It used to claim "universal
		// deduplication": a transaction imported through banque-populaire was recognised when the
		// same row arrived through maison, because the v2 key carried nothing about where the row
		// landed.
		//
		// v3 carries the `Account.id`, which is what lets two accounts hold the same transaction
		// without one of them silently vanishing (#449). On the CSV path a bucket is per PROFILE,
		// so two profiles are two accounts and the same row read twice is now imported twice.
		//
		// That trade is deliberate and the loss is covered, not absorbed. A duplicate is on the
		// screen and a dropped transaction is not, which is the direction this repository has
		// chosen twice in writing. And the case is now LOUDER rather than quieter: `findCollidingBatch`
		// compares period and totals across batches regardless of bucket, and its T3 term used to
		// SUPPRESS the dialog precisely because these fingerprints matched. They no longer match,
		// so the user gets the explicit "this file appears to repeat an earlier import" dialog
		// instead of a silent absorption they were never told about.
		//
		// What actually removes the doubling is #372, which gives the import a real destination
		// account so two reads of one statement land in one bucket.
		const existingFingerprint = assignDedupeKeys([
			{
				id: 'seed',
				source: 'banque_populaire',
				accountId: 'account-existing',
				date: '2026-06-01',
				label: 'Courses Auchan',
				amountCents: 4_210,
				type: 'expense',
				currency: 'EUR',
				exponent: 2,
				providerAccountId: null,
				entryReference: null,
				keyed: true
			}
		]).get('seed')!;
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

		expect(db.state.transactions).toHaveLength(2);
		expect(result.importResult.importedRows).toBe(1);
		expect(result.importResult.duplicateRows).toBe(0);
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

		/**
		 * THE PRECONDITION `readWithHeaderRow` LEANS ON, asserted where its cause would be.
		 *
		 * That function resolves one direction only, and the reason is this action: the payload always
		 * declares a header row, and `rowCount` is already reduced by that line, so the user can only
		 * ever flip the answer to « data ». The opposite flip is unrepresentable from here.
		 *
		 * Nothing checked that. The day this payload sends `false`, the function would silently return
		 * a reading wrong in the other direction, and the symptom is the eaten transaction again, three
		 * files away from the change that caused it. This is the cheap half of « name the route that
		 * produces it » applied to a precondition rather than to a state: the guard fails here, at the
		 * line that would break it.
		 *
		 * If this ever legitimately becomes `false`, the fix is to build the second direction in
		 * `readWithHeaderRow`, not to relax this.
		 */
		it('always declares a header row, which is what lets the reader resolve one direction', async () => {
			const result = (await runImportWithFile(RECOGNISED_HEADERS_UNREADABLE_DATES)) as unknown as {
				data: { designation?: { detectedHeaderRow: boolean; rowCount: number } };
			};

			expect(result.data.designation?.detectedHeaderRow).toBe(true);
			// Asserted beside it, because the two are one claim: the count excludes the line the flag
			// says is a header, which is exactly what the +1 on the other side restores.
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
			correction?: { batchId: string; deleteOldImport: boolean } | null;
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
