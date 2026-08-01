import { page } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Badge from './Badge.svelte';

function textSnippet(text: string) {
	return createRawSnippet(() => ({
		render: () => `<span>${text}</span>`
	}));
}

describe('Badge.svelte', () => {
	it('renders as a non-interactive span, not focusable and without an interactive role', async () => {
		const { container } = render(Badge, { tone: 'neutral', children: textSnippet('Label') });

		const badge = await page.getByText('Label').element();
		const span = badge.parentElement!;
		expect(span.tagName).toBe('SPAN');
		expect(span.getAttribute('role')).toBeNull();
		expect(span.hasAttribute('tabindex')).toBe(false);
		expect(container.querySelector('button, a')).toBeNull();
	});

	it('applies the neutral tone color classes by default', async () => {
		render(Badge, { tone: 'neutral', children: textSnippet('Neutral') });

		const span = (await page.getByText('Neutral').element()).parentElement!;
		expect(span.className).toContain('bg-zinc-100');
		expect(span.className).toContain('text-zinc-600');
	});

	it('applies the success tone color classes', async () => {
		render(Badge, { tone: 'success', children: textSnippet('Success') });

		const span = (await page.getByText('Success').element()).parentElement!;
		expect(span.className).toContain('bg-emerald-50');
		expect(span.className).toContain('text-emerald-700');
	});

	it('applies the warning tone color classes', async () => {
		render(Badge, { tone: 'warning', children: textSnippet('Warning') });

		const span = (await page.getByText('Warning').element()).parentElement!;
		expect(span.className).toContain('bg-amber-50');
		expect(span.className).toContain('text-amber-700');
	});

	it('applies the danger tone color classes', async () => {
		render(Badge, { tone: 'danger', children: textSnippet('Danger') });

		const span = (await page.getByText('Danger').element()).parentElement!;
		expect(span.className).toContain('bg-rose-50');
		expect(span.className).toContain('text-rose-700');
	});

	it('applies the count tone color classes regardless of bordered/solid', async () => {
		render(Badge, {
			tone: 'count',
			bordered: true,
			solid: true,
			children: textSnippet('12')
		});

		const span = (await page.getByText('12').element()).parentElement!;
		expect(span.className).toContain('bg-zinc-900');
		expect(span.className).toContain('text-white');
		expect(span.className).not.toContain('border');
	});

	it('uses the smaller rounded sizing when shape="rounded"', async () => {
		render(Badge, { tone: 'neutral', shape: 'rounded', children: textSnippet('Rounded') });

		const span = (await page.getByText('Rounded').element()).parentElement!;
		expect(span.className).toContain('rounded-[5px]');
		expect(span.className).toContain('h-[19px]');
		expect(span.className).not.toContain('rounded-full');
	});

	it('uses the pill sizing by default (shape unset)', async () => {
		render(Badge, { tone: 'neutral', children: textSnippet('Pill') });

		const span = (await page.getByText('Pill').element()).parentElement!;
		expect(span.className).toContain('rounded-full');
		expect(span.className).toContain('h-[22px]');
	});

	it('adds border classes and a transparent fill when bordered, without changing the text color', async () => {
		render(Badge, { tone: 'success', bordered: true, children: textSnippet('Bordered') });

		const span = (await page.getByText('Bordered').element()).parentElement!;
		expect(span.className).toContain('border');
		expect(span.className).toContain('border-emerald-200');
		expect(span.className).toContain('bg-transparent');
		expect(span.className).toContain('text-emerald-700');
		expect(span.className).not.toContain('bg-emerald-50');
	});

	it('applies the solid emerald style and renders a checkmark icon when tone="success" and solid=true', async () => {
		const { container } = render(Badge, {
			tone: 'success',
			solid: true,
			children: textSnippet('Reached')
		});

		const span = (await page.getByText('Reached').element()).parentElement!;
		expect(span.className).toContain('bg-emerald-700');
		expect(span.className).toContain('text-white');
		expect(container.querySelector('svg')).not.toBeNull();
	});

	it('ignores solid for a non-success tone (no black-on-color solid style, no icon)', async () => {
		const { container } = render(Badge, {
			tone: 'warning',
			solid: true,
			children: textSnippet('Warning solid')
		});

		const span = (await page.getByText('Warning solid').element()).parentElement!;
		expect(span.className).toContain('bg-amber-50');
		expect(span.className).toContain('text-amber-700');
		expect(span.className).not.toContain('bg-emerald-700');
		expect(container.querySelector('svg')).toBeNull();
	});

	// `class` is an escape hatch through a component that otherwise REFUSES undocumented colour
	// combinations (see the `solid` handling above). It exists for two design-mandated constants in
	// /upcoming-bills — the uncertain confidence tier, and any tier badge sitting on an overdue row.
	// These three cases pin what it may and may not do, so a future call site cannot quietly turn it
	// into a general restyling prop.
	it('leaves the class attribute unchanged when no class prop is passed', async () => {
		render(Badge, { tone: 'neutral', children: textSnippet('Bare') });

		const span = (await page.getByText('Bare').element()).parentElement!;
		expect(span.className.trim()).toBe(
			'inline-flex items-center justify-center gap-1 h-[22px] px-2.5 rounded-full text-[11px] font-bold uppercase bg-zinc-100 text-zinc-600'
		);
	});

	it('APPENDS the extra classes without displacing the tone classes', async () => {
		render(Badge, {
			tone: 'neutral',
			shape: 'rounded',
			bordered: true,
			class: '!border-zinc-400 !text-zinc-400',
			children: textSnippet('Incertain')
		});

		const span = (await page.getByText('Incertain').element()).parentElement!;
		// The component's own tone classes are all still there...
		expect(span.className).toContain('border-zinc-200');
		expect(span.className).toContain('text-zinc-600');
		expect(span.className).toContain('bg-transparent');
		// ...the shape and text classes too...
		expect(span.className).toContain('rounded-[5px]');
		// ...and the override comes LAST, which is what makes the `!` modifier necessary rather than
		// optional: without it two same-property utilities would be resolved by stylesheet order.
		expect(span.className).toContain('!border-zinc-400');
		expect(span.className).toContain('!text-zinc-400');
		expect(span.className.trim().endsWith('!border-zinc-400 !text-zinc-400')).toBe(true);
	});

	it('does not let the class prop reach a role, tabindex or any attribute other than class', async () => {
		const { container } = render(Badge, {
			tone: 'warning',
			class: '!bg-amber-100 !text-amber-800',
			children: textSnippet('Overdue tier')
		});

		const span = (await page.getByText('Overdue tier').element()).parentElement!;
		expect(span.getAttributeNames().sort()).toEqual(['class']);
		expect(container.querySelector('button, a')).toBeNull();
	});

	it('ignores solid for the danger tone as well', async () => {
		const { container } = render(Badge, {
			tone: 'danger',
			solid: true,
			children: textSnippet('Danger solid')
		});

		const span = (await page.getByText('Danger solid').element()).parentElement!;
		expect(span.className).toContain('bg-rose-50');
		expect(span.className).not.toContain('bg-emerald-700');
		expect(container.querySelector('svg')).toBeNull();
	});
});
