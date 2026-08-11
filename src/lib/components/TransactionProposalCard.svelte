<script lang="ts">
	import { enhance } from '$app/forms';
	import Button from './Button.svelte';
	import Combobox from './ui/Combobox.svelte';
	import Select from './ui/Select.svelte';
	import * as m from '$lib/paraglide/messages';
	import { resolveProposalCategory } from '$lib/domain/categories';
	// Imported rather than received as a prop. It used to be one, because a category's label
	// depended on the per-page `defaultKey` map that only a loader could supply. Since #162 the
	// label is a pure function of the stored name, so the prop was threading a constant through
	// two components.
	import { categoryDisplayName } from '$lib/domain/categoryLabels';

	// Proposal (category/nature suggestion) + Accept/Create rule/Ignore actions, shared by the
	// desktop detail panel, the mobile bottom sheet, and TransactionFocusOverlay (see CLAUDE.md
	// — zero business-logic duplication). `variant` only changes the style: 'panel' = badges
	// (desktop detail panel), 'compact' = card (mobile / focus mode).
	//
	// Always a real editable form (category Combobox + nature Select), never static text:
	// pre-filled with the rule suggestion if there is one, otherwise with UNCLASSIFIED_CATEGORY
	// ("Non catégorisé", existing default behavior) — never hidden or left empty when no rule matches.
	let {
		transactionId,
		suggestion,
		categoryOptions,
		natureOptions,
		variant = 'panel',
		getCategoryColor,
		formatNatureLabel,
		acceptError,
		onAccepted,
		onIgnore,
		onCreateRule
	}: {
		transactionId: string;
		suggestion: { category: string; nature: string | null } | null;
		categoryOptions: readonly string[];
		natureOptions: readonly string[];
		variant?: 'panel' | 'compact';
		getCategoryColor: (categoryName: string) => string;
		formatNatureLabel: (nature: string | null) => string;
		acceptError?: string;
		onAccepted: (transactionId: string) => void;
		onIgnore: (transactionId: string) => void;
		onCreateRule: (category: string, nature: string | null) => void;
	} = $props();

	let formEl = $state<HTMLFormElement | null>(null);
	let categoryValue = $state('');
	let natureValue = $state('');
	let acceptSubmitting = $state(false);

	// Re-seeds the editable fields whenever the target transaction changes (new transactionId or
	// a fresh suggestion object from the server): pre-filled with the rule-matched suggestion, or
	// UNCLASSIFIED_CATEGORY when no rule matched. Stable while the user edits the current
	// transaction (transactionId/suggestion don't change), so it never stomps an in-progress pick.
	$effect(() => {
		// Deliberate: reads transactionId to register it as a reactive dependency of this effect.
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		transactionId;
		categoryValue = resolveProposalCategory(suggestion);
		natureValue = suggestion?.nature ?? '';
	});

	// Exposed for TransactionFocusOverlay's keyboard shortcuts (Enter/R): the current
	// selection (possibly edited by the user) lives in this component, not the caller,
	// so triggering must go through here rather than the onAccepted/onCreateRule props directly.
	export function submitAccept() {
		formEl?.requestSubmit();
	}

	export function triggerCreateRule() {
		onCreateRule(categoryValue, natureValue || null);
	}

	// Explicit "Automatic" rather than a visually empty Select when no rule suggested
	// a nature — same option as the "Manual nature" form in the detail panel.
	const natureSelectOptions = $derived([
		{ value: '', label: m.transactions_automatic() },
		...natureOptions.map((n) => ({ value: n, label: formatNatureLabel(n) }))
	]);
</script>

{#if variant === 'compact'}
	<div class="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4">
		<div class="flex items-center gap-2">
			<svg
				class="h-3.5 w-3.5 shrink-0 text-zinc-500"
				viewBox="0 0 20 20"
				fill="none"
				aria-hidden="true"
			>
				<path
					d="M10 2.5 11.4 7.4 16.5 8.2 12.8 11.6 13.7 16.7 10 14.2 6.3 16.7 7.2 11.6 3.5 8.2 8.6 7.4 10 2.5Z"
					stroke="currentColor"
					stroke-width="1.3"
					stroke-linejoin="round"
				/>
			</svg>
			<span class="text-[12.5px] font-bold text-zinc-900">{m.transactions_proposal_heading()}</span>
		</div>
		<div class="grid grid-cols-2 gap-2">
			<Combobox
				value={categoryValue}
				options={categoryOptions.map((c) => ({ value: c, label: categoryDisplayName(c) }))}
				ariaLabel={m.budgets_field_category()}
				onValueChange={(v) => {
					categoryValue = v;
				}}
			/>
			<Select
				value={natureValue}
				options={natureSelectOptions}
				ariaLabel={m.categories_table_nature()}
				onValueChange={(v) => {
					natureValue = v;
				}}
			/>
		</div>
		<form
			bind:this={formEl}
			method="POST"
			action="?/acceptSuggestion"
			use:enhance={() => {
				acceptSubmitting = true;
				// await update() BEFORE onAccepted(): onAccepted may itself trigger a goto()
				// (focus mode advancing to the next transaction). Calling it first — before
				// update()'s own invalidateAll — raced the two navigations and update() won,
				// silently reverting the goto() back to the just-accepted transaction.
				return async ({ result, update }) => {
					await update({ reset: false });
					acceptSubmitting = false;
					if (result.type === 'success') onAccepted(transactionId);
				};
			}}
		>
			<input type="hidden" name="transactionId" value={transactionId} />
			<input type="hidden" name="category" value={categoryValue} />
			<input type="hidden" name="nature" value={natureValue} />
			<Button
				type="submit"
				variant="primary"
				size="sm"
				loading={acceptSubmitting}
				class="!flex min-h-[44px] w-full items-center justify-center !rounded-[11px]"
			>
				{m.transactions_accept()}
			</Button>
		</form>
		<div class="flex items-center gap-2">
			<Button
				variant="ghost"
				size="sm"
				class="!flex min-h-[44px] flex-1 items-center justify-center px-2"
				onclick={() => onIgnore(transactionId)}
			>
				{m.transactions_ignore()}
			</Button>
			<Button
				variant="secondary"
				size="sm"
				class="!flex min-h-[44px] flex-1 items-center justify-center !rounded-[11px]"
				onclick={() => onCreateRule(categoryValue, natureValue || null)}
			>
				{m.transactions_create_rule()}
			</Button>
		</div>
		{#if acceptError}
			<p class="text-xs text-rose-600">{acceptError}</p>
		{/if}
	</div>
{:else}
	<div class="border-b border-zinc-100 bg-zinc-50 px-4 py-3.5">
		<p class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
			{m.transactions_proposal_heading()}
		</p>
		<div class="mt-2 flex flex-wrap items-center gap-2">
			<Combobox
				value={categoryValue}
				options={categoryOptions.map((c) => ({ value: c, label: categoryDisplayName(c) }))}
				ariaLabel={m.budgets_field_category()}
				class="w-44"
				onValueChange={(v) => {
					categoryValue = v;
				}}
			/>
			<Select
				value={natureValue}
				options={natureSelectOptions}
				ariaLabel={m.categories_table_nature()}
				class="w-36"
				onValueChange={(v) => {
					natureValue = v;
				}}
			/>
			<span
				class="h-2 w-2 shrink-0 rounded-full {getCategoryColor(categoryValue)}"
				aria-hidden="true"
			></span>
		</div>
		<div class="mt-3 flex items-center gap-1.5">
			<form
				bind:this={formEl}
				method="POST"
				action="?/acceptSuggestion"
				class="contents"
				use:enhance={() => {
					acceptSubmitting = true;
					// await update() BEFORE onAccepted(): onAccepted may itself trigger a goto()
					// (focus mode advancing to the next transaction). Calling it first — before
					// update()'s own invalidateAll — raced the two navigations and update() won,
					// silently reverting the goto() back to the just-accepted transaction.
					return async ({ result, update }) => {
						await update({ reset: false });
						acceptSubmitting = false;
						if (result.type === 'success') onAccepted(transactionId);
					};
				}}
			>
				<input type="hidden" name="transactionId" value={transactionId} />
				<input type="hidden" name="category" value={categoryValue} />
				<input type="hidden" name="nature" value={natureValue} />
				<Button type="submit" variant="primary" size="sm" loading={acceptSubmitting}
					>{m.transactions_accept()}</Button
				>
			</form>
			<Button
				variant="secondary"
				size="sm"
				onclick={() => onCreateRule(categoryValue, natureValue || null)}
			>
				{m.transactions_create_rule()}
			</Button>
			<Button variant="ghost" size="sm" onclick={() => onIgnore(transactionId)}>
				{m.transactions_ignore()}
			</Button>
		</div>
		{#if acceptError}
			<p class="mt-2 text-xs text-rose-600">{acceptError}</p>
		{/if}
	</div>
{/if}
