import { GENERIC_BUCKET_STORED_NAME, isStatementAccount } from '$lib/domain/account';
import { computeNameKey } from '$lib/server/naming/nameKey';
import * as m from '$lib/paraglide/messages';

/**
 * How an account is CHOSEN and how it is NAMED, in one module, because the two answers must agree.
 *
 * ## Why this is a server module and why it may not move into `domain/`
 *
 * `domain/account.ts` imports nothing on purpose, and this module calls a Paraglide message.
 * Anything importing `$lib/paraglide/messages` outside a request has no negotiated locale, which is
 * how `domain/money.ts` once failed at container startup after `check` over 3 767 files, 4 000 unit
 * tests, `lint:tracked` and a full Playwright run had all passed. Every caller here is a `load` or
 * an action, so a request and its locale are always in scope.
 *
 * It is also not a page server module. SvelteKit allows `+page.server.ts` to export only `load`,
 * `prerender`, `csr`, `ssr`, `trailingSlash`, `config`, `actions`, `entries`, or a `_`-prefixed
 * name, and a helper exported from one breaks `npm run build` while every other gate stays green.
 * That is recorded next door in `transactions/accountProjection.ts`, which was the instance.
 *
 * ## The four rules, and why they are four rather than one per screen
 *
 * `domain/account.ts` says of `isStatementAccount` that three callers read it and « agree by
 * construction rather than by review ». That sentence is only true if the projections they read are
 * also one definition, so they are here rather than one per screen:
 *
 * - `accountsForList` — the Comptes screen, which shows archived accounts so the user can see what
 *   they archived.
 * - `accountsForPicker` — the import destination panel, which must not offer one.
 * - `isGenericallyNamed` — consumed by `displayAccountName` AND by `invitationApplies`, so the
 *   rendering rule and the invitation are the same claim asked twice rather than two rules that
 *   happen to agree today.
 * - `displayAccountName` — the ONE place a stored bucket name becomes a sentence.
 */

/**
 * The `Account` columns the NAMING rules read. Narrow on purpose: a projection selects, and every
 * column named here becomes a column three `load`s have to add to their `select`.
 *
 * `archivedAt` is deliberately absent. Naming an account and offering it as a destination are
 * different questions, and a shape that carried both would make `/transactions` select a column its
 * detail panel has no use for.
 */
export interface NameableAccount {
	name: string;
	nameKey: string | null;
	source: string;
	institution: string | null;
}

/** What the Comptes list reads: a nameable account, plus the half that decides destinations. */
export type ProjectableAccount = NameableAccount & { archivedAt: Date | null };

/**
 * Whether this account can receive a statement TODAY.
 *
 * `isStatementAccount` is called rather than its condition retyped: it is an EXCLUSION set whose
 * whole point is that a source nobody has heard of still counts, and a second expression of it here
 * would be the copy that drifts. Archived is the other half, and it is a fact about time rather
 * than about kind: an archived account keeps every transaction it ever received and stops being a
 * destination. That asymmetry is exactly why the list and the picker are two functions.
 */
export function isStatementDestination(account: {
	source: string;
	archivedAt: Date | null;
}): boolean {
	return isStatementAccount(account) && account.archivedAt === null;
}

/**
 * The accounts the Comptes screen lists: every statement account, archived ones included.
 *
 * Archived rows stay, and this is the deliberate half. Hiding them would leave a user who archived
 * an account by mistake with no screen on which to see it, and archiving is reversible only if it
 * is visible. The row says so with `accounts_archived_notice` rather than disappearing.
 */
export function accountsForList<T extends { source: string }>(accounts: readonly T[]): T[] {
	return accounts.filter((account) => isStatementAccount(account));
}

/** The accounts the import picker offers. Same set, minus the ones that stopped being destinations. */
export function accountsForPicker<T extends { source: string; archivedAt: Date | null }>(
	accounts: readonly T[]
): T[] {
	return accounts.filter((account) => isStatementDestination(account));
}

/**
 * Whether this account still carries the name the MACHINE gave it.
 *
 * Compared through `computeNameKey` rather than against the stored string, and the reason is the
 * same one the key exists for at all: two spellings of one name are one name here, so a row a
 * migration wrote with different casing or accents is still the machine's name. Comparing the raw
 * strings would make the answer depend on how the row happened to be written.
 *
 * `institution === null` is the other half and it carries the two banks: the backfill writes
 * « Banque Populaire » and « Revolut » into `institution` and into `name`, so those buckets are
 * named as the bank names them and are not invited to be renamed.
 *
 * SELF-CLEARING, which is the property that makes the invitation safe to show: renaming the bucket
 * changes `nameKey`, this goes false, the substitution stops and the sentence stops with it. An
 * account created in the sheet (Task 8) carries `source: 'csv'` and `institution: null` exactly
 * like the generic bucket, and differs in the one place that decides: its owner typed the name.
 */
export function isGenericallyNamed(account: {
	name: string;
	nameKey: string | null;
	institution: string | null;
}): boolean {
	if (account.institution !== null) return false;
	/**
	 * `Account.nameKey` IS NULLABLE, and the null is not hypothetical here: it is likeliest on
	 * exactly the row this predicate exists for.
	 *
	 * The column carries no unique constraint (schema.prisma's own comment says why), and the boot
	 * backfill writes it only for accounts matching `accountsPendingWhere()`, which the generic
	 * `csv` bucket does not match — it has no institution to write. So a bucket created before the
	 * column existed keeps a null key for ever, and a comparison against it would answer « not the
	 * machine's name » about the one account that is most certainly carrying it: the rendering would
	 * show « Compte import CSV » raw and the invitation would never fire, on the exact installation
	 * that most needs both.
	 *
	 * Recomputed from `name` rather than defaulted, because that is what the key MEANS. The
	 * comparison is then a pure function of what is stored, which is the rule anything recomputed
	 * from a row is held to in this repository.
	 */
	const key = account.nameKey ?? computeNameKey(account.name);
	return key === GENERIC_BUCKET_NAME_KEY;
}

const GENERIC_BUCKET_NAME_KEY = computeNameKey(GENERIC_BUCKET_STORED_NAME);

/**
 * Whether the « nommez-les comme votre banque les nomme » line has anything to be true about.
 *
 * Conditional on a generically named account rather than on there being any account, per the spec's
 * Part N.3: after the backfill two of the three migrated buckets ARE named as the bank names them,
 * and the plate's unconditional plural sentence tells that user to do something already done, on
 * accounts it points at by pointing at all of them.
 */
export function invitationApplies(accounts: readonly NameableAccount[]): boolean {
	return accountsForList(accounts).some((account) => isGenericallyNamed(account));
}

/**
 * The name of an account, as a person reads it.
 *
 * TWO SUBSTITUTIONS AND ONE PASS-THROUGH, and the two substitutions exist for opposite reasons.
 * The manual bucket has no name of its own at all: `ensureManualAccount` resolves it on the stored
 * string « Compte manuel », which is a lookup key that was never written for anybody to read. The
 * generic bucket's name IS readable and is the machine's rather than the user's, and it stays in
 * the column because it is half of `@@unique([userId, name, source])` — a localised string does not
 * live in a database column, and this repository has one expensive instance of that exact rule.
 *
 * Everything else reads the row, which is the case the whole piece exists to create.
 */
export function displayAccountName(account: NameableAccount): string {
	if (!isStatementAccount(account)) return m.accounts_manual_entry();
	if (isGenericallyNamed(account)) return m.accounts_generic_bucket();
	return account.name;
}

/**
 * One row of the Comptes screen, in the shape it crosses the wire in.
 *
 * `displayName` is computed HERE rather than on the page, and that is not tidiness: the rule reads
 * a Paraglide message, and a page that computed it would need the stored name and the folded key on
 * the client to do so. Sending a name the user must not see so the client can decide not to show it
 * is the shape that leaks it into a screenshot the first time somebody renders the wrong branch.
 *
 * `generic` travels beside it for the same reason the invitation exists: the row itself says why it
 * is being invited, so the sentence and the row cannot disagree.
 */
export interface AccountListRow {
	id: string;
	displayName: string;
	generic: boolean;
	discriminant: string | null;
	transactionCount: number;
	archived: boolean;
	netWorthAccountId: string | null;
	netWorthAccountName: string | null;
}

export function accountListRows(
	accounts: readonly (ProjectableAccount & {
		id: string;
		discriminant: string | null;
		netWorthAccountId: string | null;
		netWorthAccount: { name: string } | null;
		_count: { transactions: number };
	})[]
): AccountListRow[] {
	return accountsForList(accounts).map((account) => ({
		id: account.id,
		displayName: displayAccountName(account),
		generic: isGenericallyNamed(account),
		discriminant: account.discriminant,
		transactionCount: account._count.transactions,
		archived: account.archivedAt !== null,
		netWorthAccountId: account.netWorthAccountId,
		netWorthAccountName: account.netWorthAccount?.name ?? null
	}));
}
