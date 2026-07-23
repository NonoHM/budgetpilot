import { prisma } from '$lib/server/db';
import type { BackupExport } from './schema';

type TransactionKind = BackupExport['transactions'][number]['type'];
type CategorizationRuleKind = BackupExport['categorizationRules'][number]['type'];
type DefaultCategoryKeyExport = BackupExport['categories'][number]['defaultKey'];
type NetWorthAccountTypeExport = BackupExport['netWorthAccounts'][number]['type'];
type BankConnectionStatusExport = BackupExport['bankConnections'][number]['status'];

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
		transactions,
		monthlyBudgets,
		categoryRules,
		categorizationRules,
		categoryNatureMappings,
		netWorthAccounts,
		netWorthSnapshots,
		savingsGoals,
		bankConnections
	] = await Promise.all([
		prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
		prisma.account.findMany({
			where: { userId },
			select: {
				id: true,
				name: true,
				currency: true,
				source: true,
				netWorthAccountId: true,
				bankConnectionId: true,
				providerAccountId: true,
				providerCashAccountType: true
			}
		}),
		prisma.category.findMany({
			where: { userId },
			select: { id: true, name: true, defaultKey: true }
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
			select: { id: true, categoryName: true, amountCents: true }
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
			select: { id: true, name: true, type: true, balanceCents: true, deletedAt: true }
		}),
		prisma.netWorthSnapshot.findMany({
			where: { userId },
			select: { id: true, accountId: true, type: true, balanceCents: true, capturedAt: true }
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
		})
	]);

	return {
		formatVersion: 1,
		exportedAt: new Date().toISOString(),
		userEmail: user.email,
		accounts,
		categories: categories.map((category) => ({
			...category,
			defaultKey: category.defaultKey as DefaultCategoryKeyExport
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
		}))
	};
}
