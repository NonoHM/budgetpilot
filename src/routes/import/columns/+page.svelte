<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { MAPPING_ROLES, type MappingRole } from '$lib/server/import/mapping/model';
	import type { RoleAssignment } from '$lib/domain/columnDesignation';
	import ColumnDesignationScreen from '$lib/components/import/ColumnDesignationScreen.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import {
		clearPendingDesignation,
		takePendingDesignation
	} from '$lib/import/pendingDesignation.svelte';
	import type { ActionData } from './$types';

	/**
	 * « Désigner les colonnes », as a full page in the navigation stack.
	 *
	 * A page rather than a sheet, and the bottom tab bar is not shown, exactly as the transaction
	 * detail page behaves: the user is in the middle of one task and the way out is the header's
	 * back button or the footer's Annuler, not a tab that abandons it silently.
	 *
	 * This file is deliberately thin. Everything that can be tested without a route lives in
	 * `ColumnDesignationScreen`, and everything that decides anything lives in the action.
	 */
	let { form }: { form: ActionData } = $props();

	const pending = takePendingDesignation();
	let submitting = $state(false);
	let formEl = $state<HTMLFormElement | null>(null);

	// A reload loses the File, which cannot be serialised. Going back to the upload is the honest
	// outcome: a designation screen with no file is a screen whose primary can never do anything.
	$effect(() => {
		if (!pending) void goto(resolve('/import'));
	});

	function submit(result: { assignment: RoleAssignment; remember: boolean }) {
		if (!pending || !formEl) return;
		submitting = true;

		const data = new FormData();
		// The file itself, re-posted. Owner ruling 2: the browser keeps it, so there is no stored
		// asset with a lifetime, an expiry and a key to protect.
		data.set('csvFile', pending.file);
		data.set('remember', String(result.remember));
		data.set('hasHeaderRow', String(pending.view.hasHeaderRow));
		for (const role of MAPPING_ROLES) {
			const index = result.assignment[role];
			// Indices, never names. The server resolves them against ITS own header list, so a name
			// posted from here would be a string it has to re-derive anyway.
			if (index !== null) data.set(`${role}Index`, String(index));
		}

		void fetch(formEl.action, { method: 'POST', body: data })
			.then(async (response) => {
				submitting = false;
				if (response.ok) {
					clearPendingDesignation();
					await goto(resolve('/import'));
				}
			})
			.catch(() => {
				submitting = false;
			});
	}
</script>

<svelte:head>
	<title>{m.import_columns_page_title()}</title>
</svelte:head>

{#if pending}
	<main class="h-dvh w-full bg-white">
		{#if form?.error}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}
		<!-- `use:enhance` is not used: the submit carries a File assembled here rather than the
		     form's own fields, so the form element exists only to own the action URL. -->
		<form bind:this={formEl} method="POST" enctype="multipart/form-data" class="contents"></form>
		<ColumnDesignationScreen
			file={pending.view}
			initialAssignment={pending.initialAssignment}
			candidates={pending.candidates as Partial<Record<MappingRole, number[]>>}
			{submitting}
			onCancel={() => goto(resolve('/import'))}
			onSubmit={submit}
		/>
	</main>
{/if}
