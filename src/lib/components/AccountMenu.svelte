<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import Avatar from './Avatar.svelte';
	import Menu from './ui/DropdownMenu.svelte';
	import { getEmailInitials } from '$lib/domain/initials';

	let { email, isAdmin }: { email: string; isAdmin: boolean } = $props();

	let open = $state(false);
	const initials = $derived(getEmailInitials(email));
</script>

<Menu
	bind:open
	triggerAriaLabel={m.account_menu_trigger_aria()}
	triggerClass="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
	contentClass="w-64"
>
	{#snippet trigger()}
		<Avatar
			{initials}
			size={36}
			class={open ? 'bg-zinc-300 text-zinc-700 ring-2 ring-zinc-900/10' : 'hover:bg-zinc-300'}
		/>
	{/snippet}
	<!-- kept as an explicit named snippet (not inlined) alongside `trigger`: verified during the
	lint cleanup that inlining it doesn't change test outcomes (same pre-existing Bits UI
	hydration-race flake either way), but the explicit form is left untouched here since this is
	auth-adjacent UI -->
	<!-- eslint-disable-next-line svelte/no-useless-children-snippet -->
	{#snippet children()}
		<div class="border-b border-zinc-100 px-4 py-3">
			<div class="truncate text-sm text-zinc-500">{email}</div>
		</div>
		<div class="py-1.5">
			<DropdownMenu.Item>
				{#snippet child({ props })}
					<a
						{...props}
						class="block px-4 py-2 text-sm text-zinc-700 outline-none data-[highlighted]:bg-zinc-50"
						href={resolve('/settings')}
					>
						{m.account_menu_settings()}
					</a>
				{/snippet}
			</DropdownMenu.Item>
			{#if isAdmin}
				<DropdownMenu.Item>
					{#snippet child({ props })}
						<a
							{...props}
							class="block px-4 py-2 text-sm text-zinc-700 outline-none data-[highlighted]:bg-zinc-50"
							href={resolve('/admin')}
						>
							{m.account_menu_admin()}
						</a>
					{/snippet}
				</DropdownMenu.Item>
			{/if}
		</div>
		<div class="border-t border-zinc-100 py-1.5">
			<DropdownMenu.Item closeOnSelect={false}>
				{#snippet child({ props })}
					<form method="POST" action="/logout">
						<button
							{...props}
							type="submit"
							class="block w-full px-4 py-2 text-left text-sm font-medium text-rose-600 outline-none data-[highlighted]:bg-rose-50"
						>
							{m.account_menu_logout()}
						</button>
					</form>
				{/snippet}
			</DropdownMenu.Item>
		</div>
	{/snippet}
</Menu>
