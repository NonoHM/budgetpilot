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

/**
 * The narrowest width any provider gives a `String` column that carries no native-type
 * override: MySQL's `varchar(191)`.
 *
 * Every bound above it used to make a restore's outcome depend on the engine — the same file
 * restored on SQLite and PostgreSQL and failed at the insert on MySQL alone. That is the exact
 * class of divergence the multi-database work exists to remove, so the validator now refuses
 * what the narrowest provider cannot store, before any write, with the same message everywhere.
 *
 * 191 rather than the much smaller value each column's write path enforces today (60 for a
 * manual category, 80 for a rule field or a budget category, 120 for a bucket or goal name):
 * those caps bound what this version of the app produces, not what a row written by an older
 * one holds, and rejecting a legal export to make a comment tidier is not worth it. 191 rejects
 * nothing MySQL would have accepted.
 *
 * Columns with a `@db.Text` or a wider `@db.VarChar(n)` in NATIVE_TYPE_OVERRIDES are not bound
 * by this and keep their own, larger, bounds.
 */
const MAX_PORTABLE_STRING = 191;

/**
 * The two bounds on `RecurringStreamAction.anchorTransactionIds`, which are a pair and have to
 * be changed as one.
 *
 * The cell is a JSON array of transaction ids and it is the one column a restore *rewrites*: the
 * ids it holds are remapped to the ones this restore regenerated. A freshly generated cuid is 25
 * characters, so a remapped cell can be larger than the cell that was validated on the way in,
 * and nothing re-validates it before the insert. Bounding only the input therefore lets an
 * oversized cell be written, leave through an export that never runs this schema, and be rejected
 * on the way back in — the user is told their own export is corrupt.
 *
 * So the write path truncates to MAX_ANCHOR_IDS (see `restoreBackup`) and the two numbers satisfy
 *
 *     MAX_ANCHOR_IDS * 28 + 2 <= MAX_ANCHOR_CELL_CHARS
 *
 * where 28 = 25 (cuid) + 2 (quotes) + 1 (comma) per element, plus 2 for the brackets. A spec
 * asserts both the arithmetic and the property it stands for — that the cell actually written can
 * never exceed what this schema accepts.
 *
 * 250 rather than the "~52 for a weekly stream" this was first justified with, which bounded
 * neither the input nor the output. The real ceiling: an action's anchors are the whole
 * similar-amount occurrence group over the 12-month lookback, and the cadence test uses the
 * MEDIAN interval, so a group counts as weekly with a median of 5 days. That is about
 * 2 * 365 / 5 = 146 occurrences for an ordinary user with a frequent same-amount payment. 250
 * clears that with room, and truncation keeps the NEWEST ids (`.slice(-MAX_ANCHOR_IDS)`) because
 * dropping the oldest only weakens the action to label-based matching, which is what the fallback
 * exists for.
 */
export const MAX_ANCHOR_IDS = 250;
export const MAX_ANCHOR_CELL_CHARS = 7_500;

const transactionNature = z.enum(TRANSACTION_NATURES);
const defaultCategoryKey = z.enum(DEFAULT_CATEGORY_KEYS);

const backupAccountSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(200),
		currency: z.string().min(1).max(10),
		source: z.string().min(1).max(MAX_PORTABLE_STRING),
		// Absent from exports predating this link: treated as null (no net worth account
		// connected) rather than required, so an older backup file still restores.
		netWorthAccountId: z.string().min(1).nullable().optional(),
		// Absent from exports predating bank connections: same treatment.
		bankConnectionId: z.string().min(1).nullable().optional(),
		// Provider-side account uid of a bank-sync bucket (opaque, non-sensitive).
		//
		// The one bound deliberately left above MAX_PORTABLE_STRING, and the only remaining
		// entry in schemaGenerator.ts's gap list. Unlike every other column there, nothing in
		// the app decides its length: `syncBankConnection()` writes the uid the bank's API
		// returned, uncapped. Narrowing this to 191 would reject a SQLite or PostgreSQL
		// install's own export if its bank ever returned a longer uid — trading a divergence
		// for a data-loss path. Closing it properly means capping the write and giving the
		// column a `@db.VarChar(n)`, which is a schema decision, not a bounds edit.
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
		provider: z.string().min(1).max(MAX_PORTABLE_STRING),
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
		name: z.string().min(1).max(MAX_PORTABLE_STRING),
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
		source: z.string().min(1).max(MAX_PORTABLE_STRING),
		fileName: z.string().max(500).nullable(),
		profile: z.string().min(1).max(MAX_PORTABLE_STRING),
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
		source: z.string().min(1).max(MAX_PORTABLE_STRING),
		notes: z.string().max(10_000).nullable(),
		bankOperationType: z.string().max(500).nullable(),
		manualCategory: z.string().max(MAX_PORTABLE_STRING).nullable(),
		natureManual: transactionNature.nullable(),
		dedupeKey: z.string().max(500).nullable(),
		metadataJson: z.string().max(100_000).nullable()
	})
	.strict();

const backupMonthlyBudgetSchema = z
	.object({
		id: z.string().min(1),
		categoryName: z.string().min(1).max(MAX_PORTABLE_STRING),
		amountCents: z.number().int()
	})
	.strict();

const backupCategoryRuleSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(MAX_PORTABLE_STRING),
		matchText: z.string().min(1).max(500),
		targetCategory: z.string().min(1).max(MAX_PORTABLE_STRING),
		targetNature: transactionNature.nullable(),
		enabled: z.boolean()
	})
	.strict();

const backupCategorizationRuleSchema = z
	.object({
		id: z.string().min(1),
		pattern: z.string().min(1).max(500),
		targetCategory: z.string().min(1).max(MAX_PORTABLE_STRING),
		type: categorizationRuleKind.nullable(),
		active: z.boolean()
	})
	.strict();

const backupCategoryNatureMappingSchema = z
	.object({
		id: z.string().min(1),
		categoryName: z.string().min(1).max(MAX_PORTABLE_STRING),
		nature: transactionNature
	})
	.strict();

const netWorthAccountType = z.enum(NET_WORTH_ACCOUNT_TYPES);

const backupNetWorthAccountSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(MAX_PORTABLE_STRING),
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
		name: z.string().min(1).max(MAX_PORTABLE_STRING),
		targetAmountCents: z.number().int(),
		netWorthAccountId: z.string().min(1).nullable(),
		currentAmountCents: z.number().int(),
		startingBalanceCents: z.number().int(),
		targetDate: isoDateString.nullable(),
		reachedAt: isoDateString.nullable(),
		reachedBannerDismissedAt: isoDateString.nullable()
	})
	.strict();

const backupRecurringStreamActionSchema = z
	.object({
		id: z.string().min(1),
		kind: z.enum(['IGNORE', 'PAID', 'EXCLUDE']),
		direction: z.enum(['income', 'expense']),
		normalizedLabel: z.string().min(1).max(MAX_PORTABLE_STRING),
		label: z.string().min(1).max(MAX_PORTABLE_STRING),
		// Bound above MAX_PORTABLE_STRING on purpose, and legal there: the column carries a
		// `@db.Text` override in NATIVE_TYPE_OVERRIDES, so MySQL stores it as `text` like every
		// other provider. See MAX_ANCHOR_IDS for why the two bounds are a pair.
		anchorTransactionIds: z.string().max(MAX_ANCHOR_CELL_CHARS),
		dueDate: isoDateString.nullable(),
		createdAt: isoDateString,
		updatedAt: isoDateString
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
		bankConnections: z.array(backupBankConnectionSchema).default([]),
		// Absent from exports predating recurring stream actions: defaulted to empty.
		//
		// The one root array with a length bound, because it is the one whose size decides how
		// much work the restore does per row rather than in bulk: every transaction an action
		// anchors leaves the bulk `createMany` and gets its own `create`, inside the single
		// interactive transaction. Unbounded, a hand-edited file well under the upload limit
		// holds a pooled connection for the whole LONG_TRANSACTION_OPTIONS ceiling. It rolls
		// back cleanly — this is availability, not corruption — but the bound costs nothing:
		// 500 actions is far past what detection can produce for one user.
		recurringStreamActions: z.array(backupRecurringStreamActionSchema).max(500).default([])
	})
	.strict();

export type BackupExport = z.infer<typeof backupExportSchema>;
