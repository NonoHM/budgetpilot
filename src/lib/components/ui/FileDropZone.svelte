<script lang="ts">
	let {
		name,
		accept,
		label,
		required = false,
		chooseLabel,
		noFileLabel,
		files = $bindable<FileList | undefined>(undefined)
	}: {
		name: string;
		accept: string;
		label?: string;
		required?: boolean;
		chooseLabel: string;
		noFileLabel: string;
		files?: FileList;
	} = $props();

	// Unique per component instance (not derived from `name`): pages that render a parallel
	// desktop/mobile pair of forms reuse the same `name` twice, and duplicate DOM ids would make
	// the mobile label's `for` resolve to the hidden desktop input instead (file silently lost).
	const id = $props.id();

	/**
	 * A file is being dragged over the zone.
	 *
	 * Zinc, never a tint. The referential defends a count of exactly two tinted surfaces, rose for
	 * destructive and green for success, and a file hovering over a drop target is neither.
	 */
	let dragging = $state(false);

	/**
	 * THE ZONE ACCEPTS A DROPPED FILE, and that is what makes it a drop zone rather than a picture
	 * of one.
	 *
	 * It used to be `lg:hidden`, so the dashed frame and its glyph existed only below the
	 * breakpoint and desktop fell back to the browser's native file input. Showing the frame at
	 * every width without handling `drop` would have been worse than either: a dashed rectangle is
	 * an invitation to drop, and an invitation the page refuses is a false affordance.
	 *
	 * `dataTransfer.files` is assigned straight to the bound `FileList`, which Svelte writes back
	 * to the input, so the dropped file is posted by the ordinary submit with nothing special at
	 * the call site.
	 *
	 * The `accept` attribute does NOT filter a drop, in any browser, so a dropped file of the wrong
	 * type reaches the server. That is the correct place for it to be refused: ASVS 5.0 V2.2.2 puts
	 * validation at a trusted service layer and treats the client's own check as usability, and
	 * both consumers already refuse an unsupported file server side with a message in the page's
	 * own locale.
	 */
	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const dropped = event.dataTransfer?.files;
		if (dropped && dropped.length > 0) files = dropped;
	}
</script>

<!--
	`gap-2`, 8 px, and it is the same figure every other labelled control on the import form uses.
	It was 4, which bound the label to the zone more tightly than the form's own rhythm and read as
	an uneven gap against the 16 px between fields.
-->
<div class="grid gap-2">
	{#if label}
		<span class="text-sm font-medium">{label}</span>
	{/if}

	<!--
		One zone at every width. The input stays `sr-only` rather than `display:none` because
		sr-only keeps it focusable and keeps native `required` validation working, which
		`display:none` silently disables.

		`ondragover` must call `preventDefault`, and that is not decoration: without it the browser
		keeps its default handling and NAVIGATES AWAY to the dropped file, losing the page and any
		state on it.
	-->
	<!--
		Geometry from the plate's Écran 1 rather than from taste: radius 12, a 1.5 px dashed
		zinc-300 edge, a solid zinc-50 field and 20 px / 16 px of padding. The implementation had
		drifted to radius 16, a 1 px edge and a half-transparent field, which read as a lighter
		component than the one drawn. Radius 12 is also the referential's own figure for a desktop
		control, so one value now serves both widths.
	-->
	<label
		for={id}
		class="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-[1.5px] border-dashed px-4 py-5 text-center {dragging
			? 'border-zinc-900 bg-zinc-100'
			: 'border-zinc-300 bg-zinc-50'}"
		ondragover={(event) => {
			event.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={onDrop}
	>
		<!-- 36 px, radius 10, flat zinc-100. The ringed white tile it replaced was a second surface
		     inside a field that is already a surface. -->
		<span class="flex h-9 w-9 items-center justify-center rounded-[10px] bg-zinc-100">
			<svg
				class="h-4 w-4 text-zinc-500"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M12 16V4M7 9l5-5 5 5" />
				<path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
			</svg>
		</span>
		<!--
			NO PERMANENT UNDERLINE, and the referential is what decides it rather than taste.
			Brique 4 (`TapLink`) is described in its own source as the shared replacement for a
			permanently underlined text link: the affordance is carried by colour and by weight 600,
			and the underline appears only on desktop mouse hover, never on touch where there is no
			hover to reveal it.

			The mobile plate for this screen draws the underline permanently. A component convention
			beats one screen's drawing, because the convention is what keeps every text affordance in
			the product reading the same way, and the plate predates brique 4 rather than arguing
			against it. Recorded rather than silently diverged.
		-->
		<span
			class="text-sm font-semibold text-zinc-900 lg:hover:underline lg:hover:underline-offset-2"
		>
			{chooseLabel}
		</span>
		<!--
			zinc-500 where the plate draws zinc-400, and the deviation is deliberate. This line
			carries the CHOSEN FILE'S NAME once a file exists, which is necessary information, and
			the handoff's own contrast rule reserves zinc-400 for redundant content: raw unreadable
			headers, ignored columns, `(vide)`. zinc-400 measures about 2.3:1 on white and zinc-500
			about 4.6:1, so matching the drawing here would put the one fact the zone reports below
			the readable floor.
		-->
		<span class="text-xs text-zinc-500">
			{files && files.length > 0 ? files[0].name : noFileLabel}
		</span>
	</label>
	<input type="file" {name} {id} {accept} {required} bind:files class="sr-only" />
</div>
