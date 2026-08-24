import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../layout.css';
import Page from './+page.svelte';
import * as m from '$lib/paraglide/messages';
import type { PageData } from './$types';

/**
 * THE COMPTES SECTION, ASSERTED ON THE PAGE THAT MOUNTS IT.
 *
 * `projection.spec.ts` covers the four rules exhaustively and calls them directly. That says
 * nothing about whether this page puts an account into any of the states they describe, which is
 * the component-versus-page seam this repository keeps rediscovering: Task 10 shipped an export
 * whose builder was perfectly tested and whose CALLER omitted the argument, so the column was empty
 * for every user and no unit test could see it.
 *
 * So every assertion below reads the rendered section, and the fixtures differ only in the field
 * whose effect is being asserted.
 */

const CSV_ROW = {
	id: 'acc-csv',
	displayName: m.accounts_generic_bucket(),
	generic: true,
	discriminant: null,
	transactionCount: 12,
	archived: false,
	netWorthAccountId: null,
	netWorthAccountName: null
};

const BP_ROW = {
	id: 'acc-bp',
	displayName: 'BP ···4417',
	generic: false,
	discriminant: '4417',
	transactionCount: 128,
	archived: false,
	netWorthAccountId: 'nwa-1',
	netWorthAccountName: 'Compte courant'
};

function baseData(overrides: Partial<PageData> = {}): PageData {
	return {
		account: { email: 'demo@example.com', role: 'ADMIN' },
		mfa: { enabled: false },
		security: {
			authMode: 'locale',
			llmEnabled: false,
			runtime: 'local',
			latestSessionCreatedAt: null
		},
		sessions: [],
		tags: [],
		aiSettings: { insightsEnabled: false, includeLabels: false, llmGloballyEnabled: false },
		columnMappings: [],
		columnMappingCap: 50,
		accounts: [CSV_ROW, BP_ROW],
		accountsInvitation: true,
		accountNameMaxLength: 120,
		linkableNetWorthAccounts: [
			{ id: 'nwa-1', name: 'Compte courant' },
			{ id: 'nwa-2', name: 'Livret A' }
		],
		...overrides
	} as unknown as PageData;
}

describe('Settings — the Comptes section', () => {
	it('renders one row per statement account, named the way the projection named it', async () => {
		// SEPARATES: « the page renders `displayName` » FROM « the page renders the stored name ».
		// The generic bucket is the fixture that tells them apart: its stored name is « Compte
		// import CSV » and the sentence a user must read is « Import CSV ».
		expect.assertions(3);
		render(Page, { params: {}, data: baseData(), form: null });
		await expect
			.element(page.getByText(m.accounts_generic_bucket(), { exact: true }))
			.toBeVisible();
		await expect.element(page.getByText('BP ···4417', { exact: true })).toBeVisible();
		// The absolute figure beside the claim: two rows, so a section rendering none would not pass
		// the two assertions above by accident of a substring match elsewhere on a long page.
		expect(page.getByRole('button', { name: /^Renommer / }).elements()).toHaveLength(2);
	});

	it('names the transaction count, and the fragment when there is one', async () => {
		// SEPARATES: « the row says what identifies this account » FROM « the row says its name and
		// stops ». 6f is explicit that without the count two accounts at one bank are
		// indistinguishable in the control built to separate them, and the same holds here.
		expect.assertions(2);
		render(Page, { params: {}, data: baseData(), form: null });
		await expect
			.element(
				page.getByText(m.import_account_option_detail_many({ fragment: '4417', count: 128 }), {
					exact: true
				})
			)
			.toBeVisible();
		await expect
			.element(page.getByText(m.accounts_tx_count_many({ count: 12 }), { exact: true }))
			.toBeVisible();
	});

	it('shows the invitation only when the load says it applies', async () => {
		// SEPARATES: « the sentence is conditional on the projection's answer » FROM « the sentence
		// is always there ». Two renders differing in exactly one boolean, so nothing else can
		// explain the difference. Spec Part N.3: shown to a user whose accounts are all named, the
		// sentence tells them to do something already done.
		expect.assertions(2);
		const shown = render(Page, { params: {}, data: baseData(), form: null });
		await expect.element(page.getByText(m.accounts_invitation())).toBeVisible();
		shown.unmount();

		render(Page, {
			params: {},
			data: baseData({ accountsInvitation: false } as Partial<PageData>),
			form: null
		});
		expect(page.getByText(m.accounts_invitation()).elements()).toHaveLength(0);
	});

	it('an archived row says so, and offers the reverse rather than the same control again', async () => {
		// SEPARATES: « archived is a visible, reversible state » FROM « archived rows vanish ». A
		// user who archived by mistake needs a screen on which to see it; the picker is the one
		// screen that must not offer it, and this is not that screen.
		expect.assertions(3);
		render(Page, {
			params: {},
			data: baseData({
				accounts: [{ ...BP_ROW, archived: true }]
			} as unknown as Partial<PageData>),
			form: null
		});
		await expect.element(page.getByText(m.accounts_archived_notice())).toBeVisible();
		await expect
			.element(
				page.getByRole('button', { name: m.accounts_unarchive_aria({ name: 'BP ···4417' }) })
			)
			.toBeVisible();
		expect(
			page.getByRole('button', { name: m.accounts_archive_aria({ name: 'BP ···4417' }) }).elements()
		).toHaveLength(0);
	});

	it('the rename modal opens EMPTY for the generic bucket and prefilled for a named one', async () => {
		// SEPARATES: « the modal offers the stored key as a starting point » FROM « it does not ».
		// « Compte import CSV » is a storage key the user has never been shown, and prefilling it
		// invites them to keep the machine's name, which is the one thing the invitation is asking
		// them not to do.
		expect.assertions(2);
		render(Page, { params: {}, data: baseData(), form: null });

		await page
			.getByRole('button', { name: m.accounts_rename_aria({ name: m.accounts_generic_bucket() }) })
			.click();
		const empty = page.getByRole('textbox', { name: m.import_account_create_field() });
		await expect.element(empty).toHaveValue('');
		// The absolute figure beside the emptiness: the field is THERE and empty, not absent. An
		// unopened modal has no textbox and would satisfy an emptiness assertion just as well.
		expect(
			page.getByRole('textbox', { name: m.import_account_create_field() }).elements()
		).toHaveLength(1);
	});

	it('the rename modal prefills an account whose name a person chose', async () => {
		expect.assertions(1);
		render(Page, { params: {}, data: baseData(), form: null });
		await page
			.getByRole('button', { name: m.accounts_rename_aria({ name: 'BP ···4417' }) })
			.click();
		await expect
			.element(page.getByRole('textbox', { name: m.import_account_create_field() }))
			.toHaveValue('BP ···4417');
	});

	it('the field carries the cap the server enforces, taken from the server', async () => {
		// SEPARATES: « the bound is one constant » FROM « the field and the refusal each have their
		// own ». A `maxlength` typed as a literal beside a server cap of a different value is a
		// field that silently truncates or a refusal the user cannot see coming.
		expect.assertions(1);
		render(Page, {
			params: {},
			data: baseData({ accountNameMaxLength: 77 } as Partial<PageData>),
			form: null
		});
		await page
			.getByRole('button', { name: m.accounts_rename_aria({ name: 'BP ···4417' }) })
			.click();
		const field = page.getByRole('textbox', { name: m.import_account_create_field() });
		expect(await field.element().getAttribute('maxlength')).toBe('77');
	});

	it('the net worth form posts the value that was just chosen, not the previous one', async () => {
		// SEPARATES: « the form carries the NEW link when it is submitted » FROM « it carries the one
		// the row already had ». This is the whole reason `submitLink` awaits `tick()`:
		// `onValueChange` fires before Svelte has flushed the new value into the DOM, so submitting
		// synchronously posts the PREVIOUS id. The failure is silent and worse than silent, because
		// the screen then re-renders from what the server saved and shows a consistent wrong answer.
		//
		// READ AT SUBMIT TIME, and that is the whole instrument. A first version of this test read
		// the hidden input's value after the click and PASSED with the `tick()` removed: by the time
		// the assertions ran, Svelte had flushed anyway, so it measured the DOM rather than the
		// request. Snapshotting `new FormData(form)` inside a `requestSubmit` spy is what tells the
		// two states apart, and removing the `tick()` now reddens it.
		expect.assertions(4);
		const submitted: { account: string; link: string }[] = [];
		const original = HTMLFormElement.prototype.requestSubmit;
		HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement) {
			const body = new FormData(this);
			submitted.push({
				account: String(body.get('id') ?? ''),
				link: String(body.get('netWorthAccountId') ?? '')
			});
		};

		try {
			render(Page, { params: {}, data: baseData(), form: null });
			await page
				.getByRole('button', {
					name: m.accounts_net_worth_aria({ name: m.accounts_generic_bucket() })
				})
				.click();
			await page.getByRole('option', { name: 'Livret A' }).click();

			// The absolute figure beside the claim: exactly one submission, so a screen that
			// submitted every row's form would not pass the two assertions below by covering them.
			expect(submitted).toHaveLength(1);
			expect(submitted[0].link).toBe('nwa-2');
			// And it is the form of the row that changed. One form reference per account: with a
			// single shared reference, the change lands on whichever row bound it last.
			expect(submitted[0].account).toBe('acc-csv');
		} finally {
			HTMLFormElement.prototype.requestSubmit = original;
		}

		// The restore is asserted rather than assumed: a spy left on a prototype is a mutation with
		// no automatic undo, and the next test in this file submits forms too.
		expect(HTMLFormElement.prototype.requestSubmit).toBe(original);
	});

	it('puts the value back when the server refuses, rather than showing a link it did not save', async () => {
		// SEPARATES: « the control ends on what the SERVER holds » FROM « it ends on what was
		// clicked ». A select that posts on change and paints the new value immediately is making a
		// claim the server has not agreed to. On a refusal the screen would show one link while the
		// banner beside it says the change failed, and two contradicting statements about one
		// account are worse than either alone.
		//
		// Driven through the REAL `use:enhance`, with `fetch` answering a refusal: that is the only
		// instrument that exercises the callback the component actually installs. A first version
		// asserted `typeof value === 'string'` after a timeout, which is green whatever the code
		// does and is the kind of assertion this file exists not to contain.
		// `hasAssertions` rather than a count, and the reason is the instrument: `vi.waitFor` re-runs
		// its body until it passes, so the number of assertions executed is a fact about how many
		// retries the machine needed. Pinning it would make this test flake on a slow run and would
		// be measuring the retry loop rather than the subject.
		expect.hasAssertions();
		/**
		 * `update()` re-renders the page from SvelteKit's own form store, which this harness has not,
		 * so it rejects with `$set of undefined`. Swallowed HERE rather than in the component: a
		 * component that caught it would hide a genuine re-render failure in production, and the
		 * behaviour under test is what happens in the `finally`, which runs either way. Scoped to
		 * this test and removed after it, so a real unhandled rejection elsewhere still reports.
		 */
		const swallowHarnessRejection = (event: PromiseRejectionEvent) => {
			if (String(event.reason).includes('$set')) event.preventDefault();
		};
		window.addEventListener('unhandledrejection', swallowHarnessRejection);
		const originalFetch = globalThis.fetch;
		// HELD OPEN, so the in-flight state is a state this test can READ rather than one it has to
		// take on trust. A fetch that resolves immediately makes « inert while the request is out »
		// and « never inert » the same green, which is exactly what the break matrix caught.
		// Declared with an explicit type rather than inferred: assigned only inside the Promise
		// executor, TypeScript narrows it to `never` at every call site and `release?.()` becomes
		// « not callable ».
		let release: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			release = () => resolve();
		});
		globalThis.fetch = (async () => {
			await held;
			return new Response(JSON.stringify({ type: 'failure', status: 400, data: null }), {
				status: 400,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;

		try {
			render(Page, { params: {}, data: baseData(), form: null });
			const posted = () =>
				document.querySelectorAll<HTMLInputElement>('[data-testid="posted-net-worth"]')[1];
			const trigger = () =>
				page.getByRole('button', { name: m.accounts_net_worth_aria({ name: 'BP ···4417' }) });
			// Calibration: the row starts on the link the load reported, so a change is a CHANGE.
			expect(posted().value).toBe('nwa-1');

			await trigger().click();
			await page.getByRole('option', { name: m.accounts_net_worth_none() }).click();

			// While the request is out the control is inert: it has been asked to save something the
			// server has not answered about, and offering a second change would queue two writes on
			// one row with no way to say which won.
			await vi.waitFor(() => {
				expect(trigger().element().hasAttribute('disabled')).toBe(true);
			});

			release?.();
			await vi.waitFor(() => {
				expect(posted().value).toBe('nwa-1');
			});
			// And the control is usable again: a row left disabled after a refusal is a row the user
			// cannot correct, which turns a recoverable refusal into a dead end.
			expect(trigger().element().hasAttribute('disabled')).toBe(false);
		} finally {
			// Released here too: a held promise nobody resolves keeps a fetch pending past the end of
			// the test, and vitest reports that as an unhandled error against whatever runs next.
			release?.();
			globalThis.fetch = originalFetch;
			window.removeEventListener('unhandledrejection', swallowHarnessRejection);
		}
	});

	it('the empty state says what will fill it rather than that there is nothing', async () => {
		expect.assertions(2);
		render(Page, {
			params: {},
			data: baseData({ accounts: [], accountsInvitation: false } as unknown as Partial<PageData>),
			form: null
		});
		await expect.element(page.getByText(m.accounts_settings_empty())).toBeVisible();
		expect(page.getByRole('button', { name: /^Renommer / }).elements()).toHaveLength(0);
	});

	it('a refusal is shown in the section it was refused in', async () => {
		// SEPARATES: « the section renders `form.accountsError` » FROM « a refusal is swallowed ».
		// Every one of the six refusals reaches the user through this one banner, so a section that
		// did not render it would turn six readable rules into six silent no-ops.
		expect.assertions(1);
		render(Page, {
			params: {},
			data: baseData(),
			form: { accountsError: m.accounts_error_name_taken() } as unknown as null
		});
		await expect.element(page.getByText(m.accounts_error_name_taken())).toBeVisible();
	});
});
