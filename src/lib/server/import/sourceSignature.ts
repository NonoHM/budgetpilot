import { isStatementAccount } from '$lib/domain/account';
import { prisma } from '$lib/server/db';
import { findDiscriminantColumn } from './discriminant';
import { fingerprintFor } from './mapping/fingerprint';
import type { ParsedCsvRow } from './types';

/**
 * An `Account` row as this module needs to see it, and nothing more.
 *
 * `discriminant` is optional because the caller's projection habitually omits it for buckets that
 * cannot carry one; an absent fragment and a NULL fragment mean the same thing here, which is
 * "this account is not named by any file".
 */
export interface ResolvableAccount {
	id: string;
	source: string;
	archivedAt: Date | null;
	discriminant?: string | null;
}

/**
 * Which account a statement belongs to, and how sure we are.
 *
 * The rank is part of the answer rather than an implementation detail, because the screen says
 * something different for each: rank 1 states the account, rank 3 with one candidate proposes it,
 * rank 3 with several asks, and both refusals name what is wrong with the file.
 */
export type AccountResolution =
	| { rank: 1; accountId: string; fragment: string }
	| { rank: 1; kind: 'multi-account' }
	| { rank: 2; accountId: string }
	| { rank: 3; candidates: string[] }
	| { rank: 3; kind: 'orphan' };

/**
 * The identity of a file SHAPE, for the purpose of remembering which account it landed on.
 *
 * `name` rather than `position`, and the reason is not the one that decides it for a column
 * mapping. A mapping keyed by position stores INDICES, so a reordered file finding it would read
 * amounts out of the date column; a signature stores an account id, which no reordering can
 * invalidate. A bank that moves a column is still the same bank and still the same account, so the
 * sorted canonical form is the one that keeps answering after an export changes. It also keeps one
 * row per shape under `@@unique([userId, fingerprint, discriminant])` rather than two.
 *
 * The digest is `fingerprintFor`'s, unchanged and un-truncated: one hashing path in this tree, so
 * a change to the canonical form moves both tables together or neither.
 */
export function sourceFingerprintFor(headers: string[]): string {
	return fingerprintFor(headers, 'name');
}

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
 * ## Ambiguity pre-fills NOTHING
 *
 * When the memory holds two accounts for one shape the answer is the SET, never the more recent or
 * the more used of the two. A guess that is right eight times in ten produces two misfiled
 * statements and no trace of the guess having been made, and a misfiled statement is discovered
 * months later as a balance that does not reconcile. `{ rank: 3; candidates }` carries no
 * `accountId` field by construction, so a caller cannot pre-fill from it by accident.
 *
 * ## `candidates: []` and `orphan` are different answers
 *
 * Empty means the shape was never seen. `orphan` means it was seen, and every account it was seen
 * landing on has since been deleted or archived. The screen says different things, and the
 * distinction is also what makes the scoping break-check in `sourceSignature.db-smoke.ts`
 * observable at all.
 *
 * @param rows As `parseRows` returns them: `rows[0]` is the HEADER row, which is both what
 *   `findDiscriminantColumn` reads around and what the fingerprint is taken over.
 * @param accounts The caller's own accounts. Every candidate returned comes from THIS list, so a
 *   signature row naming an account the caller does not hold can never be proposed.
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
	const named = findDiscriminantColumn(rows);
	if (named.kind === 'multi-account') return { rank: 1, kind: 'multi-account' };
	if (named.kind === 'found') {
		const holders = destinations.filter((account) => holdsFragment(account, named.fragment));
		if (holders.length === 1) {
			return { rank: 1, accountId: holders[0].id, fragment: named.fragment };
		}
		// ZERO holders is the ordinary case of a first import from a new bank, and the memory is
		// still worth asking. TWO is supposed to be unreachable, since `assertDiscriminantFree` is the
		// precondition that makes rank 1 a statement rather than a guess, and if it ever happens
		// the answer is to fall through and ASK, never to take the first row.
	}

	// RANK 2: one of our own V3 exports, whose `compte` column names an account by NAME.
	//
	// NOT IMPLEMENTED YET, AND DELIBERATELY SO: the V3 export format does not exist in this tree.
	// Inventing a header for it here would mean a recogniser written against a guess, which is the
	// worst of both, because it would look tested and would match nothing the exporter emits. The
	// task that adds the exporter adds the recogniser beside it, and this branch stops falling
	// through then. Until then a V3 file simply reaches rank 3 like any other.

	// RANK 3: what we remember.
	//
	// `userId` is in the SAME where clause as the fingerprint, never a check performed afterwards.
	// A fingerprint is a hash of a bank's PUBLIC column names, so every user of that bank shares
	// one: a global lookup is the DESIGNED behaviour of this key rather than a rare collision, and
	// what stands between it and a read of somebody else's configuration is that the composite
	// makes the safe query the shortest one to write. ASVS 5.0 V8.2.2.
	const remembered = await prisma.importSourceSignature.findMany({
		where: { userId, fingerprint: sourceFingerprintFor(headersOf(rows)) },
		select: { accountId: true },
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
	});
	if (remembered.length === 0) return { rank: 3, candidates: [] };

	const candidates: string[] = [];
	for (const { accountId } of remembered) {
		if (candidates.includes(accountId)) continue;
		if (destinations.some((account) => account.id === accountId)) candidates.push(accountId);
	}
	return candidates.length === 0 ? { rank: 3, kind: 'orphan' } : { rank: 3, candidates };
}

export type RememberResult = 'remembered' | 'not-found';

/**
 * Records that a file of this shape landed on this account. Called at SUCCESSFUL import only.
 *
 * ## The account is authorised in the statement, not beside it
 *
 * `accountId` reaches this function from a screen, so it is a claim rather than a fact (ASVS 5.0
 * V8.1.1). The foreign key only refuses an account that does not EXIST, not one belonging to
 * somebody else, so ownership is checked here and the write does not happen without it. A row
 * belonging to another user and a row that never existed are one answer, `not-found`, because
 * telling them apart would answer "does this id exist" for an id the caller does not own.
 *
 * ## Why this is not an `upsert`
 *
 * MEASURED on the generated client: `ImportSourceSignatureUserIdFingerprintDiscriminantCompound-
 * UniqueInput` types `discriminant` as `string`, NOT `string | null`, so the composite cannot be
 * named at all for the NULL-discriminant case, which is the ordinary case of a file that carries
 * no account column. The database agrees for its own reason: NULL never equals NULL in a unique
 * index, on all three engines, so an upsert keyed that way would insert a second row every time
 * rather than update the first. A scoped `findFirst` translates `discriminant: null` to `IS NULL`
 * and gets the row that is actually there.
 *
 * A second import of the same shape onto a DIFFERENT account overwrites `accountId` rather than
 * adding a row, which is the unique constraint's meaning read forwards: the memory is a record of
 * where this shape last landed, and a user correcting themselves must not leave the old answer
 * standing beside the new one.
 */
export async function rememberStatementAccount({
	userId,
	fingerprint,
	discriminant,
	accountId
}: {
	userId: string;
	fingerprint: string;
	discriminant: string | null;
	accountId: string;
}): Promise<RememberResult> {
	const owned = await prisma.account.findFirst({
		where: { id: accountId, userId },
		select: { id: true }
	});
	if (!owned) return 'not-found';

	const existing = await prisma.importSourceSignature.findFirst({
		where: { userId, fingerprint, discriminant },
		select: { id: true }
	});

	if (existing) {
		// `updateMany` rather than `update`, so `userId` stays part of the statement the database
		// executes rather than a condition satisfied a query earlier.
		await prisma.importSourceSignature.updateMany({
			where: { id: existing.id, userId },
			data: { accountId, useCount: { increment: 1 }, lastUsedAt: new Date() }
		});
		return 'remembered';
	}

	await prisma.importSourceSignature.create({
		data: { userId, fingerprint, discriminant, accountId, useCount: 1, lastUsedAt: new Date() }
	});
	return 'remembered';
}

/** `rows[0]` is the header row. An empty file has no shape, and hashes the empty list. */
function headersOf(rows: ParsedCsvRow[]): string[] {
	return rows[0]?.cells ?? [];
}

/**
 * Whether an account can receive a statement at all.
 *
 * `isStatementAccount` is called rather than its condition retyped: it is an EXCLUSION set whose
 * whole point is that a source nobody has heard of still counts, and a second expression of it
 * here would be the copy that drifts. Archived is the other half: an archived account keeps every
 * transaction it ever received and stops being a destination.
 */
function isDestination(account: ResolvableAccount): boolean {
	return isStatementAccount(account) && account.archivedAt === null;
}

/** Fragments compare trimmed and upper cased, the same way `assertDiscriminantFree` compares them. */
function holdsFragment(account: ResolvableAccount, fragment: string): boolean {
	const held = (account.discriminant ?? '').trim().toUpperCase();
	return held !== '' && held === fragment.trim().toUpperCase();
}
