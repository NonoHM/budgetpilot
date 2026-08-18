import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESS_MIN_MS, pressable, pressableWithin } from './press';

// Runs as a "client" (real Chromium) spec, not "server"/jsdom, for the same reason
// `focus.svelte.spec.ts` does: this exercises real `PointerEvent`s and a real attribute on a real
// element. Naming the file `*.svelte.spec.ts` routes it to the browser project (see
// vite.config.ts's `include` patterns) even though it exercises plain DOM, not a Svelte component.
//
// Fake timers throughout, and that is a decision rather than a convenience. The rule under test is
// a DURATION, and an assertion that waits 120 real milliseconds is an assertion about the runner's
// scheduling. With the clock controlled, every test below separates two OBSERVABLE STATES at a
// named instant instead.

let node: HTMLElement | null = null;
let handle: { destroy(): void } | null = null;

function mount(): HTMLElement {
	const el = document.createElement('button');
	document.body.appendChild(el);
	node = el;
	return el;
}

function fire(el: HTMLElement, type: string) {
	el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	handle?.destroy();
	handle = null;
	node?.remove();
	node = null;
	vi.useRealTimers();
});

describe('pressable, clause 1: pressed is not selected', () => {
	// Separates "lit while the finger is down" from "left lit after the release". A control that
	// stays rose after the press is a bug, not a variant (plate 5a). The second assertion is the
	// clause; the first is what proves the fixture reached the state it is about to leave.
	it('never survives pointerup', () => {
		const el = mount();
		handle = pressable(el);

		fire(el, 'pointerdown');
		expect(el.dataset.pressed).toBe('');

		fire(el, 'pointerup');
		vi.advanceTimersByTime(PRESS_MIN_MS + 1);
		expect(el.dataset.pressed).toBeUndefined();
	});

	// A pointer that leaves the control has abandoned the press the same way a release ends it.
	// Asserted separately from pointerup because it is a different listener and can be lost alone.
	it('never survives pointerleave', () => {
		const el = mount();
		handle = pressable(el);

		fire(el, 'pointerdown');
		fire(el, 'pointerleave');
		vi.advanceTimersByTime(PRESS_MIN_MS + 1);

		expect(el.dataset.pressed).toBeUndefined();
	});
});

describe('pressable, clause 2: pressed cancels on scroll', () => {
	// Separates "released" from "cancelled", which the minimum-display floor is what makes
	// distinguishable at all. THE FIXTURE IS A 10 ms PRESS on purpose: at 200 ms both rules agree
	// and the test would pass against an implementation that has no cancel path.
	it('pointercancel removes it without waiting the minimum', () => {
		const el = mount();
		handle = pressable(el);

		fire(el, 'pointerdown');
		vi.advanceTimersByTime(10);
		fire(el, 'pointercancel');

		// No clock advance between the cancel and this read: the state is gone at the instant of the
		// cancel, not 110 ms later.
		expect(el.dataset.pressed).toBeUndefined();
	});
});

describe('pressable, clause 3: pressed is mute', () => {
	// Keeps 5d's value states independent. An ABSOLUTE zero on both sides, because "carries no
	// aria" is satisfied by a query that matches nothing: the resting count is asserted first so a
	// broken query would fail there rather than pass here.
	it('sets no aria attribute, pressed or resting', () => {
		const el = mount();
		el.setAttribute('aria-checked', 'true');
		handle = pressable(el);

		const resting = el.getAttributeNames().filter((name) => name.startsWith('aria-'));
		expect(resting).toEqual(['aria-checked']);

		fire(el, 'pointerdown');
		expect(el.getAttributeNames().filter((name) => name.startsWith('aria-'))).toEqual([
			'aria-checked'
		]);
		expect(el.getAttribute('aria-checked')).toBe('true');
	});
});

describe('pressable, the minimum display', () => {
	// THE measured case: a 90 ms tap. Under an implementation with no floor this shows almost
	// nothing, which is the defect the blind tester's four attempts recorded. Two instants, two
	// states: still lit at the release, gone once the floor has elapsed.
	it('holds the state when the release beats the floor', () => {
		const el = mount();
		handle = pressable(el);

		fire(el, 'pointerdown');
		vi.advanceTimersByTime(90);
		fire(el, 'pointerup');
		expect(el.dataset.pressed).toBe('');

		vi.advanceTimersByTime(PRESS_MIN_MS - 90 + 1);
		expect(el.dataset.pressed).toBeUndefined();
	});

	// The other side of the boundary, and it is the value where the two behaviours disagree: a
	// release AFTER the floor owes nothing, so the state goes at the release rather than later.
	it('releases immediately when the press already outlasted the floor', () => {
		const el = mount();
		handle = pressable(el);

		fire(el, 'pointerdown');
		vi.advanceTimersByTime(PRESS_MIN_MS);
		fire(el, 'pointerup');

		expect(el.dataset.pressed).toBeUndefined();
	});

	// A second press while the first is still serving out its floor must not be swallowed by the
	// pending timer. Found by asking what the timer does when it fires after a NEW press started.
	it('a new press outlives the previous release timer', () => {
		const el = mount();
		handle = pressable(el);

		fire(el, 'pointerdown');
		vi.advanceTimersByTime(10);
		fire(el, 'pointerup');
		fire(el, 'pointerdown');
		vi.advanceTimersByTime(PRESS_MIN_MS - 10 + 1);

		expect(el.dataset.pressed).toBe('');
	});
});

describe('pressable, destroy', () => {
	// A destroyed action leaves no state behind and no listener alive. The second half is what
	// stops a detached node keeping a timer, and it is asserted by pressing after destroy.
	it('clears the state and stops answering', () => {
		const el = mount();
		const created = pressable(el);

		fire(el, 'pointerdown');
		created.destroy();
		expect(el.dataset.pressed).toBeUndefined();

		fire(el, 'pointerdown');
		expect(el.dataset.pressed).toBeUndefined();
	});
});

describe('pressableWithin', () => {
	// One listener for a grid of 42 cells rather than 42 actions, and it is the only way to reach an
	// element a third-party component renders: `RangeCalendar`'s days come from bits-ui, which takes
	// a class but not a Svelte action.
	function grid(): { root: HTMLElement; cells: HTMLElement[] } {
		const root = document.createElement('div');
		root.innerHTML = '<span data-cell>1</span><span data-cell>2</span><span>not a cell</span>';
		document.body.appendChild(root);
		node = root;
		return { root, cells: [...root.querySelectorAll<HTMLElement>('[data-cell]')] };
	}

	// Separates "the pressed cell" from "any cell": a delegated listener that marked the container
	// or every match would light the whole grid under one finger.
	it('marks only the cell the press landed in', () => {
		const { root, cells } = grid();
		handle = pressableWithin(root, '[data-cell]');

		cells[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		expect(cells[0].dataset.pressed).toBe('');
		expect(cells[1].dataset.pressed).toBeUndefined();
		expect(root.dataset.pressed).toBeUndefined();
	});

	// A press that starts outside any cell marks nothing. Asserted with an absolute zero, because
	// "nothing is marked" is satisfied by a selector that matches nothing: the test above is what
	// proves the selector matches.
	it('marks nothing when the press misses every cell', () => {
		const { root } = grid();
		handle = pressableWithin(root, '[data-cell]');

		root.lastElementChild?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));

		expect(root.querySelectorAll('[data-pressed]')).toHaveLength(0);
	});

	// The same floor and the same cancel path as the per-node action, because it is the same rule.
	// A 90 ms press on a cell is the measured case.
	it('holds the floor and cancels like the per-node action', () => {
		const { root, cells } = grid();
		handle = pressableWithin(root, '[data-cell]');

		cells[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		vi.advanceTimersByTime(90);
		cells[0].dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		expect(cells[0].dataset.pressed).toBe('');

		vi.advanceTimersByTime(PRESS_MIN_MS);
		expect(cells[0].dataset.pressed).toBeUndefined();

		cells[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		cells[1].dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
		expect(cells[1].dataset.pressed).toBeUndefined();
	});
});
