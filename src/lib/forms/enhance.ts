import { enhance as kitEnhance, type SubmitFunction } from '$app/forms';

/**
 * `use:enhance` with every non-redirect result applied to the page it was submitted from.
 *
 * SvelteKit 3's `update()` navigates to the action's location whenever it differs from the current
 * URL, query included: `?/save` posted from `/transactions?category=x` would land on `/transactions`
 * and drop the filters. SvelteKit 2 applied the result in place, and this keeps that (#1336).
 * Redirects are still followed. Every form imports this one; eslint.config.js refuses kit's.
 */
export function enhance<
	Success extends Record<string, unknown> | undefined = Record<string, unknown>,
	Failure extends Record<string, unknown> | undefined = Record<string, unknown>
>(form: HTMLFormElement, submit?: SubmitFunction<Success, Failure>) {
	return kitEnhance<Success, Failure>(form, async (input) => {
		const callback = await submit?.(input);
		return (opts) => {
			const update: typeof opts.update = (options) => opts.update({ navigate: false, ...options });
			return callback ? callback({ ...opts, update }) : update();
		};
	});
}
