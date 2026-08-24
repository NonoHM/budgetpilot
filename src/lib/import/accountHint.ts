import * as m from '$lib/paraglide/messages';
import type { AccountResolution } from '$lib/server/import/sourceSignature';

/**
 * What the account row is given to SAY, from what resolution worked out.
 *
 * ## One function, because the row's eleven states are one sentence
 *
 * 6k's closing rule: « Tous les états au dessus sont des variations d'une seule phrase : voici le
 * compte, voici pourquoi, changez-le d'un appui. » So the mapping from a rank to a sentence is one
 * function rather than a branch in the markup, and every state it can produce is visible in one
 * place. A state absent from here is a state to add here, not to improvise at a call site.
 *
 * ## The rank is part of the answer, not an implementation detail
 *
 * The screen says something different for each, and the difference is what the user checks. Rank 1
 * read the FILE, which is evidence about the statement in hand. Rank 3 read our MEMORY, which is a
 * habit inferred from history. Reporting one as the other is not a wording problem: it tells the
 * user to verify the wrong thing.
 *
 * ## The date arrives formatted
 *
 * From the route that knows the negotiated locale, exactly as `replaces.namedAt` already does on
 * this screen. A module that reaches for an ambient locale is the failure `domain/money.ts`
 * recorded: it passed `check`, four thousand unit tests, lint and a full Playwright run, and died
 * at container startup.
 */
export interface AccountHintOption {
	id: string;
	name: string;
}

export interface AccountMemoryLabel {
	useCount: number;
	/** Already formatted by the caller. Never a `Date`, and never formatted here. */
	lastUsedLabel: string;
}

export interface AccountAnswer {
	/** The account to preselect, or null when the row must ask rather than state. */
	accountId: string | null;
	hint: string;
	/**
	 * Whether the sentence is a fact about the FILE rather than a provenance for the answer.
	 *
	 * The row drops its hint once the user overrides the resolution, because a provenance describes
	 * an answer that has been replaced. One sentence must survive that: « ce fichier contient
	 * plusieurs comptes » is the only on-screen notice that the file mixes accounts, and hiding it
	 * at the moment the user commits every row of that file to ONE account is the worst timing
	 * available. It is true whatever the user chooses, because it is about the bytes.
	 *
	 * Decided HERE and not on the screen. The screen receives an opaque string and cannot classify
	 * it, and a second classification written there would be the copied predicate this repository
	 * keeps measuring.
	 */
	aboutTheFile: boolean;
}

export function accountAnswerFor(
	resolution: AccountResolution,
	options: readonly AccountHintOption[],
	memory: AccountMemoryLabel | null
): AccountAnswer {
	/**
	 * A prefill is only a prefill if the panel can show it.
	 *
	 * An id resolution names but the options do not hold draws a row with an account chosen and a
	 * panel with nothing selected, and the user cannot tell what would be filed where. Reachable
	 * rather than theoretical: an account archived between the resolution and the render is exactly
	 * this, and so is a stale resolution carried across a navigation.
	 */
	const shown = (accountId: string): string | null =>
		options.some((option) => option.id === accountId) ? accountId : null;

	/**
	 * NO ACCOUNTS AT ALL, and this clause is first on purpose.
	 *
	 * Every sentence below describes a RANK: what the file said, what we remembered, what disagrees.
	 * All of them presuppose that there is somewhere to put a statement. When the picker is empty
	 * that presupposition is false, and rank 1's « IBAN ···4417 lu dans le fichier » would report
	 * evidence about the statement to a user who has nowhere to file any statement at all.
	 *
	 * DEVIATION FROM 6k, recorded: the plate's « Aucun compte » cell keeps state 4's « Premier relevé
	 * de ce format. » That is true and beside the point, and the spec's Part G corrects it. This
	 * user's fact is not about the format.
	 */
	if (options.length === 0) {
		return { accountId: null, hint: m.import_account_hint_no_accounts(), aboutTheFile: false };
	}

	if (resolution.rank === 1) {
		if ('kind' in resolution) {
			return { accountId: null, hint: m.import_account_hint_multi_account(), aboutTheFile: true };
		}
		return {
			accountId: shown(resolution.accountId),
			hint: m.import_account_hint_from_file({ fragment: resolution.fragment }),
			// A provenance despite naming the file: it explains why THIS account was proposed, and
			// once the user picks another it is explaining a choice that no longer stands.
			aboutTheFile: false
		};
	}

	if (resolution.rank === 2) {
		return {
			accountId: shown(resolution.accountId),
			hint: m.import_account_hint_unknown(),
			aboutTheFile: false
		};
	}

	if ('kind' in resolution) {
		return { accountId: null, hint: m.import_account_hint_orphan(), aboutTheFile: false };
	}

	if (resolution.candidates.length === 1) {
		return {
			accountId: shown(resolution.candidates[0]),
			// Without the figures the memory cannot be checked, so the sentence falls back to the one
			// that is merely true rather than inventing a count.
			hint: memory
				? m.import_account_hint_from_memory({
						count: memory.useCount,
						date: memory.lastUsedLabel
					})
				: m.import_account_hint_unknown(),
			aboutTheFile: false
		};
	}

	return {
		accountId: null,
		hint:
			resolution.candidates.length === 0
				? m.import_account_hint_unknown()
				: m.import_account_hint_ambiguous(),
		aboutTheFile: false
	};
}
