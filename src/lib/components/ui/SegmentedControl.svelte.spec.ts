import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SegmentedControl from './SegmentedControl.svelte';

const options = [
	{ value: 'curve', label: 'Courbe' },
	{ value: 'donut', label: 'Donut' }
];

function iconSnippet() {
	return createRawSnippet(() => ({
		render: () => '<svg aria-hidden="true"><path /></svg>'
	}));
}

describe('SegmentedControl.svelte', () => {
	it('renders a tablist with one tab per option', async () => {
		render(SegmentedControl, { options, value: 'curve', icon: iconSnippet() });

		await expect.element(page.getByRole('tablist')).toBeInTheDocument();
		expect(page.getByRole('tab').elements().length).toBe(2);
	});

	it('marks the option matching value as selected via aria-selected', async () => {
		render(SegmentedControl, { options, value: 'curve', icon: iconSnippet() });

		await expect
			.element(page.getByRole('tab', { name: 'Courbe' }))
			.toHaveAttribute('aria-selected', 'true');
		await expect
			.element(page.getByRole('tab', { name: 'Donut' }))
			.toHaveAttribute('aria-selected', 'false');
	});

	it('selects an option and updates aria-selected on both tabs when clicked', async () => {
		const onValueChange = vi.fn();
		render(SegmentedControl, { options, value: 'curve', onValueChange, icon: iconSnippet() });

		await userEvent.click(page.getByRole('tab', { name: 'Donut' }));

		expect(onValueChange).toHaveBeenCalledWith('donut');
		await expect
			.element(page.getByRole('tab', { name: 'Donut' }))
			.toHaveAttribute('aria-selected', 'true');
		await expect
			.element(page.getByRole('tab', { name: 'Courbe' }))
			.toHaveAttribute('aria-selected', 'false');
	});

	it('uses roving tabindex: -1 on the inactive tab, 0 on the active tab', async () => {
		render(SegmentedControl, { options, value: 'curve', icon: iconSnippet() });

		await expect
			.element(page.getByRole('tab', { name: 'Courbe' }))
			.toHaveAttribute('tabindex', '0');
		await expect
			.element(page.getByRole('tab', { name: 'Donut' }))
			.toHaveAttribute('tabindex', '-1');
	});

	it('moves selection and focus to the next option on ArrowRight', async () => {
		const onValueChange = vi.fn();
		render(SegmentedControl, { options, value: 'curve', onValueChange, icon: iconSnippet() });

		const curveTab = page.getByRole('tab', { name: 'Courbe' });
		curveTab.element().focus();
		await userEvent.keyboard('{ArrowRight}');

		expect(onValueChange).toHaveBeenCalledWith('donut');
		const donutTab = page.getByRole('tab', { name: 'Donut' }).element();
		expect(document.activeElement).toBe(donutTab);
		expect(donutTab.getAttribute('aria-selected')).toBe('true');
		expect(donutTab.getAttribute('tabindex')).toBe('0');
	});

	it('moves selection and focus to the previous option on ArrowLeft (wraps around)', async () => {
		const onValueChange = vi.fn();
		render(SegmentedControl, { options, value: 'curve', onValueChange, icon: iconSnippet() });

		const curveTab = page.getByRole('tab', { name: 'Courbe' });
		curveTab.element().focus();
		await userEvent.keyboard('{ArrowLeft}');

		expect(onValueChange).toHaveBeenCalledWith('donut');
		const donutTab = page.getByRole('tab', { name: 'Donut' }).element();
		expect(document.activeElement).toBe(donutTab);
	});

	it('does not cycle between tabs on plain Tab (arrow-key handler ignores non-arrow keys)', async () => {
		const onValueChange = vi.fn();
		render(SegmentedControl, { options, value: 'curve', onValueChange, icon: iconSnippet() });

		const curveTab = page.getByRole('tab', { name: 'Courbe' });
		curveTab.element().focus();
		await userEvent.keyboard('{Tab}');

		expect(onValueChange).not.toHaveBeenCalled();
		await expect
			.element(page.getByRole('tab', { name: 'Courbe' }))
			.toHaveAttribute('aria-selected', 'true');
	});
});
