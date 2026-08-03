import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import TagChips from './TagChips.svelte';
import * as m from '$lib/paraglide/messages';

const three = [
	{ key: 't1', name: 'Portugal', colorToken: 'clay' as const },
	{ key: 't2', name: 'Remboursement Paul', colorToken: 'ochre' as const },
	{ key: 't3', name: 'Pro', colorToken: 'olive' as const }
];

describe('TagChips.svelte', () => {
	it('always writes the name, so colour never carries information alone', async () => {
		render(TagChips, { tags: [three[0]] });

		await expect.element(page.getByText('Portugal')).toBeInTheDocument();
	});

	it('shows at most two tags by default and collapses the rest as +N', async () => {
		render(TagChips, { tags: three });

		await expect.element(page.getByText('Portugal')).toBeInTheDocument();
		await expect.element(page.getByText('Remboursement Paul')).toBeInTheDocument();
		expect(page.getByText('Pro').elements().length).toBe(0);
		// The button's accessible name is its full aria-label (asserted separately below); its
		// visible text content is the short "+1" glyph, checked here via textContent.
		await expect
			.element(page.getByRole('button', { name: /1 étiquette de plus/ }))
			.toHaveTextContent('+1');
	});

	it('names the hidden tags in the overflow button aria-label so nothing is lost', async () => {
		render(TagChips, { tags: three });

		await expect
			.element(page.getByRole('button', { name: /1 étiquette de plus : Pro/ }))
			.toBeInTheDocument();
	});

	it('pluralises the overflow aria-label when more than one tag is hidden', async () => {
		render(TagChips, { tags: three, max: 1 });

		await expect
			.element(
				page.getByRole('button', {
					name: '2 étiquettes de plus : Remboursement Paul, Pro'
				})
			)
			.toBeInTheDocument();
	});

	it('renders no overflow marker when everything fits', async () => {
		render(TagChips, { tags: [three[0], three[1]] });

		expect(page.getByRole('button').elements().length).toBe(0);
	});

	it('carries the palette background class on the dot, not on the whole chip', async () => {
		const { container } = render(TagChips, { tags: [three[0]] });

		const dot = container.querySelector('.bg-\\[\\#9f4949\\]');
		expect(dot).toBeTruthy();
		// A dot, not a filled block: two colour blocks on one row are unreadable, two dots are not.
		expect(dot?.textContent).toBe('');
	});

	it('offers a remove control only in the enclosed variant, and only when onRemove is given', async () => {
		const onRemove = vi.fn();

		const plain = render(TagChips, { tags: [three[0]], onRemove, variant: 'plain' });
		expect(plain.container.querySelectorAll('button[aria-label^="Retirer"]').length).toBe(0);
		plain.unmount();

		const enclosedNoRemove = render(TagChips, { tags: [three[0]], variant: 'enclosed' });
		expect(
			enclosedNoRemove.container.querySelectorAll('button[aria-label^="Retirer"]').length
		).toBe(0);
		enclosedNoRemove.unmount();

		render(TagChips, { tags: [three[0]], onRemove, variant: 'enclosed' });
		await expect
			.element(page.getByRole('button', { name: m.tags_remove_aria({ name: 'Portugal' }) }))
			.toBeInTheDocument();
	});

	it('calls onRemove with the tag key when the remove control is activated', async () => {
		const onRemove = vi.fn();
		render(TagChips, { tags: [three[0]], onRemove, variant: 'enclosed' });

		await userEvent.click(
			page.getByRole('button', { name: m.tags_remove_aria({ name: 'Portugal' }) })
		);

		expect(onRemove).toHaveBeenCalledExactlyOnceWith('t1');
	});

	it('shows every tag when removal is offered, so a hidden tag cannot be unremovable', async () => {
		render(TagChips, { tags: three, onRemove: vi.fn(), variant: 'enclosed' });

		await expect.element(page.getByText('Pro')).toBeInTheDocument();
		expect(page.getByRole('button', { name: /^\+/ }).elements().length).toBe(0);
	});

	it('renders nothing at all for an empty list', async () => {
		const { container } = render(TagChips, { tags: [] });

		expect(container.textContent?.trim()).toBe('');
	});

	it('renders a neutral zinc dot for a tag with no colour yet, never guessing one', async () => {
		// TagPicker's pending-create case: the colour derives from nameKey, a server-side digest,
		// so the client genuinely does not know it until the row exists.
		const { container } = render(TagChips, {
			tags: [{ key: 'Nouveau', name: 'Nouveau', colorToken: null }]
		});

		expect(container.querySelector('.bg-zinc-300')).toBeTruthy();
		await expect.element(page.getByText('Nouveau')).toBeInTheDocument();
	});

	it('marks a pending (in-flight creation) chip with a dashed border, a zinc-400 dot and a spinner', async () => {
		const { container } = render(TagChips, {
			tags: [{ key: 'Réparation vélo', name: 'Réparation vélo', colorToken: null, pending: true }],
			variant: 'enclosed'
		});

		expect(container.querySelector('.border-dashed')).toBeTruthy();
		expect(container.querySelector('.bg-zinc-400')).toBeTruthy();
		expect(container.querySelector('[data-testid="tag-chip-spinner"]')).toBeTruthy();
	});

	it('gives the remove button a real 44x44 tap target on mobile via padding that overflows the chip, staying visually 22x22', async () => {
		const onRemove = vi.fn();
		render(TagChips, { tags: [three[0]], onRemove, variant: 'enclosed' });

		const button = page
			.getByRole('button', { name: m.tags_remove_aria({ name: 'Portugal' }) })
			.element() as HTMLElement;
		const rect = button.getBoundingClientRect();
		expect(rect.width).toBeCloseTo(22, 0);

		// A point 10px beyond the visible button is still within a 44px real target
		// (44/2 - 22/2 = 11px of overflow on each side) — elementFromPoint is real hit-testing,
		// not a source-text check, so it proves the enlarged area is actually clickable.
		const reachable = document.elementFromPoint(rect.right + 10, rect.top + rect.height / 2);
		expect(reachable === button || button.contains(reachable)).toBe(true);
		reachable?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(onRemove).toHaveBeenCalledExactlyOnceWith('t1');

		// ...and it does not extend forever: a point clearly beyond the 44px target must miss.
		const tooFar = document.elementFromPoint(rect.right + 30, rect.top + rect.height / 2);
		expect(tooFar === button || button.contains(tooFar)).toBe(false);
	});

	it('widens the "+N" overflow button to a 44px min-width / 28px height real tap target on mobile', async () => {
		render(TagChips, { tags: three });

		const button = page
			.getByRole('button', { name: /1 étiquette de plus/ })
			.element() as HTMLElement;
		const rect = button.getBoundingClientRect();
		expect(rect.width).toBeGreaterThanOrEqual(44);
		expect(rect.height).toBeCloseTo(28, 0);
	});

	it("spins the pending-chip spinner at the design's 0.8s cadence, not Tailwind's 1s default", async () => {
		const { container } = render(TagChips, {
			tags: [{ key: 'x', name: 'x', colorToken: null, pending: true }],
			variant: 'enclosed'
		});

		const spinner = container.querySelector('[data-testid="tag-chip-spinner"]') as HTMLElement;
		expect(getComputedStyle(spinner).animationDuration).toBe('0.8s');
	});

	it('groups the chips in a list with an accessible name, absent entirely when there are no tags', async () => {
		const populated = render(TagChips, { tags: [three[0]] });
		await expect.element(page.getByRole('list', { name: 'Étiquettes' })).toBeInTheDocument();
		populated.unmount();

		const empty = render(TagChips, { tags: [] });
		expect(empty.container.querySelector('ul')).toBeNull();
	});

	it.each([
		['sm', '18px'],
		['md', '26px']
	])('pins the %s chip height at %s rather than letting the text decide it', async (size, px) => {
		const { container } = render(TagChips, {
			tags: [{ key: 't1', name: 'Portugal', colorToken: 'lagoon' as const }],
			size: size as 'sm' | 'md'
		});

		// The row's tag column is a fixed 190px, so a chip whose height follows its font drifts the
		// moment a locale, a font weight or a browser default changes the line box.
		const chip = container.querySelector('li > span') as HTMLElement;
		expect(getComputedStyle(chip).height).toBe(px);
	});

	it.each([
		['plain', 'nowrap'],
		['enclosed', 'wrap'],
		['tinted', 'wrap']
	])('computes flex-wrap: %s -> %s, which is the row-height guarantee', async (variant, wrap) => {
		// COMPUTED, not the class list. The class list said `flex-nowrap` all along and the browser
		// wrapped anyway: both `flex-wrap` and `flex-nowrap` were emitted on the same element, and
		// attribute order does not decide a cascade — `flex-wrap` won, plain chips stacked, and the
		// table row grew from 63px to 76px with a second tag. An assertion over `className` is
		// exactly the kind that cannot fail here, because the intended class genuinely IS present.
		//
		// The design forbids wrapping in the reading context only ("Retour à la ligne : jamais en
		// variante plain (ligne de tableau)"); the editing variants wrap on purpose, which is why
		// all three are pinned together rather than plain alone.
		const { container } = render(TagChips, {
			tags: three,
			variant: variant as 'plain' | 'enclosed' | 'tinted',
			max: Infinity
		});

		const list = container.querySelector('ul') as HTMLElement;
		expect(getComputedStyle(list).flexWrap).toBe(wrap);
	});

	it('lets a long name truncate instead of widening the chip past its cap', async () => {
		// The other half of the no-wrap fix: with nowrap and nothing shrinkable, two chips simply
		// overflowed their column instead of wrapping. The name must be the only thing that gives.
		const { container } = render(TagChips, {
			tags: [
				{ key: 't1', name: 'Mariage Camille et Thomas juin 2026 Bretagne', colorToken: 'clay' }
			],
			size: 'sm'
		});

		const chip = container.querySelector('li > span') as HTMLElement;
		const name = chip.querySelector('span:not([aria-hidden])') as HTMLElement;
		expect(chip.getBoundingClientRect().width).toBeLessThanOrEqual(110);
		// Genuinely clipped by CSS, with the full name still in the text node for a screen reader.
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
		expect(name.textContent).toBe('Mariage Camille et Thomas juin 2026 Bretagne');
	});

	it('renders the tinted variant with the token hue as text on its own tint', async () => {
		const { container } = render(TagChips, {
			tags: [{ key: 't1', name: 'Portugal', colorToken: 'lagoon' as const }],
			variant: 'tinted',
			max: Infinity
		});

		// The one pairing whose contrast is measured. Asserted as classes here; e2e/tags.spec.ts
		// measures what the browser actually paints, because a correct class can still be bound to
		// the wrong element.
		const chip = container.querySelector('li > span') as HTMLElement;
		expect(chip.className).toContain('bg-[#e3faf8]');
		const name = chip.querySelector('span:not([aria-hidden])') as HTMLElement;
		expect(name.className).toContain('text-[#007b76]');
	});

	it('falls back to neutral zinc in the tinted variant when the tag has no colour yet', async () => {
		const { container } = render(TagChips, {
			tags: [{ key: 'Portugal', name: 'Portugal', colorToken: null }],
			variant: 'tinted',
			max: Infinity
		});

		// An unsaved tag has no token: its colour comes from a server-side nameKey digest the client
		// cannot compute. Guessing a hue that changes on save would be worse than a neutral chip.
		const chip = container.querySelector('li > span') as HTMLElement;
		expect(chip.className).toContain('bg-zinc-100');
		expect(chip.className).not.toMatch(/bg-\[#/);
	});

	it('offers a remove control on a tinted chip, named after the tag', async () => {
		const removed: string[] = [];
		render(TagChips, {
			tags: [{ key: 't1', name: 'Portugal', colorToken: 'lagoon' as const }],
			variant: 'tinted',
			max: Infinity,
			onRemove: (key: string) => removed.push(key)
		});

		// The active filter's chip is how the filter is cleared, so the control has to exist and be
		// named by the tag rather than by a bare "remove".
		const button = page.getByRole('button', { name: /Portugal/ });
		await expect.element(button).toBeInTheDocument();
		await button.click();
		expect(removed).toEqual(['t1']);
	});
});
