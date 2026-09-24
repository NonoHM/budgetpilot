import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../layout.css';
import * as m from '$lib/paraglide/messages';
import { setPendingDesignation } from '$lib/import/pendingDesignation.svelte';
import { clearPendingCollision } from '$lib/import/pendingCollision.svelte';
import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

const navigation = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));

/**
 * `applyAction` and `deserialize` are replaced because both need SvelteKit's started client, which
 * a component test does not have: the real `deserialize` reads the client's decoders and throws
 * without them, which would send every answer below into the route's `catch`. The replacement
 * parses the JSON the server sends with its `data` left plain, so the route still branches on the
 * `type` and the payload exactly as it does on a real answer.
 */
const forms = vi.hoisted(() => ({ applyAction: vi.fn(async () => {}) }));
vi.mock('$app/forms', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/forms')>()),
	applyAction: forms.applyAction,
	deserialize: (text: string) => JSON.parse(text)
}));

import Page from './+page.svelte';

/**
 * #395, half 2, the route's share: HOW LONG the designation screen stays occupied.
 *
 * The screen goes inert while `submitting` is true (its own battery is
 * `ColumnDesignationScreen.sending.svelte.spec.ts`). What only this route decides is when that
 * ends. It ended at the TOP of the response handler, before the body was read and before `goto`, so
 * between the answer and the navigation the screen was live again: the primary said « Importer 1
 * ligne » and a press posted the statement a second time. The plate's own wording is « résultat,
 * ou retour à 2 »: the occupancy ends by leaving on a result, or by coming back to state 2 on a
 * failure, never in between.
 *
 * `goto` is held open by the test, so « between the answer and the navigation » is a state the test
 * holds rather than a race it hopes to win.
 *
 * BREAK MATRIX, 2026-09-24, one clause at a time. Putting the reset back at the top of the handler
 * reddens the two « between » tests (the second measured 2 requests). Removing the reset from the
 * refusal branch, the unreadable-answer branch, and the `catch` each reddens that branch's test and
 * nothing else.
 */
const VIEW: DesignationFile = {
	name: 'releve.csv',
	headers: ['Jour', 'Intitule', 'Somme'],
	samples: [['24/06/2026'], ['MERCERIE'], ['-24,90']],
	previewRows: [['24/06/2026', 'MERCERIE', '-24,90']],
	coverage: [1, 1, 1],
	firstRow: ['24/06/2026', 'MERCERIE', '-24,90'],
	rowCount: 1,
	detectedHeaderRow: true
} as DesignationFile;

const COMPLETE = { date: 0, label: 1, amount: 2, category: null } as unknown as RoleAssignment;

/** The `ActionResult`s the action answers with, `data` left plain (see the mock above). */
const SUCCESS = () =>
	new Response(
		JSON.stringify({
			type: 'success',
			status: 200,
			data: { importResult: { invalidRows: 0, totalRows: 1, importedRows: 1 }, capReached: false }
		}),
		{ status: 200 }
	);
const REFUSAL = () =>
	new Response(JSON.stringify({ type: 'failure', status: 400, data: { error: 'Refusé' } }), {
		status: 400
	});

let requests = 0;
let answer: () => Promise<Response>;

beforeEach(async () => {
	requests = 0;
	clearPendingCollision();
	vi.clearAllMocks();
	// Held open: a navigation that has started and not finished.
	navigation.goto.mockImplementation(() => new Promise(() => {}));
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			requests += 1;
			return answer();
		})
	);
	await page.viewport(390, 844);
	setPendingDesignation({
		file: new File(['Jour;Intitule;Somme\n'], 'releve.csv'),
		view: VIEW,
		initialAssignment: COMPLETE,
		candidates: {},
		dateOrder: null,
		account: {
			options: [
				{
					id: 'account-1',
					name: 'BP · Compte courant',
					discriminant: '4417',
					transactionCount: 128
				}
			],
			resolution: { rank: 1 as const, accountId: 'account-1', fragment: '4417' },
			memory: null,
			prefillName: '',
			chosenId: null
		},
		correction: null
	});
});

const primary = () => document.querySelector('[data-testid="designation-primary"]') as HTMLElement;
const cancel = () =>
	[...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === m.import_columns_cancel()
	) as HTMLElement;

/** The press the journey makes, then waits for the request to have gone out. */
async function pressImport() {
	await render(Page, { form: null as never });
	// Clicked directly: once the import is out the primary is `aria-disabled`, and a locator click
	// would wait for ever on the state under test.
	primary().click();
	await expect.poll(() => requests).toBe(1);
}

describe('how long the designation screen stays occupied', () => {
	// SEPARATES: « occupied until the screen leaves » FROM « live again between the answer and the
	// navigation ». Read once `goto` has been called, which is the moment after the answer.
	it('stays occupied between a successful answer and the navigation', async () => {
		answer = async () => SUCCESS();
		await pressImport();
		await expect.poll(() => navigation.goto.mock.calls.length).toBe(1);

		expect(primary().getAttribute('aria-busy')).toBe('true');
		expect(cancel().getAttribute('aria-disabled')).toBe('true');
	});

	// THE CONSEQUENCE, counted: the window was a second import. SEPARATES: « a press after the answer
	// and before the navigation posts nothing » FROM « it posts the statement again ».
	it('sends no second import between a successful answer and the navigation', async () => {
		answer = async () => SUCCESS();
		await pressImport();
		await expect.poll(() => navigation.goto.mock.calls.length).toBe(1);

		primary().click();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(requests).toBe(1);
	});

	// « retour à 2 », after a request that got no answer. SEPARATES: « the screen comes back live
	// with the reason » FROM « it stays inert for ever », which moving the reset would ship if the
	// catch branch lost its line.
	it('comes back live after a request that failed', async () => {
		answer = async () => {
			throw new TypeError('network');
		};
		await pressImport();

		await expect.element(page.getByText(m.import_columns_error_unexpected())).toBeVisible();
		expect(primary().hasAttribute('aria-busy')).toBe(false);
		expect(cancel().hasAttribute('aria-disabled')).toBe(false);
	});

	// « retour à 2 », after a refusal the server expressed. SEPARATES: « an applied refusal leaves
	// the screen live » FROM « it stays inert under the banner ».
	it('comes back live after a refusal', async () => {
		answer = async () => REFUSAL();
		await pressImport();

		await expect.poll(() => forms.applyAction.mock.calls.length).toBe(1);
		await expect.poll(() => primary().hasAttribute('aria-busy')).toBe(false);
		expect(cancel().hasAttribute('aria-disabled')).toBe(false);
	});

	// THE THIRD BRANCH THAT STAYS: a success whose payload carries no summary. SEPARATES: « the
	// screen comes back live with the sentence » FROM « it shows the sentence over a screen still
	// inert », which is what moving the reset out of the top of the handler would ship if this branch
	// were forgotten.
	it('comes back live after an answer it cannot read', async () => {
		answer = async () =>
			new Response(JSON.stringify({ type: 'success', status: 200, data: {} }), { status: 200 });
		await pressImport();

		await expect.element(page.getByText(m.import_columns_error_unexpected())).toBeVisible();
		expect(primary().hasAttribute('aria-busy')).toBe(false);
		expect(cancel().hasAttribute('aria-disabled')).toBe(false);
	});
});
