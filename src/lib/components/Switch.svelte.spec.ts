import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Switch from './Switch.svelte';

describe('Switch.svelte', () => {
	it('affiche aria-checked=false et le label fourni quand checked=false', async () => {
		render(Switch, { checked: false, ariaLabel: 'Règle inactive' });

		const toggle = page.getByRole('switch', { name: 'Règle inactive' });
		await expect.element(toggle).toBeInTheDocument();
		await expect.element(toggle).toHaveAttribute('aria-checked', 'false');
	});

	it('affiche aria-checked=true quand checked=true', async () => {
		render(Switch, { checked: true, ariaLabel: 'Règle active' });

		const toggle = page.getByRole('switch', { name: 'Règle active' });
		await expect.element(toggle).toHaveAttribute('aria-checked', 'true');
	});

	it('appelle onchange avec la valeur inversée au clic', async () => {
		const onchange = vi.fn();
		render(Switch, { checked: false, ariaLabel: 'Règle', onchange });

		await userEvent.click(page.getByRole('switch', { name: 'Règle' }));

		expect(onchange).toHaveBeenCalledTimes(1);
		expect(onchange).toHaveBeenCalledWith(true);
	});

	it('ne déclenche pas onchange quand disabled', async () => {
		const onchange = vi.fn();
		render(Switch, { checked: false, ariaLabel: 'Règle', disabled: true, onchange });

		const toggle = page.getByRole('switch', { name: 'Règle' });
		await expect.element(toggle).toBeDisabled();
		await userEvent.click(toggle, { force: true });

		expect(onchange).not.toHaveBeenCalled();
	});
});
