<script lang="ts">
	// Sizes per the component referential (brick 13): 24 dense, 32 list rows,
	// 36 navbar (default), 56 profile.
	const SIZE_CLASSES = {
		24: 'h-6 w-6 text-[10px]',
		32: 'h-8 w-8 text-xs',
		36: 'h-9 w-9 text-[13px]',
		56: 'h-14 w-14 text-lg'
	} as const;

	let {
		initials,
		size = 36,
		class: className = ''
	}: { initials: string; size?: 24 | 32 | 36 | 56; class?: string } = $props();
</script>

<div
	class="flex shrink-0 items-center justify-center rounded-full bg-zinc-200 font-semibold text-zinc-600 {SIZE_CLASSES[
		size
	]} {className}"
	aria-hidden="true"
>
	{initials}
</div>
