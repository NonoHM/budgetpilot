import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { prisma } from '$lib/server/db';
import { isUniqueConstraintViolation } from '$lib/server/database/upsert';
import { assertDiscriminantFree, DISCRIMINANT_LENGTH } from '$lib/server/import/discriminant';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { displayAccountName } from './projection';
import { MAX_ACCOUNT_NAME_LENGTH } from '$lib/domain/account';
import { writeNetWorthLink } from '$lib/server/net-worth/link';

/**
 * Creating and naming the accounts a statement can belong to.
 *
 * ## Why this module exists beside `import/persist.ts` rather than inside it
 *
 * `persist.ts` resolves the bucket an import LANDS on. It creates one as a side effect of a run,
 * from a name the application worked out, and that is the behaviour piece 4 exists to bound. This
 * module is the other half: an account the USER creates, deliberately, by typing a name. The two
 * have opposite defaults, and folding them would give one function a « create silently » branch and
 * a « refuse and say why » branch selected by a flag, which is how a rule that should be one
 * sentence becomes two.
 */

/** The middle dot, three times, and never more of the identifier than that. Matches 6h's copy. */
const FRAGMENT_PREFIX = '···';

/**
 * The name the create sheet opens with, composed from what the FILE said and from nothing else.
 *
 * Pure by constraint rather than by preference: the value becomes `Account.name`, a database
 * column, so it may not depend on a locale, a clock or a random source. It is also the reason this
 * function does not reach for a message: « Banque Populaire ···4417 » is a proper noun beside four
 * characters, and a localised string does not live in a database column. This repository has one
 * expensive instance of that rule, where « Compte import CSV » was ALSO the bucket lookup key.
 *
 * The fragment is cut here rather than trusted from the caller. Four characters of an account
 * identifier are a sensitive class of their own; a whole IBAN reaching this function would put the
 * identifier into a column that is stored, displayed and exported, and a caller that already cut it
 * loses nothing by being cut again.
 */
export function prefillAccountName(input: {
	institution: string | null;
	fragment: string | null;
}): string {
	const fragment = input.fragment?.trim().slice(-DISCRIMINANT_LENGTH) ?? '';
	const institution = input.institution?.trim() ?? '';
	const parts = [institution, fragment ? `${FRAGMENT_PREFIX}${fragment}` : ''].filter(Boolean);
	return parts.join(' ');
}

export { MAX_ACCOUNT_NAME_LENGTH };

/**
 * The `source` every account born in the create sheet carries.
 *
 * `csv` rather than a new value, and this is a decision rather than a default. `isStatementAccount`
 * is an EXCLUSION set on purpose (an inclusion list that forgets a source HIDES an account and
 * nothing can notice), so a source it has never heard of would be offered as a destination by
 * accident rather than by decision. Reusing the value the CSV path already uses keeps the predicate
 * answering about a set somebody chose.
 */
export const STATEMENT_ACCOUNT_SOURCE = 'csv';

/**
 * The four ways CREATING an account can be refused, as a type of its own.
 *
 * A subset rather than a comment saying « these four », because the boundary that renders them
 * writes one sentence per reason and a catch-all `return` at the end of that chain would have
 * quietly rendered « ce nom est trop long » for a reason that is not about a name. Naming the
 * subset makes the compiler ask the endpoint what it means to do with a reason it cannot receive,
 * instead of answering for it.
 */
export type AccountCreateRefusal =
	'name-required' | 'name-too-long' | 'name-taken' | 'discriminant-taken';

/** Every way a write to an account can be refused. Superset of the four above. */
export type AccountWriteRefusal =
	AccountCreateRefusal | 'not-found' | 'net-worth-not-found' | 'net-worth-already-synced';

/**
 * A refusal the sheet can render, carried as a CLASS rather than as a message to match on.
 *
 * The same shape `ImportBucketAccountError` uses next door, for the same reason: a caller that
 * recognises a refusal by matching its text is a caller sharing one source with the thrower, so the
 * two agree by construction and the assertion measures nothing. The `reason` is the contract; the
 * message is for a log that will never see the fragment.
 *
 * **No message here ever names the fragment or the colliding name.** An error message travels,
 * through a screenshot, a ticket and a clipboard. ASVS 5.0.0 `v5.0.0-16.2.5`, as of the 2026-08-13
 * assessment of commit `d9c116c`.
 */
export class AccountWriteError extends Error {
	readonly reason: AccountWriteRefusal;

	constructor(reason: AccountWriteRefusal) {
		super(REFUSAL_MESSAGES[reason]);
		this.name = 'AccountWriteError';
		this.reason = reason;
	}
}

const REFUSAL_MESSAGES: Record<AccountWriteRefusal, string> = {
	'name-required': 'An account name is required',
	'name-too-long': 'That account name is too long',
	'name-taken': 'This user already holds an account with that name',
	'discriminant-taken': 'This user already holds an account with that account identifier fragment',
	/**
	 * ONE REASON FOR TWO SITUATIONS, and that is the decision rather than an omission: an id that
	 * never existed and an id belonging to somebody else answer identically, so the response is not
	 * an oracle for whether another user's id is real. Same ruling `renameTag` and
	 * `deleteColumnMapping` already made next door, and the same reason.
	 */
	'not-found': 'No such account for this user',
	'net-worth-not-found': 'No such linkable net worth account for this user',
	/**
	 * D4, and the message says SYNCHRONIZED rather than named the bucket holding the line. Which
	 * other account already feeds it is a fact about the user's own data, so it could be shown;
	 * it is left out because an error message travels through a screenshot and a clipboard, and
	 * no message in this class names another row. Same ruling as the two above.
	 */
	'net-worth-already-synced': 'This net worth account already has a synchronized bucket'
};

/**
 * Creates the account a user typed a name for, and refuses in four ways they can read.
 *
 * ## Every field but `name` is written as its neutral value, on purpose
 *
 * F1 is ONE field, so this is a positive allow list expressed in the create itself rather than a
 * deny list applied to a request. `institution` in particular is written only by the boot backfill
 * and by the bank-sync path, which know the bank without asking; the sheet does not, and a name a
 * user typed is not evidence about an institution. The schema's own comment on that column says so.
 *
 * ## The discriminant is a parameter and is NEVER a form field
 *
 * It reaches this function from the server's own read of the file, never from the request. The
 * boundary that calls this re-derives it, which is the same doctrine `/import/columns` states for
 * every value it accepts: the four indices are the only client input that survives, and everything
 * else is recomputed. A posted fragment would let a caller claim the identity of a statement they
 * do not hold, which is precisely what rank 1 later treats as certain.
 *
 * ## One read answers both uniqueness rules
 *
 * `userId` is in the SAME where clause rather than checked afterwards, and the folded key is what
 * is compared rather than the two strings: `nameKey` exists because a collation decides what equals
 * what, and MySQL's default answers differently from SQLite's.
 */
export async function createStatementAccount(input: {
	userId: string;
	name: string;
	/** From the server's own read of the file. Never from a request body. */
	discriminant?: string | null;
}): Promise<{ id: string; name: string; discriminant: string | null }> {
	const name = input.name.trim();
	if (name.length === 0) throw new AccountWriteError('name-required');
	// Counted in CODE POINTS, like `persist.ts` cuts: a name of 120 emoji is 120 characters to the
	// person who typed it and 240 UTF-16 units to `String.length`.
	if (Array.from(name).length > MAX_ACCOUNT_NAME_LENGTH) {
		throw new AccountWriteError('name-too-long');
	}

	const fragment = input.discriminant?.trim().slice(-DISCRIMINANT_LENGTH) || null;
	const nameKey = computeNameKey(name);

	const held = await prisma.account.findMany({
		where: { userId: input.userId },
		select: { nameKey: true, discriminant: true }
	});
	if (held.some((account) => account.nameKey === nameKey)) {
		throw new AccountWriteError('name-taken');
	}
	if (fragment !== null) {
		try {
			// Called rather than re-expressed. The folding this rule applies (trim, upper case) lives
			// in one place, so a fourth caller cannot disagree with it by retyping the comparison.
			assertDiscriminantFree(fragment, held);
		} catch {
			throw new AccountWriteError('discriminant-taken');
		}
	}

	try {
		return await prisma.account.create({
			data: {
				...DEFAULT_DENOMINATION,
				userId: input.userId,
				name,
				nameKey,
				source: STATEMENT_ACCOUNT_SOURCE,
				discriminant: fragment,
				// Written explicitly rather than left to a column default. The allow list is the point:
				// a reader auditing this create sees every field the sheet does not show, set to the
				// value it must have, instead of having to prove that no default anywhere sets one.
				institution: null,
				netWorthAccountId: null,
				bankConnectionId: null,
				providerAccountId: null,
				providerCashAccountType: null,
				archivedAt: null
			},
			select: { id: true, name: true, discriminant: true }
		});
	} catch (caught) {
		// The read above cannot see a row a concurrent request has not committed yet, so the
		// `@@unique([userId, name, source])` index is the only thing that decides the race. Reported
		// as the refusal the user can act on rather than as a 500 about a constraint they cannot see.
		if (isUniqueConstraintViolation(caught)) throw new AccountWriteError('name-taken');
		throw caught;
	}
}

/**
 * The columns a MANAGEMENT write is allowed to touch, and nothing beside them.
 *
 * Written as three functions rather than one `updateAccount({ name?, archived?, link? })`, and that
 * is the mass-assignment answer expressed in the type system rather than in a filter. A single
 * update taking an object of optional fields is exactly the shape that lets a request that posted
 * `archivedAt` reach the column: the deny list then has to be complete, and completeness is a
 * property nobody can see. Three functions each writing named columns make the allow list the
 * signature, so a field a form posts and no function accepts cannot arrive at all.
 *
 * Every one of them scopes on `(id, userId)` INSIDE the statement rather than reading the row and
 * checking afterwards, and answers `not-found` identically for an id that never existed and one
 * belonging to somebody else. Both halves are the ruling `renameTag` and `deleteColumnMapping`
 * already made: a distinct refusal is an oracle telling an attacker whether a guessed id is real.
 */

/**
 * Renames an account, keeping the folded key in step with the name it is the key FOR.
 *
 * The key is not a cache of the name, it is the thing every later comparison reads: a rename that
 * wrote `name` alone would leave the row answering « taken » for the name it no longer has and
 * « free » for the one it does, invisibly, because no screen renders a key. It is also what makes
 * the Comptes invitation self-clearing — `isGenericallyNamed` reads the key, so renaming the
 * generic bucket is what stops the sentence.
 */
export async function renameStatementAccount(input: {
	userId: string;
	accountId: string;
	name: string;
}): Promise<void> {
	const name = input.name.trim();
	if (name.length === 0) throw new AccountWriteError('name-required');
	// Code points, like `createStatementAccount` and like `persist.ts` cuts: a name of 120 emoji is
	// 120 characters to the person who typed it and 240 UTF-16 units to `String.length`.
	if (Array.from(name).length > MAX_ACCOUNT_NAME_LENGTH) {
		throw new AccountWriteError('name-too-long');
	}
	const nameKey = computeNameKey(name);

	const held = await prisma.account.findMany({
		where: { userId: input.userId },
		select: { id: true, nameKey: true }
	});
	// The row being renamed is excluded from its own uniqueness check. Without this, correcting the
	// casing of an account's own name is refused as a duplicate of itself, which reads on screen as
	// a broken field rather than as a rule.
	if (held.some((account) => account.id !== input.accountId && account.nameKey === nameKey)) {
		throw new AccountWriteError('name-taken');
	}

	try {
		const { count } = await prisma.account.updateMany({
			where: { id: input.accountId, userId: input.userId },
			data: { name, nameKey }
		});
		if (count === 0) throw new AccountWriteError('not-found');
	} catch (caught) {
		if (caught instanceof AccountWriteError) throw caught;
		// `@@unique([userId, name, source])` is what decides a race the read above cannot see.
		if (isUniqueConstraintViolation(caught)) throw new AccountWriteError('name-taken');
		throw caught;
	}
}

/**
 * Archives an account, or brings it back. Writes `archivedAt` and NOTHING else.
 *
 * Not a soft delete, and the distinction is the whole feature: every transaction the account ever
 * received stays exactly where it is and keeps rendering on every screen. What changes is that
 * `accountsForPicker` stops offering it as a destination while `accountsForList` keeps showing it,
 * so a user who archived by mistake has a screen on which to see it and a control to undo it.
 *
 * The timestamp is read from the clock at the moment of the write and is a fact about the PAST,
 * never a verdict recomputed later.
 */
export async function archiveStatementAccount(input: {
	userId: string;
	accountId: string;
	archived?: boolean;
}): Promise<void> {
	const { count } = await prisma.account.updateMany({
		where: { id: input.accountId, userId: input.userId },
		data: { archivedAt: input.archived === false ? null : new Date() }
	});
	if (count === 0) throw new AccountWriteError('not-found');
}

/**
 * /settings' door onto the net worth link: sets, or clears, the line this account feeds.
 *
 * ## It was called THE ONLY WRITER OF THAT COLUMN, and that sentence was wrong
 *
 * Kept here as the record, because the sentence is what the defect was made of rather than an
 * embarrassment beside it. The column has three writers - this one, `linkBankAccountToNetWorth`
 * and `setManualAccountNetWorthLink` - and D4, the rule that at most one SYNCHRONIZED bucket may
 * point at one line, was enforced in exactly one of them. /settings lists every bank-sync bucket
 * and offers this control on each, so a user linked two of them to one line in four clicks and two
 * provider balances then fought over it (#501).
 *
 * A property of a column is a claim about every writer, and the fix is that the rule stopped being
 * a property of a function: `writeNetWorthLink` in `$lib/server/net-worth/link.ts` owns the
 * resolution, both authorisations, D4 and the write, in one transaction. This function is the door.
 * It narrows nothing - /settings addresses any bucket a statement can come from - and does one
 * thing of its own, which is to translate the refusal into the sentence the page renders.
 *
 * ## What moved with the rule, and is still true
 *
 * `accountId` and `netWorthAccountId` both arrive from a request and each is a CLAIM; a function
 * validating one of them looks exactly like a function validating both, and both are scoped by
 * `userId` in their own where clause. The type is validated by CALLING
 * `isLinkableNetWorthAccountType` rather than retyping its list - ASVS 5.0.0 `v5.0.0-2.2.1`,
 * positive validation against an allow list, for input that makes a business decision. A null
 * clears the link and needs no lookup: there is no reference to authorise and nothing to conflict
 * with. All four now live at the site above, asserted by
 * `net-worth/oneSyncedBucketPerAccount.db-smoke.ts` and by this module's own battery.
 */
export async function linkNetWorthAccount(input: {
	userId: string;
	accountId: string;
	netWorthAccountId: string | null;
}): Promise<void> {
	const refusal = await writeNetWorthLink({
		userId: input.userId,
		accountId: input.accountId,
		netWorthAccountId: input.netWorthAccountId,
		bucket: 'any'
	});
	if (refusal === 'account-not-found') throw new AccountWriteError('not-found');
	if (refusal === 'net-worth-not-found') throw new AccountWriteError('net-worth-not-found');
	if (refusal === 'already-synced') throw new AccountWriteError('net-worth-already-synced');
}

/**
 * The name of one account, as a person reads it, or null when there is no such account.
 *
 * Here rather than in `projection.ts` because it runs a QUERY, and that module is pure on purpose:
 * every rule in it is a function of rows a caller already holds, which is what lets it be called
 * from a `load`, from an action and from a test with a hand-written fixture.
 *
 * `userId` is in the same where clause and is not redundant. The id reaching this function was
 * produced by the application rather than posted, so it could be taken on trust; taking an id off
 * one row and asking the database for a name is exactly the shape that leaks a name across users
 * the moment the row scoping is loosened anywhere upstream, and the clause costs a word.
 */
export async function readAccountDisplayName(
	userId: string,
	accountId: string
): Promise<string | null> {
	const account = await prisma.account.findFirst({
		where: { id: accountId, userId },
		select: { name: true, nameKey: true, source: true, institution: true }
	});
	return account ? displayAccountName(account) : null;
}
