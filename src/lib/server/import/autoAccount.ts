import { prisma } from '$lib/server/db';
import { accountsForPicker } from '$lib/server/accounts/projection';
import { buildAccountOffer, type AccountOffer } from './accountOffer';
import {
	findImportBucketAccountBySource,
	ImportBucketAccountError,
	resolveImportBucketAccountById,
	type ImportBucketAccount
} from './persist';
import { resolveNamedAccount } from './sourceSignature';
import { accountHoldingFragment, findDiscriminantColumn } from './discriminant';
import type { ParsedCsvRow } from './types';

/**
 * Which account an AUTO-DETECTED statement lands in, decided with nothing on screen.
 *
 * ## Why this is a module rather than four branches in the route
 *
 * The same reason `accountOffer.ts` gives one door down: the route would have to build the offer to
 * refuse with it and then read the offer again to decide whether to refuse at all, and those two
 * readings are the pair that drifts. Here the question is asked once and the answer carries
 * everything the caller needs for either outcome.
 *
 * ## THE FILE IS READ BEFORE THE MEMORY, AND THE MEMORY DECIDES NOTHING HERE
 *
 * Rank 2 short-circuits unconditionally, ahead of source bucketing: a V3 export's own PROFILE
 * always buckets as `csv` regardless of which account its rows actually left, so if rank 2 waited
 * for the source lookup to be ambiguous the way rank 1 does below, it would never run on the
 * common case of a fresh re-import, and #464 would still double every row. Rank 1 stays scoped to
 * the ambiguous branch: a recognised bank file's own PROFILE already buckets it correctly, so rank
 * 1 only has within-source accounts to disambiguate, which is a question that does not arise until
 * the source lookup already found more than one.
 *
 * `resolveNamedAccount` is called directly rather than the full `resolveStatementAccount`, and
 * that is what keeps rank 3 out of every DECISION this function returns: the combined resolver
 * falls through to a memory read the moment ranks 1 and 2 both miss. Letting it decide here would
 * replay a remembered answer on the one path that shows the user nothing, which is the failure
 * `sourceSignature.ts` refuses under « THE FILE BEATS THE MEMORY, ALWAYS ». The memory is read
 * only once this function has decided to ASK, inside the offer (`buildAccountOffer`), where it
 * PRE-FILLS the question the user sees and still answers with « Importer » (#599's ruling: read
 * only on the ambiguous branch, visible, and never over a file that proves its own account).
 *
 * `{ rank: 1, kind: 'multi-account' }` does not short-circuit either, and deliberately falls
 * through to today's behaviour rather than becoming a new refusal: a file that imports today must
 * not stop importing because this path learned to read. What it gets instead is a sentence, built
 * by the caller from `findDiscriminantColumn`, saying where the rows went and that the file carried
 * several accounts. Filed as its own defect (#485); the sentence is the mitigation, not the fix.
 */
export type AutoAccountDecision =
	/**
	 * Nothing is ambiguous, so the untouched resolve-or-create path decides.
	 *
	 * `existing` is that source's one account when it already has one, and null when it does not.
	 * It is named for what it IS rather than `bucket`, because it is not a decision: the caller's
	 * own resolve-or-create call is what may create the first bucket for a source, and a second
	 * writer of that row is the duplication this whole piece removes. It is carried only so the
	 * collision fingerprints are built against the row the transactions will land in, which is what
	 * the caller read from this lookup before this function existed.
	 */
	| { kind: 'by-source'; existing: ImportBucketAccount | null }
	/** An account is decided: the file named it, or the user answered with it. */
	| { kind: 'account'; bucket: ImportBucketAccount }
	/**
	 * Nothing decides, so the user is asked. The offer IS the question; `cause` is what the banner
	 * above it says, because the two causes are different facts: « vous avez plusieurs comptes pour
	 * cette banque » is false for #599's user, who holds one.
	 */
	| { kind: 'ask'; offer: AccountOffer; cause: AskCause }
	/** A posted account reference that does not resolve against this user's own accounts. */
	| { kind: 'refused'; reason: 'not-found' | 'archived' };

/**
 * - `several-accounts`: two or more accounts share the file's source and the file names none of
 *   them.
 * - `names-another-account`: the source has ONE account, and the file's own account column names
 *   an identifier that account does not hold (#599).
 */
export type AskCause = 'several-accounts' | 'names-another-account';

/**
 * #599: the ONE account of this source holds a known fragment, and the file's account column
 * names a different one.
 *
 * Ruled « ask » (2026-09-23), the ambiguous branch of the file-evidence rule: a constant identifier
 * the held account does not carry could be another account at the same bank, or this account
 * written another way (M2 measured one account under three identifiers: IBAN or RIB, bare account
 * number, card number). Nothing in the file contradicts itself, so it is not a refusal, and the
 * file is not silent, so it is not a default.
 *
 * Scoped to a KNOWN fragment, the reversible decision the plan records: an account with none has
 * never been named by a file, so a file naming an identifier says nothing against it, and asking
 * there would ask every user whose bucket predates fragments on every statement.
 */
function namesAnotherAccount(
	rows: ParsedCsvRow[],
	account: { id: string; discriminant: string | null } | undefined
): boolean {
	if (account === undefined || (account.discriminant ?? '').trim() === '') return false;
	const verdict = findDiscriminantColumn(rows);
	// Rank 1's own comparison, called rather than retyped: « holds this fragment » means one thing.
	return (
		verdict.kind === 'resolved' && accountHoldingFragment(verdict.fragment, [account]) === null
	);
}

export async function decideAutoAccount(input: {
	userId: string;
	source: string;
	rows: ParsedCsvRow[];
	/** The user's answer to a previous `ask`, when there has been one. */
	chosenId?: string | null;
}): Promise<AutoAccountDecision> {
	if (input.chosenId) {
		// The answer is a CLAIM (ASVS 5.0 V8.2.2, data-specific access / IDOR / BOLA, and V8.3.1 for
		// enforcing it at the service layer rather than in the browser), resolved against this
		// user's own accounts and never trusted for having arrived in a form.
		//
		// V8.2.2 and not V8.1.1, which several older comments in this tree cite for the same rule.
		// V8.1.1 is a DOCUMENTATION requirement, and `scripts/security/asvs-5.0-l1-mapping.md:238`
		// marks it `X`, not met, tracked as #246. Citing an unmet documentation requirement as the
		// control a line implements reads, to the next person auditing this, as evidence for
		// something it is not.
		//
		// `resolveImportBucketAccountById` is called
		// rather than its query retyped, so the auto path and the designation path refuse an
		// account that is not yours, or archived, by one rule and with one pair of answers.
		try {
			return {
				kind: 'account',
				bucket: await resolveImportBucketAccountById({
					userId: input.userId,
					accountId: input.chosenId
				})
			};
		} catch (error) {
			if (error instanceof ImportBucketAccountError) {
				return { kind: 'refused', reason: error.reason };
			}
			throw error;
		}
	}

	// RANK 2, ahead of any source bucketing. See the module doc for why this must not wait for
	// the by-source lookup to be ambiguous, and `sourceSignature.ts`'s own doc for why a name
	// matching more than one of the user's accounts refuses rather than guesses.
	const destinations = accountsForPicker(
		await prisma.account.findMany({
			where: { userId: input.userId, archivedAt: null },
			select: { id: true, name: true, source: true, archivedAt: true, discriminant: true }
		})
	);
	const namedByExport = resolveNamedAccount(input.rows, destinations);
	if (namedByExport !== null) {
		try {
			return {
				kind: 'account',
				bucket: await resolveImportBucketAccountById({
					userId: input.userId,
					accountId: namedByExport
				})
			};
		} catch (error) {
			if (!(error instanceof ImportBucketAccountError)) throw error;
			// The named account no longer resolves (archived or gone between the two reads above,
			// a race rather than the ordinary case): by-source bucketing decides below, exactly as
			// it would have if rank 2 had found nothing.
		}
	}

	const lookup = await findImportBucketAccountBySource({
		userId: input.userId,
		source: input.source
	});
	if (lookup.kind === 'none') return { kind: 'by-source', existing: null };
	if (lookup.kind === 'one') {
		const held = destinations.find((account) => account.id === lookup.bucket.accountId);
		if (!namesAnotherAccount(input.rows, held)) {
			return { kind: 'by-source', existing: lookup.bucket };
		}
		return {
			kind: 'ask',
			offer: await buildAccountOffer({
				userId: input.userId,
				rows: input.rows,
				source: input.source
			}),
			cause: 'names-another-account'
		};
	}

	const offer = await buildAccountOffer({
		userId: input.userId,
		rows: input.rows,
		source: input.source
	});

	/**
	 * The rank 1 account, checked against the candidates of THIS source rather than accepted.
	 *
	 * `resolveStatementAccount` searches every destination the user holds, and
	 * `assertDiscriminantFree` makes a fragment unique across those without making it unique within
	 * one source. So a Banque Populaire statement whose column ends 4417 can resolve at rank 1 onto
	 * a Revolut account holding that same fragment. Taking it would file a statement across banks on
	 * a four-character coincidence, silently and with full confidence, which is worse than the dead
	 * end this function removes. The `find` is the check and the lookup is what made it writable.
	 */
	const named =
		offer.resolution.rank === 1 && 'accountId' in offer.resolution
			? offer.resolution.accountId
			: null;
	const chosen = named
		? lookup.candidates.find((candidate) => candidate.accountId === named)
		: undefined;

	return chosen
		? { kind: 'account', bucket: chosen }
		: { kind: 'ask', offer, cause: 'several-accounts' };
}
