import { describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages';
import { accountAnswerFor } from './accountHint';

/**
 * The mapping from a ranked resolution to what the row SAYS.
 *
 * Every case names the two states it separates. The sentences come from the catalogue rather than
 * being retyped: retyping a French literal here would assert something an English locale never
 * renders, and would put the test and the thing under test on one source.
 */
const OPTIONS = [
	{ id: 'a1', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 },
	{ id: 'a2', name: 'Revolut · Perso', discriminant: null, transactionCount: 12 }
];

describe('what the account row is given to say', () => {
	it('states the account when the FILE named it, and says where it read it', () => {
		// SEPARATES: « the file itself named the account » FROM « we remembered one ». The user must
		// be able to tell a fact read from their statement from a habit inferred from their history,
		// because only one of the two is evidence about THIS file.
		const answer = accountAnswerFor({ rank: 1, accountId: 'a1', fragment: '4417' }, OPTIONS, null);
		expect(answer.accountId).toBe('a1');
		expect(answer.hint).toBe(m.import_account_hint_from_file({ fragment: '4417' }));
	});

	it('states the account when MEMORY named it, with the figures behind the memory', () => {
		// SEPARATES: « one remembered account, stated » FROM « several, asked ». The figures are what
		// make the sentence checkable by the user: a habit they can date is one they can disown.
		// The date arrives ALREADY FORMATTED, from the route that knows the negotiated locale, which
		// is the convention `replaces.namedAt` already follows on this screen. A domain module that
		// reached for an ambient locale is the failure `domain/money.ts` recorded: it passed every
		// gate and died at container startup.
		const answer = accountAnswerFor({ rank: 3, candidates: ['a2'] }, OPTIONS, {
			useCount: 3,
			lastUsedLabel: '15 août'
		});
		expect(answer.accountId).toBe('a2');
		expect(answer.hint).toBe(m.import_account_hint_from_memory({ count: 3, date: '15 août' }));
	});

	it('asks, and does not choose, when several accounts share the shape', () => {
		// SEPARATES: « the application asks » FROM « the application picks the first ». Picking is how
		// a statement lands in the wrong account silently, and it is the defect this piece removes.
		const answer = accountAnswerFor({ rank: 3, candidates: ['a1', 'a2'] }, OPTIONS, null);
		expect(answer.accountId).toBeNull();
		expect(answer.hint).toBe(m.import_account_hint_ambiguous());
	});

	it('says the shape is new when nothing is remembered', () => {
		// SEPARATES: « never seen this format » FROM « seen it and lost the account ». The two need
		// different sentences because only the second is a fault the user can do something about.
		const answer = accountAnswerFor({ rank: 3, candidates: [] }, OPTIONS, null);
		expect(answer.accountId).toBeNull();
		expect(answer.hint).toBe(m.import_account_hint_unknown());
	});

	it('says the remembered account is gone when the memory is orphaned', () => {
		// SEPARATES: « the memory is empty » FROM « the memory points at an account that no longer
		// exists ». Reporting the second as the first tells the user their format was never seen,
		// which is false and leaves them expecting the prefill to return.
		const answer = accountAnswerFor({ rank: 3, kind: 'orphan' }, OPTIONS, null);
		expect(answer.accountId).toBeNull();
		expect(answer.hint).toBe(m.import_account_hint_orphan());
	});

	it('asks when the FILE itself carries more than one account', () => {
		// SEPARATES: « the file names several accounts » FROM « we know several accounts ». The first
		// is a fact about the statement in hand and the second about the user's history, and the
		// sentence that names the wrong one sends them looking in the wrong place.
		const answer = accountAnswerFor({ rank: 1, kind: 'multi-account' }, OPTIONS, null);
		expect(answer.accountId).toBeNull();
		expect(answer.hint).toBe(m.import_account_hint_multi_account());
	});

	it('does not prefill an account that is not on the list it was given', () => {
		// SEPARATES: « the prefill names an option the panel actually holds » FROM « it names an id
		// nothing can display ». The second draws a row with a chosen account and a panel with no
		// selection, and the user cannot tell what is filed where. Reachable: an account archived
		// between the resolution and the render is exactly this.
		const answer = accountAnswerFor(
			{ rank: 1, accountId: 'gone', fragment: '4417' },
			OPTIONS,
			null
		);
		expect(answer.accountId).toBeNull();
	});
	it('says the user has NO accounts at all rather than that the format is new', () => {
		// SEPARATES: « you have no accounts, create one » FROM « this is the first statement of this
		// format ». Both are true of a user whose picker is empty, and only the first is the fact
		// they can act on: the second sends them looking for a choice that does not exist. Spec Part
		// G, the empty-picker cell, which is the state Task 8 exists for.
		//
		// The clause is FIRST, ahead of every rank, and that ordering is the assertion: rank 1 here
		// reads a fragment out of the file and names an account nobody holds, so the ranked sentence
		// would describe evidence about a statement to a user who has nowhere to put any statement.
		const answer = accountAnswerFor({ rank: 1, accountId: 'gone', fragment: '4417' }, [], null);
		expect(answer.accountId).toBeNull();
		expect(answer.hint).toBe(m.import_account_hint_no_accounts());
	});
});
