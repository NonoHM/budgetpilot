<script lang="ts" module>
	// Per-instance ids for the message a field points at, so two date boxes in one form never
	// share one `aria-describedby` target. Same idiom as PeriodFilter's own `idCounter`.
	let idCounter = 0;
</script>

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
		/**
		 * Latest acceptable day, ISO. **Carried, not enforced, and that is a gap rather than a
		 * design.**
		 *
		 * The sentence here used to read "advisory only, exactly as the native `max` was", and that
		 * was simply false: `max` on a native `type="date"` is a real constraint that sets
		 * `rangeOverflow` and blocks submission. Nothing reads the `data-max` this renders, so a
		 * caller passing it gets silent no-op enforcement.
		 *
		 * No caller passes it today, which is why it is a gap and not a defect. The five single-date
		 * sites that would (see the tracker) need it working, and that is named there as one of the
		 * things the calendar brick has to bring rather than left to be discovered.
		 */
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

	idCounter += 1;
	const messageId = `date-field-${idCounter}-message`;

	/**
	 * Whether the box should SAY it did not understand.
	 *
	 * On BLUR, not on every keystroke: "0" is not yet a date and flagging it while the reader is
	 * still typing would put a red ring on every field the moment it is touched. This is the
	 * validate-on-blur rule, and `PeriodFilter` reaches the same answer by a different route (its
	 * Apply button is the single point of validation, because it has three ways to choose a range
	 * and this has one).
	 *
	 * An EMPTY field is never invalid. An unset optional date is not an error, and marking it one
	 * would decorate every untouched box on the page.
	 */
	let touched = $state(false);

	/**
	 * Whether the BUFFER cannot be read as a date. Independent of `touched`, and that separation is
	 * the fix for a measured bypass rather than a tidy-up: pressing Enter in a text field is
	 * implicit submission and does not fire `blur`, so a refusal gated on `touched` was simply not
	 * armed on one of the two ways a person submits a form. Measured on /rapports: Enter with
	 * 31/02/2026 in the box submitted `?period=this-month&from=&to=2026-08-31` and rendered a period
	 * the reader had not chosen.
	 *
	 * So the FORM's answer never waits for blur, and only the visible red and the announced sentence
	 * do. Computing both from one flag was what tied them together.
	 */
	const unreadable = $derived(display.trim() !== '' && toIsoOrNull(display) === null);
	const invalid = $derived(touched && unreadable);

	/**
	 * MEASURED, and it is why this state exists at all. Before it, typing 31/02/2026 on /rapports
	 * and pressing « Afficher » came back with NO query string: the page silently showed the
	 * DEFAULT period, with no banner and no message. The reader asked for a period, got another
	 * one, and nothing said so. The native input this component replaces made that unreachable,
	 * because a date widget will not accept an impossible day in the first place.
	 *
	 * `setCustomValidity` rather than a flag the caller has to read: it puts the refusal into the
	 * form's own constraint validation, so the surrounding `method="GET"` form stops submitting
	 * without every caller having to remember to ask. The message is ours, so it is written in the
	 * app's language rather than the browser's.
	 */
	let inputEl = $state<HTMLInputElement | null>(null);
	$effect(() => {
		inputEl?.setCustomValidity(unreadable ? m.date_field_invalid({ format: placeholder }) : '');
	});
</script>

<!--
	The wrapper is load-bearing rather than decorative. The dashboard's period form is
	`flex flex-col gap-2 lg:flex-row lg:items-center` with this component as a DIRECT child, so an
	unwrapped message became a sibling flex ITEM and rendered as a column between the "from" field
	and the arrow, shifting the whole toolbar sideways. Keeping the field and its message in one box
	means no caller's layout can split them.
-->
<div class="flex min-w-0 flex-col">
	<input type="hidden" {name} value={submitted} />
	<input
		{id}
		bind:this={inputEl}
		type="text"
		inputmode="numeric"
		autocomplete="off"
		{required}
		{placeholder}
		aria-label={ariaLabel}
		data-max={max}
		aria-describedby={invalid ? messageId : undefined}
		{...invalid ? { 'aria-invalid': 'true' } : {}}
		class="{className || inputBase} tabular-nums aria-invalid:border-rose-500
		aria-invalid:focus:border-rose-500 aria-invalid:focus:ring-rose-500"
		bind:value={display}
		oninvalid={() => {
			// The browser fires this when constraint validation blocks a submit. That is the moment the
			// reader finds out, so it is the moment the field must show it too, rather than staying
			// quiet because they pressed Enter instead of tabbing away.
			touched = true;
		}}
		onblur={() => {
			touched = true;
			// Normalising on BLUR rather than on input: rewriting mid-typing moves the caret and makes
			// the field fight the reader. On leaving, "1/8/2026" becomes "01/08/2026" so what stays on
			// screen is what was understood, and an entry that was not understood is left exactly as
			// typed rather than silently replaced by something else.
			const iso = toIsoOrNull(display);
			if (iso) display = isoToDisplay(iso);
			else display = displayToIso(display) === display.trim() ? display.trim() : display;
		}}
		oninput={() => {
			// Leaving the invalid state is immediate, entering it waits for blur. A reader correcting a
			// date should see the red go the moment it is right, not one tab press later.
			if (invalid && toIsoOrNull(display) !== null) touched = false;
		}}
	/>
	<!--
		ALWAYS RENDERED, EMPTY WHEN VALID, and that is not a detail. A live region inserted into the
		DOM in the same tick as its text is announced unreliably across screen reader and browser
		pairs, so the region has to be registered before the message arrives.

		`aria-live="polite"` rather than `role="alert"`: this fires on BLUR, by which time focus has
		moved to the next control, and an assertive region would interrupt the announcement of the
		control the reader just landed on. Polite is the register on-blur validation asks for;
		assertive belongs to an error raised at submit.

		`text-rose-700` rather than rose-600: 12px text over the dashboard's zinc-50 ground measures
		4.32:1 at rose-600, under the 4.5:1 floor. rose-700 is 5.80:1 there and 6.06:1 on white.
	-->
	<p id={messageId} aria-live="polite" class="text-xs text-rose-700 {invalid ? 'mt-1' : 'sr-only'}">
		{invalid ? m.date_field_invalid({ format: placeholder }) : ''}
	</p>
</div>
