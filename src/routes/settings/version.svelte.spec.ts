import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import type { PageData } from './$types';

/**
 * The app displayed its own version NOWHERE — not in Settings, not in a footer, not in a header.
 * So "which version am I running" was answerable only by reading the `.env` that pins the image,
 * and unanswerable for anyone who did not install it themselves.
 *
 * That is also what made the install docs' pinning problem worse than it looked: a user left on a
 * stale `latest` had no way to discover it from inside the product.
 *
 * It sits beside « Environnement » because that block is already the page's answer to "what is
 * this instance", and a version is the same question.
 */
function baseData(overrides: Partial<PageData> = {}): PageData {
	return {
		account: { email: 'demo@example.com', role: 'ADMIN' },
		mfa: { enabled: false },
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
		// The Comptes section reads these four. Present and empty rather than absent: the page reads
		// `data.accounts.length`, so an omitted key is a render crash rather than an empty section,
		// and this file is about a different section arriving intact beside it.
		accounts: [],
		accountsInvitation: false,
		accountNameMaxLength: 120,
		linkableNetWorthAccounts: [],
		columnMappingCap: 50,
		...overrides
	} as PageData;
}

describe('Settings — the running version', () => {
	it('names the version it is running, labelled', async () => {
		expect.assertions(2);

		render(Page, { params: {}, data: baseData(), form: null });

		await expect.element(page.getByText(m.settings_version_label()).first()).toBeInTheDocument();
		await expect.element(page.getByText('1.2.3').first()).toBeInTheDocument();
	});
});
