import { prisma } from '$lib/server/db';
import { FIRST_STORABLE_DAY, STORABLE_YEARS } from '$lib/domain/transaction';

/**
 * #758: rows written BEFORE the storable range existed, counted at startup and never touched.
 *
 * Until #758 every date writer accepted any four-digit year, so an install can already hold rows
 * dated before 1000: on MariaDB the column keeps the year and the application reads 0001 to 0099
 * back as 1950 to 2049, so such a row displays in the wrong century, and a backup holding one is
 * now refused on restore. Nothing can say which date the user MEANT, so this rewrites nothing: it
 * reports how many rows each column holds, so an operator knows to look.
 *
 * ## The six columns, and why only these
 *
 * The `parsed` columns of `storableDateColumns.spec.ts`, the ones a form, a file or a provider
 * wrote. `BankConnection.consentExpiresAt` is left out: it is the provider's, a sync rewrites it,
 * and nothing is displayed or totalled from it. Every `clock` column was written by the server.
 *
 * ## Counts only, never an id and never a value
 *
 * A date on a transaction is banking data. The line says how many rows and in which column, which
 * is what an operator needs to act, and nothing a log reader could tie to a statement (AGENTS.md,
 * « Never log or expose »).
 *
 * ## It cannot take the boot down
 *
 * A report is not a gate. A failed count logs that the check could not run, with no detail from
 * the error, and the server starts: a new control must not be able to take an existing one down
 * with it (CLAUDE.md records the instance that taught it).
 */
const FLOOR = new Date(`${FIRST_STORABLE_DAY}T00:00:00.000Z`);

export type OutOfRangeDateCounts = {
	'Transaction.date': number;
	'ImportBatch.periodStart': number;
	'ImportBatch.periodEnd': number;
	'SavingsGoal.targetDate': number;
	'NetWorthSnapshot.capturedAt': number;
	'RecurringStreamAction.dueDate': number;
};

async function countBelowFloor(): Promise<OutOfRangeDateCounts> {
	const below = { lt: FLOOR };
	const [date, periodStart, periodEnd, targetDate, capturedAt, dueDate] = await Promise.all([
		prisma.transaction.count({ where: { date: below } }),
		prisma.importBatch.count({ where: { periodStart: below } }),
		prisma.importBatch.count({ where: { periodEnd: below } }),
		prisma.savingsGoal.count({ where: { targetDate: below } }),
		prisma.netWorthSnapshot.count({ where: { capturedAt: below } }),
		prisma.recurringStreamAction.count({ where: { dueDate: below } })
	]);
	return {
		'Transaction.date': date,
		'ImportBatch.periodStart': periodStart,
		'ImportBatch.periodEnd': periodEnd,
		'SavingsGoal.targetDate': targetDate,
		'NetWorthSnapshot.capturedAt': capturedAt,
		'RecurringStreamAction.dueDate': dueDate
	};
}

/** Counts, logs one line when any is non-zero, and returns the counts (null when it could not run). */
export async function reportDatesOutsideStorableRange(): Promise<OutOfRangeDateCounts | null> {
	let counts: OutOfRangeDateCounts;
	try {
		counts = await countBelowFloor();
	} catch {
		console.warn(
			'[dates] The check for rows dated before the storable range could not run; nothing was changed.'
		);
		return null;
	}

	const nonZero = Object.entries(counts).filter(([, count]) => count > 0);
	if (nonZero.length === 0) return counts;

	const total = nonZero.reduce((sum, [, count]) => sum + count, 0);
	console.warn(
		`[dates] ${total} row(s) carry a date before year ${STORABLE_YEARS.first}, outside what every ` +
			`supported engine stores faithfully (#758): ` +
			nonZero.map(([column, count]) => `${column} ${count}`).join(', ') +
			'. They can display in the wrong century (MariaDB reads years 0001 to 0099 back as 1950 ' +
			'to 2049) and a backup holding them is refused on restore. Nothing was changed: correct or ' +
			'delete them by hand.'
	);
	return counts;
}
