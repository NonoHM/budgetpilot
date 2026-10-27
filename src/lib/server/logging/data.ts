import { log } from '$lib/server/logging';
import { ATTRIBUTE as A, EVENT as E } from './names.ts';
import { logUserPseudonym } from './pseudonym.ts';
import type {
	CountBucket,
	CountedDeleteOperation,
	DataExport,
	DataScope,
	PruneOperation,
	RestoreRefusal,
	SensitiveDeleteFields,
	SensitiveDeleteOperation,
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
 * callback, never a variable assigned inside an attempt, never a recount).
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
	undo_bill_action: 'bill_action'
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
