<script lang="ts">
	import { enhance } from '$app/forms';
	import Button from '$lib/components/Button.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import { cardBase } from '$lib/styles';
	import { MAX_PAIRS_PER_REQUEST } from '$lib/domain/transferPair';
	import * as m from '$lib/paraglide/messages';

	// #1189: the proposals the server computed, each from its outgoing leg to its incoming one. The
	// page never decides a pair: every button posts two ids that `confirmTransferPair` re-resolves.
	interface ProposedPair {
		outId: string;
		inId: string;
		fromAccount: string;
		toAccount: string;
		outDate: string;
		inDate: string;
		amountCents: number;
	}

	let {
		pairs,
		ambiguousCount,
		formatAmount,
		formatDate
	}: {
		pairs: ProposedPair[];
		ambiguousCount: number;
		formatAmount: (cents: number) => string;
		formatDate: (iso: string) => string;
	} = $props();

	let pending = $state<string | null>(null);

	// Earliest to latest: the window is symmetric, so money can be dated in before it is dated out
	// (passes 1189-code-1A N21, 1B N17). ISO days compare as strings.
	function dates(pair: ProposedPair): string {
		const [first, last] = [pair.outDate, pair.inDate].sort();
		return first === last ? formatDate(first) : `${formatDate(first)} – ${formatDate(last)}`;
	}

	function submitting(key: string) {
		return () => {
			pending = key;
			return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
				await update({ reset: false });
				pending = null;
			};
		};
	}
</script>

{#if pairs.length > 0}
	<section
		aria-labelledby="transfer-pairs-title"
		class="{cardBase} flex flex-col gap-4 !bg-zinc-50 p-5"
		data-testid="transfer-pairs-band"
	>
		<div class="flex items-start gap-3.5">
			<span
				aria-hidden="true"
				class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white"
			>
				<svg width="20" height="20" viewBox="0 0 20 20" fill="none">
					<path
						d="M4 7h11l-3-3M16 13H5l3 3"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</span>
			<div class="min-w-0 flex-1">
				<h2 id="transfer-pairs-title" class="text-[15px] font-bold tracking-tight text-zinc-900">
					{pairs.length === 1
						? m.transfer_pairs_title_one()
						: m.transfer_pairs_title_many({ count: pairs.length })}
				</h2>
				<p class="mt-0.5 text-[13px] leading-snug text-zinc-600">
					{m.transfer_pairs_subtitle()}
				</p>
			</div>
			<Tooltip label={m.transfer_pairs_info()} wrapperClass="relative inline-flex shrink-0">
				<button
					type="button"
					aria-label={m.transfer_pairs_info_label()}
					class="-m-1.5 flex h-11 w-11 items-center justify-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:outline-none"
				>
					<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
						<circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.4" />
						<path
							d="M10 9v5M10 6.5v.01"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
						/>
					</svg>
				</button>
			</Tooltip>
		</div>

		<ul class="flex flex-col gap-2">
			{#each pairs as pair (pair.outId)}
				<li class="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
					<div class="min-w-0 flex-1">
						<!-- Wraps rather than truncates: the destination account is the fact being checked,
						     and at 390 an ellipsis cut it off (walk 1189, w390). -->
						<p class="text-sm font-semibold break-words text-zinc-900">
							{m.transfer_pairs_route({ from: pair.fromAccount, to: pair.toAccount })}
						</p>
						<p class="mt-0.5 text-[13px] text-zinc-600">{dates(pair)}</p>
					</div>
					<span class="shrink-0 text-sm font-semibold text-zinc-900 tabular-nums">
						{formatAmount(pair.amountCents)}
					</span>
					<form
						method="POST"
						action="?/linkTransferPair"
						class="shrink-0"
						use:enhance={submitting(pair.outId)}
					>
						<input type="hidden" name="outId" value={pair.outId} />
						<input type="hidden" name="inId" value={pair.inId} />
						<Button
							type="submit"
							variant="secondary"
							size="field"
							loading={pending === pair.outId}
							disabled={pending !== null}
							aria-label={m.transfer_pairs_link_aria({
								amount: formatAmount(pair.amountCents),
								from: pair.fromAccount,
								to: pair.toAccount
							})}
						>
							{m.transfer_pairs_link()}
						</Button>
					</form>
				</li>
			{/each}
		</ul>

		{#if ambiguousCount > 0}
			<p class="text-[13px] leading-snug text-zinc-600">
				{ambiguousCount === 1
					? m.transfer_pairs_ambiguous_one()
					: m.transfer_pairs_ambiguous_many({ count: ambiguousCount })}
			</p>
		{/if}

		{#if pairs.length > 1}
			<form method="POST" action="?/linkAllTransferPairs" use:enhance={submitting('all')}>
				<Button
					type="submit"
					size="field"
					class="w-full lg:w-auto"
					loading={pending === 'all'}
					disabled={pending !== null}
				>
					<!-- What one press links: the server stops at the cap, the rest stay proposed. -->
					{m.transfer_pairs_link_all({ count: Math.min(pairs.length, MAX_PAIRS_PER_REQUEST) })}
				</Button>
			</form>
		{/if}
	</section>
{/if}
