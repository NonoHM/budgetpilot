import { page, userEvent } from 'vitest/browser';
import { createRawSnippet, tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Tooltip, { HOVER_INTENT_DELAY_MS } from './Tooltip.svelte';

function buttonSnippet(text: string) {
	return createRawSnippet(() => ({
		render: () => `<button type="button">${text}</button>`
	}));
}

describe('Tooltip.svelte', () => {
	it('reveals the tooltip on keyboard focus alone, without any hover', async () => {
		render(Tooltip, { label: 'Explication', children: buttonSnippet('Trigger') });

		const trigger = page.getByRole('button', { name: 'Trigger' });
		await trigger.element().focus();

		await expect.element(page.getByRole('tooltip')).toBeInTheDocument();
		await expect.element(page.getByRole('tooltip')).toHaveTextContent('Explication');
	});

	it('does not show the tooltip before the hover intent delay elapses', async () => {
		// Timers are driven, not raced. The previous version hovered for real and asserted
		// absence immediately after: on a loaded CI runner `userEvent.hover` alone took 747ms,
		// the 400ms intent timer had already fired, and the assertion failed on a component
		// that was behaving correctly. Only setTimeout/clearTimeout are faked — the fade
		// transitions run on requestAnimationFrame and must keep using real time.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		try {
			const { container } = render(Tooltip, {
				label: 'Explication',
				children: buttonSnippet('Hover me')
			});

			// Dispatched rather than driven through userEvent: the point of this test is the
			// timer, and the browser's own hover emulation is what made it flaky. The real
			// hover path stays covered by the next test, which awaits the tooltip instead.
			const wrapper = container.querySelector('[role="presentation"]');
			expect(wrapper).not.toBeNull();
			wrapper?.dispatchEvent(new MouseEvent('mouseenter'));
			await tick();

			expect(page.getByRole('tooltip').elements().length).toBe(0);

			vi.advanceTimersByTime(HOVER_INTENT_DELAY_MS - 1);
			await tick();
			expect(page.getByRole('tooltip').elements().length).toBe(0);

			// The other half, in the same test on purpose: an assertion that only ever checks
			// absence would still pass if the tooltip never opened at all.
			vi.advanceTimersByTime(1);
			await tick();
			expect(page.getByRole('tooltip').elements().length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('shows the tooltip on hover after the intent delay', async () => {
		render(Tooltip, { label: 'Explication', children: buttonSnippet('Hover me') });

		await userEvent.hover(page.getByRole('button', { name: 'Hover me' }));

		await expect.element(page.getByRole('tooltip')).toBeInTheDocument();
	});

	it('starts hiding on mouse-leave without waiting for the hover-intent delay', async () => {
		render(Tooltip, { label: 'Explication', children: buttonSnippet('Hover me') });

		await userEvent.hover(page.getByRole('button', { name: 'Hover me' }));
		await expect.element(page.getByRole('tooltip')).toBeInTheDocument();

		await userEvent.unhover(page.getByRole('button', { name: 'Hover me' }));

		// The close intent fires synchronously; the tooltip itself fades out over
		// MOTION.popoverOutMs (see src/lib/motion.ts) before actually leaving the DOM.
		await expect.poll(() => page.getByRole('tooltip').elements().length).toBe(0);
	});

	it('closes on Escape while focused', async () => {
		render(Tooltip, { label: 'Explication', children: buttonSnippet('Trigger') });

		const trigger = page.getByRole('button', { name: 'Trigger' });
		await trigger.element().focus();
		await expect.element(page.getByRole('tooltip')).toBeInTheDocument();

		await userEvent.keyboard('{Escape}');

		await expect.poll(() => page.getByRole('tooltip').elements().length).toBe(0);
	});

	it('closes on focus-out (blur)', async () => {
		render(Tooltip, { label: 'Explication', children: buttonSnippet('Trigger') });

		const trigger = page.getByRole('button', { name: 'Trigger' });
		await trigger.element().focus();
		await expect.element(page.getByRole('tooltip')).toBeInTheDocument();

		trigger.element().blur();

		await expect.poll(() => page.getByRole('tooltip').elements().length).toBe(0);
	});

	it('links the trigger to the tooltip via aria-describedby matching the tooltip id', async () => {
		const { container } = render(Tooltip, {
			label: 'Explication',
			children: buttonSnippet('Trigger')
		});

		const trigger = page.getByRole('button', { name: 'Trigger' });
		await trigger.element().focus();

		const tooltipEl = page.getByRole('tooltip').element();
		const tooltipId = tooltipEl.getAttribute('id');
		expect(tooltipId).toBeTruthy();

		const describedByEl = container.querySelector(`[aria-describedby="${tooltipId}"]`);
		expect(describedByEl).not.toBeNull();
	});

	it('assigns distinct ids to two Tooltip instances rendered together (no collision)', async () => {
		render(Tooltip, { label: 'Premier', children: buttonSnippet('Trigger A') });
		render(Tooltip, { label: 'Second', children: buttonSnippet('Trigger B') });

		await page.getByRole('button', { name: 'Trigger A' }).element().focus();
		// Scoped by accessible name (not a bare getByRole('tooltip')): moving focus to B starts A's
		// exit fade (see src/lib/motion.ts) without waiting for it to finish, so both tooltips can be
		// transiently in the DOM together.
		const tooltipIdA = page.getByRole('tooltip', { name: 'Premier' }).element().getAttribute('id');

		await page.getByRole('button', { name: 'Trigger B' }).element().focus();
		const tooltipIdB = page.getByRole('tooltip', { name: 'Second' }).element().getAttribute('id');

		expect(tooltipIdA).toBeTruthy();
		expect(tooltipIdB).toBeTruthy();
		expect(tooltipIdA).not.toBe(tooltipIdB);
	});
});
