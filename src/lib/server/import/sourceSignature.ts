import { isStatementDestination } from '$lib/server/accounts/projection';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { accountMemoryKeyOf, readRememberedAccount } from './accountMemory';
import { accountHoldingFragment, findDiscriminantColumn } from './discriminant';
import { readMaisonV3Account } from './profiles/maison-v3';
import type { ParsedCsvRow } from './types';

/**
 * An `Account` row as this module needs to see it, and nothing more.
 *
 * `discriminant` is optional because the caller's projection habitually omits it for buckets that
 * cannot carry one; an absent fragment and a NULL fragment mean the same thing here, which is
 * "this account is not named by any file". `name` is required rather than optional: rank 2 reads
 * it on every call, and an optional field a caller forgot to populate would silently make rank 2
 * unreachable for that caller rather than failing to compile.
 */
export interface ResolvableAccount {
	id: string;
	name: string;
	source: string;
	archivedAt: Date | null;
	discriminant?: string | null;
}

/**
 * Rank 2's own rule: the account a V3 export's `compte` column names, matched against accounts
 * the caller holds.
 *
 * Exported separately from `resolveStatementAccount` so a caller that must not read rank 3's
 * memory can still run this rule without pulling the whole ranked chain in — see
 * `decideAutoAccount`'s own doc for why the auto path is exactly that caller.
 *
 * ## Zero holders and two holders get the same answer, and it is not an oversight
 *
 * The column carries a NAME, and `@@unique([userId, name, source])` means two of the user's own
 * accounts CAN share one literal name across different sources (`naming/backfill.ts` and
 * `naming/mergePlan.ts` both key account collisions on `source + name`, never on name alone, for
 * this exact reason). A rank that picked either of two identically named accounts would file a
 * statement into an account it never came from with full confidence, which is the exact failure
 * ranks exist to prevent (see rank 1's own `kind: 'contradictory'` vs `'ambiguous'` split, above).
 * So a name matching more than one destination decides nothing here, exactly like a name matching
 * none: the caller falls through, refused rather than guessed.
 *
 * In the ordinary, unrenamed case this is not the common path: a bank-recognised bucket is named
 * after its institution (`institutionForSource`), so only the generic, no-institution `csv`
 * bucket shares its stored name with another generic `csv` bucket, and two of those cannot exist
 * for one user without one being archived first (`@@unique([userId, name, source])`).
 */
export function resolveNamedAccount(
	rows: ParsedCsvRow[],
	destinations: ResolvableAccount[]
): string | null {
	const named = readMaisonV3Account(rows);
	if (named === null) return null;
	const key = computeNameKey(named);
	const holders = destinations.filter((account) => computeNameKey(account.name) === key);
	return holders.length === 1 ? holders[0].id : null;
}

/**
 * Which account a statement belongs to, and how sure we are.
 *
 * The rank is part of the answer rather than an implementation detail, because the screen says
 * something different for each: rank 1 states the account, rank 3 `remembered` proposes the
 * account the user answered last time, and `orphan` and `multi-account` name what is wrong.
 *
 * Rank 3 holds at most ONE account by construction: the memory is keyed on the file's full
 * identifier, one row per user and identifier (`@@unique([userId, identifierKey])`), so there is no
 * set to choose from and no « ambiguous memory » state to represent.
 */
export type AccountResolution =
	| { rank: 1; accountId: string; fragment: string }
	| { rank: 1; kind: 'multi-account' }
	| { rank: 2; accountId: string }
	| { rank: 3; kind: 'remembered'; accountId: string }
	| { rank: 3; kind: 'orphan' }
	| { rank: 3; kind: 'unknown' };

/**
 * Where a statement should land, read from the file first and from the memory only afterwards.
 *
 * ## THE FILE BEATS THE MEMORY, ALWAYS
 *
 * This is the whole design and not an ordering detail. A memory is a record of what happened last
 * time, including the time the user picked the wrong account; a file's own account column is a
 * fact about the file. Letting the memory win would replay a memorised mistake for ever, which is
 * the defect this feature exists to prevent with one extra step. So rank 1 answers before rank 3
 * is read, and a `multi-account` file is refused before the memory is read AT ALL: a file that
 * carries evidence against a single account must not be overridden by a memory saying it is one.
 *
 * ## The memory is keyed on the file's own identifier, never on its shape (#599)
 *
 * A shape (the header row) is shared by every statement of one bank, so a memory keyed on it
 * cannot tell two accounts of that bank apart. The memory is keyed on the file's FULL account
 * identifier (`accountMemory.ts`), and a file carrying none gets `unknown`: asked, never guessed.
 *
 * ## `unknown` and `orphan` are different answers
 *
 * `unknown` means nothing is remembered for this identifier, or the file names none. `orphan` means
 * an answer is remembered and its account has since been archived. The screen says different
 * things.
 *
 * @param rows As `parseRows` returns them: `rows[0]` is the HEADER row, which is what
 *   `findDiscriminantColumn` reads around.
 * @param accounts The caller's own accounts. Every account returned comes from THIS list, so a
 *   remembered answer naming an account the caller does not hold can never be proposed.
 */
export async function resolveStatementAccount({
	userId,
	rows,
	accounts
}: {
	userId: string;
	rows: ParsedCsvRow[];
	accounts: ResolvableAccount[];
}): Promise<AccountResolution> {
	const destinations = accounts.filter(isDestination);

	// RANK 1: what the file itself names.
	//
	// `contradictory` ONLY, #485's plate-7 split: a verified IBAN pair that differs is proof against
	// a single account, and proof is what earns a rank-1 short-circuit ahead of the memory. A bare
	// digit run that varies (`ambiguous`) is exactly as consistent with a reference number or a
	// running balance as with a second account, so it is not proof, and it gets the SAME rank-1
	// answer as `kind: 'nothing-to-decide'`: nothing decides here, fall through and let the memory
	// answer. By the time this runs, `csv.ts`'s own door has already asked about that column when it
	// could (see #485's PR): a caller reaching this point with an unresolved `ambiguous` column,
	// source ambiguity notwithstanding, has either none to begin with or already had it answered
	// upstream.
	const named = findDiscriminantColumn(rows);
	if (named.kind === 'contradictory') {
		return { rank: 1, kind: 'multi-account' };
	}
	if (named.kind === 'resolved') {
		const holder = accountHoldingFragment(named.fragment, destinations);
		if (holder !== null) {
			return { rank: 1, accountId: holder, fragment: named.fragment };
		}
		// ZERO holders is the ordinary case of a first import from a new bank, and the memory is
		// still worth asking. TWO is supposed to be unreachable, since `assertDiscriminantFree` is the
		// precondition that makes rank 1 a statement rather than a guess, and if it ever happens
		// the answer is to fall through and ASK, never to take the first row.
	}

	// RANK 2: one of our own V3 exports, whose `compte` column names an account by NAME.
	//
	// The disambiguation the original comment here flagged as unmodelled is `resolveNamedAccount`'s
	// own job now: a name matching more than one destination refuses exactly like a name matching
	// none, so this rank never guesses between two accounts that happen to share a stored name.
	// See its doc for why that is safe in the ordinary case rather than a hole. #464.
	const namedAccountId = resolveNamedAccount(rows, destinations);
	if (namedAccountId !== null) {
		return { rank: 2, accountId: namedAccountId };
	}

	// RANK 3: what the user answered for this identifier last time, and only when the file names
	// one that no destination holds: `accountMemoryKeyOf` returns null for the file rank 1 decides,
	// which is the same predicate as the rank above, so the memory can never outrank the file.
	//
	// `userId` is in the SAME where clause as the key (`readRememberedAccount`), never a check
	// performed afterwards: two users of one instance importing one identifier compute one key.
	// ASVS v5.0.0-8.2.2.
	const key = accountMemoryKeyOf(rows, destinations);
	if (key === null) return { rank: 3, kind: 'unknown' };
	const remembered = await readRememberedAccount(userId, key);
	if (remembered === null) return { rank: 3, kind: 'unknown' };
	return destinations.some((account) => account.id === remembered.accountId)
		? { rank: 3, kind: 'remembered', accountId: remembered.accountId }
		: { rank: 3, kind: 'orphan' };
}

/**
 * Whether an account can receive a statement at all.
 *
 * The rule moved to `accounts/projection.ts` and is CALLED here rather than expressed twice. It was
 * written out in this file, computed again by `accountOffer.ts` from a query filter plus a
 * `filter()`, and about to be written a third time by the Comptes screen: three expressions of
 * « a live destination », agreeing by review. The local name stays because it reads better inside
 * the ranks below than the qualified one does.
 */
const isDestination = isStatementDestination;
