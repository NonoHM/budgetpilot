import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AppNav from './AppNav.svelte';

describe('AppNav.svelte', () => {
	it('opens the mobile "More" menu and lists Rules/Imports/Net Worth as plain navigation links', async () => {
		render(AppNav, { active: 'dashboard' });

		const moreTrigger = page.getByRole('button', { name: "Plus d'options de navigation" });
		await expect.element(moreTrigger).toHaveAttribute('aria-expanded', 'false');

		await userEvent.click(moreTrigger);

		await expect.element(moreTrigger).toHaveAttribute('aria-expanded', 'true');

		const rulesLink = page.getByRole('menuitem', { name: 'Règles' });
		const importsLink = page.getByRole('menuitem', { name: 'Imports' });
		const netWorthLink = page.getByRole('menuitem', { name: 'Patrimoine' });

		await expect.element(rulesLink).toHaveAttribute('href', '/rules');
		await expect.element(importsLink).toHaveAttribute('href', '/imports');
		await expect.element(netWorthLink).toHaveAttribute('href', '/net-worth');

		// Plain navigation links, not forms/buttons: no submission side effect to worry about here,
		// unlike AccountMenu's logout item.
		for (const link of [rulesLink, importsLink, netWorthLink]) {
			expect(link.element().tagName).toBe('A');
		}
	});

	it('marks the active "More" item with aria-current=page and does not mark the others', async () => {
		render(AppNav, { active: 'rules' });

		await userEvent.click(page.getByRole('button', { name: "Plus d'options de navigation" }));

		await expect
			.element(page.getByRole('menuitem', { name: 'Règles' }))
			.toHaveAttribute('aria-current', 'page');
		await expect
			.element(page.getByRole('menuitem', { name: 'Imports' }))
			.not.toHaveAttribute('aria-current');
	});

	it('does not render the "More" menu items before the trigger is clicked', async () => {
		render(AppNav, { active: 'dashboard' });

		await expect.element(page.getByRole('menuitem', { name: 'Règles' })).not.toBeInTheDocument();
	});
});
