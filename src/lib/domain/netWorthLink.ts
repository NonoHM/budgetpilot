/**
 * D4, THE WHOLE RULE, EXPRESSED ONCE.
 *
 * At most one SYNCHRONIZED bucket may feed one net worth line. `recordSyncedBalance` writes a
 * provider balance once per synchronized bucket whose link is set, so two of them make two
 * provider balances fight over one line: the figure /net-worth shows becomes whichever bucket
 * synced last, and its history alternates between two unrelated balances.
 *
 * ## Why this is a domain module and not a `where` clause
 *
 * Because it had been a `where` clause, in one function, while the column had three writers. The
 * rule held on /imports/bank-connections and not on /settings, and whether a user could break it
 * depended on which screen they used (#501). A rule with two enforcement sites is the shape this
 * repository has measured diverging four times, and the answer that actually removes the risk is
 * not "add the check to the other site": it is to have ONE expression that every site calls.
 *
 * The reference formulation of why the check may not simply be repeated at each caller, from
 * ardalis/DDD-NoDuplicates, which is about a uniqueness rule and is exactly this one:
 *
 * > without encapsulation the rule is enforced not by the model but by the attentiveness of the
 * > calling developer, which even when that is you is easily missed.
 *
 * That is the measurement rather than the aspiration: the calling developer here was attentive
 * enough to write D4 down, in a docstring, as ENFORCED, and to build a second door past it.
 *
 * There are now four sites, and none of them restates anything:
 *
 *   * `server/net-worth/link.ts` refuses a write that would contest a line.
 *   * `server/net-worth/contestedRepair.ts` clears the links of installs that already carry the
 *     state, at boot, because a fix on the write path cannot reach a row already written.
 *   * `server/backup/import.ts` drops them out of a RESTORE, because a backup taken before the fix
 *     carries the state and would write it straight back.
 *   * the fuzz in `netWorthLink.spec.ts`, which is only possible because the rule is a function of
 *     its arguments and of nothing else.
 *
 * ## Imports nothing, and that is a constraint rather than a coincidence
 *
 * Same rule `domain/account.ts` and `domain/money.ts` are held to: this decides what is written to
 * a stored column and is later recomputed from what is stored, so it may not read a clock, a
 * random source, an ambient locale or the network. `domain/money.ts` failed at container startup
 * after `check`, 4 000 unit tests, lint and a full Playwright run had all passed, because it
 * reached for an ambient locale. A domain predicate reaches for nothing.
 */

/**
 * One `Account` row, reduced to the three facts D4 is about.
 *
 * `synchronized` rather than `bankConnectionId`, deliberately: what makes a bucket a participant is
 * that a bank sync writes a balance FOR it, and the column is only how the server happens to know.
 * A caller that has the column translates it once, at the edge, so the rule never has to.
 */
export interface NetWorthLinkRow {
	accountId: string;
	netWorthAccountId: string | null;
	synchronized: boolean;
}

/**
 * Every net worth line that more than one synchronized bucket points at, sorted.
 *
 * SORTED so the result is a pure function of the SET of rows rather than of the order a query
 * happened to return them in. A caller comparing two runs, or a property test asserting that order
 * does not matter, would otherwise be measuring the database's row order.
 *
 * Rows are assumed to carry distinct `accountId`s, which is what a set of `Account` rows is. A
 * duplicated id would be counted twice, and that is the caller handing the rule something that is
 * not a row set rather than an ambiguity in the rule.
 */
export function contestedNetWorthLines(rows: readonly NetWorthLinkRow[]): string[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		// A bucket with no link points at nothing, and an unsynchronized one never writes a balance
		// snapshot automatically. Both are inert here, which is exactly D4's own carve-out: a CSV or
		// manual bucket sharing a line with a synchronized one is not a conflict, because it has
		// nothing to fight with.
		if (!row.synchronized || row.netWorthAccountId === null) continue;
		counts.set(row.netWorthAccountId, (counts.get(row.netWorthAccountId) ?? 0) + 1);
	}

	const contested: string[] = [];
	for (const [netWorthAccountId, count] of counts) {
		if (count > 1) contested.push(netWorthAccountId);
	}
	return contested.sort();
}

/**
 * The row set as it would be after this write. The candidate REPLACES any row with its own id,
 * because an account has one link and writing a new one is not adding a second.
 */
export function applyNetWorthLink(
	rows: readonly NetWorthLinkRow[],
	candidate: NetWorthLinkRow
): NetWorthLinkRow[] {
	return [...rows.filter((row) => row.accountId !== candidate.accountId), candidate];
}

/**
 * Whether writing this link would leave its target contested.
 *
 * DEFINED BY THE RULE ABOVE RATHER THAN BESIDE IT, and that is the entire point of this module.
 * The check the writer runs and the check the repair runs are not two implementations that agree:
 * they are one implementation, applied to a hypothetical row set here and to a real one there. It
 * is not possible for them to diverge, which is a stronger claim than any test could make about two
 * copies.
 *
 * Two consequences fall out rather than being written down, and each one used to be a clause
 * somebody had to remember:
 *
 *   * A bucket never conflicts with itself, because the candidate replaces it. That was
 *     `id: { not: bucket.id }`, and /settings submits its select on change, so re-submitting a
 *     current value is an ordinary event rather than an edge case.
 *   * Clearing is never refused: null is inert in the rule, so there is nothing to contest. That
 *     matters because clearing is how a user moves a line from one bucket to another, and a refusal
 *     would make a pair of buckets permanent.
 */
export function wouldContestNetWorthLine(
	rows: readonly NetWorthLinkRow[],
	candidate: NetWorthLinkRow
): boolean {
	if (candidate.netWorthAccountId === null) return false;
	return contestedNetWorthLines(applyNetWorthLink(rows, candidate)).includes(
		candidate.netWorthAccountId
	);
}

/**
 * The accounts whose link must be withdrawn to leave no line contested, sorted by id.
 *
 * CLEARS EVERY BUCKET IN A CONTESTED GROUP RATHER THAN KEEPING ONE, and the choice is the opposite
 * of the tempting one, so the reason is here rather than in a commit message.
 *
 * Keeping one would preserve more of what the user chose, and nothing in the data says WHICH one
 * they meant: the app would pick by row id, which is not the order the links were made in. The
 * result is a net worth line showing a plausible balance that may be the wrong account's, with
 * nothing on any screen able to say so. Clearing the group instead leaves the line visibly unfed,
 * the « Connecté » badge off, and the control that re-links it on a screen that now enforces the
 * rule. This repository's own asymmetry rule, from `domain/account.ts`: an absence has no error
 * message, so between a silent wrong answer and a visible missing one, the visible one is chosen.
 *
 * Sorted for the same reason `contestedNetWorthLines` is: so a repair's report is a fact about the
 * data rather than about the order rows came back in.
 */
export function accountsToUnlinkForContest(rows: readonly NetWorthLinkRow[]): string[] {
	const contested = new Set(contestedNetWorthLines(rows));
	if (contested.size === 0) return [];
	return rows
		.filter(
			(row) =>
				row.synchronized && row.netWorthAccountId !== null && contested.has(row.netWorthAccountId)
		)
		.map((row) => row.accountId)
		.sort();
}
