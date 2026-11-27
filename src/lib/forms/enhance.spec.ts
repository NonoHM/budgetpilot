import { describe, expect, it, vi } from 'vitest';

// SvelteKit 3's `update()` NAVIGATES to the action's location whenever it differs from the current
// URL, query included, so `?/save` posted from `/transactions?category=x` lands on `/transactions`
// and the filters are gone. SvelteKit 2 applied every result in place (#1336). These separate a
// wrapper that keeps results in place from one that lets kit navigate, through the one thing the
// wrapper controls: the options `update` reaches kit with.
const kit = vi.hoisted(() => ({ enhance: vi.fn() }));
vi.mock('$app/forms', () => kit);

const { enhance } = await import('./enhance');

/** Runs one submission through what the wrapper handed kit, and returns what kit's update got. */
async function submitThrough(submit?: Parameters<typeof enhance>[1]) {
	kit.enhance.mockClear();
	enhance({} as HTMLFormElement, submit);
	const [, wrapped] = kit.enhance.mock.calls[0];
	const kitUpdate = vi.fn(async () => {});
	const callback = await wrapped({ cancel: () => {}, formData: new FormData() });
	await callback({ result: { type: 'success', status: 200 }, update: kitUpdate });
	return kitUpdate.mock.calls;
}

describe('the house enhance', () => {
	it('applies a bare form in place', async () => {
		expect(await submitThrough()).toEqual([[{ navigate: false }]]);
	});

	it('applies in place when a callback calls update, keeping its own options', async () => {
		const calls = await submitThrough(
			() =>
				async ({ update }) =>
					update({ reset: false })
		);
		expect(calls).toEqual([[{ navigate: false, reset: false }]]);
	});

	it('never calls update for a callback that does not', async () => {
		expect(await submitThrough(() => async () => {})).toEqual([]);
	});
});
