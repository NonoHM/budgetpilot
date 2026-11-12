import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../layout.css';

// The REAL `enhance` and its real `update()` (the form reset is the thing measured). Only the
// failure that follows the reset is swallowed: `update()` ends in SvelteKit's client `applyAction`,
// which has no started app in a component test (`root.$set` of undefined), and its rejection would
// be reported as this file's unhandled error.
vi.mock('$app/forms', async (importOriginal) => {
	const forms = await importOriginal<typeof import('$app/forms')>();
	return {
		...forms,
		enhance: ((form, submit) =>
			forms.enhance(form, async (input) => {
				const callback = await submit?.(input);
				return async (opts) => {
					const update: typeof opts.update = (o) => opts.update(o).catch(() => {});
					await (callback ?? (({ update: u }) => u()))({ ...opts, update } as never);
				};
			})) as typeof forms.enhance
	};
});

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * A SUCCESSFUL IMPORT LEFT THE DROP ZONE NAMING A FILE NO INPUT HELD (#1294 walk, narrow pass F1).
 *
 * `enhance`'s `update()` resets the submitted form on success, which empties its `<input type=file>`
 * and fires no `change`, so the page's bound `csvFiles` kept the old FileList: both inputs measured
 * 0 files under « juillet.csv » at 390 and 1280. A press of « Importer le relevé » there posted no
 * file under a name, and #1294's « Changer la réponse » carried that name onto the correction page.
 *
 * Separates « a saved import leaves the page with no file chosen, as its inputs are » from « the page
 * names the statement it just saved ». Break: drop the reset after a success, and the name stays.
 */
const DATA = { user: null, correction: null } as unknown as PageData;
const NO_FILE = 'Aucun fichier sélectionné';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('a saved import leaves no file chosen', () => {
	it('names no file after a success, in both mounts', async () => {
		await page.viewport(1280, 800);
		const action = vi.fn(
			async () => new Response(JSON.stringify({ type: 'success', status: 200 }), { status: 200 })
		);
		vi.stubGlobal('fetch', action);
		const rendered = await render(Page, { data: DATA, form: null });
		const section = rendered.container.querySelectorAll('main > section')[0] as HTMLElement;
		await userEvent.upload(
			section.querySelector('input[type=file]') as HTMLInputElement,
			new File(['a;b;c\n1;2;3\n'], 'juillet.csv', { type: 'text/csv' })
		);
		// Calibration: the name is shown once the file is chosen, so its absence below is a finding.
		await expect.element(page.getByText('juillet.csv').first()).toBeInTheDocument();

		await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);

		// Calibration: the action answered, so what follows is about its success and not a lost press.
		await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(page.getByText(NO_FILE).elements()).toHaveLength(2));
		expect(page.getByText('juillet.csv').elements()).toHaveLength(0);
		const inputs = [
			...rendered.container.querySelectorAll('input[type=file]')
		] as HTMLInputElement[];
		expect(inputs.map((el) => el.files?.length ?? 0)).toEqual([0, 0]);
	});
});
