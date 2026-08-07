import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Combobox from './Combobox.svelte';
import '../../../routes/layout.css';

/**
 * The `size` prop, added for design 1k: « tous les contrôles passent à 48 px, le plancher de 44
 * l'emporte sans exception d'écran ». Before it, the only way to reach 48 was `triggerClass="h-12"`,
 * appended to a class string that already contains `h-11` — which leaves the winner to Tailwind's
 * generated source order rather than to anything written at the call site. That fails by silently
 * changing height, not by going red, which is why it is a prop.
 *
 * Measured, not read off the class list. A class name is evidence that a rule was requested; the
 * computed height is evidence it won. Those are different claims, and this repo has been caught by
 * the difference before.
 */
describe('Combobox.svelte — field height', () => {
	const options = [
		{ value: 'alimentation', label: 'Alimentation' },
		{ value: 'maison', label: 'Maison' }
	];

	function heightOf(ariaLabel: string) {
		const input = page.getByRole('combobox', { name: ariaLabel }).element() as HTMLElement;
		return input.getBoundingClientRect().height;
	}

	it('is 44px by default — the app-wide touch-target floor, and every existing caller', async () => {
		render(Combobox, { options, ariaLabel: 'Catégorie' });
		await expect.element(page.getByRole('combobox', { name: 'Catégorie' })).toBeInTheDocument();
		expect(heightOf('Catégorie')).toBe(44);
	});

	it('is 48px at size="lg", which the mobile sheet requires of every control', async () => {
		render(Combobox, { options, ariaLabel: 'Catégorie de la part 1', size: 'lg' });
		await expect
			.element(page.getByRole('combobox', { name: 'Catégorie de la part 1' }))
			.toBeInTheDocument();
		expect(heightOf('Catégorie de la part 1')).toBe(48);
	});
});
