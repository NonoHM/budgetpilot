import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import type { PageData } from './$types';

/**
 * #904: an account whose stored two-factor secret no longer decrypts. The factor is still there, so
 * the switch stays on; no code can pass it, so the row says the one way back; and turning it off
 * asks for a recovery code, which is what the server then accepts in that field.
 *
 * The state is produced by Settings `load` (`mfa.status`, from `storedFactorState`), asserted in
 * `page.server.spec.ts`; this file is what the page makes of it. Each test carries its readable
 * counterpart, so a page that ignored `status` cannot pass both.
 */
function baseData(status: 'disabled' | 'enabled' | 'unreadable'): PageData {
	return {
		account: { email: 'demo@example.com', role: 'ADMIN' },
		mfa: { status },
		security: {
			authMode: 'locale',
			llmEnabled: false,
			runtime: 'local',
			version: '1.2.3',
			latestSessionCreatedAt: null
		},
		sessions: [],
		tags: [],
		aiSettings: { insightsEnabled: false, includeLabels: false, llmGloballyEnabled: false },
		columnMappings: [],
		accounts: [],
		accountsInvitation: false,
		accountNameMaxLength: 120,
		linkableNetWorthAccounts: [],
		columnMappingCap: 50,
		rememberedAccounts: []
	} as unknown as PageData;
}

/** A refused disable re-opens its dialog, which is how the dialog is reached without a click. */
const disableRefused = { totpDisableError: 'refused' };

describe('Settings, two-factor whose secret no longer decrypts (#904)', () => {
	it('says the way back, where an enabled factor says it is enabled', async () => {
		expect.assertions(2);

		await render(Page, { params: {}, data: baseData('unreadable'), form: null });

		await expect.element(page.getByText(m.settings_mfa_status_unreadable())).toBeInTheDocument();
		expect(page.getByText(m.settings_mfa_description_enabled()).elements()).toHaveLength(0);
	});

	// Still a factor: the switch reads on, and pressing it opens the disable dialog, not enrolment.
	it('keeps the switch on', async () => {
		expect.assertions(1);

		await render(Page, { params: {}, data: baseData('unreadable'), form: null });

		await expect
			.element(page.getByRole('switch', { name: m.settings_mfa_switch_aria() }))
			.toHaveAttribute('aria-checked', 'true');
	});

	it('the disable dialog asks for a recovery code on a text keyboard', async () => {
		expect.assertions(3);

		await render(Page, { params: {}, data: baseData('unreadable'), form: disableRefused as never });

		const field = page.getByRole('textbox', { name: m.settings_mfa_recovery_code_label() });
		await expect.element(field).toHaveAttribute('inputmode', 'text');
		await expect.element(field).toHaveAttribute('autocomplete', 'off');
		await expect
			.element(page.getByText(m.settings_mfa_disable_modal_description_unreadable()).first())
			.toBeInTheDocument();
	});

	// The other actions that ask for a code still ask for one (the contradiction pass on the code):
	// a form that dropped the field would post the password alone and read « Incorrect password or
	// code. ». A refused delete re-opens its panel; the account with no factor is the calibration.
	it('deleting the account still asks for a code, where an account with no factor is not asked', async () => {
		expect.assertions(3);

		await render(Page, {
			params: {},
			data: baseData('unreadable'),
			form: { deleteError: 'refused' } as never
		});
		// Waited for, so the count below reads a rendered panel rather than the framework's batching.
		await expect
			.element(page.getByText(m.settings_delete_confirm_password_label()).first())
			.toBeInTheDocument();
		const unreadable = page.getByText(m.settings_delete_confirm_code_label()).elements().length;
		document.body.innerHTML = '';

		await render(Page, {
			params: {},
			data: baseData('disabled'),
			form: { deleteError: 'refused' } as never
		});
		await expect
			.element(page.getByText(m.settings_delete_confirm_password_label()).first())
			.toBeInTheDocument();
		expect({
			unreadable,
			disabled: page.getByText(m.settings_delete_confirm_code_label()).elements().length
		}).toEqual({ unreadable: 1, disabled: 0 });
	});

	it('the calibration: a readable factor keeps the six-digit field and its numeric keyboard', async () => {
		expect.assertions(2);

		await render(Page, { params: {}, data: baseData('enabled'), form: disableRefused as never });

		const field = page.getByRole('textbox', { name: m.settings_mfa_setup_code_label() });
		await expect.element(field).toHaveAttribute('inputmode', 'numeric');
		expect(
			page.getByRole('textbox', { name: m.settings_mfa_recovery_code_label() }).elements()
		).toHaveLength(0);
	});
});
