<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { NetWorthTimelinePoint } from '$lib/domain/netWorth';

	let { series }: { series: NetWorthTimelinePoint[] } = $props();

	const WIDTH = 600;
	const HEIGHT = 160;
	const PADDING = 8;
	// Extra vertical room reserved so the max/min labels never clip the viewBox edges.
	const LABEL_MARGIN = 14;

	// crypto.randomUUID() avoids gradient id collisions if several charts render at once.
	const gradientId = `net-worth-gradient-${crypto.randomUUID().slice(0, 8)}`;

	function formatFullDate(capturedAt: string): string {
		return new Date(capturedAt).toLocaleString(getLocale(), {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// Light label: year only shown if different from the current year (app-wide date convention).
	function formatShortDate(capturedAt: string): string {
		const date = new Date(capturedAt);
		const includeYear = date.getFullYear() !== new Date().getFullYear();
		return date.toLocaleDateString(getLocale(), {
			day: 'numeric',
			month: 'short',
			year: includeYear ? 'numeric' : undefined
		});
	}

	// X is proportional to elapsed TIME between snapshots, not to the point's index — two
	// updates a day apart and one six months later must not occupy equal horizontal space,
	// or the curve's slope stops meaning anything (see net-worth audit finding #2).
	const points = $derived.by(() => {
		if (series.length === 0) return [];
		const totals = series.map((point) => point.totalCents);
		const min = Math.min(...totals);
		const max = Math.max(...totals);
		const span = max - min || 1;
		const top = PADDING + LABEL_MARGIN;
		const bottom = HEIGHT - PADDING - LABEL_MARGIN;

		const timestamps = series.map((point) => new Date(point.capturedAt).getTime());
		const minTs = Math.min(...timestamps);
		const maxTs = Math.max(...timestamps);
		const tsSpan = maxTs - minTs || 1;

		return series.map((point, index) => {
			const x =
				series.length === 1
					? WIDTH / 2
					: PADDING + ((timestamps[index] - minTs) / tsSpan) * (WIDTH - PADDING * 2);
			const y = bottom - ((point.totalCents - min) / span) * (bottom - top);
			return { x, y, capturedAt: point.capturedAt, totalCents: point.totalCents };
		});
	});

	// Picks the first point reaching the extremum (stable if several points tie).
	const maxPoint = $derived.by(() => {
		if (points.length === 0) return null;
		return points.reduce((best, point) => (point.totalCents > best.totalCents ? point : best));
	});
	const minPoint = $derived.by(() => {
		if (points.length === 0) return null;
		return points.reduce((best, point) => (point.totalCents < best.totalCents ? point : best));
	});

	function labelAnchor(x: number): 'start' | 'middle' | 'end' {
		if (x < 60) return 'start';
		if (x > WIDTH - 60) return 'end';
		return 'middle';
	}

	// Hover (desktop) / tap (mobile) card for the exact value at a point — the always-visible
	// max/min labels above stay untouched, this is a separate, transient detail on demand.
	let activeIndex = $state<number | null>(null);
	const activePoint = $derived(activeIndex !== null ? (points[activeIndex] ?? null) : null);

	// Always SETS (never toggles): a real click/tap is preceded by a synthetic mouseenter
	// (true for both mouse clicks and touch-compatibility mouse events), which already sets
	// activeIndex — a toggle here would immediately flip it back off on every click/tap.
	function selectPoint(index: number): void {
		activeIndex = index;
	}

	function dismissActivePoint(): void {
		activeIndex = null;
	}

	// Hover must only react to a genuine mouse (pointerType), never a touch tap: touch's
	// mouse-compatibility layer fires a full enter+leave pair for every tap (finger lifts,
	// no persisted hover), which would otherwise clear the card the instant it was set.
	function handlePointerEnter(index: number, event: PointerEvent): void {
		if (event.pointerType === 'mouse') activeIndex = index;
	}
	function handlePointerLeave(event: PointerEvent): void {
		if (event.pointerType === 'mouse') dismissActivePoint();
	}

	// Mobile browsers can fire a SECOND, independent click for a tap (their touch-to-mouse
	// compatibility layer) beyond the one that already bubbled through a point's own handler
	// and called stopPropagation() — so this window listener can't rely on propagation alone.
	// It checks the target directly instead: any click landing on a point is the point's own
	// business (it already set the right index), never a reason to dismiss.
	function handleWindowClick(event: MouseEvent): void {
		const target = event.target as Element | null;
		if (target?.closest('[data-net-worth-point]')) return;
		dismissActivePoint();
	}

	// Card sits above the point by default, flipping below when too close to the chart's top
	// edge (mirrors the same clamping logic already used for the max/min text labels).
	const activeCardTransform = $derived.by(() => {
		if (!activePoint) return '';
		const anchor = labelAnchor(activePoint.x);
		const translateX = anchor === 'start' ? '0%' : anchor === 'end' ? '-100%' : '-50%';
		const showAbove = activePoint.y > PADDING + LABEL_MARGIN + 20;
		const translateY = showAbove ? 'calc(-100% - 10px)' : '10px';
		return `translate(${translateX}, ${translateY})`;
	});

	// Colored by the sign of the current (latest) total only — never per-segment — so the
	// line stays a single consistent color even when the curve dips temporarily.
	const tone = $derived.by(() => {
		if (points.length === 0) return 'neutral';
		const currentTotal = points[points.length - 1].totalCents;
		if (currentTotal > 0) return 'positive';
		if (currentTotal < 0) return 'negative';
		return 'neutral';
	});

	const toneColor = $derived(
		tone === 'positive' ? '#10b981' : tone === 'negative' ? '#e11d48' : '#71717a'
	);
	const toneTextClass = $derived(
		tone === 'positive'
			? 'text-emerald-500'
			: tone === 'negative'
				? 'text-rose-600'
				: 'text-zinc-500'
	);

	const linePath = $derived(
		points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')
	);
	// A single point has nothing to fill under (no line to close into an area).
	const areaPath = $derived(
		points.length < 2
			? ''
			: `${linePath} L${points[points.length - 1].x},${HEIGHT} L${points[0].x},${HEIGHT} Z`
	);
</script>

<svelte:window onclick={handleWindowClick} />

{#if points.length === 0}
	<p class="text-sm text-zinc-500">{m.net_worth_chart_empty()}</p>
{:else}
	<div class="relative">
		<svg
			class="w-full {toneTextClass}"
			viewBox="0 0 {WIDTH} {HEIGHT}"
			role="img"
			aria-label={m.net_worth_chart_caption()}
		>
			<defs>
				<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color={toneColor} stop-opacity="0.25" />
					<stop offset="100%" stop-color={toneColor} stop-opacity="0" />
				</linearGradient>
			</defs>
			<path d={areaPath} fill="url(#{gradientId})" stroke="none" />
			<path d={linePath} fill="none" stroke="currentColor" stroke-width="1.5" />
			{#each points as point, index (`${point.capturedAt}-${index}`)}
				<g
					role="button"
					tabindex="0"
					data-net-worth-point
					aria-label={`${formatFullDate(point.capturedAt)} · ${formatCents(point.totalCents)}`}
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
						r={activeIndex === index ? 4 : 3}
						fill="white"
						stroke="currentColor"
						stroke-width="1.5"
					>
						<title>{formatFullDate(point.capturedAt)} · {formatCents(point.totalCents)}</title>
					</circle>
				</g>
			{/each}
			{#if maxPoint}
				<text
					x={maxPoint.x}
					y={maxPoint.y - 6}
					text-anchor={labelAnchor(maxPoint.x)}
					font-size="9"
					fill="#71717a"
				>
					{m.net_worth_chart_max_label({ amount: formatCents(maxPoint.totalCents) })}
				</text>
			{/if}
			{#if minPoint && minPoint !== maxPoint}
				<text
					x={minPoint.x}
					y={minPoint.y + 14}
					text-anchor={labelAnchor(minPoint.x)}
					font-size="9"
					fill="#71717a"
				>
					{m.net_worth_chart_min_label({ amount: formatCents(minPoint.totalCents) })}
				</text>
			{/if}
		</svg>
		{#if activePoint}
			<div
				class="pointer-events-none absolute z-10 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs whitespace-nowrap shadow-sm"
				style:left="{(activePoint.x / WIDTH) * 100}%"
				style:top="{(activePoint.y / HEIGHT) * 100}%"
				style:transform={activeCardTransform}
			>
				<div class="font-semibold text-zinc-900 tabular-nums">
					{formatCents(activePoint.totalCents)}
				</div>
				<div class="mt-0.5 text-zinc-400">{formatFullDate(activePoint.capturedAt)}</div>
			</div>
		{/if}
	</div>
	{#if series.length === 1}
		<div class="mt-1 text-center text-xs text-zinc-500">
			{formatShortDate(series[0].capturedAt)}
		</div>
	{:else}
		<div class="mt-1 flex justify-between text-xs text-zinc-500">
			<span>{formatShortDate(series[0].capturedAt)}</span>
			<span>{formatShortDate(series[series.length - 1].capturedAt)}</span>
		</div>
	{/if}
	<div class="sr-only">
		<table>
			<caption>{m.net_worth_chart_caption()}</caption>
			<tbody>
				{#each series as point, index (`${point.capturedAt}-${index}`)}
					<tr>
						<th scope="row">{formatFullDate(point.capturedAt)}</th>
						<td>{formatCents(point.totalCents)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
{/if}
