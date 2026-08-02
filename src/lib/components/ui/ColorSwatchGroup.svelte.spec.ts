import { page } from 'vitest/browser';
import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ColorSwatchGroup from './ColorSwatchGroup.svelte';

const options = [
	{ value: 'clay', label: 'Clay', class: 'bg-[#9f4949]' },
	{ value: 'ochre', label: 'Ochre', class: 'bg-[#9c4f29]' },
	{ value: 'olive', label: 'Olive', class: 'bg-[#6e6b00]' }
];

function renderGroup(selected = 'ochre') {
	return render(ColorSwatchGroup, {
		name: 'colorToken',
		options,
		selected,
		ariaLabel: 'Colour'
	});
}

function radios(container: HTMLElement) {
	return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

describe('ColorSwatchGroup', () => {
	it('names every swatch by its colour rather than its position', async () => {
		const { container } = renderGroup();

		// The design's rule: "Lagune", never "couleur 4". A positional name tells a screen-reader
		// user nothing about what they are choosing.
		expect(radios(container).map((r) => r.getAttribute('aria-label'))).toEqual([
			'Clay',
			'Ochre',
			'Olive'
		]);
	});

	it('marks exactly one swatch checked, and it is the selected one', async () => {
		const { container } = renderGroup();

		const checked = radios(container).filter((r) => r.getAttribute('aria-checked') === 'true');
		expect(checked).toHaveLength(1);
		expect(checked[0].value).toBe('ochre');
	});

	it('puts only the selected swatch in the tab order', async () => {
		const { container } = renderGroup();

		// A roving tabindex. Without it, Tab walks through all nine swatches before reaching the
		// next control, which is the thing the arrow keys exist to avoid.
		expect(radios(container).map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
	});

	it('moves focus with the arrow keys and wraps at both ends', async () => {
		const { container } = renderGroup();
		const [first, second, third] = radios(container);

		second.focus();
		await page
			.getByRole('radio', { name: 'Ochre' })
			.element()
			.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(document.activeElement).toBe(third);

		third.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(document.activeElement).toBe(first);

		first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		expect(document.activeElement).toBe(third);
	});

	it('jumps to the ends with Home and End', async () => {
		const { container } = renderGroup();
		const [first, second, third] = radios(container);

		second.focus();
		second.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		expect(document.activeElement).toBe(third);

		third.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		expect(document.activeElement).toBe(first);
	});

	it('does not submit while the arrow keys are only moving focus', async () => {
		const { container } = renderGroup();

		// Manual activation, deliberately. Each swatch is a submit button, so selecting on arrow
		// would fire one POST per keypress while the user is just looking through the palette.
		let submits = 0;
		const form = document.createElement('form');
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			submits += 1;
		});
		container.parentElement?.insertBefore(form, container);
		form.appendChild(container);

		const [, second] = radios(container);
		second.focus();
		second.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

		expect(submits).toBe(0);
	});

	it('stays keyboard reachable when the selected value is not in the palette', async () => {
		const { container } = renderGroup('written-by-an-older-release');

		// Falls back to the first swatch rather than leaving every tabindex at -1, which would make
		// the whole group unreachable by Tab.
		expect(radios(container).map((r) => r.tabIndex)).toEqual([0, -1, -1]);
	});

	it('submits the token under the field name the caller chose', async () => {
		const { container } = renderGroup();

		const [first] = radios(container);
		expect(first.name).toBe('colorToken');
		expect(first.value).toBe('clay');
		expect(first.type).toBe('submit');
	});
});
