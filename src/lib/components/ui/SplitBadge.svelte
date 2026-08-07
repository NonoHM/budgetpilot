<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { formatCents } from '$lib/domain/budget';

	/**
	 * The list row's répartition indicator (design 1l–1o): « +N » other categories, or « ×N » parts
	 * when every part shares one category.
	 *
	 * IT IS ALWAYS RENDERED ON A SPLIT ROW, and the « ×N » form is why. Two parts in one category
	 * give N = 0, and a bare category name there would be strictly indistinguishable from an
	 * unsplit transaction — breaking the constraint the whole surface exists for, « une transaction
	 * répartie doit se reconnaître sans l'ouvrir », precisely for the user who has just filtered on
	 * répartition. The operator changes with the quantity: « + » counts categories, « × » counts
	 * parts, and reusing one symbol for two different things would be the real trap.
	 *
	 * NOT the shared Tooltip component, for the reason `TagChips` records at its own overflow badge:
	 * Tooltip wires an `aria-describedby` from the trigger to the bubble, which here would repeat
	 * the button's own `aria-label` word for word. The bubble is a purely visual, `aria-hidden` echo
	 * for sighted mouse and keyboard users; the label is what carries the parts to everyone else,
	 * which is why it lists them rather than promising a detail no assistive technology can reach.
	 */
	interface Props {
		/**
		 * Every allocation, in position order, with categories ALREADY localised by the caller —
		 * resolving the "Non catégorisé" sentinel needs the page's own default-key map, so doing it
		 * here would drag page state into a leaf component.
		 */
		parts: Array<{ category: string; amountCents: number }>;
		/** Distinct categories OTHER than the dominant one. Zero selects the « ×N » form. */
		otherCategoryCount: number;
		/** Localised, and only used by the « ×N » sentence — « toutes en Alimentation ». */
		dominantCategory: string;
		/**
		 * Desktop only. A button with a bubble at 24 px; anywhere else an inert 22 px span.
		 *
		 * Interactivity and geometry travel together on purpose, and the design ties them the same
		 * way: at 390 the badge would be a 22 px target glued to a full-row target, two destinations
		 * under one thumb, so it is not a target at all — and the detail comes from opening the
		 * transaction, which is already the natural gesture there. A 22 px BUTTON would be under the
		 * 24 px floor; a 24 px span would cost height in the one place height is scarce.
		 */
		interactive?: boolean;
	}

	let { parts, otherCategoryCount, dominantCategory, interactive = false }: Props = $props();

	const label = $derived(
		otherCategoryCount >= 1
			? m.splits_row_badge_others({ n: otherCategoryCount })
			: m.splits_row_badge_same({ n: parts.length })
	);

	/**
	 * Magnitudes, not signed amounts, and the design draws them that way: a part of an 80,00 €
	 * expense reads « 60,00 € », never « −60,00 € ». It is the editor's convention — everything in a
	 * répartition is expressed relative to the parent's sign, which is what lets one sentence work
	 * for an expense and an income (see domain/splitDraft.ts). A sign here would be the only place
	 * in the feature where the user has to read one to understand a magnitude.
	 */
	const detail = $derived(
		parts.map((part) => `${part.category} ${formatCents(Math.abs(part.amountCents))}`).join(', ')
	);

	/** The full sentence: the bubble is aria-hidden, so the name is the only route to the parts. */
	const detailedName = $derived(
		otherCategoryCount >= 1
			? m.splits_row_badge_others_detail({ count: otherCategoryCount + 1, detail })
			: m.splits_row_badge_same_detail({
					count: parts.length,
					category: dominantCategory,
					detail
				})
	);

	/**
	 * The short sentence, for the inert badge. No per-part list: at 390 the detail is deliberately
	 * behind opening the transaction, and reading every part of every row would make the list
	 * unusable by ear long before it became useful.
	 */
	const shortName = $derived(
		otherCategoryCount >= 1
			? m.splits_row_badge_others_short({ count: otherCategoryCount + 1 })
			: m.splits_row_badge_same_short({ count: parts.length, category: dominantCategory })
	);

	let open = $state(false);
</script>

{#if interactive}
	<span class="relative inline-flex">
		<button
			type="button"
			class="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md border px-1 text-[11.5px] font-semibold tabular-nums focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none {open
				? 'border-zinc-900 bg-zinc-900 text-white'
				: 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900'}"
			aria-label={detailedName}
			onmouseenter={() => (open = true)}
			onmouseleave={() => (open = false)}
			onfocus={() => (open = true)}
			onblur={() => (open = false)}
			onkeydown={(event) => {
				if (event.key === 'Escape') open = false;
			}}
		>
			{label}
		</button>
		{#if open}
			<span
				aria-hidden="true"
				class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[11.5px] leading-relaxed whitespace-nowrap text-white"
			>
				<span class="block font-semibold"
					>{m.splits_row_tooltip_heading({ count: parts.length })}</span
				>
				{#each parts as part, index (index)}
					<span class="block"
						>{part.category}
						{formatCents(Math.abs(part.amountCents))}</span
					>
				{/each}
			</span>
		{/if}
	</span>
{:else}
	<!-- The sentence travels WITH the badge rather than being owed by the caller. An optional
	     affordance stays at its first consumer — the header snippet took months and four wrong call
	     sites to prove it — and a badge announcing itself as "times two" is the exact fragmented
	     reading the design asks to replace. Nothing here can be used without its explanation. -->
	<span class="inline-flex shrink-0 items-center">
		<span
			aria-hidden="true"
			class="inline-flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-white px-1 text-[11.5px] font-semibold text-zinc-700 tabular-nums"
		>
			{label}
		</span>
		<span class="sr-only">{shortName}</span>
	</span>
{/if}
