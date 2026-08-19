<script lang="ts">
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';
	import { fade, scale } from 'svelte/transition';
	import * as m from '$lib/paraglide/messages';
	import IconButton from './ui/IconButton.svelte';
	import { MOTION, easeIn, easeOut, motionDuration } from '$lib/motion';
	import { createFocusRestore, focusFirst, trapTabKey } from '$lib/focus';

	let {
		open = false,
		title,
		description,
		variant = 'default',
		hideHeader = false,
		mobileFullscreen = false,
		busy = false,
		onClose,
		children
	}: {
		open?: boolean;
		title: string;
		description?: string;
		// 'compact' is an opt-in used by ConfirmDialog and by transactions' "create rule"
		// modal: below lg it swaps the header (title/description/×) for a
		// visually-hidden-but-accessible one — the caller renders its own visible
		// mobile header in `children` instead — and rounds the panel like the app's
		// cards. Callers that don't pass it are unaffected — default renders exactly
		// as before at all breakpoints.
		variant?: 'default' | 'compact';
		// Keeps Modal's own header sr-only at ALL breakpoints, not just below lg like
		// 'compact' already does. For callers (e.g. TransactionFocusOverlay) whose custom
		// header replaces Modal's on desktop too, not just on mobile — same "one visible
		// header only" fix family as ConfirmDialog's lg:hidden mobile header, just extended
		// to desktop as well since the custom header there isn't mobile-only.
		hideHeader?: boolean;
		// Below lg, the panel takes over the full viewport (no backdrop margin, no rounding)
		// instead of floating as a centered card — for flows like TransactionFocusOverlay
		// that need every pixel on mobile. Desktop is unaffected (still the compact card).
		mobileFullscreen?: boolean;
		/**
		 * A request is in flight, so the dialog OWNS ITS ACTION until the answer (Planche 5f).
		 *
		 * Escape is neutralised, a backdrop click is neutralised, and the close control is inert. A
		 * modal that closes on the press moves the answer out of the screen where the finger just was
		 * and where the focus is: the row is still there, nothing has changed, and it reads exactly
		 * like a press that did nothing. On an irreversible action that is the worst reading there is.
		 *
		 * Measured before this existed, in a real browser: Escape closed a delete mid-flight, and so
		 * did a backdrop click. Nothing was cancelled by either, because the request was already out.
		 * A dismissal that cannot cancel anything and hides the answer is not a dismissal.
		 *
		 * The dialog does not close on the press. It closes on the answer.
		 */
		busy?: boolean;
		onClose: () => void;
		children: Snippet;
	} = $props();

	// crypto.randomUUID() avoids the short-suffix edge case of Math.random().toString(36)
	const uid = crypto.randomUUID().slice(0, 8);
	const titleId = `modal-title-${uid}`;
	const descriptionId = `modal-desc-${uid}`;

	let dialogEl = $state<HTMLElement | null>(null);
	const focusRestore = createFocusRestore();

	// Focus management: save caller focus on open, restore on close.
	// - untrack prevents dialogEl writes from re-triggering this effect (avoids overwriting the saved focus).
	// - The cleanup return handles the {#if}-destroy pattern (budgets page mounts Modal with open={true}
	//   then removes it entirely; the effect body never sees open=false, but cleanup still runs).
	$effect(() => {
		const isOpen = open;
		untrack(() => {
			if (isOpen) {
				focusRestore.save();
				focusFirst(dialogEl);
			} else {
				focusRestore.restore();
			}
		});
		return () => {
			// Runs on every re-execution (open change) and on component destruction.
			// After a normal open→close cycle the else-branch above already restored focus,
			// so this call is a no-op. On {#if}-destroy it is the only path that runs.
			focusRestore.restore();
		};
	});

	// Global Escape handler (catches Escape even if focus somehow leaves the dialog)
	function handleWindowKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			// Swallowed rather than ignored: the press is answered by nothing happening, which is the
			// honest outcome while a request the user cannot recall is still out.
			if (busy) return;
			onClose();
		}
	}

	// Tab trap: cycle focus within the dialog (shared with BottomSheet, see $lib/focus)
	function handleDialogKeydown(event: KeyboardEvent) {
		trapTabKey(event, dialogEl);
	}

	function handleBackdropClick(event: MouseEvent) {
		if (busy) return;
		if (event.target === event.currentTarget) onClose();
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 {mobileFullscreen
			? 'p-0 lg:px-4 lg:py-6'
			: 'px-4 py-6'}"
		role="presentation"
		onclick={handleBackdropClick}
		in:fade={{ duration: motionDuration(MOTION.overlayInMs), easing: easeOut }}
		out:fade={{ duration: motionDuration(MOTION.overlayOutMs), easing: easeIn }}
	>
		<div
			bind:this={dialogEl}
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			aria-describedby={description ? descriptionId : undefined}
			tabindex="-1"
			onkeydown={handleDialogKeydown}
			in:scale={{ duration: motionDuration(MOTION.overlayInMs), start: 0.97, easing: easeOut }}
			out:scale={{ duration: motionDuration(MOTION.overlayOutMs), start: 0.97, easing: easeIn }}
			class={mobileFullscreen
				? 'h-full w-full overflow-y-auto rounded-none border-0 bg-white p-6 shadow-2xl lg:h-auto lg:max-w-lg lg:rounded-md lg:border lg:border-zinc-200 lg:p-5 lg:shadow-xl'
				: variant === 'compact'
					? 'w-full max-w-lg rounded-3xl border-0 bg-white p-6 shadow-2xl lg:rounded-md lg:border lg:border-zinc-200 lg:p-5 lg:shadow-xl'
					: 'w-full max-w-lg rounded-md border border-zinc-200 bg-white p-5 shadow-xl'}
		>
			<div
				class={hideHeader
					? 'sr-only'
					: variant === 'compact'
						? 'sr-only lg:not-sr-only lg:flex lg:items-start lg:justify-between lg:gap-4 lg:border-b lg:border-zinc-200 lg:pb-4'
						: 'flex items-start justify-between gap-4 border-b border-zinc-200 pb-4'}
			>
				<div>
					<h2 id={titleId} class="text-lg font-semibold text-zinc-950">{title}</h2>
					{#if description}
						<p id={descriptionId} class="mt-1 text-sm text-zinc-600">{description}</p>
					{/if}
				</div>

				<!-- -my-2 centers the 44px close button's glyph on the text-lg title
				     line (28px) without inflating the header row. -->
				<IconButton
					class="-my-2"
					label={m.common_modal_close_aria()}
					softDisabled={busy}
					onclick={onClose}
				>
					✕
				</IconButton>
			</div>

			<div class={hideHeader ? '' : variant === 'compact' ? 'lg:mt-4' : 'mt-4'}>
				{@render children()}
			</div>
		</div>
	</div>
{/if}
