<script lang="ts">
	/**
	 * The state of a CONDITION the user is still satisfying, and the single place its reason is
	 * written.
	 *
	 * Introduced by the Repartition plate and reused unchanged by the column-designation screen, so
	 * this is its SECOND consumer and that is exactly what turns it from a local flourish into a
	 * component. The Repartition plate asked for it from one use, which left the usual objection
	 * open; two independent screens needing the same two lines closes it. Implemented as a shared
	 * piece rather than copied into the second screen, which is the instruction the handoff gives.
	 *
	 * ## 64 px, in every state, and the 1 px is inside it
	 *
	 *     1   top hairline
	 *    12   padding-top
	 *    20   line 1     label, and the count
	 *     2   gap
	 *    17   line 2     the consequence
	 *    12   padding-bottom
	 *   ---
	 *    64
	 *
	 * **The hairline is part of the 64. Do not "correct" this to 62.** That subtraction was made
	 * twice in one design document by counting the content and forgetting the border, which is why
	 * the figure is asserted absolutely in the spec and why this comment exists next to it. A border
	 * is inside its box.
	 *
	 * The invariance matters because this banner sits OUTSIDE the scrolling area, between the body
	 * and the action footer. If its height moved between states, the body's 636 px would move with
	 * it, and the promise that nothing on the screen scrolls would hold in some states and not
	 * others. A height that depends on copy is a layout that depends on translation.
	 *
	 * ## The complete-state glyph is BLACK, not green
	 *
	 * This reports the state of a condition, not the result of an action. Green is one of the
	 * product's two tinted surfaces and it is spent on success, meaning something happened. Nothing
	 * has happened here: three columns are designated, which is a fact about the form, and painting
	 * it green would spend a scarce colour on a precondition.
	 *
	 * ## One reason location per disabled control
	 *
	 * The blocked primary is `aria-disabled="true"` (never the `disabled` attribute, which takes it
	 * out of the accessibility tree and out of reach along with its explanation) and its
	 * `aria-describedby` points HERE, at the consequence line, through `consequenceId`. It never
	 * points at a reason line under the button, because there is not one: the cause is a count, the
	 * count is displayed here, so the explanation lives beside the count.
	 *
	 * `consequenceId` is therefore required rather than optional. A dangling `aria-describedby` is
	 * silent and looks identical in the markup to a working one, so the caller must be made to say
	 * the id out loud rather than being allowed to forget it.
	 */
	let {
		label,
		count,
		consequence,
		consequenceId,
		complete = false,
		class: extraClass = ''
	}: {
		/** Line 1, left. What is being counted, in words. */
		label: string;
		/**
		 * Line 1, right. A STRING, not a number: the plate's own states include `0 sur 3` and, during
		 * analysis, a bare placeholder glyph (U+2014, named rather than typed here, per the
		 * depict-never-carry rule). A numeric prop would force the caller to render that glyph some
		 * other way, which is how a second layout appears for one of a component's states.
		 */
		count: string;
		/** Line 2. The consequence of the current state, in one sentence. */
		consequence: string;
		/** DOM id for line 2. The blocked primary's `aria-describedby` target. */
		consequenceId: string;
		complete?: boolean;
		class?: string;
	} = $props();
</script>

<div
	class="border-t border-zinc-200 bg-zinc-50 px-5 py-3 {extraClass}"
	data-testid="condition-banner"
>
	<!-- `items-baseline`: the 14 px label and the 17 px count sit on one line, aligned on the text
	     rather than on the box, which is what keeps line 1 exactly 20 px whatever the count reads. -->
	<div class="flex h-5 items-baseline justify-between gap-3">
		<span class="flex min-w-0 items-center gap-1.5 text-[14px] font-semibold text-zinc-700">
			{#if complete}
				<!-- Black. The state of a condition, never the result of an action. -->
				<svg
					viewBox="0 0 16 16"
					class="h-[13px] w-[13px] shrink-0 text-zinc-900"
					fill="none"
					aria-hidden="true"
				>
					<path
						d="M3.5 8.5 6.5 11.5 12.5 5"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			{/if}
			<span class="truncate">{label}</span>
		</span>
		<span class="shrink-0 text-[17px] font-bold text-zinc-900 tabular-nums">{count}</span>
	</div>
	<p id={consequenceId} class="mt-0.5 h-[17px] text-[12.5px] leading-[17px] text-zinc-500">
		{consequence}
	</p>
</div>
