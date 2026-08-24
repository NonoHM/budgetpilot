import { describe, expect, it } from 'vitest';
import { GENERIC_BUCKET_STORED_NAME, isStatementAccount } from '$lib/domain/account';
import { computeNameKey } from '$lib/server/naming/nameKey';
import * as m from '$lib/paraglide/messages';
import {
	accountsForList,
	accountsForPicker,
	displayAccountName,
	invitationApplies,
	isGenericallyNamed,
	isStatementDestination
} from './projection';

/**
 * ONE PREDICATE, READ BY THE LIST, THE PICKER AND THE INVITATION.
 *
 * `domain/account.ts`'s own docstring already names those three readers and says they « agree by
 * construction rather than by review ». This file is where that sentence stops being a claim: the
 * expected value of each projection is COMPUTED from `isStatementAccount` here rather than typed
 * out, so a fixture whose membership somebody edits moves both sides of the comparison together and
 * the test keeps asking the question it was written to ask.
 *
 * The exception is `isGenericallyNamed`, whose two expected values are written by hand on purpose.
 * Deriving them from the function under test would be the identity comparison this repository has a
 * rule against; the whole point of those two lines is that a human decided which of the two
 * accounts is still carrying a machine's name.
 */

const manualBucket = {
	id: 'acc-manual',
	name: 'Compte manuel',
	nameKey: computeNameKey('Compte manuel'),
	source: 'manual',
	institution: null,
	archivedAt: null
};

const csvBucket = {
	id: 'acc-csv',
	name: GENERIC_BUCKET_STORED_NAME,
	nameKey: computeNameKey(GENERIC_BUCKET_STORED_NAME),
	source: 'csv',
	institution: null,
	archivedAt: null
};

const bpBucket = {
	id: 'acc-bp',
	name: 'Banque Populaire',
	nameKey: computeNameKey('Banque Populaire'),
	source: 'banque_populaire',
	institution: 'Banque Populaire',
	archivedAt: null
};

const archivedBucket = { ...bpBucket, id: 'acc-archived', archivedAt: new Date('2026-08-01') };

describe('the three projections read one predicate', () => {
	it('the list and the picker agree on a fixture where nothing is archived', () => {
		// SEPARATES: « both projections call `isStatementAccount` » FROM « one of them retypes its
		// condition and the two happen to agree today ». The expected value is derived from the
		// predicate itself, so a source added to the exclusion set moves all three at once.
		expect.assertions(3);
		const fixture = [manualBucket, csvBucket, bpBucket];
		const listed = fixture.filter(isStatementAccount).map((account) => account.id);
		// The absolute figure beside the identity: two of the three, never zero and never all three.
		expect(listed).toStrictEqual(['acc-csv', 'acc-bp']);
		expect(accountsForList(fixture).map((account) => account.id)).toStrictEqual(listed);
		expect(accountsForPicker(fixture).map((account) => account.id)).toStrictEqual(listed);
	});

	it('the picker drops an archived account and the list keeps it', () => {
		// SEPARATES: « archived is the half the PICKER adds » FROM « the two projections are the same
		// function under two names ». This is the only fixture on which they may differ, and a
		// management screen that hid an archived account would leave the user no way to see what
		// they archived, which is the state `accounts_archived_notice` exists for.
		expect.assertions(2);
		const fixture = [manualBucket, csvBucket, bpBucket, archivedBucket];
		expect(accountsForList(fixture).map((account) => account.id)).toStrictEqual([
			'acc-csv',
			'acc-bp',
			'acc-archived'
		]);
		expect(accountsForPicker(fixture).map((account) => account.id)).toStrictEqual([
			'acc-csv',
			'acc-bp'
		]);
	});

	it('the destination predicate is what both the resolver and the offer already meant', () => {
		// SEPARATES: « one definition of `a live destination` » FROM « three expressions of it ».
		// `sourceSignature.ts` and `accountOffer.ts` both computed this rule for themselves before
		// this module existed; they now call it, and this is the assertion that says what it is.
		expect.assertions(4);
		expect(isStatementDestination(csvBucket)).toBe(true);
		expect(isStatementDestination(bpBucket)).toBe(true);
		expect(isStatementDestination(manualBucket)).toBe(false);
		expect(isStatementDestination(archivedBucket)).toBe(false);
	});
});

describe('the invitation is true of the accounts it points at', () => {
	it('invites only where the name is still the one the machine gave', () => {
		// SEPARATES: « the invitation is conditional on a generically named account » FROM « it is
		// conditional on there being any account at all ». The plate's sentence is plural and
		// unconditional; after the backfill two of three buckets are named as the bank names them,
		// so the unconditional form tells a user to name accounts that are named. Spec Part N.3.
		expect.assertions(4);
		expect(isGenericallyNamed(csvBucket)).toBe(true);
		expect(isGenericallyNamed(bpBucket)).toBe(false);
		expect(invitationApplies([manualBucket, csvBucket, bpBucket])).toBe(true);
		// The case that decides it, and the one the plate gets wrong.
		expect(invitationApplies([manualBucket, bpBucket])).toBe(false);
	});

	it('stops inviting once the bucket has been renamed', () => {
		// SEPARATES: « the invitation clears itself » FROM « it is pinned to a source or an id ».
		// Renaming changes `nameKey`, the substitution stops, and the sentence stops with it — one
		// property rather than a rule plus a rule for turning the rule off.
		expect.assertions(3);
		const renamed = { ...csvBucket, name: 'Livret A', nameKey: computeNameKey('Livret A') };
		expect(isGenericallyNamed(renamed)).toBe(false);
		expect(invitationApplies([renamed])).toBe(false);
		expect(displayAccountName(renamed)).toBe('Livret A');
	});

	it('never invites over an account a person created, whatever its source', () => {
		// SEPARATES: « generically named is a claim about the NAME » FROM « it is a claim about the
		// source ». An account made in the create sheet carries `source: 'csv'` and
		// `institution: null`, exactly like the generic bucket, and differs only in the one place
		// that matters: its owner typed the name.
		expect.assertions(2);
		const mine = {
			...csvBucket,
			id: 'acc-mine',
			name: 'BP ···4417',
			nameKey: computeNameKey('BP ···4417')
		};
		expect(isGenericallyNamed(mine)).toBe(false);
		expect(invitationApplies([mine])).toBe(false);
	});

	it('recognises the machine name on a row whose key was never written', () => {
		// SEPARATES: « the key is recomputed when the column is null » FROM « a null key means not
		// generic ». `Account.nameKey` is nullable and carries no unique constraint, and the boot
		// backfill writes it only for accounts with an institution to write — which the generic
		// bucket has not. So the null is likeliest on precisely the row this predicate exists for,
		// and the wrong answer here shows « Compte import CSV » raw and suppresses the invitation on
		// the installation that most needs both.
		expect.assertions(3);
		const legacy = { ...csvBucket, nameKey: null };
		expect(legacy.name).toBe(GENERIC_BUCKET_STORED_NAME);
		expect(isGenericallyNamed(legacy)).toBe(true);
		expect(displayAccountName(legacy)).toBe(m.accounts_generic_bucket());
	});

	// The near-miss the folding decides, and it is why `computeNameKey` is called rather than the
	// stored strings compared. `normalizeForMatch` folds case and accents, so a bucket a migration
	// wrote with different casing is still the machine's name.
	it('recognises the machine name through the same folding every other name uses', () => {
		expect.assertions(1);
		const folded = {
			...csvBucket,
			name: 'COMPTE IMPORT CSV',
			nameKey: computeNameKey('COMPTE IMPORT CSV')
		};
		expect(isGenericallyNamed(folded)).toBe(true);
	});
});

describe('the display name substitutes rather than reads, and only where it must', () => {
	it('renders the generic bucket through a message', () => {
		// SEPARATES: « the screen substitutes a message » FROM « the French phrase was written into
		// the column ». `Account.name` still holds the storage key, which is what keeps the bucket
		// findable for an English user; only the rendering changes.
		expect.assertions(2);
		expect(displayAccountName(csvBucket)).toBe(m.accounts_generic_bucket());
		expect(csvBucket.name).toBe(GENERIC_BUCKET_STORED_NAME);
	});

	it('renders the manual bucket through its own message', () => {
		// SEPARATES: « one rule covers both substitutions » FROM « each screen has its own ». Before
		// this module the manual rule lived in `transactions/accountProjection.ts` and the generic
		// rule did not exist, so /transactions and the Comptes screen would have named one row two
		// ways the day the second rule shipped.
		expect.assertions(1);
		expect(displayAccountName(manualBucket)).toBe(m.accounts_manual_entry());
	});

	it('reads the row for every account whose name a person chose', () => {
		expect.assertions(1);
		expect(displayAccountName(bpBucket)).toBe('Banque Populaire');
	});
});
