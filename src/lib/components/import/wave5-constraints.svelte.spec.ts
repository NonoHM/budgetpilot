import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import Button from '../Button.svelte';
import ConfirmDialog from '../ConfirmDialog.svelte';
import IconButton from '../ui/IconButton.svelte';
import SwitchRow from '../ui/SwitchRow.svelte';
import ImportDeleteButton from './ImportDeleteButton.svelte';

/**
 * Planche 5h's constraints, verified one by one, because the plate verifies them in prose and prose
 * is what ages without anything noticing.
 *
 * Each is a claim the wave makes about ITSELF, so each is checked against the components the wave
 * actually shipped rather than against a description of them.
 */
function icon() {
	return createRawSnippet(() => ({ render: () => '<svg aria-hidden="true"><path /></svg>' }));
}

describe('5h: never the colour alone', () => {
	// Every state this wave adds must survive a monochrome screen. The press carries a fill or a
	// stroke, the flight carries a WORD, the failure carries a glyph and a sentence, and the switch
	// writes its value in words. Asserted on the two that are new copy rather than new paint.
	it('the flight carries a word, not only a spinner', async () => {
		const screen = render(Button, {
			loading: true,
			busyLabel: 'Suppression…',
			children: createRawSnippet(() => ({ render: () => '<span>Supprimer</span>' }))
		});

		await expect.element(screen.getByText('Suppression…')).toBeInTheDocument();
	});

	it('the switch writes its value in words beside a decorative knob', async () => {
		const screen = render(SwitchRow, {
			label: 'Première ligne',
			valueLabel: ['données', 'en-têtes'] as [string, string],
			consequence: 'Conséquence.',
			checked: true,
			onChange: () => {}
		});

		await expect.element(screen.getByText('en-têtes')).toBeInTheDocument();
		// The knob is hidden from the tree precisely because the words already carry the state: two
		// announcements of one value is a worse outcome than none.
		const control = (await screen.getByRole('switch').element()) as HTMLElement;
		expect(control.querySelector('[aria-hidden="true"]')).not.toBeNull();
	});
});

describe('5h: no danger tint without a fault', () => {
	// The import card is neutral at rest. Rose appears on the press of a destructive control, or
	// inside a modal that is already destructive, and nowhere else.
	it('the destructive control on a card rests in the neutral glyph colour', async () => {
		const screen = render(ImportDeleteButton, {
			namedAt: '1 juillet 2026 à 10:59',
			onPress: () => {}
		});
		const control = (await screen.getByRole('button').element()) as HTMLElement;

		const probe = document.createElement('div');
		probe.className = 'text-zinc-700';
		document.body.appendChild(probe);
		expect(getComputedStyle(control).color).toBe(getComputedStyle(probe).color);
		probe.remove();
	});

	it('rose arrives on the press and not before', async () => {
		const screen = render(IconButton, { tone: 'danger', label: 'Supprimer', children: icon() });
		const control = (await screen.getByRole('button').element()) as HTMLElement;
		const resting = getComputedStyle(control).color;

		control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		expect(getComputedStyle(control).color).not.toBe(resting);
	});
});

describe('5h: nothing depends on hover', () => {
	// The desktop loses its tooltip, which is the one place information was reserved to a surface
	// that has a pointer. Asserted as an absolute zero over the control the wave introduced.
	it('the destructive control carries no title attribute at any width', async () => {
		const screen = render(ImportDeleteButton, {
			namedAt: '1 juillet 2026 à 10:59',
			onPress: () => {}
		});
		const control = (await screen.getByRole('button').element()) as HTMLElement;

		expect(control.hasAttribute('title')).toBe(false);
		// And its name is carried by `aria-label`, which a touch surface reads exactly as a pointer
		// surface does.
		expect(control.getAttribute('aria-label')).toContain('1 juillet 2026');
	});
});

describe('5h: floor 44, preferred 48', () => {
	// 48 where the room exists, 44 where pushing to 48 would cost a footer its budget. Both are
	// asserted, because a rule with only its floor checked is satisfied by a screen of 44s.
	it('the switch row takes 48', async () => {
		const screen = render(SwitchRow, {
			label: 'Première ligne',
			valueLabel: ['données', 'en-têtes'] as [string, string],
			consequence: 'Conséquence.',
			checked: true,
			onChange: () => {}
		});
		const control = (await screen.getByRole('switch').element()) as HTMLElement;

		expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
	});

	it('the destructive control never drops below the floor', async () => {
		const screen = render(ImportDeleteButton, {
			namedAt: '1 juillet 2026 à 10:59',
			onPress: () => {}
		});
		const rect = (await screen.getByRole('button').element()).getBoundingClientRect();

		expect(rect.height).toBeGreaterThanOrEqual(44);
		expect(rect.width).toBeGreaterThanOrEqual(44);
	});
});

describe('5h: mobile first, one mount', () => {
	// No `lg:hidden` introduced by this wave's components. A screen with state mounted twice is a
	// screen with two truths, which this repository has already paid for once.
	it('the components this wave added carry no breakpoint-hidden branch', async () => {
		const screen = render(SwitchRow, {
			label: 'Première ligne',
			valueLabel: ['données', 'en-têtes'] as [string, string],
			consequence: 'Conséquence.',
			checked: true,
			onChange: () => {}
		});
		const control = (await screen.getByRole('switch').element()) as HTMLElement;

		expect(control.outerHTML).not.toContain('lg:hidden');
	});

	// The confirmation is ONE dialog at both widths: the same node, measured at each.
	it('the destructive confirmation is one dialog at both widths', async () => {
		render(ConfirmDialog, {
			open: true,
			title: 'Supprimer ?',
			onClose: () => {},
			children: createRawSnippet(() => ({ render: () => '<p>corps</p>' }))
		});

		await page.viewport(390, 844);
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		await page.viewport(1280, 900);
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
	});
});

describe('5h: the press carries no aria', () => {
	// 5a's third clause, checked at the level of a control that has a VALUE state, which is the case
	// it exists to protect. A press that moved `aria-checked` would make the switch lie.
	it('pressing a switch does not disturb its value state', async () => {
		const onChange = vi.fn();
		const screen = render(SwitchRow, {
			label: 'Première ligne',
			valueLabel: ['données', 'en-têtes'] as [string, string],
			consequence: 'Conséquence.',
			checked: true,
			onChange
		});
		const control = (await screen.getByRole('switch').element()) as HTMLElement;

		control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		expect(control.dataset.pressed).toBe('');
		expect(control.getAttribute('aria-checked')).toBe('true');
	});
});
