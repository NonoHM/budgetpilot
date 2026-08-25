<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import type { ActionData, PageData } from './$types';
	import Button from '$lib/components/Button.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Select from '$lib/components/ui/Select.svelte';
	import IconButton from '$lib/components/ui/IconButton.svelte';
	import ListCard from '$lib/components/ui/ListCard.svelte';
	import TapLink from '$lib/components/ui/TapLink.svelte';
	import { inputBase } from '$lib/styles';
	import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
	import { categoryDisplayName } from '$lib/domain/categoryLabels';
	import { natureLabel } from '$lib/domain/natureLabels';
	import { isTransactionNature } from '$lib/domain/transaction';
	import { resolveCategoryColorClass } from '$lib/domain/colors';
	import * as m from '$lib/paraglide/messages';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	type CategoryRow = PageData['categories'][number];

	let createOpen = $state(false);
	let renamingCategory: CategoryRow | null = $state(null);
	let deletingCategory: CategoryRow | null = $state(null);
	let savedNatureIds = $state(new Set<string>());
	let restoreDefaultsSubmitting = $state(false);
	let adoptSubmitting = $state(false);
	let dismissPromptForm: HTMLFormElement | null = $state(null);
	let createSubmitting = $state(false);
	let renameSubmitting = $state(false);
	let deleteSubmitting = $state(false);

	// Per-row state for nature selects: value overrides and form refs for auto-submit.
	let natureValues = $state<Record<string, string>>({});
	let natureFormRefs = $state<Record<string, HTMLFormElement | null>>({});

	function getNatureValue(catId: string, defaultNature: string | null): string {
		return catId in natureValues ? natureValues[catId] : (defaultNature ?? '');
	}

	function formatNatureLabel(nature: string | null): string {
		return nature && isTransactionNature(nature) ? natureLabel(nature) : m.categories_nature_none();
	}

	/**
	 * The actionable half of a refusal: an obstacle and the path to it, in one breath.
	 *
	 * Read through one narrow cast rather than off `form` directly. `ActionData` is the union of
	 * every `fail()` shape this route returns, and only `deleteCategory`'s "used by parts" branch
	 * carries a link — `'errorLink' in form` narrows the OTHER members to `{}` rather than giving
	 * this one back, so the property has to be named once, here, with its type. Keeping the cast to
	 * a single line beside the type it asserts is the point: the alternative was two `in` checks
	 * scattered through the markup, each silently typed `{}`.
	 */
	const errorLink = $derived(
		form && 'errorLink' in form
			? ((form as { errorLink?: { href: string; label: string } }).errorLink ?? null)
			: null
	);

	function pluralTx(n: number): string {
		return n > 1
			? m.categories_delete_tx_count_many({ count: n })
			: m.categories_delete_tx_count_one({ count: n });
	}
</script>

<svelte:head>
	<title>{m.categories_page_title()}</title>
</svelte:head>

<main class="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950 sm:px-6 lg:px-8">
	<div class="mx-auto max-w-4xl">
		{#if form?.error}
			<AlertBanner variant="error" class="mb-4">
				{form.error}
				<!-- The obstacle and the path in one breath. Rendered as a real link rather than
				     interpolated into the sentence: the message stays translatable as prose, and no
				     catalogue entry has to carry markup.
				     See `errorLink` in the script for why it is read through a typed local. -->
				{#if errorLink}
					<a
						href={resolve(errorLink.href as `/transactions?${string}`)}
						class="ml-1 font-medium underline underline-offset-2"
					>
						{errorLink.label}
					</a>
				{/if}
			</AlertBanner>
		{/if}
		{#if form?.success}
			<AlertBanner variant="success" class="mb-4">{form.success}</AlertBanner>
		{/if}

		<!-- #162's offer. `data.renamePrompt` is null unless there is something to rename AND the
		     user has not declined, so there is no condition to restate here.

		     Zinc, not amber: the user did nothing wrong and nothing is broken. Their categories are
		     stored under the names they were created with, which is a fact rather than a fault, and
		     an amber banner would be the app apologising for its own data model. -->
		{#if data.renamePrompt}
			<!-- Bound once here because the action snippet is a closure: `data.renamePrompt` is
			     narrowed by the `{#if}` in the banner's own body but not inside the snippet, so
			     without this the count would have to be re-checked for null down there. -->
			{@const promptCount = data.renamePrompt.count}
			<form
				bind:this={dismissPromptForm}
				method="POST"
				action="?/dismissRenamePrompt"
				class="hidden"
				aria-hidden="true"
				use:enhance={() =>
					async ({ update }) => {
						await update();
					}}
			></form>
			<AlertBanner
				variant="info"
				class="mb-4"
				dismissLabel={m.categories_rename_prompt_dismiss_aria()}
				onDismiss={() => dismissPromptForm?.requestSubmit()}
			>
				{promptCount === 1
					? m.categories_rename_prompt_body_one()
					: m.categories_rename_prompt_body({ count: promptCount })}
				{#snippet action()}
					<form
						method="POST"
						action="?/adoptDefaultNames"
						class="shrink-0"
						use:enhance={() => {
							adoptSubmitting = true;
							return async ({ update }) => {
								await update();
								adoptSubmitting = false;
							};
						}}
					>
						<!-- A submit button styled as the banner's own action, per AlertBanner's
						     contract: the banner's tone rather than TapLink's default, and an
						     always-visible underline, since an action inside a sentence has no
						     surrounding "this is clickable" context to lean on. -->
						<button
							type="submit"
							disabled={adoptSubmitting}
							class="rounded-sm font-medium text-zinc-900 underline underline-offset-2 hover:text-zinc-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-60"
						>
							{promptCount === 1
								? m.categories_rename_prompt_action_one()
								: m.categories_rename_prompt_action()}
						</button>
					</form>
				{/snippet}
			</AlertBanner>
		{/if}
	</div>

	<section class="mx-auto max-w-4xl space-y-4">
		<!-- ============ DESKTOP (≥lg, unchanged) ============ -->
		<div class="hidden rounded-lg border border-zinc-200 bg-white lg:block">
			<div class="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
				<div>
					<h1 class="text-xl font-semibold">{m.categories_heading()}</h1>
					<p class="mt-0.5 text-sm text-zinc-500">{m.categories_subtitle()}</p>
				</div>
				<div class="flex items-center gap-2">
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
							>{m.categories_restore_defaults()}</Button
						>
					</form>
					{#if data.categories.length > 0}
						<Button type="button" size="sm" onclick={() => (createOpen = true)}
							>{m.categories_new()}</Button
						>
					{/if}
				</div>
			</div>

			{#if data.categories.length === 0}
				<EmptyState
					card={false}
					description={m.categories_empty()}
					ctaLabel={m.categories_create_cta()}
					onCtaClick={() => (createOpen = true)}
				/>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full min-w-[560px] text-left text-sm">
						<thead class="text-xs text-zinc-500 uppercase">
							<tr class="border-b border-zinc-200">
								<th class="px-5 py-2.5 font-medium">{m.categories_table_name()}</th>
								<th class="px-5 py-2.5 font-medium">{m.categories_table_nature()}</th>
								<th class="px-5 py-2.5 text-right font-medium"
									>{m.categories_table_transactions()}</th
								>
								<th class="sr-only px-5 py-2.5 text-right">{m.categories_table_actions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each data.categories as cat (cat.id)}
								<tr class="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
									<td class="px-5 py-2.5 font-medium">{categoryDisplayName(cat.name)}</td>
									<td class="px-5 py-2.5">
										<form
											bind:this={natureFormRefs[cat.id]}
											method="POST"
											action="?/updateNature"
											use:enhance={() => {
												return ({ update }) => {
													update({ reset: false }).then(() => {
														// Plain Set + copy-and-reassign idiom (not SvelteSet): already correct and
														// tested as-is; migrating to SvelteSet's in-place add()/delete() is a real
														// reactivity-pattern change, deferred rather than forced during this lint cleanup.
														// eslint-disable-next-line svelte/prefer-svelte-reactivity
														savedNatureIds = new Set([...savedNatureIds, cat.id]);
														setTimeout(() => {
															savedNatureIds.delete(cat.id);
															savedNatureIds = new Set(savedNatureIds);
														}, 1200);
													});
												};
											}}
										>
											<input type="hidden" name="categoryName" value={cat.name} />
											<input type="hidden" name="mappingId" value={cat.mappingId ?? ''} />
											<input
												type="hidden"
												name="nature"
												value={getNatureValue(cat.id, cat.nature)}
											/>
											<div class="flex items-center gap-1.5">
												<Select
													value={getNatureValue(cat.id, cat.nature)}
													ariaLabel={m.categories_nature_aria({
														name: categoryDisplayName(cat.name)
													})}
													options={[
														{ value: '', label: m.categories_nature_none() },
														...data.natureOptions.map((n) => ({
															value: n,
															label: formatNatureLabel(n)
														}))
													]}
													onValueChange={async (v) => {
														natureValues[cat.id] = v;
														await tick();
														natureFormRefs[cat.id]?.requestSubmit();
													}}
												/>
												{#if savedNatureIds.has(cat.id)}
													<span aria-hidden="true" class="text-xs text-emerald-500">✓</span>
												{/if}
											</div>
										</form>
									</td>
									<td class="px-5 py-2.5 text-right text-zinc-500 tabular-nums">
										{cat.transactionCount}
									</td>
									<td class="px-5 py-2.5 text-right">
										{#if cat.name !== UNCLASSIFIED_CATEGORY}
											<div class="flex justify-end gap-2">
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onclick={() => (renamingCategory = cat)}>{m.categories_rename()}</Button
												>
												<Button
													type="button"
													variant="ghost-danger"
													size="sm"
													onclick={() => (deletingCategory = cat)}>{m.common_delete()}</Button
												>
											</div>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</section>

	<!-- ============ MOBILE (<lg) ============ -->
	<section class="mx-auto max-w-4xl space-y-4 lg:hidden">
		<div>
			<h1 class="text-xl font-semibold">{m.categories_heading()}</h1>
			<p class="mt-1 text-sm text-zinc-500">{m.categories_subtitle()}</p>
		</div>

		<div class="flex flex-col gap-2.5">
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
					class="h-11 w-full !rounded-xl"
					loading={restoreDefaultsSubmitting}
				>
					{m.categories_restore_defaults()}
				</Button>
			</form>
			{#if data.categories.length > 0}
				<Button type="button" class="h-11 w-full !rounded-xl" onclick={() => (createOpen = true)}>
					{m.categories_new()}
				</Button>
			{/if}
		</div>

		{#if data.categories.length === 0}
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
					<circle cx="12" cy="12" r="8" />
					<path d="M12 8.5v7M8.5 12h7" />
				</svg>
			{/snippet}
			<EmptyState
				icon={emptyIcon}
				description={m.categories_empty()}
				ctaLabel={m.categories_create_cta()}
				onCtaClick={() => (createOpen = true)}
			/>
		{:else}
			<div class="space-y-3">
				{#each data.categories as cat (cat.id)}
					{@const isUnclassified = cat.name === UNCLASSIFIED_CATEGORY}
					{#snippet categoryPrimary()}
						<div class="flex items-center gap-2.5">
							<span
								class="h-3.5 w-3.5 shrink-0 rounded-[5px] {resolveCategoryColorClass(
									cat.name,
									UNCLASSIFIED_CATEGORY
								)}"
								aria-hidden="true"
							></span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<span class="text-[15.5px] font-bold text-zinc-950"
										>{categoryDisplayName(cat.name)}</span
									>
									{#if isUnclassified}
										<span
											class="flex h-[18px] shrink-0 items-center rounded-md bg-zinc-100 px-1.5 text-[10px] font-bold tracking-wide text-zinc-500 uppercase"
										>
											{m.categories_system_badge()}
										</span>
									{/if}
								</div>
								<p class="mt-0.5 text-[12.5px] text-zinc-400">{pluralTx(cat.transactionCount)}</p>
							</div>
							{#if !isUnclassified}
								<IconButton
									class="shrink-0"
									label={m.categories_rename_aria({
										name: categoryDisplayName(cat.name)
									})}
									onclick={() => (renamingCategory = cat)}
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
										<path d="M13.5 3.5 16.5 6.5 6.5 16.5H3.5V13.5Z" />
									</svg>
								</IconButton>
							{/if}
						</div>

						<form
							bind:this={natureFormRefs[cat.id]}
							method="POST"
							action="?/updateNature"
							class="mt-3.5"
							use:enhance={() => {
								return ({ update }) => {
									update({ reset: false }).then(() => {
										savedNatureIds = new Set([...savedNatureIds, cat.id]);
										setTimeout(() => {
											savedNatureIds.delete(cat.id);
											savedNatureIds = new Set(savedNatureIds);
										}, 1200);
									});
								};
							}}
						>
							<input type="hidden" name="categoryName" value={cat.name} />
							<input type="hidden" name="mappingId" value={cat.mappingId ?? ''} />
							<input type="hidden" name="nature" value={getNatureValue(cat.id, cat.nature)} />
							<div class="relative">
								<Select
									value={getNatureValue(cat.id, cat.nature)}
									ariaLabel={m.categories_nature_aria({
										name: categoryDisplayName(cat.name)
									})}
									class="!bg-zinc-50"
									options={[
										{ value: '', label: m.categories_nature_none() },
										...data.natureOptions.map((n) => ({ value: n, label: formatNatureLabel(n) }))
									]}
									onValueChange={async (v) => {
										natureValues[cat.id] = v;
										await tick();
										natureFormRefs[cat.id]?.requestSubmit();
									}}
								/>
								{#if savedNatureIds.has(cat.id)}
									<span
										aria-hidden="true"
										class="pointer-events-none absolute top-1/2 right-3.5 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-emerald-100"
									>
										<svg class="h-3 w-3 text-emerald-600" viewBox="0 0 20 20" fill="none">
											<path
												d="M4.5 10.5 8 14l7.5-9"
												stroke="currentColor"
												stroke-width="2.2"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									</span>
								{/if}
							</div>
						</form>
					{/snippet}

					{#if isUnclassified}
						<ListCard>
							{@render categoryPrimary()}
						</ListCard>
					{:else}
						<ListCard
							expandAriaLabel={m.categories_delete_expand_aria({
								name: categoryDisplayName(cat.name)
							})}
						>
							{@render categoryPrimary()}
							{#snippet details()}
								<div class="flex items-center justify-end">
									<IconButton
										tone="danger"
										label={m.common_delete()}
										onclick={() => (deletingCategory = cat)}
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
					{/if}
				{/each}
			</div>
		{/if}
	</section>
</main>

<!-- Modal: create a category -->
<Modal
	open={createOpen}
	title={m.categories_create_modal_title()}
	description={m.categories_create_modal_description()}
	onClose={() => (createOpen = false)}
>
	<form
		method="POST"
		action="?/createCategory"
		class="space-y-4"
		use:enhance={() => {
			createSubmitting = true;
			return async ({ result, update }) => {
				await update();
				createSubmitting = false;
				if (result.type === 'success') createOpen = false;
			};
		}}
	>
		<label class="grid gap-1 text-sm font-medium text-zinc-700">
			{m.categories_name_label()}
			<input name="name" maxlength="80" required class={inputBase} />
		</label>
		<div class="flex justify-end gap-3 border-t border-zinc-100 pt-4">
			<TapLink onclick={() => (createOpen = false)} disabled={createSubmitting}
				>{m.common_cancel()}</TapLink
			>
			<Button type="submit" loading={createSubmitting}>{m.categories_create_submit()}</Button>
		</div>
	</form>
</Modal>

<!-- Modal: rename a category -->
<Modal
	open={renamingCategory !== null}
	title={m.categories_rename_modal_title()}
	description={m.categories_rename_modal_description()}
	onClose={() => (renamingCategory = null)}
>
	<form
		method="POST"
		action="?/renameCategory"
		class="space-y-4"
		use:enhance={() => {
			renameSubmitting = true;
			return async ({ result, update }) => {
				await update();
				renameSubmitting = false;
				if (result.type === 'success') renamingCategory = null;
			};
		}}
	>
		<input type="hidden" name="id" value={renamingCategory?.id ?? ''} />
		<label class="grid gap-1 text-sm font-medium text-zinc-700">
			{m.categories_rename_name_label()}
			<input
				name="newName"
				maxlength="80"
				required
				value={renamingCategory ? renamingCategory.name : ''}
				class={inputBase}
			/>
		</label>
		<div class="flex justify-end gap-3 border-t border-zinc-100 pt-4">
			<TapLink onclick={() => (renamingCategory = null)} disabled={renameSubmitting}
				>{m.common_cancel()}</TapLink
			>
			<Button type="submit" loading={renameSubmitting}>{m.common_save()}</Button>
		</div>
	</form>
</Modal>

<!-- ConfirmDialog: delete a category -->
<form
	method="POST"
	action="?/deleteCategory"
	use:enhance={() => {
		deleteSubmitting = true;
		return async ({ result, update }) => {
			await update();
			deleteSubmitting = false;
			if (result.type === 'success') deletingCategory = null;
		};
	}}
>
	<input type="hidden" name="id" value={deletingCategory?.id ?? ''} />
	<ConfirmDialog
		open={deletingCategory !== null}
		title={m.categories_delete_confirm_title({
			name: deletingCategory ? categoryDisplayName(deletingCategory.name) : ''
		})}
		confirmLabel={m.common_delete()}
		tone="danger"
		confirmLoading={deleteSubmitting}
		onClose={() => (deletingCategory = null)}
	>
		{#if (deletingCategory?.transactionCount ?? 0) > 0}
			<p class="text-sm text-zinc-600">
				{m.categories_delete_confirm_contains()}
				<strong>{pluralTx(deletingCategory!.transactionCount)}</strong>.
				{m.categories_delete_confirm_moved_prefix()}
				<em>{categoryDisplayName(UNCLASSIFIED_CATEGORY)}</em>.
			</p>
		{:else}
			<p class="text-sm text-zinc-600">{m.categories_delete_confirm_irreversible()}</p>
		{/if}
		<!-- #161: the consequence stated BEFORE the action, on its own line rather than folded into
		     the sentence above, because it is a different subject. The transaction line is about
		     money that moves; this is about automation that stops, and it survives the `{:else}`
		     branch above precisely because a category with no transactions can still be the target
		     of rules the user wrote months ago and has not thought about since. -->
		{#if (deletingCategory?.pausedRuleCount ?? 0) > 0}
			<p class="mt-2 text-sm text-zinc-600">
				{(deletingCategory?.pausedRuleCount ?? 0) > 1
					? m.categories_delete_rules_paused_many({ count: deletingCategory!.pausedRuleCount })
					: m.categories_delete_rules_paused_one({ count: deletingCategory!.pausedRuleCount })}
			</p>
		{/if}
	</ConfirmDialog>
</form>
