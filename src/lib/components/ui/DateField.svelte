<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { inputBase } from '$lib/styles';
	import { isoToDisplay, displayToIso, toIsoOrNull } from '$lib/domain/dateField';

	/**
	 * One date, written in the app's own grammar, inside an ordinary form.
	 *
	 * ## Why this is not `type="date"`
	 *
	 * A native date input renders jj/mm/aaaa or mm/dd/yyyy depending on the BROWSER's own locale and
	 * ignores every `lang` attribute this app sets. The same build showed two different formats on
	 * two machines, and a reader cannot tell from the box whether 01/08/2026 is the first of August
	 * or the eighth of January. `ui/PeriodFilter.svelte` already refused it for that reason and had
	 * carried the fix privately since; this component is that fix made reachable.
	 *
	 * ## The two elements, and why there are two
	 *
	 * What the reader edits is TEXT. What the form submits is a hidden ISO value under `name`. The
	 * split is what lets a screen keep its existing `method="GET"` form and its existing server-side
	 * parsing and still lose the picker: nothing on either side of the request had to learn a new
	 * format. A single text input named `from` would have sent "01/08/2026" to a parser expecting
	 * "2026-08-01".
	 *
	 * ## What it deliberately does not do
	 *
	 * It offers no calendar. `PeriodFilter` pairs its two fields with a `RangeCalendar` because a
	 * range is chosen by comparing two dates against a month; a single field in a filter row is
	 * typed, and a grid there would be a popover competing with the form's own submit. The cost is
	 * real and is stated rather than hidden: the native control offered a click-to-pick affordance
	 * that this does not. The placeholder carries the expected order in its place, which is the same
	 * mitigation /transactions has shipped since the Période dimension replaced its two native
	 * inputs.
	 */
	interface Props {
		/** The form field name. The hidden ISO input carries it; the visible text box never does. */
		name: string;
		/** The current value, ISO. Empty for an unset field. */
		value?: string;
		/**
		 * The accessible name, for a caller whose design has no visible label. A placeholder is not
		 * a label: it disappears the moment the reader types. Omit it when a real `<label>` is wired
		 * to `id`.
		 */
		ariaLabel?: string;
		/** Wired to a caller's `<label for=...>`. */
		id?: string;
		/** Latest acceptable day, ISO. Advisory only, exactly as the native `max` was. */
		max?: string;
		required?: boolean;
		class?: string;
	}

	let {
		name,
		value = '',
		ariaLabel = undefined,
		id = undefined,
		max = undefined,
		required = false,
		class: className = ''
	}: Props = $props();

	/**
	 * The reader's buffer, seeded from the stored value and thereafter owned by the reader.
	 *
	 * NOT a `$derived` of `value`: re-deriving would rewrite a half-typed date under the cursor
	 * every time anything else on the page changed.
	 *
	 * But not a plain one-time seed either, and that distinction is a real defect rather than a
	 * nicety. Both callers navigate with GET, and SvelteKit re-renders the same component instance
	 * with new props rather than remounting it, so choosing a preset in the period Select beside
	 * this field changes `value` on a live instance. Seeded once, the box would have gone on showing
	 * the previous period's date for ever. Svelte's own `state_referenced_locally` warning is what
	 * surfaced it, before it reached a screen.
	 *
	 * So: follow `value` when the PAGE changes it, and never when it has not moved.
	 */
	// `state_referenced_locally` is suppressed here rather than designed away, and the two lines
	// below are the reason it is safe: reading `value` once is exactly what is wanted for the SEED,
	// and the `$effect` underneath is what makes later changes arrive. The alternatives are worse in
	// ways a test would catch — a `$derived` rewrites a half-typed date under the cursor, and
	// seeding inside the effect paints an empty box on first render before filling it.
	// svelte-ignore state_referenced_locally
	let display = $state(isoToDisplay(value));
	// svelte-ignore state_referenced_locally
	let lastValue = value;
	$effect(() => {
		if (value === lastValue) return;
		lastValue = value;
		display = isoToDisplay(value);
	});

	/**
	 * What the form sends. `toIsoOrNull` rather than `displayToIso`, so a buffer that is not a
	 * complete, REAL date submits nothing: 31/02/2026 matches the shape exactly and is not a day,
	 * and sending it would get the range refused server-side and show the reader an invalid state
	 * for input this field had accepted without a word.
	 */
	const submitted = $derived(toIsoOrNull(display) ?? '');

	const placeholder = `${m.transactions_period_day_placeholder()}/${m.transactions_period_month_placeholder()}/${m.transactions_period_year_placeholder()}`;
</script>

<input type="hidden" {name} value={submitted} />
<input
	{id}
	type="text"
	inputmode="numeric"
	autocomplete="off"
	{required}
	{placeholder}
	aria-label={ariaLabel}
	data-max={max}
	class="{className || inputBase} tabular-nums"
	bind:value={display}
	onblur={() => {
		// Normalising on BLUR rather than on input: rewriting mid-typing moves the caret and makes
		// the field fight the reader. On leaving, "1/8/2026" becomes "01/08/2026" so what stays on
		// screen is what was understood, and an entry that was not understood is left exactly as
		// typed rather than silently replaced by something else.
		const iso = toIsoOrNull(display);
		if (iso) display = isoToDisplay(iso);
		else display = displayToIso(display) === display.trim() ? display.trim() : display;
	}}
/>
