<script module lang="ts">
	export interface DonutSegment {
		label: string;
		color: string;
		pct: number; // 0-100, share of the total
	}
</script>

<script lang="ts">
	let {
		segments,
		othersColor,
		title,
		meta,
		centerCaption,
		centerValue,
		emptyText,
		ariaLabel
	}: {
		segments: DonutSegment[];
		othersColor: string;
		title: string;
		meta: string;
		centerCaption: string;
		centerValue: string;
		emptyText: string;
		ariaLabel?: string;
	} = $props();

	// Hand-rolled SVG ring (stroke-dasharray trick on a circle), same pattern as
	// NetWorthChart.svelte — no charting library, and segment colors are set via the SVG
	// `stroke`/`fill` presentation attributes rather than a CSS `style="background: ..."`:
	// those attributes aren't governed by the `style-src` CSP directive, unlike inline styles,
	// so this avoids `unsafe-inline` entirely without any visual change (a conic-gradient
	// circle and a stroked ring render identically here).
	const SIZE = 100;
	const CENTER = SIZE / 2;
	const RADIUS = 40;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

	interface RingArc {
		color: string;
		dasharray: string;
		dashoffset: number;
	}

	function buildArcs(segs: DonutSegment[]): RingArc[] {
		if (segs.length === 0) {
			return [{ color: othersColor, dasharray: `${CIRCUMFERENCE} 0`, dashoffset: 0 }];
		}
		let cursorPct = 0;
		const arcs: RingArc[] = [];
		for (const seg of segs) {
			const pct = Math.max(0, Math.min(seg.pct, 100 - cursorPct));
			const length = (pct / 100) * CIRCUMFERENCE;
			arcs.push({
				color: seg.color,
				dasharray: `${length} ${CIRCUMFERENCE - length}`,
				dashoffset: -((cursorPct / 100) * CIRCUMFERENCE)
			});
			cursorPct += pct;
		}
		if (cursorPct < 100) {
			const length = ((100 - cursorPct) / 100) * CIRCUMFERENCE;
			arcs.push({
				color: othersColor,
				dasharray: `${length} ${CIRCUMFERENCE - length}`,
				dashoffset: -((cursorPct / 100) * CIRCUMFERENCE)
			});
		}
		return arcs;
	}

	const arcs = $derived(buildArcs(segments));
</script>

<div class="flex items-baseline justify-between">
	<h3 class="text-sm font-semibold tracking-tight text-zinc-900">{title}</h3>
	<span class="text-xs text-zinc-400">{meta}</span>
</div>
{#if segments.length > 0}
	<div class="mt-4 flex flex-col items-center gap-6 lg:flex-row">
		<div
			class="relative h-44 w-44 shrink-0 lg:h-32 lg:w-32"
			role="img"
			aria-label={ariaLabel ?? title}
		>
			<svg viewBox="0 0 {SIZE} {SIZE}" class="h-44 w-44 -rotate-90 lg:h-32 lg:w-32">
				{#each arcs as arc, i (i)}
					<circle
						cx={CENTER}
						cy={CENTER}
						r={RADIUS}
						fill="none"
						stroke={arc.color}
						stroke-width="16"
						stroke-dasharray={arc.dasharray}
						stroke-dashoffset={arc.dashoffset}
					/>
				{/each}
			</svg>
			<div
				class="absolute inset-[22px] flex flex-col items-center justify-center rounded-full bg-white lg:inset-[15px]"
			>
				<span class="text-[10px] font-medium uppercase tracking-wide text-zinc-400 lg:text-[9px]">
					{centerCaption}
				</span>
				<span class="text-xl font-semibold tabular-nums text-zinc-900 lg:text-base">
					{centerValue}
				</span>
			</div>
		</div>
		<ul class="w-full flex-1 space-y-2 text-[13px]">
			{#each segments as segment (segment.label)}
				<li class="flex items-center gap-2">
					<svg class="h-2.5 w-2.5 shrink-0" viewBox="0 0 10 10" aria-hidden="true">
						<rect width="10" height="10" rx="2" fill={segment.color} />
					</svg>
					<span class="flex-1 truncate text-zinc-700">{segment.label}</span>
					<span class="tabular-nums font-medium text-zinc-900">{Math.round(segment.pct)} %</span>
				</li>
			{/each}
		</ul>
	</div>
{:else}
	<p class="mt-4 text-sm text-zinc-500">{emptyText}</p>
{/if}
