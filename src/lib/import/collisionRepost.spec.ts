import { describe, expect, it } from 'vitest';
import { buildCollisionRepost } from './collisionRepost';
import type { PendingDesignation } from './pendingDesignation.svelte';
import type { RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * THE FIXTURE MAKES THE TWO VALUES DIFFER, which is the whole point.
 *
 * `view.hasHeaderRow` is what detection guessed and `result.hasHeaderRow` is what the user answered.
 * Every collision fixture in this repository kept both at `true`, so a mapping reading the wrong one
 * agreed with the right one and no test could see it.
 */
const ASSIGNMENT = { date: 0, label: 1, amount: 2, category: null } as unknown as RoleAssignment;

const PENDING = {
	file: new File(['a;b;c\n'], 'releve.csv'),
	view: {
		name: 'releve.csv',
		headers: ['a', 'b', 'c'],
		samples: [['1'], ['2'], ['3']],
		rowCount: 2,
		// DETECTION's guess, and `/import`'s action always sends this as `true`.
		detectedHeaderRow: true
	},
	initialAssignment: ASSIGNMENT,
	candidates: {},
	account: {
		options: [
			{
				id: 'account-chosen',
				name: 'BP · Compte courant',
				discriminant: '4417',
				transactionCount: 128
			}
		],
		resolution: { rank: 3 as const, candidates: [] },
		memory: null,
		// Nobody has chosen yet on the way IN. The repost is what fills it.
		chosenId: null
	},
	correction: {
		mappingId: 'mapping-1',
		batchId: 'batch-resolved',
		namedAt: '1 juillet 2026 à 10:59',
		replacedRows: 25,
		hasUserWork: false
	}
} as unknown as PendingDesignation;

const ANSWER = {
	assignment: ASSIGNMENT,
	remember: true,
	// The USER's answer, and it disagrees.
	hasHeaderRow: false,
	deleteOldImport: true,
	accountId: 'account-chosen'
};

describe('buildCollisionRepost', () => {
	// THE DEFECT. Re-posting detection's guess ate the file's first line as a header, on a file the
	// user had just declared headerless.
	it('re-posts the answer the user gave, not the one detection guessed', () => {
		expect(buildCollisionRepost(PENDING, ANSWER).hasHeaderRow).toBe(false);
	});

	// And the view follows it, so DECLINING reopens the screen the way it was left rather than the
	// way it was guessed. Asserted separately: the two fields are read by different consumers, the
	// repost by the confirm and the view by the decline.
	it('hands the same answer to the view the decline reopens', () => {
		expect(buildCollisionRepost(PENDING, ANSWER).view.detectedHeaderRow).toBe(false);
	});

	// The consent travels because answering re-posts the run. Without it a correction imports beside
	// the import it came to replace, or deletes one the user had chosen to keep.
	it('carries the consent as answered, beside the server-resolved batch id', () => {
		const repost = buildCollisionRepost(PENDING, { ...ANSWER, deleteOldImport: false });

		expect(repost.correction?.deleteOldImport).toBe(false);
		expect(repost.correction?.batchId).toBe('batch-resolved');
	});

	// The account travels for the same reason the consent does: CONFIRMING re-posts the run, and the
	// designation action refuses a submission with no account. A repost that lost it would turn
	// « Importer quand même » into a refusal telling the user to choose an account, with no control
	// in front of them to choose one with.
	it('carries the account the user chose, on both legs of the dialog', () => {
		const repost = buildCollisionRepost(PENDING, ANSWER);

		expect(repost.accountId).toBe('account-chosen');
		// And the offer goes back carrying that choice, so DECLINING reopens the screen showing it
		// rather than re-deriving a prefill and overwriting the user's answer with the application's.
		expect(repost.account?.chosenId).toBe('account-chosen');
	});

	it('carries no correction when the run is not one', () => {
		const repost = buildCollisionRepost({ ...PENDING, correction: null }, ANSWER);

		expect(repost.correction).toBeNull();
	});
});
