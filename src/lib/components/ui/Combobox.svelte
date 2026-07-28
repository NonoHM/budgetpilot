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
		required = false,
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
		required?: boolean;
		class?: string;
		triggerClass?: string;
		onValueChange?: (value: string) => void;
	} = $props();

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

<Combobox.Root
	type="single"
	{name}
	{disabled}
	{required}
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
			class="h-11 w-full rounded-xl border border-zinc-200 bg-white pr-8 pl-3 text-sm text-zinc-900 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 {triggerClass}"
			aria-label={ariaLabel ?? placeholder}
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
