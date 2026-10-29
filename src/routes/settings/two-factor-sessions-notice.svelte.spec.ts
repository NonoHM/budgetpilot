import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import type { PageData } from './$types';

/**
 * #951: turning two-factor on or off ends every other session (#949), as a password change does, so
 * each of the three dialogs says so before the button. The sentence is one key, and it sits in the
 * dialog's description, which is what a screen reader reads on opening and what shows below lg.
 *
 * Each dialog is reached the way the page reaches it after a refused or pending action. The
 * description is compared as a whole sentence, so a notice dropped from one dialog, or doubled, fails
 * that dialog's test alone.
 */
function baseData(status: 'disabled' | 'enabled' | 'unreadable'): PageData {
	return {
		account: { email: 'demo@example.com', role: 'ADMIN' },
		mfa: { status },
		security: {
			authMode: 'locale',
			runtime: 'local',
			version: '1.2.3',
			latestSessionCreatedAt: null
		},
		sessions: [],
		tags: [],
		columnMappings: [],
		accounts: [],
		accountsInvitation: false,
		accountNameMaxLength: 120,
		linkableNetWorthAccounts: [],
		columnMappingCap: 50,
		rememberedAccounts: []
	} as unknown as PageData;
}

const notice = () => m.settings_other_sessions_logged_out_notice();

/**
 * Both copies of the description, read together so neither goes unread when the other is wrong: the
 * one the dialog points at with aria-describedby (a screen reader, and the header at lg, where the
 * sentence is appended), and the visible one below lg, which is aria-hidden, is what a phone shows,
 * and gives the sentence a paragraph of its own (owner, 2026-10-29: appended, it was the fourth line
 * of the French disable dialog at 390 px). Text alone cannot tell a hidden copy from a shown one (the
 * contradiction pass), so each width also reports whether the sentence sits in a rendered box.
 */
async function descriptions(sentence: string) {
	const dialog = page.getByRole('dialog');
	await expect.element(dialog).toBeInTheDocument();
	const element = dialog.element();
	const id = element.getAttribute('aria-describedby');
	// The copy and every ancestor up to the dialog: an sr-only header is a 1px clipping box whose
	// nowrap paragraph still reports its full width (break B9).
	const boxed = (node: Element | null): boolean => {
		for (let el = node; el && el !== element; el = el.parentElement) {
			const box = el.getBoundingClientRect();
			if (box.width <= 2 || box.height <= 2) return false;
		}
		return true;
	};
	const shown = () =>
		[...element.querySelectorAll('p')].some(
			(p) => [notice(), sentence].includes(p.textContent?.trim() ?? '') && boxed(p)
		);
	await page.viewport(390, 844);
	const shownAt390 = shown();
	await page.viewport(1280, 800);
	const shownAt1280 = shown();
	return {
		described: id ? document.getElementById(id)?.textContent?.trim() : undefined,
		// The paragraphs after the title.
		visible: [...element.querySelectorAll('[aria-hidden="true"] > p')]
			.slice(1)
			.map((p) => p.textContent?.trim()),
		shownAt390,
		shownAt1280
	};
}

/** The dialog's own instruction, if it has one, then the sentence. */
async function expectSaid(instruction: string | null) {
	const parts = instruction ? [instruction, notice()] : [notice()];
	expect(await descriptions(parts.join(' '))).toEqual({
		described: parts.join(' '),
		visible: parts,
		shownAt390: true,
		shownAt1280: true
	});
}

describe('Settings, the dialogs that end other sessions say so (#951)', () => {
	it('turning two-factor on', async () => {
		expect.assertions(2);

		await render(Page, {
			params: {},
			data: baseData('disabled'),
			form: {
				totpSetupPending: { secretBase32: 'JBSWY3DPEHPK3PXP', qrDataUrl: 'data:image/png;base64,' }
			} as never
		});

		await expectSaid(m.settings_mfa_setup_modal_description());
	});

	it('turning two-factor off', async () => {
		expect.assertions(2);

		await render(Page, {
			params: {},
			data: baseData('enabled'),
			form: { totpDisableError: 'refused' } as never
		});

		await expectSaid(m.settings_mfa_disable_modal_description());
	});

	it('turning two-factor off over a secret that no longer decrypts (#904)', async () => {
		expect.assertions(2);

		await render(Page, {
			params: {},
			data: baseData('unreadable'),
			form: { totpDisableError: 'refused' } as never
		});

		await expectSaid(m.settings_mfa_disable_modal_description_unreadable());
	});

	it('changing the password, which said it first', async () => {
		expect.assertions(2);

		await render(Page, {
			params: {},
			data: baseData('disabled'),
			form: { passwordError: 'refused' } as never
		});

		await expectSaid(null);
	});

	// The sentence itself, both catalogues: in the page's own verb (« Log out other sessions »).
	it('reads the same in both catalogues', () => {
		expect({
			en: m.settings_other_sessions_logged_out_notice({}, { locale: 'en' }),
			fr: m.settings_other_sessions_logged_out_notice({}, { locale: 'fr' })
		}).toEqual({
			en: 'Your other sessions will be logged out.',
			fr: 'Vos autres sessions seront déconnectées.'
		});
	});
});
