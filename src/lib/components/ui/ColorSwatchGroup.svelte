<script lang="ts">
	/**
	 * A radiogroup of colour swatches that submits its choice as a form field.
	 *
	 * Extracted from the tag settings section rather than invented: that section had `role="radio"`
	 * on nine bare buttons with no keyboard navigation between them, which is the half of the
	 * radiogroup pattern that is easy to forget and impossible to notice by looking. Anything that
	 * lets a user pick one colour from a fixed palette wants this, and the app already has a second
	 * candidate in CATEGORY_PALETTE.
	 *
	 * NO CLIENT-SIDE COLOUR LOGIC. The caller passes a ready-made Tailwind class per option, because
	 * this project forbids building a class by concatenation (Tailwind's scanner never sees it, and
	 * the CSP forbids the inline-style fallback). This component owns the group's behaviour and
	 * accessibility, never the palette.
	 *
	 * ACTIVATION IS MANUAL, and that is a deliberate departure from the usual radiogroup rule that
	 * an arrow key both moves and selects. Each swatch is a real submit button, so selecting on
	 * arrow would fire one POST per keypress while a user is simply looking through the palette.
	 * Arrows move focus (roving tabindex); Enter or Space commits. ARIA allows manual activation
	 * precisely for the case where selecting is expensive.
	 */
	let {
		name,
		options,
		selected,
		ariaLabel
	}: {
		/** Form field name each swatch submits under. */
		name: string;
		/** `class` is a complete Tailwind class string, never a fragment to be composed. */
		options: ReadonlyArray<{ value: string; label: string; class: string }>;
		selected: string;
		ariaLabel: string;
	} = $props();

	let container: HTMLDivElement | undefined = $state();

	/**
	 * The roving tabindex: exactly one swatch is reachable by Tab, and it is the selected one.
	 *
	 * Falls back to the first option when `selected` matches nothing, so a value written by an
	 * older release can never leave the whole group unreachable from the keyboard.
	 */
	const activeIndex = $derived(
		Math.max(
			0,
			options.findIndex((o) => o.value === selected)
		)
	);

	function focusAt(index: number) {
		const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
		buttons?.[(index + options.length) % options.length]?.focus();
	}

	function onKeyDown(event: KeyboardEvent, index: number) {
		const step =
			event.key === 'ArrowRight' || event.key === 'ArrowDown'
				? 1
				: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
					? -1
					: 0;

		if (step !== 0) {
			// Wraps, matching the pattern a user gets from a native radio group.
			event.preventDefault();
			focusAt(index + step);
			return;
		}
		if (event.key === 'Home') {
			event.preventDefault();
			focusAt(0);
		} else if (event.key === 'End') {
			event.preventDefault();
			focusAt(options.length - 1);
		}
	}
</script>

<div bind:this={container} class="flex flex-wrap gap-2" role="radiogroup" aria-label={ariaLabel}>
	{#each options as option, index (option.value)}
		<button
			type="submit"
			{name}
			value={option.value}
			role="radio"
			aria-checked={option.value === selected}
			aria-label={option.label}
			tabindex={index === activeIndex ? 0 : -1}
			onkeydown={(event) => onKeyDown(event, index)}
			class="relative h-8 w-8 shrink-0 rounded-full {option.class} before:absolute before:-inset-1.5 before:content-[''] focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none {option.value ===
			selected
				? 'ring-2 ring-zinc-900 ring-offset-2'
				: 'ring-1 ring-zinc-200 ring-offset-1'}"
		></button>
	{/each}
</div>
