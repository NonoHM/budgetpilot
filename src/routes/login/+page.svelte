<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { resolve } from '$app/paths';
	import AuthCard from '$lib/components/ui/AuthCard.svelte';
	import PasswordInput from '$lib/components/ui/PasswordInput.svelte';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import { inputBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>{m.login_page_title()}</title>
</svelte:head>

<AuthCard>
	{#snippet title()}
		<h1 class="text-2xl font-semibold tracking-normal">{m.login_heading()}</h1>
	{/snippet}

	{#if data.notice === 'registration_closed'}
		<AlertBanner variant="info" class="mb-4">{m.register_notice_closed()}</AlertBanner>
	{/if}

	<form class="grid gap-4" method="POST">
		<label class="grid gap-1 text-sm font-medium">
			{m.login_email_label()}
			<input class={inputBase} name="email" type="email" autocomplete="email" required />
		</label>
		<label class="grid gap-1 text-sm font-medium">
			{m.login_password_label()}
			<PasswordInput name="password" autocomplete="current-password" required />
		</label>

		{#if form?.error}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}

		<Button type="submit" class="w-full justify-center !rounded-xl">{m.login_submit()}</Button>
	</form>

	{#if data.canRegister}
		<p class="mt-4 text-sm text-zinc-600">
			{m.login_no_account()}
			<a class="font-medium text-zinc-950 underline" href={resolve('/register')}
				>{m.login_register_link()}</a
			>
		</p>
	{/if}
</AuthCard>
