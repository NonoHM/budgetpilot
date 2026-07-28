<script lang="ts">
	let {
		checked = false,
		onchange,
		ariaLabel,
		disabled = false
	}: {
		checked?: boolean;
		onchange?: (checked: boolean) => void;
		ariaLabel: string;
		disabled?: boolean;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={ariaLabel}
	{disabled}
	onclick={() => onchange?.(!checked)}
	class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 {checked
		? 'bg-zinc-900'
		: 'bg-zinc-200'}"
>
	<span
		class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform {checked
			? 'translate-x-6'
			: 'translate-x-1'}"
	></span>
</button>
