<script lang="ts">
	import { getLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';
	import { formatCents } from '$lib/domain/budget';
	import { formatMoneyWithoutSymbol, money } from '$lib/domain/money';
	import { createPoliteAnnouncer } from '$lib/announce';
	import type { RemainderState } from '$lib/domain/splitDraft';

	/**
	 * Design 1d's remainder band, and design 1p's announcement of it — deliberately the SAME
	 * component, because they are the two halves of one mechanism and each is harmless alone.
	 *
	 * The band is the visible, per-keystroke display. The live region is a whole sentence heard only
	 * after a typing pause. They read the same `RemainderState` and share no DOM node, which is the
	 * point: 1p's rule is that `aria-describedby` targets the hidden region and ONLY the hidden
	 * region, because `aria-hidden` takes an element's descendants out of the accessibility tree and
	 * a `describedby` aimed into it exposes nothing reliably across browsers.
	 *
	 * The caller owns `announcementId` and points its neutralised Save button at it — never at
	 * anything inside the band.
	 *
	 * The prop is `remainder` and NOT `state`, and that is not a style preference: a variable named
	 * `state` in scope makes the compiler read `$state(...)` as a store auto-subscription on it, and
	 * the component dies at runtime with `store_invalid_shape` — « `state` is not a store with a
	 * `subscribe` method ». Every test in this file failed that way before the rename.
	 */
	let {
		remainder,
		announcementId,
		class: extraClass = ''
	}: {
		remainder: RemainderState;
		announcementId: string;
		class?: string;
	} = $props();

	/**
	 * Spoken amounts are formatted WITHOUT the currency symbol, because 1p spells the word:
	 * « Reste à répartir, 20,00 euros. » Screen-reader pronunciation of "€" is not consistent enough
	 * to carry the unit, and the design chose the spelled form rather than leaving it to chance.
	 */
	function spokenAmount(cents: number): string {
		return formatMoneyWithoutSymbol(money(cents), { locale: getLocale() });
	}

	function sentenceFor(s: RemainderState): string {
		if (s.kind === 'zero') return m.splits_announce_zero();
		const amount = spokenAmount(s.magnitudeCents);
		return s.kind === 'positive'
			? m.splits_announce_positive({ amount })
			: m.splits_announce_negative({ amount });
	}

	const label = $derived(
		remainder.kind === 'positive'
			? m.splits_remainder_label_positive()
			: remainder.kind === 'zero'
				? m.splits_remainder_label_zero()
				: m.splits_remainder_label_negative()
	);

	const hint = $derived.by(() => {
		const total = formatCents(Math.abs(remainder.totalCents));
		if (remainder.kind === 'positive') return m.splits_remainder_hint_positive();
		// `count` is never 1: the model's floor is 2 parts, enforced by `replaceSplits` and by the
		// editor's own floor. A `_one` variant here would be copy that can never render.
		if (remainder.kind === 'zero')
			return m.splits_remainder_hint_zero({ total, count: remainder.partCount });
		return m.splits_remainder_hint_negative({
			total,
			amount: formatCents(remainder.magnitudeCents)
		});
	});

	// Seeded, not announced: see `createPoliteAnnouncer`'s `initial`. The region renders holding the
	// opening sentence so that opening the panel is silent.
	//
	// Capturing only the INITIAL value is the entire point, so the warning is suppressed rather than
	// worked around: this is the sentence the region is born with, and a reactive read here would
	// defeat it by making the seed track later states.
	// svelte-ignore state_referenced_locally
	const initialSentence = sentenceFor(remainder);
	let announced = $state(initialSentence);
	const announcer = createPoliteAnnouncer({
		initial: initialSentence,
		onChange: (sentence) => (announced = sentence)
	});

	$effect(() => {
		announcer.schedule(sentenceFor(remainder));
		return () => announcer.cancel();
	});

	/**
	 * Announce now rather than after the pause. The caller wires this to its amount fields' `blur`:
	 * 1p allows the sentence « immédiatement au blur du champ », because leaving a field is a
	 * discrete gesture and only typing has to be muzzled.
	 */
	export function flushAnnouncement(): void {
		announcer.flush();
	}

	const surfaceClass = $derived(
		remainder.kind === 'negative'
			? 'border-[#fda4af] bg-[#fff1f2] text-[#be123c]'
			: 'border-zinc-200 bg-zinc-50 text-zinc-700'
	);
</script>

<!--
	`aria-hidden`, and it is not an oversight: what changes on every keystroke is never what is
	heard. The same information reaches assistive technology through the region below, as one
	sentence, after a pause.

	Three lines, never more, never fewer — the height does not change between states, so nothing
	jumps while typing. No field is ever marked in error: no single part is wrong on its own, it is
	their sum that is, and reddening the last-edited field would accuse the wrong line.
-->
<div
	class="grid gap-0.5 rounded-xl border px-3 py-2 {surfaceClass} {extraClass}"
	aria-hidden="true"
>
	<div class="flex items-center justify-between gap-3">
		<span class="flex items-center gap-1.5 text-sm font-semibold">
			{#if remainder.kind === 'zero'}
				<svg viewBox="0 0 16 16" class="h-[13px] w-[13px] shrink-0" fill="none">
					<path
						d="M3.5 8.5 6.5 11.5 12.5 5"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			{:else if remainder.kind === 'negative'}
				<svg viewBox="0 0 16 16" class="h-[13px] w-[13px] shrink-0" fill="none">
					<path
						d="M8 2.5 15 14.5H1L8 2.5Z"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linejoin="round"
					/>
					<path d="M8 6.5v3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
					<circle cx="8" cy="12" r="0.75" fill="currentColor" />
				</svg>
			{/if}
			{label}
		</span>
		<span class="text-sm font-semibold tabular-nums">{formatCents(remainder.magnitudeCents)}</span>
	</div>
	<p class="text-xs {remainder.kind === 'negative' ? 'text-[#be123c]' : 'text-zinc-500'}">{hint}</p>
</div>

<!--
	The ONLY thing `aria-describedby` may point at. `status`, not `alert`: an overshoot is a form
	state in progress, not an incident — `alert` is reserved for the save failure, which arrives
	without the user having typed anything.
-->
<div id={announcementId} class="sr-only" role="status" aria-live="polite">{announced}</div>
