<script lang="ts">
	import { enhance } from '$app/forms';
	import { afterNavigate } from '$app/navigation';
	import { onMount } from 'svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import FileDropZone from '$lib/components/ui/FileDropZone.svelte';
	import PasswordInput from '$lib/components/ui/PasswordInput.svelte';
	import Switch from '$lib/components/Switch.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import TagChips from '$lib/components/ui/TagChips.svelte';
	import ColorSwatchGroup from '$lib/components/ui/ColorSwatchGroup.svelte';
	import { cardBase, inputBase } from '$lib/styles';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { TAG_COLOR_TOKENS } from '$lib/domain/tags';
	import { tagColorBgClass } from '$lib/domain/colors';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, setLocale, locales, type Locale } from '$lib/paraglide/runtime';
	import type { PageProps } from './$types';

	const LOCALE_LABELS: Record<Locale, () => string> = {
		fr: m.settings_language_fr,
		en: m.settings_language_en
	};

	let { data, form }: PageProps = $props();

	type TagRow = PageProps['data']['tags'][number];

	// Modal/dialog state for the tag management section, same shape as /categories'
	// renamingCategory/deletingCategory: the row itself, not just its id, so the modal has the
	// current name/count to render without a second lookup.
	let renamingTag: TagRow | null = $state(null);
	let deletingTag: TagRow | null = $state(null);
	let renameTagSubmitting = $state(false);
	let deleteTagSubmitting = $state(false);

	// The accessible name of a colour swatch is the hue token capitalised, derived here rather
	// than stored: TAG_COLOR_TOKENS in domain/tags.ts is deliberately the only place the token
	// names are written down.
	function capitalizeToken(token: string): string {
		return token.charAt(0).toUpperCase() + token.slice(1);
	}

	// Built once, not per tag row: the palette is the same for every tag, and tagColorBgClass is a
	// lookup into a closed literal table rather than a computed class (see domain/colors.ts).
	const swatchOptions = TAG_COLOR_TOKENS.map((token) => ({
		value: token,
		label: capitalizeToken(token),
		class: tagColorBgClass(token)
	}));

	function tagTxCount(n: number): string {
		return n > 1 ? m.tags_tx_count_many({ count: n }) : m.tags_tx_count_one({ count: n });
	}

	const dateTimeFormatter = new Intl.DateTimeFormat(getLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short'
	});

	function formatDate(value: Date | string | null): string {
		if (!value) return '—';
		return dateTimeFormatter.format(new Date(value));
	}

	const activeSessions = $derived(data.sessions.filter((s) => s.status === 'active').length);
	const currentSession = $derived(data.sessions.find((s) => s.isCurrent) ?? null);

	// Password modal
	let passwordModalOpen = $state(false);
	let newPasswordValue = $state('');
	let confirmPasswordValue = $state('');
	let newPasswordTouched = $state(false);
	let confirmPasswordTouched = $state(false);

	// Inline errors (triggered on blur)
	const passwordMismatch = $derived(
		confirmPasswordTouched &&
			confirmPasswordValue.length > 0 &&
			newPasswordValue !== confirmPasswordValue
	);
	const newPasswordTooShort = $derived(
		newPasswordTouched && newPasswordValue.length > 0 && newPasswordValue.length < 12
	);
	// Disabled state independent of blur (current value)
	const submitDisabled = $derived(
		(newPasswordValue.length > 0 && newPasswordValue.length < 12) ||
			(newPasswordValue.length > 0 &&
				confirmPasswordValue.length > 0 &&
				newPasswordValue !== confirmPasswordValue)
	);

	function openPasswordModal() {
		newPasswordValue = '';
		confirmPasswordValue = '';
		newPasswordTouched = false;
		confirmPasswordTouched = false;
		passwordModalOpen = true;
	}

	function closePasswordModal() {
		passwordModalOpen = false;
		newPasswordValue = '';
		confirmPasswordValue = '';
		newPasswordTouched = false;
		confirmPasswordTouched = false;
	}

	// TOTP modal (enabling)
	let mfaSetupModalOpen = $state(false);
	let mfaSetupForm = $state<HTMLFormElement | undefined>(undefined);
	let mfaCodeValue = $state('');
	let mfaSetupPasswordValue = $state('');

	function closeMfaSetupModal() {
		mfaSetupModalOpen = false;
		mfaCodeValue = '';
		mfaSetupPasswordValue = '';
	}

	$effect(() => {
		if (form?.totpSetupPending || form?.recoveryCodes) {
			mfaSetupModalOpen = true;
			mfaCodeValue = '';
			mfaSetupPasswordValue = '';
		}
	});

	// TOTP modal (disabling)
	let mfaDisableModalOpen = $state(false);

	function closeMfaDisableModal() {
		mfaDisableModalOpen = false;
	}

	$effect(() => {
		if (form?.totpDisableError) mfaDisableModalOpen = true;
		if (form?.totpDisableSuccess) mfaDisableModalOpen = false;
	});

	// Sessions detail
	let sessionsDetailOpen = $state(false);

	// Danger zone (controlled button, not <details>/<summary>)
	let dangerOpen = $state(false);
	let dangerConfirmValue = $state('');
	const deleteConfirmValid = $derived(dangerConfirmValue === 'SUPPRIMER');

	// Backup restore (controlled button)
	let restoreOpen = $state(false);
	let restoreFiles = $state<FileList | undefined>(undefined);
	let restoreConfirmOpen = $state(false);
	const hasRestoreFile = $derived((restoreFiles?.length ?? 0) > 0);

	$effect(() => {
		if (form?.restoreError) restoreOpen = true;
	});

	// Reopen the modal only on error; close + show success inline
	$effect(() => {
		if (form?.passwordError) passwordModalOpen = true;
		if (form?.passwordSuccess) closePasswordModal();
	});

	// AI toggles: immediate submission on click via an inverted hidden input
	let aiInsightsForm = $state<HTMLFormElement | undefined>(undefined);
	let aiLabelsForm = $state<HTMLFormElement | undefined>(undefined);

	// Common card chrome (pattern already used by /rules, /categories):
	// see cardBase in $lib/styles.
	const card = `${cardBase} p-5`;

	// Arrival state for the /settings#tags deep link (ManageTagsFooter's "Gérer dans Paramètres"
	// row on the transaction-side tag panels): bring the section into view and move focus to its
	// heading, so eye and ear land in the same place and a screen reader announces it. Checked on
	// both a cold load (onMount) and a client-side navigation (afterNavigate) — the footer link is
	// reached from /transactions without a full page reload, so onMount alone would miss it.
	// tabindex="-1" makes the heading a valid focus target without adding it to Tab order, and the
	// ring is not timed: it stays until the next Tab or click, never a coloured flash.
	//
	// The ring is `focus:`, NOT `focus-visible:`, and that is the whole point rather than a slip.
	// :focus-visible does not match when focus is moved programmatically while the last input was a
	// MOUSE — so a user arriving by clicking the footer row would have landed on the heading with no
	// visible ring at all, which is exactly the arrival state this exists to provide. Because the
	// heading is tabindex="-1" it can never be reached by Tab, so `focus:` fires here and nowhere
	// else; there is no over-application to trade against.
	let tagsHeadingEl = $state<HTMLHeadingElement | undefined>(undefined);

	function focusTagsHeadingIfHashed() {
		if (typeof window !== 'undefined' && window.location.hash === '#tags') {
			tagsHeadingEl?.focus();
		}
	}

	onMount(focusTagsHeadingIfHashed);
	afterNavigate(focusTagsHeadingIfHashed);
</script>

<svelte:head>
	<title>{m.settings_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<section class="mx-auto max-w-5xl space-y-4">
		<!-- Titre -->
		<h1 class="text-2xl font-semibold tracking-normal">{m.settings_heading()}</h1>

		<!-- Succès désactivation TOTP (inline, modale fermée) -->
		{#if form?.totpDisableSuccess}
			<AlertBanner variant="success">{form.totpDisableSuccess}</AlertBanner>
		{/if}

		<!-- Succès changement de mot de passe (inline, modale fermée) -->
		{#if form?.passwordSuccess}
			<AlertBanner variant="success">{form.passwordSuccess}</AlertBanner>
		{/if}

		<!-- LIGNE 1 : COMPTE (1/3) + STATUT SÉCURITÉ (2/3) -->
		<div class="grid gap-4 lg:grid-cols-3">
			<!-- Compte -->
			<div class={card}>
				<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
					{m.settings_account_heading()}
				</h2>
				<div class="mt-4 flex items-center gap-3">
					<div
						class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-semibold text-white"
						aria-hidden="true"
					>
						{data.account.email.charAt(0).toUpperCase()}
					</div>
					<div class="min-w-0">
						<div class="truncate text-sm font-semibold text-zinc-900">{data.account.email}</div>
					</div>
				</div>
				<dl class="mt-4 border-t border-zinc-100 pt-4 text-sm">
					<div class="flex items-center justify-between">
						<dt class="text-zinc-500">{m.settings_role_label()}</dt>
						<dd>
							<span
								class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-zinc-600 uppercase"
							>
								{data.account.role}
							</span>
						</dd>
					</div>
				</dl>
			</div>

			<!-- Statut sécurité -->
			<div class="{card} lg:col-span-2">
				<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
					{m.settings_security_status_heading()}
				</h2>
				<div class="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
					<!-- Auth : toujours active sur cette page — texte neutre, pas de dot -->
					<div>
						<div class="text-sm font-medium text-zinc-900">{m.settings_auth_label()}</div>
						<div class="text-xs text-zinc-500">{m.settings_auth_value()}</div>
					</div>
					<!-- LLM : état réel binaire → dot encodé -->
					<div class="flex items-start gap-2.5">
						<span
							class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
							class:bg-emerald-500={data.security.llmEnabled}
							class:bg-zinc-300={!data.security.llmEnabled}
						></span>
						<div>
							<div class="text-sm font-medium text-zinc-900">{m.settings_llm_local_label()}</div>
							<div class="text-xs text-zinc-500">
								{data.security.llmEnabled ? m.settings_llm_enabled() : m.settings_llm_disabled()}
							</div>
						</div>
					</div>
					<!-- Environnement : informatif, pas de dot -->
					<div>
						<div class="text-sm font-medium text-zinc-900">{m.settings_environment_label()}</div>
						<div class="text-xs text-zinc-500">
							{data.security.runtime === 'docker'
								? m.settings_environment_docker()
								: m.settings_environment_local()}
						</div>
					</div>
					<!-- Dernière session : informatif, pas de dot -->
					<div>
						<div class="text-sm font-medium text-zinc-900">{m.settings_last_session_label()}</div>
						<div class="text-xs text-zinc-500 tabular-nums">
							{formatDate(data.security.latestSessionCreatedAt)}
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- LANGUE -->
		<div class={card}>
			<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
				{m.settings_language_heading()}
			</h2>
			<div class="mt-3 lg:max-w-xs">
				<p class="mb-1.5 text-sm font-medium text-zinc-600">{m.settings_language_label()}</p>
				<Select
					value={getLocale()}
					ariaLabel={m.settings_language_label()}
					options={locales.map((locale) => ({ value: locale, label: LOCALE_LABELS[locale]() }))}
					onValueChange={(value) => setLocale(value as Locale)}
				/>
			</div>
		</div>

		<!-- SÉCURITÉ -->
		<div class={card}>
			<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
				{m.settings_security_heading()}
			</h2>
			<div
				class="mt-3 flex flex-col items-start gap-4 rounded-xl border border-zinc-200 bg-zinc-50/50 px-4 py-3.5 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between"
			>
				<div class="flex items-start gap-3">
					<span
						class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white text-zinc-500 ring-1 ring-zinc-200"
					>
						<svg
							class="h-5 w-5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<rect x="4" y="11" width="16" height="9" rx="2" />
							<path d="M8 11V7a4 4 0 0 1 8 0v4" />
						</svg>
					</span>
					<div>
						<div class="text-sm font-medium text-zinc-900">{m.settings_password_label()}</div>
						<div class="mt-0.5 text-sm text-zinc-500">
							{m.settings_password_description()}
						</div>
					</div>
				</div>
				<Button
					type="button"
					size="sm"
					class="h-11 w-full shrink-0 lg:h-auto lg:w-auto"
					onclick={openPasswordModal}
				>
					{m.settings_change_password()}
				</Button>
			</div>
		</div>

		<!-- MFA (TOTP) -->
		<div class={card}>
			<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
				{m.settings_mfa_heading()}
			</h2>
			<div
				class="mt-3 flex flex-col items-start gap-4 rounded-xl border border-zinc-200 bg-zinc-50/50 px-4 py-3.5 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between"
			>
				<div class="flex items-start gap-3">
					<span
						class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white text-zinc-500 ring-1 ring-zinc-200"
					>
						<svg
							class="h-5 w-5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<rect x="3" y="4" width="18" height="16" rx="2" />
							<path d="M7 8h2M7 12h2M7 16h2M12 8h5M12 12h5M12 16h2" />
						</svg>
					</span>
					<div>
						<div class="text-sm font-medium text-zinc-900">{m.settings_mfa_title()}</div>
						<div class="mt-0.5 text-sm text-zinc-500">
							{data.mfa.enabled
								? m.settings_mfa_description_enabled()
								: m.settings_mfa_description_disabled()}
						</div>
					</div>
				</div>
				<form method="POST" action="?/startTotpSetup" class="shrink-0" bind:this={mfaSetupForm}>
					<Switch
						checked={data.mfa.enabled}
						ariaLabel={m.settings_mfa_switch_aria()}
						onchange={(next) => {
							if (next) mfaSetupForm?.requestSubmit();
							else mfaDisableModalOpen = true;
						}}
					/>
				</form>
			</div>
		</div>

		<!-- SESSIONS -->
		<div class={card}>
			<div class="flex items-center justify-between">
				<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
					{m.settings_sessions_heading()}
				</h2>
				<Badge tone="success">
					<span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
					{activeSessions > 1
						? m.settings_sessions_active_many({ count: activeSessions })
						: m.settings_sessions_active_one({ count: activeSessions })}
				</Badge>
			</div>

			{#if form?.sessionsSuccess}
				<AlertBanner variant="success" class="mt-3">{form.sessionsSuccess}</AlertBanner>
			{/if}
			{#if form?.sessionsError}
				<AlertBanner variant="error" class="mt-3">{form.sessionsError}</AlertBanner>
			{/if}

			<!-- MOBILE (<lg) : une carte par session, avec bouton "Révoquer" individuel
			     pour les sessions actives autres que la session courante. -->
			<div class="mt-3 space-y-2.5 lg:hidden">
				{#each data.sessions as session, i (i)}
					<div class="flex items-start gap-3 rounded-xl border border-zinc-200 px-4 py-3.5">
						<span
							class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-50 text-zinc-500 ring-1 ring-zinc-200"
						>
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<rect x="3" y="4" width="18" height="12" rx="2" />
								<path d="M8 20h8M12 16v4" />
							</svg>
						</span>
						<div class="min-w-0 flex-1">
							<div class="flex flex-wrap items-center gap-2">
								<span class="text-sm font-medium text-zinc-900">
									{session.isCurrent
										? m.settings_this_session()
										: m.settings_session_n({ n: i + 1 })}
								</span>
								{#if session.isCurrent}
									<span
										class="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase"
									>
										{m.settings_current_badge()}
									</span>
								{:else}
									<span
										class="inline-flex items-center gap-1 text-[11px] font-semibold"
										class:text-emerald-700={session.status === 'active'}
										class:text-zinc-500={session.status !== 'active'}
									>
										<span
											class="h-1.5 w-1.5 rounded-full"
											class:bg-emerald-500={session.status === 'active'}
											class:bg-zinc-300={session.status !== 'active'}
										></span>
										{session.status === 'active'
											? m.settings_status_active()
											: m.settings_status_revoked()}
									</span>
								{/if}
							</div>
							<div class="mt-0.5 text-xs text-zinc-500">
								{m.settings_session_created_expires({
									created: formatDate(session.createdAt),
									expires: formatDate(session.expiresAt)
								})}
							</div>
						</div>
						{#if !session.isCurrent && session.status === 'active'}
							<form method="POST" action="?/revokeSession" class="shrink-0">
								<input type="hidden" name="sessionId" value={session.id} />
								<Button type="submit" variant="ghost-danger" size="sm">
									{m.settings_revoke_session()}
								</Button>
							</form>
						{/if}
					</div>
				{:else}
					<p class="py-4 text-center text-sm text-zinc-500">{m.settings_no_sessions()}</p>
				{/each}
			</div>

			<!-- Déconnecter cette session — mobile uniquement, pleine largeur en bas de la liste
			     (à lg, ce bouton est déjà rendu dans le bloc "session courante" ci-dessous) -->
			{#if currentSession}
				<form method="POST" action="/logout" class="mt-3 lg:hidden">
					<Button type="submit" variant="secondary" class="h-11 w-full">
						{m.settings_logout_this_session()}
					</Button>
				</form>
			{/if}

			<!-- Déconnecter les autres — mobile, affiché uniquement si > 1 session active -->
			{#if activeSessions > 1}
				<form method="POST" action="?/revokeOtherSessions" class="mt-2 lg:hidden">
					<Button type="submit" variant="ghost-danger" class="h-11 w-full">
						{m.settings_logout_other_sessions()}
					</Button>
				</form>
			{/if}

			<!-- Session courante — desktop (≥lg) uniquement -->
			{#if currentSession}
				<div
					class="mt-3 hidden flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-200 px-4 py-3.5 lg:flex"
				>
					<div class="flex items-start gap-3">
						<span
							class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-50 text-zinc-500 ring-1 ring-zinc-200"
						>
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linecap="round"
								stroke-linejoin="round"
								aria-hidden="true"
							>
								<rect x="3" y="4" width="18" height="12" rx="2" />
								<path d="M8 20h8M12 16v4" />
							</svg>
						</span>
						<div>
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium text-zinc-900">{m.settings_this_session()}</span>
								<span
									class="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-zinc-500 uppercase"
								>
									{m.settings_current_badge()}
								</span>
							</div>
							<div class="mt-0.5 text-xs text-zinc-500">
								{m.settings_session_created_expires({
									created: formatDate(currentSession.createdAt),
									expires: formatDate(currentSession.expiresAt)
								})}
							</div>
						</div>
					</div>
					<form method="POST" action="/logout">
						<Button type="submit" variant="secondary" size="sm" class="shrink-0"
							>{m.settings_logout_this_session()}</Button
						>
					</form>
				</div>
			{/if}

			<!-- Déconnecter les autres — desktop, affiché uniquement si > 1 session active -->
			{#if activeSessions > 1}
				<form method="POST" action="?/revokeOtherSessions" class="mt-2 hidden lg:block">
					<Button type="submit" variant="secondary" class="w-full"
						>{m.settings_logout_other_sessions()}</Button
					>
				</form>
			{/if}

			<!-- Détail des sessions (repliable, desktop uniquement — la liste mobile ci-dessus
			     affiche déjà toutes les sessions sans repli) -->
			<details
				class="mt-3 hidden lg:block"
				ontoggle={(e) => (sessionsDetailOpen = (e.currentTarget as HTMLDetailsElement).open)}
			>
				<summary
					class="flex cursor-pointer list-none items-center justify-between rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
				>
					<span>{m.settings_sessions_detail_toggle()}</span>
					<svg
						class="h-4 w-4 text-zinc-400 transition-transform"
						class:rotate-180={sessionsDetailOpen}
						viewBox="0 0 20 20"
						aria-hidden="true"
					>
						<path
							d="M5.5 7.5 10 12l4.5-4.5"
							stroke="currentColor"
							stroke-width="1.5"
							fill="none"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</summary>
				<div class="mt-2 overflow-x-auto rounded-xl border border-zinc-200">
					<table class="w-full text-sm">
						<thead>
							<tr
								class="border-b border-zinc-100 text-[11px] tracking-wide text-zinc-400 uppercase"
							>
								<th class="px-4 py-2 text-left font-medium">{m.settings_table_session()}</th>
								<th class="px-4 py-2 text-left font-medium">{m.settings_table_created()}</th>
								<th class="px-4 py-2 text-left font-medium">{m.settings_table_expires()}</th>
								<th class="px-4 py-2 text-right font-medium">{m.settings_table_status()}</th>
								<th class="px-4 py-2 text-right font-medium"
									><span class="sr-only">{m.settings_revoke_session()}</span></th
								>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-100">
							{#each data.sessions as session, i (session.id)}
								<tr>
									<td class="px-4 py-3 font-medium text-zinc-900">
										{#if session.isCurrent}
											{m.settings_this_session()}
										{:else}
											{m.settings_session_n({ n: i + 1 })}
										{/if}
									</td>
									<td class="px-4 py-3 text-zinc-500 tabular-nums">
										{formatDate(session.createdAt)}
									</td>
									<td class="px-4 py-3 text-zinc-500 tabular-nums">
										{formatDate(session.expiresAt)}
									</td>
									<td class="px-4 py-3 text-right">
										<span
											class="rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
											class:bg-emerald-50={session.status === 'active'}
											class:text-emerald-700={session.status === 'active'}
											class:bg-zinc-100={session.status !== 'active'}
											class:text-zinc-500={session.status !== 'active'}
										>
											{session.status === 'active'
												? m.settings_status_active()
												: m.settings_status_revoked()}
										</span>
									</td>
									<td class="px-4 py-3 text-right">
										{#if !session.isCurrent && session.status === 'active'}
											<form method="POST" action="?/revokeSession">
												<input type="hidden" name="sessionId" value={session.id} />
												<Button type="submit" variant="ghost-danger" size="sm">
													{m.settings_revoke_session()}
												</Button>
											</form>
										{/if}
									</td>
								</tr>
							{:else}
								<tr>
									<td colspan="5" class="px-4 py-4 text-center text-sm text-zinc-500">
										{m.settings_no_sessions()}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</details>
		</div>

		<!-- SAUVEGARDE ET RESTAURATION -->
		<div class={card}>
			<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
				{m.settings_backup_heading()}
			</h2>

			{#if form?.restoreSuccess}
				<AlertBanner variant="success" class="mt-3">{form.restoreSuccess}</AlertBanner>
			{/if}

			<!-- Export -->
			<div class="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/50 px-4 py-3.5">
				<div class="flex flex-wrap items-center justify-between gap-4">
					<div>
						<div class="text-sm font-medium text-zinc-900">{m.settings_export_title()}</div>
						<div class="mt-0.5 text-sm text-zinc-500">
							{m.settings_export_description()}
						</div>
					</div>
					<form method="GET" action="/settings/export" class="hidden shrink-0 lg:block">
						<Button type="submit" size="sm">{m.settings_export_cta()}</Button>
					</form>
				</div>
				<form method="GET" action="/settings/export" class="mt-3 lg:hidden">
					<Button type="submit" variant="secondary" class="h-11 w-full">
						{m.settings_export_cta()}
					</Button>
				</form>
			</div>

			<!-- Restauration (repliée, action irréversible) -->
			<div class="mt-3 rounded-xl border border-zinc-200">
				<div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
					<div>
						<div class="text-sm font-medium text-zinc-900">{m.settings_restore_title()}</div>
						<div class="mt-0.5 text-xs text-zinc-500">
							{m.settings_restore_description()}
						</div>
					</div>
					<button
						type="button"
						class="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 lg:h-auto"
						aria-expanded={restoreOpen}
						onclick={() => (restoreOpen = !restoreOpen)}
					>
						{restoreOpen ? m.settings_toggle_hide() : m.settings_toggle_show()}
						<svg
							class="h-3.5 w-3.5 transition-transform"
							class:rotate-180={restoreOpen}
							viewBox="0 0 20 20"
							aria-hidden="true"
						>
							<path
								d="M5.5 7.5 10 12l4.5-4.5"
								stroke="currentColor"
								stroke-width="1.5"
								fill="none"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
				</div>

				{#if restoreOpen}
					<div class="border-t border-zinc-100 px-4 py-4">
						<p
							class="flex items-start gap-2 rounded-xl bg-rose-50 px-3 py-2.5 text-xs font-medium text-rose-600 lg:block lg:rounded-none lg:bg-transparent lg:px-0 lg:py-0"
						>
							<svg
								class="mt-0.5 h-3.5 w-3.5 shrink-0 lg:hidden"
								viewBox="0 0 20 20"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								aria-hidden="true"
							>
								<path d="M10 2 1.5 17h17L10 2Z" stroke-linejoin="round" />
								<path d="M10 8v4" stroke-linecap="round" />
								<circle cx="10" cy="14.5" r="0.75" fill="currentColor" stroke="none" />
							</svg>
							{m.settings_restore_warning()}
						</p>
						<form method="POST" action="?/restoreData" enctype="multipart/form-data" class="mt-3">
							<FileDropZone
								name="backupFile"
								accept="application/json"
								required
								chooseLabel={m.settings_restore_choose_file()}
								noFileLabel={m.settings_restore_no_file_selected()}
								desktopInputClass="lg:w-full lg:text-sm lg:text-zinc-700 lg:file:mr-3 lg:file:rounded-md lg:file:border lg:file:border-zinc-300 lg:file:bg-white lg:file:px-3 lg:file:py-1.5 lg:file:text-sm lg:file:font-medium lg:file:text-zinc-700 lg:hover:file:bg-zinc-50"
								bind:files={restoreFiles}
							/>

							<div class="mt-3 flex justify-end">
								<Button
									type="button"
									variant="ghost-danger"
									size="sm"
									disabled={!hasRestoreFile}
									onclick={() => (restoreConfirmOpen = true)}
									class="hidden lg:inline-flex"
								>
									{m.settings_restore_submit()}
								</Button>
							</div>
							<Button
								type="button"
								variant="ghost-danger"
								disabled={!hasRestoreFile}
								onclick={() => (restoreConfirmOpen = true)}
								class="h-11 w-full lg:hidden"
							>
								{m.settings_restore_submit()}
							</Button>
							{#if form?.restoreError}
								<p class="mt-2 text-xs text-rose-600" role="alert" aria-live="assertive">
									{form.restoreError}
								</p>
							{/if}
							<ConfirmDialog
								open={restoreConfirmOpen}
								title={m.settings_restore_confirm_title()}
								description={m.settings_restore_confirm_description()}
								confirmLabel={m.settings_restore_submit()}
								tone="danger"
								onClose={() => (restoreConfirmOpen = false)}
							>
								<p class="text-sm text-zinc-600">
									{m.settings_restore_confirm_body()}
								</p>
							</ConfirmDialog>
						</form>
					</div>
				{/if}
			</div>
		</div>

		<!-- ASSISTANT IA -->
		<div class={card} class:opacity-50={!data.aiSettings.llmGloballyEnabled}>
			<h2 class="text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
				{m.settings_ai_heading()}
			</h2>
			{#if !data.aiSettings.llmGloballyEnabled}
				<p class="mt-2 text-xs text-zinc-500">{m.settings_ai_disabled_notice()}</p>
			{/if}

			<div class="mt-3 space-y-3">
				<div
					class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-200 px-4 py-3.5"
				>
					<div class="min-w-0">
						<div class="text-sm font-medium text-zinc-900">{m.settings_ai_insights_title()}</div>
						<div class="mt-0.5 text-xs text-zinc-500">
							{m.settings_ai_insights_description()}
						</div>
					</div>
					<form
						method="POST"
						action="?/updateAiInsightsEnabled"
						class="shrink-0"
						bind:this={aiInsightsForm}
					>
						<input
							type="hidden"
							name="enabled"
							value={(!data.aiSettings.insightsEnabled).toString()}
						/>
						<Switch
							checked={data.aiSettings.insightsEnabled}
							disabled={!data.aiSettings.llmGloballyEnabled}
							ariaLabel={m.settings_ai_insights_switch_aria()}
							onchange={() => aiInsightsForm?.requestSubmit()}
						/>
					</form>
				</div>

				<div
					class="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-200 px-4 py-3.5"
				>
					<div class="min-w-0">
						<div class="text-sm font-medium text-zinc-900">{m.settings_ai_labels_title()}</div>
						<div class="mt-0.5 text-xs text-zinc-500">
							{m.settings_ai_labels_description()}
						</div>
					</div>
					<form
						method="POST"
						action="?/updateAiIncludeLabels"
						class="shrink-0"
						bind:this={aiLabelsForm}
					>
						<input
							type="hidden"
							name="enabled"
							value={(!data.aiSettings.includeLabels).toString()}
						/>
						<Switch
							checked={data.aiSettings.includeLabels}
							disabled={!data.aiSettings.llmGloballyEnabled}
							ariaLabel={m.settings_ai_labels_switch_aria()}
							onchange={() => aiLabelsForm?.requestSubmit()}
						/>
					</form>
				</div>
			</div>
		</div>

		<!-- ÉTIQUETTES -->
		<!-- Deliberately no "New tag" affordance anywhere in this section: the design forbids
		     creation from Settings. A tag is created only by typing a name on a transaction. -->
		<div id="tags" class={card}>
			<h2
				bind:this={tagsHeadingEl}
				tabindex="-1"
				class="rounded text-[11px] font-semibold tracking-wide text-zinc-500 uppercase focus:ring-2 focus:ring-zinc-400 focus:outline-none"
			>
				{m.tags_settings_heading()}
			</h2>
			<p class="mt-1 text-sm text-zinc-500">{m.tags_settings_subtitle()}</p>
			<p class="mt-1 text-xs text-zinc-500">{m.tags_settings_auto_delete_note()}</p>

			{#if form?.tagsError}
				<AlertBanner variant="error" class="mt-3">{form.tagsError}</AlertBanner>
			{/if}
			{#if form?.tagsSuccess}
				<AlertBanner variant="success" class="mt-3">{form.tagsSuccess}</AlertBanner>
			{/if}

			{#if data.tags.length === 0}
				<EmptyState card={false} description={m.tags_settings_empty()}>
					{#snippet detail()}
						<p class="text-[13px] leading-relaxed text-zinc-500">
							{m.tags_settings_auto_delete_note()}
						</p>
					{/snippet}
				</EmptyState>
			{:else}
				<ul class="mt-3 space-y-2.5">
					{#each data.tags as tag (tag.id)}
						<li class="rounded-xl border border-zinc-200 p-3.5">
							<div class="flex flex-wrap items-center justify-between gap-3">
								<div class="flex min-w-0 items-center gap-3">
									<TagChips
										tags={[{ key: tag.id, name: tag.name, colorToken: tag.colorToken }]}
										variant="enclosed"
										max={Infinity}
									/>
									<span class="shrink-0 text-xs text-zinc-500"
										>{tagTxCount(tag.transactionCount)}</span
									>
								</div>
								<div class="flex shrink-0 gap-2">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onclick={() => (renamingTag = tag)}
									>
										{m.tags_rename()}
									</Button>
									<Button
										type="button"
										variant="ghost-danger"
										size="sm"
										onclick={() => (deletingTag = tag)}
									>
										{m.common_delete()}
									</Button>
								</div>
							</div>

							<!-- Colour change: one swatch per palette token, each a submit button carrying
							     its own value — no client-side colour computation, the server is the only
							     place that assigns or validates a colorToken.
							     Deliberately no opacity/dimming on the unselected swatches: lagoon and azure
							     are locked colours (see the comment on TAG_COLORS in domain/colors.ts) whose
							     measured contrast ratio must never be reduced, and treating every token the
							     same way here is simpler than carving out an exception for two of nine.
							     Selection is shown with a ring instead. -->
							<form method="POST" action="?/recolorTag" class="mt-3" use:enhance>
								<input type="hidden" name="id" value={tag.id} />
								<ColorSwatchGroup
									name="colorToken"
									options={swatchOptions}
									selected={tag.colorToken}
									ariaLabel={m.tags_settings_color_group_aria({ name: tag.name })}
								/>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<!-- ZONE DANGER -->
		<div>
			<div class="flex items-center gap-2">
				<h2 class="text-[11px] font-semibold tracking-wide text-rose-500 uppercase">
					{m.settings_danger_heading()}
				</h2>
				<div class="h-px flex-1 bg-rose-100"></div>
			</div>

			<div class="mt-3 rounded-xl border border-rose-200 bg-rose-50/40">
				<!-- Trigger row — seul le bouton est interactif, pas toute la ligne -->
				<div class="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
					<div>
						<div class="text-sm font-medium text-rose-700">{m.settings_delete_account_title()}</div>
						<div class="mt-0.5 text-xs text-rose-500/90">
							{m.settings_delete_account_description()}
						</div>
					</div>
					<button
						type="button"
						class="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 lg:h-auto"
						aria-expanded={dangerOpen}
						onclick={() => (dangerOpen = !dangerOpen)}
					>
						{dangerOpen ? m.settings_toggle_hide() : m.settings_toggle_show()}
						<svg
							class="h-3.5 w-3.5 transition-transform"
							class:rotate-180={dangerOpen}
							viewBox="0 0 20 20"
							aria-hidden="true"
						>
							<path
								d="M5.5 7.5 10 12l4.5-4.5"
								stroke="currentColor"
								stroke-width="1.5"
								fill="none"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
				</div>

				{#if dangerOpen}
					<div class="border-t border-rose-100 px-5 py-4">
						<form method="POST" action="?/deleteAccount">
							<label for="danger-confirm" class="block text-xs font-medium text-rose-700">
								{m.settings_delete_confirm_instruction()}
							</label>
							<div class="mt-2 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
								<input
									id="danger-confirm"
									type="text"
									name="confirmation"
									placeholder="SUPPRIMER"
									autocomplete="off"
									bind:value={dangerConfirmValue}
									class="h-11 w-full rounded-xl border border-rose-200 bg-white px-3 text-sm text-zinc-900 placeholder:text-rose-300 focus:border-rose-400 focus:ring-2 focus:ring-rose-200 focus:outline-none lg:w-48"
								/>
								<Button
									type="submit"
									variant="danger"
									size="sm"
									disabled={!deleteConfirmValid}
									class="h-11 w-full lg:h-auto lg:w-auto"
								>
									{m.settings_delete_confirm_submit()}
								</Button>
							</div>
							{#if form?.deleteError}
								<p class="mt-2 text-xs text-rose-600" role="alert" aria-live="assertive">
									{form.deleteError}
								</p>
							{/if}
						</form>
					</div>
				{/if}
			</div>
		</div>
	</section>
</main>

<!-- Modale : modifier le mot de passe -->
<Modal
	open={passwordModalOpen}
	title={m.settings_password_modal_title()}
	description={m.settings_password_modal_description()}
	variant="compact"
	onClose={closePasswordModal}
>
	<!-- Titre/description mobile visibles : le header par défaut de Modal passe sr-only sous lg
	     (cf. variant="compact"). aria-hidden car le nom/description accessibles du dialogue sont
	     déjà portés par le header sr-only. -->
	<div class="mb-4 lg:hidden" aria-hidden="true">
		<p class="text-lg font-bold text-zinc-950">{m.settings_password_modal_title()}</p>
		<p class="mt-1 text-sm text-zinc-500">{m.settings_password_modal_description()}</p>
	</div>
	<form class="space-y-4" method="POST" action="?/changePassword" autocomplete="off">
		<div class="space-y-4">
			<label class="block space-y-1.5 text-sm">
				<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.settings_current_password_label()}
				</span>
				<PasswordInput name="currentPassword" required autocomplete="current-password" />
			</label>

			<label class="block space-y-1.5 text-sm">
				<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.settings_new_password_label()}
				</span>
				<PasswordInput
					name="newPassword"
					required
					minlength={12}
					autocomplete="new-password"
					bind:value={newPasswordValue}
					onblur={() => (newPasswordTouched = true)}
				/>
				{#if newPasswordTooShort}
					<p class="text-xs text-rose-600">{m.settings_password_too_short()}</p>
				{/if}
			</label>

			<label class="block space-y-1.5 text-sm">
				<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.settings_confirm_password_label()}
				</span>
				<PasswordInput
					name="confirmPassword"
					required
					minlength={12}
					autocomplete="new-password"
					bind:value={confirmPasswordValue}
					onblur={() => (confirmPasswordTouched = true)}
				/>
				{#if passwordMismatch}
					<p class="text-xs text-rose-600">{m.settings_password_mismatch()}</p>
				{/if}
			</label>
		</div>

		{#if form?.passwordError}
			<AlertBanner variant="error">{form.passwordError}</AlertBanner>
		{/if}

		<div class="flex gap-2 lg:justify-end lg:gap-3">
			<TapLink class="flex-1 justify-center lg:flex-none" onclick={closePasswordModal}
				>{m.common_cancel()}</TapLink
			>
			<Button type="submit" disabled={submitDisabled} class="h-11 flex-1 lg:h-auto lg:flex-none">
				{m.settings_password_submit()}
			</Button>
		</div>
	</form>
</Modal>

<!-- Modale : activer le TOTP -->
<Modal
	open={mfaSetupModalOpen}
	title={form?.recoveryCodes
		? m.settings_mfa_recovery_codes_title()
		: m.settings_mfa_setup_modal_title()}
	description={form?.recoveryCodes ? undefined : m.settings_mfa_setup_modal_description()}
	variant="compact"
	onClose={closeMfaSetupModal}
>
	{#if form?.recoveryCodes}
		<div class="mb-4 lg:hidden" aria-hidden="true">
			<p class="text-lg font-bold text-zinc-950">{m.settings_mfa_recovery_codes_title()}</p>
		</div>
		<p class="text-sm text-zinc-600">{m.settings_mfa_recovery_codes_description()}</p>
		<div class="mt-4 grid grid-cols-2 gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4">
			{#each form.recoveryCodes as recoveryCode (recoveryCode)}
				<span class="font-mono text-sm text-amber-900">{recoveryCode}</span>
			{/each}
		</div>
		<div class="mt-4 flex justify-end">
			<Button type="button" class="h-11 w-full lg:h-auto lg:w-auto" onclick={closeMfaSetupModal}>
				{m.settings_mfa_recovery_codes_confirm()}
			</Button>
		</div>
	{:else if form?.totpSetupPending}
		<div class="mb-4 lg:hidden" aria-hidden="true">
			<p class="text-lg font-bold text-zinc-950">{m.settings_mfa_setup_modal_title()}</p>
			<p class="mt-1 text-sm text-zinc-500">{m.settings_mfa_setup_modal_description()}</p>
		</div>
		<form class="space-y-4" method="POST" action="?/confirmTotpSetup">
			<input type="hidden" name="secretBase32" value={form.totpSetupPending.secretBase32} />

			<div class="flex justify-center">
				<img
					src={form.totpSetupPending.qrDataUrl}
					alt={m.settings_mfa_setup_qr_alt()}
					class="h-44 w-44 rounded-md border border-zinc-200"
				/>
			</div>

			<div class="space-y-1.5 text-sm">
				<p class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.settings_mfa_setup_secret_label()}
				</p>
				<p
					class="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-sm break-all text-zinc-900"
				>
					{form.totpSetupPending.secretBase32}
				</p>
			</div>

			<label class="block space-y-1.5 text-sm">
				<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.settings_current_password_label()}
				</span>
				<PasswordInput
					name="currentPassword"
					required
					autocomplete="current-password"
					bind:value={mfaSetupPasswordValue}
				/>
			</label>

			<label class="block space-y-1.5 text-sm">
				<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
					{m.settings_mfa_setup_code_label()}
				</span>
				<input
					class="w-full {inputBase}"
					type="text"
					inputmode="numeric"
					name="code"
					required
					autocomplete="one-time-code"
					bind:value={mfaCodeValue}
				/>
			</label>

			{#if form?.totpSetupError}
				<AlertBanner variant="error">{form.totpSetupError}</AlertBanner>
			{/if}

			<div class="flex gap-2 lg:justify-end lg:gap-3">
				<TapLink class="flex-1 justify-center lg:flex-none" onclick={closeMfaSetupModal}
					>{m.common_cancel()}</TapLink
				>
				<Button
					type="submit"
					disabled={mfaCodeValue.length !== 6 || mfaSetupPasswordValue.length === 0}
					class="h-11 flex-1 lg:h-auto lg:flex-none"
				>
					{m.settings_mfa_setup_submit()}
				</Button>
			</div>
		</form>
	{/if}
</Modal>

<!-- Modale : désactiver le TOTP -->
<Modal
	open={mfaDisableModalOpen}
	title={m.settings_mfa_disable_modal_title()}
	description={m.settings_mfa_disable_modal_description()}
	variant="compact"
	onClose={closeMfaDisableModal}
>
	<div class="mb-4 lg:hidden" aria-hidden="true">
		<p class="text-lg font-bold text-zinc-950">{m.settings_mfa_disable_modal_title()}</p>
		<p class="mt-1 text-sm text-zinc-500">{m.settings_mfa_disable_modal_description()}</p>
	</div>
	<form class="space-y-4" method="POST" action="?/disableTotp" autocomplete="off">
		<label class="block space-y-1.5 text-sm">
			<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
				{m.settings_current_password_label()}
			</span>
			<PasswordInput name="currentPassword" required autocomplete="current-password" />
		</label>

		<label class="block space-y-1.5 text-sm">
			<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
				{m.settings_mfa_setup_code_label()}
			</span>
			<input
				class="w-full {inputBase}"
				type="text"
				inputmode="numeric"
				name="code"
				required
				autocomplete="one-time-code"
			/>
		</label>

		{#if form?.totpDisableError}
			<AlertBanner variant="error">{form.totpDisableError}</AlertBanner>
		{/if}

		<div class="flex gap-2 lg:justify-end lg:gap-3">
			<TapLink class="flex-1 justify-center lg:flex-none" onclick={closeMfaDisableModal}
				>{m.common_cancel()}</TapLink
			>
			<Button type="submit" variant="danger" class="h-11 flex-1 lg:h-auto lg:flex-none">
				{m.settings_mfa_disable_submit()}
			</Button>
		</div>
	</form>
</Modal>

<!-- Modale : renommer une étiquette -->
<Modal
	open={renamingTag !== null}
	title={m.tags_rename_modal_title()}
	description={m.tags_rename_modal_description()}
	onClose={() => (renamingTag = null)}
>
	<form
		method="POST"
		action="?/renameTag"
		class="space-y-4"
		use:enhance={() => {
			renameTagSubmitting = true;
			return async ({ result, update }) => {
				await update();
				renameTagSubmitting = false;
				if (result.type === 'success') renamingTag = null;
			};
		}}
	>
		<input type="hidden" name="id" value={renamingTag?.id ?? ''} />
		<label class="grid gap-1 text-sm font-medium text-zinc-700">
			{m.tags_rename_name_label()}
			<input
				name="newName"
				maxlength="60"
				required
				value={renamingTag?.name ?? ''}
				class={inputBase}
			/>
		</label>
		<div class="flex justify-end gap-3 border-t border-zinc-100 pt-4">
			<TapLink onclick={() => (renamingTag = null)} disabled={renameTagSubmitting}
				>{m.common_cancel()}</TapLink
			>
			<Button type="submit" loading={renameTagSubmitting}>{m.common_save()}</Button>
		</div>
	</form>
</Modal>

<!-- ConfirmDialog : supprimer une étiquette -->
<form
	method="POST"
	action="?/deleteTag"
	use:enhance={() => {
		deleteTagSubmitting = true;
		return async ({ result, update }) => {
			await update();
			deleteTagSubmitting = false;
			if (result.type === 'success') deletingTag = null;
		};
	}}
>
	<input type="hidden" name="id" value={deletingTag?.id ?? ''} />
	<ConfirmDialog
		open={deletingTag !== null}
		title={m.tags_delete_confirm_title({ name: deletingTag?.name ?? '' })}
		confirmLabel={m.common_delete()}
		tone="danger"
		confirmLoading={deleteTagSubmitting}
		onClose={() => (deletingTag = null)}
	>
		{#if (deletingTag?.transactionCount ?? 0) > 0}
			<p class="text-sm text-zinc-600">
				{m.tags_delete_confirm_contains()}
				<strong>{tagTxCount(deletingTag!.transactionCount)}</strong>.
				{m.tags_delete_confirm_detach_suffix()}
			</p>
		{:else}
			<p class="text-sm text-zinc-600">{m.tags_delete_confirm_irreversible()}</p>
		{/if}
	</ConfirmDialog>
</form>
