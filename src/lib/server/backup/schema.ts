import { z } from 'zod';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import { DEFAULT_CATEGORY_KEYS } from '$lib/domain/categories';
import { NET_WORTH_ACCOUNT_TYPES } from '$lib/domain/netWorth';

const transactionKind = z.enum(['income', 'expense']);
const categorizationRuleKind = z.enum(['income', 'expense', 'any']);

/**
 * Strict Zod schemas to validate an imported backup file, BEFORE any DB write.
 * `.strict()` on each object: any undeclared field (passwordHash, real userId, role, ...)
 * is automatically rejected, even if present in the payload.
 */

const isoDateString = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
	message: 'date ISO invalide'
});

const transactionNature = z.enum(TRANSACTION_NATURES);
const defaultCategoryKey = z.enum(DEFAULT_CATEGORY_KEYS);

const backupAccountSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(200),
		currency: z.string().min(1).max(10),
		source: z.string().min(1).max(200),
		// Absent from exports predating this link: treated as null (no net worth account
		// connected) rather than required, so an older backup file still restores.
		netWorthAccountId: z.string().min(1).nullable().optional(),
		// Absent from exports predating bank connections: same treatment.
		bankConnectionId: z.string().min(1).nullable().optional(),
		// Provider-side account uid of a bank-sync bucket (opaque, non-sensitive).
		providerAccountId: z.string().min(1).max(500).nullable().optional(),
		// Provider-side cash account type of a bank-sync bucket (opaque, non-sensitive
		// metadata — feeds a net worth account type suggestion, never authoritative).
		providerCashAccountType: z.string().min(1).max(100).nullable().optional()
	})
	.strict();

/**
 * Non-sensitive connection metadata ONLY. `credentialsEncrypted` and `providerSessionId`
 * are deliberately absent — `.strict()` rejects a hand-edited backup that smuggles them
 * in — so a restored connection can never come back functional with imported secrets.
 */
const backupBankConnectionSchema = z
	.object({
		id: z.string().min(1),
		provider: z.string().min(1).max(200),
		status: z.enum(['active', 'expired', 'revoked', 'error']),
		// Display metadata (bank name/country) — absent from older exports.
		aspspName: z.string().max(200).nullable().optional(),
		aspspCountry: z.string().max(10).nullable().optional(),
		consentExpiresAt: isoDateString.nullable(),
		lastSyncAt: isoDateString.nullable()
	})
	.strict();

const backupCategorySchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(200),
		// Absent from pre-i18n exports: re-derived on import from the canonical FR name.
		// Constrained to real system keys: a defaultKey forged outside this enum is
		// rejected here; a defaultKey valid but inconsistent with `name` is neutralized
		// on import (see normalizeCategoryDefaultKey in backup/import.ts).
		defaultKey: defaultCategoryKey.nullable().optional()
	})
	.strict();

const backupImportBatchSchema = z
	.object({
		id: z.string().min(1),
		source: z.string().min(1).max(200),
		fileName: z.string().max(500).nullable(),
		profile: z.string().min(1).max(200),
		rowCount: z.number().int(),
		importedRows: z.number().int(),
		duplicateRows: z.number().int(),
		invalidRows: z.number().int(),
		periodStart: isoDateString.nullable(),
		periodEnd: isoDateString.nullable()
	})
	.strict();

const backupTransactionSchema = z
	.object({
		id: z.string().min(1),
		accountId: z.string().min(1),
		categoryId: z.string().min(1),
		importBatchId: z.string().min(1).nullable(),
		date: isoDateString,
		label: z.string().min(1).max(2000),
		amountCents: z.number().int(),
		type: transactionKind.nullable(),
		source: z.string().min(1).max(200),
		notes: z.string().max(10_000).nullable(),
		bankOperationType: z.string().max(500).nullable(),
		manualCategory: z.string().max(500).nullable(),
		natureManual: transactionNature.nullable(),
		dedupeKey: z.string().max(500).nullable(),
		metadataJson: z.string().max(100_000).nullable()
	})
	.strict();

const backupMonthlyBudgetSchema = z
	.object({
		id: z.string().min(1),
		categoryName: z.string().min(1).max(200),
		amountCents: z.number().int()
	})
	.strict();

const backupCategoryRuleSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(200),
		matchText: z.string().min(1).max(500),
		targetCategory: z.string().min(1).max(200),
		targetNature: transactionNature.nullable(),
		enabled: z.boolean()
	})
	.strict();

const backupCategorizationRuleSchema = z
	.object({
		id: z.string().min(1),
		pattern: z.string().min(1).max(500),
		targetCategory: z.string().min(1).max(200),
		type: categorizationRuleKind.nullable(),
		active: z.boolean()
	})
	.strict();

const backupCategoryNatureMappingSchema = z
	.object({
		id: z.string().min(1),
		categoryName: z.string().min(1).max(200),
		nature: transactionNature
	})
	.strict();

const netWorthAccountType = z.enum(NET_WORTH_ACCOUNT_TYPES);

const backupNetWorthAccountSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(200),
		type: netWorthAccountType,
		balanceCents: z.number().int(),
		deletedAt: isoDateString.nullable()
	})
	.strict();

const backupNetWorthSnapshotSchema = z
	.object({
		id: z.string().min(1),
		accountId: z.string().min(1),
		type: netWorthAccountType,
		balanceCents: z.number().int(),
		capturedAt: isoDateString
	})
	.strict();

const backupSavingsGoalSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(200),
		targetAmountCents: z.number().int(),
		netWorthAccountId: z.string().min(1).nullable(),
		currentAmountCents: z.number().int(),
		startingBalanceCents: z.number().int(),
		targetDate: isoDateString.nullable(),
		reachedAt: isoDateString.nullable(),
		reachedBannerDismissedAt: isoDateString.nullable()
	})
	.strict();

export const backupExportSchema = z
	.object({
		formatVersion: z.literal(1),
		exportedAt: isoDateString,
		userEmail: z.string().min(1),
		accounts: z.array(backupAccountSchema),
		categories: z.array(backupCategorySchema),
		importBatches: z.array(backupImportBatchSchema),
		transactions: z.array(backupTransactionSchema),
		monthlyBudgets: z.array(backupMonthlyBudgetSchema),
		categoryRules: z.array(backupCategoryRuleSchema),
		categorizationRules: z.array(backupCategorizationRuleSchema),
		categoryNatureMappings: z.array(backupCategoryNatureMappingSchema),
		// Absent from exports predating net-worth backup coverage: defaulted to empty rather
		// than required, so an older file still restores (minus net-worth data) instead of
		// being rejected outright.
		netWorthAccounts: z.array(backupNetWorthAccountSchema).default([]),
		netWorthSnapshots: z.array(backupNetWorthSnapshotSchema).default([]),
		// Absent from exports predating savings goals: defaulted to empty rather than required.
		savingsGoals: z.array(backupSavingsGoalSchema).default([]),
		// Absent from exports predating bank connections: defaulted to empty.
		bankConnections: z.array(backupBankConnectionSchema).default([])
	})
	.strict();

export type BackupExport = z.infer<typeof backupExportSchema>;
