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
 * #476: the account question, on the host it had never appeared on.
 *
 * A recognised file whose bank the user holds two accounts for was refused with a sentence naming
 * the designation screen. That screen does not open for a recognised file and `/import/columns`
 * bounces a direct visit, so the import could not be completed at all. The refusal now carries the
 * control that answers it.
 *
 * `AccountRow` and `AccountPicker` are registered briques with their own batteries, so what is
 * measured here is the HOST: whether the question renders beside the refusal, whether the answer
 * reaches the request, whether it survives the mount this page renders twice, and whether it stops
 * describing a file the user has since replaced. The last two times a component landed on a new host
 * in this repository the defect was in the host rather than in the component.
 */

const OFFER = {
	options: [
		{ id: 'acc-courant', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 },
		{ id: 'acc-livret', name: 'BP · Livret A', discriminant: '9032', transactionCount: 12 }
	],
	resolution: { rank: 3, candidates: [] },
	prefillName: 'Banque Populaire',
	memory: null,
	chosenId: null
};

const DATA: PageData = { user: null, correction: null } as unknown as PageData;

const FORM = {
	error: m.import_account_error_ambiguous_auto(),
	account: OFFER
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
	section.querySelector('[data-testid="import-account-question"]') as HTMLElement | null;

const postedAccount = (section: HTMLElement) =>
	(section.querySelector('input[name="accountId"]') as HTMLInputElement | null)?.value ?? null;

beforeEach(() => {
	clearPendingDesignation();
	vi.clearAllMocks();
});

describe('the account question beside an import refusal', () => {
	it('draws the control that answers the refusal, at 1280', async () => {
		// SEPARATES: « the refusal carries a control » FROM « it carries a sentence and nothing
		// else », which is the dead end: the message named a screen this path never opens.
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);

		expect(questionIn(section)).not.toBeNull();
		// `.first()` because this page renders its whole content twice and both copies carry the
		// banner; the desktop one is the visible mount at this width.
		await expect
			.element(page.getByText(m.import_account_error_ambiguous_auto()).first())
			.toBeVisible();
	});

	it('draws it at 390 too', async () => {
		// SEPARATES: « both mounts carry the question » FROM « one of them does ». A fix applied to
		// one mount and not the other is invisible to any test that does not choose a width, and this
		// page has shipped exactly that defect before.
		await page.viewport(390, 844);
		const { section } = mount(390);
		await chooseAndSubmit(section);

		expect(questionIn(section)).not.toBeNull();
	});

	it('gives each mount its own panel id, so the document holds no duplicate', async () => {
		// SEPARATES: « the two mounts are two controls in the DOM » FROM « they are one id written
		// twice ». A duplicate id makes `aria-controls` ambiguous and is this HOST's hazard rather
		// than the component's: the component is correct and is mounted twice by a responsive layout
		// that renders its whole form at both widths.
		await page.viewport(1280, 800);
		const { container, section } = mount(1280);
		await chooseAndSubmit(section);

		const ids = [...container.querySelectorAll('[aria-controls]')].map((element) =>
			element.getAttribute('aria-controls')
		);
		const accountIds = ids.filter((id) => id?.startsWith('import-account-panel'));
		expect(accountIds).toHaveLength(2);
		expect(new Set(accountIds).size).toBe(2);
	});

	it('puts the chosen account into the request', async () => {
		// SEPARATES: « the answer rides the ordinary submit » FROM « the user chooses and the form
		// posts the same thing it posted before », which is a dead end with a button on it. Asserted
		// on the field the browser will send, not on the row's rendering.
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);

		expect(postedAccount(section)).toBe('');
		await userEvent.click(questionIn(section)!.querySelector('button') as HTMLElement);
		await userEvent.click(page.getByRole('option').nth(1).element() as HTMLElement);

		expect(postedAccount(section)).toBe('acc-livret');
	});

	it('carries one answer across both mounts', async () => {
		// SEPARATES: « the choice lives once on the page » FROM « each mount owns its own », which
		// would leave a user who answered at 390 and rotated to 1280 looking at an unanswered
		// question. Two mounts of a stateful control is not a responsive layout, it is two controls
		// that happen to look alike.
		await page.viewport(1280, 800);
		const { container, section } = mount(1280);
		await chooseAndSubmit(section);
		await userEvent.click(questionIn(section)!.querySelector('button') as HTMLElement);
		await userEvent.click(page.getByRole('option').nth(1).element() as HTMLElement);

		const both = [...container.querySelectorAll('input[name="accountId"]')].map(
			(input) => (input as HTMLInputElement).value
		);
		expect(both).toEqual(['acc-livret', 'acc-livret']);
	});

	it('stops describing a file the user has since replaced', async () => {
		// SEPARATES: « the offer is gated on the file in hand being the one the server described »
		// FROM « the options stay on screen whatever the picker now holds ». The picker stays live
		// under the refusal, so answering with an option computed for the old statement would post an
		// account chosen for a file that is no longer being imported. By IDENTITY, never by name: a
		// bank exporting `releve.csv` every month is the ordinary case.
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);
		expect(questionIn(section)).not.toBeNull();

		const input = section.querySelector('input[type=file]') as HTMLInputElement;
		await userEvent.upload(input, file('releve.csv'));

		expect(questionIn(section)).toBeNull();
	});

	it('reveals the question rather than posting when the primary is pressed unanswered', async () => {
		// SEPARATES: « the press shows the user what is missing » FROM « it spends a round trip to be
		// told again what this page already knows », which comes back with the banner already on
		// screen and reads as nothing happening. The primary stays live rather than being disabled,
		// which is the ruling the designation screen records: a disabled control explains nothing and
		// cannot be asked why.
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);

		// Recorded rather than blocked: `preventDefault` does not stop other listeners on the same
		// element, so a listener asserting it was never called would be asserting about listener
		// order. What decides whether the browser posts is `defaultPrevented`, so that is what is
		// read, and the listener prevents it a second time so a regression cannot navigate the test
		// runner away.
		let prevented: boolean | null = null;
		section.querySelector('form')!.addEventListener('submit', (event) => {
			prevented = event.defaultPrevented;
			event.preventDefault();
		});
		await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);

		expect(prevented).toBe(true);
		// And the user is shown WHERE: the row took the focus rather than the page saying nothing.
		expect(document.activeElement).toBe(questionIn(section)!.querySelector('button'));
	});

	it('says what is missing, in the row, when the primary is pressed unanswered', async () => {
		// SEPARATES: « the press states what is missing » FROM « it moves the focus and nothing
		// else », which is what a mouse user gets: a click produces `:focus` and not
		// `:focus-visible`, so there is no ring, and the row's `error` ground is rose-50 on white.
		// FOUND ON THE FIRST SCREENSHOT and by nothing else: the press was measured as prevented and
		// as moving focus, both green, over a screen where visibly nothing happened.
		//
		// The sentence is the row's HINT, which is also the channel `AccountRow` puts the error into
		// its accessible name through: its name falls back to the bare label when `state === 'error'`
		// arrives without one, so a row with no hint loses the error in BOTH channels at once.
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);
		await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);

		const row = questionIn(section)!.querySelector('button') as HTMLElement;
		await expect.element(page.getByText(m.import_account_error_required()).first()).toBeVisible();
		expect(row.getAttribute('aria-label')).toContain(m.import_account_error_required());
	});

	it('drops the error the moment it is answered', async () => {
		// SEPARATES: « the sentence goes when the thing it asks for arrives » FROM « it stays beside
		// a row that now names an account », which is a refusal contradicting the value next to it.
		await page.viewport(1280, 800);
		const { section } = mount(1280);
		await chooseAndSubmit(section);
		await userEvent.click(section.querySelector('button[type=submit]') as HTMLElement);
		await expect.element(page.getByText(m.import_account_error_required()).first()).toBeVisible();

		await userEvent.click(questionIn(section)!.querySelector('button') as HTMLElement);
		await userEvent.click(page.getByRole('option').nth(0).element() as HTMLElement);

		await expect
			.element(page.getByText(m.import_account_error_required()).first())
			.not.toBeInTheDocument();
	});
});

/**
 * The notice for a file that carries several accounts.
 *
 * The rows all land in one account, which is the behaviour that must not change: refusing here
 * would stop an import that works today. What changes is that the screen says so.
 */
describe('a file carrying several accounts', () => {
	const SUMMARY = {
		fileName: 'releve.csv',
		profile: 'csv',
		totalRows: 2,
		importedRows: 2,
		invalidRows: 0,
		fileLevelRefusals: 0,
		duplicateRows: 0,
		autoCategorizedRows: 0,
		totalDebitCents: 7210,
		totalCreditCents: 0,
		period: { from: '2026-06-01', to: '2026-06-02' },
		batchId: 'batch-1',
		invalidRowDetails: [],
		hiddenInvalidRowsCount: 0,
		accountName: 'BP · Livret A'
	};

	it('names the account the rows went into, and says the file named several', async () => {
		// SEPARATES: « an account showing money that is not its own says so » FROM « the rows are
		// filed and nothing on screen mentions there was more than one account in the file ». The
		// second is discovered months later as a balance that will not reconcile.
		await page.viewport(1280, 800);
		render(Page, {
			data: DATA,
			form: { importResult: { ...SUMMARY, multiAccountFile: true } } as never
		});

		await expect
			.element(page.getByText(m.import_multi_account_notice({ account: 'BP · Livret A' })).first())
			.toBeVisible();
	});

	it('says nothing for an ordinary single-account file', async () => {
		// SEPARATES: « the notice fires on the evidence the file offers » FROM « it fires on every
		// import ». A notice shown always is one nobody reads by the third month, which is the same
		// defect as the refusal it replaces, one tone quieter.
		await page.viewport(1280, 800);
		render(Page, {
			data: DATA,
			form: { importResult: { ...SUMMARY, multiAccountFile: false } } as never
		});

		await expect
			.element(page.getByText(m.import_multi_account_notice({ account: 'BP · Livret A' })).first())
			.not.toBeInTheDocument();
	});
});
