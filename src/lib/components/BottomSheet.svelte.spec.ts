import { page, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import BottomSheet from './BottomSheet.svelte';
import '../../routes/layout.css';

function bodySnippet(html = '<button type="button">Inside</button>') {
	return createRawSnippet(() => ({
		render: () => `<div>${html}</div>`
	}));
}

function footerSnippet() {
	return createRawSnippet(() => ({
		render: () => '<button type="button">Appliquer</button>'
	}));
}

// A tall body — taller than any plausible sheet height — so the flex layout is
// forced to shrink the scrolling zone rather than the sheet simply growing to
// fit its content. Every "does X stay pinned while the body scrolls" assertion
// needs this; a body shorter than the sheet never scrolls at all.
function tallBodySnippet() {
	return createRawSnippet(() => ({
		render: () =>
			`<div>
				<span id="top-marker">top</span>
				<div style="height: 1800px;"></div>
				<input id="deep-field" />
				<div style="height: 200px;"></div>
			</div>`
	}));
}

// window.visualViewport exists in the real Chromium instance vitest-browser-svelte
// runs against, so exercising the "no visualViewport" fallback needs it stubbed
// away — and exercising a controlled resize (the virtual-keyboard case) needs a
// fake we can move by hand, since headless Chromium never shows a real keyboard.
// Both stubs restore the original descriptor afterwards so they cannot leak
// between tests.
const originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');

function stubVisualViewport(value: VisualViewport | null) {
	Object.defineProperty(window, 'visualViewport', { value, configurable: true });
}

function restoreVisualViewport() {
	if (originalVisualViewportDescriptor) {
		Object.defineProperty(window, 'visualViewport', originalVisualViewportDescriptor);
	}
}

class FakeVisualViewport extends EventTarget {
	height: number;
	offsetTop: number;

	constructor(height: number, offsetTop: number) {
		super();
		this.height = height;
		this.offsetTop = offsetTop;
	}

	set(height: number, offsetTop: number) {
		this.height = height;
		this.offsetTop = offsetTop;
		this.dispatchEvent(new Event('resize'));
	}
}

afterEach(() => {
	restoreVisualViewport();
});

describe('BottomSheet.svelte', () => {
	it('renders children and no footer container when footer is omitted (existing callers)', async () => {
		render(BottomSheet, {
			open: true,
			ariaLabel: 'Titre',
			onClose: vi.fn(),
			children: bodySnippet()
		});

		await expect.element(page.getByRole('button', { name: 'Inside' })).toBeInTheDocument();
		// No border-t footer band exists at all — the sheet's only child besides
		// the drag handle and the body is the {#if footer} block, which must not
		// render anything when the prop is absent.
		const footerBand = document.querySelector('[role="dialog"] > div.border-t');
		expect(footerBand).toBeNull();
	});

	it('renders the footer outside the scrolling body when provided', async () => {
		render(BottomSheet, {
			open: true,
			ariaLabel: 'Titre',
			onClose: vi.fn(),
			children: bodySnippet(),
			footer: footerSnippet()
		});

		const applyButton = page.getByRole('button', { name: 'Appliquer' }).element() as HTMLElement;
		await expect.element(page.getByRole('button', { name: 'Appliquer' })).toBeInTheDocument();

		// The footer's parent must not be the scrolling body (overflow-y-auto);
		// it must be a sibling of it, direct child of the dialog.
		const footerParent = applyButton.closest('div');
		expect(footerParent?.classList.contains('overflow-y-auto')).toBe(false);
		expect(footerParent?.parentElement?.getAttribute('role')).toBe('dialog');
	});

	it('keeps the footer visible while the body scrolls (sticky, not scrolled)', async () => {
		render(BottomSheet, {
			open: true,
			ariaLabel: 'Titre',
			onClose: vi.fn(),
			children: tallBodySnippet(),
			footer: footerSnippet()
		});

		const applyButton = page.getByRole('button', { name: 'Appliquer' }).element() as HTMLElement;
		const body = document.querySelector('[role="dialog"] .overflow-y-auto') as HTMLElement;
		expect(body).not.toBeNull();

		const beforeRect = applyButton.getBoundingClientRect();
		body.scrollTop = 500;
		expect(body.scrollTop).toBeGreaterThan(0);
		const afterRect = applyButton.getBoundingClientRect();

		expect(afterRect.top).toBe(beforeRect.top);
		expect(afterRect.bottom).toBe(beforeRect.bottom);
	});

	it('scrolls a focused field inside the body into view', async () => {
		render(BottomSheet, {
			open: true,
			ariaLabel: 'Titre',
			onClose: vi.fn(),
			children: tallBodySnippet(),
			footer: footerSnippet()
		});

		const body = document.querySelector('[role="dialog"] .overflow-y-auto') as HTMLElement;
		const field = document.getElementById('deep-field') as HTMLInputElement;

		// The field is the sheet's only focusable body element, so opening the
		// sheet already focused (and scrolled to) it via focusFirst — reset both
		// before exercising the focus-triggered scroll on its own.
		field.blur();
		body.scrollTop = 0;
		expect(body.scrollTop).toBe(0);

		field.focus();
		await expect.poll(() => body.scrollTop).toBeGreaterThan(0);

		const bodyRect = body.getBoundingClientRect();
		const fieldRect = field.getBoundingClientRect();
		expect(fieldRect.top).toBeGreaterThanOrEqual(bodyRect.top - 1);
		expect(fieldRect.bottom).toBeLessThanOrEqual(bodyRect.bottom + 1);
	});

	it('falls back to the static max-h-[85vh] sizing when visualViewport is unavailable', async () => {
		stubVisualViewport(null);

		render(BottomSheet, {
			open: true,
			ariaLabel: 'Titre',
			onClose: vi.fn(),
			children: bodySnippet()
		});

		const dialog = page.getByRole('dialog').element() as HTMLElement;
		// No inline max-height override — the static Tailwind class (max-h-[85vh])
		// is the only thing constraining height.
		expect(dialog.style.maxHeight).toBe('');
		const wrapper = dialog.parentElement as HTMLElement;
		expect(wrapper.style.top).toBe('');
		expect(wrapper.style.height).toBe('');
	});

	it('resizes to window.visualViewport and pins the sheet to its visible box', async () => {
		const fake = new FakeVisualViewport(844, 0);
		stubVisualViewport(fake as unknown as VisualViewport);

		render(BottomSheet, {
			open: true,
			ariaLabel: 'Titre',
			onClose: vi.fn(),
			children: bodySnippet(),
			footer: footerSnippet()
		});

		const dialog = page.getByRole('dialog').element() as HTMLElement;
		const wrapper = dialog.parentElement as HTMLElement;

		await expect.poll(() => wrapper.style.height).toBe('844px');
		expect(wrapper.style.top).toBe('0px');
		expect(dialog.style.maxHeight).toBe('100%');

		// The virtual-keyboard case from design 6M: visualViewport shrinks and is
		// pushed down (offsetTop rises as the page scrolls under the keyboard).
		fake.set(544, 40);
		await expect.poll(() => wrapper.style.height).toBe('544px');
		expect(wrapper.style.top).toBe('40px');
		expect(wrapper.style.bottom).toBe('auto');
	});

	it('stops listening to visualViewport once closed', async () => {
		const fake = new FakeVisualViewport(844, 0);
		stubVisualViewport(fake as unknown as VisualViewport);

		const { rerender } = render(BottomSheet, {
			open: true,
			ariaLabel: 'Titre',
			onClose: vi.fn(),
			children: bodySnippet()
		});

		await expect.element(page.getByRole('dialog')).toBeInTheDocument();

		await rerender({ open: false, ariaLabel: 'Titre', onClose: vi.fn(), children: bodySnippet() });

		// Dispatching after close must not throw and must not resurrect any
		// removed listener — nothing to assert on the DOM (the dialog is gone),
		// this only needs to not blow up.
		expect(() => fake.set(400, 10)).not.toThrow();
	});

	it('keeps the Tab trap and Escape contract, and the trap now spans the footer too', async () => {
		const onClose = vi.fn();
		render(BottomSheet, {
			open: true,
			ariaLabel: 'Titre',
			onClose,
			children: bodySnippet(),
			footer: footerSnippet()
		});

		// Initial focus lands inside the sheet (the "Inside" body button, first
		// focusable in DOM order — the footer's button comes after it).
		const insideButton = page.getByRole('button', { name: 'Inside' }).element() as HTMLElement;
		const applyButton = page.getByRole('button', { name: 'Appliquer' }).element() as HTMLElement;
		expect(document.activeElement).toBe(insideButton);

		// Forward Tab from the body button must land on the footer's button — the
		// footer is inside the same dialog element the Tab trap scopes to.
		await userEvent.tab();
		expect(document.activeElement).toBe(applyButton);

		// Shift+Tab from the first focusable (Inside) must wrap around to the
		// last (the footer's Appliquer), never escape the sheet.
		insideButton.focus();
		await userEvent.tab({ shift: true });
		expect(document.activeElement).toBe(applyButton);

		await userEvent.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe('the visualViewport sizing must not repaint the sheets that never asked for it', () => {
	/**
	 * The `visualViewport` work replaced `max-h-[85vh]` with `100%` for EVERY sheet — +127px at 844
	 * — and no test noticed, because every assertion about sizing was written against the sheet that
	 * wanted the change. Four other sheets in this app carry no footer and were silently allowed to
	 * grow. These pin the blast radius in both directions.
	 */
	it('leaves a footer-less sheet on its 85vh cap when the keyboard is closed', async () => {
		const vv = new FakeVisualViewport(window.innerHeight, 0);
		stubVisualViewport(vv as unknown as VisualViewport);

		render(BottomSheet, {
			open: true,
			ariaLabel: 'Sans pied',
			onClose: vi.fn(),
			children: tallBodySnippet()
		});
		await new Promise((r) => requestAnimationFrame(() => r(null)));

		const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
		// No inline override at all: the element falls through to the class, which is what
		// "unchanged from before the visualViewport work" actually means.
		expect(sheet.style.maxHeight).toBe('');
		expect(sheet.className).toContain('max-h-[85vh]');
		expect(sheet.getBoundingClientRect().height).toBeLessThanOrEqual(
			Math.round(window.innerHeight * 0.85) + 1
		);
	});

	it('still shrinks a footer-less sheet when the keyboard takes the viewport', async () => {
		// The cap is a ceiling, never a floor: a reduced viewport constrains every sheet.
		const vv = new FakeVisualViewport(window.innerHeight, 0);
		stubVisualViewport(vv as unknown as VisualViewport);

		render(BottomSheet, {
			open: true,
			ariaLabel: 'Sans pied',
			onClose: vi.fn(),
			children: tallBodySnippet()
		});
		await new Promise((r) => requestAnimationFrame(() => r(null)));

		vv.set(400, 0);
		await new Promise((r) => requestAnimationFrame(() => r(null)));

		const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
		expect(sheet.style.maxHeight).toBe('100%');
		expect(sheet.getBoundingClientRect().height).toBeLessThanOrEqual(401);
	});

	it('gives a sheet WITH a sticky footer the near-full height, minus the backdrop sliver', async () => {
		const vv = new FakeVisualViewport(window.innerHeight, 0);
		stubVisualViewport(vv as unknown as VisualViewport);

		render(BottomSheet, {
			open: true,
			ariaLabel: 'Avec pied',
			onClose: vi.fn(),
			children: tallBodySnippet(),
			footer: footerSnippet()
		});
		await new Promise((r) => requestAnimationFrame(() => r(null)));

		const sheet = document.querySelector('[role="dialog"]') as HTMLElement;
		expect(sheet.style.maxHeight).toBe(`${window.innerHeight - 35}px`);
	});
});
