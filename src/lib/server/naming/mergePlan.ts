import { computeNameKey } from './nameKey.ts';

/**
 * Pure merge decisions for the name-key backfill.
 *
 * Folding names case- and accent-insensitively can turn rows that were distinct into rows
 * that mean the same thing: a user holding both "Courses" and "courses" has two categories
 * today and one after the fold. Deciding which row survives, what happens to the rows that
 * point at the losers, and which conflicting field value wins is business logic, not
 * plumbing, so it lives here as pure functions and is unit-tested directly. The executor
 * (`backfill.ts`) only reads rows, hands them to these functions, and applies the result.
 * The dry-run report renders the very same plan object it would otherwise apply, so what an
 * operator previews is by construction what runs.
 *
 * Two rules run through every decision:
 *
 * - **The survivor is the oldest row** (earliest `createdAt`, ties broken by the smaller
 *   id). It is the row the user created first, so it is the one their other data already
 *   points at most often, and the rule is deterministic: the same database always produces
 *   the same plan, which is what makes a dry-run worth reading.
 * - **A conflict that would lose information blocks the merge** rather than resolving it.
 *   Nothing here is urgent enough to justify silently dropping a link to a bank connection
 *   or a provider account, so those groups are reported and left exactly as they are.
 */

export interface NameKeyedRow {
	id: string;
	createdAt: Date;
}

/** A group of rows that fold to one name, with the survivor already chosen. */
export interface SurvivorGroup<T extends NameKeyedRow> {
	key: string;
	survivor: T;
	losers: T[];
}

/**
 * Groups rows by their name key and picks a survivor per group.
 *
 * Groups of one are dropped: they need no decision, only a key backfill, which the
 * executor does for every row regardless.
 */
export function groupCollisions<T extends NameKeyedRow>(
	rows: T[],
	keyOf: (row: T) => string
): SurvivorGroup<T>[] {
	const byKey = new Map<string, T[]>();
	for (const row of rows) {
		const key = keyOf(row);
		const bucket = byKey.get(key);
		if (bucket) bucket.push(row);
		else byKey.set(key, [row]);
	}

	const groups: SurvivorGroup<T>[] = [];
	for (const [key, bucket] of byKey) {
		if (bucket.length < 2) continue;
		const ordered = [...bucket].sort(compareByAge);
		const [survivor, ...losers] = ordered;
		groups.push({ key, survivor, losers });
	}
	// Stable output order so two runs on the same data render identically.
	return groups.sort((left, right) => left.key.localeCompare(right.key));
}

/** Oldest first; the id breaks ties so the order never depends on row insertion order. */
function compareByAge<T extends NameKeyedRow>(left: T, right: T): number {
	const byDate = left.createdAt.getTime() - right.createdAt.getTime();
	return byDate !== 0 ? byDate : left.id.localeCompare(right.id);
}

/** Most recently updated first: the value the user expressed most recently wins. */
function compareByRecency<T extends { updatedAt: Date; id: string }>(left: T, right: T): number {
	const byDate = right.updatedAt.getTime() - left.updatedAt.getTime();
	return byDate !== 0 ? byDate : left.id.localeCompare(right.id);
}

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export interface CategoryRow extends NameKeyedRow {
	name: string;
	/** Transactions currently pointing at this row, for the report and nothing else. */
	transactionCount: number;
}

export interface CategoryMerge {
	key: string;
	survivorId: string;
	survivorName: string;
	losers: Array<{ id: string; name: string; transactionCount: number }>;
	/** Transactions to repoint from the losers onto the survivor. */
	transactionsToReassign: number;
}

export function planCategoryMerges(categories: CategoryRow[]): CategoryMerge[] {
	return groupCollisions(categories, (row) => computeNameKey(row.name)).map((group) => {
		const { survivor, losers } = group;

		// No `defaultKey` reconciliation, where there used to be one.
		//
		// A merge had to decide which of the colliding rows' default keys the survivor kept,
		// because the key decided how the survivor would be DISPLAYED: pick wrong and a row the
		// user had renamed started showing a translated name again. Since #162 nothing reads the
		// column, so a merge has nothing to resolve and the survivor simply keeps its own name.
		return {
			key: group.key,
			survivorId: survivor.id,
			survivorName: survivor.name,
			losers: losers.map((row) => ({
				id: row.id,
				name: row.name,
				transactionCount: row.transactionCount
			})),
			transactionsToReassign: losers.reduce((total, row) => total + row.transactionCount, 0)
		};
	});
}

// ---------------------------------------------------------------------------
// Account (import/manual buckets)
// ---------------------------------------------------------------------------

/**
 * Link fields that tie a bucket to something outside itself. Two buckets folding to one
 * name while pointing at different things is not a duplicate, it is two real buckets that
 * happen to be named alike, so the merge stands down.
 */
const ACCOUNT_LINK_FIELDS = ['netWorthAccountId', 'bankConnectionId', 'providerAccountId'] as const;

type AccountLinkField = (typeof ACCOUNT_LINK_FIELDS)[number];

export interface AccountRow extends NameKeyedRow {
	name: string;
	source: string;
	currency: string;
	netWorthAccountId: string | null;
	bankConnectionId: string | null;
	providerAccountId: string | null;
	providerCashAccountType: string | null;
	/** Null on a row from before the keys, which is the only row the merge is for (#1086). */
	nameKey: string | null;
	transactionCount: number;
}

export interface AccountMerge {
	key: string;
	source: string;
	survivorId: string;
	survivorName: string;
	losers: Array<{ id: string; name: string; transactionCount: number }>;
	transactionsToReassign: number;
	/** Link fields the survivor adopts from a loser because its own were empty. */
	adoptedLinks: Partial<Record<AccountLinkField | 'providerCashAccountType', string>>;
}

/**
 * Why a group of same-named buckets is left alone.
 *
 * - `conflicting-value`: one field holds two different non-null values. Merging would have to
 *   pick one and drop the other.
 * - `multiple-linked-rows`: several rows in the group each carry a link, even though no single
 *   field disagrees (one bucket linked to a net worth account, another to a bank connection).
 *   Adopting field by field would assemble a bucket that never existed, wearing links that
 *   belonged to two different things.
 */
export type AccountMergeBlockReason =
	| { kind: 'conflicting-value'; field: AccountConflictField }
	| { kind: 'multiple-linked-rows' }
	| { kind: 'already-keyed' };

type AccountConflictField = AccountLinkField | 'currency';

export interface AccountMergeBlocked {
	key: string;
	source: string;
	names: string[];
	reason: AccountMergeBlockReason;
}

export interface AccountMergePlan {
	merges: AccountMerge[];
	blocked: AccountMergeBlocked[];
}

export function planAccountMerges(accounts: AccountRow[]): AccountMergePlan {
	// Uniqueness is per (name, source), so the fold is too: a "Courses" manual bucket and a
	// "courses" Revolut bucket were never the same row and must not become one.
	// The separator is written as the ESCAPE `\u0000`, never as the byte itself. This line carried
	// a literal NUL for months (#175) and that made the whole file invisible to `grep`, `rg` and
	// `git grep`, which report it as binary and print no lines. An audit's scope figure was
	// measured without it. The escape compiles to the identical character, so the grouping is
	// byte for byte what it was: 50 of 50 naming tests unchanged across the substitution.
	const groups = groupCollisions(
		accounts,
		(row) => `${row.source}\u0000${computeNameKey(row.name)}`
	);

	const merges: AccountMerge[] = [];
	const blocked: AccountMergeBlocked[] = [];

	for (const group of groups) {
		const members = [group.survivor, ...group.losers];
		// First, because it decides whether this is the duplicate the merge exists for at all
		// (#1086). A group whose keys are ALL written is either a legacy pair an earlier run left
		// apart (that run writes every surviving key, blocked ones included) or one made since: two
		// concurrent renames to « Livret » and « LIVRET », or a writer checking exact spelling
		// (#1092). Nothing stored tells them apart, so they are never merged (owner ruling on #1086):
		// every comparable product read merges two accounts only when the user picks both.
		if (members.every((row) => row.nameKey !== null)) {
			blocked.push({
				key: group.key,
				source: group.survivor.source,
				names: members.map((row) => row.name),
				reason: { kind: 'already-keyed' }
			});
			continue;
		}
		const conflictingField: AccountConflictField | undefined =
			// Currency first: it is the one field where merging would misstate money rather than
			// only lose a link. Two buckets in different currencies are two buckets, full stop,
			// and their transaction amounts must never end up added together under one of them.
			new Set(members.map((row) => row.currency)).size > 1
				? 'currency'
				: ACCOUNT_LINK_FIELDS.find((field) => {
						const values = new Set(
							members.map((row) => row[field]).filter((value): value is string => value !== null)
						);
						return values.size > 1;
					});

		if (conflictingField) {
			blocked.push({
				key: group.key,
				source: group.survivor.source,
				names: members.map((row) => row.name),
				reason: { kind: 'conflicting-value', field: conflictingField }
			});
			continue;
		}

		// No field disagrees, but more than one row is linked to something: adopting per field
		// would merge two genuinely different buckets into one wearing both their links.
		const linkedMembers = members.filter((row) =>
			ACCOUNT_LINK_FIELDS.some((field) => row[field] !== null)
		);
		if (linkedMembers.length > 1) {
			blocked.push({
				key: group.key,
				source: group.survivor.source,
				names: members.map((row) => row.name),
				reason: { kind: 'multiple-linked-rows' }
			});
			continue;
		}

		// No conflict by definition of the check above, so "the one non-null value, if any"
		// is unambiguous. The survivor keeps its own; otherwise it adopts the loser's.
		const adoptedLinks: AccountMerge['adoptedLinks'] = {};
		for (const field of [...ACCOUNT_LINK_FIELDS, 'providerCashAccountType'] as const) {
			if (group.survivor[field] !== null) continue;
			const donated = group.losers.find((row) => row[field] !== null)?.[field];
			if (donated) adoptedLinks[field] = donated;
		}

		merges.push({
			key: group.key,
			source: group.survivor.source,
			survivorId: group.survivor.id,
			survivorName: group.survivor.name,
			losers: group.losers.map((row) => ({
				id: row.id,
				name: row.name,
				transactionCount: row.transactionCount
			})),
			transactionsToReassign: group.losers.reduce((total, row) => total + row.transactionCount, 0),
			adoptedLinks
		});
	}

	return { merges, blocked };
}

// ---------------------------------------------------------------------------
// MonthlyBudget and CategoryNatureMapping
// ---------------------------------------------------------------------------

export interface ValuedNameRow<TValue> extends NameKeyedRow {
	categoryName: string;
	updatedAt: Date;
	value: TValue;
}

export interface ValuedMerge<TValue> {
	key: string;
	survivorId: string;
	survivorName: string;
	losers: Array<{ id: string; name: string; value: TValue }>;
	/** Value the survivor ends up with: the one edited most recently. */
	resolvedValue: TValue;
	valueSource: 'survivor' | 'loser';
	/**
	 * Values this merge throws away, newest first, with the name that held each one.
	 *
	 * Carried explicitly rather than left for the reader to work out: a budget merge
	 * silently replacing one amount with another is exactly the kind of decision an
	 * operator needs to see spelled out before it runs.
	 */
	discardedValues: Array<{ name: string; value: TValue }>;
}

/**
 * Merge rule for the two tables keyed by a category name and holding a single value: a
 * budget amount, or a nature.
 *
 * The most recently updated value wins. Neither "the largest amount" nor "the survivor's
 * own" is more correct in general, and last-edit-wins is the rule the rest of the app
 * already follows when a rename lands a budget on an existing category name.
 */
export function planValuedMerges<TValue>(
	rows: Array<ValuedNameRow<TValue>>
): Array<ValuedMerge<TValue>> {
	return groupCollisions(rows, (row) => computeNameKey(row.categoryName)).map((group) => {
		const members = [group.survivor, ...group.losers];
		const newest = [...members].sort(compareByRecency)[0];

		return {
			key: group.key,
			survivorId: group.survivor.id,
			survivorName: group.survivor.categoryName,
			losers: group.losers.map((row) => ({
				id: row.id,
				name: row.categoryName,
				value: row.value
			})),
			resolvedValue: newest.value,
			valueSource: newest.id === group.survivor.id ? 'survivor' : 'loser',
			discardedValues: [...members]
				.sort(compareByRecency)
				.filter((member) => member.id !== newest.id)
				.map((member) => ({ name: member.categoryName, value: member.value }))
		};
	});
}

// ---------------------------------------------------------------------------
// NetWorthAccount: reported, never merged
// ---------------------------------------------------------------------------

export interface NetWorthAccountRow extends NameKeyedRow {
	name: string;
	deletedAt: Date | null;
}

export interface NetWorthCollision {
	key: string;
	names: string[];
}

/**
 * Net worth accounts are reported and left alone.
 *
 * Merging them would mean merging balances and snapshot histories, and there is no
 * defensible automatic answer to "what is the balance of the merged account" or "which
 * snapshot series is the real one". Uniqueness there has always been enforced in
 * application code against active rows rather than by a constraint, so an existing pair
 * keeps working untouched: only creating or renaming an account to a name that folds onto
 * another one starts being refused.
 */
export function findNetWorthCollisions(accounts: NetWorthAccountRow[]): NetWorthCollision[] {
	const active = accounts.filter((row) => row.deletedAt === null);
	return groupCollisions(active, (row) => computeNameKey(row.name)).map((group) => ({
		key: group.key,
		names: [group.survivor, ...group.losers].map((row) => row.name)
	}));
}
