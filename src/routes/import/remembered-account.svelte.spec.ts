import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import { refusalLabel } from '$lib/i18n/refusalLabel';
import { clearPendingDesignation } from '$lib/import/pendingDesignation.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * #599: THE ROW SAYS « MÉMORISÉ » ONLY WHEN THE MEMORY ANSWERED, as a private Claude Design canvas
 * draws it.
 *
 * The server hands this page the account question with `resolution.kind === 'remembered'` when the
 * user answered this statement's account number before. The row then arrives chosen, with the
 * existing hint `import_account_hint_from_memory`, and the answer rides the next press. Every other
 * resolution leaves the row as #476 draws it: unanswered, no hint.
 */

const OPTIONS = [
	{ id: 'acc-courant', name: 'Compte courant', discriminant: '4417', transactionCount: 128 },
	{ id: 'acc-joint', name: 'Compte joint', discriminant: null, transactionCount: 12 }
];

const offer = (resolution: Record<string, unknown>, memory: Record<string, unknown> | null) => ({
	options: OPTIONS,
	resolution,
	prefillName: '',
	memory,
	chosenId: null
});

const REMEMBERED = offer(
	{ rank: 3, kind: 'remembered', accountId: 'acc-joint' },
	{ useCount: 3, rememberedAt: '2026-08-15T12:00:00.000Z' }
);
const UNKNOWN = offer({ rank: 3, kind: 'unknown' }, null);

const DATA: PageData = { user: null, correction: null } as unknown as PageData;

async function mount(
	account: unknown,
	width: number,
	error: string = m.import_account_error_required()
) {
	// `answers` as the route sends it with every question (`kept`): FOUND BY THE WALK, a fixture
	// without it let the pre-fill pass here while the page's reply effect cleared it in the browser.
	const form = {
		error,
		account,
		answers: { key: 'k', dateOrder: null, accountId: null, accountColumnAnswer: null }
	};
	const rendered = await render(Page, { data: DATA, form: form as never });
	const sections = rendered.container.querySelectorAll('main > section');
	return (width >= 1024 ? sections[0] : sections[1]) as HTMLElement;
}

async function chooseAndSubmit(section: HTMLElement) {
	const input = section.querySelector('input[type=file]') as HTMLInputElement;
	await userEvent.upload(input, new File([`a,b,c\n1,2,3\n`], 'releve.csv', { type: 'text/csv' }));
	await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);
}

const question = (section: HTMLElement) =>
	section.querySelector('[data-testid="import-account-question"]') as HTMLElement;

const posted = (section: HTMLElement) =>
	(section.querySelector('input[name="accountId"]') as HTMLInputElement | null)?.value ?? null;

/** The hint the canvas draws, built by the catalogue, never retyped. */
const HINT = m.import_account_hint_from_memory({ count: 3, date: '15 août' });

beforeEach(() => {
	clearPendingDesignation();
	vi.clearAllMocks();
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response(
					JSON.stringify({ type: 'failure', status: 400, data: '[{"error":1},"Refusé"]' }),
					{ status: 400 }
				)
		)
	);
});

/**
 * M1 (contradiction pass): the currency refusal comes back with the SAME remembered resolution,
 * because the server rebuilds the offer. Pre-filling it again would post the refused account on the
 * next press, and hiding the banner would hide the only sentence saying why: a loop with its
 * reason hidden. Remembered account in USD, file declares EUR.
 */
const CURRENCY_REFUSED = {
	...offer(
		{ rank: 3, kind: 'remembered', accountId: 'acc-joint' },
		{ useCount: 3, rememberedAt: '2026-08-15T12:00:00.000Z' }
	),
	options: [
		{ ...OPTIONS[0], currency: 'EUR' },
		{ ...OPTIONS[1], currency: 'USD' }
	],
	declaredCurrency: 'EUR'
};
const EUR_INTO_USD = refusalLabel({
	code: 'declared-currency-mismatch',
	declared: 'EUR',
	destination: 'USD'
});

describe('the remembered account and the currency refusal', () => {
	it('does not pre-fill an account in another currency, and shows why', async () => {
		// SEPARATES « the refusal's reason on screen, the row unanswered » FROM « the refused
		// account posted again under a hidden banner ».
		await page.viewport(1280, 800);
		const section = await mount(CURRENCY_REFUSED, 1280, EUR_INTO_USD);
		await chooseAndSubmit(section);

		expect(posted(section)).toBe('');
		expect(section.textContent).toContain(EUR_INTO_USD);
		expect(question(section).textContent).not.toContain(HINT);
	});
});

describe('the account row when the memory answered', () => {
	it('arrives chosen, says « Mémorisé », and posts the remembered account, at 1280', async () => {
		// SEPARATES « the memory pre-fills the row and says so » FROM « the row asks as if nothing
		// were remembered » (#696's dead reader) and from « chosen with no provenance ».
		await page.viewport(1280, 800);
		const section = await mount(REMEMBERED, 1280);
		await chooseAndSubmit(section);

		await expect.element(page.getByText(HINT).first()).toBeVisible();
		expect(question(section).textContent).toContain('Compte joint');
		expect(posted(section)).toBe('acc-joint');
	});

	it('does the same at 390', async () => {
		await page.viewport(390, 844);
		const section = await mount(REMEMBERED, 390);
		await chooseAndSubmit(section);

		expect(question(section).textContent).toContain(HINT);
		expect(posted(section)).toBe('acc-joint');
	});

	it('says nothing of memory, and chooses nothing, when the memory did not answer', async () => {
		// SEPARATES « the hint ONLY when memory answered » FROM « the hint on every question ».
		// Calibrated: the question itself is on screen, so the absence is about the hint.
		await page.viewport(1280, 800);
		const section = await mount(UNKNOWN, 1280);
		await chooseAndSubmit(section);

		expect(question(section)).not.toBeNull();
		// « Mémorisé », the word both memory sentences open with, read off the catalogue; the first
		// test is its positive calibration.
		expect(question(section).textContent).not.toContain(HINT.split(',')[0]);
		expect(posted(section)).toBe('');
	});

	it('hides the « choisissez » banner while the row holds the remembered account', async () => {
		// SEPARATES « the hint explains the pre-fill, so the banner asking to choose is withdrawn »
		// FROM « a red banner above an already answered row » (controller ruling, currency-refusal
		// precedent). Both mounts are checked: the banner is rendered once per mount.
		for (const width of [1280, 390]) {
			await page.viewport(width, width === 390 ? 844 : 800);
			const section = await mount(REMEMBERED, width);
			await chooseAndSubmit(section);
			expect(question(section).textContent).toContain(HINT);
			expect(section.textContent).not.toContain(m.import_account_error_required());
		}
	});

	it('keeps the banner when the memory did not answer', async () => {
		// The calibration of the case above: the same banner, same fixture shape, is on screen.
		await page.viewport(1280, 800);
		const section = await mount(UNKNOWN, 1280);
		await chooseAndSubmit(section);
		expect(section.textContent).toContain(m.import_account_error_required());
	});

	it('drops the hint once the user picks another account', async () => {
		// SEPARATES « a provenance describes the answer on the row » FROM « it survives a choice
		// that replaced it », which would say the user's own pick was remembered.
		await page.viewport(1280, 800);
		const section = await mount(REMEMBERED, 1280);
		await chooseAndSubmit(section);

		await userEvent.click(question(section).querySelector('button') as HTMLElement);
		await userEvent.click(page.getByRole('option', { name: /Compte courant/ }).first());

		expect(posted(section)).toBe('acc-courant');
		expect(question(section).textContent).not.toContain(HINT);
	});
});

describe('#599 question: « Nouveau compte » (M2)', () => {
	it('offers the footer when the server says the file names another account', async () => {
		// SEPARATES « the user can answer with a new account » FROM « only the accounts they hold ».
		// Calibrated by the plain question below, which must not offer it.
		await page.viewport(1280, 800);
		const section = await mount({ ...UNKNOWN, allowCreate: true }, 1280);
		await chooseAndSubmit(section);
		await userEvent.click(question(section).querySelector('button') as HTMLElement);
		await expect
			.element(page.getByRole('button', { name: m.import_account_new() }).first())
			.toBeVisible();
	});

	it('does not offer it on the plain question', async () => {
		await page.viewport(1280, 800);
		const section = await mount(UNKNOWN, 1280);
		await chooseAndSubmit(section);
		await userEvent.click(question(section).querySelector('button') as HTMLElement);
		expect(document.body.textContent).not.toContain(m.import_account_new());
	});
});
