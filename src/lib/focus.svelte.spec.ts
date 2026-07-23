import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFocusRestore, focusFirst, getFocusable, trapTabKey } from './focus';

// Runs as a "client" (real Chromium) spec, not "server"/jsdom — jsdom's
// offsetParent is always null, which would make the visibility filter in
// getFocusable() untestable. Naming this file `*.svelte.spec.ts` routes it
// to the browser project (see vite.config.ts's `include` patterns) even
// though it exercises plain DOM, not a Svelte component.

let container: HTMLElement | null = null;

afterEach(() => {
	container?.remove();
	container = null;
});

function mount(html: string): HTMLElement {
	const el = document.createElement('div');
	el.innerHTML = html;
	document.body.appendChild(el);
	container = el;
	return el;
}

describe('getFocusable', () => {
	it('returns an empty array for a null container', () => {
		expect(getFocusable(null)).toEqual([]);
	});

	it('returns an empty array for a container with no focusable descendants', () => {
		const el = mount('<p>Nothing to focus here</p>');

		expect(getFocusable(el)).toEqual([]);
	});

	it('excludes disabled elements', () => {
		const el = mount(`
			<button type="button" disabled>Disabled button</button>
			<input disabled />
			<button type="button">Enabled</button>
		`);

		const focusable = getFocusable(el);

		expect(focusable).toHaveLength(1);
		expect(focusable[0].textContent).toBe('Enabled');
	});

	it('excludes non-native elements with tabindex="-1"', () => {
		// The `button:not([disabled])` clause of the selector matches any button
		// regardless of its tabindex — the tabindex="-1" exclusion is what covers
		// elements made focusable via `tabindex="0"` on a non-interactive tag
		// (e.g. a Modal's own panel, which deliberately uses tabindex="-1" to be
		// programmatically-only focusable).
		const el = mount(`
			<div tabindex="-1">Not tabbable</div>
			<div tabindex="0">Tabbable</div>
		`);

		const focusable = getFocusable(el);

		expect(focusable).toHaveLength(1);
		expect(focusable[0].textContent).toBe('Tabbable');
	});

	it('excludes elements hidden via display:none (offsetParent === null)', () => {
		const el = mount(`
			<button type="button" style="display:none">Hidden</button>
			<button type="button">Visible</button>
		`);

		const focusable = getFocusable(el);

		expect(focusable).toHaveLength(1);
		expect(focusable[0].textContent).toBe('Visible');
	});

	it('includes anchors with an href, textareas and selects, in DOM order', () => {
		const el = mount(`
			<a href="/somewhere">Link</a>
			<textarea></textarea>
			<select><option>1</option></select>
		`);

		const focusable = getFocusable(el);

		expect(focusable.map((node) => node.tagName)).toEqual(['A', 'TEXTAREA', 'SELECT']);
	});

	it('excludes anchors without an href', () => {
		const el = mount('<a>No href</a>');

		expect(getFocusable(el)).toEqual([]);
	});
});

describe('focusFirst', () => {
	it('is a no-op for a null container', () => {
		expect(() => focusFirst(null)).not.toThrow();
	});

	it('focuses the first focusable descendant', () => {
		const el = mount(`
			<button type="button">First</button>
			<button type="button">Second</button>
		`);

		focusFirst(el);

		expect(document.activeElement?.textContent).toBe('First');
	});

	it('falls back to focusing the container itself when it has no focusable descendants', () => {
		const el = mount('<p>No focusable children</p>');
		el.tabIndex = -1;

		focusFirst(el);

		expect(document.activeElement).toBe(el);
	});
});

describe('trapTabKey', () => {
	function tabEvent(shiftKey = false): KeyboardEvent {
		return new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
	}

	it('is a no-op for a null container', () => {
		const event = tabEvent();
		const spy = vi.spyOn(event, 'preventDefault');

		expect(() => trapTabKey(event, null)).not.toThrow();
		expect(spy).not.toHaveBeenCalled();
	});

	it('is a no-op for a container with no focusable descendants', () => {
		const el = mount('<p>Empty</p>');
		const event = tabEvent();
		const spy = vi.spyOn(event, 'preventDefault');

		trapTabKey(event, el);

		expect(spy).not.toHaveBeenCalled();
	});

	it('ignores non-Tab keys', () => {
		const el = mount(`
			<button type="button">First</button>
			<button type="button">Last</button>
		`);
		const last = el.querySelectorAll('button')[1] as HTMLElement;
		last.focus();

		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		const spy = vi.spyOn(event, 'preventDefault');

		trapTabKey(event, el);

		expect(spy).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(last);
	});

	it('wraps Tab from the last element back to the first, calling preventDefault', () => {
		const el = mount(`
			<button type="button">First</button>
			<button type="button">Middle</button>
			<button type="button">Last</button>
		`);
		const buttons = el.querySelectorAll('button');
		const first = buttons[0] as HTMLElement;
		const last = buttons[2] as HTMLElement;
		last.focus();

		const event = tabEvent();
		const spy = vi.spyOn(event, 'preventDefault');

		trapTabKey(event, el);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(first);
	});

	it('does not intercept Tab when focus is not on the last element', () => {
		const el = mount(`
			<button type="button">First</button>
			<button type="button">Last</button>
		`);
		const first = el.querySelectorAll('button')[0] as HTMLElement;
		first.focus();

		const event = tabEvent();
		const spy = vi.spyOn(event, 'preventDefault');

		trapTabKey(event, el);

		expect(spy).not.toHaveBeenCalled();
		// Real Tab navigation is left to the browser; the helper only wraps at the edges.
		expect(document.activeElement).toBe(first);
	});

	it('wraps Shift+Tab from the first element back to the last, calling preventDefault', () => {
		const el = mount(`
			<button type="button">First</button>
			<button type="button">Middle</button>
			<button type="button">Last</button>
		`);
		const buttons = el.querySelectorAll('button');
		const first = buttons[0] as HTMLElement;
		const last = buttons[2] as HTMLElement;
		first.focus();

		const event = tabEvent(true);
		const spy = vi.spyOn(event, 'preventDefault');

		trapTabKey(event, el);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(last);
	});

	it('does not intercept Shift+Tab when focus is not on the first element', () => {
		const el = mount(`
			<button type="button">First</button>
			<button type="button">Last</button>
		`);
		const last = el.querySelectorAll('button')[1] as HTMLElement;
		last.focus();

		const event = tabEvent(true);
		const spy = vi.spyOn(event, 'preventDefault');

		trapTabKey(event, el);

		expect(spy).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(last);
	});

	it('wraps to itself when there is only one focusable element', () => {
		const el = mount('<button type="button">Only</button>');
		const only = el.querySelector('button') as HTMLElement;
		only.focus();

		const event = tabEvent();
		const spy = vi.spyOn(event, 'preventDefault');

		trapTabKey(event, el);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(only);
	});
});

describe('createFocusRestore', () => {
	it('restores focus to the element captured by save()', () => {
		const trigger = document.createElement('button');
		trigger.textContent = 'Trigger';
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const focusRestore = createFocusRestore();
		focusRestore.save();

		const other = document.createElement('button');
		other.textContent = 'Other';
		document.body.appendChild(other);
		other.focus();
		expect(document.activeElement).toBe(other);

		focusRestore.restore();

		expect(document.activeElement).toBe(trigger);

		other.remove();
		trigger.remove();
	});

	it('is idempotent: a second restore() call does not refocus a stale element', () => {
		const trigger = document.createElement('button');
		trigger.textContent = 'Trigger';
		document.body.appendChild(trigger);
		trigger.focus();

		const focusRestore = createFocusRestore();
		focusRestore.save();

		const decoy = document.createElement('button');
		decoy.textContent = 'Decoy';
		document.body.appendChild(decoy);

		focusRestore.restore();
		expect(document.activeElement).toBe(trigger);

		decoy.focus();
		expect(document.activeElement).toBe(decoy);

		focusRestore.restore();
		// Second call is a no-op: focus stays wherever it currently is, it does
		// not re-apply the stale saved element.
		expect(document.activeElement).toBe(decoy);

		trigger.remove();
		decoy.remove();
	});

	it('does nothing when restore() is called without a prior save()', () => {
		const trigger = document.createElement('button');
		trigger.textContent = 'Trigger';
		document.body.appendChild(trigger);
		trigger.focus();

		const focusRestore = createFocusRestore();
		focusRestore.restore();

		expect(document.activeElement).toBe(trigger);

		trigger.remove();
	});
});
