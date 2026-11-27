import { sumIncomeAndExpense, type CategoryAllocation } from './allocation';

/** One month of the /reports income-against-spending chart (#418). */
export interface ReportMonth {
	/** `YYYY-MM`, the key allocations are bucketed by. */
	month: string;
	/** First and last day, inclusive, as /transactions reads `from` and `to`. */
	from: string;
	to: string;
	/** Today's month: its figures are still growing. */
	partial: boolean;
}

export interface MonthIncomeExpense extends ReportMonth {
	incomeCents: number;
	expenseCents: number;
}

const WHOLE_MONTHS = 12;

/** The twelve whole months before `todayIso`'s month, then that month. Today is a parameter so
 *  the boundary can be tested; nothing here reads the clock. */
export function reportMonths(todayIso: string): ReportMonth[] {
	const year = Number(todayIso.slice(0, 4));
	const monthIndex = Number(todayIso.slice(5, 7)) - 1;
	return Array.from({ length: WHOLE_MONTHS + 1 }, (_, offset) => {
		const first = new Date(Date.UTC(year, monthIndex - WHOLE_MONTHS + offset, 1));
		const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
		return {
			month: first.toISOString().slice(0, 7),
			from: first.toISOString().slice(0, 10),
			to: last.toISOString().slice(0, 10),
			partial: offset === WHOLE_MONTHS
		};
	});
}

/** Each month's figures, by the same rule and the same bucketing as the period report
 *  (`sumIncomeAndExpense`, `date` prefix as in `getAllocationsForMonth`). */
export function buildIncomeExpenseByMonth(
	allocations: ReadonlyArray<CategoryAllocation>,
	months: ReadonlyArray<ReportMonth>
): MonthIncomeExpense[] {
	return months.map((month) => ({
		...month,
		...sumIncomeAndExpense(
			allocations.filter((allocation) => allocation.date.startsWith(`${month.month}-`))
		)
	}));
}
