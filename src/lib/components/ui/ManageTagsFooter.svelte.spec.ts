import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ManageTagsFooter from './ManageTagsFooter.svelte';
import * as m from '$lib/paraglide/messages';

/**
 * The row that answers "where does a tag go when I want it gone from everywhere".
 *
 * Both assertions are about computed properties of a live node — the resolved element role and
 * the accessible name — which is why this renders rather than reading source text.
 */
describe('ManageTagsFooter', () => {
	it('is a link to the tags section of Settings, not a button', async () => {
		expect.assertions(2);
		render(ManageTagsFooter);

		// A link, because the destination is an address: middle-click and open-in-new-tab must work.
		// getByRole('link') resolves only for an <a> that actually carries an href, so this fails
		// both if the element becomes a <button> and if the href is dropped.
		const link = page.getByRole('link', { name: m.tags_manage_footer_aria() });
		await expect.element(link).toBeInTheDocument();
		expect(link.element().getAttribute('href')).toBe('/settings#tags');
	});

	it('renders the second line visibly, since that is what answers "how do I delete"', async () => {
		expect.assertions(2);
		render(ManageTagsFooter);

		const sub = page.getByText(m.tags_manage_footer_sub());
		await expect.element(sub).toBeInTheDocument();
		// Not aria-hidden: a row that announces a destination without announcing a capability is
		// the thing this whole row exists to stop being.
		expect(sub.element().closest('[aria-hidden="true"]')).toBeNull();
	});
});
