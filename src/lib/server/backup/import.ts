import { DEFAULT_CURRENCY, DEFAULT_EXPONENT } from '$lib/domain/money';
import * as m from '$lib/paraglide/messages';
import { prisma } from '$lib/server/db';
import { LONG_TRANSACTION_OPTIONS } from '$lib/server/dbTransaction';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { manualCategoryUpdate } from '$lib/server/transactions/manualCategory';
import { dedupeKeyUpdate } from '$lib/server/import/dedupeKey';
import { assignDedupeKeys } from '$lib/server/import/dedupeRecompute';
import { normalizeTagName, MAX_TAGS_PER_TRANSACTION } from '$lib/domain/tags';
import {
	isValidSplitPartAmount,
	MIN_SPLITS_PER_TRANSACTION,
	MAX_SPLITS_PER_TRANSACTION,
	normalizeSplitNote
} from '$lib/domain/allocation';
import { MAX_ANCHOR_IDS, parseAnchorTransactionIds, type BackupExport } from './schema';
import { validateColumnMapping } from '$lib/server/import/mapping/model';
import { resolveColumnMappingsPerUser } from '$lib/server/import/mapping/store';

export class BackupImportError extends Error {}

/** Historical FR name of the sentinel, present in pre-i18n exports. */
const LEGACY_UNCLASSIFIED_NAME = 'Non catégorisé';

/**
 * Compatibility with pre-i18n exports: the "to classify" sentinel is stored there under its
 * old FR name. Normalized to the current slug everywhere a category is
 * referenced by name, otherwise the "to classify" pile would no longer recognize these rows.
 */
function normalizeCategoryName(name: string): string {
	return name === LEGACY_UNCLASSIFIED_NAME ? UNCLASSIFIED_CATEGORY : name;
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
/**
 * The denomination a restored row is written with: the file's own, or the application default when
 * the file predates the columns.
 *
 * This is the SECOND call site of the stamp the migration performs, and it exists for the same
 * reason: a backup taken before `currency` and `exponent` were columns is exponent-2 euros BY
 * CONSTRUCTION, because that is the only thing the schema of the day could express. So the `??` is
 * a fact rather than a guess, and writing it here means every restored row has a denomination
 * somebody wrote, exactly as every migrated row does. There is no database default to fall back on
 * (see prisma/schema.prisma), which is what makes the absence of this call a compile error rather
 * than a silent euro.
 *
 * It is NOT applied to `TransactionSplit`: a part is denominated by its parent, and giving a part
 * its own currency is what would let `sum(parts) === parent.amountCents` become false.
 */
function restoredDenomination(row: { currency?: string; exponent?: number }): {
	currency: string;
	exponent: number;
} {
	return {
		currency: row.currency ?? DEFAULT_CURRENCY,
		exponent: row.exponent ?? DEFAULT_EXPONENT
	};
}

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
		// Position is free, and stating why stops the next reader moving it "to be safe": nothing
		// references a ColumnMapping and it references nothing by foreign key except its owner,
		// exactly like RecurringStreamAction above.
		await tx.columnMapping.deleteMany({ where: { userId } });
		// TransactionTag is deliberately absent from this list: it has no userId to scope a
		// deleteMany by, and it cascades from BOTH parents, the first of which (transaction) is
		// already deleted above. A test asserts no orphan link survives a restore.
		//
		// TransactionSplit is absent for the same reason but NOT by the same mechanism, and the
		// difference is worth stating because it constrains the order above. It cascades from
		// Transaction ONLY — Category deliberately does not cascade, since deleting a category
		// must never delete money. So a part dies with its transaction at the top of this block
		// and nothing else can remove it. That ordering is already correct: `transaction` is
		// purged first, so by the time `category` is purged no part remains to block it on the
		// foreign key. Moving the category purge above the transaction purge would break the
		// restore on every account that has ever used a répartition.
		await tx.tag.deleteMany({ where: { userId } });

		// b. Recreation: NetWorthAccount first (ids regenerated, one by one to build the id
		// map, INCLUDING soft-deleted ones — their history round-trips through a restore just
		// like active accounts), so that Account.netWorthAccountId can be remapped below.
		const netWorthAccountIdMap = new Map<string, string>();
		for (const account of payload.netWorthAccounts) {
			const created = await tx.netWorthAccount.create({
				data: {
					...restoredDenomination(account),
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
					...restoredDenomination(goal),
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
		// Keyed on the RESTORED account rather than on the file's, because two file accounts whose
		// names fold together are merged into one bucket above and the second one's transactions
		// follow the first. A map keyed on the file's id would hand a merged row the provider
		// account of a bucket it does not live in, and the deduplication key would name a
		// provider account that never held it.
		const providerAccountIdByBucket = new Map<string, string | null>();
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
					...restoredDenomination(account),
					userId,
					name: account.name,
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
			providerAccountIdByBucket.set(created.id, account.providerAccountId ?? null);
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

			// A `defaultKey` in the payload is READ AND IGNORED, deliberately, and the schema goes
			// on accepting one so that every file written before #162 still restores. It used to
			// be sanitised here, because a hand-edited backup could pair a valid key with a
			// mismatched name (name="Compte piégé" + defaultKey="income" displayed as "Revenus")
			// and hand the restorer a category that showed a name nobody had written. That whole
			// class is gone rather than defended against: the stored name is the only name, so
			// there is nothing a forged key can make a row claim.
			const created = await tx.category.create({
				data: { userId, name, nameKey },
				select: { id: true }
			});
			categoryIdMap.set(category.id, created.id);
			categoryKeyMap.set(nameKey, created.id);
		}

		// Same shape as categories above: created one at a time to capture the regenerated id,
		// first-wins on a folded-name collision. Tag counts are small, so this costs nothing.
		const tagIdMap = new Map<string, string>();
		const tagKeyMap = new Map<string, string>();
		for (const tag of payload.tags) {
			const name = normalizeTagName(tag.name);
			// The one place a restore drops data the validator accepted: `z.string().min(1)` passes
			// a whitespace-only name, which normalizes to ''. Skipped rather than stored, and every
			// pair naming it is then dropped below, after assertReferentialIntegrity has already
			// approved those pairs. Deliberate: a tag whose name is invisible is worse than no tag.
			if (!name) continue;
			const nameKey = computeNameKey(name);
			const alreadyRestored = tagKeyMap.get(nameKey);
			if (alreadyRestored) {
				tagIdMap.set(tag.id, alreadyRestored);
				continue;
			}

			const created = await tx.tag.create({
				data: { userId, name, nameKey, colorToken: tag.colorToken },
				select: { id: true }
			});
			tagIdMap.set(tag.id, created.id);
			tagKeyMap.set(nameKey, created.id);
		}

		for (const mapping of payload.columnMappings) {
			await tx.columnMapping.create({
				data: {
					userId,
					fingerprint: mapping.fingerprint,
					matchBy: mapping.matchBy,
					dateColumn: mapping.dateColumn,
					labelColumn: mapping.labelColumn,
					amountColumn: mapping.amountColumn,
					categoryColumn: mapping.categoryColumn,
					dateIndex: mapping.dateIndex,
					labelIndex: mapping.labelIndex,
					amountIndex: mapping.amountIndex,
					categoryIndex: mapping.categoryIndex,
					columnCount: mapping.columnCount,
					useCount: mapping.useCount
				}
			});
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

		// Two reasons a transaction needs its regenerated id captured, so the set is their union.
		//
		// Anchors: a recurring stream action points at transactions by id inside a JSON cell, and
		// those ids are regenerated by this restore like every other id in the file. An id left as
		// the file wrote it would, after a restore into another account, name a row belonging to
		// somebody else.
		//
		// Tags: a TransactionTag pair names a transaction by id, and `createMany` cannot return
		// generated ids, so the only way to know the new id is to create that row on its own.
		// Bounded by the relative bound on `transactionTags` (see backup/schema.ts), which is what
		// keeps this loop from being an availability problem on a hand-edited file.
		//
		// Splits: same mechanism as tags. A part names its transaction by id and `createMany`
		// cannot return generated ids, so a split transaction has to be created on its own.
		// Bounded by the relative bound on `transactionSplits` (see backup/schema.ts).
		//
		// Everything outside the union keeps the bulk `createMany` path, and the union is empty
		// for any backup carrying neither an action nor a tag nor a split, which is every file
		// written before those features.
		const idCapturingTransactionIds = new Set([
			...payload.recurringStreamActions.flatMap((action) =>
				parseAnchorTransactionIds(action.anchorTransactionIds)
			),
			...payload.transactionTags.map((link) => link.transactionId),
			...payload.transactionSplits.map((split) => split.transactionId)
		]);
		const transactionIdMap = new Map<string, string>();

		// RECOMPUTED, never taken from the file, and this is a correction rather than a tidy-up.
		//
		// `dedupeKey` is an exported format as well as a stored one, and the key names the account
		// a row lands on. A restore regenerates every id, so a key copied verbatim names an account
		// that does not exist on this instance: the row then deduplicates against nothing, and the
		// user's next import of the same statement doubles it with nothing to report it.
		//
		// The ordinal is assigned over the payload's rows in payload order, which is the same rule
		// the write path uses over a batch. Two identical rows therefore get 0 and 1 rather than
		// one key, which is what keeps the restore from failing on
		// `@@unique([userId, dedupeKeyHash])` or, worse, losing one of them.
		//
		// `keyed` comes from whether the FILE carried a key. A manual transaction has none, and
		// inventing one would let a row the user typed compete for identity with rows a file
		// produced. A row with no direction cannot be keyed at all and `assignDedupeKeys` returns
		// null for it, which leaves it invisible to deduplication rather than wrongly matched.
		const restoredDedupeKeys = assignDedupeKeys(
			payload.transactions.map((transaction) => ({
				id: transaction.id,
				source: transaction.source,
				accountId: accountIdMap.get(transaction.accountId)!,
				// The stored `DateTime` truncated, which is what the key carries. `transaction.date`
				// is validated as parseable and NOT as date-only, so a file may legitimately carry a
				// full instant here (`schema.ts`'s `isoDateString`).
				date: new Date(transaction.date).toISOString().slice(0, 10),
				label: transaction.label,
				amountCents: transaction.amountCents,
				type: transaction.type,
				...restoredDenomination(transaction),
				providerAccountId:
					providerAccountIdByBucket.get(accountIdMap.get(transaction.accountId)!) ?? null,
				entryReference: readEntryReference(transaction.metadataJson),
				keyed: transaction.dedupeKey !== null
			}))
		);

		const transactionData = payload.transactions.map((transaction) => ({
			oldId: transaction.id,
			data: {
				...restoredDenomination(transaction),
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
				// Recomputed here, never read from the file: the key names an account this restore
				// has just regenerated, and the hash is the app's own answer to "is this the same
				// row", not something a backup gets to assert.
				...dedupeKeyUpdate(restoredDedupeKeys.get(transaction.id)),
				metadataJson: transaction.metadataJson
			}
		}));

		const bulkTransactions = transactionData.filter(
			(entry) => !idCapturingTransactionIds.has(entry.oldId)
		);
		if (bulkTransactions.length > 0) {
			await tx.transaction.createMany({ data: bulkTransactions.map((entry) => entry.data) });
		}
		for (const entry of transactionData) {
			if (!idCapturingTransactionIds.has(entry.oldId)) continue;
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

		if (payload.transactionTags.length > 0) {
			// Bulk, unlike the transactions above: a pair carries no generated id anybody needs,
			// so nothing has to be read back. Pairs whose tag or transaction did not survive the
			// folded-name dedupe are dropped rather than kept. assertReferentialIntegrity has
			// already refused any pair naming a row absent from the FILE, so a miss here means the
			// row was merged into another, and the surviving link is already present.
			const links = payload.transactionTags
				.map((link) => ({
					transactionId: transactionIdMap.get(link.transactionId),
					tagId: tagIdMap.get(link.tagId)
				}))
				.filter(
					(link): link is { transactionId: string; tagId: string } =>
						link.transactionId !== undefined && link.tagId !== undefined
				);
			// De-duplicated: two file tags folding to one row would otherwise produce the same
			// pair twice and violate the composite primary key.
			const unique = new Map(links.map((link) => [`${link.transactionId}:${link.tagId}`, link]));
			if (unique.size > 0) {
				await tx.transactionTag.createMany({ data: [...unique.values()] });
			}
		}

		if (payload.transactionSplits.length > 0) {
			// Bulk, like the tag pairs: a part's own id is regenerated and nothing references it.
			//
			// A part whose transaction or category is missing from the id maps REFUSES the restore.
			// It does not get filtered out, and that is the one place this deliberately differs
			// from the tag pairs above.
			//
			// Dropping a tag link loses a label. Dropping a part loses MONEY: the surviving parts
			// would no longer sum to their parent, and the sum check that ran before any write
			// would already have certified a total that is no longer what got stored. Nothing
			// downstream could tell — allocationsOf would emit the shortfall as a phantom
			// remainder under the parent's category, indistinguishable from a legitimate one.
			//
			// Today this is unreachable: assertReferentialIntegrity has refused any part naming a
			// row absent from the file, and every payload category gets a map entry (folding
			// re-points both spellings at the survivor rather than losing either). But that is two
			// modules independently maintaining one invariant with nothing shared enforcing it.
			// Tags already show how it breaks — a whitespace-only name normalizes to '' and is
			// skipped, leaving no map entry — so the day a category acquires a normalization step
			// that can collapse the same way, this must fail loudly rather than quietly write a
			// répartition that no longer adds up.
			//
			// DO NOT REMOVE THIS ON THE GROUNDS THAT "THE SUM IS ALREADY CHECKED". That sentence is
			// true and is exactly the trap: the sum check runs over the PAYLOAD, before any write.
			// If a part is dropped between that check and this insert, the check has certified a
			// total that no longer matches what got stored — the guard passes while the write
			// diverges from it. A refusal here is what keeps the two describing the same thing.
			const parts = payload.transactionSplits.map((split) => ({
				transactionId: transactionIdMap.get(split.transactionId),
				categoryId: categoryIdMap.get(split.categoryId),
				amountCents: split.amountCents,
				position: split.position,
				// Normalized here too, not just in replaceSplits. A restore is a write path, and an
				// uploaded payload is the one place a note arrives without ever having passed
				// through the editor — so it is exactly where a bidi override would enter if this
				// were left to the service that this path bypasses.
				note: normalizeSplitNote(split.note) || null
			}));
			for (const [index, part] of parts.entries()) {
				if (part.transactionId === undefined) {
					throw new BackupImportError(
						m.settings_backup_error_unknown_split_transaction({
							id: payload.transactionSplits[index].transactionId
						})
					);
				}
				if (part.categoryId === undefined) {
					throw new BackupImportError(
						m.settings_backup_error_unknown_split_category({
							id: payload.transactionSplits[index].categoryId
						})
					);
				}
			}
			if (parts.length > 0) {
				await tx.transactionSplit.createMany({
					data: parts as Array<{
						transactionId: string;
						categoryId: string;
						amountCents: number;
						position: number;
						note: string | null;
					}>
				});
			}
		}

		if (payload.monthlyBudgets.length > 0) {
			await tx.monthlyBudget.createMany({
				data: dedupeByNameKey(
					payload.monthlyBudgets.map((budget) => ({
						...restoredDenomination(budget),
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
					...restoredDenomination(snapshot),
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
	const tagIds = new Set(payload.tags.map((t) => t.id));
	const transactionIds = new Set(payload.transactions.map((t) => t.id));

	// COLUMN MAPPINGS, and the two checks below are not interchangeable with the zod schema.
	//
	// The schema bounds the SHAPE: a 64 character fingerprint, a matchBy from a two-value enum,
	// column names of at most 120 characters. It cannot express that the category column is not
	// also the label column, and that is the rule whose violation creates one category per
	// merchant on every later import of that shape, repairable only by hand.
	//
	// This repository has shipped the two-predicate version of exactly this once: `replaceSplits`
	// enforced the sum invariant while the restore inserted parts with `createMany`, so a
	// hand-edited backup could write a repartition summing to anything. `validateColumnMapping` is
	// the SAME function the form path runs, not a second predicate that agrees with it today.
	//
	// A mapping arriving through a restore is more dangerous than a split was: a bad split is one
	// wrong transaction, a bad mapping decides which column is money on every future import.
	for (const mapping of payload.columnMappings) {
		const verdict = validateColumnMapping(mapping);
		if (!verdict.ok) {
			throw new BackupImportError(
				m.settings_backup_error_invalid_column_mapping({ reason: verdict.reason.code })
			);
		}
	}

	// The PER-ARRAY bound, and it is owed separately from the document-wide one. BACKUP_MAX_JSON_NODES
	// bounds this array incidentally, and an incidental bound is not the bound for this array: the
	// same argument that gave the split count its own MIN/MAX check rather than leaning on the node
	// count. Nothing deletes a mapping yet (#326), so a restore is the one path that could plant
	// thousands in a single request.
	const mappingCap = resolveColumnMappingsPerUser();
	if (payload.columnMappings.length > mappingCap) {
		throw new BackupImportError(
			m.settings_backup_error_too_many_column_mappings({ max: mappingCap })
		);
	}

	// Two mappings sharing a fingerprint would violate @@unique([userId, fingerprint]) mid-restore,
	// which aborts the enclosing transaction on PostgreSQL and takes the whole restore with it.
	// Refused by name instead, before any write.
	const fingerprints = new Set<string>();
	for (const mapping of payload.columnMappings) {
		if (fingerprints.has(mapping.fingerprint)) {
			throw new BackupImportError(
				m.settings_backup_error_duplicate_column_mapping({
					fingerprint: mapping.fingerprint.slice(0, 12)
				})
			);
		}
		fingerprints.add(mapping.fingerprint);
	}

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

	// Both sides of a pair, matching how every other foreign key here is handled: a dangling
	// transactionId or tagId fails before any write rather than being silently dropped at insert
	// time, where the user would see a successful restore missing links they had.
	for (const link of payload.transactionTags) {
		if (!transactionIds.has(link.transactionId)) {
			throw new BackupImportError(
				m.settings_backup_error_unknown_tag_transaction({ id: link.transactionId })
			);
		}
		if (!tagIds.has(link.tagId)) {
			throw new BackupImportError(m.settings_backup_error_unknown_tag({ id: link.tagId }));
		}
	}

	// THE PER-TRANSACTION CAP, checked here for the same reason the split count bounds below are:
	// the restore does not go through `setTransactionTags`, so nothing else applies it to an
	// uploaded payload. It is the exact analogue of the MIN/MAX_SPLITS_PER_TRANSACTION check, and
	// its absence was the one thing a forged tag payload could still do — every other shape
	// (dangling transaction, dangling tag, tag with no owner, off-palette colour) is already
	// refused by name.
	//
	// `schema.ts` bounds the array RELATIVELY, at transactions x MAX_TAGS_PER_TRANSACTION. That is
	// a ceiling on the total and says nothing about the distribution: 11 tags on one transaction
	// and none on the other ten is well under it. MEASURED before this check existed — a payload
	// putting 11 on a single row was accepted and stored all 11, with two consequences neither of
	// which mentions tags:
	//
	//   - the user's own untampered export then becomes UN-IMPORTABLE the moment they delete the
	//     other transactions, because the relative ceiling finally catches what the distribution
	//     always violated: "transactionTags exceeds 10, the most 1 transactions can legally carry";
	//   - the tag editor on that row cannot save. Resubmitting its own 11 tags unchanged returns
	//     `too-many`, and the only way out is to drop one.
	//
	// COUNTED AS THE RESTORE WILL STORE IT, not as the file spells it. Below, two file tags whose
	// names fold to one key become one row and one link, a whitespace-only name is skipped along
	// with every link naming it, and identical pairs are de-duplicated before `createMany`. So the
	// count that matters is the number of distinct surviving NAME KEYS, and it is computed by
	// CALLING `normalizeTagName` and `computeNameKey` — the same two functions the restore calls —
	// rather than by restating what they do. Counting raw links instead would refuse a payload that
	// stores ten, which is a legal file.
	const tagKeyById = new Map<string, string>();
	for (const tag of payload.tags) {
		const name = normalizeTagName(tag.name);
		if (!name) continue;
		tagKeyById.set(tag.id, computeNameKey(name));
	}
	const tagKeysByTransaction = new Map<string, Set<string>>();
	for (const link of payload.transactionTags) {
		const tagKey = tagKeyById.get(link.tagId);
		if (tagKey === undefined) continue;
		let keys = tagKeysByTransaction.get(link.transactionId);
		if (!keys) {
			keys = new Set();
			tagKeysByTransaction.set(link.transactionId, keys);
		}
		keys.add(tagKey);
	}
	for (const [transactionId, keys] of tagKeysByTransaction) {
		if (keys.size > MAX_TAGS_PER_TRANSACTION) {
			throw new BackupImportError(
				m.settings_backup_error_tag_count({
					id: transactionId,
					max: MAX_TAGS_PER_TRANSACTION
				})
			);
		}
	}

	// Both sides of a part, same treatment as a tag pair and for the same reason.
	for (const split of payload.transactionSplits) {
		if (!transactionIds.has(split.transactionId)) {
			throw new BackupImportError(
				m.settings_backup_error_unknown_split_transaction({ id: split.transactionId })
			);
		}
		if (!categoryIds.has(split.categoryId)) {
			throw new BackupImportError(
				m.settings_backup_error_unknown_split_category({ id: split.categoryId })
			);
		}
	}

	// THE SUM INVARIANT, checked here because the restore is the one write path that does not go
	// through replaceSplits.
	//
	// Everywhere else, "the parts sum to their parent" holds because a single service enforces it
	// against the parent row re-read inside the same transaction. A restore inserts parts with
	// createMany, bypassing that service entirely, so without this check a hand-edited file is a
	// way to write a répartition that sums to anything at all — and the resulting rows would look
	// exactly like legitimate ones. The consequence is not cosmetic: allocationsOf would emit the
	// difference as a phantom remainder under the parent's category, so a crafted backup could
	// silently invent or destroy money in every per-category total the app shows.
	//
	// The count bounds are checked in the same pass. A part count below MIN or above MAX cannot
	// come from this app's write path, so it can only come from a hand-edited file.
	const partsByTransaction = new Map<string, { sum: number; count: number }>();
	for (const split of payload.transactionSplits) {
		const entry = partsByTransaction.get(split.transactionId) ?? { sum: 0, count: 0 };
		entry.sum += split.amountCents;
		entry.count += 1;
		partsByTransaction.set(split.transactionId, entry);
	}
	const transactionAmountById = new Map(payload.transactions.map((t) => [t.id, t.amountCents]));

	// THE PER-PART RULE, checked here for the same reason the sum is: the restore does not go
	// through replaceSplits, so nothing else applies it to an uploaded payload.
	//
	// The sum is not enough on its own, and that is the whole point of this loop. Parts of
	// −130,00 € and +50,00 € under a −80,00 € parent SUM EXACTLY, count 2, both categories
	// present — so every check above passes. Measured on a real instance: the restore was accepted
	// and /reports expenseCents went 21450 → 31450, one hundred euros of expense invented by a
	// transaction that still reads −80,00 €, because every per-category and per-nature reader takes
	// Math.abs(allocation.amountCents) and Σ|parts| is 180,00 € where |parent| is 80,00 €.
	//
	// The predicate is CALLED, never restated: it is the same function replaceSplits refuses on,
	// so the two paths cannot drift.
	//
	// A MISSING PARENT IS REFUSED HERE, not asserted away with `!`. The loop above has already
	// refused any part naming a transaction absent from the file, so `get` cannot return undefined
	// today — but `!` erases at runtime, and the predicate compares signs, so an undefined parent
	// would make it answer TRUE for every negative part: `(-2000 > 0) === (undefined >= 0)` is
	// `false === false`. Negative parts are most of this app's parts, so that failure is open and
	// silent, in the common direction. The sum check below carries the same `!` and fails CLOSED
	// (`sum !== undefined` always holds), which is exactly why the two read as equally safe from
	// three lines away and are not.
	//
	// BREAK-CHECKED, and the result is worth carrying: removing this clause alone changes nothing,
	// because the dangling-transaction loop refuses first. Removing BOTH still refuses — by the sum
	// check, under « les parts ne totalisent pas son montant », which is a true refusal with a
	// false explanation. So what this clause buys is not the refusal; it is that the predicate's
	// contract is honoured where it is called, rather than resting on a neighbouring check whose
	// fail-closed behaviour is an accident of comparing against `undefined` with `!==`.
	for (const split of payload.transactionSplits) {
		const parentAmountCents = transactionAmountById.get(split.transactionId);
		if (
			parentAmountCents === undefined ||
			!isValidSplitPartAmount(split.amountCents, parentAmountCents)
		) {
			throw new BackupImportError(
				m.settings_backup_error_split_amount({ id: split.transactionId })
			);
		}
	}

	for (const [transactionId, { sum, count }] of partsByTransaction) {
		const parentAmountCents = transactionAmountById.get(transactionId)!;
		if (sum !== parentAmountCents) {
			throw new BackupImportError(
				m.settings_backup_error_split_sum_mismatch({ id: transactionId })
			);
		}
		if (count < MIN_SPLITS_PER_TRANSACTION || count > MAX_SPLITS_PER_TRANSACTION) {
			throw new BackupImportError(m.settings_backup_error_split_count({ id: transactionId }));
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

/**
 * The provider's per-account entry reference, read out of a restored row's `metadataJson`.
 *
 * Defensive on every step, because this is an UNTRUSTED boundary: the payload is a file the user
 * hands us, `metadataJson` is validated as a bounded string and never as a shape, and a hand-edited
 * one can hold anything parseable. A throw here would abort the whole restore over a cell the
 * restore does not otherwise read.
 *
 * Returning null on anything unexpected is the safe direction rather than the lenient one: the key
 * then falls back to the content branch, which is what a row with no provider reference gets
 * anyway. The opposite failure, trusting a non-string, would put an object's stringification into
 * a stored identifier.
 *
 * ASVS 5.0.0 1.5.2, on deserialization of untrusted data enforcing safe input handling.
 */
function readEntryReference(metadataJson: string | null): string | null {
	if (!metadataJson) return null;
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const reference = (parsed as Record<string, unknown>).reference;
		return typeof reference === 'string' && reference.trim() ? reference : null;
	} catch {
		return null;
	}
}
