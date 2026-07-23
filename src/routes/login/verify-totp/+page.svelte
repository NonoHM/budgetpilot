<script lang="ts">
	import type { ActionData } from './$types';
	import AuthCard from '$lib/components/ui/AuthCard.svelte';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import { inputBase } from '$lib/styles';
	import * as m from '$lib/paraglide/messages';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>{m.mfa_verify_page_title()}</title>
</svelte:head>

<AuthCard>
	{#snippet title()}
		<h1 class="text-2xl font-semibold tracking-normal">{m.mfa_verify_heading()}</h1>
		<p class="mt-2 text-sm text-zinc-600">{m.mfa_verify_description()}</p>
	{/snippet}

	<form class="grid gap-4" method="POST">
		<label class="grid gap-1 text-sm font-medium">
			{m.mfa_verify_code_label()}
			<input
				class={inputBase}
				name="code"
				type="text"
				inputmode="text"
				autocomplete="one-time-code"
				required
			/>
		</label>

		{#if form?.error}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}

		<Button type="submit" class="w-full justify-center !rounded-xl">{m.mfa_verify_submit()}</Button>
	</form>

	<p class="mt-4 text-sm text-zinc-600">{m.mfa_verify_recovery_hint()}</p>
</AuthCard>
