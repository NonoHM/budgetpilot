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
