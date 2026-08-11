<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Button from '$lib/components/Button.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import Combobox from '$lib/components/ui/Combobox.svelte';
	import Switch from '$lib/components/Switch.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import SearchBar from '$lib/components/ui/SearchBar.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import { cardBase, inputBase } from '$lib/styles';
	import Badge from '$lib/components/ui/Badge.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { categoryDisplayName } from '$lib/domain/categoryLabels';
	import { natureLabel } from '$lib/domain/natureLabels';
	import { isTransactionNature } from '$lib/domain/transaction';
	import * as m from '$lib/paraglide/messages';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type Rule = PageData['rules'][number];

	let searchRules = $state('');
	let showDefaults = $state(true);
	let createRuleOpen = $state(false);
	let editingRule: Rule | null = $state(null);
	let deleteRuleId: string | null = $state(null);
	let applyConfirmOpen = $state(false);
	let ruleIsRegex = $state(false);
	let targetCategoryValue = $state('');
	let desktopToggleForms: Record<string, HTMLFormElement> = {};
	let mobileToggleForms: Record<string, HTMLFormElement> = {};
	let optimisticEnabled: Record<string, boolean> = $state({});
	let restoreDefaultsSubmitting = $state(false);
	let ruleFormSubmitting = $state(false);
	let applySubmitting = $state(false);
	let deleteSubmitting = $state(false);

	const targetCategoryOptions = $derived.by(() => {
		const options = data.categories.map((c) => ({
			value: c.name,
			label: categoryDisplayName(c.name)
		}));
		const currentTarget = editingRule?.targetCategory;
		if (currentTarget && !data.categories.some((c) => c.name === currentTarget)) {
			options.push({ value: currentTarget, label: categoryDisplayName(currentTarget) });
		}
		return options;
	});

	function effectiveEnabled(rule: Rule): boolean {
		return rule.id in optimisticEnabled ? optimisticEnabled[rule.id] : rule.enabled;
	}

	function handleToggleSubmit(rule: Rule): SubmitFunction {
		// `rule` is only captured once at mount (use:enhance has no Svelte-side
		// update() method): never re-read rule.enabled here, it would stay
		// frozen on its initial value after the first toggle. The up-to-date
		// value is already in formData (hidden input reactively bound in
		// the template), so we just read it back as-is.
		return ({ formData }) => {
			const newEnabled = formData.get('enabled') === 'true';
			optimisticEnabled[rule.id] = newEnabled;
			return async ({ update }) => {
				await update();
				delete optimisticEnabled[rule.id];
			};
		};
	}

	function openCreateRuleModal() {
		ruleIsRegex = false;
		targetCategoryValue = '';
		createRuleOpen = true;
	}

	function openEditRuleModal(rule: Rule) {
		ruleIsRegex = rule.isRegex;
		targetCategoryValue = rule.targetCategory;
		editingRule = rule;
	}

	let filteredRules = $derived(
		data.rules
			.filter((r) => showDefaults || r.defaultRuleKey === null)
			.filter(
				(r) =>
					searchRules.trim() === '' ||
					r.name.toLowerCase().includes(searchRules.toLowerCase()) ||
					r.matchText.toLowerCase().includes(searchRules.toLowerCase()) ||
					r.targetCategory.toLowerCase().includes(searchRules.toLowerCase())
			)
	);

	function formatNatureLabel(nature: string | null) {
		return nature && isTransactionNature(nature) ? natureLabel(nature) : m.categories_nature_none();
	}

	function closeRuleModal() {
		createRuleOpen = false;
		editingRule = null;
		targetCategoryValue = '';
	}
</script>

<svelte:head>
	<title>{m.rules_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<section class="mx-auto max-w-6xl space-y-4">
		{#if form?.error}
			<AlertBanner variant="error">{form.error}</AlertBanner>
		{/if}
		{#if form?.success}
			<AlertBanner variant="success">{form.success}</AlertBanner>
		{/if}

		<!-- ============ DESKTOP (≥lg, unchanged) ============ -->
		<div class="hidden rounded-lg border border-zinc-200 bg-white lg:block">
			<div class="space-y-4 p-5">
				<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<h2 class="text-xl font-semibold">{m.rules_heading()}</h2>
						<p class="mt-1 text-sm text-zinc-500">
							{m.rules_subtitle()}
						</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<label
							class="flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700"
						>
							<Switch
								checked={showDefaults}
								ariaLabel={m.rules_toggle_show_defaults()}
								onchange={(v) => (showDefaults = v)}
							/>
							{m.rules_toggle_show_defaults()}
						</label>
						<form
							method="POST"
							action="?/restoreDefaults"
							use:enhance={() => {
								restoreDefaultsSubmitting = true;
								return async ({ update }) => {
									await update();
									restoreDefaultsSubmitting = false;
								};
							}}
						>
							<Button type="submit" variant="ghost" size="sm" loading={restoreDefaultsSubmitting}
								>{m.rules_restore_defaults()}</Button
							>
						</form>
						<Button href="/rules?preview=1" variant="secondary" size="sm">
							{m.rules_preview()}
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onclick={() => (applyConfirmOpen = true)}>{m.rules_apply()}</Button
						>
						<Button type="button" size="sm" onclick={openCreateRuleModal}>{m.rules_new()}</Button>
					</div>
				</div>

				{#if data.preview}
					<div class="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
						<p class="text-sm font-medium">
							{m.rules_preview_count({ count: data.preview.count })}
						</p>
						{#if data.preview.examples.length > 0}
							<div class="mt-3 overflow-x-auto">
								<table class="w-full min-w-[640px] text-left text-sm">
									<thead class="text-xs text-zinc-500 uppercase">
										<tr class="border-b border-zinc-200">
											<th class="py-2 pr-4 font-medium">{m.rules_preview_label()}</th>
											<th class="py-2 pr-4 font-medium">{m.rules_preview_current()}</th>
											<th class="py-2 pr-4 font-medium">{m.rules_preview_target()}</th>
											<th class="py-2 font-medium">{m.rules_preview_rule()}</th>
										</tr>
									</thead>
									<tbody>
										{#each data.preview.examples as item (item.transactionId)}
											<tr class="border-b border-zinc-100 last:border-0">
												<td class="py-2 pr-4 font-mono text-xs">{item.labelPreview}</td>
												<td class="py-2 pr-4 text-zinc-600"
													>{categoryDisplayName(item.currentCategory)}</td
												>
												<td class="py-2 pr-4">{categoryDisplayName(item.targetCategory)}</td>
												<td class="py-2 text-zinc-600">{item.ruleName}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}
					</div>
				{/if}

				<div>
					<label for="search-rules" class="sr-only">{m.rules_search_label()}</label>
					<SearchBar
						id="search-rules"
						placeholder={m.rules_search_placeholder()}
						bind:value={searchRules}
						clearLabel={m.common_search_clear_aria()}
						wrapperClass="w-full max-w-sm"
						inputClass="placeholder:text-zinc-400"
					/>
				</div>

				{#if data.rules.length === 0}
					<EmptyState
						card={false}
						description={m.rules_empty()}
						ctaLabel={m.rules_create_first()}
						onCtaClick={openCreateRuleModal}
					/>
				{:else if filteredRules.length === 0}
					<div class="flex items-center gap-3 py-6">
						<p class="text-sm text-zinc-500">{m.rules_no_match()}</p>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							class="underline underline-offset-2"
							onclick={() => (searchRules = '')}>{m.rules_clear_search()}</Button
						>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full min-w-[760px] text-left text-sm">
							<thead class="text-xs text-zinc-500 uppercase">
								<tr class="border-b border-zinc-200">
									<th class="py-2.5 pr-4 font-medium">{m.rules_table_name()}</th>
									<th class="py-2.5 pr-4 font-medium">{m.rules_table_match()}</th>
									<th class="py-2.5 pr-4 font-medium">{m.rules_table_category()}</th>
									<th class="py-2.5 pr-4 font-medium">{m.rules_table_nature()}</th>
									<th class="py-2.5 pr-4 font-medium">{m.rules_table_status()}</th>
									<th class="py-2.5 text-right font-medium">{m.rules_table_actions()}</th>
								</tr>
							</thead>
							<tbody>
								{#each filteredRules as rule (rule.id)}
									<tr class="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
										<td class="py-2.5 pr-4 font-medium">
											{rule.name}
											{#if rule.defaultRuleKey !== null}
												<Badge tone="neutral" shape="rounded">{m.rules_badge_default()}</Badge>
											{/if}
										</td>
										<td class="py-2.5 pr-4 font-mono text-xs text-zinc-600">
											{rule.matchText}
											{#if rule.isRegex}
												<Badge tone="neutral" shape="rounded">{m.rules_badge_regex()}</Badge>
											{/if}
										</td>
										<td class="py-2.5 pr-4">{categoryDisplayName(rule.targetCategory)}</td>
										<td class="py-2.5 pr-4 text-zinc-600">{formatNatureLabel(rule.targetNature)}</td
										>
										<td class="py-2.5 pr-4">
											<form
												method="POST"
												action="?/toggle"
												bind:this={desktopToggleForms[rule.id]}
												use:enhance={handleToggleSubmit(rule)}
												class="flex items-center gap-2"
											>
												<input type="hidden" name="id" value={rule.id} />
												<input
													type="hidden"
													name="enabled"
													value={effectiveEnabled(rule) ? 'false' : 'true'}
												/>
												<Switch
													checked={effectiveEnabled(rule)}
													ariaLabel={effectiveEnabled(rule)
														? m.rules_status_active()
														: m.rules_status_inactive()}
													onchange={() => desktopToggleForms[rule.id]?.requestSubmit()}
												/>
												<!-- The EFFECTIVE state, which is not the switch's state (#161). `enabled` is the
												     user's own intent and stays under their control; a paused rule is one whose
												     target category no longer exists, and it does not fire whatever the switch
												     says. Showing "Active" beside a rule that cannot run is the false claim this
												     whole change exists to remove, so the word tracks what actually happens. -->
												<span
													class="text-xs font-medium {rule.paused
														? 'text-zinc-500'
														: effectiveEnabled(rule)
															? 'text-emerald-700'
															: 'text-zinc-500'}"
												>
													{rule.paused
														? m.rules_status_paused()
														: effectiveEnabled(rule)
															? m.rules_status_active()
															: m.rules_status_inactive()}
												</span>
											</form>
											<!-- Zinc, never rose: the user did nothing wrong, they deleted a category, which
											     is an ordinary thing to do. The plate settles this for the staged split
											     removal the same way. And the state carries a WORD above rather than relying
											     on the colour, so the reason here is an explanation, not the signal. -->
											{#if rule.paused}
												<p class="mt-1 max-w-[22ch] text-xs text-zinc-500">
													{m.rules_paused_reason()}
												</p>
												<p class="mt-0.5 max-w-[22ch] text-xs text-zinc-400">
													{m.rules_paused_hint()}
												</p>
											{/if}
										</td>
										<td class="py-2.5 text-right">
											<div class="flex justify-end gap-2">
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onclick={() => openEditRuleModal(rule)}>{m.rules_edit()}</Button
												>
												<Button
													type="button"
													variant="ghost-danger"
													size="sm"
													onclick={() => (deleteRuleId = rule.id)}>{m.common_delete()}</Button
												>
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>
		</div>

		<!-- ============ MOBILE (<lg) ============ -->
		<div class="space-y-4 lg:hidden">
			<div>
				<h2 class="text-xl font-semibold">{m.rules_heading()}</h2>
				<p class="mt-1 text-sm text-zinc-500">{m.rules_subtitle()}</p>
			</div>

			<div class="flex items-center justify-between gap-3 {cardBase} px-4 py-3">
				<label class="flex items-center gap-2 text-sm font-medium text-zinc-700">
					<Switch
						checked={showDefaults}
						ariaLabel={m.rules_toggle_show_defaults()}
						onchange={(v) => (showDefaults = v)}
					/>
					{m.rules_toggle_show_defaults()}
				</label>
			</div>
			<form
				method="POST"
				action="?/restoreDefaults"
				use:enhance={() => {
					restoreDefaultsSubmitting = true;
					return async ({ update }) => {
						await update();
						restoreDefaultsSubmitting = false;
					};
				}}
			>
				<Button
					type="submit"
					variant="secondary"
					size="field"
					class="w-full"
					loading={restoreDefaultsSubmitting}
				>
					{m.rules_restore_defaults()}
				</Button>
			</form>

			<div class="flex gap-2">
				<Button href="/rules?preview=1" variant="secondary" size="field" class="flex-1">
					{m.rules_preview()}
				</Button>
				<Button
					type="button"
					variant="secondary"
					size="field"
					class="flex-1"
					onclick={() => (applyConfirmOpen = true)}
				>
					{m.rules_apply()}
				</Button>
			</div>
			<Button type="button" size="field" class="w-full" onclick={openCreateRuleModal}>
				{m.rules_new()}
			</Button>

			{#if data.preview}
				<div class="{cardBase} p-5">
					<p class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">
						{m.rules_preview_heading_mobile()}
					</p>
					<p class="mt-2 text-2xl leading-tight font-bold text-zinc-950">
						{m.rules_preview_count({ count: data.preview.count })}
					</p>
					{#if data.preview.examples.length > 0}
						<div class="mt-4 divide-y divide-zinc-100">
							{#each data.preview.examples as item (item.transactionId)}
								<div class="py-3 first:pt-0 last:pb-0">
									<p class="font-mono text-xs text-zinc-700">{item.labelPreview}</p>
									<p class="mt-1 text-sm">
										<span class="text-zinc-400 italic"
											>{categoryDisplayName(item.currentCategory)}</span
										>
										<span class="text-zinc-400"> → </span>
										<span class="font-semibold text-zinc-950"
											>{categoryDisplayName(item.targetCategory)}</span
										>
									</p>
								</div>
							{/each}
						</div>
						{#if data.preview.count > data.preview.examples.length}
							<p class="mt-1 text-xs text-zinc-400">
								{m.rules_preview_more({ count: data.preview.count - data.preview.examples.length })}
							</p>
						{/if}
					{/if}
					<Button
						type="button"
						class="mt-4 h-11 w-full !rounded-xl"
						onclick={() => (applyConfirmOpen = true)}
					>
						{m.rules_apply_confirm_label()}
					</Button>
				</div>
			{/if}

			<div>
				<label for="search-rules-mobile" class="sr-only">{m.rules_search_label()}</label>
				<SearchBar
					id="search-rules-mobile"
					placeholder={m.rules_search_placeholder()}
					bind:value={searchRules}
					clearLabel={m.common_search_clear_aria()}
					wrapperClass="w-full"
					inputClass="!bg-zinc-50 placeholder:text-zinc-400"
				/>
			</div>

			{#if data.rules.length === 0}
				{#snippet emptyIcon()}
					<svg
						class="h-5 w-5 text-zinc-400"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<path d="M4 6h16M8 12h8M11 18h2" />
					</svg>
				{/snippet}
				<EmptyState
					icon={emptyIcon}
					description={m.rules_empty()}
					ctaLabel={m.rules_create_first()}
					onCtaClick={openCreateRuleModal}
				/>
			{:else if filteredRules.length === 0}
				<div class="flex flex-col items-center gap-2 py-6 text-center">
					<p class="text-sm text-zinc-500">{m.rules_no_match()}</p>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						class="underline underline-offset-2"
						onclick={() => (searchRules = '')}
					>
						{m.rules_clear_search()}
					</Button>
				</div>
			{:else}
				<div class="space-y-3">
					{#each filteredRules as rule (rule.id)}
						<div class={effectiveEnabled(rule) ? '' : 'opacity-60'}>
							<ListCard expandAriaLabel={m.rules_delete_expand_aria({ name: rule.name })}>
								<div class="flex items-start justify-between gap-3">
									<p class="min-w-0 font-bold text-zinc-950">
										{rule.name}
										{#if rule.defaultRuleKey !== null}
											<Badge tone="neutral" shape="rounded">{m.rules_badge_default()}</Badge>
										{/if}
									</p>
									<div class="-my-2.5 flex shrink-0 items-center gap-2">
										<form
											method="POST"
											action="?/toggle"
											bind:this={mobileToggleForms[rule.id]}
											use:enhance={handleToggleSubmit(rule)}
										>
											<input type="hidden" name="id" value={rule.id} />
											<input
												type="hidden"
												name="enabled"
												value={effectiveEnabled(rule) ? 'false' : 'true'}
											/>
											<Switch
												checked={effectiveEnabled(rule)}
												ariaLabel={effectiveEnabled(rule)
													? m.rules_status_active()
													: m.rules_status_inactive()}
												onchange={() => mobileToggleForms[rule.id]?.requestSubmit()}
											/>
										</form>
										<IconButton label={m.rules_edit()} onclick={() => openEditRuleModal(rule)}>
											<svg
												class="h-4 w-4"
												viewBox="0 0 20 20"
												fill="none"
												stroke="currentColor"
												stroke-width="1.6"
												stroke-linecap="round"
												stroke-linejoin="round"
												aria-hidden="true"
											>
												<path d="M13.5 3.5 16.5 6.5 6.5 16.5H3.5V13.5Z" />
											</svg>
										</IconButton>
									</div>
								</div>
								<p class="mt-1 font-mono text-xs text-zinc-400 italic">
									{rule.matchText}
									{#if rule.isRegex}
										<Badge tone="neutral" shape="rounded">{m.rules_badge_regex()}</Badge>
									{/if}
								</p>
								<p class="mt-1 text-sm text-zinc-500">
									{categoryDisplayName(rule.targetCategory)} · {formatNatureLabel(
										rule.targetNature
									)}
								</p>
								<!-- #161, always visible rather than behind the card's `details` disclosure. The
								     reason a rule is not firing is the first thing the user needs, not a detail:
								     hiding it would leave the card looking exactly like a working rule, which is
								     the silent failure the pause exists to replace. -->
								{#if rule.paused}
									<p class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
										<Badge tone="neutral" shape="rounded">{m.rules_status_paused()}</Badge>
										{m.rules_paused_reason()}
									</p>
									<p class="mt-0.5 text-xs text-zinc-400">{m.rules_paused_hint()}</p>
								{/if}
								{#snippet details()}
									<div class="flex items-center justify-end">
										<IconButton
											tone="danger"
											label={m.common_delete()}
											onclick={() => (deleteRuleId = rule.id)}
										>
											<svg
												class="h-4 w-4"
												viewBox="0 0 20 20"
												fill="none"
												stroke="currentColor"
												stroke-width="1.6"
												stroke-linecap="round"
												stroke-linejoin="round"
												aria-hidden="true"
											>
												<path
													d="M4 6h12M8 6V4.5A1.5 1.5 0 0 1 9.5 3h1A1.5 1.5 0 0 1 12 4.5V6M6 6v9.5A1.5 1.5 0 0 0 7.5 17h5A1.5 1.5 0 0 0 14 15.5V6"
												/>
											</svg>
										</IconButton>
									</div>
								{/snippet}
							</ListCard>
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Modal: create/edit rule -->
		<Modal
			open={createRuleOpen || editingRule !== null}
			title={editingRule ? m.rules_modal_edit_title() : m.rules_modal_create_title()}
			description={editingRule ? undefined : m.rules_modal_create_description()}
			variant="compact"
			onClose={closeRuleModal}
		>
			<!-- Visible mobile title: Modal's default header goes sr-only below lg
			     (see variant="compact"). aria-hidden since the dialog's accessible name is
			     already carried by the sr-only header. -->
			<p class="mb-4 text-lg font-bold text-zinc-950 lg:hidden" aria-hidden="true">
				{editingRule ? m.rules_modal_edit_title() : m.rules_modal_create_title()}
			</p>
			<form
				method="POST"
				action={editingRule ? '?/update' : '?/create'}
				class="space-y-4"
				use:enhance={() => {
					ruleFormSubmitting = true;
					return async ({ result, update }) => {
						await update();
						ruleFormSubmitting = false;
						if (result.type === 'success') closeRuleModal();
					};
				}}
			>
				{#if editingRule}
					<input type="hidden" name="id" value={editingRule.id} />
				{/if}
				<label class="grid gap-1 text-sm font-medium text-zinc-700">
					{m.rules_field_name()}
					<input
						name="name"
						value={editingRule?.name ?? ''}
						maxlength="80"
						required
						placeholder={m.rules_field_name_placeholder()}
						class={inputBase}
					/>
				</label>
				<label class="grid gap-1 text-sm font-medium text-zinc-700">
					{m.rules_field_match()}
					<div class="flex items-center gap-2">
						<IconButton
							pressed={ruleIsRegex}
							label={m.rules_regex_toggle_aria()}
							title={m.rules_regex_toggle_aria()}
							onclick={() => (ruleIsRegex = !ruleIsRegex)}
						>
							r
						</IconButton>
						<input
							name="matchText"
							value={editingRule?.matchText ?? ''}
							maxlength="80"
							required
							placeholder={ruleIsRegex
								? m.rules_field_match_placeholder_regex()
								: m.rules_field_match_placeholder()}
							class="{inputBase} flex-1 font-mono"
						/>
					</div>
					{#if ruleIsRegex}
						<p class="text-xs font-normal text-zinc-500">{m.rules_regex_note_lookbehind()}</p>
					{/if}
				</label>
				<input type="hidden" name="isRegex" value={ruleIsRegex ? 'true' : 'false'} />
				<label class="grid gap-1 text-sm font-medium text-zinc-700">
					{m.rules_field_target_category()}
					<input type="hidden" name="targetCategory" value={targetCategoryValue} />
					<Combobox
						value={targetCategoryValue}
						options={targetCategoryOptions}
						ariaLabel={m.rules_field_target_category()}
						placeholder={m.transactions_rule_target_category_placeholder()}
						onValueChange={(v) => {
							targetCategoryValue = v;
						}}
					/>
				</label>
				<label class="grid gap-1 text-sm font-medium text-zinc-700">
					{m.rules_field_target_nature()}
					<Select
						name="targetNature"
						value={editingRule?.targetNature ?? ''}
						ariaLabel={m.rules_field_target_nature()}
						options={[
							{ value: '', label: '—' },
							...data.natureOptions.map((n) => ({ value: n, label: formatNatureLabel(n) }))
						]}
					/>
				</label>
				<div class="flex justify-end gap-3 border-t border-zinc-100 pt-4">
					<TapLink onclick={closeRuleModal} disabled={ruleFormSubmitting}
						>{m.common_cancel()}</TapLink
					>
					<Button type="submit" loading={ruleFormSubmitting}
						>{editingRule ? m.common_save() : m.rules_create_submit()}</Button
					>
				</div>
			</form>
		</Modal>

		<!-- Confirm applying the rules -->
		<form
			method="POST"
			action="?/apply"
			use:enhance={() => {
				applySubmitting = true;
				return async ({ result, update }) => {
					await update();
					applySubmitting = false;
					if (result.type === 'success') applyConfirmOpen = false;
				};
			}}
		>
			<ConfirmDialog
				open={applyConfirmOpen}
				title={m.rules_apply_confirm_title()}
				confirmLabel={m.rules_apply_confirm_label()}
				confirmLoading={applySubmitting}
				onClose={() => (applyConfirmOpen = false)}
			>
				<p class="text-sm text-zinc-600">
					{#if data.preview}
						{m.rules_apply_confirm_count({ count: data.preview.count })}
					{:else}
						{m.rules_apply_confirm_all()}
					{/if}
				</p>
			</ConfirmDialog>
		</form>

		<!-- Confirm rule deletion -->
		<form
			method="POST"
			action="?/delete"
			use:enhance={() => {
				deleteSubmitting = true;
				return async ({ result, update }) => {
					await update();
					deleteSubmitting = false;
					if (result.type === 'success') deleteRuleId = null;
				};
			}}
		>
			<input type="hidden" name="id" value={deleteRuleId ?? ''} />
			<ConfirmDialog
				open={deleteRuleId !== null}
				title={m.rules_delete_confirm_title()}
				confirmLabel={m.common_delete()}
				tone="danger"
				confirmLoading={deleteSubmitting}
				onClose={() => (deleteRuleId = null)}
			>
				<p class="text-sm text-zinc-600">{m.rules_delete_confirm_body()}</p>
			</ConfirmDialog>
		</form>
	</section>
</main>
