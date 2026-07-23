<script lang="ts">
	import type { Snippet } from 'svelte';

	// Generic 2-(or-more)-option tab switch (e.g. curve/donut view toggle on
	// /net-worth). Single active option at a time, solid black on the active
	// tab — same "active state" convention used elsewhere (nav, primary
	// button). Keyboard: left/right arrows move focus+selection between tabs
	// (standard tablist pattern); plain Tab still moves focus in/out of the
	// group. No roving-tabindex edge cases beyond that are handled — the only
	// two current usages are a simple 2-option toggle, so anything more
	// elaborate would be premature.
	type Option = { value: string; label: string; ariaLabel?: string };

	let {
		options,
		value = $bindable(),
		onValueChange,
		icon
	}: {
		options: Option[];
		value: string;
		onValueChange?: (value: string) => void;
		icon: Snippet<[Option]>;
	} = $props();

	function select(next: string): void {
		value = next;
		onValueChange?.(next);
	}

	function handleKeydown(event: KeyboardEvent, index: number): void {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		const delta = event.key === 'ArrowRight' ? 1 : -1;
		const nextIndex = (index + delta + options.length) % options.length;
		const nextOption = options[nextIndex];
		select(nextOption.value);
		const currentButton = event.currentTarget as HTMLElement;
		const container = currentButton.closest('[role="tablist"]');
		const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
		buttons?.[nextIndex]?.focus();
	}
</script>

<div
	role="tablist"
	class="flex shrink-0 items-center gap-0.5 rounded-lg border border-zinc-200 p-1"
>
	{#each options as option, index (option.value)}
		<button
			type="button"
			role="tab"
			aria-selected={value === option.value}
			aria-label={option.ariaLabel ?? option.label}
			tabindex={value === option.value ? 0 : -1}
			onclick={() => select(option.value)}
			onkeydown={(event) => handleKeydown(event, index)}
			class="flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1 {value ===
			option.value
				? 'bg-zinc-900 text-white'
				: 'text-zinc-500 hover:bg-zinc-100'}"
		>
			{@render icon(option)}
		</button>
	{/each}
</div>
