import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import IconButton from './IconButton.svelte';

function iconSnippet() {
	return createRawSnippet(() => ({
		render: () => '<svg aria-hidden="true"><path /></svg>'
	}));
}

describe('IconButton.svelte', () => {
	it('renders aria-label from the label prop', async () => {
		render(IconButton, { label: 'Supprimer', children: iconSnippet() });

		await expect.element(page.getByRole('button', { name: 'Supprimer' })).toBeInTheDocument();
	});

	it('applies the neutral tone color classes by default', async () => {
		render(IconButton, { label: 'Modifier', tone: 'neutral', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Modifier' }).element();
		expect(button.className).toContain('text-zinc-500');
		expect(button.className).not.toContain('text-rose-600');
	});

	/**
	 * NEUTRAL AT REST, and this assertion was reversed by Planche 5e rather than relaxed.
	 *
	 * It read `toContain('text-rose-600')`. Brique 1's own clause says « tone danger (poubelle) :
	 * neutre au repos, rose seulement au hover/focus », so the resting rose was the code deviating
	 * from the brick it is registered under, and the test was pinning the deviation.
	 *
	 * Both halves are asserted, because the change is a pair: the rest loses the tint and the hover
	 * keeps it. Asserting only the first would pass on a control that had lost its danger tone
	 * entirely.
	 */
	it('rests neutral and reserves rose for hover, focus and press', async () => {
		render(IconButton, { label: 'Supprimer', tone: 'danger', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Supprimer' }).element();
		expect(button.className).toContain('text-zinc-700');
		expect(button.className).not.toContain('text-rose-600');
		expect(button.className).toContain('hover:text-rose-700');
		expect(button.className).toContain('data-[pressed]:text-rose-700');
	});

	it('sets aria-pressed=true and the active visual state when pressed=true', async () => {
		render(IconButton, { label: 'Regex', shape: 'box', pressed: true, children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Regex' });
		await expect.element(button).toHaveAttribute('aria-pressed', 'true');
		expect(button.element().className).toContain('bg-zinc-900');
	});

	it('sets aria-pressed=false when pressed=false', async () => {
		render(IconButton, { label: 'Regex', shape: 'box', pressed: false, children: iconSnippet() });

		await expect
			.element(page.getByRole('button', { name: 'Regex' }))
			.toHaveAttribute('aria-pressed', 'false');
	});

	it('omits aria-pressed entirely when pressed is not provided (non-toggle button)', async () => {
		render(IconButton, { label: 'Fermer', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Fermer' }).element();
		expect(button.hasAttribute('aria-pressed')).toBe(false);
	});

	it('applies distinct classes for the circle shape (default)', async () => {
		render(IconButton, { label: 'Fermer', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Fermer' }).element();
		expect(button.className).toContain('rounded-full');
		expect(button.className).not.toContain('border');
	});

	it('applies distinct classes for the box shape', async () => {
		render(IconButton, { label: 'Regex', shape: 'box', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Regex' }).element();
		expect(button.className).toContain('rounded-md');
		expect(button.className).toContain('border');
	});

	it('applies distinct classes for the pill shape', async () => {
		render(IconButton, { label: 'Regex', shape: 'pill', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Regex' }).element();
		expect(button.className).toContain('rounded-full');
		expect(button.className).toContain('border');
		expect(button.className).toContain('px-2.5');
	});

	it('renders with a minimum 44x44px touch target regardless of shape', async () => {
		render(IconButton, { label: 'Fermer', children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Fermer' }).element();
		expect(button.className).toContain('min-h-11');
		expect(button.className).toContain('min-w-11');
	});

	it('disables the button and does not fire onclick when disabled', async () => {
		const onclick = vi.fn();
		render(IconButton, { label: 'Fermer', disabled: true, onclick, children: iconSnippet() });

		const button = page.getByRole('button', { name: 'Fermer' });
		await expect.element(button).toBeDisabled();
		await userEvent.click(button, { force: true });

		expect(onclick).not.toHaveBeenCalled();
	});

	it('fires onclick when enabled', async () => {
		const onclick = vi.fn();
		render(IconButton, { label: 'Fermer', onclick, children: iconSnippet() });

		await userEvent.click(page.getByRole('button', { name: 'Fermer' }));

		expect(onclick).toHaveBeenCalledTimes(1);
	});

	it('defaults to type="button"', async () => {
		render(IconButton, { label: 'Fermer', children: iconSnippet() });

		await expect
			.element(page.getByRole('button', { name: 'Fermer' }))
			.toHaveAttribute('type', 'button');
	});

	it('renders type="submit" when explicitly set', async () => {
		render(IconButton, { label: 'Envoyer', type: 'submit', children: iconSnippet() });

		await expect
			.element(page.getByRole('button', { name: 'Envoyer' }))
			.toHaveAttribute('type', 'submit');
	});

	/**
	 * `softDisabled`, added because design 1q makes "neutralised, not mute" law for every
	 * `aria-disabled` control in the app rather than for primary actions only. The floor cross and
	 * the ceiling add button in the split editor are both IconButtons, and both must be able to say
	 * why they are off — which a natively `disabled` button cannot do, being unreachable.
	 */
	it('neutralises with aria-disabled and stays focusable, never native disabled', async () => {
		render(IconButton, {
			label: 'Retirer la part 2',
			softDisabled: true,
			'aria-describedby': 'floor-hint',
			children: iconSnippet()
		});

		const button = page.getByRole('button', { name: 'Retirer la part 2' }).element();
		expect(button.getAttribute('aria-disabled')).toBe('true');
		// The whole point: not `disabled`, so it is still in the tab order and can carry a reason.
		expect(button.hasAttribute('disabled')).toBe(false);
		expect(button.getAttribute('aria-describedby')).toBe('floor-hint');

		(button as HTMLElement).focus();
		expect(document.activeElement).toBe(button);
	});

	it('swallows the click while soft-disabled, and lets it through once it is not', async () => {
		const onclick = vi.fn<() => void>();
		const { rerender } = render(IconButton, {
			label: 'Retirer la part 2',
			softDisabled: true,
			onclick,
			children: iconSnippet()
		});

		// `.click()` on the element rather than `userEvent.click`, and the reason is the finding:
		// Playwright's actionability check treats `aria-disabled="true"` as not-enabled and simply
		// waits forever, so it can never exercise the swallow. A programmatic or assistive-technology
		// activation is under no such restraint and DOES reach the handler — which is exactly why the
		// component has to swallow it rather than rely on being un-clickable.
		const button = page.getByRole('button', { name: 'Retirer la part 2' }).element() as HTMLElement;
		button.click();
		expect(onclick).not.toHaveBeenCalled();

		await rerender({
			label: 'Retirer la part 2',
			softDisabled: false,
			onclick,
			children: iconSnippet()
		});
		(page.getByRole('button', { name: 'Retirer la part 2' }).element() as HTMLElement).click();
		expect(onclick).toHaveBeenCalledTimes(1);
	});
});
