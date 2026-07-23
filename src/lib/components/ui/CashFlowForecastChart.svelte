<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import { formatShortDate } from '$lib/domain/dateFormat';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { FlowCadence } from '$lib/domain/forecast';

	interface ForecastEvent {
		amountCents: number;
		label: string;
		cadence: FlowCadence;
	}

	interface ForecastDay {
		date: string;
		balanceCents: number;
		events: ForecastEvent[];
	}

	let {
		days,
		todayIndex,
		hasBalanceAnchor
	}: { days: ForecastDay[]; todayIndex: number; hasBalanceAnchor: boolean } = $props();

	const WIDTH = 600;
	const HEIGHT = 160;
	const PADDING = 8;
	const LABEL_MARGIN = 14;

	// Strictly monochrome black/zinc/white per the design decision: a projected flow is neither a
	// gain nor a loss until it's realized, so the SVG trace itself never carries the app's
	// emerald/rose monetary convention — only the numeric KPI labels around the chart do (see the
	// dashboard/reports callers).
	const REALIZED_COLOR = '#18181b'; // zinc-900
	const PROJECTED_MARKER_STROKE = '#a1a1aa'; // zinc-400
	const TODAY_LINE_COLOR = '#d4d4d8'; // zinc-300

	// Unique per chart instance so several charts on the same page (e.g. dashboard + reports) never
	// collide on the same SVG def id — same pattern as NetWorthChart's gradientId.
	const areaGradientId = `cash-flow-forecast-area-${crypto.randomUUID().slice(0, 8)}`;
	const projectedFadeMaskId = `cash-flow-forecast-projected-fade-${crypto.randomUUID().slice(0, 8)}`;

	function formatFullDate(date: string): string {
		return formatShortDate(date, getLocale());
	}

	// Keeps the accessible name (aria-label/title) in sync with the visual "Aujourd'hui" pin, which
	// also special-cases the today index instead of its date — a screen-reader user must get the
	// same framing for the single most important point on the chart.
	function pointDateLabel(index: number, date: string): string {
		return index === todayIndex ? m.forecast_chart_today_label() : formatFullDate(date);
	}

	function pointStatusLabel(index: number): string {
		return index <= todayIndex
			? m.forecast_chart_status_realized()
			: m.forecast_chart_status_projected();
	}

	// Index-proportional spacing is equivalent to time-proportional here: the ledger is a dense
	// daily series (unlike NetWorthChart's irregular snapshots), so consecutive points are always
	// exactly 1 day apart.
	const points = $derived.by(() => {
		if (days.length === 0) return [];
		const balances = days.map((day) => day.balanceCents);
		const min = Math.min(...balances, 0);
		const max = Math.max(...balances, 0);
		const span = max - min || 1;
		const top = PADDING + LABEL_MARGIN;
		const bottom = HEIGHT - PADDING - LABEL_MARGIN;

		return days.map((day, index) => {
			const x =
				days.length === 1
					? WIDTH / 2
					: PADDING + (index / (days.length - 1)) * (WIDTH - PADDING * 2);
			const y = bottom - ((day.balanceCents - min) / span) * (bottom - top);
			return { x, y, date: day.date, balanceCents: day.balanceCents, events: day.events };
		});
	});

	// Clamped defensively — todayIndex always comes from the server-computed ledger (never
	// re-derived from dates here), but a clamp keeps a single out-of-range value from breaking the
	// whole chart instead of just the boundary it describes.
	const clampedTodayIndex = $derived(
		Math.min(Math.max(todayIndex, 0), Math.max(points.length - 1, 0))
	);

	// Only "today" (the realized/projected boundary), event days, and the final projected day get a
	// visible marker + are keyboard-reachable — every other day is purely part of the line
	// (selective direct labels, not a number on every point; also avoids up to ~90 tab stops on a
	// 3-month horizon).
	const markerIndexes = $derived.by(() => {
		// Local scratch value, built and discarded within this computation; never stored as reactive state.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const indexes = new Set<number>([clampedTodayIndex, points.length - 1]);
		points.forEach((point, index) => {
			if (point.events.length > 0) indexes.add(index);
		});
		return [...indexes].filter((index) => index >= 0).sort((a, b) => a - b);
	});

	function buildPath(pts: { x: number; y: number }[]): string {
		return pts.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');
	}
	function buildArea(pts: { x: number; y: number }[]): string {
		if (pts.length < 2) return '';
		return `${buildPath(pts)} L${pts[pts.length - 1].x},${HEIGHT} L${pts[0].x},${HEIGHT} Z`;
	}

	// Solid for the realized portion (up to and including "today"), dashed for the projected
	// portion (from "today" onward) — sharing the today point between both slices keeps the two
	// strokes visually joined, with no gap at the boundary.
	const realizedPoints = $derived(points.slice(0, clampedTodayIndex + 1));
	const projectedPoints = $derived(points.slice(clampedTodayIndex));

	const realizedLinePath = $derived(buildPath(realizedPoints));
	const projectedLinePath = $derived(buildPath(projectedPoints));
	const realizedAreaPath = $derived(buildArea(realizedPoints));
	const projectedAreaPath = $derived(buildArea(projectedPoints));

	const todayX = $derived(points[clampedTodayIndex]?.x ?? 0);
	const horizonEndX = $derived(points[points.length - 1]?.x ?? WIDTH - PADDING);

	let activeIndex = $state<number | null>(null);
	const activePoint = $derived(activeIndex !== null ? (points[activeIndex] ?? null) : null);

	function selectPoint(index: number): void {
		activeIndex = index;
	}
	function dismissActivePoint(): void {
		activeIndex = null;
	}
	function handlePointerEnter(index: number, event: PointerEvent): void {
		if (event.pointerType === 'mouse') activeIndex = index;
	}
	function handlePointerLeave(event: PointerEvent): void {
		if (event.pointerType === 'mouse') dismissActivePoint();
	}
	function handleWindowClick(event: MouseEvent): void {
		const target = event.target as Element | null;
		if (target?.closest('[data-forecast-point]')) return;
		dismissActivePoint();
	}

	function labelAnchor(x: number): 'start' | 'middle' | 'end' {
		if (x < 60) return 'start';
		if (x > WIDTH - 60) return 'end';
		return 'middle';
	}

	const activeCardTransform = $derived.by(() => {
		if (!activePoint) return '';
		const anchor = labelAnchor(activePoint.x);
		const translateX = anchor === 'start' ? '0%' : anchor === 'end' ? '-100%' : '-50%';
		const showAbove = activePoint.y > PADDING + LABEL_MARGIN + 20;
		const translateY = showAbove ? 'calc(-100% - 10px)' : '10px';
		return `translate(${translateX}, ${translateY})`;
	});
</script>

<svelte:window onclick={handleWindowClick} />

{#if points.length === 0}
	<p class="text-sm text-zinc-500">{m.forecast_chart_empty()}</p>
{:else}
	{#if !hasBalanceAnchor}
		<p class="mb-2 text-xs text-zinc-500">{m.forecast_chart_relative_caption()}</p>
	{/if}
	<div class="relative">
		<svg
			class="w-full"
			viewBox="0 0 {WIDTH} {HEIGHT}"
			role="img"
			aria-label={m.forecast_chart_caption()}
		>
			<defs>
				<linearGradient id={areaGradientId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color={REALIZED_COLOR} stop-opacity="0.12" />
					<stop offset="100%" stop-color={REALIZED_COLOR} stop-opacity="0" />
				</linearGradient>
				<!-- Luminance mask: white = fully visible, black = fully transparent. Combined
				     (multiplied) with the vertical area gradient above, this fades the projected fill
				     both top-to-bottom (like the realized portion) AND left-to-right toward the end of
				     the horizon — "less certain the further out we project" — without ever tinting the
				     fill itself (still REALIZED_COLOR, monochrome). -->
				<linearGradient
					id={projectedFadeMaskId}
					x1={todayX}
					y1="0"
					x2={horizonEndX}
					y2="0"
					gradientUnits="userSpaceOnUse"
				>
					<stop offset="0%" stop-color="white" />
					<stop offset="100%" stop-color="black" />
				</linearGradient>
				<mask
					id="{projectedFadeMaskId}-mask"
					maskUnits="userSpaceOnUse"
					x="0"
					y="0"
					width={WIDTH}
					height={HEIGHT}
				>
					<rect x="0" y="0" width={WIDTH} height={HEIGHT} fill="url(#{projectedFadeMaskId})" />
				</mask>
			</defs>
			<path d={realizedAreaPath} fill="url(#{areaGradientId})" stroke="none" />
			<path
				d={projectedAreaPath}
				fill="url(#{areaGradientId})"
				stroke="none"
				mask="url(#{projectedFadeMaskId}-mask)"
			/>
			<line
				x1={todayX}
				y1={PADDING}
				x2={todayX}
				y2={HEIGHT - PADDING}
				stroke={TODAY_LINE_COLOR}
				stroke-width="1"
				stroke-dasharray="2 3"
			/>
			<path d={realizedLinePath} fill="none" stroke={REALIZED_COLOR} stroke-width="1.5" />
			<path
				d={projectedLinePath}
				fill="none"
				stroke={REALIZED_COLOR}
				stroke-opacity="0.55"
				stroke-width="1.5"
				stroke-dasharray="4 3"
			/>
			{#each markerIndexes as index (points[index].date)}
				{@const point = points[index]}
				{@const isBoundaryMarker = index === clampedTodayIndex || index === points.length - 1}
				<g
					role="button"
					tabindex="0"
					data-forecast-point
					aria-label={`${pointDateLabel(index, point.date)} · ${formatCents(point.balanceCents)}${point.events.length > 0 ? ` · ${point.events.map((e) => e.label).join(', ')}` : ''}`}
					onpointerenter={(event) => handlePointerEnter(index, event)}
					onpointerleave={handlePointerLeave}
					onclick={(event) => {
						event.stopPropagation();
						selectPoint(index);
					}}
					onkeydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							event.stopPropagation();
							selectPoint(index);
						}
					}}
					class="cursor-pointer"
				>
					<circle cx={point.x} cy={point.y} r="10" fill="transparent" />
					<circle
						cx={point.x}
						cy={point.y}
						r={activeIndex === index ? 4 : isBoundaryMarker ? 3.5 : 3}
						fill={isBoundaryMarker ? REALIZED_COLOR : 'white'}
						stroke={isBoundaryMarker ? REALIZED_COLOR : PROJECTED_MARKER_STROKE}
						stroke-width="1.5"
					>
						<title>{pointDateLabel(index, point.date)} · {formatCents(point.balanceCents)}</title>
					</circle>
				</g>
			{/each}
		</svg>
		<div
			class="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-bold text-white"
			style:left="{(todayX / WIDTH) * 100}%"
		>
			{m.forecast_chart_today_label()}
		</div>
		{#if activePoint}
			<div
				class="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs shadow-sm"
				style:left="{(activePoint.x / WIDTH) * 100}%"
				style:top="{(activePoint.y / HEIGHT) * 100}%"
				style:transform={activeCardTransform}
			>
				<div class="font-semibold tabular-nums text-zinc-900">
					{formatCents(activePoint.balanceCents)}
				</div>
				<div class="mt-0.5 text-zinc-400">
					{pointDateLabel(activeIndex ?? -1, activePoint.date)}
				</div>
				{#each activePoint.events as event (event.label + event.amountCents)}
					<div class="mt-1 flex items-center gap-1.5 border-t border-zinc-100 pt-1 text-zinc-500">
						<span class="truncate">{event.label}</span>
						<span class="tabular-nums font-medium text-zinc-700"
							>{formatCents(event.amountCents)}</span
						>
					</div>
				{/each}
			</div>
		{/if}
	</div>
	<div class="mt-1 flex justify-between text-xs text-zinc-500">
		<span>{formatFullDate(points[0].date)}</span>
		<span>{formatFullDate(points[points.length - 1].date)}</span>
	</div>
	<div class="sr-only">
		<table>
			<caption>{m.forecast_chart_caption()}</caption>
			<tbody>
				{#each points as point, index (point.date)}
					<tr>
						<th scope="row">{formatFullDate(point.date)}</th>
						<td>{formatCents(point.balanceCents)}</td>
						<td>{pointStatusLabel(index)}</td>
						<td>
							{point.events
								.map((event) => `${event.label} ${formatCents(event.amountCents)}`)
								.join(', ')}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
