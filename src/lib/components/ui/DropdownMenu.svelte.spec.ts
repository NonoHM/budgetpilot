import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import DropdownMenu from './DropdownMenu.svelte';

function triggerSnippet() {
	return createRawSnippet(() => ({
		render: () => '<span data-testid="trigger-content">Open menu</span>'
	}));
}

function childrenSnippet() {
	return createRawSnippet(() => ({
		render: () => '<div data-testid="menu-content">Menu body</div>'
	}));
}

describe('ui/DropdownMenu.svelte', () => {
	it('renders the trigger snippet content inside a button carrying the given aria-label', async () => {
		render(DropdownMenu, {
			triggerAriaLabel: 'Ouvrir le menu',
			trigger: triggerSnippet(),
			children: childrenSnippet()
		});

		const trigger = page.getByRole('button', { name: 'Ouvrir le menu' });
		await expect.element(trigger).toBeInTheDocument();
		await expect.element(page.getByTestId('trigger-content')).toBeInTheDocument();
	});

	it('does not render the children snippet content while closed', async () => {
		render(DropdownMenu, {
			triggerAriaLabel: 'Ouvrir le menu',
			trigger: triggerSnippet(),
			children: childrenSnippet()
		});

		await expect.element(page.getByTestId('menu-content')).not.toBeInTheDocument();
	});

	it('opens the menu and renders the children snippet content when the trigger is clicked', async () => {
		render(DropdownMenu, {
			triggerAriaLabel: 'Ouvrir le menu',
			trigger: triggerSnippet(),
			children: childrenSnippet()
		});

		const trigger = page.getByRole('button', { name: 'Ouvrir le menu' });
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');

		await userEvent.click(trigger);

		await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect.element(page.getByTestId('menu-content')).toBeInTheDocument();
	});

	it('renders the children content immediately when open is passed as true (bindable prop accepts an initial value)', async () => {
		render(DropdownMenu, {
			open: true,
			triggerAriaLabel: 'Ouvrir le menu',
			trigger: triggerSnippet(),
			children: childrenSnippet()
		});

		await expect.element(page.getByTestId('menu-content')).toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Ouvrir le menu' }))
			.toHaveAttribute('aria-expanded', 'true');
	});

	it('applies triggerClass and contentClass to the trigger and content elements', async () => {
		render(DropdownMenu, {
			open: true,
			triggerAriaLabel: 'Ouvrir le menu',
			triggerClass: 'my-trigger-class',
			contentClass: 'my-content-class',
			trigger: triggerSnippet(),
			children: childrenSnippet()
		});

		const trigger = page.getByRole('button', { name: 'Ouvrir le menu' }).element();
		expect(trigger.className).toContain('my-trigger-class');

		const content = page.getByTestId('menu-content').element().closest('[role="menu"]');
		expect(content?.className).toContain('my-content-class');
	});
});
