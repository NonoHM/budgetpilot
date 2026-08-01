<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import { resolve } from '$app/paths';
	import Menu from './ui/DropdownMenu.svelte';
	import * as m from '$lib/paraglide/messages';

	let {
		active
	}: {
		active:
			| 'dashboard'
			| 'transactions'
			| 'upcoming-bills'
			| 'reports'
			| 'imports'
			| 'rules'
			| 'budgets'
			| 'net-worth'
			| 'settings';
	} = $props();

	const items = [
		{ key: 'dashboard', label: m.nav_dashboard(), href: '/' },
		{ key: 'transactions', label: m.nav_transactions(), href: '/transactions' },
		{ key: 'budgets', label: m.nav_budgets(), href: '/budgets' },
		{ key: 'upcoming-bills', label: m.nav_upcoming_bills(), href: '/upcoming-bills' },
		{ key: 'reports', label: m.nav_reports(), href: '/reports' },
		{ key: 'rules', label: m.nav_rules(), href: '/rules' },
		{ key: 'imports', label: m.nav_imports(), href: '/imports' },
		{ key: 'net-worth', label: m.nav_net_worth(), href: '/net-worth' }
	] as const;

	// Bottom bar stays at 5 items (4 tabs + "Plus"): "Échéances" lives under "Plus" on mobile.
	const tabItems = [
		{ key: 'dashboard', label: m.nav_dashboard(), href: '/' },
		{ key: 'transactions', label: m.nav_transactions(), href: '/transactions' },
		{ key: 'budgets', label: m.nav_budgets(), href: '/budgets' },
		{ key: 'reports', label: m.nav_reports(), href: '/reports' }
	] as const;

	const moreItems = [
		{ key: 'upcoming-bills', label: m.nav_upcoming_bills(), href: '/upcoming-bills' },
		{ key: 'rules', label: m.nav_rules(), href: '/rules' },
		{ key: 'imports', label: m.nav_imports(), href: '/imports' },
		{ key: 'net-worth', label: m.nav_net_worth(), href: '/net-worth' }
	] as const;

	function isItemActive(key: (typeof items)[number]['key']) {
		return active === key;
	}

	const isMoreActive = $derived(
		active === 'upcoming-bills' ||
			active === 'rules' ||
			active === 'imports' ||
			active === 'net-worth'
	);

	let moreOpen = $state(false);
</script>

{#snippet dashboardIcon(cls: string)}
	<svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
		<path d="M4 11.5 12 4l8 7.5M6 9.5V20h12V9.5" stroke-linecap="round" stroke-linejoin="round" />
	</svg>
{/snippet}

{#snippet transactionsIcon(cls: string)}
	<svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
		<path d="M7 7h11l-3-3M17 17H6l3 3" stroke-linecap="round" stroke-linejoin="round" />
	</svg>
{/snippet}

{#snippet budgetsIcon(cls: string)}
	<svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
		<path
			d="M4 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
		<path d="M15 12h3" stroke-linecap="round" />
	</svg>
{/snippet}

{#snippet reportsIcon(cls: string)}
	<svg class={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
		<path d="M5 20V10M12 20V4M19 20v-7" stroke-linecap="round" stroke-linejoin="round" />
	</svg>
{/snippet}

{#snippet moreIcon(cls: string)}
	<svg class={cls} viewBox="0 0 24 24" fill="currentColor">
		<circle cx="5" cy="12" r="1.6" />
		<circle cx="12" cy="12" r="1.6" />
		<circle cx="19" cy="12" r="1.6" />
	</svg>
{/snippet}

{#snippet tabIcon(key: (typeof tabItems)[number]['key'], cls: string)}
	{#if key === 'dashboard'}
		{@render dashboardIcon(cls)}
	{:else if key === 'transactions'}
		{@render transactionsIcon(cls)}
	{:else if key === 'budgets'}
		{@render budgetsIcon(cls)}
	{:else}
		{@render reportsIcon(cls)}
	{/if}
{/snippet}

<nav class="hidden overflow-x-auto lg:block" aria-label={m.nav_aria_main()}>
	<div class="flex min-w-max gap-1 rounded-md border border-zinc-200 bg-white p-1">
		{#each items as item (item.key)}
			<a
				class:bg-zinc-950={isItemActive(item.key)}
				class:text-white={isItemActive(item.key)}
				class:text-zinc-600={!isItemActive(item.key)}
				class:hover:bg-zinc-100={!isItemActive(item.key)}
				class="rounded px-3 py-2 text-sm font-semibold transition-colors"
				href={resolve(item.href)}
				aria-current={isItemActive(item.key) ? 'page' : undefined}
			>
				{item.label}
			</a>
		{/each}
	</div>
</nav>

<nav class="nav-safe-area fixed inset-x-0 bottom-0 z-40 lg:hidden" aria-label={m.nav_aria_bottom()}>
	<div
		id="app-nav-mobile-floating"
		class="mx-4 flex items-stretch gap-0.5 rounded-3xl bg-white p-1.5 shadow-lg"
	>
		{#each tabItems as item (item.key)}
			<a
				class="flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center px-1 py-1.5 text-center"
				href={resolve(item.href)}
				aria-current={isItemActive(item.key) ? 'page' : undefined}
			>
				<span
					class:bg-zinc-900={isItemActive(item.key)}
					class:text-white={isItemActive(item.key)}
					class:text-zinc-400={!isItemActive(item.key)}
					class="flex flex-col items-center gap-0.5 rounded-2xl px-3 py-1.5 text-[11px] leading-tight font-medium transition-colors"
				>
					{@render tabIcon(item.key, 'h-5 w-5')}
					{item.label}
				</span>
			</a>
		{/each}
		<Menu
			bind:open={moreOpen}
			triggerAriaLabel={m.nav_more_aria()}
			triggerClass="flex min-h-[44px] min-w-0 flex-1 flex-col items-center justify-center px-1 py-1.5 text-center"
			contentClass="w-48"
			side="top"
			sideOffset={12}
		>
			{#snippet trigger()}
				<span
					class:bg-zinc-900={isMoreActive}
					class:text-white={isMoreActive}
					class:text-zinc-400={!isMoreActive}
					class="flex flex-col items-center gap-0.5 rounded-2xl px-3 py-1.5 text-[11px] leading-tight font-medium transition-colors"
				>
					{@render moreIcon('h-5 w-5')}
					{m.nav_more()}
				</span>
			{/snippet}
			<div class="py-1.5">
				{#each moreItems as item (item.key)}
					<DropdownMenu.Item>
						{#snippet child({ props })}
							<a
								{...props}
								class:font-semibold={isItemActive(item.key)}
								class:text-zinc-950={isItemActive(item.key)}
								class:text-zinc-700={!isItemActive(item.key)}
								class="block px-4 py-2.5 text-sm outline-none data-[highlighted]:bg-zinc-50"
								href={resolve(item.href)}
								aria-current={isItemActive(item.key) ? 'page' : undefined}
							>
								{item.label}
							</a>
						{/snippet}
					</DropdownMenu.Item>
				{/each}
			</div>
		</Menu>
	</div>
</nav>

<style>
	.nav-safe-area {
		margin-bottom: calc(env(safe-area-inset-bottom) + 1rem);
	}
</style>
