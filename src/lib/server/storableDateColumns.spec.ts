import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

// Nothing here opens a database: the parsers under test are pure, and the mock only keeps the
// service modules from constructing a client when they are imported.
vi.mock('$lib/server/db', () => ({ prisma: {} }));

const { validateTransaction } = await import('$lib/domain/transaction');
const { readRowDate } = await import('$lib/server/import/utils/csv');
const { parseCsvTransactions } = await import('$lib/server/import/csv');
const { parseTargetDate } = await import('$lib/server/savings-goals/service');
const { parseAsOfDate } = await import('$lib/server/net-worth/service');
const { parseDueDate } = await import('$lib/server/upcoming-bills/service');
const { mapTransaction, parseProviderDate } =
	await import('$lib/server/banking/connectors/enablebanking');
const { backupExportSchema, isoDateString, RESTORE_DATE_KINDS } =
	await import('$lib/server/backup/schema');

/**
 * #758: EVERY `DateTime` COLUMN, and every writer that puts a date a user or a provider supplied
 * into one.
 *
 * ## Why the columns are read from the schema
 *
 * The first pass of #758 fixed the import path and claimed one definition; a contradiction pass
 * then found three services and a provider field that parsed their own dates and never asked the
 * range. A hand-kept list of « the date writers » is how that happened. So the columns come from
 * `prisma/schema.prisma` itself, and `every DateTime column is classified` fails the day a column
 * is added without saying which kind it is.
 *
 * ## The two kinds
 *
 * - `clock`: the server computes the value (`@default(now())`, `@updatedAt`, `new Date()`, an
 *   expiry from a duration). Nothing a user or a provider supplies reaches it, except through a
 *   restore, which is checked separately below. « Computed » is not « in range »: an operator's
 *   `SESSION_TTL_DAYS` or `INVITATION_TTL_HOURS` can push an expiry past 9999, which is #754's to
 *   bound, not this file's. What this file holds to the range is every value a user or a provider
 *   supplies.
 * - `parsed`: a string from a form, a file or a provider becomes the value. Each such writer is
 *   named with its production parser and PROBED: it must accept the first storable day and a
 *   leap day, and refuse year 0000 (PostgreSQL `22008`), year 0026 (MariaDB reads it back as
 *   2026) and 0999 (the last year outside the range).
 *
 * What this cannot see, stated rather than implied: a writer that parses a date and is not listed
 * against its column. Classifying a column `clock` is a claim this file cannot check. The restore
 * half below is structural for the fields it can see: it finds every field that IS the shared
 * `isoDateString` by identity, and cannot see a date field added as a bare `z.string()`.
 *
 * Breaks, each separately: the range check removed from any one parser reddens that writer's
 * « refuses » probes alone (separates « this writer asks the range » from « it parses its own
 * way »); a DateTime column added to the schema reddens the classification test.
 */

type Writer = { name: string; accepts: (isoDate: string) => boolean };
type Column = { kind: 'clock' } | { kind: 'parsed'; writers: Writer[] };

const CLOCK: Column = { kind: 'clock' };

function throwsNot(run: () => unknown): boolean {
	try {
		run();
		return true;
	} catch {
		return false;
	}
}

const BASE_TRANSACTION = {
	id: 'probe',
	label: 'PROBE',
	amountCents: -100,
	type: 'expense' as const,
	category: 'Alimentation',
	source: 'manual' as const
};

const IMPORT_PERIOD = (side: 'from' | 'to'): Writer => ({
	name: `import period ${side} (the parse summary of the storable rows)`,
	accepts: (value) =>
		parseCsvTransactions(`Date,Description,Amount\n${value},PROBE,-1.00`).summary.period[side] ===
		value
});

const COLUMNS: Record<string, Column> = {
	'User.defaultsSeededAt': CLOCK,
	'User.defaultRulesSeededAt': CLOCK,
	'User.totpEnabledAt': CLOCK,
	'User.categoryRenamePromptDismissedAt': CLOCK,
	'User.createdAt': CLOCK,
	'User.updatedAt': CLOCK,
	'RecoveryCode.usedAt': CLOCK,
	'RecoveryCode.createdAt': CLOCK,
	'PendingMfaChallenge.expiresAt': CLOCK,
	'PendingMfaChallenge.createdAt': CLOCK,
	'Session.expiresAt': CLOCK,
	'Session.createdAt': CLOCK,
	'Session.revokedAt': CLOCK,
	'Invitation.expiresAt': CLOCK,
	'Invitation.usedAt': CLOCK,
	'Invitation.revokedAt': CLOCK,
	'Invitation.createdAt': CLOCK,
	'Account.archivedAt': CLOCK,
	'Account.createdAt': CLOCK,
	'Account.updatedAt': CLOCK,
	'BankConnection.consentExpiresAt': {
		kind: 'parsed',
		writers: [
			{
				name: 'Enable Banking access.valid_until (parseProviderDate)',
				accepts: (value) => parseProviderDate(`${value}T00:00:00Z`) !== null
			}
		]
	},
	'BankConnection.lastSyncAt': CLOCK,
	// The fetch cursor (#763): the server's clock at a complete sync, or NULL. The restore carries
	// it through the validated backup field below.
	'BankConnection.lastCompleteSyncAt': CLOCK,
	'BankConnection.createdAt': CLOCK,
	'BankConnection.updatedAt': CLOCK,
	'BankAuthorizationRequest.expiresAt': CLOCK,
	'BankAuthorizationRequest.consumedAt': CLOCK,
	'BankAuthorizationRequest.createdAt': CLOCK,
	'Category.createdAt': CLOCK,
	'Category.updatedAt': CLOCK,
	'Tag.createdAt': CLOCK,
	'Tag.updatedAt': CLOCK,
	'TransactionTag.createdAt': CLOCK,
	'TransactionSplit.createdAt': CLOCK,
	'TransactionSplit.updatedAt': CLOCK,
	'Transaction.date': {
		kind: 'parsed',
		writers: [
			{
				name: 'CSV and XLSX rows, every profile (readRowDate)',
				accepts: (value) => readRowDate([{ column: 'date', value }]).kind === 'date'
			},
			{
				name: 'manual entry (validateTransaction)',
				accepts: (value) => validateTransaction({ ...BASE_TRANSACTION, date: value }).ok
			},
			{
				name: 'Enable Banking booking_date (mapTransaction)',
				accepts: (value) =>
					throwsNot(() =>
						mapTransaction(
							{
								status: 'BOOK',
								credit_debit_indicator: 'DBIT',
								transaction_amount: { currency: 'EUR', amount: '10.00' },
								booking_date: value,
								creditor: { name: 'PROBE' }
							} as never,
							0
						)
					)
			}
		]
	},
	'Transaction.createdAt': CLOCK,
	'Transaction.updatedAt': CLOCK,
	// The file import's period is the span of its storable rows. The bank sync's batch period is
	// NOT parsed: `banking/sync/service.ts` builds it from `lastCompleteSyncAt` and the clock, so it is not a
	// writer of a supplied date and is not listed here.
	'ImportBatch.periodStart': { kind: 'parsed', writers: [IMPORT_PERIOD('from')] },
	'ImportBatch.periodEnd': { kind: 'parsed', writers: [IMPORT_PERIOD('to')] },
	'ImportBatch.createdAt': CLOCK,
	'ImportBatch.updatedAt': CLOCK,
	'ColumnMapping.lastUsedAt': CLOCK,
	'ColumnMapping.createdAt': CLOCK,
	'ColumnMapping.updatedAt': CLOCK,
	'RememberedAccount.rememberedAt': CLOCK,
	'CategorizationRule.createdAt': CLOCK,
	'CategorizationRule.updatedAt': CLOCK,
	'CategoryRule.createdAt': CLOCK,
	'CategoryRule.updatedAt': CLOCK,
	'MonthlyBudget.createdAt': CLOCK,
	'MonthlyBudget.updatedAt': CLOCK,
	'LoginAttempt.createdAt': CLOCK,
	'CategoryNatureMapping.createdAt': CLOCK,
	'CategoryNatureMapping.updatedAt': CLOCK,
	'NetWorthAccount.deletedAt': CLOCK,
	'NetWorthAccount.createdAt': CLOCK,
	'NetWorthAccount.updatedAt': CLOCK,
	// A bank sync stamps its own clock here (`recordSyncedBalance`); the form's « à la date du »
	// is the one writer that parses.
	'NetWorthSnapshot.capturedAt': {
		kind: 'parsed',
		writers: [
			{
				name: 'net worth « à la date du » (parseAsOfDate)',
				accepts: (value) => parseAsOfDate(value) instanceof Date
			}
		]
	},
	'SavingsGoal.targetDate': {
		kind: 'parsed',
		writers: [
			{
				name: 'savings goal deadline (parseTargetDate)',
				accepts: (value) => parseTargetDate(value) instanceof Date
			}
		]
	},
	'SavingsGoal.reachedAt': CLOCK,
	'SavingsGoal.reachedBannerDismissedAt': CLOCK,
	'SavingsGoal.deletedAt': CLOCK,
	'SavingsGoal.createdAt': CLOCK,
	'SavingsGoal.updatedAt': CLOCK,
	'RecurringStreamAction.dueDate': {
		kind: 'parsed',
		writers: [
			{
				name: 'upcoming bill action (parseDueDate)',
				accepts: (value) => throwsNot(() => parseDueDate('paid', value))
			}
		]
	},
	'RecurringStreamAction.createdAt': CLOCK,
	'RecurringStreamAction.updatedAt': CLOCK
};

/**
 * Where a restore writes each column from, as a path into the backup schema (`[]` is an array's
 * element). `exportedAt` is the file's own stamp and is read, never stored.
 */
const RESTORED_FROM: Record<string, string> = {
	'BankConnection.consentExpiresAt': 'bankConnections.[].consentExpiresAt',
	'BankConnection.lastSyncAt': 'bankConnections.[].lastSyncAt',
	'BankConnection.lastCompleteSyncAt': 'bankConnections.[].lastCompleteSyncAt',
	'ImportBatch.periodStart': 'importBatches.[].periodStart',
	'ImportBatch.periodEnd': 'importBatches.[].periodEnd',
	'Transaction.date': 'transactions.[].date',
	'NetWorthAccount.deletedAt': 'netWorthAccounts.[].deletedAt',
	'NetWorthSnapshot.capturedAt': 'netWorthSnapshots.[].capturedAt',
	'SavingsGoal.targetDate': 'savingsGoals.[].targetDate',
	'SavingsGoal.reachedAt': 'savingsGoals.[].reachedAt',
	'SavingsGoal.reachedBannerDismissedAt': 'savingsGoals.[].reachedBannerDismissedAt',
	'RecurringStreamAction.dueDate': 'recurringStreamActions.[].dueDate',
	'RecurringStreamAction.createdAt': 'recurringStreamActions.[].createdAt',
	'RecurringStreamAction.updatedAt': 'recurringStreamActions.[].updatedAt'
};
const FILE_STAMP = 'exportedAt';

/** Every `Model.field` typed `DateTime` in the schema, read from the file rather than recalled. */
function dateTimeColumns(): string[] {
	const text = readFileSync('prisma/schema.prisma', 'utf8');
	const columns: string[] = [];
	let model: string | null = null;
	for (const line of text.split('\n')) {
		const opened = /^model (\w+) \{/.exec(line);
		if (opened) model = opened[1];
		else if (/^\}/.test(line)) model = null;
		else if (model) {
			const field = /^\s+(\w+)\s+DateTime\??(\s|$)/.exec(line);
			if (field) columns.push(`${model}.${field[1]}`);
		}
	}
	return columns;
}

type Walkable = z.ZodType & {
	unwrap?: () => z.ZodType;
	shape?: Record<string, z.ZodType>;
	element?: z.ZodType;
	def?: { innerType?: z.ZodType };
};

/** Strips `nullable`, `optional` and `default` until an object, an array or a leaf is left. */
function peel(schema: z.ZodType): Walkable {
	let current = schema as Walkable;
	for (let guard = 0; guard < 10; guard += 1) {
		if (current === (isoDateString as unknown)) return current;
		const inner = current.def?.innerType;
		if (inner) current = inner as Walkable;
		else return current;
	}
	return current;
}

/** Every path in the backup schema whose leaf IS `isoDateString`, by identity. */
function backupDatePaths(schema: z.ZodType, prefix: string[] = []): string[] {
	const node = peel(schema);
	if (node === (isoDateString as unknown)) return [prefix.join('.')];
	if (node.shape) {
		return Object.entries(node.shape).flatMap(([key, child]) =>
			backupDatePaths(child, [...prefix, key])
		);
	}
	if (node.element) return backupDatePaths(node.element, [...prefix, '[]']);
	return [];
}

const IN_RANGE = ['1000-01-01', '2000-02-29'];
const OUT_OF_RANGE = ['0000-01-16', '0026-05-01', '0999-12-31'];

const PARSED_WRITERS = Object.entries(COLUMNS).flatMap(([column, entry]) =>
	entry.kind === 'parsed' ? entry.writers.map((writer) => ({ column, ...writer })) : []
);

describe('every DateTime column is held to the storable range', () => {
	it('every DateTime column in the schema is classified, and nothing else is', () => {
		expect.assertions(2);
		const columns = dateTimeColumns();
		// The absolute figure: a parse that found nothing would compare equal to an empty table.
		expect(columns.length).toBeGreaterThan(50);
		expect(Object.keys(COLUMNS).sort()).toEqual([...columns].sort());
	});

	it.each(PARSED_WRITERS)('$column, $name: accepts the storable controls', (writer) => {
		expect.assertions(1);
		expect(IN_RANGE.filter((value) => !writer.accepts(value))).toEqual([]);
	});

	it.each(PARSED_WRITERS)(
		'$column, $name: refuses a year no engine stores faithfully',
		(writer) => {
			expect.assertions(1);
			expect(OUT_OF_RANGE.filter((value) => writer.accepts(value))).toEqual([]);
		}
	);

	/**
	 * THE RESTORE HALF, structural for what it can see. Separates « every field built on the shared
	 * `isoDateString` maps to a classified column, and back » from « a restored column is missing
	 * from the map » or « a mapped path is not the shared reader ». It does NOT catch a date field
	 * added as a bare `z.string()`: that field is not `isoDateString`, so the walk never finds it.
	 */
	it('every backup date field is isoDateString and maps to a classified column', () => {
		expect.assertions(4);
		const found = backupDatePaths(backupExportSchema).sort();
		expect(found.length).toBeGreaterThan(0);
		expect(found).toEqual([...Object.values(RESTORED_FROM), FILE_STAMP].sort());
		expect(Object.keys(RESTORED_FROM).filter((column) => !(column in COLUMNS))).toEqual([]);
		// The restore sentence names the kind of record at fault, so every member carrying a date
		// must be one it can name.
		expect(
			[...new Set(found.map((path) => path.split('.')[0]))].filter(
				(kind) => !(RESTORE_DATE_KINDS as readonly string[]).includes(kind)
			)
		).toEqual([]);
	});
});
