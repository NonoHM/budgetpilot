import { log } from '$lib/server/logging';
import { ATTRIBUTE as A, EVENT as E } from './names.ts';
import { logUserPseudonym } from './pseudonym.ts';
import type {
	CountBucket,
	CountedCreateOperation,
	CountedDeleteOperation,
	DataExport,
	DataScope,
	PruneOperation,
	RestoreRefusal,
	SensitiveDeleteFields,
	SensitiveCreateOperation,
	SensitiveDeleteOperation,
	SensitiveUpdateOperation,
	UncountedCreateOperation,
	UncountedDeleteOperation,
	UserFields
} from './events.ts';

export type {
	BackupIntegrityReason,
	CountedDeleteOperation,
	DataExport,
	PruneOperation,
	RestoreRefusal,
	UncountedDeleteOperation
} from './events.ts';

/**
 * The data events (L4b-2, part of #250), and the only code that builds them. A caller hands over
 * the raw user id and the engine's own counts: the pseudonym, the scope and the buckets are taken
 * here, so no caller can name a scope its operation does not have or write a raw count.
 *
 * WHEN. After the write or the commit returns, success only: a refused or rolled-back write
 * destroyed nothing. The counts are the committed attempt's own answer (returned from the commit
 * callback, never a variable assigned inside an attempt, never a recount). The one count taken on a
 * failure is a sync's (#1087): rows of the buckets whose write returned, plus the `landedRows` the
 * failing write read back from the ledger, and `unknown` when it could not read it.
 */

/** What each operation destroys, whatever its count: `0` beside `account` still means all of it. */
const SCOPE: { [O in SensitiveDeleteOperation]: DataScope } = {
	delete_account: 'account',
	delete_user: 'account',
	restore: 'account_records',
	import_cancel: 'import',
	import_replace: 'import',
	delete_transaction: 'transaction',
	delete_category: 'category',
	delete_rule: 'rule',
	delete_tag: 'tag',
	prune_tags: 'tag',
	prune_bill_actions: 'bill_action',
	merge_budget: 'budget',
	overrule_remembered_account: 'remembered_account',
	delete_budget: 'budget',
	delete_column_mapping: 'column_mapping',
	forget_remembered_account: 'remembered_account',
	delete_nature_mapping: 'nature_mapping',
	delete_bank_connection: 'bank_connection',
	undo_bill_action: 'bill_action',
	// Soft deletes: the row stays under `deletedAt`, the member has no undo (owner ruling 7).
	delete_net_worth_account: 'net_worth_account',
	delete_savings_goal: 'savings_goal'
};

/** What each creation or update added or changed, as `SCOPE` says what a deletion took. */
const CREATE_SCOPE: { [O in SensitiveCreateOperation]: DataScope } = {
	connect_bank: 'bank_connection',
	// The transactions, and the balances recorded for the accounts linked to net worth.
	sync_bank_connection: 'bank_connection',
	// The transactions, the account `/import` created for them, and any category a row named.
	import_file: 'import',
	// With the account manual entries are filed under, and the category, when either is new.
	create_transaction: 'transaction',
	// The upsert creates the budget, or replaces the limit the category already has.
	save_budget: 'budget',
	create_category: 'category',
	restore_default_categories: 'category',
	create_rule: 'rule',
	restore_default_rules: 'rule',
	create_net_worth_account: 'net_worth_account',
	create_savings_goal: 'savings_goal',
	// The record `undo_bill_action` deletes.
	mark_bill_paid: 'bill_action',
	ignore_bill_occurrence: 'bill_action',
	exclude_bill_stream: 'bill_action',
	create_statement_account: 'statement_account'
};
const UPDATE_SCOPE: { [O in SensitiveUpdateOperation]: DataScope } = {
	renew_bank_connection: 'bank_connection'
};

const EXPORT_SCOPE: { [X in DataExport]: DataScope } = {
	backup: 'account_records',
	transactions_csv: 'selection'
};

/** A count is the engine's answer, so anything else is a defect upstream, refused loudly. */
function bucket(count: number): CountBucket {
	if (!Number.isInteger(count) || count < 0)
		throw new RangeError('a count must be a non-negative integer');
	if (count <= 1) return count === 0 ? '0' : '1';
	if (count < 10) return '2-9';
	if (count < 100) return '10-99';
	if (count < 1000) return '100-999';
	return '1000+';
}

function user(userId: string): UserFields {
	return { [A.userPseudonym]: logUserPseudonym(userId) };
}

/**
 * Stored data was deleted at a member's or an admin's request. The target is required on
 * `delete_user` only; `restore` carries what it wrote back beside what it deleted; the two prunes
 * count records, the scope saying which; the one-row deletes of other records carry no count.
 */
export function logSensitiveDelete(
	userId: string,
	...call:
		| [transactions: number, operation: CountedDeleteOperation]
		| [transactions: number, operation: 'delete_user', targetUserId: string]
		| [transactions: number, operation: 'restore', restored: number]
		| [records: number, operation: PruneOperation]
		| [operation: UncountedDeleteOperation]
): void {
	let fields: SensitiveDeleteFields;
	if (call.length === 1) {
		fields = { [A.dataOperation]: call[0], [A.dataScope]: SCOPE[call[0]] };
	} else {
		const [count, operation] = call;
		fields = { [A.dataOperation]: operation, [A.dataScope]: SCOPE[operation] };
		if (operation === 'prune_tags' || operation === 'prune_bill_actions') {
			fields[A.dataRecordsDeleted] = bucket(count);
		} else {
			fields[A.dataTransactionsDeleted] = bucket(count);
			if (call.length === 3 && call[1] === 'restore') {
				fields[A.dataTransactionsRestored] = bucket(call[2]);
			} else if (call.length === 3 && call[1] === 'delete_user') {
				fields[A.targetUserPseudonym] = logUserPseudonym(call[2]);
			}
		}
	}
	log({ event: E.sensitiveDelete, attributes: { ...user(userId), ...fields } });
}

/**
 * Stored data was created (#1087): a record, with no count, or what a sync or a file import wrote,
 * with the transactions it created, `null` when the ledger could not be read.
 */
export function logSensitiveCreate(
	userId: string,
	...call:
		| [operation: UncountedCreateOperation]
		| [transactions: number | null, operation: CountedCreateOperation]
): void {
	const operation: SensitiveCreateOperation = call.length === 1 ? call[0] : call[1];
	log({
		event: E.sensitiveCreate,
		attributes: {
			...user(userId),
			[A.dataOperation]: operation,
			[A.dataScope]: CREATE_SCOPE[operation],
			...(call.length === 2
				? { [A.dataTransactionsCreated]: call[0] === null ? 'unknown' : bucket(call[0]) }
				: {})
		}
	});
}

/** Stored data was changed in place (#1087; #1080 extends the operations). */
export function logSensitiveUpdate(userId: string, operation: SensitiveUpdateOperation): void {
	log({
		event: E.sensitiveUpdate,
		attributes: {
			...user(userId),
			[A.dataOperation]: operation,
			[A.dataScope]: UPDATE_SCOPE[operation]
		}
	});
}

/** A member downloaded an export; `transactions` is how many transactions it read. */
export function logSensitiveRead(userId: string, kind: DataExport, transactions: number): void {
	const exported = bucket(transactions);
	log({
		event: E.sensitiveRead,
		attributes: {
			...user(userId),
			[A.dataExport]: kind,
			[A.dataScope]: EXPORT_SCOPE[kind],
			[A.dataTransactionsExported]: exported
		}
	});
}

/** An uploaded backup file was refused, and nothing in the account changed. */
export function logRestoreRefused(userId: string, reason: RestoreRefusal): void {
	log({ event: E.inputValidationFail, attributes: { ...user(userId), [A.restoreReason]: reason } });
}
