import { prisma } from '$lib/server/db';
import { isUniqueConstraintViolation } from '$lib/server/database/upsert';
import { accountsForPicker, displayAccountName } from '$lib/server/accounts/projection';
import {
	accountHoldingFragment,
	findDiscriminantColumn,
	statementIdentifier
} from './discriminant';
import { accountMemoryKeyFor } from './accountMemoryKey';
import type { ResolvableAccount } from './sourceSignature';
import type { ParsedCsvRow } from './types';

/**
 * WHICH ACCOUNT A STATEMENT'S OWN IDENTIFIER BELONGS TO, AS THE USER ANSWERED IT (#599, #696).
 *
 * ## The owner's conditions, and where each one lives
 *
 * - **Evidence outranks memory.** A file whose identifier an account already holds decides by
 *   itself (`accountHoldingFragment`, rank 1), and this memory is neither read nor written for it.
 *   One predicate for both directions, so a row can never be written that the reader would skip,
 *   nor read where the writer would have refused.
 * - **Read only on the ambiguous branch.** The reader is rank 3 of `resolveStatementAccount`, which
 *   the auto path consults only once it has decided to ASK (`autoAccount.ts`); there the memory
 *   pre-fills the question, and the user still presses « Importer ».
 * - **Visible and revocable.** Every row is listed in Settings, « Comptes mémorisés », and forgotten
 *   there (`forgetRememberedAccount`).
 * - **Keyed on the FULL identifier**, through a keyed hash (`accountMemoryKey.ts`), never on the
 *   fragment: two cards at one bank can end in the same four digits.
 *
 * ## What a file with no identifier gets
 *
 * Nothing: no key, no memory, and the question each time. A memory keyed on anything weaker than
 * the file's own identifier (its header shape, which every statement of a bank shares) could not
 * tell two accounts of one bank apart, and would file one's statements into the other with a
 * sentence saying it remembered.
 */
export interface AccountMemoryKey {
	identifierKey: string;
	/** Display only (« ···4417 »). Never a key, never a filter. */
	fragment: string;
}

/**
 * The key this file's identifier is remembered under, or null when the memory does not apply.
 *
 * Null when the file names no single constant identifier (`findDiscriminantColumn` is not
 * `resolved`), and null when one of `destinations` already holds its fragment: that file proves its
 * own account, and the memory is not consulted for it at all.
 */
export function accountMemoryKeyOf(
	rows: ParsedCsvRow[],
	destinations: readonly ResolvableAccount[]
): AccountMemoryKey | null {
	const named = namedIdentifierOf(rows);
	if (named === null) return null;
	if (named.holder(destinations) !== null) return null;
	return named.key;
}

/** The file's one constant identifier, keyed, and a way to ask which destination holds it. */
function namedIdentifierOf(rows: ParsedCsvRow[]) {
	const verdict = findDiscriminantColumn(rows);
	if (verdict.kind !== 'resolved') return null;
	return {
		key: {
			identifierKey: accountMemoryKeyFor(statementIdentifier(rows, verdict)),
			fragment: verdict.fragment
		} satisfies AccountMemoryKey,
		holder: (destinations: readonly ResolvableAccount[]) =>
			accountHoldingFragment(verdict.fragment, destinations)
	};
}

export interface RememberedAnswer {
	accountId: string;
	useCount: number;
	rememberedAt: Date;
}

/**
 * The answer remembered under this key, for THIS user. `userId` is in the same where clause as the
 * key, never checked afterwards: the key is a function of the identifier and the instance secret
 * alone, so two users of one instance importing the same identifier compute the same key
 * (ASVS v5.0.0-8.2.2).
 */
export async function readRememberedAccount(
	userId: string,
	key: AccountMemoryKey
): Promise<RememberedAnswer | null> {
	return prisma.rememberedAccount.findFirst({
		where: { userId, identifierKey: key.identifierKey },
		select: { accountId: true, useCount: true, rememberedAt: true }
	});
}

export type RememberOutcome = 'remembered' | 'not-applicable' | 'not-found';

/**
 * THE WRITER, called once an import filed on the user's ANSWER has succeeded (#696).
 *
 * `accountId` reached the route from a form, so it is a claim: resolved against this user's own
 * accounts with `userId` in the same where clause, and a foreign or unknown id is `not-found`
 * without telling the two apart (ASVS v5.0.0-8.2.2). The route has already resolved it the same way
 * before writing; this does not rely on that.
 *
 * The same answer again counts one more use. A DIFFERENT account for the same identifier replaces
 * the answer, count and date included: the user correcting themselves must not leave the old
 * answer standing, and « utilisé 7 fois » would describe an answer they just withdrew.
 */
export async function rememberAnsweredAccount(input: {
	userId: string;
	rows: ParsedCsvRow[];
	accountId: string;
}): Promise<RememberOutcome> {
	const held = await prisma.account.findMany({
		where: { userId: input.userId },
		select: { id: true, name: true, source: true, archivedAt: true, discriminant: true }
	});
	if (!held.some((account) => account.id === input.accountId)) return 'not-found';

	// The destinations the READER compares against (`buildAccountOffer` hands the resolver
	// `accountsForPicker`), so the two sides of « the file decides » read one set.
	//
	// ONE EXCEPTION to « no row where the file decides » (M2, contradiction pass): when the account
	// the user answered IS the one holding the file's fragment, typically an account just created
	// from this file after an earlier answer misfiled it, the answer is written. The reader never
	// consults it (rank 1 answers first), but Settings then names the account the statements really
	// go to, instead of keeping the withdrawn answer listed. Held by ANOTHER account: nothing.
	const named = namedIdentifierOf(input.rows);
	const holder = named?.holder(accountsForPicker(held)) ?? null;
	if (named === null || (holder !== null && holder !== input.accountId)) return 'not-applicable';
	const key = named.key;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const existing = await prisma.rememberedAccount.findFirst({
			where: { userId: input.userId, identifierKey: key.identifierKey },
			select: { id: true, accountId: true }
		});
		if (existing) {
			// `updateMany` rather than `update`, so `userId` stays in the statement the database runs.
			await prisma.rememberedAccount.updateMany({
				where: { id: existing.id, userId: input.userId },
				data:
					existing.accountId === input.accountId
						? { useCount: { increment: 1 } }
						: { accountId: input.accountId, useCount: 1, rememberedAt: new Date() }
			});
			return 'remembered';
		}
		try {
			await prisma.rememberedAccount.create({
				data: {
					userId: input.userId,
					identifierKey: key.identifierKey,
					fragment: key.fragment,
					accountId: input.accountId
				}
			});
			return 'remembered';
		} catch (caught) {
			// Two imports of one identifier finishing together: the other one created the row between
			// the read and the create. Read it again and count this use on it.
			if (!isUniqueConstraintViolation(caught)) throw caught;
		}
	}
	throw new Error('The remembered account could not be written after a concurrent create');
}

/** One row of « Comptes mémorisés », in the shape it crosses the wire in. */
export interface RememberedAccountRow {
	id: string;
	fragment: string;
	/** Through `displayAccountName`, the one rule every surface names an account by. */
	accountName: string;
	useCount: number;
	rememberedAt: Date;
}

export async function listRememberedAccounts(userId: string): Promise<RememberedAccountRow[]> {
	const rows = await prisma.rememberedAccount.findMany({
		where: { userId },
		select: {
			id: true,
			fragment: true,
			useCount: true,
			rememberedAt: true,
			account: { select: { name: true, nameKey: true, source: true, institution: true } }
		},
		orderBy: [{ rememberedAt: 'desc' }, { id: 'asc' }]
	});
	return rows.map((row) => ({
		id: row.id,
		fragment: row.fragment,
		accountName: displayAccountName(row.account),
		useCount: row.useCount,
		rememberedAt: row.rememberedAt
	}));
}

export type ForgetOutcome = 'forgotten' | 'not-found';

/**
 * « Oublier ». The user's own row or nothing: `deleteMany` with `userId` in the filter, so a row
 * of another user and a row that never existed are one answer, and the response is no oracle for
 * whether somebody else's id is real (ASVS v5.0.0-8.2.2). The next statement of that account asks
 * again; imported transactions do not move.
 */
export async function forgetRememberedAccount(userId: string, id: string): Promise<ForgetOutcome> {
	const { count } = await prisma.rememberedAccount.deleteMany({ where: { id, userId } });
	return count > 0 ? 'forgotten' : 'not-found';
}
