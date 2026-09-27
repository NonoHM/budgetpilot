import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import { clearPendingDesignation } from '$lib/import/pendingDesignation.svelte';
import { takePendingCollision } from '$lib/import/pendingCollision.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * #600, THE WAY FORWARD AFTER THE CURRENCY REFUSAL, on the page's side.
 *
 * The server answers a file declaring EUR, filed into a USD account, with the refusal AND the
 * account question (`+page.server.ts`'s `currency` rung), and without the refused account in the
 * answers it keeps. What is measured here is the page's half: the question is on screen beside the
 * sentence that asks for it, and it reopens UNANSWERED rather than still showing the account just
 * refused. MEASURED by a browser walk before this: the row came back reading « Compte, Checking
 * USD », so a user pressing Import again posted the refused account and met the same refusal.
 */

const KEY = 'b'.repeat(64);
const DATA: PageData = { user: null, correction: null } as unknown as PageData;

const ACCOUNT_OFFER = {
	options: [
		{
			id: 'acc-courant',
			name: 'Compte courant',
			discriminant: null,
			transactionCount: 12,
			currency: 'EUR'
		},
		{
			id: 'acc-usd',
			name: 'Checking USD',
			discriminant: null,
			transactionCount: 3,
			currency: 'USD'
		}
	],
	resolution: { rank: 3, candidates: [] },
	prefillName: 'CSV',
	memory: null,
	chosenId: null
};

const answers = (accountId: string | null) => ({
	key: KEY,
	accountId,
	dateOrder: null,
	accountColumnAnswer: null
});

/** The account question, first asked. */
const ACCOUNT_ASKED = {
	error: m.import_account_error_ambiguous_auto(),
	account: ACCOUNT_OFFER,
	answers: answers(null)
};

/** The server's reply to the USD answer: refused, the question back, the account not kept. */
const CURRENCY_REFUSED = {
	error: refusalLabel({ code: 'declared-currency-mismatch', declared: 'EUR', destination: 'USD' }),
	account: { ...ACCOUNT_OFFER, declaredCurrency: 'EUR' },
	answers: answers(null)
};

const file = () => new File([`date,label,amount,currency\n`], 'releve.csv', { type: 'text/csv' });

const posted = (section: HTMLElement, name: string) =>
	[...section.querySelectorAll(`form input[name="${name}"]`)].map(
		(input) => (input as HTMLInputElement).value
	);

beforeEach(() => {
	clearPendingDesignation();
	takePendingCollision();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('after the currency refusal, the account question is back and unanswered', () => {
	it('shows the question beside the refusal, reopened without the refused account', async () => {
		await page.viewport(1280, 800);
		const rendered = await render(Page, { data: DATA, form: ACCOUNT_ASKED as never });
		const section = rendered.container.querySelectorAll('main > section')[0] as HTMLElement;
		await userEvent.upload(section.querySelector('input[type=file]') as HTMLInputElement, file());
		await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);
		await userEvent.click(
			section.querySelector('[data-testid="import-account-question"] button') as HTMLElement
		);
		await userEvent.click(page.getByRole('option', { name: /Checking USD/ }).element());
		// The calibration: the USD answer is what the page was about to post.
		expect(posted(section, 'accountId')).toEqual(['acc-usd']);

		await rendered.rerender({ data: DATA, form: CURRENCY_REFUSED as never });

		const question = section.querySelector('[data-testid="import-account-question"]');
		// SEPARATES: « the refusal comes with the control it names » FROM « a sentence naming a
		// choice the screen does not offer », which the walk measured.
		// The banner's own sentence, compared whole (a substring would pass over a doubled tail).
		expect(
			[...section.querySelectorAll('[role="alert"] span.min-w-0')].map((banner) =>
				banner.textContent?.trim()
			)
		).toContain(CURRENCY_REFUSED.error);
		expect(question).not.toBeNull();
		// SEPARATES: « reopened unanswered » FROM « still holding the refused account », which posts
		// it again and meets the same refusal.
		expect(question?.querySelector('button')?.getAttribute('aria-label')).not.toContain(
			'Checking USD'
		);
		expect(posted(section, 'accountId')).toEqual(['']);
	});

	it('mutes, in the reopened panel, the account the declared currency rules out', async () => {
		// SEPARATES: « the page hands the panel the currency the refusal named » FROM « the panel is
		// reopened with every account reading alike », which is the canvas's one addition
		// (a private Claude Design canvas): the sentence asks for a EUR account
		// and the panel must say which accounts those are.
		await page.viewport(1280, 800);
		const rendered = await render(Page, { data: DATA, form: ACCOUNT_ASKED as never });
		const section = rendered.container.querySelectorAll('main > section')[0] as HTMLElement;
		await userEvent.upload(section.querySelector('input[type=file]') as HTMLInputElement, file());
		await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);
		await rendered.rerender({ data: DATA, form: CURRENCY_REFUSED as never });
		await userEvent.click(
			section.querySelector('[data-testid="import-account-question"] button') as HTMLElement
		);

		const nameOf = (label: RegExp) =>
			[...section.querySelectorAll('[role="option"]')]
				.find((option) => label.test(option.getAttribute('aria-label') ?? ''))
				?.querySelector(':scope > span > span');
		expect(nameOf(/^Compte courant, EUR,/)?.className).toContain('text-zinc-900');
		expect(nameOf(/^Checking USD, USD,/)?.className).toContain('text-zinc-500');
	});
});

/**
 * #741, THE REFUSAL'S WAY FORWARD. A user holding no account in the declared currency was told
 * « Choisissez un compte en EUR » over a panel that could not produce one. The panel's « Nouveau
 * compte » is now offered in the currency-refusal state, and ONLY there (a private Claude Design
 * canvas draws it on the refusal alone).
 */
describe('#741: « Nouveau compte » on the currency refusal', () => {
	/** Uploads, submits, and lands on `reply`, with the account panel opened, at 1280. */
	async function panelAfter(reply: object) {
		await page.viewport(1280, 800);
		const rendered = await render(Page, { data: DATA, form: ACCOUNT_ASKED as never });
		const section = rendered.container.querySelectorAll('main > section')[0] as HTMLElement;
		await userEvent.upload(section.querySelector('input[type=file]') as HTMLInputElement, file());
		await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);
		await rendered.rerender({ data: DATA, form: reply as never });
		await userEvent.click(
			section.querySelector('[data-testid="import-account-question"] button') as HTMLElement
		);
		return section;
	}

	/** The footer actions in the open panel, counted by their visible name. */
	const footerActions = (section: HTMLElement) =>
		[...section.querySelectorAll('[data-testid="account-panel"] button')].filter(
			(button) => button.textContent?.trim() === m.import_account_new()
		);

	it('is absent from the plain account question', async () => {
		// SEPARATES: « the footer belongs to the refusal state » FROM « the footer is always shown »
		// (the break: `allowCreate` true on every mount). The options are counted beside it, so a
		// zero here is a panel that rendered and not a panel that did not open.
		const section = await panelAfter(ACCOUNT_ASKED);
		expect(section.querySelectorAll('[data-testid="account-panel"] [role="option"]').length).toBe(
			2
		);
		expect(footerActions(section).length).toBe(0);
	});

	it('is offered, once, on the currency refusal', async () => {
		// SEPARATES: « the refusal offers the way forward » FROM « the footer is never shown », the
		// dead end #741 measured. Also the calibration of the count the test above reads as zero.
		const section = await panelAfter(CURRENCY_REFUSED);
		expect(footerActions(section).length).toBe(1);
	});

	it('creates the account in the declared currency, chooses it, and clears the banner', async () => {
		const section = await panelAfter(CURRENCY_REFUSED);
		const created = {
			id: 'acc-new',
			name: 'Compte joint',
			discriminant: null,
			transactionCount: 0,
			currency: 'EUR'
		};
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ account: created })));
		vi.stubGlobal('fetch', fetchSpy);

		await userEvent.click(footerActions(section)[0] as HTMLElement);
		// The one line the sheet gains, compared WHOLE: a substring would pass over a doubled tail.
		// SEPARATES: « the sheet says which currency the account will be in » FROM « the sheet reads
		// as on the designation screen », where nothing names it.
		expect(
			[...document.querySelectorAll('[role="dialog"] p')].map((line) => line.textContent?.trim())
		).toContain(m.import_account_create_currency({ currency: 'EUR' }));
		await userEvent.fill(page.getByLabelText(m.import_account_create_field()), 'Compte joint');
		await userEvent.click(page.getByRole('button', { name: m.import_account_create_submit() }));

		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
		const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: FormData }];
		// SEPARATES: « the refusal's own currency is posted » FROM « the account is created in the
		// default », which the endpoint does with no `currency` field (the break: the field not set).
		// Its stored consequence is asserted through the route in `accounts/declaredCurrency.db-smoke.ts`.
		expect({
			url: String(url).endsWith('/import/accounts'),
			name: init.body.get('name'),
			currency: init.body.get('currency'),
			file: (init.body.get('csvFile') as File | null)?.name
		}).toStrictEqual({ url: true, name: 'Compte joint', currency: 'EUR', file: 'releve.csv' });

		const row = section.querySelector('[data-testid="import-account-question"] button');
		// SEPARATES: « the created account is chosen, by its name ALONE » FROM « the row still asks »,
		// and from a row carrying a provenance line under the name (the live rule: a created account
		// has none).
		await vi.waitFor(() =>
			expect(row?.getAttribute('aria-label')).toBe(
				m.import_account_row_aria({ account: 'Compte joint' })
			)
		);
		expect(row?.getAttribute('aria-describedby')).toBeNull();
		// The answer rides the next « Importer le relevé ».
		expect(posted(section, 'accountId')).toEqual(['acc-new']);
		// SEPARATES: « the banner clears once an account in the declared currency is chosen » FROM
		// « the refusal still stands over its own answer » (the break: the banner's condition without
		// `currencyRefusalAnswered`). The next test is this zero's calibration on the same banner.
		expect(section.querySelectorAll('[role="alert"]').length).toBe(0);
	});

	it('keeps the banner while the chosen account is still in another currency', async () => {
		// Choosing the USD account answers nothing the refusal asked, so the sentence stays.
		const section = await panelAfter(CURRENCY_REFUSED);
		await userEvent.click(page.getByRole('option', { name: /Checking USD/ }).element());
		expect(posted(section, 'accountId')).toEqual(['acc-usd']);
		expect(
			[...section.querySelectorAll('[role="alert"] span.min-w-0')].map((banner) =>
				banner.textContent?.trim()
			)
		).toEqual([CURRENCY_REFUSED.error]);
	});
});
