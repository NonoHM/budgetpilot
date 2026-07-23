import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';

export type PeriodKey =
	| 'this-month'
	| 'last-month'
	| 'last-30-days'
	| 'last-90-days'
	| 'all-time'
	| 'custom';

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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
		// Epoch lower bound = no effective date filter (no transaction predates 1970), so the
		// range keeps the plain DateRange shape without touching any query. Never a whole
		// calendar month, so the budget summary stays unavailable (isWholeMonthPeriod) and the
		// derived budgetMonth ('1970-01') is inert. "custom" ranges are unbounded too (no day cap).
		return buildRange({
			key,
			label: m.reports_period_all_time(),
			from: new Date(0),
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

	const to = addUtcDays(toInclusive, 1);
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

function parseIsoDate(value: string | null): Date | null {
	if (!value || !DATE_PATTERN.test(value)) return null;
	const date = new Date(`${value}T00:00:00.000Z`);
	return date.toISOString().slice(0, 10) === value ? date : null;
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
		toDate: formatDate(addUtcDays(input.to, -1)),
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
