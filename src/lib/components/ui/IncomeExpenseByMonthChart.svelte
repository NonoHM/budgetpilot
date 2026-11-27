<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import { formatMoney, money } from '$lib/domain/money';
	import type { MonthIncomeExpense } from '$lib/domain/incomeExpenseByMonth';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { resolve } from '$app/paths';

	let { months }: { months: MonthIncomeExpense[] } = $props();

	// Validated pair (docs: f3-colour-decision): emerald-500 / rose-700 keep deutan ΔE 17.0, where
	// the text pair emerald-600 / rose-600 scored 5.8. Amounts in text keep the text tokens.
	const INCOME_FILL = '#10b981';
	const EXPENSE_FILL = '#be123c';
	const PLOT_TOP = 8;
	const GUTTER = 52;
	const LIST_PREVIEW = 6;
	// Below this width the chart keeps the last six months, as YNAB's mobile report does: thirteen
	// pairs at 390 px are needles with labels that cannot all fit.
	const NARROW = 560;

	// Drawn at the container's own pixel width, so text in the SVG renders at its true size and
	// each month label sits in its own slot; 640 until the first measure (server render).
	let measured = $state(0);
	const width = $derived(measured || 640);
	// Taller beside the month list on wide screens, so the two columns end together.
	const HEIGHT = $derived(width < 600 ? 200 : 260);
	const PLOT_BOTTOM = $derived(HEIGHT - 24);
	const shown = $derived(width < NARROW ? months.slice(-LIST_PREVIEW) : months);

	const whole = $derived(months.filter((month) => !month.partial));
	const hasData = $derived(months.some((month) => month.incomeCents > 0 || month.expenseCents > 0));
	const totals = $derived({
		income: whole.reduce((sum, month) => sum + month.incomeCents, 0),
		expense: whole.reduce((sum, month) => sum + month.expenseCents, 0),
		beyond: whole.filter((month) => month.expenseCents > month.incomeCents).length
	});

	/** Gridlines on a 1-2-5 step, so the top line sits just above the tallest bar and every label
	 *  is a round amount. */
	const scale = $derived.by(() => {
		const peak = Math.max(1, ...shown.flatMap((month) => [month.incomeCents, month.expenseCents]));
		const raw = peak / 3;
		const magnitude = 10 ** Math.floor(Math.log10(raw));
		const step = ([1, 2, 5, 10].find((factor) => factor * magnitude >= raw) ?? 10) * magnitude;
		const top = step * Math.ceil(peak / step);
		return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
	});
	const slot = $derived((width - GUTTER) / Math.max(1, shown.length));
	const barWidth = $derived(Math.min(28, slot * 0.34));

	function y(cents: number): number {
		return PLOT_BOTTOM - ((PLOT_BOTTOM - PLOT_TOP) * cents) / scale.top;
	}

	/** A bar with rounded top corners, square on the baseline; nothing for a zero amount. */
	function bar(x: number, cents: number): string {
		const top = y(cents);
		if (PLOT_BOTTOM - top < 0.5) return '';
		const r = Math.min(3, (PLOT_BOTTOM - top) / 2, barWidth / 2);
		return `M${x},${PLOT_BOTTOM}V${top + r}Q${x},${top} ${x + r},${top}H${x + barWidth - r}Q${x + barWidth},${top} ${x + barWidth},${top + r}V${PLOT_BOTTOM}Z`;
	}

	function wholeAmount(cents: number): string {
		return formatMoney(money(cents), { locale: getLocale(), maximumFractionDigits: 0 });
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
		const name = month.partial
			? `${monthName(month.month, 'long')} · ${m.reports_month_flow_in_progress()}`
			: monthName(month.month, 'long');
		return m.reports_month_flow_bar_label({
			month: name,
			income: formatCents(month.incomeCents),
			expense: formatCents(month.expenseCents)
		});
	}

	let activeIndex = $state<number | null>(null);
	const active = $derived(activeIndex === null ? null : shown[activeIndex]);
	let expanded = $state(false);
	const newestFirst = $derived([...months].reverse());
	const listed = $derived(expanded ? newestFirst : newestFirst.slice(0, LIST_PREVIEW));
</script>

<figure class="space-y-5">
	{#if !hasData}
		<p class="text-sm text-zinc-500">{m.reports_month_flow_empty()}</p>
	{:else}
		<figcaption class="max-w-prose text-sm text-zinc-600">
			{m.reports_month_flow_summary({
				income: formatCents(totals.income),
				expense: formatCents(totals.expense),
				count: String(totals.beyond)
			})}
		</figcaption>

		<div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
			<div>
				<div class="mb-2 flex gap-4 text-xs text-zinc-600" aria-hidden="true">
					<span class="inline-flex items-center gap-1.5">
						<span class="h-2.5 w-2.5 rounded-sm bg-emerald-500"></span>
						{m.reports_kpi_income()}
					</span>
					<span class="inline-flex items-center gap-1.5">
						<span class="h-2.5 w-2.5 rounded-sm bg-rose-700"></span>
						{m.reports_kpi_expense()}
					</span>
				</div>
				<div class="relative" bind:clientWidth={measured}>
					<svg class="block w-full" height={HEIGHT} viewBox="0 0 {width} {HEIGHT}" role="group">
						{#each scale.ticks as tick (tick)}
							<line
								x1={GUTTER}
								x2={width}
								y1={Math.round(y(tick)) + 0.5}
								y2={Math.round(y(tick)) + 0.5}
								stroke={tick === 0 ? '#a1a1aa' : '#f4f4f5'}
							/>
							<text
								x={GUTTER - 8}
								y={y(tick) + 4}
								text-anchor="end"
								font-size="11"
								fill="#71717a"
								aria-hidden="true">{wholeAmount(tick)}</text
							>
						{/each}
						{#each shown as month, index (month.month)}
							{@const left = GUTTER + index * slot + (slot - 2 * barWidth - 3) / 2}
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
									x={GUTTER + index * slot + 1}
									y="1"
									width={slot - 2}
									height={HEIGHT - 2}
									rx="6"
									class="fill-transparent stroke-transparent group-hover:fill-zinc-50 group-focus-visible:stroke-zinc-900"
									stroke-width="2"
								/>
								<path
									d={bar(left, month.incomeCents)}
									fill={INCOME_FILL}
									fill-opacity={month.partial ? 0.4 : 1}
								/>
								<path
									d={bar(left + barWidth + 3, month.expenseCents)}
									fill={EXPENSE_FILL}
									fill-opacity={month.partial ? 0.4 : 1}
								/>
								<text
									x={GUTTER + index * slot + slot / 2}
									y={HEIGHT - 6}
									text-anchor="middle"
									font-size="11"
									class={month.partial ? 'fill-zinc-400' : 'fill-zinc-500'}
									aria-hidden="true">{monthName(month.month, 'short')}</text
								>
							</a>
						{/each}
					</svg>
					{#if active && activeIndex !== null}
						<div
							class="pointer-events-none absolute top-0 z-10 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs whitespace-nowrap shadow-sm"
							style:left="{GUTTER + (activeIndex + 0.5) * slot}px"
							style:transform={activeIndex < shown.length / 2
								? 'translateX(-12px)'
								: 'translateX(calc(-100% + 12px))'}
						>
							<div class="font-semibold text-zinc-900">
								{monthName(
									active.month,
									'long'
								)}{#if active.partial}{` · ${m.reports_month_flow_in_progress()}`}{/if}
							</div>
							<div class="mt-1 text-zinc-600 tabular-nums">
								{m.reports_kpi_income()}
								<span class="text-zinc-900">{formatCents(active.incomeCents)}</span>
							</div>
							<div class="text-zinc-600 tabular-nums">
								{m.reports_kpi_expense()}
								<span class="text-zinc-900">{formatCents(active.expenseCents)}</span>
							</div>
						</div>
					{/if}
				</div>
			</div>

			<div>
				<ul class="divide-y divide-zinc-100">
					{#each listed as month (month.month)}
						{@const difference = month.incomeCents - month.expenseCents}
						<li class="flex items-start justify-between gap-4 py-2.5" data-month-row={month.month}>
							<div class="min-w-0">
								<a
									href={monthHref(month)}
									class="text-sm font-medium text-zinc-900 underline-offset-2 hover:underline"
									>{monthName(month.month, 'long')}</a
								>{#if month.partial}<span class="text-xs text-zinc-500"
										>{` · ${m.reports_month_flow_in_progress()}`}</span
									>{/if}
								<div class="mt-0.5 text-xs text-zinc-500 tabular-nums">
									{m.reports_kpi_income()}
									{formatCents(month.incomeCents)} · {m.reports_kpi_expense()}
									{formatCents(month.expenseCents)}
								</div>
							</div>
							<div
								class="shrink-0 text-sm font-semibold tabular-nums {difference < 0
									? 'text-rose-600'
									: difference > 0
										? 'text-emerald-600'
										: 'text-zinc-500'}"
							>
								{formatCents(difference, getLocale(), undefined, 'exceptZero')}
							</div>
						</li>
					{/each}
				</ul>
				{#if months.length > LIST_PREVIEW}
					<button
						type="button"
						class="mt-1 min-h-11 text-sm font-medium text-zinc-700 underline-offset-2 hover:underline"
						aria-expanded={expanded}
						onclick={() => (expanded = !expanded)}
					>
						{expanded
							? m.reports_month_flow_show_fewer()
							: m.reports_month_flow_show_all({ count: String(months.length) })}
					</button>
				{/if}
			</div>
		</div>
	{/if}
</figure>
