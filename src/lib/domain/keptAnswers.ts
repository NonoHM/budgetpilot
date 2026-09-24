import type { AccountColumnAnswer } from './accountColumnAnswer';
import type { DateOrder } from './dateReading';

/**
 * What `/import` hands back with every question it asks about a file: the file's key, and the
 * answers bound to that file so far, the account only once it resolved (`answerBinding.ts`'s
 * `keptAnswers` says exactly which are tested and which are merely bound). The page posts them
 * back, beside the answer to the question on screen, for as long as the same file is in hand.
 *
 * In `domain/` because both halves read it: `server/import/answerBinding.ts` builds it and
 * `routes/import/+page.svelte` posts it, and `$lib/server` is not importable from the client.
 */
export interface KeptAnswers {
	/** The SHA-256 of the file's bytes, which every answer below is bound to. */
	key: string;
	dateOrder: DateOrder | null;
	accountId: string | null;
	accountColumnAnswer: AccountColumnAnswer | null;
}
