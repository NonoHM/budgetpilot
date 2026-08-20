<script lang="ts">
	import { Combobox } from 'bits-ui';
	import * as m from '$lib/paraglide/messages';

	type Option = { value: string; label: string };

	let {
		options,
		value = $bindable(),
		name,
		placeholder = m.common_select_placeholder(),
		ariaLabel,
		disabled = false,
		softDisabled = false,
		'aria-describedby': ariaDescribedby,
		required = false,
		size = 'md',
		class: className = 'w-full',
		triggerClass = '',
		onValueChange
	}: {
		options: Option[];
		value?: string;
		name?: string;
		placeholder?: string;
		ariaLabel?: string;
		disabled?: boolean;
		/**
		 * Neutralised but still reachable — `aria-disabled`, never the native `disabled`. Design 1q
		 * makes this law for EVERY neutralised control in the app: a control that is switched off
		 * must still be focusable so it can state its own reason, carried by `aria-describedby`.
		 * Mirrors `Button` and `IconButton`'s prop of the same name.
		 *
		 * The immediate caller is design 1j's parent category selector, which « se neutralise sur
		 * place » on a répartie transaction. Its `disabled` sibling would have been mute, and
		 * CLAUDE.md already records four sightings of that shape.
		 *
		 * A SEPARATE branch below rather than attributes bolted onto the live one, deliberately. The
		 * live path's markup is then untouched by construction — the only way to be sure a fourteen
		 * call-site component did not move — and no combination of bits-ui state can leave a locked
		 * field with an openable list, because there is no bits-ui in the locked branch at all.
		 *
		 * The corollary, from 1q: a control whose neutralisation cannot be explained is not
		 * neutralised, it is removed. So `softDisabled` without an `aria-describedby` is a
		 * half-applied rule.
		 */
		softDisabled?: boolean;
		'aria-describedby'?: string;
		/**
		 * Announces the field as required (`aria-required` on the visible input). It deliberately does
		 * NOT install a native `required` constraint, and that is a fix rather than a shortcut.
		 *
		 * Forwarded to `Combobox.Root`, `required` lands on bits-ui's hidden mirror input — which
		 * carries `srOnlyStyles` (`transform: translateX(-100%)`, 1x1px, clipped), `aria-hidden="true"`
		 * and `tabindex="-1"`. Chrome finds that input invalid, cannot focus it to report the problem,
		 * and ABORTS THE SUBMIT: no message on screen, nothing in the accessibility tree, only
		 * `An invalid form control with name='...' is not focusable` on a console no user reads. The
		 * button simply does nothing. Measured on the manual-add modal (the app's only hand-entry
		 * path), the new-budget dialog and the linked savings-goal form.
		 *
		 * The refusal belongs to the server, which already owns it: every action behind these forms
		 * returns `fail(400)` with a localised message and every call site renders it. The defect was
		 * that the server was never asked.
		 *
		 * Not solvable by moving `required` onto the visible `Combobox.Input` either: that input holds
		 * the SEARCH TEXT, not the selected value. It is cleared on open while a value is still
		 * selected (see the `$effect` below), and it is non-empty after typing a search that matched
		 * nothing — so it would refuse a valid field and accept an empty one, in that order.
		 */
		required?: boolean;
		/**
		 * Field height. `'md'` is 44px, the app-wide touch-target floor and every existing caller's
		 * behaviour. `'lg'` is 48px, which design 1k requires of every control inside the mobile
		 * sheet — « tous les contrôles passent à 48 px, le plancher de 44 l'emporte sans exception
		 * d'écran ».
		 *
		 * A prop rather than `triggerClass="h-12"`, deliberately: `triggerClass` is APPENDED to a
		 * class string that already contains `h-11`, so which one wins is decided by Tailwind's
		 * generated source order rather than by anything written here. That is precisely the kind of
		 * silent, load-bearing coincidence this repo's notes say not to build on — it would break by
		 * changing height rather than by failing.
		 */
		size?: 'md' | 'lg';
		class?: string;
		triggerClass?: string;
		onValueChange?: (value: string) => void;
	} = $props();

	// The one class string both branches render, so the locked field cannot drift a pixel from the
	// live one. 1j puts the selector in situ precisely so nothing moves at the moment of removal; a
	// second hand-copied class list is how that promise would be lost later, silently.
	const fieldClass = $derived(
		`${size === 'lg' ? 'h-12' : 'h-11'} w-full rounded-xl border border-zinc-200 bg-white pr-8 pl-3 text-sm text-zinc-900 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${triggerClass}`
	);

	let open = $state(false);
	// Controls the input's displayed text programmatically.
	// Updated by oninput (user typing) and by $effect on open/close.
	let inputValue = $state('');
	// Tracks the user's current search string for local filtering.
	let searchTerm = $state('');

	const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? '');

	const filteredOptions = $derived(
		searchTerm.trim() === ''
			? options
			: options.filter((o) => o.label.toLowerCase().includes(searchTerm.toLowerCase()))
	);

	// When the dropdown opens: clear input and search for a fresh start.
	// When it closes: restore the selected label (or empty string).
	$effect(() => {
		if (open) {
			inputValue = '';
			searchTerm = '';
		} else {
			inputValue = selectedLabel;
			searchTerm = '';
		}
	});
</script>

{#if softDisabled}
	<!--
		The neutralised field, 1j. Focusable, named, showing what is selected, and unopenable.

		It is a READONLY TEXTBOX and deliberately not a `role="combobox"`, which was the first
		version. A combobox role promises a popup: `aria-expanded="false"` announces "collapsed",
		which invites Alt+Down, and nothing answers. Svelte's own a11y check says the same thing from
		the other end — it demands an `aria-controls`, and the only way to satisfy it here would be to
		point at an id that does not exist. There is no list while this is locked, so the honest
		exposure is a read-only field carrying the chosen category.

		`readonly` rather than `disabled`: the field stays in the tab order and keeps its accessible
		name, which is the whole point of `aria-disabled`. The chevron is drawn but is not a button —
		1q's corollary read forward, since a trigger that could be pressed and did nothing would be a
		control with no reason to state.
	-->
	<div class="relative {className}">
		<input
			type="text"
			readonly
			aria-disabled="true"
			aria-describedby={ariaDescribedby}
			aria-label={ariaLabel ?? placeholder}
			{placeholder}
			value={selectedLabel}
			class="{fieldClass} cursor-default"
		/>
		<span
			class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-zinc-300"
			aria-hidden="true"
		>
			<svg class="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="none">
				<path
					d="M5.5 7.5 10 12l4.5-4.5"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</span>
	</div>
{:else}
	<Combobox.Root
		type="single"
		{name}
		{disabled}
		{value}
		bind:open
		{inputValue}
		onValueChange={(v) => {
			value = v;
			onValueChange?.(v);
		}}
	>
		<div class="relative {className}">
			<Combobox.Input
				class={fieldClass}
				aria-describedby={ariaDescribedby}
				aria-label={ariaLabel ?? placeholder}
				aria-required={required ? 'true' : undefined}
				placeholder={open ? m.common_combobox_search_placeholder() : placeholder}
				oninput={(e) => {
					inputValue = e.currentTarget.value;
					searchTerm = e.currentTarget.value;
				}}
			/>
			<Combobox.Trigger
				class="absolute inset-y-0 right-0 flex items-center rounded-r-xl px-2 text-zinc-400 hover:text-zinc-600 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none disabled:pointer-events-none"
				aria-label={m.common_combobox_open_list_aria()}
			>
				<svg class="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden="true">
					<path
						d="M5.5 7.5 10 12l4.5-4.5"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</Combobox.Trigger>
		</div>

		<Combobox.Portal>
			<Combobox.Content
				class="z-50 w-[var(--bits-combobox-anchor-width)] rounded-xl border border-zinc-200 bg-white shadow-sm"
				sideOffset={4}
			>
				<Combobox.Viewport class="max-h-60 overflow-y-auto p-1">
					{#if filteredOptions.length === 0}
						<p class="px-3 py-2 text-sm text-zinc-400" role="status">
							{m.common_combobox_no_results()}
						</p>
					{:else}
						{#each filteredOptions as option (option.value)}
							<Combobox.Item
								value={option.value}
								label={option.label}
								class="relative flex cursor-pointer items-center justify-between rounded px-3 py-1.5 text-sm text-zinc-700 outline-none select-none data-[highlighted]:bg-zinc-100 data-[highlighted]:text-zinc-900 data-[selected]:font-medium data-[selected]:text-zinc-900"
							>
								{#snippet children({ selected })}
									{option.label}
									{#if selected}
										<svg
											class="h-3.5 w-3.5 shrink-0 text-zinc-500"
											viewBox="0 0 16 16"
											fill="none"
											aria-hidden="true"
										>
											<path
												d="M2.5 8 6.5 12 13.5 4"
												stroke="currentColor"
												stroke-width="1.6"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									{/if}
								{/snippet}
							</Combobox.Item>
						{/each}
					{/if}
				</Combobox.Viewport>
			</Combobox.Content>
		</Combobox.Portal>
	</Combobox.Root>
{/if}
