<script lang="ts">
	import type { Snippet } from 'svelte';
	import Modal from './Modal.svelte';
	import Button from './Button.svelte';
	import TapLink from './ui/TapLink.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		open = false,
		title,
		description,
		confirmLabel = m.common_confirm(),
		cancelLabel = m.common_cancel(),
		tone = 'default',
		confirmLoading = false,
		onClose,
		children
	}: {
		open?: boolean;
		title: string;
		description?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		tone?: 'default' | 'danger';
		// Wired to the caller's use:enhance submission state so the confirm button shows a
		// spinner instead of freezing with no feedback while the server call is in flight.
		confirmLoading?: boolean;
		onClose: () => void;
		children: Snippet;
	} = $props();
</script>

<Modal {open} {title} {description} variant="compact" {onClose}>
	<!-- flex+gap, not space-y: the mobile header below is lg:hidden (display:none at lg),
	     but Tailwind's space-y-* only excludes siblings carrying the HTML `hidden` attribute,
	     not display:none — it would still add a phantom top margin on desktop. gap correctly
	     skips display:none children. -->
	<div class="flex flex-col gap-5 lg:gap-4">
		<!-- Mobile header: icon + centered title/description (visually replaces
		     Modal's default header, kept sr-only for accessibility). Marked
		     aria-hidden because the dialog's accessible name/description are
		     already carried by Modal's sr-only title (aria-labelledby/aria-describedby)
		     — without this, a screen reader would announce the title twice. -->
		<div class="flex flex-col items-center gap-3 text-center lg:hidden" aria-hidden="true">
			<div
				class="flex h-12 w-12 items-center justify-center rounded-full {tone === 'danger'
					? 'bg-rose-50'
					: 'bg-zinc-100'}"
				aria-hidden="true"
			>
				<svg
					class="h-6 w-6 {tone === 'danger' ? 'text-rose-600' : 'text-zinc-500'}"
					viewBox="0 0 20 20"
					fill="none"
				>
					<circle cx="10" cy="10" r="7.5" stroke="currentColor" stroke-width="1.6" />
					<path d="M10 6v4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
					<circle cx="10" cy="13.6" r="1" fill="currentColor" />
				</svg>
			</div>
			<p class="text-base font-bold text-zinc-950">{title}</p>
			{#if description}
				<p class="text-sm text-zinc-500">{description}</p>
			{/if}
		</div>

		<div class="text-center lg:text-left">
			{@render children()}
		</div>

		<div class="flex gap-2 lg:justify-end lg:gap-3">
			<!-- Cancel is a TapLink, never a second filled/bordered button — the confirm
			     button stays the single primary action of the dialog (referential brick 15). -->
			<TapLink
				class="flex-1 justify-center lg:flex-none"
				onclick={onClose}
				disabled={confirmLoading}>{cancelLabel}</TapLink
			>
			<Button
				type="submit"
				variant={tone === 'danger' ? 'danger' : 'primary'}
				class="flex-1 lg:flex-none"
				loading={confirmLoading}>{confirmLabel}</Button
			>
		</div>
	</div>
</Modal>
