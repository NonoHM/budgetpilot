<script lang="ts" module>
	let rcIdCounter = 0;

	export interface RangeCalendarRange {
		/** Midnight-UTC ISO date, or null when the bound is not placed. */
		start: string | null;
		end: string | null;
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { RangeCalendar as Bits } from 'bits-ui';
	import { CalendarDate, type DateValue } from '@internationalized/date';
	import type { locales } from '$lib/paraglide/runtime';
	import {
		RANGE_CALENDAR_SIZES,
		rangeStatusSentence,
		type RangeCalendarCopy,
		type RangeCalendarSize
	} from '$lib/domain/rangeCalendar';

	/**
	 * The range calendar: a grid, month navigation, a keyboard model and the semantics. Nothing else.
	 *
	 * SEPARABILITY IS THE POINT, not a nicety. The presets, the "Du"/"Au" fields, "Appliquer" and
	 * "Effacer" are chrome belonging to whichever dimension mounts this, and they live in the caller.
	 * /reports consumes the same grid for its two date pairs with entirely different presets ("Même
	 * période l'an dernier"), so anything that reads a Période message key or a Période URL param
	 * would have to be unpicked to get there. Hence `copy` as a prop rather than a messages import,
	 * ISO strings rather than this app's filter params, and no knowledge here of what a "period" is.
	 *
	 * The keyboard model is bits-ui's and is deliberately NOT reimplemented: arrows across weeks and
	 * months, Home/End, PageUp/PageDown, one tab stop for the whole grid via a roving tabindex.
	 * Forty-two tab stops would be a prison, and every one of those behaviours is a place to get an
	 * edge case wrong. What this file owns is what the design actually specifies: eleven visual
	 * states, two sizes, which strokes refuse to scale, and the words.
	 */
	let {
		value,
		onValueChange,
		size = 'mouse',
		locale,
		copy,
		/** Localises a day for its accessible name, e.g. "mardi 3 juin 2026". */
		formatLongDate,
		/** Localises the month caption for the live region, e.g. "juin 2026". */
		formatMonthCaption,
		/** Where the grid opens. Callers compute this with `reopeningMonthAnchor`. */
		anchorIso,
		todayIso,
		minIso,
		maxIso,
		isDateUnavailable,
		gridLabel,
		previousMonthLabel,
		nextMonthLabel
	}: {
		value: RangeCalendarRange;
		onValueChange: (range: RangeCalendarRange) => void;
		size?: RangeCalendarSize;
		/**
		 * The negotiated locale, NOT an arbitrary string. `new Intl.DateTimeFormat(locale)` throws a
		 * RangeError on a malformed tag — verified, including on `''` and `'../../etc'` — and this
		 * component builds formatters from it. Typing it as the compiled locale union makes that throw
		 * unrepresentable at compile time rather than guarded at runtime, which is the stronger form:
		 * there is no path that reaches the constructor with a bad tag.
		 *
		 * Not reachable today in any case (every caller passes Paraglide's `getLocale()`, which only
		 * ever returns a member of `locales`), so this closes the shape rather than a live hole.
		 */
		locale: (typeof locales)[number];
		copy: RangeCalendarCopy;
		formatLongDate: (iso: string) => string;
		formatMonthCaption: (iso: string) => string;
		anchorIso: string;
		/** Passed in, never read from the clock here: a component that reads `new Date()` cannot be
		 *  tested at a boundary, and a fixture pinned to the real wall clock is one of the assertion
		 *  shapes this repo records as structurally incapable of failing. */
		todayIso: string;
		/**
		 * SPECIFIED AND EXERCISED, BUT UNREACHABLE FROM THE ONLY CONSUMER TODAY.
		 *
		 * /transactions passes none of these three: it places no floor on how far back a period may
		 * reach, so no day is ever unavailable there and no bound is ever set. The design does specify
		 * the state ("les jours indisponibles sont barrés... et restent atteignables aux flèches"), so
		 * they are implemented and covered by direct-mount tests in RangeCalendar.svelte.spec.ts —
		 * mounted directly precisely because going through Période cannot reach them.
		 *
		 * For /reports, which is expected to adopt this component with a "premier import" floor: what
		 * is proven is the rendering and the refusal to select, in Chromium, at the mouse size. What is
		 * NOT proven is any of it under touch, or how a screen reader announces a struck-through cell.
		 * Do not assume this is battle-tested; it is specified, implemented and unit-covered.
		 */
		minIso?: string;
		maxIso?: string;
		isDateUnavailable?: (iso: string) => boolean;
		gridLabel: string;
		previousMonthLabel: string;
		nextMonthLabel: string;
	} = $props();

	const metrics = $derived(RANGE_CALENDAR_SIZES[size]);

	function toDateValue(iso: string | null | undefined): DateValue | undefined {
		if (!iso) return undefined;
		const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (!match) return undefined;
		return new CalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
	}

	function toIso(date: DateValue | undefined | null): string | null {
		if (!date) return null;
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
	}

	/**
	 * The panel's own view state. `placeholder` is bits-ui's name for "which month is on screen"; it
	 * is seeded from `anchorIso` rather than bound to the value so that navigating months never
	 * rewrites the range, and reopening re-seeds it through the caller's anchor rule.
	 */
	// `untrack` is deliberate, not a warning silencer: capturing the INITIAL anchor is exactly the
	// intent. The month on screen is view state the user then moves with the chevrons and the arrow
	// keys, so it must not be re-derived from the prop on every change — the $effect below is the
	// single writer that re-seeds it when the caller genuinely re-anchors (a reopen, a preset).
	let placeholder = $state<DateValue>(
		toDateValue(untrack(() => anchorIso)) ?? new CalendarDate(2000, 1, 1)
	);

	$effect(() => {
		const next = toDateValue(anchorIso);
		if (next) placeholder = next;
	});

	const bitsValue = $derived({
		start: toDateValue(value.start),
		end: toDateValue(value.end)
	});

	/**
	 * A range with a start and no end is not half a band, it is a single placed bound: design 6L
	 * wants all four corners on it, not a left-rounded stub whose flat right edge promises a band
	 * that is not there. bits-ui has no attribute for "the range is incomplete" — it is a property of
	 * the whole calendar rather than of a cell — so it is published here on the root and read back by
	 * the cells through a named group variant.
	 */
	const incomplete = $derived(value.start !== null && value.end === null);

	/**
	 * The candidate preview does not exist at 390, and must not be simulated (6L). A finger does not
	 * hover, so a band that follows the last tap would read as a selection already placed. The
	 * waiting state is said in words by the status line instead.
	 */
	const showsCandidate = $derived(size === 'mouse');

	const statusText = $derived(
		rangeStatusSentence({
			from: value.start,
			to: value.end,
			fromLong: value.start ? formatLongDate(value.start) : null,
			toLong: value.end ? formatLongDate(value.end) : null,
			copy
		})
	);

	const monthCaption = $derived(formatMonthCaption(toIso(placeholder) ?? anchorIso));

	function boundOf(iso: string): 'start' | 'end' | null {
		if (iso === value.start) return 'start';
		if (iso === value.end) return 'end';
		return null;
	}

	const radius = $derived(`${metrics.radius}px`);

	rcIdCounter += 1;
	const startDescId = `rc-bound-start-${rcIdCounter}`;
	const endDescId = `rc-bound-end-${rcIdCounter}`;
</script>

<div
	class="rc-root flex flex-col"
	style:--rc-cell="{metrics.cell}px"
	style:--rc-radius={radius}
	style:--rc-digit="{metrics.digit}px"
	style:--rc-head="{metrics.headCell}px"
	style:--rc-head-digit="{metrics.headDigit}px"
	data-incomplete={incomplete ? '' : undefined}
	data-candidate={showsCandidate ? '' : undefined}
	data-size={size}
>
	<Bits.Root
		bind:placeholder
		value={bitsValue}
		{locale}
		weekStartsOn={1}
		weekdayFormat="narrow"
		fixedWeeks={true}
		minValue={toDateValue(minIso)}
		maxValue={toDateValue(maxIso)}
		isDateUnavailable={isDateUnavailable
			? (date) => {
					const iso = toIso(date);
					return iso ? isDateUnavailable(iso) : false;
				}
			: undefined}
		onValueChange={(next) => onValueChange({ start: toIso(next?.start), end: toIso(next?.end) })}
		class="flex flex-col gap-2.5"
	>
		{#snippet children({ months, weekdays })}
			<!-- Month navigation. Two 44px chevrons at touch, 30px at mouse: they are targets, so they
			     follow the cell's own rule rather than staying at a desktop size. -->
			<Bits.Header class="flex items-center justify-between">
				<Bits.PrevButton
					aria-label={previousMonthLabel}
					class="flex h-[var(--rc-cell)] w-[var(--rc-cell)] items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none data-disabled:text-zinc-300"
				>
					<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" class="h-4 w-4">
						<path
							d="M12 5.5 7.5 10l4.5 4.5"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</Bits.PrevButton>
				<!--
					A PLAIN element, deliberately not `Bits.Heading`.

					`Bits.Heading` sets `aria-hidden="true"` on itself unconditionally, and svelte-toolbelt's
					`mergeProps` lets the LATER argument win for plain values — bits-ui's own props are
					merged after ours. So an `aria-live` passed to it produced a live region that was also
					`aria-hidden`, which is not a weaker announcement but NO announcement: an aria-hidden
					node is outside the accessibility tree and no screen reader ever reads it. The month
					change was silent, against 4.1.3, and it looked correct in the markup.

					That is also why the accessible names below go through `aria-describedby` rather than
					`aria-label` — same override, same cause.

					A reader arrowing from 31 May into 1 June crosses a month boundary with no other signal
					that the view changed under them, so this region is the only thing that says so.
				-->
				<div
					class="text-sm font-semibold text-zinc-900"
					aria-live="polite"
					aria-atomic="true"
					data-testid="rc-month-caption"
				>
					{monthCaption}
				</div>
				<Bits.NextButton
					aria-label={nextMonthLabel}
					class="flex h-[var(--rc-cell)] w-[var(--rc-cell)] items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none data-disabled:text-zinc-300"
				>
					<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" class="h-4 w-4">
						<path
							d="M8 5.5 12.5 10 8 14.5"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</Bits.NextButton>
			</Bits.Header>

			{#each months as month (month.value.toString())}
				<!--
					`border-separate border-spacing-0` is load-bearing, not a reset: a table's default
					border-spacing would put a gap between cells, and the band has to read as one
					continuous segment rather than a row of pills. The design's "écart entre cellules: 0"
					is this line.
				-->
				<Bits.Grid
					aria-label={gridLabel}
					class="mx-auto border-separate border-spacing-0 select-none"
				>
					<Bits.GridHead>
						<Bits.GridRow class="flex">
							{#each weekdays as day, index (index)}
								<!--
									`abbr` carries the full day name so a screen reader says "lundi" and not "L".
									The visible glyph stays one letter because seven of them have to fit in the
									grid's own width.
								-->
								<Bits.HeadCell
									abbr={new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(
										new Date(Date.UTC(2024, 0, 1 + index))
									)}
									class="flex h-[var(--rc-head)] w-[var(--rc-cell)] items-center justify-center text-[length:var(--rc-head-digit)] font-semibold text-zinc-400"
								>
									{day}
								</Bits.HeadCell>
							{/each}
						</Bits.GridRow>
					</Bits.GridHead>
					<Bits.GridBody>
						{#each month.weeks as week, weekIndex (weekIndex)}
							<Bits.GridRow class="flex">
								{#each week as date (date.toString())}
									{@const iso = toIso(date) ?? ''}
									<Bits.Cell {date} month={month.value} class="p-0">
										<Bits.Day
											aria-describedby={boundOf(iso) === 'start'
												? startDescId
												: boundOf(iso) === 'end'
													? endDescId
													: undefined}
											class="rc-day"
										>
											{#snippet children({ day })}
												<!--
													Aujourd'hui is an underline on the DIGIT, not a ring or a fill: both of
													those are already spoken for by the bounds and the band, and a third
													filled shape in the same grid would compete with the two that carry the
													range. 2px in both sizes — it answers acuity, not target size.

													Dropped once the cell is a bound: the solid black fill already carries
													far more emphasis than an underline could add, and a white 2px rule on
													black reads as an artefact rather than as "today".
												-->
												<!--
													Marked from `todayIso`, NOT from bits-ui's own `data-today`. bits-ui derives that
													attribute from the SYSTEM CLOCK, so it cannot be pinned by a fixture and it disagrees
													with the date this app considers today wherever the two differ, which is every test and
													every seeded environment. The app's notion of today is injected precisely so it is
													testable at a boundary; this marker follows it.
												-->
												<span
													data-rc-today={iso === todayIso ? '' : undefined}
													class="leading-[1.05] {iso === todayIso && boundOf(iso) === null
														? 'border-b-2 border-zinc-900 font-bold text-zinc-900'
														: ''}"
												>
													{day}
												</span>
											{/snippet}
										</Bits.Day>
									</Bits.Cell>
								{/each}
							</Bits.GridRow>
						{/each}
					</Bits.GridBody>
				</Bits.Grid>
			{/each}
		{/snippet}
	</Bits.Root>

	<!--
		The range, in words. This is what holds WCAG 1.4.1 for the band: the zinc-100 fill is 1.07:1
		against white and is never the sole carrier of the information. At 390 it does more than that —
		with the candidate preview removed, this sentence is the ONLY feedback between the first tap
		and the second.
	-->
	<!--
		The bound suffixes ("début de la plage" / "fin de la plage"), as DESCRIPTIONS rather than as
		part of each cell's name.

		They started as `aria-label` on the day, which is the obvious place for them and does not
		work: bits-ui sets its own `aria-label` (the bare date) on the same element, and mergeProps
		gives the later argument the win, so the suffix was dropped on every render. The unit test for
		`dayAccessibleName` passed throughout, because the function was right and simply never reached
		the DOM — the per-leg-green shape this repo keeps rediscovering.

		`aria-describedby` is not set by bits-ui, so it survives; and it is additive rather than
		replacing, which reads better anyway: "mercredi 10 juin 2026", then "début de la plage".
	-->
	<span id={startDescId} hidden>{copy.rangeStart}</span>
	<span id={endDescId} hidden>{copy.rangeEnd}</span>

	<p role="status" aria-live="polite" class="mt-2 text-xs text-zinc-600" data-testid="rc-status">
		{statusText}
	</p>
</div>

<style>
	/*
	 * The eleven states of design 6A, as a stylesheet rather than as utility classes.
	 *
	 * A stylesheet rather than the utility classes these rules started as, for two reasons that are
	 * about this component specifically and not about Tailwind. First, eleven states with two
	 * conditional radii, a not() exclusion and a whole-calendar modifier produced single class
	 * strings over 300 characters long, in which the difference between the candidate and the
	 * candidate EDGE was five repeated prefixes and one word. Second, the states are a specification
	 * with exact figures in it, and they are easier to check against the design side by side here.
	 *
	 * Recorded because it would otherwise be inferred wrongly: the 0px radius that first showed up
	 * in the measurement spec was NOT a Tailwind compilation failure. It was the test querying
	 * `[data-selection-start]`, which matches the `<td>` wrapper before the day element inside it, so
	 * it measured a box that never carried a radius under either approach. Whether the arbitrary
	 * variants would have compiled was never established, and nothing here should be read as
	 * evidence that they would not.
	 *
	 * `:global()` because the day elements are rendered by bits-ui, not by this template, so Svelte's
	 * scoping attribute never reaches them. Every selector is anchored under `.rc-root`, so the reach
	 * is this component's own subtree and not the document.
	 *
	 * Literal hex values, taken from the design, rather than theme tokens: these eleven states are a
	 * specification with exact figures in it (15.8:1 on the bounds, 1.07:1 on the band), and a token
	 * indirection is one more place for the palette to drift out from under a contrast claim.
	 *
	 * This does not weaken the CSP. The policy forbids an inline <style> element in HTML; a Svelte
	 * component style block is compiled into the external stylesheet.
	 */

	/* Base — Repos. zinc-700 on white. */
	.rc-root :global([data-bits-day]) {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		width: var(--rc-cell);
		height: var(--rc-cell);
		font-size: var(--rc-digit);
		font-variant-numeric: tabular-nums;
		color: #3f3f46;
		cursor: pointer;
	}

	/* Hors du mois — zinc-300. Rendered, never blanked: a blank cell breaks the grid's shape, and
	   the arrow keys still travel through it. */
	.rc-root :global([data-bits-day][data-outside-month]) {
		color: #d4d4d8;
	}

	/* Indisponible — struck through. Still reachable by the arrows and still announced: skipping it
	   would hide the limit instead of explaining it. */
	.rc-root :global([data-bits-day][data-unavailable]) {
		color: #a1a1aa;
		text-decoration: line-through;
		text-decoration-thickness: 1px;
		cursor: default;
	}

	/* Dans la plage — zinc-100, and NO radius at all, so the band reads as one continuous segment
	   rather than a row of pills. 1.07:1 against white, which is why it is never the sole carrier of
	   the information: the two bounds are black, both dates are written in Du/Au, and role="status"
	   states the range in words. */
	.rc-root :global([data-bits-day][data-range-middle]) {
		background: #f4f4f5;
		color: #18181b;
	}

	/* Début / Fin — solid black, white on top (15.8:1), radius on the outer side only. Two
	   independent rules, so a one-day range (both attributes at once) gets all four corners without
	   a branch. */
	.rc-root :global([data-bits-day][data-selection-start]),
	.rc-root :global([data-bits-day][data-selection-end]) {
		background: #18181b;
		color: #ffffff;
		font-weight: 600;
	}
	.rc-root :global([data-bits-day][data-selection-start]) {
		border-top-left-radius: var(--rc-radius);
		border-bottom-left-radius: var(--rc-radius);
	}
	.rc-root :global([data-bits-day][data-selection-end]) {
		border-top-right-radius: var(--rc-radius);
		border-bottom-right-radius: var(--rc-radius);
	}

	/* Jour unique, and the first bound placed before the second — four corners. A left-rounded stub
	   with a flat right edge promises a band that is not there. */
	.rc-root[data-incomplete] :global([data-bits-day][data-selection-start]) {
		border-radius: var(--rc-radius);
	}

	/* Candidat — dashes, never a solid fill: it is not chosen yet. 1px in BOTH sizes; at 48px a 2px
	   dash reads as a border. Gated on the root's data-candidate so 390 never renders it (6L). */
	.rc-root[data-candidate] :global([data-bits-day][data-highlighted]:not([data-selected])) {
		background: #fafafa;
		border-top: 1px dashed #d4d4d8;
		border-bottom: 1px dashed #d4d4d8;
	}

	/* Bord candidat — the edge of the preview is simply where the pointer or the keyboard focus is,
	   so it needs no state of its own. */
	.rc-root[data-candidate] :global([data-bits-day][data-highlighted]:not([data-selected]):hover),
	.rc-root[data-candidate]
		:global([data-bits-day][data-highlighted]:not([data-selected])[data-focused]) {
		background: #ffffff;
		border: 1px dashed #71717a;
		border-radius: var(--rc-radius);
		font-weight: 600;
		color: #18181b;
	}

	/* Focus clavier — 2px white then 2px zinc-400, identical in both sizes. A ring proportional to
	   the cell would become a frame. z-index so it is never clipped by a neighbour's background,
	   and it is a box-shadow rather than an outline so it follows the bound's radius. */
	.rc-root :global([data-bits-day][data-focused]) {
		z-index: 1;
		box-shadow:
			0 0 0 2px #ffffff,
			0 0 0 4px #a1a1aa;
		outline: none;
	}
</style>
