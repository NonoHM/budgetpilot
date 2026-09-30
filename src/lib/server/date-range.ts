import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import { PERIOD_FLOOR, type PeriodKey } from '$lib/domain/periodPresets';
import { isStorableIsoDate, isStorableYear, STORABLE_YEARS } from '$lib/domain/transaction';

/**
 * Re-exported rather than declared, so this parser and the Période panel's preset block cannot
 * name different sets of periods. The list lives in `domain/periodPresets.ts`, which imports
 * nothing and is therefore reachable from the client half too.
 */
export type { PeriodKey };

export interface DateRange {
	key: PeriodKey;
	label: string;
	from: Date;
	to: Date;
	fromDate: string;
	toDate: string;
	budgetMonth: string;
	comparisonMonth?: string;
}

/**
 * The last instant a query bound may name (#758). An exclusive upper bound is « the day after the
 * last day asked for », and for the last storable day that is year 10000, which MariaDB answers
 * with warning 1292 and ZERO rows: every total read 0, with no error. Stored dates sit at midnight
 * or noon UTC, so a bound one millisecond before year 10000 excludes nothing a row can hold.
 */
const LAST_BOUND = new Date(Date.UTC(STORABLE_YEARS.last, 11, 31, 23, 59, 59, 999));

export function parseDateRange(params: URLSearchParams, now = new Date()): DateRange {
	const key = parsePeriodKey(params.get('period'));
	const today = startOfUtcDay(now);

	if (key === 'last-month') {
		const currentMonth = startOfUtcMonth(today);
		const from = addUtcMonths(currentMonth, -1);
		const to = currentMonth;
		return buildRange({
			key,
			label: m.reports_period_last_month(),
			from,
			to,
			comparisonMonth: getMonthKey(addUtcMonths(from, -1))
		});
	}

	if (key === 'last-30-days') {
		const to = addUtcDays(today, 1);
		const from = addUtcDays(to, -30);
		return buildRange({ key, label: m.reports_period_last_30_days(), from, to });
	}

	if (key === 'last-90-days') {
		const to = addUtcDays(today, 1);
		const from = addUtcDays(to, -90);
		return buildRange({ key, label: m.reports_period_last_90_days(), from, to });
	}

	if (key === 'all-time') {
		// The first storable day (#758), so the lower bound filters nothing a row can hold and the
		// range keeps the plain DateRange shape without touching any query. It was the epoch, which
		// dropped every row from 1000 to 1969 from the all-time totals. Never a whole calendar
		// month, so the budget summary stays unavailable (isWholeMonthPeriod) and the derived
		// budgetMonth is inert. "custom" ranges are unbounded too (no day cap).
		return buildRange({
			key,
			label: m.reports_period_all_time(),
			from: new Date(`${PERIOD_FLOOR}T00:00:00.000Z`),
			to: addUtcDays(today, 1)
		});
	}

	if (key === 'custom') {
		const range = parseCustomDateRange(params.get('from'), params.get('to'));
		return buildRange({
			key,
			label: m.date_range_custom_label({ from: range.fromDate, to: range.toDate }),
			from: range.from,
			to: range.to
		});
	}

	const from = startOfUtcMonth(today);
	const to = addUtcMonths(from, 1);
	return buildRange({
		key: 'this-month',
		label: m.reports_period_this_month(),
		from,
		to,
		comparisonMonth: getMonthKey(addUtcMonths(from, -1))
	});
}

export function parseCustomDateRange(
	fromParam: string | null,
	toParam: string | null
): { from: Date; to: Date; fromDate: string; toDate: string } {
	const from = parseIsoDate(fromParam);
	const toInclusive = parseIsoDate(toParam);
	if (!from || !toInclusive) throw error(400, m.date_range_error_invalid_custom());

	const to = exclusiveEndOf(toInclusive);
	if (from >= to) throw error(400, m.date_range_error_invalid_custom());

	return { from, to, fromDate: formatDate(from), toDate: formatDate(toInclusive) };
}

export function serializePeriodParams(range: DateRange): string {
	const params = new URLSearchParams({ period: range.key });
	if (range.key === 'custom') {
		params.set('from', range.fromDate);
		params.set('to', range.toDate);
	}
	return params.toString();
}

export function getPreviousMonthRange(range: DateRange): DateRange | null {
	if (!range.comparisonMonth) return null;
	const [year, month] = range.comparisonMonth.split('-').map(Number);
	const from = new Date(Date.UTC(year, month - 1, 1));
	return buildRange({
		key: 'last-month',
		label: m.date_range_previous_month_label({ month: range.comparisonMonth }),
		from,
		to: addUtcMonths(from, 1)
	});
}

function parsePeriodKey(value: string | null): PeriodKey {
	if (
		value === 'last-month' ||
		value === 'last-30-days' ||
		value === 'last-90-days' ||
		value === 'all-time' ||
		value === 'custom'
	) {
		return value;
	}

	return 'this-month';
}

/**
 * The day after `toInclusive`, as the exclusive bound every query here uses, or `LAST_BOUND` when
 * that day would leave the storable range (#758).
 */
function exclusiveEndOf(toInclusive: Date): Date {
	const next = addUtcDays(toInclusive, 1);
	return isStorableYear(next.getUTCFullYear()) ? next : LAST_BOUND;
}

/**
 * A query bound, or null. Through `isStorableIsoDate`, the one reading every date writer and every
 * bound shares (#758): a calendar date whose year an engine can compare. `from=0000-01-01` used to
 * reach PostgreSQL as a bound and throw `22008`, a 500.
 *
 * The calendar half is load-bearing too, and its absence was once a 500: a digit-shape pattern
 * admitted `2026-99-99`, `new Date()` answered an Invalid Date, and `toISOString()` THROWS on one,
 * past `parseTransactionDateRange`'s catch. `isValidIsoDate` returns rather than throws, and
 * `2026-02-30` (which JS rolls over to March 2) is refused as non-canonical.
 */
function parseIsoDate(value: string | null): Date | null {
	if (!value || !isStorableIsoDate(value)) return null;
	return new Date(`${value}T00:00:00.000Z`);
}

function buildRange(input: {
	key: PeriodKey;
	label: string;
	from: Date;
	to: Date;
	comparisonMonth?: string;
}): DateRange {
	return {
		...input,
		fromDate: formatDate(input.from),
		// The last instant before the exclusive bound, rather than « one day before »: the two agree
		// on every midnight bound, and only this one names 9999-12-31 for `LAST_BOUND`.
		toDate: formatDate(new Date(input.to.getTime() - 1)),
		budgetMonth: getMonthKey(input.from)
	};
}

function startOfUtcDay(value: Date): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function startOfUtcMonth(value: Date): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function addUtcDays(value: Date, days: number): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + days));
}

function addUtcMonths(value: Date, months: number): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1));
}

function getMonthKey(value: Date): string {
	return `${value.getUTCFullYear()}-${`${value.getUTCMonth() + 1}`.padStart(2, '0')}`;
}

function formatDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}
