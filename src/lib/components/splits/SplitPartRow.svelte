<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import MoneyInput from '$lib/components/ui/MoneyInput.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import { MAX_SPLIT_NOTE_LENGTH } from '$lib/domain/allocation';

	/**
	 * One part, design 1c — TWO lines, not one.
	 *
	 * At 268px of panel content a single row holding category + amount + remove would leave ~90px to
	 * the category selector, which is a permanent ellipsis on labels the user wrote themselves. The
	 * second line is indented 20px under the part number so it reads as a continuation rather than
	 * as another part.
	 *
	 * The number is `aria-hidden`: the position is already in every field's accessible name
	 * (« Montant de la part 1 »), so repeating it would be read twice. It exists so the rounding-cent
	 * mention in 1e can say "part 1" and be found by eye.
	 */
	let {
		position,
		categoryId = $bindable(),
		amount = $bindable(),
		note = $bindable(),
		categoryOptions,
		deletedCategoryName,
		removeSoftDisabled = false,
		removeHintId,
		saving = false,
		savingHintId,
		showRoundingCent = false,
		size = 'md',
		onRemove,
		onAmountInput,
		onAmountBlur
	}: {
		/** 1-based, as spoken. The array index is `position - 1`. */
		position: number;
		categoryId: string;
		amount: string;
		note: string;
		/** Already filtered by the caller — `Combobox` has no exclusion prop, and 1b/OD-5 require the
		 *  « Non catégorisé » sentinel to be absent from the list rather than offered and refused. */
		categoryOptions: Array<{ value: string; label: string }>;
		/**
		 * 1r: the category this part carried was deleted in another window. The lost NAME stays
		 * written, « Cadeaux, supprimée », because it is the only thing that lets the user work out
		 * what to choose instead — and the amount and note are kept, since it is the category that
		 * vanished, not the work.
		 */
		deletedCategoryName?: string;
		/** 1f: at the floor of 2 parts both crosses are neutralised, never removed, never mute. */
		removeSoftDisabled?: boolean;
		/**
		 * 1i's saving state: every control in the row neutralises for the duration of the request,
		 * `aria-disabled` and never `disabled` — « le focus ne s'évapore pas sous les doigts si la
		 * requête traîne ». It OUTRANKS the floor on the cross: both are true at the floor while
		 * saving, and 1q allows exactly one reason, so the row states the one that will change first.
		 */
		saving?: boolean;
		/** Id of the sentence explaining the saving lock. Required whenever `saving` is true. */
		savingHintId?: string;
		/** Id of the sentence explaining the neutralisation. Required whenever the cross is off — 1q:
		 *  a control that cannot be explained is not neutralised, it is removed. */
		removeHintId?: string;
		/** 1e: attached to the part that received the extra cent, and gone the moment any amount is
		 *  edited, because it explains a gesture rather than a permanent state. */
		showRoundingCent?: boolean;
		/** 1k: every control goes to 48px inside the mobile sheet, no screen exception. */
		size?: 'md' | 'lg';
		onRemove: () => void;
		onAmountInput?: () => void;
		onAmountBlur?: () => void;
	} = $props();

	const controlHeight = $derived(size === 'lg' ? 'h-12' : 'h-11');

	let noteOpen = $state(false);

	// 1h: the counter appears only from 60 of 80 characters. « Afficher "80 restants" sur un champ
	// vide, c'est annoncer une limite avant qu'elle existe. »
	const NOTE_COUNTER_FROM = 60;
	const noteRemaining = $derived(MAX_SPLIT_NOTE_LENGTH - note.length);
	const showNoteCounter = $derived(noteOpen && note.length >= NOTE_COUNTER_FROM);
</script>

<div class="grid gap-1.5 border-b border-zinc-100 py-2 last:border-b-0">
	<div class="flex items-start gap-2">
		<span class="w-4 shrink-0 pt-3 text-[12px] text-zinc-400 tabular-nums" aria-hidden="true">
			{position}
		</span>

		<div class="min-w-0 flex-1" data-split-category={position}>
			<!--
				Explicit hidden inputs rather than Combobox's own `name`, and the note's too when the
				field is collapsed. The action reads three PARALLEL lists and their alignment is what
				identifies a part; a row that contributed a category and no note would shift every
				later note by one and file a comment against the wrong money. Rendering all three
				unconditionally makes the lists the same length by construction.
			-->
			<input type="hidden" name="splitCategoryId" value={categoryId} />
			<Combobox
				options={categoryOptions}
				bind:value={categoryId}
				{size}
				softDisabled={saving}
				aria-describedby={saving ? savingHintId : undefined}
				ariaLabel={m.splits_part_category_aria({ position })}
				triggerClass={deletedCategoryName ? 'border-dashed border-zinc-400' : ''}
			/>
			{#if deletedCategoryName}
				<!-- Shape AND text, never colour alone, and no rose: the user did nothing wrong. -->
				<p class="mt-1 text-[11px] text-zinc-500">
					{m.splits_category_deleted({ name: deletedCategoryName })}
				</p>
			{/if}
		</div>

		<!-- `focusout`, not a prop on MoneyInput: blur bubbles as focusout, and 1p allows the
		     sentence immediately on leaving a field because that is a discrete gesture. -->
		<div class="w-[132px] shrink-0" onfocusout={() => onAmountBlur?.()}>
			<MoneyInput
				name="splitAmount"
				label={m.splits_part_amount_aria({ position })}
				labelHidden
				bind:value={amount}
				oninput={() => onAmountInput?.()}
				required={false}
				softDisabled={saving}
				aria-describedby={saving ? savingHintId : undefined}
				inputClass={controlHeight}
				wrapperClass="gap-0"
			/>
			{#if showRoundingCent}
				<p class="mt-1 text-[11px] text-zinc-500">{m.splits_rounding_cent()}</p>
			{/if}
		</div>

		<!-- The wrapper carries the position so 1p's focus management can find this cross without
		     building a selector out of a translated accessible name. -->
		<div data-split-remove={position} class="shrink-0">
			<IconButton
				label={m.splits_part_remove_aria({ position })}
				tone="danger"
				softDisabled={saving || removeSoftDisabled}
				aria-describedby={saving ? savingHintId : removeSoftDisabled ? removeHintId : undefined}
				onclick={onRemove}
				class={size === 'lg' ? 'min-h-12 min-w-12' : ''}
			>
				<svg viewBox="0 0 20 20" class="h-4 w-4" fill="none" aria-hidden="true">
					<path
						d="M6 6l8 8M14 6l-8 8"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
					/>
				</svg>
			</IconButton>
		</div>
	</div>

	<!-- Line 2, indented 20px under the number: a continuation, not another part. 1h's three states
	     cost nothing to the nine users in ten who ignore the note — absent, the button sits in space
	     that is already empty to the right of the amount and the row does not grow by one pixel. -->
	<div class="pl-5">
		{#if noteOpen || note.length > 0}
			<label class="grid gap-0.5">
				<span class="sr-only">{m.splits_part_note_aria({ position })}</span>
				<input
					type="text"
					name="splitNote"
					bind:value={note}
					readonly={saving}
					aria-disabled={saving ? 'true' : undefined}
					aria-describedby={saving ? savingHintId : undefined}
					maxlength={MAX_SPLIT_NOTE_LENGTH}
					onblur={() => (noteOpen = false)}
					onfocus={() => (noteOpen = true)}
					title={note}
					class="{controlHeight} w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-700 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400 focus:outline-none"
				/>
				{#if showNoteCounter}
					<span class="text-[11px] text-zinc-400">
						{m.splits_note_counter({ remaining: noteRemaining })}
					</span>
				{/if}
			</label>
		{:else}
			<input type="hidden" name="splitNote" value={note} />
			<button
				type="button"
				class="text-[12px] text-zinc-500 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none"
				onclick={() => (noteOpen = true)}
			>
				{m.splits_note_add()}
			</button>
		{/if}
	</div>
</div>
