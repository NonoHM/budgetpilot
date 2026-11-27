<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import type { MonthIncomeExpense } from '$lib/domain/incomeExpenseByMonth';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { resolve } from '$app/paths';

	let { months }: { months: MonthIncomeExpense[] } = $props();

	// Validated pair (docs: f3-colour-decision): emerald-500 / rose-700 keep deutan ΔE 17.0, where
	// the text pair emerald-600 / rose-600 scored 5.8. Amounts in text keep the text tokens.
	const INCOME_FILL = '#10b981';
	const EXPENSE_FILL = '#be123c';

	const WIDTH = 600;
	const HEIGHT = 160;
	const TOP = 4;
	const BAR_GAP = 2;

	const whole = $derived(months.filter((month) => !month.partial));
	const hasData = $derived(months.some((month) => month.incomeCents > 0 || month.expenseCents > 0));
	const totals = $derived({
		income: whole.reduce((sum, month) => sum + month.incomeCents, 0),
		expense: whole.reduce((sum, month) => sum + month.expenseCents, 0),
		beyond: whole.filter((month) => month.expenseCents > month.incomeCents).length
	});
	const max = $derived(
		Math.max(1, ...months.flatMap((month) => [month.incomeCents, month.expenseCents]))
	);
	const slot = $derived(WIDTH / Math.max(1, months.length));
	const barWidth = $derived(slot * 0.32);

	function barHeight(cents: number): number {
		return ((HEIGHT - TOP) * cents) / max;
	}

	function monthName(month: string, style: 'short' | 'long'): string {
		return new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString(getLocale(), {
			month: style,
			year: style === 'long' ? 'numeric' : undefined,
			timeZone: 'UTC'
		});
	}

	function monthHref(month: MonthIncomeExpense) {
		return resolve(`/transactions?from=${month.from}&to=${month.to}` as `/transactions?${string}`);
	}

	function barLabel(month: MonthIncomeExpense): string {
		return m.reports_month_flow_bar_label({
			month: monthName(month.month, 'long'),
			income: formatCents(month.incomeCents),
			expense: formatCents(month.expenseCents)
		});
	}

	let activeIndex = $state<number | null>(null);
	const active = $derived(activeIndex === null ? null : months[activeIndex]);
</script>

<figure class="space-y-4">
	{#if !hasData}
		<p class="text-sm text-zinc-500">{m.reports_month_flow_empty()}</p>
	{:else}
		<figcaption class="text-sm text-zinc-700">
			{m.reports_month_flow_summary({
				income: formatCents(totals.income),
				expense: formatCents(totals.expense),
				count: String(totals.beyond)
			})}
		</figcaption>

		<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
			<span class="inline-flex items-center gap-1.5">
				<span class="h-2.5 w-2.5 rounded-sm bg-emerald-500" aria-hidden="true"></span>
				{m.reports_kpi_income()}
			</span>
			<span class="inline-flex items-center gap-1.5">
				<span class="h-2.5 w-2.5 rounded-sm bg-rose-700" aria-hidden="true"></span>
				{m.reports_kpi_expense()}
			</span>
		</div>

		<div class="relative">
			<svg
				class="w-full"
				viewBox="0 0 {WIDTH} {HEIGHT}"
				role="group"
				aria-label={m.reports_month_flow_heading()}
			>
				<line
					x1="0"
					y1={HEIGHT - 0.5}
					x2={WIDTH}
					y2={HEIGHT - 0.5}
					stroke="#d4d4d8"
					stroke-width="1"
				/>
				{#each months as month, index (month.month)}
					{@const x = index * slot + (slot - 2 * barWidth - BAR_GAP) / 2}
					<a
						href={monthHref(month)}
						aria-label={barLabel(month)}
						class="group outline-none"
						data-month-flow={month.month}
						onpointerenter={() => (activeIndex = index)}
						onpointerleave={() => (activeIndex = null)}
						onfocus={() => (activeIndex = index)}
						onblur={() => (activeIndex = null)}
					>
						<title>{barLabel(month)}</title>
						<rect
							x={index * slot + 1}
							y="0"
							width={slot - 2}
							height={HEIGHT}
							rx="4"
							fill="transparent"
							class="stroke-transparent group-focus-visible:stroke-zinc-900"
							stroke-width="2"
						/>
						<rect
							{x}
							y={HEIGHT - barHeight(month.incomeCents)}
							width={barWidth}
							height={barHeight(month.incomeCents)}
							rx="2"
							fill={INCOME_FILL}
							fill-opacity={month.partial ? 0.45 : 1}
						/>
						<rect
							x={x + barWidth + BAR_GAP}
							y={HEIGHT - barHeight(month.expenseCents)}
							width={barWidth}
							height={barHeight(month.expenseCents)}
							rx="2"
							fill={EXPENSE_FILL}
							fill-opacity={month.partial ? 0.45 : 1}
						/>
					</a>
				{/each}
			</svg>
			{#if active && activeIndex !== null}
				<div
					class="pointer-events-none absolute top-0 z-10 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs whitespace-nowrap shadow-sm"
					style:left="{((activeIndex + 0.5) / months.length) * 100}%"
					style:transform={activeIndex < months.length / 2 ? 'translateX(0)' : 'translateX(-100%)'}
				>
					<div class="font-semibold text-zinc-900">
						{monthName(active.month, 'long')}{#if active.partial}
							· {m.reports_month_flow_in_progress()}{/if}
					</div>
					<div class="mt-0.5 text-emerald-600 tabular-nums">
						{m.reports_kpi_income()}
						{formatCents(active.incomeCents)}
					</div>
					<div class="text-rose-600 tabular-nums">
						{m.reports_kpi_expense()}
						{formatCents(active.expenseCents)}
					</div>
				</div>
			{/if}
			<div
				class="mt-1 grid text-center text-[10px] text-zinc-500"
				style:grid-template-columns="repeat({months.length}, minmax(0, 1fr))"
			>
				{#each months as month, index (month.month)}
					<!-- Every other label below sm: thirteen fit at 1280, not at 390. -->
					<span class={index % 2 === 1 ? 'hidden sm:block' : ''}
						>{monthName(month.month, 'short')}</span
					>
				{/each}
			</div>
		</div>

		<table class="w-full text-xs tabular-nums">
			<caption class="sr-only">{m.reports_month_flow_heading()}</caption>
			<thead class="text-zinc-500">
				<tr>
					<th scope="col" class="py-1 text-left font-medium">{m.reports_month_flow_month()}</th>
					<th scope="col" class="py-1 text-right font-medium">{m.reports_kpi_income()}</th>
					<th scope="col" class="py-1 text-right font-medium">{m.reports_kpi_expense()}</th>
					<th scope="col" class="py-1 text-right font-medium"
						>{m.reports_month_flow_difference()}</th
					>
				</tr>
			</thead>
			<tbody class="divide-y divide-zinc-100 text-zinc-900">
				{#each [...months].reverse() as month (month.month)}
					{@const difference = month.incomeCents - month.expenseCents}
					<tr>
						<th scope="row" class="py-1.5 text-left font-normal">
							<a href={monthHref(month)} class="underline-offset-2 hover:underline">
								{monthName(month.month, 'short')}
								{month.month.slice(0, 4)}</a
							>{#if month.partial}
								<span class="text-zinc-500"> · {m.reports_month_flow_in_progress()}</span>{/if}
						</th>
						<td class="py-1.5 text-right">{formatCents(month.incomeCents)}</td>
						<td class="py-1.5 text-right">{formatCents(month.expenseCents)}</td>
						<td class="py-1.5 text-right {difference < 0 ? 'text-rose-600' : 'text-emerald-600'}">
							{formatCents(difference)}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</figure>
