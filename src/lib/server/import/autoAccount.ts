import { buildAccountOffer, type AccountOffer } from './accountOffer';
import {
	findImportBucketAccountBySource,
	ImportBucketAccountError,
	resolveImportBucketAccountById,
	type ImportBucketAccount
} from './persist';
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
 * ## THE FILE IS READ BEFORE THE MEMORY, AND THE MEMORY IS NOT READ AT ALL
 *
 * Only `{ rank: 1, accountId }` short-circuits, which is the file's OWN account column naming an
 * account the user holds. A rank 3 answer is a memory, and the memory is written by the designation
 * screen: letting it decide here would replay a memorised mistake on the one path that shows the
 * user nothing and asks them nothing, which is the failure `sourceSignature.ts` refuses at length
 * under « THE FILE BEATS THE MEMORY, ALWAYS ». On the designated path the same memory only
 * PRE-FILLS a control the user can see and change. There is no such control here, so it decides
 * nothing.
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
	/** Two or more accounts share the source and nothing decides. The offer IS the question. */
	| { kind: 'ask'; offer: AccountOffer }
	/** A posted account reference that does not resolve against this user's own accounts. */
	| { kind: 'refused'; reason: 'not-found' | 'archived' };

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

	const lookup = await findImportBucketAccountBySource({
		userId: input.userId,
		source: input.source
	});
	if (lookup.kind !== 'ambiguous') {
		return { kind: 'by-source', existing: lookup.kind === 'one' ? lookup.bucket : null };
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

	return chosen ? { kind: 'account', bucket: chosen } : { kind: 'ask', offer };
}
