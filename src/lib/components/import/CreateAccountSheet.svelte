<script lang="ts">
	/**
	 * « Nouveau compte », the sheet the panel's footer action opens.
	 *
	 * ## It composes bricks and registers nothing, which is 6g's own instruction
	 *
	 * Brique 15 for the shell, brique 9 for the two actions, brique 8 for the failure, and brique 6's
	 * field-plus-error molecule for the local refusal. 6h's props table adds ONE line about this
	 * surface, `state: 'idle' | 'busy' | 'error'`, and calls the brique « inchangée ». So there is no
	 * new component here and no new tone; there is a form with one field, and every mechanism it
	 * needs already exists somewhere in the referential.
	 *
	 * In particular the in-flight contract is NOT reimplemented. `Button`'s `busyLabel` already
	 * carries all three of 5f's clauses (the verb is visible, `aria-busy` replaces the native
	 * `disabled` so the control keeps its place in the tab order, and the width is frozen at the
	 * resting measurement), and `Modal`'s `busy` already neutralises Escape, the backdrop and the
	 * close control. Writing either again here would give the product two answers to one question.
	 *
	 * ## Two error surfaces, and they are different on purpose
	 *
	 * A name the user can FIX is a field error: it sits under the input, the input carries
	 * `aria-invalid`, and the focus goes back to the field, because the field is the thing to act on.
	 * `aria-invalid` is legal here and was dropped on the account row for the opposite reason: ARIA
	 * 1.2 lists it for a textbox and not for `role=button`.
	 *
	 * A failure the user CANNOT fix is a banner: brique 8 in its danger tone, between the field and
	 * the footer, and it takes the focus. 6g asks for both, and the second half is the one that is
	 * easy to lose: `role="alert"` reads the sentence out and moves nobody, so a keyboard user is
	 * left reading a message whose actions they then have to hunt for. `AlertBanner`'s `focusOnShow`
	 * exists for exactly this case and its own docstring says so.
	 *
	 * ## The failure sentence names what SURVIVED
	 *
	 * « Votre fichier et vos désignations sont conservés ». The user is in the middle of an import
	 * and has just watched something else fail; without that half-sentence the failure of a creation
	 * reads as the loss of the designation work. Same doctrine as 5f's import failure banner.
	 *
	 * ## The local refusal is an affordance and the server is the control
	 *
	 * Refusing a held name before the network saves a round trip and, more importantly, keeps two
	 * homonymous accounts out of the panel built to tell accounts apart. It is not a security
	 * boundary: `createStatementAccount` refuses the same name again, and it is the one that decides.
	 * Both sides fold with `normalizeForMatch`, so the two answers cannot disagree by retyping.
	 */
	import * as m from '$lib/paraglide/messages';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Button from '$lib/components/Button.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { MAX_ACCOUNT_NAME_LENGTH } from '$lib/domain/account';
	import { normalizeForMatch } from '$lib/domain/normalize';
	import { inputBase } from '$lib/styles';

	let {
		open = false,
		prefill = '',
		existingNames = [],
		// RENAMED LOCALLY, and the rename is the whole point of these two lines. A binding called
		// `state` SHADOWS the `$state` rune for the rest of the component, and the failure is not a
		// compile error: every `$state(...)` below throws `store_invalid_shape` at runtime, because
		// Svelte reads the bare identifier as a store. Measured here, on the session that had the trap
		// written down. The PROP keeps 6h's name, so the plate's contract is unchanged; only the local
		// name moves.
		state: phase = 'idle',
		error = null,
		onSubmit,
		onCancel
	}: {
		open?: boolean;
		/**
		 * What the FILE said, already composed by the server. Empty when it said nothing, which is a
		 * recorded deviation from 6g's « jamais vide »: there is nothing to prefill from, and both
		 * alternatives fabricate a name out of something that is not about the user's bank.
		 */
		prefill?: string;
		/** The names this user already holds, for the refusal that happens before the network. */
		existingNames?: readonly string[];
		/** 5f's contract, reused unchanged. The CALLER owns it, because the caller owns the request. */
		state?: 'idle' | 'busy' | 'error';
		/** The server's sentence. Rendered verbatim and never interpolated into anything. */
		error?: string | null;
		onSubmit?: (name: string) => void;
		onCancel?: () => void;
	} = $props();

	const uid = crypto.randomUUID().slice(0, 8);
	const fieldId = `create-account-name-${uid}`;
	const hintId = `create-account-hint-${uid}`;
	const fieldErrorId = `create-account-error-${uid}`;

	// The INITIAL value is the whole point: the prefill is a suggestion the user owns from the
	// moment the sheet opens, exactly as the designation screen owns its resolved account.
	// svelte-ignore state_referenced_locally
	let name = $state(prefill);
	let fieldError = $state<string | null>(null);
	let inputEl = $state<HTMLInputElement | null>(null);

	const busy = $derived(phase === 'busy');

	/**
	 * The hint says what a good name LOOKS LIKE when there is nothing prefilled, and what the name
	 * is FOR when there is.
	 *
	 * Not a requiredness notice either way. A user staring at an empty field in the one cell where
	 * they have the least context needs an example, and « Compte courant » is their own vocabulary
	 * rather than ours. The same reason F chose « Compte » over « Origine ».
	 */
	const hint = $derived(
		prefill ? m.import_account_create_hint() : m.import_account_create_hint_examples()
	);

	const heldKeys = $derived(new Set(existingNames.map((held) => normalizeForMatch(held))));

	/**
	 * The primary NAMES the state it is in, and there are three names for one action.
	 *
	 * « Réessayer » after a failure is 6g's copy and it is not decoration: the button the user is
	 * looking at after a refusal is answering a different question from the one they first pressed.
	 */
	const primaryLabel = $derived(
		phase === 'error' ? m.error_retry() : m.import_account_create_submit()
	);

	function press() {
		if (busy) return;
		const typed = name.trim();
		if (typed.length === 0) {
			// REVEALED at the press rather than prevented by grey. The plate's transverse rule, which
			// this plate applies and does not impose: a disabled control explains nothing and cannot
			// be asked why. 6k's « Champ vidé » mechanics, unchanged.
			refuse(m.import_account_create_error_name_required());
			return;
		}
		if (heldKeys.has(normalizeForMatch(typed))) {
			refuse(m.import_account_create_error_name_taken());
			return;
		}
		fieldError = null;
		onSubmit?.(typed);
	}

	/**
	 * THE CARET GOES IN THE FIELD, and brique 15 cannot do it.
	 *
	 * `Modal` focuses the FIRST focusable inside the dialog, which is its header's close control.
	 * That is right for a dialog that asks a question and wrong for a form with one field: this sheet
	 * was opened deliberately in order to type. Found by SCREENSHOT with every assertion in this
	 * component's spec green, and it is worse at 390, where the compact variant renders that close
	 * control `sr-only`: the focus lands on something nobody can see.
	 *
	 * The prefill is SELECTED rather than left with the caret at one end. A suggestion the user has
	 * to clear by hand costs more than it saves, and `select()` makes the first keystroke replace it
	 * while leaving it fully editable, which is exactly what 6g means by « modifiable, avant un appui
	 * explicite ».
	 *
	 * Runs AFTER brique 15's own focus, not instead of it: both are `$effect`s and this component's
	 * runs when the input exists, which is after the modal has mounted its children.
	 */
	$effect(() => {
		if (!open) return;
		inputEl?.focus();
		inputEl?.select();
	});

	function refuse(sentence: string) {
		fieldError = sentence;
		// Back to the field, because the field is what has to change. The banner takes the focus in
		// the other case for the opposite reason: there is nothing in the form to correct.
		inputEl?.focus();
	}

	function cancel() {
		if (busy) return;
		onCancel?.();
	}
</script>

<Modal
	{open}
	title={m.import_account_new()}
	variant="compact"
	widthClass="lg:max-w-[340px]"
	{busy}
	onClose={cancel}
>
	<!--
		The visible mobile header, which brique 15's `compact` variant deliberately leaves to the
		caller: its own header is sr-only below lg so that exactly one visible title exists at every
		width. `aria-hidden`, because the accessible name is already the modal's.
	-->
	<p class="mb-4 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
		{m.import_account_new()}
	</p>

	<form
		class="space-y-4"
		novalidate
		onsubmit={(event) => {
			// Intercepted rather than posted: the file this creation belongs to lives in memory on the
			// screen that opened this sheet, and a full-page POST would lose it. Kept as a real
			// `<form>` all the same, so Enter in the field presses the primary.
			event.preventDefault();
			press();
		}}
	>
		<div>
			<label class="block text-xs font-medium text-zinc-600" for={fieldId}>
				{m.import_account_create_field()}
			</label>
			<input
				bind:this={inputEl}
				bind:value={name}
				id={fieldId}
				type="text"
				name="name"
				class="mt-1.5 w-full {inputBase} {fieldError ? 'border-rose-300' : ''}"
				maxlength={MAX_ACCOUNT_NAME_LENGTH}
				autocomplete="off"
				aria-invalid={fieldError ? 'true' : undefined}
				aria-describedby={fieldError ? `${fieldErrorId} ${hintId}` : hintId}
				oninput={() => (fieldError = null)}
			/>
			{#if fieldError}
				<!--
					rose-700 and never rose-400: the pair rose-700 on rose-50 was measured at 5.4:1 by
					brique 1 and is the only red this product spends outside irreversible deletion.
				-->
				<p id={fieldErrorId} class="mt-1.5 text-[12.5px] text-rose-700">{fieldError}</p>
			{/if}
			<p id={hintId} class="mt-1.5 text-[12.5px] text-zinc-500">{hint}</p>
		</div>

		{#if phase === 'error' && error}
			<AlertBanner variant="error" size="sm" focusOnShow>{error}</AlertBanner>
		{/if}

		<div class="flex flex-col gap-2">
			<Button
				type="submit"
				variant="primary"
				size="field"
				class="w-full"
				loading={busy}
				busyLabel={m.import_account_create_submitting()}
			>
				{primaryLabel}
			</Button>
			<!--
				`softDisabled` and not `disabled`: an inert Cancel that leaves the tab order sends the
				focus to the body at the moment the user is waiting for an answer where they pressed.
				It stays focusable, keeps its name, and swallows the activation.
			-->
			<Button variant="ghost" size="field" class="w-full" softDisabled={busy} onclick={cancel}>
				{m.common_cancel()}
			</Button>
		</div>
	</form>
</Modal>
