import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	accountsToUnlinkForContest,
	applyNetWorthLink,
	contestedNetWorthLines,
	wouldContestNetWorthLine,
	type NetWorthLinkRow
} from './netWorthLink';

/**
 * D4 IS NOW A FUNCTION OF ITS ARGUMENTS, WHICH IS THE ONLY REASON THIS FILE CAN EXIST.
 *
 * While the rule was a `where` clause inside one service function it could not be fuzzed at all: a
 * property test needs something it can call ten thousand times, and a clause inside a transaction
 * against a real engine is not that. Moving the rule into `domain/` was done to remove the
 * divergence between two enforcement sites; being able to attack it is what the move also bought.
 *
 * ## The two calibrations, and they fail in OPPOSITE directions
 *
 * A property test that never fails proves nothing about its generator, so the properties below are
 * pointed at two deliberately wrong predicates and each MUST break something:
 *
 *   * `neverContests`, which is /settings' door exactly as 0.14.1 shipped it, must break the
 *     INVARIANT: a sequence of accepted writes must be able to reach a contested line.
 *   * `forgetsSelfExclusion`, a plausible over-tightening, must break the LEGITIMATE PATH: a bucket
 *     re-submitting the line it already holds must not be refused.
 *
 * Without the second, a fix that refused every link everywhere would satisfy every other assertion
 * in this file. The loss lives on the path that must keep working, and that is where it is asserted.
 *
 * ## `it.fails` is not used, on purpose
 *
 * `vite.config.ts` sets `expect: { requireAssertions: true }`, so an assertion-free body FAILS for
 * that reason alone and `it.fails` accepts any failure: a calibration written that way reports
 * green whether it caught anything or not. Each calibration below is an ordinary `it` that records
 * the finding and asserts something POSITIVE about it.
 *
 * ## What the generator refuses to produce
 *
 * Account ids are assigned by index rather than drawn. A row set is a set of `Account` ROWS, so two
 * rows cannot share an id, and drawing ids independently would generate a shape the database cannot
 * hold and report the result as a finding about the rule.
 *
 * Lines are drawn from THREE values, and the smallness is the point rather than laziness. A
 * generator over a wide id alphabet would put every bucket on its own line and never produce a
 * contest at all, which is a clean run about nothing: this repository has one measured instance of
 * exactly that, where a 5 000-run fuzz came back green because the colliding pair needed two
 * specific values in two specific fields. The counts printed below are what proves it did not
 * happen again here.
 */

/** Pinned, so a later clean run is comparable to this one rather than merely resembling it. */
const SEED = 20260825;
const RUNS = 5000;

/** Small on purpose: with three lines, contests are reached in a handful of draws instead of never. */
const lineArb = fc.constantFrom<string | null>('line-a', 'line-b', 'line-c', null);

/** One bucket, minus its id: the id is a property of its POSITION in the set, not a drawn field. */
const bucketArb = fc.record({
	netWorthAccountId: lineArb,
	synchronized: fc.boolean()
});

const rowsArb = fc
	.array(bucketArb, { minLength: 0, maxLength: 8 })
	.map((buckets): NetWorthLinkRow[] =>
		buckets.map((bucket, index) => ({ accountId: `acc-${index}`, ...bucket }))
	);

/** A write, as a door receives one: which bucket, which line. */
const writeArb = fc.record({
	index: fc.integer({ min: 0, max: 7 }),
	netWorthAccountId: lineArb
});

type Decide = (rows: readonly NetWorthLinkRow[], candidate: NetWorthLinkRow) => boolean;

/** /settings' door as 0.14.1 shipped it: it wrote, and nothing refused the second bucket. */
const neverContests: Decide = () => false;

/**
 * A plausible over-tightening: any synchronized bucket already on the line is a conflict, including
 * the one being written. This is what the rule looks like if `id: { not: bucket.id }` is forgotten,
 * and it reads as more careful rather than as wrong.
 */
const forgetsSelfExclusion: Decide = (rows, candidate) => {
	if (candidate.netWorthAccountId === null) return false;
	if (!candidate.synchronized) return false;
	return rows.some(
		(row) => row.synchronized && row.netWorthAccountId === candidate.netWorthAccountId
	);
};

/**
 * Replays a sequence of writes through one decision function and reports the final row set.
 *
 * THIS IS THE APPLICATION OVER TIME, which is the thing no single call can measure: the defect in
 * #501 was not one bad write, it was a second write that a rule should have refused. Counting how
 * many writes were REFUSED is what tells a run that exercised the rule from a run that never met it.
 */
function replay(
	rows: NetWorthLinkRow[],
	writes: readonly { index: number; netWorthAccountId: string | null }[],
	decide: Decide
): { final: NetWorthLinkRow[]; accepted: number; refused: number } {
	let current = rows;
	let accepted = 0;
	let refused = 0;
	for (const write of writes) {
		const bucket = current[write.index];
		if (!bucket) continue;
		const candidate: NetWorthLinkRow = {
			accountId: bucket.accountId,
			netWorthAccountId: write.netWorthAccountId,
			synchronized: bucket.synchronized
		};
		if (decide(current, candidate)) {
			refused += 1;
			continue;
		}
		current = applyNetWorthLink(current, candidate);
		accepted += 1;
	}
	return { final: current, accepted, refused };
}

/**
 * Runs the invariant over a decision function and returns the first sequence that reached a
 * contested line, or null. `fc.assert` throws on a failing property and in a calibrated leg the
 * failure is the expected result, so the throw is caught in both and the finding is read off the
 * record.
 */
function findInvariantBreach(decide: Decide): {
	breach: { contested: string[]; refused: number } | null;
	exercised: { runs: number; refused: number; contestable: number };
} {
	let breach: { contested: string[]; refused: number } | null = null;
	const exercised = { runs: 0, refused: 0, contestable: 0 };

	try {
		fc.assert(
			fc.property(rowsArb, fc.array(writeArb, { maxLength: 8 }), (drawn, writes) => {
				exercised.runs += 1;
				// EVERY LINK IN THE FINAL STATE IS A WRITE THIS DECISION FUNCTION ALLOWED, which is why
				// the drawn buckets start unlinked. A first version replayed the writes over the drawn
				// links and reported a breach on its very first run: the draw itself had produced two
				// synchronized buckets on one line, which no write rule can undo. That is a finding
				// about the generator rather than about the rule, and the corrected model is also the
				// truthful one, because a freshly synced bucket carries no link until somebody sets it.
				const rows = drawn.map((row) => ({ ...row, netWorthAccountId: null }));
				// How often the DRAW could produce a contest at all, counted independently of the
				// decision function: a run where no draw ever had two synchronized buckets available
				// would report a clean invariant about a generator that never posed the question.
				if (rows.filter((row) => row.synchronized).length > 1) exercised.contestable += 1;

				const { final, refused } = replay(rows, writes, decide);
				exercised.refused += refused;

				const contested = contestedNetWorthLines(final);
				if (contested.length > 0) {
					breach ??= { contested, refused };
					return false;
				}
				return true;
			}),
			{ seed: SEED, numRuns: RUNS, endOnFailure: true }
		);
	} catch (caught) {
		// A BREACH AND A CRASH ARRIVE AS THE SAME THROW, and treating them alike is how a harness
		// reports a clean run about a property it never evaluated. `fc.assert` throws both when the
		// predicate returns false and when it raises, so the two are told apart by whether a breach
		// was recorded: nothing recorded means the property died rather than failed, and that is
		// re-thrown rather than returned as "no breach found".
		if (breach === null) throw caught;
	}

	// The same rule one step further out, and it applies ONLY to a clean leg. `endOnFailure` stops
	// the moment a breach is found, so a calibration legitimately runs once; a leg that found nothing
	// after one run has measured the harness rather than the rule, and those are the same output.
	if (breach === null && exercised.runs < RUNS) {
		throw new Error(
			`the property ran ${exercised.runs} of ${RUNS} times, so this result is about the harness`
		);
	}

	return { breach, exercised };
}

describe('CALIBRATION: the invariant catches the door that refuses nothing', () => {
	it('reaches a contested line through 0.14.1 settings door, or nothing here measures anything', () => {
		expect.assertions(3);

		const { breach, exercised } = findInvariantBreach(neverContests);
		// Printed rather than merely asserted: a calibration reporting a verdict and no figure cannot
		// be compared with a later run, and pinning the seed is what makes comparison possible.
		console.log(
			`[fuzz-calibration] seed=${SEED} runs=${exercised.runs} contestable-draws=` +
				`${exercised.contestable} breach=${JSON.stringify(breach)}`
		);

		// The absolute figure beside the finding: a run in which no draw could ever contest would
		// report "no breach" for a reason that has nothing to do with the rule.
		expect(exercised.contestable, 'the generator must reach sets with two synchronized buckets')
			.toBeGreaterThan(0);
		expect(breach, 'a door that refuses nothing must be able to contest a line').not.toBeNull();
		// The defect IN KIND rather than any disagreement the oracle happened to notice: the door
		// accepted every write, so nothing was refused on the way to the contested state.
		expect(breach!.refused).toBe(0);
	});
});

describe('the rule holds the invariant no sequence of accepted writes can break', () => {
	it('never leaves a line fed by two synchronized buckets', () => {
		expect.assertions(2);

		const { breach, exercised } = findInvariantBreach(wouldContestNetWorthLine);
		console.log(
			`[fuzz] seed=${SEED} runs=${exercised.runs} contestable-draws=${exercised.contestable} ` +
				`writes-refused=${exercised.refused}`
		);

		// The detector is proven to have fired: a run that refused nothing would be a clean result
		// about a rule that was never asked a question it could answer no to.
		expect(exercised.refused, 'the rule must actually refuse something over this corpus')
			.toBeGreaterThan(0);
		expect(breach).toBeNull();
	});
});

describe('CALIBRATION: the legitimate path catches a rule that closes too far', () => {
	it('refuses a bucket re-submitting its own line, which the real rule must not', () => {
		expect.assertions(3);

		// /settings submits its select on change, so a bucket being written to the line it already
		// holds is an ordinary event. The over-strict predicate refuses it.
		const rows: NetWorthLinkRow[] = [
			{ accountId: 'acc-0', netWorthAccountId: 'line-a', synchronized: true }
		];
		const candidate: NetWorthLinkRow = {
			accountId: 'acc-0',
			netWorthAccountId: 'line-a',
			synchronized: true
		};

		expect(forgetsSelfExclusion(rows, candidate), 'the over-strict predicate must refuse it')
			.toBe(true);
		expect(wouldContestNetWorthLine(rows, candidate)).toBe(false);
		// And it is not merely tolerated, it is a write: the row set is unchanged by it.
		expect(applyNetWorthLink(rows, candidate)).toEqual(rows);
	});
});

describe('the rule leaves the paths that must keep working alone', () => {
	it('never refuses a clear, whatever the row set', () => {
		expect.assertions(1);

		const breaches = fc.sample(rowsArb, { seed: SEED, numRuns: 500 }).filter((rows) =>
			rows.some((row) =>
				wouldContestNetWorthLine(rows, { ...row, netWorthAccountId: null })
			)
		);
		// Clearing is how a user moves a line from one bucket to another. A refusal here would make
		// a contested pair permanent, so this is the assertion that keeps the repair reachable.
		expect(breaches).toHaveLength(0);
	});

	it('never refuses a bucket already holding its line, on an uncontested set', () => {
		expect.assertions(2);

		const sets = fc
			.sample(rowsArb, { seed: SEED, numRuns: 500 })
			.filter((rows) => contestedNetWorthLines(rows).length === 0);
		const refused = sets.flatMap((rows) =>
			rows.filter((row) => wouldContestNetWorthLine(rows, row))
		);

		expect(sets.length, 'the corpus must contain uncontested sets to check').toBeGreaterThan(0);
		expect(refused).toHaveLength(0);
	});

	it('is not affected by buckets that never write a balance', () => {
		expect.assertions(1);

		// D4's own carve-out, as a property: a CSV or manual bucket sharing a line with a
		// synchronized one is not a conflict, because it has nothing to fight with. A fix that
		// refused it would break the ordinary case of a user who imports statements for the same
		// account they also connected.
		const disagreements = fc
			.sample(fc.tuple(rowsArb, fc.array(bucketArb, { maxLength: 4 })), {
				seed: SEED,
				numRuns: 1000
			})
			.filter(([rows, extras]) => {
				const inert = extras.map((bucket, index) => ({
					accountId: `inert-${index}`,
					netWorthAccountId: bucket.netWorthAccountId,
					synchronized: false
				}));
				return (
					JSON.stringify(contestedNetWorthLines([...rows, ...inert])) !==
					JSON.stringify(contestedNetWorthLines(rows))
				);
			});

		expect(disagreements).toHaveLength(0);
	});
});

describe('the repair converges, which is what the boot module rests on', () => {
	it('leaves no contested line after one pass, and finds nothing on a second', () => {
		expect.assertions(3);

		let everContested = 0;
		const failures: NetWorthLinkRow[][] = [];
		const secondPassWork: NetWorthLinkRow[][] = [];

		for (const rows of fc.sample(rowsArb, { seed: SEED, numRuns: 2000 })) {
			if (contestedNetWorthLines(rows).length > 0) everContested += 1;
			const cleared = new Set(accountsToUnlinkForContest(rows));
			const after = rows.map((row) =>
				cleared.has(row.accountId) ? { ...row, netWorthAccountId: null } : row
			);
			if (contestedNetWorthLines(after).length > 0) failures.push(rows);
			if (accountsToUnlinkForContest(after).length > 0) secondPassWork.push(rows);
		}

		// The absolute figure: a corpus with no contested set would report convergence about nothing.
		expect(everContested, 'the corpus must contain contested sets').toBeGreaterThan(0);
		expect(failures).toHaveLength(0);
		// Idempotence, asserted rather than described. This is the claim `contestedBoot.ts` makes
		// when it says a second instance redoes no work.
		expect(secondPassWork).toHaveLength(0);
	});
});

describe('contestedNetWorthLines, by example', () => {
	it('is a fact about the row SET, not about the order rows arrived in', () => {
		expect.assertions(2);

		const rows: NetWorthLinkRow[] = [
			{ accountId: 'acc-2', netWorthAccountId: 'line-b', synchronized: true },
			{ accountId: 'acc-0', netWorthAccountId: 'line-a', synchronized: true },
			{ accountId: 'acc-1', netWorthAccountId: 'line-b', synchronized: true },
			{ accountId: 'acc-3', netWorthAccountId: 'line-a', synchronized: true }
		];

		expect(contestedNetWorthLines(rows)).toEqual(['line-a', 'line-b']);
		expect(contestedNetWorthLines([...rows].reverse())).toEqual(['line-a', 'line-b']);
	});

	it('counts a synchronized bucket and ignores every other kind', () => {
		expect.assertions(3);

		const line = 'line-a';
		const synced = { accountId: 'sync-1', netWorthAccountId: line, synchronized: true };
		const csv = { accountId: 'csv-1', netWorthAccountId: line, synchronized: false };
		const unlinked = { accountId: 'sync-2', netWorthAccountId: null, synchronized: true };

		// One synchronized bucket plus any number of others is the ORDINARY state, not a contest.
		expect(contestedNetWorthLines([synced, csv, unlinked])).toEqual([]);
		// Two is the defect.
		expect(
			contestedNetWorthLines([synced, { ...synced, accountId: 'sync-3' }])
		).toEqual([line]);
		// And both of them are withdrawn, never one of them kept: nothing in the data says which
		// one the user meant, so keeping one would show a plausible balance from an arbitrary
		// account. See the reasoning on `accountsToUnlinkForContest`.
		expect(
			accountsToUnlinkForContest([synced, { ...synced, accountId: 'sync-3' }, csv])
		).toEqual(['sync-1', 'sync-3']);
	});
});
