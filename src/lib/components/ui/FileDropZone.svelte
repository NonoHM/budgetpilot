<script lang="ts">
	let {
		name,
		accept,
		label,
		required = false,
		chooseLabel,
		noFileLabel,
		desktopInputClass = '',
		files = $bindable<FileList | undefined>(undefined)
	}: {
		name: string;
		accept: string;
		label?: string;
		required?: boolean;
		chooseLabel: string;
		noFileLabel: string;
		desktopInputClass?: string;
		files?: FileList;
	} = $props();

	// Unique per component instance (not derived from `name`): pages that render a parallel
	// desktop/mobile pair of forms reuse the same `name` twice, and duplicate DOM ids would make
	// the mobile label's `for` resolve to the hidden desktop input instead (file silently lost).
	const id = $props.id();
</script>

<div class="grid gap-1">
	{#if label}
		<span class="text-sm font-medium">{label}</span>
	{/if}

	<!-- A single file input (a single `name` submitted): sr-only below lg (triggered by
	     the dashed-styled zone via `for`, stays focusable and validatable — unlike
	     display:none, sr-only doesn't break native required validation), rendered
	     natively from lg up. -->
	<label
		for={id}
		class="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/50 px-4 py-6 text-center lg:hidden"
	>
		<span class="flex h-9 w-9 items-center justify-center rounded-lg bg-white ring-1 ring-zinc-200">
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
		<span class="text-sm font-semibold text-zinc-900 underline underline-offset-2">
			{chooseLabel}
		</span>
		<span class="text-xs text-zinc-500">
			{files && files.length > 0 ? files[0].name : noFileLabel}
		</span>
	</label>
	<input
		type="file"
		{name}
		{id}
		{accept}
		{required}
		bind:files
		class="sr-only lg:not-sr-only lg:mt-0 lg:block {desktopInputClass}"
	/>
</div>
