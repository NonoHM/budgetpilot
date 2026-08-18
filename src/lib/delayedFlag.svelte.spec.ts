import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDelayedFlag } from './delayedFlag.svelte';

/**
 * Brique 9's 300 ms, both halves, on a controlled clock.
 *
 * The threshold is a FILTER and the floor is what makes it honest. Each test names the two instants
 * it separates, because a duration asserted against the runner's scheduling is an assertion about
 * the runner.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the 300 ms filter', () => {
	// Separates « the load was short » from « the load was short and the screen flickered anyway ».
	// A 200 ms load is the case the threshold exists for and it must show NOTHING.
	it('shows nothing for a load that beats the threshold', () => {
		const flag = createDelayedFlag();
		flag.set(true);
		vi.advanceTimersByTime(200);
		flag.set(false);
		vi.advanceTimersByTime(1000);

		expect(flag.shown).toBe(false);
		flag.destroy();
	});

	it('shows once the threshold is crossed', () => {
		const flag = createDelayedFlag();
		flag.set(true);
		vi.advanceTimersByTime(299);
		expect(flag.shown).toBe(false);

		vi.advanceTimersByTime(2);
		expect(flag.shown).toBe(true);
		flag.destroy();
	});
});

describe('the exit floor', () => {
	// THE MEASURED CASE the floor exists for: an answer at 320 ms. Without a floor the skeleton is
	// on screen for 20 ms, which is worse than never showing it.
	it('holds the state when the answer arrives just past the threshold', () => {
		const flag = createDelayedFlag();
		flag.set(true);
		vi.advanceTimersByTime(320);
		expect(flag.shown).toBe(true);

		flag.set(false);
		// Still up 20 ms after the answer, which is the whole point.
		vi.advanceTimersByTime(20);
		expect(flag.shown).toBe(true);

		vi.advanceTimersByTime(300);
		expect(flag.shown).toBe(false);
		flag.destroy();
	});

	// The other side of the boundary: a load long enough that the floor is already paid.
	it('hides immediately when the floor has already elapsed', () => {
		const flag = createDelayedFlag();
		flag.set(true);
		vi.advanceTimersByTime(2000);
		flag.set(false);

		expect(flag.shown).toBe(false);
		flag.destroy();
	});

	// A second load starting while the first is serving out its floor must not be cut short by the
	// pending exit timer.
	it('a load starting inside the floor cancels the pending exit', () => {
		const flag = createDelayedFlag();
		flag.set(true);
		vi.advanceTimersByTime(320);
		flag.set(false);
		flag.set(true);
		vi.advanceTimersByTime(1000);

		expect(flag.shown).toBe(true);
		flag.destroy();
	});
});
