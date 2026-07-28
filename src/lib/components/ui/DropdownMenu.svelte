<script lang="ts">
	import type { Snippet } from 'svelte';
	import { DropdownMenu } from 'bits-ui';

	// Shared shell for the app's two Bits UI DropdownMenu usages (AccountMenu, AppNav's mobile
	// "More" menu): dedupes the repeated Root/Trigger/Portal/Content boilerplate and card styling
	// only. Bits UI already implements the full ARIA menu-button pattern itself (role="menu" on
	// Content, role="menuitem" on Item, aria-haspopup/aria-expanded on the trigger, arrow-key
	// navigation, Escape-closes-without-selecting, focus-returns-to-trigger) — this wrapper does
	// not reimplement any of that, it only avoids repeating the Tailwind class strings.
	//
	// DropdownMenu.Item usage stays owned by each caller via the `children` snippet (rendered
	// in-place, so Bits UI's Root-provided context is still correctly inherited) — item content
	// varies too much between callers (plain links vs. AccountMenu's POST-form logout item) to
	// safely generalize here.
	let {
		open = $bindable(false),
		triggerAriaLabel,
		triggerClass = '',
		trigger,
		children,
		contentClass = '',
		side = 'bottom',
		sideOffset = 8,
		align = 'end'
	}: {
		open?: boolean;
		triggerAriaLabel: string;
		triggerClass?: string;
		trigger: Snippet;
		children: Snippet;
		contentClass?: string;
		side?: 'top' | 'bottom' | 'left' | 'right';
		sideOffset?: number;
		align?: 'start' | 'center' | 'end';
	} = $props();
</script>

<DropdownMenu.Root bind:open>
	<DropdownMenu.Trigger class={triggerClass} aria-label={triggerAriaLabel}>
		{@render trigger()}
	</DropdownMenu.Trigger>

	<DropdownMenu.Portal>
		<DropdownMenu.Content
			class="z-50 origin-[var(--bits-dropdown-menu-content-transform-origin)] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg ring-1 ring-black/5 data-[state=closed]:scale-95 data-[state=closed]:opacity-0 data-[state=closed]:transition-[opacity,transform] data-[state=closed]:duration-[120ms] data-[state=closed]:ease-in data-[state=open]:animate-[bp-popover-in_160ms_ease-out] motion-reduce:animate-none! motion-reduce:data-[state=closed]:transition-none! {contentClass}"
			{side}
			{sideOffset}
			{align}
		>
			{@render children()}
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
