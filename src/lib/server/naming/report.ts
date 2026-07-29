import type { NameKeyBackfillReport, UserNameKeyReport } from './backfill.ts';

/**
 * Renders a backfill plan as plain text for an operator to read before upgrading.
 *
 * The report names names. It prints category, bucket and budget labels, which are the
 * operator's own financial data, because a report that says "3 categories will be merged"
 * without saying which ones is not something anyone can approve. That is safe here and only
 * here: this runs from a command the operator types against their own database and prints to
 * their terminal. The boot path never renders it, and the application log only ever gets the
 * counts (see `renderSummaryLine`), because application logs get shipped, pasted into bug
 * reports, and read by people who are not the account holder.
 */
export function renderNameKeyReport(report: NameKeyBackfillReport): string {
	const lines: string[] = [];
	const heading = report.dryRun
		? 'Name normalization: DRY RUN, nothing was written'
		: 'Name normalization: applied';
	lines.push(heading, '='.repeat(heading.length), '');

	const affected = report.users.filter(hasAnythingToSay);
	if (affected.length === 0) {
		lines.push('No duplicate names found. Every row already folds to a distinct name.', '');
	}

	for (const user of affected) {
		lines.push(`User ${user.userId}`, '-'.repeat(`User ${user.userId}`.length));
		renderCategories(user, lines);
		renderAccounts(user, lines);
		renderBudgets(user, lines);
		renderNatures(user, lines);
		renderNetWorth(user, lines);
		lines.push('');
	}

	lines.push('Totals');
	lines.push('------');
	lines.push(`  Users scanned            ${report.users.length}`);
	lines.push(`  Rows merged away         ${report.rowsDeleted}`);
	lines.push(`  Transactions repointed   ${report.transactionsReassigned}`);
	lines.push(`  Keys written             ${totalKeysWritten(report)}`);
	if (report.dryRun) {
		lines.push('');
		lines.push('Re-run without --dry-run, or just start the app, to apply this plan.');
	}
	return lines.join('\n');
}

/** What the application log is allowed to say: counts, never a name. */
export function renderSummaryLine(report: NameKeyBackfillReport): string {
	return (
		`[name-keys] backfill complete: ${report.users.length} user(s), ` +
		`${totalKeysWritten(report)} key(s) written, ${report.rowsDeleted} duplicate row(s) merged, ` +
		`${report.transactionsReassigned} transaction(s) repointed`
	);
}

function hasAnythingToSay(user: UserNameKeyReport): boolean {
	return (
		user.categoryMerges.length > 0 ||
		user.accountMerges.length > 0 ||
		user.accountMergesBlocked.length > 0 ||
		user.budgetMerges.length > 0 ||
		user.natureMerges.length > 0 ||
		user.netWorthCollisions.length > 0
	);
}

function totalKeysWritten(report: NameKeyBackfillReport): number {
	return report.users.reduce(
		(total, user) => total + Object.values(user.keysWritten).reduce((sum, count) => sum + count, 0),
		0
	);
}

function renderCategories(user: UserNameKeyReport, lines: string[]): void {
	if (user.categoryMerges.length === 0) return;
	lines.push(`  Categories merged (${user.categoryMerges.length})`);
	for (const merge of user.categoryMerges) {
		lines.push(`    keep   "${merge.survivorName}"  (oldest row, id ${merge.survivorId})`);
		for (const loser of merge.losers) {
			lines.push(
				`    merge  "${loser.name}"  ->  "${merge.survivorName}"  ` +
					`(${loser.transactionCount} transaction(s) repointed)`
			);
		}
		lines.push(
			`    defaultKey: ${describeDefaultKey(merge.resolvedDefaultKey, merge.defaultKeySource)}`
		);
		if (merge.discardedDefaultKeys.length > 0) {
			lines.push(`    defaultKey dropped: ${merge.discardedDefaultKeys.join(', ')}`);
		}
	}
}

function describeDefaultKey(resolved: string | null, source: string): string {
	if (resolved === null) return 'none (both rows were custom or renamed categories)';
	return `"${resolved}" (kept from the ${source})`;
}

function renderAccounts(user: UserNameKeyReport, lines: string[]): void {
	if (user.accountMerges.length > 0) {
		lines.push(`  Accounts merged (${user.accountMerges.length})`);
		for (const merge of user.accountMerges) {
			lines.push(
				`    keep   "${merge.survivorName}"  [source ${merge.source}]  (oldest row, id ${merge.survivorId})`
			);
			for (const loser of merge.losers) {
				lines.push(
					`    merge  "${loser.name}"  ->  "${merge.survivorName}"  ` +
						`(${loser.transactionCount} transaction(s) repointed)`
				);
			}
			for (const [field, value] of Object.entries(merge.adoptedLinks)) {
				lines.push(`    adopts ${field} = ${value} from the merged row`);
			}
		}
	}

	if (user.accountMergesBlocked.length === 0) return;
	lines.push(`  Accounts NOT merged, needs your attention (${user.accountMergesBlocked.length})`);
	for (const blocked of user.accountMergesBlocked) {
		lines.push(
			`    left as is: ${blocked.names.map((name) => `"${name}"`).join(', ')}  ` +
				`[source ${blocked.source}]`
		);
		lines.push(
			`      they hold different ${blocked.conflictingField} values, so merging them would ` +
				'drop a real link. Rename one of them if they are meant to be one bucket.'
		);
	}
}

function renderBudgets(user: UserNameKeyReport, lines: string[]): void {
	if (user.budgetMerges.length === 0) return;
	lines.push(`  Budgets merged (${user.budgetMerges.length})`);
	for (const merge of user.budgetMerges) {
		lines.push(
			`    keep   "${merge.survivorName}" at ${formatCents(merge.resolvedValue)} ` +
				`(most recently edited, from the ${merge.valueSource})`
		);
		lines.push(`    merge  ${merge.losers.map((row) => `"${row.name}"`).join(', ')}`);
		for (const dropped of merge.discardedValues) {
			lines.push(`    drop   ${formatCents(dropped.value)} (was on "${dropped.name}")`);
		}
	}
}

function renderNatures(user: UserNameKeyReport, lines: string[]): void {
	if (user.natureMerges.length === 0) return;
	lines.push(`  Category natures merged (${user.natureMerges.length})`);
	for (const merge of user.natureMerges) {
		lines.push(
			`    keep   "${merge.survivorName}" as ${merge.resolvedValue} ` +
				`(most recently edited, from the ${merge.valueSource})`
		);
		lines.push(`    merge  ${merge.losers.map((row) => `"${row.name}"`).join(', ')}`);
		for (const dropped of merge.discardedValues) {
			lines.push(`    drop   ${dropped.value} (was on "${dropped.name}")`);
		}
	}
}

function renderNetWorth(user: UserNameKeyReport, lines: string[]): void {
	if (user.netWorthCollisions.length === 0) return;
	lines.push(`  Net worth accounts left untouched (${user.netWorthCollisions.length})`);
	for (const collision of user.netWorthCollisions) {
		lines.push(`    ${collision.names.map((name) => `"${name}"`).join(' / ')}`);
	}
	lines.push(
		'    Nothing is merged here: balances and snapshot histories have no automatic',
		'    answer. They keep working as they are. Only renaming one onto the other,',
		'    or creating a third that folds onto them, is refused from now on.'
	);
}

function formatCents(cents: number): string {
	return `${(cents / 100).toFixed(2)} EUR`;
}
