import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import { clearPendingDesignation } from '$lib/import/pendingDesignation.svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * #433's auto-path remainder, plate 7l: the reading question on the host that never had one.
 *
 * A recognised bank whose date column proves neither reading used to import silently under the
 * day-first default. The refusal now carries the control that answers it, exactly the shape #476
 * gave the account question: `ColumnPicker` is a registered brique with its own battery, so what is
 * measured here is the HOST — whether the question renders beside the refusal, whether the answer
 * reaches the request, whether it survives the mount this page renders twice, and whether it stops
 * describing a file the user has since replaced.
 */

const HEADERS = ['Date operation', 'Libelle', 'Montant'];

/** Column 0 ambiguous both ways: 06/01 is the first data row, 07/02 and 08/03 the samples. */
const READING_OFFER = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: [
		['07/02/2026', '08/03/2026', '09/04/2026'],
		['CARREFOUR', 'SNCF', 'EDF'],
		['-12,90', '-45,00', '-83,10']
	],
	firstRow: ['06/01/2026', 'CARREFOUR', '-12,90'],
	detectedHeaderRow: true,
	rowCount: 3,
	dateColumn: 0,
	dateReadings: [
		{
			dayFirst: ['2026-01-06', '2026-02-07', '2026-03-08', '2026-04-09'],
			monthFirst: ['2026-06-01', '2026-07-02', '2026-08-03', '2026-09-04']
		},
		{ dayFirst: [null, null, null, null], monthFirst: [null, null, null, null] },
		{ dayFirst: [null, null, null, null], monthFirst: [null, null, null, null] }
	]
};

const DATA: PageData = { user: null, correction: null } as unknown as PageData;

const FORM = {
	error: m.import_error_ambiguous_date_order(),
	reading: READING_OFFER
} as unknown as Record<string, unknown>;

/** This page renders its whole content twice; section 0 is desktop, section 1 is the 390 mount. */
function mount(width: number) {
	const rendered = render(Page, { data: DATA, form: FORM as never });
	const sections = rendered.container.querySelectorAll('main > section');
	return {
		section: (width >= 1024 ? sections[0] : sections[1]) as HTMLElement,
		container: rendered.container
	};
}

const file = (name: string) => new File([`a,b,c\n1,2,3\n`], name, { type: 'text/csv' });

/** Puts a file in the picker AND submits, which is what makes the refusal describe that file. */
async function chooseAndSubmit(section: HTMLElement, named = 'releve.csv') {
	const input = section.querySelector('input[type=file]') as HTMLInputElement;
	await userEvent.upload(input, file(named));
	await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);
}

const questionIn = (section: HTMLElement) =>
	section.querySelector('[data-testid="import-reading-question"]') as HTMLElement | null;

const postedOrder = (section: HTMLElement) =>
	(section.querySelector('input[name="dateOrder"]') as HTMLInputElement | null)?.value ?? null;

beforeEach(() => {
	clearPendingDesignation();
	vi.clearAllMocks();
});

describe('the reading question beside an import refusal', () => {
	it('draws the control that answers the refusal, at 1280', async () => {
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);

		expect(questionIn(section)).not.toBeNull();
		await expect
			.element(page.getByText(m.import_error_ambiguous_date_order()).first())
			.toBeVisible();
	});

	it('draws it at 390 too', async () => {
		await page.viewport(390, 844);
		const { section } = mount(390);
		await chooseAndSubmit(section);

		expect(questionIn(section)).not.toBeNull();
	});

	/**
	 * THE ONE DIFFERENCE FROM THE ACCOUNT QUESTION. There the unanswered field posts '': there is
	 * no honest default for which account a statement belongs to. Here there is one, plate 7a's
	 * "day-first, always stated", and posting it explicitly is what stops the retry repeating the
	 * exact same refusal forever.
	 */
	it('posts the day-first default before any card is chosen', async () => {
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);

		expect(postedOrder(section)).toBe('day-first');
	});

	it('opens at the reading step alone, two cards and no column list', async () => {
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);

		await userEvent.click(questionIn(section)!.querySelector('button') as HTMLElement);

		await expect.element(page.getByText(m.import_datesheet_title()).first()).toBeVisible();
		expect(page.getByRole('option').elements()).toHaveLength(2);
	});

	it('puts the chosen reading into the request', async () => {
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);

		await userEvent.click(questionIn(section)!.querySelector('button') as HTMLElement);
		await userEvent.click(
			page.getByRole('option', { name: /Mois puis jour/ }).element() as HTMLElement
		);

		expect(postedOrder(section)).toBe('month-first');
	});

	it('carries one answer across both mounts', async () => {
		await page.viewport(1280, 800);
		const { container, section } = mount(1280);
		await chooseAndSubmit(section);
		await userEvent.click(questionIn(section)!.querySelector('button') as HTMLElement);
		await userEvent.click(
			page.getByRole('option', { name: /Mois puis jour/ }).element() as HTMLElement
		);

		const both = [...container.querySelectorAll('input[name="dateOrder"]')].map(
			(input) => (input as HTMLInputElement).value
		);
		expect(both).toEqual(['month-first', 'month-first']);
	});

	it('stops describing a file the user has since replaced', async () => {
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);
		expect(questionIn(section)).not.toBeNull();

		const input = section.querySelector('input[type=file]') as HTMLInputElement;
		await userEvent.upload(input, file('releve.csv'));

		expect(questionIn(section)).toBeNull();
	});

	it('forgets the answer when the file it was given for is replaced', async () => {
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);
		await userEvent.click(questionIn(section)!.querySelector('button') as HTMLElement);
		await userEvent.click(
			page.getByRole('option', { name: /Mois puis jour/ }).element() as HTMLElement
		);
		expect(postedOrder(section)).toBe('month-first');

		// A DIFFERENT file, by identity: same name on purpose, matching the account question's own
		// hazard (a bank exporting `releve.csv` every month is the ordinary case).
		const input = section.querySelector('input[type=file]') as HTMLInputElement;
		await userEvent.upload(input, file('releve.csv'));
		await chooseAndSubmit(section, 'releve.csv');

		expect(postedOrder(section)).toBe('day-first');
	});
});
