<script lang="ts">
	import { resolve } from '$app/paths';
	import AppNav from './AppNav.svelte';
	import AccountMenu from './AccountMenu.svelte';

	let {
		active,
		userEmail,
		isAdmin
	}: {
		active:
			| 'dashboard'
			| 'transactions'
			| 'reports'
			| 'imports'
			| 'rules'
			| 'budgets'
			| 'net-worth'
			| 'settings';
		userEmail: string;
		isAdmin: boolean;
	} = $props();
</script>

<header class="border-b border-zinc-200 bg-white">
	<div
		class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-5"
	>
		<div class="min-w-0">
			<a class="text-2xl font-semibold tracking-tight text-zinc-950" href={resolve('/')}
				>BudgetPilot</a
			>
		</div>
		<div class="flex items-center gap-3">
			<AppNav {active} />
			<AccountMenu email={userEmail} {isAdmin} />
		</div>
	</div>
</header>
