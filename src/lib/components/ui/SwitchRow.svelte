<script lang="ts">
	import { pressable } from '$lib/press';
	import { pressNeutral, pressTransition, transitionHover } from '$lib/styles';
	import Spinner from './Spinner.svelte';

	/**
	 * BRIQUE 6c, registered by Planche 5d: a labelled boolean whose VALUE is read before the press.
	 *
	 * ## Three facts decide it, and none is aesthetic
	 *
	 * One. The control has an immediate effect on the list it sits above: nothing is submitted, and
	 * everything recomputes on the press. Two. Its value is a state of the DATA, not a form field.
	 * Three. It is the control that silently eats the first transaction when it is wrong, so its
	 * value must be legible BEFORE the press and never deduced after.
	 *
	 * ## Why none of the existing bricks is this one
	 *
	 * NOT `CheckboxField` (6b). A checkbox is a value collected and validated later with the rest of
	 * the form, which is exactly its use in Planche 5c's footer. Fusing the two would licence
	 * immediate-effect checkboxes across the product, and the distinction that protects 5c would
	 * disappear.
	 *
	 * NOT a toggle button with `aria-pressed` (brique 1's toggle role). A toggle says « I performed an
	 * action »; a switch says « here is the state ». Fact three asks for legibility before the press,
	 * which is the definition of a switch. Brique 1 is also text-free by its own accessibility clause,
	 * and this control carries words.
	 *
	 * NOT `Switch.svelte`, and the reason is structural rather than ergonomic, because it will be
	 * proposed again. That component is the knob alone: 44x24 with a 16 px thumb, named by an
	 * `ariaLabel`, and its target is the knob. Here the target is the whole 48 px row, so the row is
	 * the `<button role="switch">` and A BUTTON CANNOT CONTAIN A BUTTON. There is no composition that
	 * puts `Switch.svelte` inside this row and leaves either of them valid. Its three callers
	 * (`/settings`, `/net-worth`, `/rules`) keep it unchanged.
	 *
	 * ## The label carries no verb, and that is the repair
	 *
	 * « La première ligne contient des données » is a sentence true or false according to a state it
	 * does not show: the reader sees an action and gets a value. 6c separates them, so the label
	 * names the subject (« Première ligne ») and the value is written in words beside it
	 * (« en-têtes » / « données »). The consequence goes underneath, linked by `aria-describedby`
	 * rather than folded into the name: heard after the name, never instead of it.
	 *
	 * Announced as « Première ligne, en-têtes, interrupteur, activé », and the explicit `aria-label`
	 * is what produces exactly that. Without it a `<button>` takes its name from its CONTENTS, so the
	 * consequence sentence rendered inside the row became part of the name: the reader would hear the
	 * whole explanation before the role and the state, which is the « second nom » the plate forbids.
	 * Caught by the spec asserting the name does not contain the consequence.
	 */
	let {
		label,
		valueLabel,
		checked,
		onChange,
		consequence,
		lockedReason,
		busyLabel,
		class: extraClass = ''
	}: {
		label: string;
		/** `[off, on]`, in words. The value the user reads before deciding, never a glyph. */
		valueLabel: [string, string];
		checked: boolean;
		/** The NEXT value, so a caller never has to remember which way the control was going. */
		onChange: (next: boolean) => void;
		/** What the current value means for the import, written rather than guessed. */
		consequence: string;
		/**
		 * Renders the row inert AND states the reason, never one without the other.
		 *
		 * `aria-disabled` and not the native attribute: a control switched off has to stay reachable
		 * so it can say why, and a natively disabled button leaves the tab order and announces
		 * nothing. Same rule as `IconButton`'s `softDisabled` and `Button`'s.
		 */
		lockedReason?: string;
		/**
		 * The conditional in-flight state of Planche 5f, and it is NOT a state in its own right.
		 *
		 * A header re-read is local, so there is normally no interval during which the application
		 * does not know. Past 5000 rows it can exceed 300 ms, and only then does this word replace the
		 * value. It replaces the VALUE rather than sitting beside it, so the row never reads as though
		 * it had two states at once.
		 */
		busyLabel?: string;
		class?: string;
	} = $props();

	const locked = $derived(lockedReason !== undefined);
	const uid = crypto.randomUUID().slice(0, 8);
	const consequenceId = `switchrow-consequence-${uid}`;
	const shownValue = $derived(busyLabel ?? (checked ? valueLabel[1] : valueLabel[0]));
	const shownConsequence = $derived(lockedReason ?? consequence);

	function toggle() {
		if (locked || busyLabel !== undefined) return;
		onChange(!checked);
	}

	function onKeydown(event: KeyboardEvent) {
		// A switch accepts BOTH keys. A native <button> already answers Enter and Space with a click,
		// but only for real key events from a keyboard; the explicit handler is what makes Space work
		// identically under a synthetic event and what documents the requirement where it is read.
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		toggle();
	}
</script>

<!--
	The whole row is the control, so the pressed state is on the row (Planche 5a: the row presses, not
	the box). The knob is drawn from spans rather than composed from `Switch.svelte`, because a button
	cannot contain a button and the target here is the row.
-->
<button
	type="button"
	role="switch"
	use:pressable
	aria-label={`${label}, ${shownValue}`}
	aria-checked={checked}
	aria-disabled={locked ? 'true' : undefined}
	aria-busy={busyLabel !== undefined ? 'true' : undefined}
	aria-describedby={consequenceId}
	onclick={toggle}
	onkeydown={onKeydown}
	class="flex w-full flex-col gap-1.5 rounded-xl border border-zinc-200 bg-white px-3.5 py-3 text-left {transitionHover} {pressTransition} {pressNeutral} focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:outline-none {locked
		? 'cursor-default opacity-45'
		: 'cursor-pointer'} {extraClass}"
>
	<span class="flex h-12 items-center gap-3">
		<span class="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-zinc-900">{label}</span>
		<span
			class="flex items-center gap-[7px] text-[13px] font-semibold {checked
				? 'text-zinc-900'
				: 'text-zinc-700'}"
		>
			{#if busyLabel !== undefined}
				<Spinner size={14} />
			{/if}
			{shownValue}
		</span>
		<!--
			The knob, 44x26 with a 20 px thumb, from the plate. Decorative: the value is already in
			words to its left, so nothing here is the sole carrier of the state and a monochrome screen
			loses nothing.
		-->
		<span
			aria-hidden="true"
			class="flex h-[26px] w-11 shrink-0 items-center rounded-full {transitionHover} {checked
				? 'justify-end bg-zinc-900 p-[3px]'
				: 'justify-start border-[1.5px] border-zinc-400 bg-white p-[2px]'}"
		>
			<span class="rounded-full {checked ? 'h-5 w-5 bg-white' : 'h-[19px] w-[19px] bg-zinc-400'}"
			></span>
		</span>
	</span>
	<span
		id={consequenceId}
		class="block text-[11.5px] leading-[1.5] {locked ? 'text-zinc-700' : 'text-zinc-500'}"
	>
		{shownConsequence}
	</span>
</button>
