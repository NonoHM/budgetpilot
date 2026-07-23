<script lang="ts">
	import { Select } from 'bits-ui';
	import * as m from '$lib/paraglide/messages';

	type Option = { value: string; label: string };

	let {
		options,
		value = $bindable(),
		name,
		placeholder = m.common_select_placeholder(),
		ariaLabel,
		disabled = false,
		onValueChange,
		class: triggerClass = ''
	}: {
		options: Option[];
		value?: string;
		name?: string;
		placeholder?: string;
		ariaLabel?: string;
		disabled?: boolean;
		onValueChange?: (value: string) => void;
		class?: string;
	} = $props();

	const selectedLabel = $derived(options.find((o) => o.value === value)?.label ?? placeholder);
</script>

<Select.Root
	type="single"
	{name}
	{disabled}
	{value}
	onValueChange={(v) => {
		value = v;
		onValueChange?.(v);
	}}
>
	<Select.Trigger
		class="inline-flex h-11 w-full items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 {triggerClass}"
		aria-label={ariaLabel ?? placeholder}
	>
		<span class={value ? 'text-zinc-900' : 'text-zinc-400'}>{selectedLabel}</span>
		<svg class="h-4 w-4 shrink-0 text-zinc-400" viewBox="0 0 20 20" fill="none" aria-hidden="true">
			<path
				d="M5.5 7.5 10 12l4.5-4.5"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</Select.Trigger>

	<Select.Portal>
		<Select.Content
			class="z-50 w-[var(--bits-select-anchor-width)] rounded-xl border border-zinc-200 bg-white shadow-sm"
			sideOffset={4}
		>
			<Select.Viewport class="p-1">
				{#each options as option (option.value)}
					<Select.Item
						value={option.value}
						label={option.label}
						class="relative flex cursor-pointer select-none items-center justify-between rounded px-3 py-1.5 text-sm text-zinc-700 outline-none data-[highlighted]:bg-zinc-100 data-[highlighted]:text-zinc-900 data-[selected]:font-medium data-[selected]:text-zinc-900"
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
					</Select.Item>
				{/each}
			</Select.Viewport>
		</Select.Content>
	</Select.Portal>
</Select.Root>
