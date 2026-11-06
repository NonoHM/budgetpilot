<script lang="ts">
	import { onMount } from 'svelte';
	import * as m from '$lib/paraglide/messages';
	import type { AmountSign } from '$lib/domain/amountSign';
	import TapLink from '$lib/components/ui/TapLink.svelte';

	/**
	 * #1207 C2c-S1, ADR #1206: the amount sign question as a STEP OF ITS OWN, at both widths.
	 *
	 * Not a bottom sheet and not an anchored panel (owner, 2026-11-06): a blocking question of a flow
	 * is a page whose heading is the question (NN/g, « not using a bottom sheet to replace typical
	 * page-to-page user flows »; GOV.UK question pages). The walk measured the panel's answers below
	 * the fold at 1280. One column, no sticky, no inner scroll: everything fits the first viewport for
	 * the three rows it shows.
	 *
	 * No default: nothing is pressed or focused on arrival but the heading. Back returns to the columns
	 * WITHOUT answering; « Some out, some in » explains and answers nothing.
	 */
	let {
		prompt,
		onChoose,
		onBack
	}: {
		prompt: {
			fact: string;
			rows: readonly { label: string; date: string; amount: string }[];
			outFirst: string;
			inFirst: string;
		};
		onChoose: (sign: AmountSign) => void;
		onBack: () => void;
	} = $props();

	let headingEl = $state<HTMLElement | null>(null);
	let bothShown = $state(false);

	onMount(() => {
		window.scrollTo(0, 0);
		headingEl?.focus();
	});
</script>

<div class="w-full text-zinc-900" data-testid="amount-sign-step">
	<div class="mx-auto flex w-full max-w-[40rem] flex-col px-5 pt-2 pb-8">
		<div class="flex">
			<button
				type="button"
				class="-ml-2 flex min-h-11 items-center gap-1 rounded-lg px-2 text-[15px] font-semibold text-zinc-700"
				onclick={onBack}
			>
				<span aria-hidden="true">‹</span>
				{m.import_designate_amount_sign_back()}
			</button>
		</div>

		<h1
			bind:this={headingEl}
			tabindex="-1"
			class="mt-3 text-2xl font-semibold outline-none lg:text-3xl"
		>
			{m.import_designate_amount_sign_title()}
		</h1>
		<p class="mt-2 text-[15px] leading-[22px] text-zinc-600">{prompt.fact}</p>

		<p class="mt-5 text-[12.5px] leading-[18px] text-zinc-500">
			{m.import_designate_amount_sign_rows_label()}
		</p>
		<!-- Wrapped, never truncated (AISVS C9.2.2): a cut amount is the one fact being asked about. -->
		<ul
			class="mt-1.5 flex flex-col divide-y divide-zinc-100 rounded-[14px] border border-zinc-200 bg-white"
		>
			{#each prompt.rows as row, index (index)}
				<li
					class="flex items-start justify-between gap-3 px-3.5 py-2.5 text-[14px] leading-5"
					data-testid="amount-sign-row"
				>
					<span class="min-w-0 break-words text-zinc-700">{row.label} · {row.date}</span>
					<!-- shrink-0: as a flex item it would shrink to one character, and break-all cuts the number (#1306). -->
					<span
						class="max-w-[50%] shrink-0 text-right font-semibold break-all text-zinc-900 tabular-nums"
						>{row.amount}</span
					>
				</li>
			{/each}
		</ul>

		<div class="mt-5 grid grid-cols-2 gap-3">
			<button
				type="button"
				class="flex min-h-[88px] flex-col items-start justify-center gap-1 rounded-[14px] border-[1.5px] border-zinc-900 bg-white px-4 py-3 text-left"
				onclick={() => onChoose('out')}
			>
				<span class="text-[17px] font-semibold text-zinc-900"
					>{m.import_designate_amount_sign_out()}</span
				>
				<span class="text-[15px] font-semibold break-all text-rose-600 tabular-nums"
					>{prompt.outFirst}</span
				>
			</button>
			<button
				type="button"
				class="flex min-h-[88px] flex-col items-start justify-center gap-1 rounded-[14px] border-[1.5px] border-zinc-900 bg-white px-4 py-3 text-left"
				onclick={() => onChoose('in')}
			>
				<span class="text-[17px] font-semibold text-zinc-900"
					>{m.import_designate_amount_sign_in()}</span
				>
				<span class="text-[15px] font-semibold break-all text-emerald-700 tabular-nums"
					>{prompt.inFirst}</span
				>
			</button>
		</div>

		<div class="mt-2 flex min-h-12 items-center">
			<TapLink onclick={() => (bothShown = true)}>{m.import_designate_amount_sign_both()}</TapLink>
		</div>
		<!-- Always present, so the sentence is announced when it appears. -->
		<div
			aria-live="polite"
			class="text-[14px] leading-5 text-zinc-600"
			data-testid="amount-sign-both"
		>
			{#if bothShown}
				<p>{m.import_designate_amount_sign_both_reason()}</p>
			{/if}
		</div>
	</div>
</div>
