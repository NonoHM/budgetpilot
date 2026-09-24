import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import '../layout.css';
import * as m from '$lib/paraglide/messages';
import { clearPendingDesignation } from '$lib/import/pendingDesignation.svelte';
import { takePendingCollision } from '$lib/import/pendingCollision.svelte';
import type { CollidingBatchView } from '$lib/domain/importCollision';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

import Page from './+page.svelte';
import type { PageData } from './$types';

/**
 * THE PAGE KEEPS EVERY ANSWER THE SERVER ACCEPTED, WHILE THE SAME FILE IS IN HAND.
 *
 * The loop measured on 1.1.1: a file whose dates read both ways, from a user with two accounts of
 * its bank, alternated forever between the two questions, because each hidden answer existed only
 * while its own question was on screen. The server now echoes the answers it accepted for the file
 * (`answers`, keyed by the file's digest) and the page posts them back beside the answer to the
 * question on screen. What is measured here is the page's half: that the echo is posted, posted
 * ONCE, posted together with the new answer, and never posted with a different file.
 */

const KEY = 'a'.repeat(64);
const DATA: PageData = { user: null, correction: null } as unknown as PageData;

const ACCOUNT_OFFER = {
	options: [
		{ id: 'acc-courant', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 },
		{ id: 'acc-livret', name: 'BP · Livret A', discriminant: '9032', transactionCount: 12 }
	],
	resolution: { rank: 3, candidates: [] },
	prefillName: 'Banque Populaire',
	memory: null,
	chosenId: null
};

const READING_OFFER = {
	name: 'releve.csv',
	headers: ['Date', 'Libelle', 'Montant'],
	samples: [['07/02/2026'], ['SNCF'], ['-45,00']],
	firstRow: ['06/01/2026', 'CARREFOUR', '-12,90'],
	detectedHeaderRow: true,
	rowCount: 2,
	dateColumn: 0,
	dateReadings: [
		{ dayFirst: ['2026-01-06', '2026-02-07'], monthFirst: ['2026-06-01', '2026-07-02'] },
		{ dayFirst: [null, null], monthFirst: [null, null] },
		{ dayFirst: [null, null], monthFirst: [null, null] }
	]
};

const answers = (
	fields: Partial<Record<'accountId' | 'dateOrder' | 'accountColumnAnswer', string>>
) => ({
	key: KEY,
	accountId: null,
	dateOrder: null,
	accountColumnAnswer: null,
	...fields
});

/** The date question on screen, the account already answered for this file. */
const DATE_ASKED = {
	error: m.import_error_ambiguous_date_order(),
	reading: READING_OFFER,
	answers: answers({ accountId: 'acc-livret' })
};

/** The account question on screen, the date and the account column already answered. */
const ACCOUNT_ASKED = {
	error: m.import_account_error_ambiguous_auto(),
	account: ACCOUNT_OFFER,
	answers: answers({ dateOrder: 'month-first', accountColumnAnswer: 'not-account' })
};

async function mount(form: Record<string, unknown>) {
	await page.viewport(1280, 800);
	const rendered = await render(Page, { data: DATA, form: form as never });
	return rendered.container.querySelectorAll('main > section')[0] as HTMLElement;
}

const file = (name = 'releve.csv') => new File([`a,b,c\n1,2,3\n`], name, { type: 'text/csv' });

async function chooseAndSubmit(section: HTMLElement) {
	await userEvent.upload(section.querySelector('input[type=file]') as HTMLInputElement, file());
	await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);
}

/** Every value the section's form would post under `name`, in document order. */
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

describe('the answers kept for the file in hand', () => {
	it('posts the account already accepted beside the date answer, once each', async () => {
		// SEPARATES: « the accepted account rides the request that answers the date » FROM « only
		// the question on screen has an input », which is the half of the loop that re-asks the
		// account. `toEqual` on the whole list, so a second copy of either input fails too.
		const section = await mount(DATE_ASKED);
		await chooseAndSubmit(section);

		expect(posted(section, 'answersFor')).toEqual([KEY]);
		expect(posted(section, 'accountId')).toEqual(['acc-livret']);
		expect(posted(section, 'dateOrder')).toEqual(['day-first']);
	});

	it('posts the date already accepted beside the account answer, once each', async () => {
		// The other half of the alternation: the date answered, the account on screen.
		const section = await mount(ACCOUNT_ASKED);
		await chooseAndSubmit(section);
		await userEvent.click(
			section.querySelector('[data-testid="import-account-question"] button') as HTMLElement
		);
		await userEvent.click(page.getByRole('option').nth(1).element() as HTMLElement);

		expect(posted(section, 'answersFor')).toEqual([KEY]);
		expect(posted(section, 'dateOrder')).toEqual(['month-first']);
		expect(posted(section, 'accountColumnAnswer')).toEqual(['not-account']);
		expect(posted(section, 'accountId')).toEqual(['acc-livret']);
	});

	it.each([
		[1280, 0],
		[390, 1]
	] as const)(
		'posts an answer given on this page once, when the next reply echoes it (%i)',
		async (width, mount) => {
			// SEPARATES: « an accepted answer reaches the form from the echo ALONE » FROM « its control
			// keeps posting it too », which puts two copies of one field in the request and leaves
			// `FormData.get` to pick one: two sources for one answer is how they come to disagree.
			// Walked across two replies, because only then does the page hold both the control's state
			// and the server's echo of it.
			await page.viewport(width, width === 390 ? 844 : 800);
			const { container, rerender } = await render(Page, {
				data: DATA,
				form: {
					error: m.import_error_ambiguous_account_column(),
					accountColumn: { column: 3, header: 'compte', samples: ['10000001', '10000002'] },
					answers: answers({})
				} as never
			});
			const section = container.querySelectorAll('main > section')[mount] as HTMLElement;
			await chooseAndSubmit(section);
			await userEvent.click(
				page.getByRole('button', { name: m.import_account_column_deny() }).element() as HTMLElement
			);
			expect(posted(section, 'accountColumnAnswer')).toEqual(['not-account']);

			// The server accepted it and moved on to the account question.
			await rerender({ data: DATA, form: ACCOUNT_ASKED as never });

			expect(posted(section, 'accountColumnAnswer')).toEqual(['not-account']);
		}
	);

	it('posts nothing kept once a different file is picked, even under the same name', async () => {
		// SEPARATES: « the kept answers die with the file they were given for » FROM « they ride
		// whatever the picker holds ». By identity, never by name: a bank exporting `releve.csv`
		// every month is the ordinary case, and is when carrying an answer hurts most.
		const section = await mount(DATE_ASKED);
		await chooseAndSubmit(section);
		expect(posted(section, 'accountId')).toEqual(['acc-livret']);

		await userEvent.upload(section.querySelector('input[type=file]') as HTMLInputElement, file());

		expect(posted(section, 'answersFor')).toEqual([]);
		expect(posted(section, 'accountId')).toEqual([]);
		expect(posted(section, 'dateOrder')).toEqual([]);
	});

	it('confirms a duplicate statement with every answer the run was accepted with', async () => {
		// SEPARATES: « Importer quand même re-posts the answers the server accepted » FROM « it
		// re-posts whatever the page state holds », which after this change is nothing for a
		// question answered two requests earlier, and the confirmation would loop back to it.
		const existing: CollidingBatchView = {
			batchId: 'batch-1',
			fileName: 'releve.csv',
			periodStart: '2026-01-06',
			periodEnd: '2026-02-07',
			transactionCount: 2,
			debitCents: 5790,
			creditCents: 0,
			createdAt: '2026-08-15T21:50:00.000Z'
		};
		const fetchSpy = vi.fn(
			async () => new Response(JSON.stringify({ type: 'failure', status: 400, data: '[{}]' }))
		);
		vi.stubGlobal('fetch', fetchSpy);
		const section = await mount({
			collision: existing,
			incoming: { ...existing },
			answers: answers({ accountId: 'acc-livret', dateOrder: 'month-first' })
		});
		// The run that raised the collision was submitted with this file: that is what makes the
		// echo describe the file in hand. `requestSubmit` because the dialog is modal over the form.
		await userEvent.upload(section.querySelector('input[type=file]') as HTMLInputElement, file());
		(section.querySelector('form[method="POST"]') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

		await userEvent.click(
			page
				.getByRole('button', { name: m.import_collision_confirm() })
				.last()
				.element() as HTMLElement
		);

		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
		const body = (fetchSpy.mock.calls[1] as unknown as [string, { body: FormData }])[1].body;
		expect({
			answersFor: body.get('answersFor'),
			accountId: body.get('accountId'),
			dateOrder: body.get('dateOrder'),
			confirmCollision: body.get('confirmCollision')
		}).toStrictEqual({
			answersFor: KEY,
			accountId: 'acc-livret',
			dateOrder: 'month-first',
			confirmCollision: '1'
		});
	});

	it('declining a duplicate statement withdraws the account and keeps the reading', async () => {
		// SEPARATES: « « Ne pas importer » gives the destination back to the user » FROM « the echo
		// re-posts the account they just declined », under which the next press raises the SAME
		// collision and the account question never comes back: found by the contradiction pass on
		// this branch, a regression against main, where that press asked the account again.
		//
		// The reading is KEPT, and asserted as kept: it is a fact about the file, and the collision
		// is about where the file goes. Dropping it would re-ask a question nothing has put in doubt.
		const existing: CollidingBatchView = {
			batchId: 'batch-1',
			fileName: 'releve.csv',
			periodStart: '2026-01-06',
			periodEnd: '2026-02-07',
			transactionCount: 2,
			debitCents: 5790,
			creditCents: 0,
			createdAt: '2026-08-15T21:50:00.000Z'
		};
		const fetchSpy = vi.fn(
			async () => new Response(JSON.stringify({ type: 'failure', status: 400, data: '[{}]' }))
		);
		vi.stubGlobal('fetch', fetchSpy);
		const section = await mount({
			collision: existing,
			incoming: { ...existing },
			answers: answers({ accountId: 'acc-deux', dateOrder: 'month-first' })
		});
		await userEvent.upload(section.querySelector('input[type=file]') as HTMLInputElement, file());
		(section.querySelector('form[method="POST"]') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
		expect(posted(section, 'accountId')).toEqual(['acc-deux']);

		await userEvent.click(
			page
				.getByRole('button', { name: m.import_collision_cancel() })
				.last()
				.element() as HTMLElement
		);

		expect({
			answersFor: posted(section, 'answersFor'),
			accountId: posted(section, 'accountId'),
			dateOrder: posted(section, 'dateOrder')
		}).toStrictEqual({ answersFor: [KEY], accountId: [], dateOrder: ['month-first'] });
	});
});
