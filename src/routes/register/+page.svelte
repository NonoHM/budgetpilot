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
	<title>{m.register_page_title()}</title>
</svelte:head>

<AuthCard>
	{#snippet title()}
		<h1 class="text-2xl font-semibold tracking-normal">{m.register_heading()}</h1>
	{/snippet}

	{#if data.inviteEmail}
		<p class="mb-4 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-600">
			{m.register_invite_notice({ email: data.inviteEmail })}
		</p>
	{/if}

	<form class="grid gap-4" method="POST">
		<label class="grid gap-1 text-sm font-medium">
			{m.register_email_label()}
			<input
				class={inputBase}
				name="email"
				type="email"
				autocomplete="email"
				value={data.inviteEmail ?? ''}
				readonly={Boolean(data.inviteEmail)}
				required
			/>
		</label>
		<label class="grid gap-1 text-sm font-medium">
			{m.register_password_label()}
			<PasswordInput name="password" autocomplete="new-password" minlength={12} required />
		</label>
		{#if data.requiresBootstrapToken}
			<label class="grid gap-1 text-sm font-medium">
				{m.register_bootstrap_token_label()}
				<input class={inputBase} name="bootstrapToken" type="password" autocomplete="off" />
				<span class="mt-1 block text-xs font-normal text-zinc-500"
					>{m.register_bootstrap_token_hint()}</span
				>
			</label>
		{/if}

		{#if form?.error}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}
		{#if form?.success}
			<AlertBanner variant="success">{form.success}</AlertBanner>
		{/if}

		<Button type="submit" class="w-full justify-center !rounded-xl">{m.register_submit()}</Button>
	</form>

	<p class="mt-4 text-sm text-zinc-600">
		{m.register_has_account()}
		<a class="font-medium text-zinc-950 underline" href={resolve('/login')}
			>{m.register_login_link()}</a
		>
	</p>
</AuthCard>
