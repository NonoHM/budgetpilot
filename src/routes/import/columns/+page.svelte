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
	import { setCompletedImport, type ReplaceOutcome } from '$lib/import/completedImport.svelte';
	import { setPendingCollision } from '$lib/import/pendingCollision.svelte';
	import { buildCollisionRepost } from '$lib/import/collisionRepost';
	import type { CollidingBatchView, CollisionFigures } from '$lib/domain/importCollision';
	import type { ImportSummaryResult } from '$lib/domain/importSummary';
	import { applyAction, deserialize } from '$app/forms';
	import type { ActionData } from './$types';
	import { accountAnswerFor } from '$lib/import/accountHint';
	import type { AccountPickerOption } from '$lib/components/import/AccountPicker.svelte';
	import { getLocale } from '$lib/paraglide/runtime';

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

	/**
	 * The way out, which has to land where the user came from rather than on a bare upload form.
	 *
	 * Reached by « Annuler » and by the header's back chevron. On an ordinary import `/import` IS where
	 * they came from. On a CORRECTION it is not: they arrived from « Modifier les colonnes » on an
	 * import's recap, and the address that reopens that state carries both ids.
	 *
	 * Measured before this existed: abandoning here landed on `/import` with no correction notice and
	 * no checkbox, so the obvious next action — pick the file, press Import — re-read the statement
	 * through the very correspondance the user came to fix and imported it a second time, silently.
	 *
	 * ONE CONSEQUENCE, stated rather than hidden. The consent checkbox is re-rendered at its default,
	 * so a user who had unticked it and then abandoned the screen returns to a ticked box. That is a
	 * reset rather than a reversal — nothing is submitted on the way — and carrying the answer would
	 * mean putting a consent in a URL, which is the shape this wave has just spent a commit removing.
	 * The alternative on offer is today's behaviour, which loses the whole correction instead.
	 *
	 * Reload and browser-back are NOT covered and are filed: the pending designation is read-once, so
	 * by the time either lands there is nothing left to rebuild an address from. Fixing those means
	 * putting the two ids in this route's own URL and resolving them here, which is a second
	 * resolution site rather than carrying a query string.
	 */
	function leaveDesignation() {
		const correction = pending?.correction;
		if (!correction) {
			void goto(resolve('/import'));
			return;
		}
		void goto(
			resolve(
				`/import?correct=${encodeURIComponent(correction.mappingId)}&batch=${encodeURIComponent(correction.batchId)}` as `/import?${string}`
			)
		);
	}

	/**
	 * What the account row opens with: the options, the prefill, and the sentence explaining it.
	 *
	 * Derived HERE and not on the screen, because this is where the negotiated locale is and the
	 * memorised sentence carries a date. `domain/money.ts` is the recorded instance of a module
	 * reaching for an ambient locale: it passed `check`, four thousand unit tests, lint and a full
	 * Playwright run, and died at container startup.
	 *
	 * `chosenId` wins over the resolution whenever it is set. It is only ever set on the way back
	 * from the collision dialog, where the user has already answered, and re-deriving there would
	 * replace their answer with the application's on the one screen built to stop that.
	 */
	const accountOffer = $derived.by(() => {
		const carried = pending?.account ?? null;
		if (!carried) {
			// No offer at all: the row asks, which is the honest state rather than a guess.
			return { options: [], chosenId: null, hint: undefined };
		}
		const answer = accountAnswerFor(
			carried.resolution,
			carried.options,
			carried.memory
				? {
						useCount: carried.memory.useCount,
						lastUsedLabel: carried.memory.lastUsedAt
							? new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long' }).format(
									new Date(carried.memory.lastUsedAt)
								)
							: ''
					}
				: null
		);
		return {
			options: carried.options,
			chosenId: carried.chosenId ?? answer.accountId,
			hint: answer.hint
		};
	});

	/**
	 * « Créer et sélectionner », posted to the endpoint that owns the write.
	 *
	 * The FILE goes with it, and that is the point rather than an accident of what is in hand: the
	 * fragment stored on the new account is what rank 1 will later treat as certain, so it has to be
	 * read from the bytes by the server rather than claimed by this page. The endpoint reads `name`
	 * and `csvFile` and nothing else.
	 *
	 * Resolves rather than throws, in both directions. The screen owns 6g's three states and needs an
	 * ANSWER to move between them; an exception would leave it in flight for ever. The two cases with
	 * no server answer at all are the ones that used to be silent everywhere in this flow: the fetch
	 * rejecting, and a body that is not the JSON this endpoint returns (a crash outside it, or the
	 * login page served after a session expired, which `fetch` follows on its own).
	 *
	 * ASVS 5.0 V16.5.1: the caught value is never rendered and never interpolated, so nothing
	 * internal can reach the screen through this path.
	 */
	async function createAccount(
		name: string
	): Promise<{ ok: true; account: AccountPickerOption } | { ok: false; error: string }> {
		if (!pending) return { ok: false, error: m.import_account_create_error_generic() };
		const body = new FormData();
		body.set('name', name);
		body.set('csvFile', pending.file);
		try {
			const response = await fetch(resolve('/import/accounts'), { method: 'POST', body });
			const payload = (await response.json()) as {
				account?: AccountPickerOption;
				error?: string;
			};
			if (response.ok && payload.account) return { ok: true, account: payload.account };
			return { ok: false, error: payload.error ?? m.import_account_create_error_generic() };
		} catch {
			return { ok: false, error: m.import_account_create_error_generic() };
		}
	}

	function submit(result: {
		accountId: string;
		assignment: RoleAssignment;
		remember: boolean;
		hasHeaderRow: boolean;
		deleteOldImport: boolean;
	}) {
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
		// The account the user chose, posted as an ID and re-resolved against THEIR OWN accounts on
		// the server. It is a claim from here, not a fact: the server puts `userId` in the same where
		// clause, so a hand-made request naming somebody else's account is refused as not-found.
		data.set('accountId', result.accountId);
		// The USER's answer, out of the screen, never `pending.view.hasHeaderRow` — which is what
		// detection guessed on arrival and is exactly what this used to post. A user who told the
		// screen their file had no header row was overruled in silence, losing their first
		// transaction to a header that was never there.
		data.set('hasHeaderRow', String(result.hasHeaderRow));
		for (const role of MAPPING_ROLES) {
			const index = result.assignment[role];
			// Indices, never names. The server resolves them against ITS own header list, so a name
			// posted from here would be a string it has to re-derive anyway.
			if (index !== null) data.set(`${role}Index`, String(index));
		}
		// The batch this correction replaces, posted only when the user consented on the screen that
		// is submitting. `result.deleteOldImport` and NOT a field of `pending`: Planche 5c moved the
		// question into the designation footer, so the answer is the one just given rather than an
		// echo of a choice made two screens ago. That echo was the measured defect on the previous
		// placement, where unticking after the first press lost the import anyway.
		//
		// The ID still comes from `pending`, which is the id the SERVER resolved against this user and
		// against the correspondance being corrected. The two halves come from different places on
		// purpose: one is a consent, the other is a subject, and only the second may name a delete.
		// ASVS 5.0 v5.0.0-2.2.1 and v5.0.0-8.2.2: it travels as a request and is re-resolved there,
		// never as an authorisation.
		if (pending.correction && result.deleteOldImport) {
			data.set('replaceBatchId', pending.correction.batchId);
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
					{ importResult: ImportSummaryResult; capReached: boolean; replaced?: ReplaceOutcome },
					{
						error?: string;
						keepDesignation?: boolean;
						collision?: CollidingBatchView;
						incoming?: CollisionFigures;
					}
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
				/**
				 * The run duplicates a statement already imported, and the question is asked on
				 * `/import` rather than here.
				 *
				 * §5.5 of the design handoff lists `ConfirmDialog` among the things this screen does
				 * not contain, and §5.2 gives the reason in general form: on a server refusal, this
				 * screen does not own the outcome. It keeps the answers exactly as they were and the
				 * report happens where reports happen. The designation is not what is being
				 * questioned here, the resulting import is.
				 *
				 * Ahead of `applyAction`, because applying a failure would paint a banner on a screen
				 * this branch is about to leave.
				 */
				if (
					actionResult.type === 'failure' &&
					actionResult.data?.collision &&
					actionResult.data.incoming
				) {
					setPendingDesignation({ ...pending, initialAssignment: result.assignment });
					setPendingCollision({
						// Built by `buildCollisionRepost`, which is where the mapping is asserted: this
						// branch is reachable only through a serialised `ActionResult`, which a component
						// test cannot construct faithfully, so the transport was what made the seam
						// untestable rather than the mapping.
						repost: buildCollisionRepost(pending, result),
						existing: actionResult.data.collision,
						incoming: actionResult.data.incoming
					});
					await goto(resolve('/import'));
					return;
				}

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
					canRevisit: failed,
					// Defaulted rather than asserted. This is the only field of the four whose absence
					// is a legitimate state of the payload, since a run that was not a correction has
					// nothing to report about a replacement.
					replaced: carried.replaced ?? { kind: 'none' }
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
	<!--
		`h-dvh` at mobile, `h-full` from `lg`. The screen owns the whole viewport at 390, where it
		carries no chrome at all; from `lg` the layout gives it the space left under the header, and
		a hardcoded viewport height there can only push its own bottom 87 px out of sight.
	-->
	<main class="flex h-dvh w-full flex-col bg-zinc-50 lg:h-full">
		{#if shownError}
			<div class="shrink-0">
				<AlertBanner variant="error">{shownError}</AlertBanner>
			</div>
		{/if}
		<!-- `use:enhance` is not used: the submit carries a File assembled here rather than the
		     form's own fields, so the form element exists only to own the action URL. -->
		<form bind:this={formEl} method="POST" enctype="multipart/form-data" class="contents"></form>
		<div class="min-h-0 flex-1">
			<!--
				`replaces` is GATED ON THE NAME, not only on the batch. A batch can resolve while its
				timestamp does not, and a consent labelled « Supprimer l'import du  » names nothing: the
				control exists to say WHICH import it destroys, so with no name there is no control to
				offer. Carried over from the gate the previous placement had on `/import`.
			-->
			<ColumnDesignationScreen
				file={pending.view}
				accounts={accountOffer.options}
				initialAccountId={accountOffer.chosenId}
				accountHint={accountOffer.hint}
				accountPrefill={pending.account?.prefillName ?? ''}
				onCreateAccount={createAccount}
				initialAssignment={pending.initialAssignment}
				candidates={pending.candidates as Partial<Record<MappingRole, number[]>>}
				{submitting}
				{wide}
				replaces={pending.correction && pending.correction.namedAt !== ''
					? {
							batchId: pending.correction.batchId,
							namedAt: pending.correction.namedAt,
							replacedRows: pending.correction.replacedRows,
							hasUserWork: pending.correction.hasUserWork
						}
					: undefined}
				onCancel={leaveDesignation}
				onSubmit={submit}
			/>
		</div>
	</main>
{/if}
