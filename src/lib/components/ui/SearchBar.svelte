<script lang="ts">
	import { inputSearchPill } from '$lib/styles';
	import IconButton from './IconButton.svelte';

	// Shared search field (rules' name filter, transactions' label/regex filter) — same
	// 44px/12px field template as every other input (referential brick 14 as decided:
	// no pill shape, one single field look app-wide).
	// Deliberately a thin wrapper around a real <input> — callers embedding this inside a native
	// <form method="GET"> (transactions, for deep-linking via q/qMode) rely on the DOM being the
	// actual source of truth at submit time, so this component must never intercept submission or
	// drive navigation itself. `value` is `$bindable` so it works both as a two-way bound field
	// (rules' pure client-side filter, `bind:value`) and as an ordinary one-way prop (transactions'
	// uncontrolled `value={data.filters.q}`, where a fresh value from a reload must still win over
	// anything locally typed) — see SearchBar.svelte.spec.ts for both cases proven explicitly.
	//
	// The regex-mode toggle IconButton and any adjacent hidden `qMode` input stay owned by the
	// caller (position/shape differ by breakpoint) — this component only owns the input pill, the
	// error visual state, and the clear button.
	//
	// wrapperClass/inputClass split (mirrors MoneyInput.svelte's own wrapperClass/inputClass):
	// the clear button needs a `position:relative` box exactly the size of the input to overlay
	// against, so the input is wrapped in a div. Sizing/growth classes (w-full, flex-1, h-11) must
	// land on that wrapper (the actual flex item at call sites like transactions' mobile filter
	// row) while visual overrides (border/bg/placeholder color) must land on the input itself, or
	// they'd double up as a mismatched ring around the wrapper. The input always fills its wrapper
	// (baked-in w-full h-full) — with no wrapperClass at all, the wrapper defaults to
	// `inline-block` so it shrink-wraps to the input's own intrinsic default size, exactly like a
	// bare <input> would as a flex item.
	let {
		value = $bindable(''),
		name,
		id,
		placeholder,
		ariaLabel,
		error = false,
		clearLabel,
		wrapperClass = '',
		inputClass = ''
	}: {
		value?: string;
		name?: string;
		id?: string;
		placeholder?: string;
		ariaLabel?: string;
		error?: boolean;
		clearLabel: string;
		wrapperClass?: string;
		inputClass?: string;
	} = $props();

	let inputEl = $state<HTMLInputElement | null>(null);

	function clear() {
		value = '';
		inputEl?.focus();
	}
</script>

<div class="relative inline-block h-11 {wrapperClass}">
	<input
		bind:this={inputEl}
		bind:value
		{id}
		{name}
		type="search"
		{placeholder}
		aria-label={ariaLabel}
		class="{inputSearchPill} !h-full w-full [&::-webkit-search-cancel-button]:appearance-none {error
			? '!border-rose-300 !bg-rose-50'
			: ''} {value ? 'pr-11' : ''} {inputClass}"
	/>
	{#if value}
		<span class="absolute inset-y-0 right-0 flex items-center">
			<IconButton label={clearLabel} onclick={clear}>✕</IconButton>
		</span>
	{/if}
</div>
