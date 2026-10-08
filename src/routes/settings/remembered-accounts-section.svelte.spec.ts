import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import type { PageData } from './$types';

/**
 * #599: « COMPTES MÉMORISÉS », asserted on the page that mounts it, built to a private Claude Design
 * canvas: under « Colonnes mémorisées », one row per remembered answer (« ···0185 → Compte joint »),
 * a zinc-500 meta line, a ghost « Oublier » naming the fragment, the danger ConfirmDialog, and an
 * empty state. The owner's condition « visible and revocable » is these assertions.
 */

const ROW = {
	id: 'ra-1',
	fragment: '0185',
	accountName: 'Compte joint',
	useCount: 3,
	rememberedAt: new Date('2026-08-15T12:00:00.000Z')
};

function data(rememberedAccounts: unknown[]): PageData {
	return {
		account: { email: 'demo@example.com', role: 'ADMIN' },
		mfa: { status: 'disabled' },
		security: {
			authMode: 'locale',
			llmEnabled: false,
			runtime: 'local',
			latestSessionCreatedAt: null
		},
		sessions: [],
		tags: [],
		aiSettings: { insightsEnabled: false, includeLabels: false, llmGloballyEnabled: false },
		columnMappings: [],
		columnMappingCap: 50,
		rememberedAccounts,
		accounts: [],
		accountsInvitation: false,
		accountNameMaxLength: 120,
		linkableNetWorthAccounts: []
	} as unknown as PageData;
}

const section = () => document.querySelector('#remembered-accounts') as HTMLElement;

describe('Settings — « Comptes mémorisés »', () => {
	it('sits directly under « Colonnes mémorisées »', async () => {
		// SEPARATES « the canvas's place » FROM « somewhere else on a long page ».
		await render(Page, { params: {}, data: data([ROW]), form: null });
		expect(document.querySelector('#column-mappings')?.nextElementSibling?.id).toBe(
			'remembered-accounts'
		);
	});

	it('reads « ···0185 → Compte joint » with its meta line in zinc-500', async () => {
		await render(Page, { params: {}, data: data([ROW]), form: null });
		const row = section().querySelector('li') as HTMLElement;
		const [line, meta] = row.querySelectorAll('p');
		// Compared WHOLE: the arrow is an aria-hidden icon, so the row's text is fragment then name.
		expect(line.textContent?.replace(/\s+/g, ' ').trim()).toBe('···0185 Compte joint');
		expect(line.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
		expect(meta.textContent?.trim()).toBe(
			`${m.settings_remembered_accounts_remembered_on({ date: '15 août' })} · ${m.settings_remembered_accounts_used({ count: 3 })}`
		);
		// #734: zinc-400 on white fails 4.5:1 at 12 px.
		expect(meta.classList.contains('text-zinc-500')).toBe(true);
	});

	it('says « utilisé 1 fois » through the singular key', async () => {
		await render(Page, { params: {}, data: data([{ ...ROW, useCount: 1 }]), form: null });
		expect(section().textContent).toContain(m.settings_remembered_accounts_used_one({ count: 1 }));
	});

	it('names the fragment on « Oublier », and opens the danger confirmation posting that id', async () => {
		// SEPARATES « one Oublier per row, named for assistive technology » FROM « a bare button
		// whose name repeats on every row ».
		await render(Page, { params: {}, data: data([ROW]), form: null });
		const forget = page.getByRole('button', {
			name: m.settings_remembered_accounts_forget_aria({ fragment: '0185' })
		});
		await expect.element(forget).toBeVisible();
		await userEvent.click(forget);

		await expect
			.element(page.getByRole('heading', { name: m.settings_remembered_accounts_confirm_title() }))
			.toBeVisible();
		await expect
			.element(page.getByText(m.settings_remembered_accounts_confirm_body()))
			.toBeVisible();
		const form = document.querySelector(
			'form[action="?/forgetRememberedAccount"]'
		) as HTMLFormElement;
		expect(form.method).toBe('post');
		expect((form.querySelector('input[name="id"]') as HTMLInputElement).value).toBe('ra-1');
	});

	it('shows the empty state when nothing is remembered', async () => {
		await render(Page, { params: {}, data: data([]), form: null });
		expect(section().textContent).toContain(m.settings_remembered_accounts_empty_title());
		expect(section().textContent).toContain(m.settings_remembered_accounts_empty());
		expect(section().querySelector('li')).toBeNull();
	});
});
