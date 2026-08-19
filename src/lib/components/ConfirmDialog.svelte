<script lang="ts">
	import type { Snippet } from 'svelte';
	import Modal from './Modal.svelte';
	import Button from './Button.svelte';
	import TapLink from './ui/TapLink.svelte';
	import AlertBanner from './AlertBanner.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		open = false,
		title,
		description,
		confirmLabel = m.common_confirm(),
		cancelLabel = m.common_cancel(),
		tone = 'default',
		confirmLoading = false,
		phase = 'idle',
		busyLabel,
		error,
		onConfirm,
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
		/**
		 * The three times of an action that crosses the network (Planche 5f).
		 *
		 * `idle` is every existing caller and is unchanged. `busy` hands the dialog its own lock:
		 * Escape, the backdrop and the close control stop closing it, the confirm shows the action's
		 * verb in the progressive and refuses activation without going natively disabled, and the
		 * dismiss is inert. `error` keeps the dialog mounted and puts the answer where the press was.
		 *
		 * A modal that closes on the press leaves the answer nowhere to be read, and an answer with
		 * nowhere to be read is indistinguishable from a press that did nothing.
		 */
		/**
		 * NAMED `phase` AND NOT `state`, which is what Planche 5g's props table calls it.
		 *
		 * `state` is a reserved name in this codebase: a prop or a const of that name SHADOWS the
		 * `$state` rune, and every `$state(...)` in the component is then parsed as a store
		 * subscription on it. The component dies at runtime with `store_invalid_shape`, which names
		 * neither the prop nor the line that collided. Already recorded as a trap here, for a const;
		 * this is the same trap reached through a prop.
		 */
		phase?: 'idle' | 'busy' | 'error';
		/** The verb in the progressive, e.g. « Suppression… ». Visible, never an sr-only fallback. */
		busyLabel?: string;
		/**
		 * What failed, and what to do about it. Rendered between the body and the actions, announced
		 * by `role="alert"`, and given focus, because it appears where the focus is not.
		 *
		 * `actionLabel` carries the distinction between the two failures, which is the half a sentence
		 * alone cannot make: a server that answered no is retried, and a request that got no answer at
		 * all is not, because retrying an irreversible action blind is the worst advice a banner can
		 * give. There the action refreshes the list instead.
		 */
		error?: { message: string; actionLabel: string; onAction: () => void };
		/**
		 * What the confirm does, when it is not submitting a form.
		 *
		 * The original callers wrap this dialog in a `<form method="POST">` and let the confirm be a
		 * native submit, which is right for a server action. A caller with no form (the designation
		 * screen's replace confirmation, which resolves into an in-page callback) has nothing to
		 * submit, and a `type="submit"` outside a form is a button that does nothing at all.
		 *
		 * Passing this switches the confirm to `type="button"` and calls it. Omitting it leaves every
		 * existing caller on the submit path unchanged.
		 */
		onConfirm?: () => void;
		onClose: () => void;
		children: Snippet;
	} = $props();
</script>

<Modal {open} {title} {description} variant="compact" busy={phase === 'busy'} {onClose}>
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

		{#if phase === 'error' && error}
			<!--
				BETWEEN THE BODY AND THE ACTIONS, and it takes the focus. `role="alert"` announces it to a
				reader; the focus is what puts them AT the thing that changed, and the two are different
				mechanisms that fail separately.

				`AlertBanner` rather than a hand-rolled box: brique 8 makes it the single pattern for
				feedback after an action, and a second rose surface built here would be a seventeenth
				pattern for a job the referential already has a piece for. What it gained for this is
				`focusOnShow`, which is off everywhere else because a page-level banner reporting what
				happened must not steal the focus.

				The page-level banner is still not used HERE: it announces what happened on a screen, and
				nothing happened and the user is not on that screen.
			-->
			<AlertBanner variant="error" focusOnShow autoDismissMs={Infinity}>
				{error.message}
			</AlertBanner>
		{/if}

		<div class="flex gap-2 lg:justify-end lg:gap-3">
			<!-- Cancel is a TapLink, never a second filled/bordered button — the confirm
			     button stays the single primary action of the dialog (referential brick 15). -->
			<TapLink
				class="flex-1 justify-center lg:flex-none"
				onclick={onClose}
				disabled={confirmLoading || phase === 'busy'}>{cancelLabel}</TapLink
			>
			{#if phase === 'error' && error}
				<Button
					type="button"
					variant={tone === 'danger' ? 'danger' : 'primary'}
					class="flex-1 lg:flex-none"
					onclick={error.onAction}>{error.actionLabel}</Button
				>
			{:else}
				<Button
					type={onConfirm ? 'button' : 'submit'}
					variant={tone === 'danger' ? 'danger' : 'primary'}
					class="flex-1 lg:flex-none"
					loading={confirmLoading || phase === 'busy'}
					{busyLabel}
					onclick={onConfirm}>{confirmLabel}</Button
				>
			{/if}
		</div>
	</div>
</Modal>
