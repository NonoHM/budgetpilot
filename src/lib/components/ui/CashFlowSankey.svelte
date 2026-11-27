<script lang="ts">
	import { formatCents } from '$lib/domain/budget';
	import { categoryDisplayName } from '$lib/domain/categoryLabels';
	import type { CashFlowSankey, SankeyNode } from '$lib/domain/cashFlowSankey';
	import * as m from '$lib/paraglide/messages';
	import { CATEGORY_PALETTE_OTHERS, hexToBgClass } from '$lib/domain/colors';

	// `colors`: the page's own category → colour map, the one its donut and top-categories table
	// use, so a category wears one colour across /reports. A category outside it, and « Other »,
	// take the palette's neutral.
	let { flow, colors = {} }: { flow: CashFlowSankey; colors?: Record<string, string> } = $props();

	// Layout values within the published library defaults (d3-sankey 24/8, Highcharts 20/10):
	// docs f2-sankey-principles. The diagram is drawn only where its labels fit beside it; below
	// that the list under it is the whole view (ruled in #1193, WCAG 2.2 1.4.10).
	const NODE = 12;
	const GAP = 10;
	const HEIGHT = 320;
	// Room above the nodes for the total's label, so it is never clipped.
	const TOP = 28;
	const LABEL = 200;
	const MIN_WIDTH = 640;
	const INCOME_FILL = '#10b981';
	const NEUTRAL_FILL = '#a1a1aa';
	const TOTAL_FILL = '#3f3f46';

	let measured = $state(0);
	const width = $derived(measured);
	const draws = $derived(width >= MIN_WIDTH && flow.totalCents > 0);

	// A ribbon takes its node's colour: income in emerald (the money rule), each spending category
	// in the colour the page's donut gives it, the balance and « Other » neutral.
	interface Flow {
		key: string;
		label: string;
		cents: number;
		color: string;
	}
	interface Placed extends Flow {
		y: number;
		height: number;
	}

	function expenseColor(node: SankeyNode): string {
		return node.category === null
			? CATEGORY_PALETTE_OTHERS
			: (colors[node.category] ?? CATEGORY_PALETTE_OTHERS);
	}

	function label(node: SankeyNode): string {
		return node.category === null
			? m.reports_cash_flow_other({ count: String(node.members.length) })
			: categoryDisplayName(node.category);
	}

	const left: Flow[] = $derived([
		...flow.income.map((node) => ({
			key: `in:${node.category ?? ''}`,
			label: label(node),
			cents: node.cents,
			color: INCOME_FILL
		})),
		...(flow.beyondIncomeCents > 0
			? [
					{
						key: 'beyond',
						label: m.reports_cash_flow_beyond(),
						cents: flow.beyondIncomeCents,
						color: NEUTRAL_FILL
					}
				]
			: [])
	]);
	const right: Flow[] = $derived([
		...flow.expenses.map((node) => ({
			key: `out:${node.category ?? ''}`,
			label: label(node),
			cents: node.cents,
			color: expenseColor(node)
		})),
		...(flow.leftOverCents > 0
			? [
					{
						key: 'left',
						label: m.reports_cash_flow_left_over(),
						cents: flow.leftOverCents,
						color: NEUTRAL_FILL
					}
				]
			: [])
	]);

	const scale = $derived(
		(HEIGHT - TOP - 8 - GAP * (Math.max(left.length, right.length) - 1)) /
			Math.max(1, flow.totalCents)
	);

	function stack(nodes: Flow[]): Placed[] {
		const span =
			nodes.reduce((total, node) => total + node.cents * scale, 0) + GAP * (nodes.length - 1);
		let y = TOP + (HEIGHT - TOP - span) / 2;
		return nodes.map((node) => {
			const placed = { ...node, y, height: Math.max(1, node.cents * scale) };
			y += node.cents * scale + GAP;
			return placed;
		});
	}

	const leftNodes = $derived(stack(left));
	const rightNodes = $derived(stack(right));
	const totalHeight = $derived(flow.totalCents * scale);
	const totalY = $derived(TOP + (HEIGHT - TOP - totalHeight) / 2);
	const xLeft = $derived(LABEL);
	const xCentre = $derived(width / 2 - NODE / 2);
	const xRight = $derived(width - LABEL - NODE);

	/** A ribbon between two vertical segments, as a closed band of two cubic curves. */
	function ribbon(x0: number, a0: number, a1: number, x1: number, b0: number, b1: number): string {
		const mid = (x0 + x1) / 2;
		return `M${x0},${a0}C${mid},${a0} ${mid},${b0} ${x1},${b0}L${x1},${b1}C${mid},${b1} ${mid},${a1} ${x0},${a1}Z`;
	}

	const ribbons = $derived.by(() => {
		const out: { key: string; d: string; color: string }[] = [];
		let cursor = totalY;
		for (const node of leftNodes) {
			const h = node.cents * scale;
			out.push({
				key: node.key,
				color: node.color,
				d: ribbon(xLeft + NODE, node.y, node.y + h, xCentre, cursor, cursor + h)
			});
			cursor += h;
		}
		cursor = totalY;
		for (const node of rightNodes) {
			const h = node.cents * scale;
			out.push({
				key: node.key,
				color: node.color,
				d: ribbon(xCentre + NODE, cursor, cursor + h, xRight, node.y, node.y + h)
			});
			cursor += h;
		}
		return out;
	});

	/** Long category names are cut by characters (never inside an emoji) and also clipped to the
	 *  label column; the full name is in the list under the diagram. The amount has its own line and
	 *  is never cut, so no clipping can change a figure (contradiction pass, 2026-11-27). */
	function fit(text: string): string {
		const characters = [...text];
		return characters.length > 24 ? `${characters.slice(0, 23).join('')}…` : text;
	}

	// Two lines per label need 30 px. A label sits beside its node, pushed down when the one above
	// is closer than that, then the column is moved up as a whole if it overflows the bottom.
	const LINE_PAIR = 30;
	function labelCentres(nodes: Placed[]): number[] {
		const centres: number[] = [];
		for (const node of nodes) {
			const wanted = node.y + node.height / 2;
			centres.push(centres.length === 0 ? wanted : Math.max(wanted, centres.at(-1)! + LINE_PAIR));
		}
		const overflow = (centres.at(-1) ?? 0) + LINE_PAIR / 2 - HEIGHT;
		return overflow > 0 ? centres.map((centre) => centre - overflow) : centres;
	}
	const leftLabels = $derived(labelCentres(leftNodes));
	const rightLabels = $derived(labelCentres(rightNodes));
	const clipId = `sankey-${crypto.randomUUID().slice(0, 8)}`;

	let hovered = $state<string | null>(null);
</script>

<figure class="space-y-5">
	{#if flow.totalCents === 0}
		<p class="text-sm text-zinc-500">{m.reports_cash_flow_empty()}</p>
	{:else}
		<div bind:clientWidth={measured}>
			{#if draws}
				<svg class="block w-full" height={HEIGHT} viewBox="0 0 {width} {HEIGHT}" aria-hidden="true">
					<defs>
						<clipPath id="{clipId}-left"
							><rect x="0" y="0" width={xLeft - 8} height={HEIGHT} /></clipPath
						>
						<clipPath id="{clipId}-right"
							><rect x={xRight + NODE + 8} y="0" width={LABEL - 8} height={HEIGHT} /></clipPath
						>
					</defs>
					{#each ribbons as band (band.key)}
						<path
							d={band.d}
							fill={band.color}
							fill-opacity={hovered === null ? 0.2 : hovered === band.key ? 0.45 : 0.08}
						/>
					{/each}
					{#each leftNodes as node, index (node.key)}
						<g
							role="presentation"
							onpointerenter={() => (hovered = node.key)}
							onpointerleave={() => (hovered = null)}
						>
							<rect
								x={xLeft}
								y={node.y}
								width={NODE}
								height={node.height}
								rx="2"
								fill={node.color}
							/>
							<text
								x={xLeft - 8}
								y={leftLabels[index] - 2}
								text-anchor="end"
								font-size="12"
								fill="#18181b"
								clip-path="url(#{clipId}-left)">{fit(node.label)}</text
							>
							<text
								x={xLeft - 8}
								y={leftLabels[index] + 12}
								text-anchor="end"
								font-size="12"
								fill="#71717a"
								class="tabular-nums">{formatCents(node.cents)}</text
							>
						</g>
					{/each}
					<rect x={xCentre} y={totalY} width={NODE} height={totalHeight} rx="2" fill={TOTAL_FILL} />
					<text
						x={xCentre + NODE / 2}
						y={totalY - 8}
						text-anchor="middle"
						font-size="12"
						fill="#18181b"
						>{m.reports_donut_total_label()}
						<tspan fill="#71717a">{formatCents(flow.totalCents)}</tspan></text
					>
					{#each rightNodes as node, index (node.key)}
						<g
							role="presentation"
							onpointerenter={() => (hovered = node.key)}
							onpointerleave={() => (hovered = null)}
						>
							<rect
								x={xRight}
								y={node.y}
								width={NODE}
								height={node.height}
								rx="2"
								fill={node.color}
							/>
							<text
								x={xRight + NODE + 8}
								y={rightLabels[index] - 2}
								font-size="12"
								fill="#18181b"
								clip-path="url(#{clipId}-right)">{fit(node.label)}</text
							>
							<text
								x={xRight + NODE + 8}
								y={rightLabels[index] + 12}
								font-size="12"
								fill="#71717a"
								class="tabular-nums">{formatCents(node.cents)}</text
							>
						</g>
					{/each}
				</svg>
			{/if}
		</div>

		<div class="grid gap-6 sm:grid-cols-2">
			{#each [{ title: m.reports_cash_flow_in(), nodes: flow.income, kind: 'in' }, { title: m.reports_cash_flow_out(), nodes: flow.expenses, kind: 'out' }] as group (group.kind)}
				<section class={group.nodes.length === 0 ? 'hidden' : ''}>
					<h3 class="text-sm font-medium text-zinc-900">{group.title}</h3>
					<ul class="mt-1 divide-y divide-zinc-100" data-cash-flow={group.kind}>
						{#each group.nodes as node (node.category ?? '')}
							<li class="flex items-start justify-between gap-4 py-2">
								<div class="min-w-0">
									<div class="flex items-center gap-2 text-sm text-zinc-900">
										{#if group.kind === 'out'}<span
												class="h-2.5 w-2.5 shrink-0 rounded-sm {hexToBgClass(expenseColor(node))}"
												aria-hidden="true"
											></span>{/if}{label(node)}
									</div>
									{#if node.members.length > 0}
										<div class="mt-0.5 text-xs text-zinc-500">
											{node.members.map(categoryDisplayName).join(', ')}
										</div>
									{/if}
								</div>
								<div class="shrink-0 text-sm text-zinc-900 tabular-nums">
									{formatCents(node.cents)}
								</div>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
		<p
			class="flex justify-between gap-4 border-t border-zinc-200 pt-3 text-sm font-semibold tabular-nums"
			data-cash-flow="balance"
		>
			{#if flow.beyondIncomeCents > 0}
				<span class="text-zinc-900">{m.reports_cash_flow_beyond()}</span>
				<span class="text-rose-600">{formatCents(flow.beyondIncomeCents)}</span>
			{:else}
				<span class="text-zinc-900">{m.reports_cash_flow_left_over()}</span>
				<span class="text-emerald-600">{formatCents(flow.leftOverCents)}</span>
			{/if}
		</p>
	{/if}
</figure>
