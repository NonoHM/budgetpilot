import { isValidCurrencyCode } from '$lib/domain/money';
import { z } from 'zod';
import { TRANSACTION_NATURES } from '$lib/domain/transaction';
import { DEFAULT_CATEGORY_KEYS } from '$lib/domain/categories';
import { NET_WORTH_ACCOUNT_TYPES } from '$lib/domain/netWorth';
import { TAG_COLOR_TOKENS, MAX_TAGS_PER_TRANSACTION } from '$lib/domain/tags';
import { MAX_SPLITS_PER_TRANSACTION } from '$lib/domain/allocation';

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
export const MAX_PORTABLE_STRING = 191;

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

/**
 * Parses a `RecurringStreamAction.anchorTransactionIds` cell into a list of ids.
 *
 * Defensive on purpose: this schema only bounds the cell's length, so a hand-edited file can put
 * anything in it. Anything that is not a JSON array of non-empty strings yields an empty anchor
 * list, which costs the action nothing it cannot recover — matching falls back to the direction +
 * normalized label pair.
 *
 * Exported because every reader of this column must go through it. A bare `JSON.parse` on a
 * malformed cell throws, and this column is read on every dashboard page load, not just on a
 * restore. Lives here rather than in `import.ts` for exactly that reason: `import.ts` pulls in the
 * whole restore write path (prisma writes, category defaults, dedupe), and this schema module is
 * the one both the restore and the read path already import for the anchor-cell size constants
 * above.
 */
export function parseAnchorTransactionIds(serialized: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * The two bounds on how many `RecurringStreamAction` rows exist, and the gap between them.
 *
 * `MAX_RECURRING_STREAM_ACTIONS` is what the WRITE path (`recordStreamAction`) refuses to exceed.
 * `MAX_IMPORTED_RECURRING_STREAM_ACTIONS` is what the IMPORT validator accepts, and it is
 * deliberately higher rather than equal.
 *
 * The write-path check is a count-then-insert inside one transaction, which bounds normal growth
 * but cannot be exact: under READ COMMITTED — PostgreSQL's and MySQL's default, and the only
 * isolation SQLite's single writer makes moot — two concurrent submits can both read a count below
 * the cap and both insert. The overshoot is small and self-limiting.
 *
 * If the validator's bound were the same number, that small overshoot would make the user's OWN
 * export unrestorable, which is precisely the failure the write cap was added to prevent — a hard
 * equality would convert a harmless race into permanent data loss on restore. The headroom absorbs
 * it. Twice the write cap is far beyond what any race can produce and still far below the point
 * where the per-row restore work this bound exists to limit becomes a problem.
 *
 * Only lower `MAX_IMPORTED_…` if `MAX_RECURRING_STREAM_ACTIONS` goes down with it.
 */
export const MAX_RECURRING_STREAM_ACTIONS = 500;
export const MAX_IMPORTED_RECURRING_STREAM_ACTIONS = MAX_RECURRING_STREAM_ACTIONS * 2;

const transactionNature = z.enum(TRANSACTION_NATURES);
const defaultCategoryKey = z.enum(DEFAULT_CATEGORY_KEYS);

/**
 * The denomination a money-bearing row carries: its ISO 4217 code and the power of ten that scales
 * its integer minor units.
 *
 * OPTIONAL, and only because a backup written before the columns existed has neither. Such a file
 * is exponent-2 euros BY CONSTRUCTION, since that is the only thing the schema could express at the
 * time, so the restore stamps it rather than guessing: see server/backup/import.ts.
 *
 * BOTH OR NEITHER, enforced below. An earlier version of this comment claimed `.strict()` already
 * did that. It does not: `.strict()` rejects UNKNOWN keys and says nothing about two optional ones
 * being independent. MEASURED before the check existed: a payload carrying `currency: 'JOD'` with
 * no `exponent` parsed successfully, and the restore then stamped it 2, so a row meaning 1.000 JOD
 * came back meaning 10.00 JOD. That is the exact ambiguity this whole pair exists to prevent, and
 * it would have been permitted by the contract 1.0 freezes.
 */
const CURRENCY_CODE_MESSAGE = 'must be a three-letter ISO 4217 code';

const denomination = {
	// The GRAMMAR, not just a length. An uploaded backup is untrusted input, and a currency code
	// that is not three uppercase letters makes `Intl.NumberFormat` raise a `RangeError` on every
	// screen that renders the row it lands on. Stored, that is a persistent failure the user cannot
	// repair through a UI that will not render. `min(1).max(10)` accepted all of it.
	currency: z.string().refine(isValidCurrencyCode, { message: CURRENCY_CODE_MESSAGE }).optional(),
	// Bounded rather than any integer: ISO 4217 uses 0, 2, 3 and 4, and an unbounded exponent in a
	// restored row is a scaling factor an uploaded file gets to choose.
	exponent: z.number().int().min(0).max(4).optional()
};

/**
 * Applies the both-or-neither rule to an entity that carries `denomination`.
 *
 * A file that names a currency on one of these rows was written by a version that had the exponent
 * column too, so it can and must carry both. Absent means "written before the columns existed",
 * which the restore stamps.
 */
function requireDenominationPair<T extends z.ZodTypeAny>(schema: T) {
	return schema.superRefine((parsed, context) => {
		// Narrowed inside rather than in the signature, so the wrapper keeps the schema's own
		// inferred output type. Typing the parameter instead widens every wrapped entity to these
		// two fields and takes the rest of the payload's types with it.
		const value = parsed as { currency?: string; exponent?: number };
		if ((value.currency === undefined) === (value.exponent === undefined)) return;
		context.addIssue({
			code: 'custom',
			path: [value.currency === undefined ? 'currency' : 'exponent'],
			message:
				'currency and exponent travel together: a currency with no exponent beside it does not ' +
				'say what its integer amounts mean'
		});
	});
}

const backupAccountSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(200),
		// A currency field and an EXPONENT field arrive in the same change, never currency alone: a
		// row restored under a non-euro currency with no exponent beside it is ambiguous forever.
		// The rule and its reasoning are on `Account.currency` in prisma/schema.prisma; this is the
		// second declaration site and moves with it. This comment used to say every `amountCents`
		// and `balanceCents` below was exponent-2 by assumption and recorded nothing about it; the
		// change that added `denomination` to those entities is the change that corrected it.
		currency: z.string().refine(isValidCurrencyCode, { message: CURRENCY_CODE_MESSAGE }),
		// NOT subject to the both-or-neither rule the five money-bearing entities carry, and this is
		// the one place the rule cannot apply: `currency` here PREDATES the exponent column, so it is
		// required while `exponent` is optional, and "currency present, exponent absent" is the shape
		// of every backup ever exported before this change. Refusing it would make them all
		// unrestorable.
		//
		// The cost is stated rather than hidden: a pre-change file naming a 3-decimal currency on an
		// account restores at exponent 2, because no pre-change file records one and this design
		// consults no list. It is the same limit the migration has for the same reason, and it is
		// not recoverable by any other means, because the information was never written down.
		exponent: denomination.exponent,
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
		// ACCEPTED AND IGNORED since #162, and it must stay that way. Nothing emits it and
		// nothing reads it, but every backup written before that chantier carries it, and this
		// object is `.strict()`: removing the field would turn an unrecognised key into a hard
		// rejection and make every installed user's existing file un-restorable. It is
		// `.optional()`, so a file written today validates too. Same constraint as
		// `categorizationRules`, for the same reason.
		//
		// Left constrained to the real enum rather than loosened to `z.unknown()`: a payload
		// carrying a forged key is still a malformed payload, and refusing it costs nothing now
		// that no code path can act on the value either way.
		defaultKey: defaultCategoryKey.nullable().optional()
	})
	.strict();

const tagColorToken = z.enum(TAG_COLOR_TOKENS);

const backupTagSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(1).max(MAX_PORTABLE_STRING),
		// A closed set, so a hand-edited file cannot store an off-palette or inaccessible colour
		// any more than the write path can. The validator is the only thing standing between a
		// crafted file and a colour the contrast gate never checked.
		colorToken: tagColorToken
	})
	.strict();

// No id of its own: TransactionTag has a composite primary key, so the payload is two foreign
// keys and the restore remaps both. Nothing references a pair.
const backupTransactionTagSchema = z
	.object({
		transactionId: z.string().min(1),
		tagId: z.string().min(1)
	})
	.strict();

// One line of a transaction's category allocation. Carries its own id, unlike TransactionTag:
// the same category may legitimately appear twice in one répartition, so there is no natural
// composite key and the restore remaps the id like every other table's.
//
// `amountCents` is deliberately unbounded here beyond being an integer. The invariant that gives
// it meaning is `sum of parts === parent.amountCents`, which no per-field validator can express —
// it is checked against the parent row, on the way in, in assertReferentialIntegrity.
const backupTransactionSplitSchema = z
	.object({
		id: z.string().min(1),
		transactionId: z.string().min(1),
		categoryId: z.string().min(1),
		amountCents: z.number().int(),
		position: z.number().int().min(0),
		// MAX_PORTABLE_STRING, not the write path's 80: this bound exists so a value MySQL cannot
		// store is refused by the validator on every engine, and it must still accept what an
		// older build legally wrote. Rejecting a legal export is worse than a looser bound.
		note: z.string().max(MAX_PORTABLE_STRING).nullable().default(null)
	})
	.strict();

/**
 * A remembered column mapping.
 *
 * `.strict()` and per-field bounds like every other entry here, but the SHAPE check is not what
 * makes this safe: `assertReferentialIntegrity` runs `validateColumnMapping`, the same predicate
 * the form path runs, over every entry. A schema can say a field is a string of at most 120
 * characters; only the validator can say that the category column is not also the label column,
 * and that is the rule whose violation creates one category per merchant on every later import.
 */
const backupColumnMappingSchema = z
	.object({
		fingerprint: z.string().length(64),
		matchBy: z.enum(['name', 'position']),
		dateColumn: z.string().max(120).nullable(),
		labelColumn: z.string().max(120).nullable(),
		amountColumn: z.string().max(120).nullable(),
		categoryColumn: z.string().max(120).nullable(),
		dateIndex: z.number().int().nullable(),
		labelIndex: z.number().int().nullable(),
		amountIndex: z.number().int().nullable(),
		categoryIndex: z.number().int().nullable(),
		columnCount: z.number().int(),
		useCount: z.number().int()
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

const backupTransactionSchema = requireDenominationPair(
	z
		.object({
			...denomination,
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
		.strict()
);

const backupMonthlyBudgetSchema = requireDenominationPair(
	z
		.object({
			...denomination,
			id: z.string().min(1),
			categoryName: z.string().min(1).max(MAX_PORTABLE_STRING),
			amountCents: z.number().int()
		})
		.strict()
);

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

const backupNetWorthAccountSchema = requireDenominationPair(
	z
		.object({
			...denomination,
			id: z.string().min(1),
			name: z.string().min(1).max(MAX_PORTABLE_STRING),
			type: netWorthAccountType,
			balanceCents: z.number().int(),
			deletedAt: isoDateString.nullable()
		})
		.strict()
);

const backupNetWorthSnapshotSchema = requireDenominationPair(
	z
		.object({
			...denomination,
			id: z.string().min(1),
			accountId: z.string().min(1),
			type: netWorthAccountType,
			balanceCents: z.number().int(),
			capturedAt: isoDateString
		})
		.strict()
);

const backupSavingsGoalSchema = requireDenominationPair(
	z
		.object({
			...denomination,
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
		.strict()
);

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
		// DEFAULTED, not required, because an export format is a CONTRACT: a file produced by a
		// version before column mappings existed must still restore. Same treatment as
		// `bankConnections`, which has its own backward-compatibility test for the same reason.
		// Making it required was the first attempt and the suite refused it by name.
		columnMappings: z.array(backupColumnMappingSchema).default([]),
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
		// back cleanly — this is availability, not corruption — but the bound costs nothing: the
		// write cap is far past what detection can produce for one user.
		//
		// Bounded at MAX_IMPORTED_RECURRING_STREAM_ACTIONS, which is HIGHER than the write path's
		// own cap on purpose. See those two constants: the gap absorbs the small overshoot a
		// concurrent count-then-insert can produce, so that a user's own export is never refused.
		recurringStreamActions: z
			.array(backupRecurringStreamActionSchema)
			.max(MAX_IMPORTED_RECURRING_STREAM_ACTIONS)
			.default([]),
		// Absent from exports predating tags: defaulted to empty.
		tags: z.array(backupTagSchema).default([]),
		// Absent from exports predating tags: defaulted to empty.
		//
		// Bounded RELATIVE to the transactions array, not by an absolute number, and for the same
		// reason recurringStreamActions is bounded at all (see that comment): every tagged
		// transaction leaves the bulk `createMany` and gets its own `create` inside the single
		// interactive transaction, so an unbounded pair array lets a hand-edited file well under
		// the upload limit hold a pooled connection for the whole LONG_TRANSACTION_OPTIONS
		// ceiling. It rolls back cleanly, so this is availability, not corruption.
		//
		// Relative rather than absolute because, unlike recurring stream actions, tagging has no
		// write-path cap to double: tagging every transaction you own is legitimate, so any
		// absolute number would eventually refuse somebody's own export. The ceiling a legal
		// export cannot exceed is transactions x MAX_TAGS_PER_TRANSACTION, which is exactly what
		// is asserted, in a superRefine because the bound depends on a sibling key.
		//
		// That ceiling is a claim about every write path, not just about setTransactionTags, and it
		// only holds because each of them enforces the per-transaction cap. A security review found
		// the bulk path had shipped without doing so, which would have produced an export this very
		// validator refuses, on the user's own untampered file. Any new path that ADDS a link, as
		// opposed to replacing a transaction's whole set, has to count first. See the cap check in
		// server/tags/bulk.ts.
		transactionTags: z.array(backupTransactionTagSchema).default([]),

		// Bounded relative to the transactions array, exactly as transactionTags is and for the
		// same reason: every split transaction leaves the bulk `createMany` and gets its own
		// `create` inside the single interactive transaction, so an unbounded array lets a
		// hand-edited file well under the upload limit hold a pooled connection for the whole
		// LONG_TRANSACTION_OPTIONS ceiling.
		//
		// Relative rather than absolute because splitting every transaction you own is legitimate,
		// so any absolute number would eventually refuse somebody's own export. The ceiling a legal
		// export cannot exceed is transactions x MAX_SPLITS_PER_TRANSACTION.
		//
		// Note the version-skew this accepts, knowingly and for the reason `.strict()` already
		// accepts it everywhere else: an export from a future build with a higher cap will not
		// restore here.
		transactionSplits: z.array(backupTransactionSplitSchema).default([])
	})
	.strict()
	.superRefine((payload, ctx) => {
		const ceiling = payload.transactions.length * MAX_TAGS_PER_TRANSACTION;
		if (payload.transactionTags.length > ceiling) {
			ctx.addIssue({
				code: 'custom',
				path: ['transactionTags'],
				message: `transactionTags exceeds ${ceiling}, the most ${payload.transactions.length} transactions can legally carry`
			});
		}

		const splitCeiling = payload.transactions.length * MAX_SPLITS_PER_TRANSACTION;
		if (payload.transactionSplits.length > splitCeiling) {
			ctx.addIssue({
				code: 'custom',
				path: ['transactionSplits'],
				message: `transactionSplits exceeds ${splitCeiling}, the most ${payload.transactions.length} transactions can legally carry`
			});
		}
	});

export type BackupExport = z.infer<typeof backupExportSchema>;
