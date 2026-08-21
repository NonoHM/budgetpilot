import { prisma } from '$lib/server/db';
import type { BackupExport } from './schema';

type TransactionKind = BackupExport['transactions'][number]['type'];
type CategorizationRuleKind = BackupExport['categorizationRules'][number]['type'];
type NetWorthAccountTypeExport = BackupExport['netWorthAccounts'][number]['type'];
type BankConnectionStatusExport = BackupExport['bankConnections'][number]['status'];
// `direction` is a plain String column (FlowDirection lives in the domain, not in the DB), so
// the export narrows it to the two values the backup schema accepts. `kind` needs no such cast:
// it is a Prisma enum and already has the exact literal type.
type RecurringActionDirectionExport = BackupExport['recurringStreamActions'][number]['direction'];
type TagColorTokenExport = BackupExport['tags'][number]['colorToken'];

/**
 * Builds the full export of a user's data, strictly scoped by `userId`.
 * The returned ids are the DB's real cuids: this is fine because on import they are
 * regenerated anyway and never reinjected as-is (see import.ts).
 */
export async function buildBackupExport(userId: string): Promise<BackupExport> {
	const [
		user,
		accounts,
		categories,
		importBatches,
		columnMappings,
		transactions,
		monthlyBudgets,
		categoryRules,
		categorizationRules,
		categoryNatureMappings,
		netWorthAccounts,
		netWorthSnapshots,
		savingsGoals,
		bankConnections,
		recurringStreamActions,
		tags,
		transactionTags,
		transactionSplits
	] = await Promise.all([
		prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
		prisma.account.findMany({
			where: { userId },
			select: {
				id: true,
				name: true,
				currency: true,
				exponent: true,
				source: true,
				netWorthAccountId: true,
				bankConnectionId: true,
				providerAccountId: true,
				providerCashAccountType: true
			}
		}),
		prisma.category.findMany({
			where: { userId },
			select: { id: true, name: true }
		}),
		prisma.importBatch.findMany({
			where: { userId },
			select: {
				id: true,
				source: true,
				fileName: true,
				profile: true,
				rowCount: true,
				importedRows: true,
				duplicateRows: true,
				invalidRows: true,
				periodStart: true,
				periodEnd: true
			}
		}),
		prisma.columnMapping.findMany({
			where: { userId },
			select: {
				fingerprint: true,
				matchBy: true,
				dateColumn: true,
				labelColumn: true,
				amountColumn: true,
				categoryColumn: true,
				dateIndex: true,
				labelIndex: true,
				amountIndex: true,
				categoryIndex: true,
				columnCount: true,
				useCount: true
			}
		}),
		prisma.transaction.findMany({
			where: { userId },
			select: {
				id: true,
				accountId: true,
				categoryId: true,
				importBatchId: true,
				date: true,
				label: true,
				amountCents: true,
				currency: true,
				exponent: true,
				type: true,
				source: true,
				notes: true,
				bankOperationType: true,
				manualCategory: true,
				natureManual: true,
				dedupeKey: true,
				metadataJson: true
			}
		}),
		prisma.monthlyBudget.findMany({
			where: { userId },
			select: { id: true, categoryName: true, amountCents: true, currency: true, exponent: true }
		}),
		prisma.categoryRule.findMany({
			where: { userId },
			select: {
				id: true,
				name: true,
				matchText: true,
				targetCategory: true,
				targetNature: true,
				enabled: true
			}
		}),
		prisma.categorizationRule.findMany({
			where: { userId },
			select: { id: true, pattern: true, targetCategory: true, type: true, active: true }
		}),
		prisma.categoryNatureMapping.findMany({
			where: { userId },
			select: { id: true, categoryName: true, nature: true }
		}),
		// Includes soft-deleted accounts (deletedAt set) so their history round-trips through
		// a restore rather than being silently dropped.
		prisma.netWorthAccount.findMany({
			where: { userId },
			select: {
				id: true,
				name: true,
				type: true,
				balanceCents: true,
				currency: true,
				exponent: true,
				deletedAt: true
			}
		}),
		prisma.netWorthSnapshot.findMany({
			where: { userId },
			select: {
				id: true,
				accountId: true,
				type: true,
				balanceCents: true,
				currency: true,
				exponent: true,
				capturedAt: true
			}
		}),
		// Includes soft-deleted goals? No — deleted goals are intentionally dropped, consistent
		// with every other soft-deletable model except NetWorthAccount (whose deletion must
		// preserve snapshot history; a deleted goal has no such dependent history to preserve).
		prisma.savingsGoal.findMany({
			where: { userId, deletedAt: null },
			select: {
				id: true,
				name: true,
				targetAmountCents: true,
				netWorthAccountId: true,
				currentAmountCents: true,
				startingBalanceCents: true,
				currency: true,
				exponent: true,
				targetDate: true,
				reachedAt: true,
				reachedBannerDismissedAt: true
			}
		}),
		// Non-sensitive metadata ONLY: credentialsEncrypted and providerSessionId must
		// never leave the DB through an export (the backup schema also rejects them).
		prisma.bankConnection.findMany({
			where: { userId },
			select: {
				id: true,
				provider: true,
				status: true,
				aspspName: true,
				aspspCountry: true,
				consentExpiresAt: true,
				lastSyncAt: true
			}
		}),
		prisma.recurringStreamAction.findMany({
			where: { userId },
			select: {
				id: true,
				kind: true,
				direction: true,
				normalizedLabel: true,
				label: true,
				anchorTransactionIds: true,
				dueDate: true,
				createdAt: true,
				updatedAt: true
			}
		}),
		prisma.tag.findMany({
			where: { userId },
			select: { id: true, name: true, colorToken: true }
		}),
		// Scoped through the transaction rather than a userId column, because TransactionTag has
		// none by design: a link's owner is its transaction's owner (see the model comment). This
		// is the only place the export reaches a row without a userId of its own.
		//
		// BOTH sides are scoped, not just the transaction, and that second conjunct is not
		// redundant. "A link's tag and its transaction have the same owner" is an invariant the
		// write path maintains and NO constraint enforces: the two foreign keys are independent,
		// and there is no composite key tying Tag.userId to Transaction.userId. Scoping only the
		// transaction would mean a single bad write anywhere ever emits a pair whose tagId is
		// absent from the `tags` array above, and assertReferentialIntegrity refuses exactly that
		// on the way back in. The user's own export would become permanently unrestorable. Both
		// columns are indexed, so agreeing by construction costs nothing.
		prisma.transactionTag.findMany({
			where: { transaction: { userId }, tag: { userId } },
			select: { transactionId: true, tagId: true }
		}),
		// Same shape and the same two conjuncts as transactionTags above, for the same reason:
		// TransactionSplit has no userId of its own, and "a part's category and its transaction
		// have the same owner" is an invariant the write path maintains and NO constraint
		// enforces. The two foreign keys are independent; nothing ties Category.userId to
		// Transaction.userId. Scoping only the transaction would let one bad write anywhere emit
		// a part whose categoryId is absent from the `categories` array, which
		// assertReferentialIntegrity refuses on the way back in — making the user's own export
		// permanently unrestorable. Both columns are indexed, so agreeing by construction is free.
		//
		// Ordered so the payload is stable across exports: a diff between two backups of an
		// unchanged database should be empty, and `position` is user-visible (it decides which
		// part carries the rounding cent).
		prisma.transactionSplit.findMany({
			where: { transaction: { userId }, category: { userId } },
			select: {
				id: true,
				transactionId: true,
				categoryId: true,
				amountCents: true,
				position: true,
				note: true
			},
			orderBy: [{ transactionId: 'asc' }, { position: 'asc' }]
		})
	]);

	return {
		formatVersion: 1,
		exportedAt: new Date().toISOString(),
		userEmail: user.email,
		accounts,
		// No `defaultKey`. The schema still ACCEPTS one so that a file written before #162
		// restores unchanged, but nothing emits one any more: the stored name is the name, so
		// there is no second identity for a backup to carry.
		categories,
		// No `id`: nothing references a mapping, so it restores as a fresh row keyed by its own
		// (userId, fingerprint). `lastUsedAt` is left out for the same reason `useCount` is kept:
		// the count is what the recap sentence reports, the timestamp is not portable state worth
		// carrying across a restore.
		//
		// `matchBy` is narrowed rather than cast. The column is a string in the database and the
		// only writer is the validated store, so a row carrying anything else is corruption; a cast
		// would put it in the payload and let the restore refuse it later, on the user's machine,
		// as a malformed backup. Refusing at export names the row instead.
		columnMappings: columnMappings.map((mapping) => ({
			...mapping,
			matchBy: assertMatchBy(mapping.matchBy, mapping.fingerprint)
		})),
		importBatches: importBatches.map((batch) => ({
			...batch,
			periodStart: batch.periodStart ? batch.periodStart.toISOString() : null,
			periodEnd: batch.periodEnd ? batch.periodEnd.toISOString() : null
		})),
		transactions: transactions.map((transaction) => ({
			...transaction,
			date: transaction.date.toISOString(),
			type: transaction.type as TransactionKind
		})),
		monthlyBudgets,
		categoryRules,
		categorizationRules: categorizationRules.map((rule) => ({
			...rule,
			type: rule.type as CategorizationRuleKind
		})),
		categoryNatureMappings,
		netWorthAccounts: netWorthAccounts.map((account) => ({
			...account,
			type: account.type as NetWorthAccountTypeExport,
			deletedAt: account.deletedAt ? account.deletedAt.toISOString() : null
		})),
		netWorthSnapshots: netWorthSnapshots.map((snapshot) => ({
			...snapshot,
			type: snapshot.type as NetWorthAccountTypeExport,
			capturedAt: snapshot.capturedAt.toISOString()
		})),
		savingsGoals: savingsGoals.map((goal) => ({
			...goal,
			targetDate: goal.targetDate ? goal.targetDate.toISOString() : null,
			reachedAt: goal.reachedAt ? goal.reachedAt.toISOString() : null,
			reachedBannerDismissedAt: goal.reachedBannerDismissedAt
				? goal.reachedBannerDismissedAt.toISOString()
				: null
		})),
		bankConnections: bankConnections.map((connection) => ({
			...connection,
			status: connection.status as BankConnectionStatusExport,
			consentExpiresAt: connection.consentExpiresAt
				? connection.consentExpiresAt.toISOString()
				: null,
			lastSyncAt: connection.lastSyncAt ? connection.lastSyncAt.toISOString() : null
		})),
		recurringStreamActions: recurringStreamActions.map((action) => ({
			...action,
			direction: action.direction as RecurringActionDirectionExport,
			dueDate: action.dueDate ? action.dueDate.toISOString() : null,
			createdAt: action.createdAt.toISOString(),
			updatedAt: action.updatedAt.toISOString()
		})),
		tags: tags.map((tag) => ({
			...tag,
			// `colorToken` is a plain String column; the backup schema accepts only the closed
			// palette set. A row holding anything else cannot have been written by this app.
			colorToken: tag.colorToken as TagColorTokenExport
		})),
		transactionTags,
		transactionSplits
	};
}

/**
 * Narrows a stored `matchBy` to the union the payload declares, refusing anything else.
 *
 * The only writer is `saveColumnMapping`, which validates, so an unexpected value means the row
 * was written by something that bypassed it. Throwing here is the loud half of that discovery.
 */
function assertMatchBy(value: string, fingerprint: string): 'name' | 'position' {
	if (value === 'name' || value === 'position') return value;
	throw new Error(
		`column mapping ${fingerprint.slice(0, 12)} has an unknown matchBy (${JSON.stringify(value)}); it was not written through saveColumnMapping`
	);
}
