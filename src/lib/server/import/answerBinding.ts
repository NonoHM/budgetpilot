import { createHash } from 'node:crypto';
import { readAccountColumnAnswer, type AccountColumnAnswer } from '$lib/domain/accountColumnAnswer';
import { readDateOrderAnswer, type DateOrder } from '$lib/domain/dateReading';
import type { KeptAnswers } from '$lib/domain/keptAnswers';

/**
 * AN ANSWER IS BOUND TO THE FILE IT WAS GIVEN FOR, and `/import` applies no other.
 *
 * `/import` asks up to three questions about one statement (does this column name accounts, which
 * of your accounts, how do its dates read), one per round trip, and every later request re-posts
 * the file together with every answer given so far. An answer is a fact about ONE file: the account
 * a March statement belongs to says nothing about the April statement a user picks next, and the
 * two routinely share a name (`releve.csv`) and a header row, so neither the name nor
 * `sourceFingerprintFor` can tell them apart. Applying the March answer to the April file files its
 * rows into an account nobody chose for them, with a summary that looks right.
 *
 * ## The binding
 *
 * The key is the SHA-256 of the uploaded bytes. The server computes it from the file in every
 * request, hands it back with every question it asks (`KeptAnswers.key`), and the page posts it
 * back as `answersFor` beside the answers. An answer is read only when `answersFor` equals the key
 * of the file in THIS request. On any mismatch, including an absent key, EVERY answer is dropped
 * rather than refused: the file in hand is then asked its own questions from the first one, which
 * is exactly what a new file should meet, and no sentence is needed to explain it.
 *
 * Dropped as a SET, never per field: the answers were given together about one file, and keeping
 * one of them for a different file is the defect this module exists to prevent.
 *
 * ## Why a digest and not a server secret
 *
 * The binding protects the user from the PAGE carrying a stale answer, not from the user: every
 * answer is still validated on its own merits after it is bound (the account against this user's
 * own accounts with `userId` in the same where clause, `resolveImportBucketAccountById`; the two
 * readings against their closed sets). A user who computes the digest by hand can only answer, for
 * their own file, a question they are entitled to answer, so a keyed MAC would add a secret to
 * manage and no protection. ASVS v5.0.0-2.3.1: an answer from another flow is not processed in this
 * one.
 */

/** The key an answer is bound to: the SHA-256 of the uploaded bytes, lowercase hex. */
export async function answerKeyFor(file: Blob): Promise<string> {
	return createHash('sha256')
		.update(new Uint8Array(await file.arrayBuffer()))
		.digest('hex');
}

/** An account id is resolved against the database; this only bounds what may be sent there. */
const ACCOUNT_ID_MAX_LENGTH = 128;

export interface BoundAnswers {
	dateOrder: DateOrder | null;
	accountId: string | null;
	accountColumnAnswer: AccountColumnAnswer | null;
}

const NO_ANSWERS: BoundAnswers = { dateOrder: null, accountId: null, accountColumnAnswer: null };

/**
 * The answers this request carries FOR THE FILE IT CARRIES, each validated positively
 * (ASVS v5.0.0-2.2.1): the two readings against their closed sets, the account id as a bounded
 * string that the caller then resolves against the user's own accounts. Anything else is absent.
 *
 * @param key `answerKeyFor` of the file in this same request, never a value the request supplied.
 */
export function readBoundAnswers(formData: FormData, key: string): BoundAnswers {
	if (formData.get('answersFor') !== key) return NO_ANSWERS;
	const accountId = formData.get('accountId');
	return {
		dateOrder: readDateOrderAnswer(formData.get('dateOrder')) ?? null,
		accountId:
			typeof accountId === 'string' &&
			accountId.length > 0 &&
			accountId.length <= ACCOUNT_ID_MAX_LENGTH
				? accountId
				: null,
		accountColumnAnswer: readAccountColumnAnswer(formData.get('accountColumnAnswer')) ?? null
	};
}

/**
 * What the page keeps while the same file is in hand (`KeptAnswers`): the key, and the answers the
 * server ACCEPTED for that file. The page posts these back with the next request, beside the answer
 * to whichever question is on screen, so no answered question is ever asked twice for one file.
 *
 * Echoed by the server rather than remembered by the page, so what is kept is what was accepted:
 * an account that did not resolve is not echoed, and the page stops posting it.
 */
export function keptAnswers(
	key: string,
	answers: BoundAnswers,
	accepted: { accountId: boolean }
): KeptAnswers {
	return {
		key,
		dateOrder: answers.dateOrder,
		accountId: accepted.accountId ? answers.accountId : null,
		accountColumnAnswer: answers.accountColumnAnswer
	};
}
