import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import type { PageData } from './$types';

// Settings' tags section (src/routes/settings/+page.svelte, between the load-bearing
// `<!-- ÉTIQUETTES -->` and `<!-- ZONE DANGER -->` comments — see
// tags-no-create-affordance.spec.ts) is the arrival state for a deep link from the
// ManageTagsFooter row ("Gérer dans Paramètres") mounted on the transaction-side tag panels
// (feat/tags-discoverability Task 2). This suite proves the three things that link depends on:
// an anchor to land on, a heading that can take programmatic focus, and the sentence explaining
// the one silent, undocumented lifecycle event (a tag emptied of transactions disappears with no
// banner, confirmation or log — a locked product decision, not a gap).

function baseData(overrides: Partial<PageData> = {}): PageData {
	return {
		account: { email: 'demo@example.com', role: 'ADMIN' },
		mfa: { enabled: false },
		security: {
			authMode: 'locale',
			llmEnabled: false,
			runtime: 'local',
			latestSessionCreatedAt: null
		},
		sessions: [],
		tags: [{ id: 't1', name: 'Voyage', colorToken: 'ochre', transactionCount: 3 }],
		aiSettings: { insightsEnabled: false, includeLabels: false, llmGloballyEnabled: false },
		...overrides
	} as PageData;
}

describe('Settings — arrival at the tags section', () => {
	it('the section carries the anchor the panel footer links at', async () => {
		expect.assertions(1);
		const { container } = render(Page, { params: {}, data: baseData(), form: null });
		expect(container.querySelector('#tags')).not.toBeNull();
	});

	it('the heading is programmatically focusable, so the deep link can land on it', async () => {
		expect.assertions(1);
		render(Page, { params: {}, data: baseData(), form: null });
		const heading = page
			.getByRole('heading', { name: m.tags_settings_heading(), level: 2 })
			.element();
		expect(heading.getAttribute('tabindex')).toBe('-1');
	});

	it('states the silent auto-deletion rule, in the section and in the empty state', async () => {
		expect.assertions(2);
		render(Page, { params: {}, data: baseData(), form: null });
		await expect.element(page.getByText(m.tags_settings_auto_delete_note())).toBeInTheDocument();

		render(Page, { params: {}, data: baseData({ tags: [] }), form: null });
		expect(page.getByText(m.tags_settings_auto_delete_note()).elements().length).toBeGreaterThan(0);
	});
});
