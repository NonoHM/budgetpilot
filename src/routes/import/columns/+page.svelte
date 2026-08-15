<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { MAPPING_ROLES, type MappingRole } from '$lib/domain/mappingRoles';
	import type { RoleAssignment } from '$lib/domain/columnDesignation';
	import ColumnDesignationScreen from '$lib/components/import/ColumnDesignationScreen.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import {
		clearPendingDesignation,
		setPendingDesignation,
		takePendingDesignation
	} from '$lib/import/pendingDesignation.svelte';
	import { setCompletedImport } from '$lib/import/completedImport.svelte';
	import type { ImportSummaryResult } from '$lib/domain/importSummary';
	import { applyAction, deserialize } from '$app/forms';
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

	/**
	 * A failure this page has to report ITSELF, because no `ActionResult` arrived to report it.
	 *
	 * `form` covers every refusal the server managed to express: `applyAction` writes it and the
	 * banner below reads it. It cannot cover the two cases where there is no server answer to apply
	 * at all, and those are exactly the cases that used to be silent: the fetch rejecting, and a
	 * body that is not a serialised `ActionResult` (a crash outside the action returns an HTML error
	 * page, which `deserialize` throws on).
	 *
	 * ASVS 5.0 **V16.5.1**: the message is GENERIC. The caught value is never rendered and never
	 * interpolated, so a stack trace or an internal path cannot reach the page through this route.
	 */
	let localError = $state<string | null>(null);
	const shownError = $derived(form?.error ?? localError);

	/**
	 * Which chrome the one screen wears, resolved from `matchMedia` rather than from CSS.
	 *
	 * The alternative, rendering both and hiding one with `lg:hidden`, would mount the screen TWICE.
	 * Each instance owns its own assignment, so a user designating at 390 and rotating to 1280 would
	 * arrive at an empty form, and neither copy could see the other's state. Two mounts of a stateful
	 * screen is not a responsive layout, it is two screens that happen to look alike.
	 *
	 * `lg` is 1024 in this project's Tailwind scale, and the desktop figures are drawn at 1280.
	 */
	let wide = $state(false);
	$effect(() => {
		const query = window.matchMedia('(min-width: 1024px)');
		wide = query.matches;
		const update = (event: MediaQueryListEvent) => (wide = event.matches);
		query.addEventListener('change', update);
		return () => query.removeEventListener('change', update);
	});

	// A reload loses the File, which cannot be serialised. Going back to the upload is the honest
	// outcome: a designation screen with no file is a screen whose primary can never do anything.
	$effect(() => {
		if (!pending) void goto(resolve('/import'));
	});

	function submit(result: { assignment: RoleAssignment; remember: boolean }) {
		if (!pending || !formEl) return;
		submitting = true;
		// Cleared per attempt, so a retry that fails differently does not read as the first failure
		// still standing, and a retry that succeeds does not leave a banner contradicting the summary.
		localError = null;

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

		// `x-sveltekit-action`, and the whole defect was its absence. Without it the action's reply
		// is a rendered page rather than a serialised ActionResult, so there was nothing in the
		// response worth reading and the summary the server had already built was dropped on the
		// floor. With it, the result deserialises and is handed to `/import` to draw (#338).
		void fetch(formEl.action, {
			method: 'POST',
			body: data,
			headers: { 'x-sveltekit-action': 'true' }
		})
			.then(async (response) => {
				submitting = false;
				// Typed at the call rather than cast after it: `deserialize` returns `unknown` data by
				// default, and a cast downstream would let the action's payload drift from what
				// `/import` draws without anything failing.
				const actionResult = deserialize<
					{ importResult: ImportSummaryResult; capReached: boolean },
					{ error?: string; keepDesignation?: boolean }
				>(await response.text());
				// A REFUSAL IS APPLIED, NOT DISCARDED, and the response status is why this cannot be
				// gated on `response.ok`. A `fail()` is HTTP 400, so an `ok` check returns before
				// reading the body and the screen sits there saying nothing: the user presses
				// Import, the server refuses, and nothing at all happens. The `{#if form?.error}`
				// banner on this page could only ever render on a full-page POST, which this flow
				// never performs.
				//
				// Found by screenshot while verifying #343's guard, which refuses a file whose money
				// is split across two columns. Every unit test of that guard passed: the refusal was
				// produced correctly and never rendered.
				// EVERY non-success is applied, and the union has FOUR members rather than the two
				// this branch used to read. `failure` was handled; `redirect` and `error` fell through
				// to the `carried` check below, came back undefined, and returned having done nothing.
				//
				// `redirect` is the expired session, and it is the one that mattered most. `requireUser`
				// throws `redirect(303, '/login')`, SvelteKit serialises that as an ActionResult rather
				// than as an HTTP redirect because the request carries `x-sveltekit-action`, and dropping
				// it left the user pressing « Importer » against a screen that did nothing at all, for as
				// long as they were willing to keep pressing.
				//
				// `applyAction` already knows all three: it writes `form` for a failure, navigates for a
				// redirect, and renders the error boundary for an error. The fix is to stop narrowing the
				// union, not to reimplement what it does.
				if (actionResult.type !== 'success') {
					await applyAction(actionResult);
					return;
				}

				// `data` is optional on a success too, so the summary is checked rather than assumed.
				// Reported rather than returned silently: navigating with nothing to draw would land the
				// user on the same silent screen this change exists to remove, and returning without a
				// word left the primary looking inert. Staying here keeps the designations intact.
				const carried = actionResult.data;
				if (!carried?.importResult) {
					localError = m.import_columns_error_unexpected();
					return;
				}
				// KEPT, not cleared, when rows failed. The plate's way back reopens this screen « en
				// état 2, désignations intactes », which needs both the file — held in the browser,
				// owner ruling 2 — and the answers just given. Re-seeding `initialAssignment` with
				// them is what makes the screen come back designated rather than empty; without it
				// the link would be a re-import with extra steps.
				const failed = carried.importResult.invalidRows > 0;
				setCompletedImport({
					importResult: carried.importResult,
					capReached: carried.capReached === true,
					canRevisit: failed
				});
				if (failed) {
					setPendingDesignation({ ...pending, initialAssignment: result.assignment });
				} else {
					clearPendingDesignation();
				}
				await goto(resolve('/import'));
			})
			.catch(() => {
				// The network failed, or the body was not a serialised ActionResult and `deserialize`
				// threw. Both used to land here and do nothing but stop the spinner, which is the same
				// silence as before with a tidier shape.
				//
				// ASVS 5.0 **V16.5.1**: a GENERIC message, and the caught value is deliberately not a
				// parameter of this function. There is nothing to interpolate, so no stack trace, no
				// internal path and no upstream body can be rendered from here.
				//
				// ASVS 5.0 **V16.5.3**: it fails CLOSED. Nothing below this line navigates, clears the
				// pending designation or writes a completed import, so a failed call cannot present
				// itself as a finished one. The plate's own answer is the same: return to state 2
				// exactly as left, no designation lost.
				submitting = false;
				localError = m.import_columns_error_unexpected();
			});
	}
</script>

<svelte:head>
	<title>{m.import_columns_page_title()}</title>
</svelte:head>

{#if pending}
	<!--
		A FLEX COLUMN, and the banner is why. The screen's own root is `h-full`, so as siblings in a
		block container the banner's height was ADDED to a full 844 rather than taken out of it: the
		document grew past the viewport and the footer carrying the primary went below the fold.

		That defect was latent while the banner almost never rendered. Making the silent failures
		speak is exactly what would have made it routine, so the fix for a silent failure would have
		shipped an occluded control instead. This repository has already paid for that once, on the
		band whose whole purpose was to explain why Save was disabled, covering the rows it was about.

		`flex-1 min-h-0` hands the screen the room that is LEFT. Its grid is
		`[auto_minmax(0,1fr)_auto_auto]`, so the loss lands on the body, which is the only region
		designed to give and which carries 125 px of air in every state.
	-->
	<main class="flex h-dvh w-full flex-col bg-zinc-50">
		{#if shownError}
			<div class="shrink-0">
				<AlertBanner variant="error">{shownError}</AlertBanner>
			</div>
		{/if}
		<!-- `use:enhance` is not used: the submit carries a File assembled here rather than the
		     form's own fields, so the form element exists only to own the action URL. -->
		<form bind:this={formEl} method="POST" enctype="multipart/form-data" class="contents"></form>
		<div class="min-h-0 flex-1">
			<ColumnDesignationScreen
				file={pending.view}
				initialAssignment={pending.initialAssignment}
				candidates={pending.candidates as Partial<Record<MappingRole, number[]>>}
				{submitting}
				{wide}
				onCancel={() => goto(resolve('/import'))}
				onSubmit={submit}
			/>
		</div>
	</main>
{/if}
