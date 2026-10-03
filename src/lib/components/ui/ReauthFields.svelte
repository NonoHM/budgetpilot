<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { REAUTH_FIELDS } from '$lib/domain/reauthFields';
	import { inputBase } from '$lib/styles';
	import PasswordInput from './PasswordInput.svelte';

	/**
	 * The fields an action that changes security state asks for, drawn once (S1, #253, #228, #229).
	 *
	 * The password field is the change-password modal's, moved here rather than copied: the same
	 * label treatment over the same `PasswordInput`, so paste, the password manager and the eye
	 * toggle work alike everywhere a secret is re-entered (WCAG 2.2 « Accessible Authentication »).
	 * The code field is the delete-account form's, with `one-time-code` so a phone offers the code.
	 *
	 * `asksCode` is the page's knowledge of whether the account has a second factor. It only decides
	 * what is DRAWN: the server asks for a code whatever this rendered, and refuses without one.
	 * The names come from `REAUTH_FIELDS`, the constant the server reads them back by.
	 */
	let {
		asksCode,
		idPrefix,
		passwordLabel = m.settings_delete_confirm_password_label()
	}: {
		asksCode: boolean;
		/** Distinguishes two instances on one page, for the code input's label association. */
		idPrefix: string;
		passwordLabel?: string;
	} = $props();
</script>

<div class="space-y-4 text-left">
	<label class="block space-y-1.5 text-sm">
		<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
			{passwordLabel}
		</span>
		<PasswordInput name={REAUTH_FIELDS.password} required autocomplete="current-password" />
	</label>

	{#if asksCode}
		<label for="{idPrefix}-code" class="block space-y-1.5 text-sm">
			<span class="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
				{m.settings_delete_confirm_code_label()}
			</span>
			<input
				id="{idPrefix}-code"
				name={REAUTH_FIELDS.code}
				type="text"
				inputmode="numeric"
				pattern="[0-9]{6}"
				maxlength={6}
				required
				autocomplete="one-time-code"
				class="w-full {inputBase}"
			/>
		</label>
	{/if}
</div>
