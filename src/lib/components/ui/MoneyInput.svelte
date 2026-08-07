<script module lang="ts">
	// Module-level counter (not per-instance): guarantees stable, collision-free
	// error-message ids across every MoneyInput rendered on a page, without
	// pulling in a UUID dependency. Mirrors the pattern already used by
	// Tooltip.svelte for its aria-describedby id.
	let idCounter = 0;
</script>

<script lang="ts">
	// Shared euro-amount text field: € suffix, right-aligned tabular-nums,
	// 44px touch target everywhere (not just mobile — see IconButton's
	// min-h-11 convention). Purely presentational + accessibility: parsing
	// (parseManualAmountCents / parseNetWorthBalanceCents / parseBudgetAmountCents)
	// stays server-side, this component never reimplements or duplicates it.
	// No live reformatting on input — the field stays a plain free-text
	// control so it never fights the server-side parser's own tolerance for
	// commas/dots/spaces/thousands separators.
	//
	// `allowZero`/`allowNegative` surface as `data-allow-zero`/`data-allow-negative` for callers'
	// own hinting/tests — not enforced here (the server remains the single source of truth), and
	// deliberately not wired to the HTML `min` attribute: `min` has no effect on `type="text"`
	// inputs, so setting it would be dead markup rather than a real constraint.
	//
	// `value` is bindable and `oninput` fires on every keystroke, added for the split editor's live
	// remainder — and it does NOT weaken the paragraph above. OBSERVING what the user typed is not
	// PARSING it: the raw string is handed back untouched, the field is never rewritten from it, and
	// nothing here decides what "12,5" or "1 234,56" means. That is still the server's job, and a
	// caller computing a preview does so with the same parser rather than a second opinion.
	let {
		name,
		label,
		labelClass = 'text-sm font-medium text-zinc-700',
		labelHidden = false,
		value = $bindable(),
		oninput,
		placeholder = '0,00',
		required = true,
		error,
		allowZero = true,
		allowNegative = false,
		hint,
		wrapperClass = '',
		inputClass = ''
	}: {
		name: string;
		label: string;
		labelClass?: string;
		/**
		 * Hide the label TEXT while keeping the label element, so the field still has an accessible
		 * name. `labelClass="sr-only"` cannot do this: the input sits INSIDE the `<label>`, so hiding
		 * the label hides the control with it. The split editor's rows show no label text — the part
		 * number and the € suffix carry the meaning visually — while each field is still named
		 * « Montant de la part 1 ».
		 */
		labelHidden?: boolean;
		/** Bindable. Reflects the raw text the user typed, never a reformatted version of it. */
		value?: string;
		/** Fires on every keystroke, with the raw string. For a live preview; not for reformatting. */
		oninput?: (raw: string) => void;
		placeholder?: string;
		required?: boolean;
		error?: string;
		allowZero?: boolean;
		allowNegative?: boolean;
		hint?: string;
		wrapperClass?: string;
		inputClass?: string;
	} = $props();

	// Module-level counter deliberately persists across instances; the incremented value is
	// read by the NEXT MoneyInput instance.
	// eslint-disable-next-line no-useless-assignment
	const errorId = `money-input-error-${idCounter++}`;

	const baseInputClass =
		'w-full h-11 rounded-xl border border-zinc-200 bg-white pr-8 text-right text-sm tabular-nums focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400';
</script>

<label class="grid gap-1.5 {labelClass} {wrapperClass}">
	{#if labelHidden}<span class="sr-only">{label}</span>{:else}{label}{/if}
	<div class="relative">
		<input
			type="text"
			{name}
			{placeholder}
			bind:value
			{required}
			inputmode="decimal"
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? errorId : undefined}
			data-allow-zero={allowZero}
			data-allow-negative={allowNegative}
			class="{baseInputClass} {inputClass}"
			oninput={(event) => oninput?.((event.currentTarget as HTMLInputElement).value)}
		/>
		<span
			class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-zinc-400"
			aria-hidden="true"
		>
			€
		</span>
	</div>
	{#if hint}
		<span class="text-xs font-normal text-zinc-400">{hint}</span>
	{/if}
	{#if error}
		<p id={errorId} class="text-sm font-normal text-rose-600">{error}</p>
	{/if}
</label>
