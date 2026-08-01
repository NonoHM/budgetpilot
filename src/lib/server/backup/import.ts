import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';
import { LONG_TRANSACTION_OPTIONS } from '$lib/server/dbTransaction';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { DEFAULT_CATEGORIES } from '$lib/server/categories/defaults';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import { dedupeKeyUpdate } from '$lib/server/import/dedupeKey';
import { MAX_ANCHOR_IDS, parseAnchorTransactionIds, type BackupExport } from './schema';

export class BackupImportError extends Error {}

/** Historical FR name of the sentinel, present in pre-i18n exports. */
const LEGACY_UNCLASSIFIED_NAME = 'Non catégorisé';

const DEFAULT_KEY_BY_NAME = new Map(DEFAULT_CATEGORIES.map((c) => [c.name, c.key]));

/**
 * Compatibility with pre-i18n exports: the "to classify" sentinel is stored there under its
 * old FR name. Normalized to the current slug everywhere a category is
 * referenced by name, otherwise the "to classify" pile would no longer recognize these rows.
 */
function normalizeCategoryName(name: string): string {
	return name === LEGACY_UNCLASSIFIED_NAME ? UNCLASSIFIED_CATEGORY : name;
}

/**
 * The Zod schema already constrains `defaultKey` to the enum of real system keys, but
 * doesn't prevent a hand-edited backup from associating a valid key with a `name` that
 * doesn't match it (e.g. name="Compte piégé" + defaultKey="income" → would display
 * "Revenus" instead of the real name). We only trust a defaultKey consistent with
 * the expected canonical name; otherwise we neutralize it (null) rather than reject
 * the whole restore for this one row.
 */
function normalizeCategoryDefaultKey(
	name: string,
	defaultKey: string | null | undefined
): string | null {
	const canonicalKey = DEFAULT_KEY_BY_NAME.get(name) ?? null;
	if (defaultKey == null) return canonicalKey;
	return defaultKey === canonicalKey ? defaultKey : null;
}

/**
 * Restores a backup for a user: fully replaces their data
 * (Account, Category, Transaction, ImportBatch, MonthlyBudget, CategoryRule,
 * CategorizationRule, CategoryNatureMapping) with the file's content.
 *
 * First validates the file's internal referential consistency (before any write),
 * then executes purge + recreation in a single Prisma transaction.
 *
 * That transaction runs with LONG_TRANSACTION_OPTIONS rather than Prisma's defaults: the
 * recreation phase issues one statement per parent row to capture its regenerated id, so
 * the round trips add up on any database reached over a socket. See that module for why
 * the default budget only ever fitted a local SQLite file.
 */
export async function restoreBackup(userId: string, payload: BackupExport): Promise<void> {
	assertReferentialIntegrity(payload);

	await prisma.$transaction(async (tx) => {
		// a. Full purge for this user, in dependency order.
		await tx.transaction.deleteMany({ where: { userId } });
		await tx.account.deleteMany({ where: { userId } });
		await tx.category.deleteMany({ where: { userId } });
		await tx.importBatch.deleteMany({ where: { userId } });
		await tx.monthlyBudget.deleteMany({ where: { userId } });
		await tx.categoryRule.deleteMany({ where: { userId } });
		await tx.categorizationRule.deleteMany({ where: { userId } });
		await tx.categoryNatureMapping.deleteMany({ where: { userId } });
		await tx.savingsGoal.deleteMany({ where: { userId } });
		await tx.netWorthSnapshot.deleteMany({ where: { userId } });
		await tx.netWorthAccount.deleteMany({ where: { userId } });
		await tx.bankConnection.deleteMany({ where: { userId } });
		// No table references a RecurringStreamAction and it references none by foreign key (its
		// anchors are transaction ids inside a JSON cell), so its position here is free.
		await tx.recurringStreamAction.deleteMany({ where: { userId } });

		// b. Recreation: NetWorthAccount first (ids regenerated, one by one to build the id
		// map, INCLUDING soft-deleted ones — their history round-trips through a restore just
		// like active accounts), so that Account.netWorthAccountId can be remapped below.
		const netWorthAccountIdMap = new Map<string, string>();
		for (const account of payload.netWorthAccounts) {
			const created = await tx.netWorthAccount.create({
				data: {
					userId,
					name: account.name,
					nameKey: computeNameKey(account.name),
					type: account.type,
					balanceCents: account.balanceCents,
					deletedAt: account.deletedAt ? new Date(account.deletedAt) : null
				},
				select: { id: true }
			});
			netWorthAccountIdMap.set(account.id, created.id);
		}

		// Savings goals: no table depends on their id, so createMany with the netWorthAccountId
		// remapped via the map built just above suffices (no dedicated id map needed).
		if (payload.savingsGoals.length > 0) {
			await tx.savingsGoal.createMany({
				data: payload.savingsGoals.map((goal) => ({
					userId,
					name: goal.name,
					targetAmountCents: goal.targetAmountCents,
					netWorthAccountId: goal.netWorthAccountId
						? (netWorthAccountIdMap.get(goal.netWorthAccountId) ?? null)
						: null,
					currentAmountCents: goal.currentAmountCents,
					startingBalanceCents: goal.startingBalanceCents,
					targetDate: goal.targetDate ? new Date(goal.targetDate) : null,
					reachedAt: goal.reachedAt ? new Date(goal.reachedAt) : null,
					reachedBannerDismissedAt: goal.reachedBannerDismissedAt
						? new Date(goal.reachedBannerDismissedAt)
						: null
				}))
			});
		}

		// Bank connections before Account (so Account.bankConnectionId can be remapped).
		// The backup only ever carries non-sensitive metadata (schema-enforced):
		// providerSessionId and credentialsEncrypted are recreated as NULL, and an
		// exported "active" status is demoted to "expired" — a restored connection is
		// always "to reconnect", never functional with imported secrets.
		const bankConnectionIdMap = new Map<string, string>();
		for (const connection of payload.bankConnections) {
			const created = await tx.bankConnection.create({
				data: {
					userId,
					provider: connection.provider,
					status: connection.status === 'active' ? 'expired' : connection.status,
					aspspName: connection.aspspName ?? null,
					aspspCountry: connection.aspspCountry ?? null,
					consentExpiresAt: connection.consentExpiresAt
						? new Date(connection.consentExpiresAt)
						: null,
					lastSyncAt: connection.lastSyncAt ? new Date(connection.lastSyncAt) : null
				},
				select: { id: true }
			});
			bankConnectionIdMap.set(connection.id, created.id);
		}

		// Account/Category/ImportBatch next (ids regenerated, one by one to know the new id
		// and build the Maps oldId(file) → newId).
		const accountIdMap = new Map<string, string>();
		const accountKeyMap = new Map<string, string>();
		for (const account of payload.accounts) {
			// First spelling wins: an older export can hold two buckets whose names fold
			// together, and recreating both would rebuild the duplicate the app no longer
			// accepts. The second one's transactions follow the first through the id map.
			const accountKey = `${account.source} ${computeNameKey(account.name)}`;
			const alreadyRestored = accountKeyMap.get(accountKey);
			if (alreadyRestored) {
				accountIdMap.set(account.id, alreadyRestored);
				continue;
			}

			const created = await tx.account.create({
				data: {
					userId,
					name: account.name,
					currency: account.currency,
					source: account.source,
					netWorthAccountId: account.netWorthAccountId
						? (netWorthAccountIdMap.get(account.netWorthAccountId) ?? null)
						: null,
					bankConnectionId: account.bankConnectionId
						? (bankConnectionIdMap.get(account.bankConnectionId) ?? null)
						: null,
					providerAccountId: account.providerAccountId ?? null,
					providerCashAccountType: account.providerCashAccountType ?? null,
					nameKey: computeNameKey(account.name)
				},
				select: { id: true }
			});
			accountIdMap.set(account.id, created.id);
			accountKeyMap.set(accountKey, created.id);
		}

		const categoryIdMap = new Map<string, string>();
		const categoryKeyMap = new Map<string, string>();
		for (const category of payload.categories) {
			const name = normalizeCategoryName(category.name);
			// Same first-wins rule as accounts above.
			const nameKey = computeNameKey(name);
			const alreadyRestored = categoryKeyMap.get(nameKey);
			if (alreadyRestored) {
				categoryIdMap.set(category.id, alreadyRestored);
				continue;
			}

			const created = await tx.category.create({
				data: {
					userId,
					name,
					nameKey,
					defaultKey: normalizeCategoryDefaultKey(name, category.defaultKey)
				},
				select: { id: true }
			});
			categoryIdMap.set(category.id, created.id);
			categoryKeyMap.set(nameKey, created.id);
		}

		const importBatchIdMap = new Map<string, string>();
		for (const batch of payload.importBatches) {
			const created = await tx.importBatch.create({
				data: {
					userId,
					source: batch.source,
					fileName: batch.fileName,
					profile: batch.profile,
					rowCount: batch.rowCount,
					importedRows: batch.importedRows,
					duplicateRows: batch.duplicateRows,
					invalidRows: batch.invalidRows,
					periodStart: batch.periodStart ? new Date(batch.periodStart) : null,
					periodEnd: batch.periodEnd ? new Date(batch.periodEnd) : null
				},
				select: { id: true }
			});
			importBatchIdMap.set(batch.id, created.id);
		}

		// Recurring stream actions anchor themselves to transactions by id, inside a JSON cell.
		// Those ids are regenerated by this restore like every other id in the file, so the
		// anchors have to follow — an id left as the file wrote it would, after a restore into
		// another account, name a row belonging to somebody else.
		//
		// Only the anchored transactions are created one by one to capture their new id; every
		// other one keeps the bulk `createMany` path. The set is small (a handful of actions,
		// each anchored to at most a year of occurrences) and empty for any backup carrying no
		// action at all, which is every file written before this feature.
		const anchoredTransactionIds = new Set(
			payload.recurringStreamActions.flatMap((action) =>
				parseAnchorTransactionIds(action.anchorTransactionIds)
			)
		);
		const transactionIdMap = new Map<string, string>();

		const transactionData = payload.transactions.map((transaction) => ({
			oldId: transaction.id,
			data: {
				userId,
				accountId: accountIdMap.get(transaction.accountId)!,
				categoryId: categoryIdMap.get(transaction.categoryId)!,
				importBatchId: transaction.importBatchId
					? (importBatchIdMap.get(transaction.importBatchId) ?? null)
					: null,
				date: new Date(transaction.date),
				label: transaction.label,
				amountCents: transaction.amountCents,
				type: transaction.type,
				source: transaction.source,
				notes: transaction.notes,
				bankOperationType: transaction.bankOperationType,
				...manualCategoryUpdate(
					transaction.manualCategory ? normalizeCategoryName(transaction.manualCategory) : null
				),
				natureManual: transaction.natureManual,
				// Recomputed here, never read from the file: the hash is the app's own answer
				// to "is this the same row", not something a backup gets to assert.
				...dedupeKeyUpdate(transaction.dedupeKey),
				metadataJson: transaction.metadataJson
			}
		}));

		const bulkTransactions = transactionData.filter(
			(entry) => !anchoredTransactionIds.has(entry.oldId)
		);
		if (bulkTransactions.length > 0) {
			await tx.transaction.createMany({ data: bulkTransactions.map((entry) => entry.data) });
		}
		for (const entry of transactionData) {
			if (!anchoredTransactionIds.has(entry.oldId)) continue;
			const created = await tx.transaction.create({ data: entry.data, select: { id: true } });
			transactionIdMap.set(entry.oldId, created.id);
		}

		if (payload.recurringStreamActions.length > 0) {
			await tx.recurringStreamAction.createMany({
				data: payload.recurringStreamActions.map((action) => ({
					userId,
					kind: action.kind,
					direction: action.direction,
					normalizedLabel: action.normalizedLabel,
					label: action.label,
					// Remapped, and ids with no mapping are dropped rather than kept. Dropping one
					// only weakens this action to label-based matching; keeping one would let a
					// restore point an anchor at a transaction this user does not own.
					//
					// Truncated to the NEWEST MAX_ANCHOR_IDS because this is the one column a
					// restore rewrites: a 25-char cuid can be longer than the id it replaces, so
					// the cell written here can outgrow the cell the schema validated on the way
					// in. Without the cap an oversized cell leaves through an export — which does
					// not run the schema — and is refused on the way back in, telling the user
					// their own export is corrupt.
					anchorTransactionIds: JSON.stringify(
						parseAnchorTransactionIds(action.anchorTransactionIds)
							.map((id) => transactionIdMap.get(id))
							.filter((id): id is string => id !== undefined)
							.slice(-MAX_ANCHOR_IDS)
					),
					dueDate: action.dueDate ? new Date(action.dueDate) : null,
					createdAt: new Date(action.createdAt),
					updatedAt: new Date(action.updatedAt)
				}))
			});
		}

		if (payload.monthlyBudgets.length > 0) {
			await tx.monthlyBudget.createMany({
				data: dedupeByNameKey(
					payload.monthlyBudgets.map((budget) => ({
						userId,
						categoryName: normalizeCategoryName(budget.categoryName),
						categoryNameKey: computeNameKey(normalizeCategoryName(budget.categoryName)),
						amountCents: budget.amountCents
					})),
					(row) => row.categoryNameKey
				)
			});
		}

		if (payload.categoryRules.length > 0) {
			await tx.categoryRule.createMany({
				data: payload.categoryRules.map((rule) => ({
					userId,
					name: rule.name,
					matchText: rule.matchText,
					targetCategory: normalizeCategoryName(rule.targetCategory),
					targetNature: rule.targetNature,
					enabled: rule.enabled
				}))
			});
		}

		if (payload.categorizationRules.length > 0) {
			await tx.categorizationRule.createMany({
				data: payload.categorizationRules.map((rule) => ({
					userId,
					pattern: rule.pattern,
					targetCategory: normalizeCategoryName(rule.targetCategory),
					type: rule.type,
					active: rule.active
				}))
			});
		}

		if (payload.categoryNatureMappings.length > 0) {
			await tx.categoryNatureMapping.createMany({
				data: dedupeByNameKey(
					payload.categoryNatureMappings.map((mapping) => ({
						userId,
						categoryName: normalizeCategoryName(mapping.categoryName),
						categoryNameKey: computeNameKey(normalizeCategoryName(mapping.categoryName)),
						nature: mapping.nature
					})),
					(row) => row.categoryNameKey
				)
			});
		}

		// Net worth snapshots: createMany with remapped accountId (netWorthAccountIdMap was
		// already built above, before Account recreation).
		if (payload.netWorthSnapshots.length > 0) {
			await tx.netWorthSnapshot.createMany({
				data: payload.netWorthSnapshots.map((snapshot) => ({
					userId,
					accountId: netWorthAccountIdMap.get(snapshot.accountId)!,
					type: snapshot.type,
					balanceCents: snapshot.balanceCents,
					capturedAt: new Date(snapshot.capturedAt)
				}))
			});
		}

		// c. Guarantee the "to classify" category exists for this user, even if absent from the file.
		// Keyed on the folded name, like every other category write: a file whose own
		// "non catégorisé" row differs only in case or accents already occupies this key, and
		// re-creating it under the raw name would now be refused by the constraint.
		//
		// Not wrapped in `withConcurrentWriteRetry` like the other empty-update upserts, and
		// deliberately so: it runs inside this restore's transaction, where PostgreSQL would
		// abort everything on the violation and leave the retry nothing to succeed at. Nothing
		// races it either. A restore replaces one user's entire dataset, and the rows it could
		// collide with are ones this same transaction just wrote.
		await tx.category.upsert({
			where: {
				userId_nameKey: { userId, nameKey: computeNameKey(UNCLASSIFIED_CATEGORY) }
			},
			update: {},
			create: {
				userId,
				name: UNCLASSIFIED_CATEGORY,
				nameKey: computeNameKey(UNCLASSIFIED_CATEGORY)
			}
		});
	}, LONG_TRANSACTION_OPTIONS);
}

function assertReferentialIntegrity(payload: BackupExport): void {
	const accountIds = new Set(payload.accounts.map((a) => a.id));
	const categoryIds = new Set(payload.categories.map((c) => c.id));
	const importBatchIds = new Set(payload.importBatches.map((b) => b.id));
	const netWorthAccountIds = new Set(payload.netWorthAccounts.map((a) => a.id));
	const bankConnectionIds = new Set(payload.bankConnections.map((c) => c.id));

	for (const account of payload.accounts) {
		if (account.netWorthAccountId && !netWorthAccountIds.has(account.netWorthAccountId)) {
			throw new BackupImportError(
				m.settings_backup_error_unknown_net_worth_account_link({ id: account.id })
			);
		}
		if (account.bankConnectionId && !bankConnectionIds.has(account.bankConnectionId)) {
			throw new BackupImportError(
				m.settings_backup_error_unknown_bank_connection_link({ id: account.id })
			);
		}
	}

	for (const transaction of payload.transactions) {
		if (!accountIds.has(transaction.accountId)) {
			throw new BackupImportError(m.settings_backup_error_unknown_account({ id: transaction.id }));
		}
		if (!categoryIds.has(transaction.categoryId)) {
			throw new BackupImportError(m.settings_backup_error_unknown_category({ id: transaction.id }));
		}
		if (transaction.importBatchId && !importBatchIds.has(transaction.importBatchId)) {
			throw new BackupImportError(m.settings_backup_error_unknown_import({ id: transaction.id }));
		}
	}

	for (const snapshot of payload.netWorthSnapshots) {
		if (!netWorthAccountIds.has(snapshot.accountId)) {
			throw new BackupImportError(
				m.settings_backup_error_unknown_net_worth_account({ id: snapshot.id })
			);
		}
	}

	for (const goal of payload.savingsGoals) {
		if (goal.netWorthAccountId && !netWorthAccountIds.has(goal.netWorthAccountId)) {
			throw new BackupImportError(
				m.settings_backup_error_unknown_savings_goal_account({ id: goal.id })
			);
		}
	}
}

/**
 * Keeps the first row per folded name.
 *
 * A backup file written before names were folded can hold two rows that now mean one row.
 * Recreating both would rebuild, inside a fresh restore, exactly the duplicate the app no
 * longer accepts. First wins: a restore replays a snapshot with no history to weigh, so
 * there is nothing to prefer beyond the order the file already has.
 */
function dedupeByNameKey<T>(rows: T[], keyOf: (row: T) => string): T[] {
	const seen = new Set<string>();
	return rows.filter((row) => {
		const key = keyOf(row);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
