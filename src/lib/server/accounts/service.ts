import { DEFAULT_DENOMINATION } from '$lib/domain/money';
import { prisma } from '$lib/server/db';
import { isUniqueConstraintViolation } from '$lib/server/database/upsert';
import { assertDiscriminantFree, DISCRIMINANT_LENGTH } from '$lib/server/import/discriminant';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { MAX_ACCOUNT_NAME_LENGTH } from '$lib/domain/account';

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

export type AccountCreateRefusal =
	'name-required' | 'name-too-long' | 'name-taken' | 'discriminant-taken';

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
export class AccountCreateError extends Error {
	readonly reason: AccountCreateRefusal;

	constructor(reason: AccountCreateRefusal) {
		super(REFUSAL_MESSAGES[reason]);
		this.name = 'AccountCreateError';
		this.reason = reason;
	}
}

const REFUSAL_MESSAGES: Record<AccountCreateRefusal, string> = {
	'name-required': 'An account name is required',
	'name-too-long': 'That account name is too long',
	'name-taken': 'This user already holds an account with that name',
	'discriminant-taken': 'This user already holds an account with that account identifier fragment'
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
	if (name.length === 0) throw new AccountCreateError('name-required');
	// Counted in CODE POINTS, like `persist.ts` cuts: a name of 120 emoji is 120 characters to the
	// person who typed it and 240 UTF-16 units to `String.length`.
	if (Array.from(name).length > MAX_ACCOUNT_NAME_LENGTH) {
		throw new AccountCreateError('name-too-long');
	}

	const fragment = input.discriminant?.trim().slice(-DISCRIMINANT_LENGTH) || null;
	const nameKey = computeNameKey(name);

	const held = await prisma.account.findMany({
		where: { userId: input.userId },
		select: { nameKey: true, discriminant: true }
	});
	if (held.some((account) => account.nameKey === nameKey)) {
		throw new AccountCreateError('name-taken');
	}
	if (fragment !== null) {
		try {
			// Called rather than re-expressed. The folding this rule applies (trim, upper case) lives
			// in one place, so a fourth caller cannot disagree with it by retyping the comparison.
			assertDiscriminantFree(fragment, held);
		} catch {
			throw new AccountCreateError('discriminant-taken');
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
		if (isUniqueConstraintViolation(caught)) throw new AccountCreateError('name-taken');
		throw caught;
	}
}
