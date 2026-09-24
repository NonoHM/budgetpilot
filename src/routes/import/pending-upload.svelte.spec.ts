import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * #395, half 1: `/import` said nothing while a statement parsed.
 *
 * The form was a bare `use:enhance` and its submit `Button` received neither `loading` nor
 * `busyLabel`, so a press produced no answer on the control that was pressed, at either width, and
 * a second press posted the statement again. Planche 5f's rule applies: the answer appears on the
 * control that was pressed, through the registered occupancy contract (`Button`'s `busyLabel`,
 * whose own battery is `busy-and-failure.svelte.spec.ts`). What is measured HERE is the host: that
 * the contract is wired to the request's real lifetime, on both mounts, and that the form refuses
 * to send a second request while the first is out.
 *
 * ## The request is held open by the test, and counted
 *
 * `fetch` is stubbed with a response the test releases by hand, so « while the request is out » is
 * a state the test holds rather than a race it hopes to win. Every assertion about the busy state
 * is read through `expect.element`, which retries, because a read taken synchronously after the
 * press measures Svelte's batching and not the page.
 */

const DATA = { user: null, correction: null } as unknown as PageData;

let requests = 0;
let release: ((response: Response) => void) | null = null;

/**
 * A refusal the page can apply, serialised the way SvelteKit sends one. `data` is devalue's
 * encoding of `{ error: 'Refusé' }`.
 */
const REFUSAL = () =>
	new Response(JSON.stringify({ type: 'failure', status: 400, data: '[{"error":1},"Refusé"]' }), {
		status: 400
	});

/** A recognised file whose bank the user holds two accounts for: the page asks which one. */
const ACCOUNT_REFUSAL = {
	error: m.import_account_error_ambiguous_auto(),
	account: {
		options: [
			{
				id: 'acc-courant',
				name: 'BP · Compte courant',
				discriminant: '4417',
				transactionCount: 128
			},
			{ id: 'acc-livret', name: 'BP · Livret A', discriminant: '9032', transactionCount: 12 }
		],
		resolution: { rank: 3, candidates: [] },
		prefillName: 'Banque Populaire',
		memory: null,
		chosenId: null
	}
};

beforeEach(() => {
	requests = 0;
	release = null;
	vi.stubGlobal(
		'fetch',
		vi.fn(() => {
			requests += 1;
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		})
	);
});

/** This page renders its whole content twice; section 0 is the 1280 mount, section 1 the 390. */
async function mountAt(width: 1280 | 390) {
	await page.viewport(width, width === 1280 ? 800 : 844);
	const rendered = await render(Page, { data: DATA, form: null as never });
	const sections = rendered.container.querySelectorAll('main > section');
	const section = (width === 1280 ? sections[0] : sections[1]) as HTMLElement;
	return { section, sections: [...sections] as HTMLElement[] };
}

const submitIn = (section: HTMLElement) =>
	section.querySelector('button[type=submit]') as HTMLButtonElement;

/** Chooses a statement and presses the submit FROM THE KEYBOARD, which is what keeps focus on it. */
async function pressImport(section: HTMLElement) {
	const input = section.querySelector('input[type=file]') as HTMLInputElement;
	await userEvent.upload(input, new File(['a,b,c\n1,2,3\n'], 'releve.csv', { type: 'text/csv' }));
	const submit = submitIn(section);
	submit.focus();
	await userEvent.keyboard('{Enter}');
	await expect.poll(() => requests).toBe(1);
	return submit;
}

describe.each([1280, 390] as const)(
	'the /import submit at %i while the statement is out',
	(width) => {
		// SEPARATES: « the control says it is occupied » FROM « nothing answers the press », which was the
		// defect at both widths. Break-checked: dropping `loading` turns this red at both widths.
		//
		// THE FIGURES BELOW ARE FROM THE BREAK-CHECK of 2026-09-24, one clause at a time. Dropping
		// `loading` reddens every test that waits for the busy state (6 per width). Dropping
		// `busyLabel` reddens « native disabled », « focus » and « verb » and leaves this one green,
		// because `loading` alone still sets `aria-busy`: the two props are separate clauses.
		it('carries aria-busy', async () => {
			const { section } = await mountAt(width);
			const submit = await pressImport(section);

			await expect.element(submit).toHaveAttribute('aria-busy', 'true');
		});

		// SEPARATES: « occupied » FROM « disabled ». The native attribute sends focus to the body at the
		// moment the user is waiting at the control they pressed, which the plate forbids by name.
		// Break-checked: dropping `busyLabel` turns this red, since `Button` then falls back to the
		// plain `loading` spinner, which IS natively disabled. Passing `disabled={uploading}` from here
		// leaves it GREEN, and that is the contract working rather than a blind spot: a busy `Button`
		// computes `disabled` as false whatever its host passes, which `busy-and-failure.svelte.spec.ts`
		// owns.
		it('does not carry the native disabled attribute', async () => {
			const { section } = await mountAt(width);
			const submit = await pressImport(section);
			await expect.element(submit).toHaveAttribute('aria-busy', 'true');

			expect(submit.hasAttribute('disabled')).toBe(false);
		});

		// SEPARATES: « focus stays where the user pressed » FROM « focus falls to the body ». Read after
		// the busy state has rendered, since a focus read before it proves nothing about it.
		it('keeps the focus on the pressed control', async () => {
			const { section } = await mountAt(width);
			const submit = await pressImport(section);
			await expect.element(submit).toHaveAttribute('aria-busy', 'true');

			expect(document.activeElement).toBe(submit);
		});

		// SEPARATES: « the action's own verb, in its course » FROM « a bare spinner with a generic
		// fallback ». The SENTENCE is compared, not a fragment of it. Break: drop `busyLabel` and the
		// Button falls back to its sr-only « En cours… » with no visible text.
		it('shows the verb of the action it is doing', async () => {
			const { section } = await mountAt(width);
			const submit = await pressImport(section);

			await expect.element(submit).toHaveTextContent(m.import_columns_submitting());
		});

		// SEPARATES: « a second press while the first is out sends nothing » FROM « it posts the
		// statement again », which measured 3 requests for three presses before the fix. Counted on
		// the requests, not on the button's rendering. TWO guards stand behind this press, the busy
		// `Button`'s swallow and `submitUpload`'s `cancel()`, and break-checked, removing the
		// `cancel()` alone leaves this green: the swallow holds. The test below is the one that sees
		// the `cancel()`.
		it('sends no second request on a second press', async () => {
			const { section } = await mountAt(width);
			const submit = await pressImport(section);
			await expect.element(submit).toHaveAttribute('aria-busy', 'true');

			await userEvent.keyboard('{Enter}');
			submit.click();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(requests).toBe(1);
		});

		// THE FORM'S OWN GUARD, which the test above cannot see: the Button swallows ITS clicks, and a
		// form can be submitted without its button (`requestSubmit`, or the other mount's form, which is
		// a second `<form>` element). SEPARATES: « the page refuses a second submission while one is out »
		// FROM « only the pressed button refuses ». Break-checked: dropping the `cancel()` for a busy
		// upload turns this red at both widths and nothing else.
		it('refuses a second submission of either form while one is out', async () => {
			const { section, sections } = await mountAt(width);
			await pressImport(section);

			for (const each of sections) each.querySelector('form')!.requestSubmit();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(requests).toBe(1);
		});

		// A PRESS THE PAGE REFUSES ITSELF IS NOT A REQUEST, and the busy state made the difference
		// visible. The page asks its own questions before posting (the account row here), and its guard
		// used to run in the form's `onsubmit` while `enhance`, which never reads `defaultPrevented`
		// (read in its source), posted anyway. With the occupancy contract wired,
		// that request would also have painted « Import en cours… » over a press the page had just
		// answered with « choose an account ». SEPARATES: « the local refusal is the whole answer » FROM
		// « it is answered locally AND posted ». Break-checked: restoring the pre-move behaviour (the
		// guard answers, the post goes ahead) counts 2 at both widths and reddens nothing else.
		it('sends nothing, and does not go busy, on a press the page refuses itself', async () => {
			await page.viewport(width, width === 1280 ? 800 : 844);
			const rendered = await render(Page, { data: DATA, form: ACCOUNT_REFUSAL as never });
			const section = rendered.container.querySelectorAll('main > section')[
				width === 1280 ? 0 : 1
			] as HTMLElement;
			// The first press is what makes the refusal describe the file in hand.
			const submit = await pressImport(section);
			release!(REFUSAL());
			await expect.element(submit).toHaveAttribute('aria-busy', 'false');

			submit.focus();
			await userEvent.keyboard('{Enter}');
			const row = section.querySelector('[data-testid="import-account-question"] button');
			await expect.poll(() => document.activeElement).toBe(row);

			expect(requests).toBe(1);
			expect(submit.getAttribute('aria-busy')).toBe('false');
		});

		// SEPARATES: « the occupancy ends with the answer » FROM « the control stays occupied for ever »,
		// which is what a guard with no reset would ship: a page that can never import twice.
		// Break-checked: emptying the `finally` reddens this and the test above, which needs its first
		// press released.
		it('is released when the answer arrives', async () => {
			const { section } = await mountAt(width);
			const submit = await pressImport(section);
			await expect.element(submit).toHaveAttribute('aria-busy', 'true');

			release!(REFUSAL());

			await expect.element(submit).toHaveAttribute('aria-busy', 'false');
			await expect.element(submit).toHaveTextContent(m.import_submit());
		});
	}
);
