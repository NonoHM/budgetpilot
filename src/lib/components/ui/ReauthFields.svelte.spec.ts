import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
import { REAUTH_FIELDS } from '$lib/domain/reauthFields';
import ReauthFields from './ReauthFields.svelte';

/**
 * The fields carry the names `server/auth/reauth.ts` reads back, through the one constant both
 * import. A literal typed here instead would pass while the form posted a name the server never
 * reads, and that failure looks exactly like a person who left the field empty.
 */
describe('ReauthFields.svelte', () => {
	it('draws the password field, reachable by its label, named for the server, for a password manager', async () => {
		await render(ReauthFields, { asksCode: false, idPrefix: 't1' });

		const input = (await page
			.getByLabelText(m.settings_delete_confirm_password_label())
			.element()) as HTMLInputElement;
		expect(input.name).toBe(REAUTH_FIELDS.password);
		expect(input.type).toBe('password');
		expect(input.autocomplete).toBe('current-password');
		expect(input.required).toBe(true);
	});

	// The two states `asksCode` separates: a password-only action shows no code field, which is
	// what keeps a revoke from asking for something R3 does not require.
	it('draws no code field when the action does not ask for one', async () => {
		const { container } = await render(ReauthFields, { asksCode: false, idPrefix: 't2' });

		expect(container.querySelector(`input[name="${REAUTH_FIELDS.code}"]`)).toBeNull();
	});

	it('draws the code field when asked, labelled, numeric, and offered as a one-time code', async () => {
		await render(ReauthFields, { asksCode: true, idPrefix: 't3' });

		const code = (await page
			.getByLabelText(m.settings_delete_confirm_code_label())
			.element()) as HTMLInputElement;
		expect(code.name).toBe(REAUTH_FIELDS.code);
		expect(code.inputMode).toBe('numeric');
		expect(code.autocomplete).toBe('one-time-code');
		expect(code.required).toBe(true);
	});

	it('takes the label it is given, for the change-password form', async () => {
		await render(ReauthFields, {
			asksCode: false,
			idPrefix: 't4',
			passwordLabel: m.settings_current_password_label()
		});

		const input = (await page
			.getByLabelText(m.settings_current_password_label())
			.element()) as HTMLInputElement;
		expect(input.name).toBe(REAUTH_FIELDS.password);
	});
});
