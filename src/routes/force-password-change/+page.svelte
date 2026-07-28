<script lang="ts">
	import AuthCard from '$lib/components/ui/AuthCard.svelte';
	import PasswordInput from '$lib/components/ui/PasswordInput.svelte';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import * as m from '$lib/paraglide/messages';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>{m.force_password_page_title()}</title>
</svelte:head>

<AuthCard>
	{#snippet title()}
		<p
			class="mb-4 flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700"
		>
			<svg
				class="h-4 w-4 shrink-0"
				viewBox="0 0 20 20"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<circle cx="10" cy="10" r="8" />
				<path d="M6.5 10.5 9 13l4.5-6" />
			</svg>
			{m.force_password_verified_notice()}
		</p>
		<h1 class="text-xl font-semibold tracking-tight">{m.force_password_heading()}</h1>
		<p class="mt-1 text-sm text-zinc-600">
			{m.force_password_description()}
		</p>
	{/snippet}

	<form class="space-y-4" method="POST" autocomplete="off">
		<label class="block space-y-1.5 text-sm">
			<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
				{m.force_password_new_label()}
			</span>
			<PasswordInput name="newPassword" required minlength={12} autocomplete="new-password" />
		</label>

		<label class="block space-y-1.5 text-sm">
			<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
				{m.force_password_confirm_label()}
			</span>
			<PasswordInput name="confirmPassword" required minlength={12} autocomplete="new-password" />
		</label>

		{#if form?.passwordError}
			<AlertBanner variant="error">{form.passwordError}</AlertBanner>
		{/if}

		<Button type="submit" class="w-full justify-center !rounded-xl"
			>{m.force_password_submit()}</Button
		>
	</form>

	<form method="POST" action="/logout" class="mt-4">
		<TapLink type="submit">{m.force_password_logout()}</TapLink>
	</form>
</AuthCard>
