import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../layout.css';
import * as m from '$lib/paraglide/messages';
import {
	setPendingDesignation,
	takePendingDesignation
} from '$lib/import/pendingDesignation.svelte';
import { clearPendingCollision } from '$lib/import/pendingCollision.svelte';
import { EMPTY_ASSIGNMENT, type DesignationFile } from '$lib/domain/columnDesignation';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: navigation.goto
}));
vi.mock('$app/forms', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/forms')>()),
	applyAction: vi.fn(async () => {}),
	deserialize: (text: string) => JSON.parse(text)
}));

import Page from './+page.svelte';

/**
 * THE ROWS-FAILED REVISIT KEEPS THE ANSWER ABOUT LINE 1 (found by #1213's code pass A, predates it).
 *
 * A run whose rows partly failed stores the screen's answers so « Revoir les colonnes » reopens it
 * « désignations intactes ». It stored the assignment, the reading and now the currency decline, but
 * reused the view detection built, read as headers: the member's « line 1 is data » came back as
 * « headers », and the next import read line 1 as a header and lost that transaction. The duplicate
 * dialog's leg already moves the view with the answer (`buildCollisionRepost`, `declareHeaderRow`).
 */
const VIEW: DesignationFile = {
	name: 'releve.csv',
	headers: ['2026-06-01', 'CB A', '-10.00'],
	samples: [['2026-06-02'], ['CB B'], ['-20.00']],
	firstRow: ['2026-06-02', 'CB B', '-20.00'],
	// Two data rows under the headers guess: the switch locks a file of one.
	rowCount: 2,
	detectedHeaderRow: true
};

async function sayLineOneIsData() {
	await page
		.getByRole('button', { name: /^Date,/ })
		.first()
		.click();
	await page.getByRole('switch').first().click();
	await page.getByRole('button', { name: m.import_columns_picker_close() }).first().click();
}

/** Already read as headerless, with column 4 a column of codes the screen would prefill. */
const HEADERLESS_WITH_CODES: DesignationFile = {
	name: 'releve.csv',
	headers: ['2026-06-01', 'CB A', '-10.00', 'USD'],
	samples: [['2026-06-01'], ['CB A'], ['-10.00'], ['USD']],
	firstRow: ['2026-06-01', 'CB A', '-10.00', 'USD'],
	rowCount: 3,
	detectedHeaderRow: false,
	proposals: {
		designated: { ...EMPTY_ASSIGNMENT, currency: 3 },
		candidates: { date: [], label: [], amount: [], category: [], currency: [3] }
	}
};

const ROWS_FAILED = () =>
	new Response(
		JSON.stringify({
			type: 'success',
			status: 200,
			data: { importResult: { invalidRows: 1, totalRows: 3, importedRows: 2 }, capReached: false }
		}),
		{ status: 200 }
	);

/** A duplicate statement: the action answers the collision question rather than importing. */
const COLLISION = () =>
	new Response(
		JSON.stringify({
			type: 'failure',
			status: 400,
			data: { collision: { batchId: 'b1' }, incoming: { rows: 3 } }
		}),
		{ status: 400 }
	);

let answer: () => Response = ROWS_FAILED;
let posted: FormData[] = [];

beforeEach(async () => {
	clearPendingCollision();
	vi.clearAllMocks();
	answer = ROWS_FAILED;
	posted = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: FormData }) => {
			posted.push(init.body);
			return answer();
		})
	);
	await page.viewport(1280, 900);
	setPendingDesignation({
		file: new File(['2026-06-01;CB A;-10.00\n'], 'releve.csv'),
		view: VIEW,
		initialAssignment: { ...EMPTY_ASSIGNMENT, date: 0, label: 1, amount: 2 },
		dateOrder: null,
		currencyDeclined: false,
		account: {
			options: [{ id: 'account-1', name: 'Compte courant', discriminant: '', transactionCount: 0 }],
			resolution: { rank: 1 as const, accountId: 'account-1', fragment: '' },
			memory: null,
			prefillName: '',
			chosenId: null
		},
		correction: null
	} as never);
});

describe('the rows-failed revisit', () => {
	/** Separates « the revisit reopens line 1 as data » from « as headers », which ate line 1. */
	it('reopens with line 1 as data when the member said so', async () => {
		expect.assertions(2);
		await render(Page, { props: { data: {} } } as never);
		await sayLineOneIsData();
		await page
			.getByRole('button', { name: m.import_columns_submit_many({ count: 3 }) })
			.first()
			.click();
		await vi.waitFor(() => expect(navigation.goto).toHaveBeenCalled());
		expect(takePendingDesignation()?.view.detectedHeaderRow).toBe(false);
	});

	/**
	 * #1213 narrow pass, finding 1: the duplicate dialog's interim write kept detection's view, so
	 * browser Back from the dialog reopened « line 1 is data » as headers.
	 */
	it('the collision leg stores line 1 as data too', async () => {
		expect.assertions(2);
		answer = COLLISION;
		await render(Page, { props: { data: {} } } as never);
		await sayLineOneIsData();
		await page
			.getByRole('button', { name: m.import_columns_submit_many({ count: 3 }) })
			.first()
			.click();
		await vi.waitFor(() => expect(navigation.goto).toHaveBeenCalled());
		expect(takePendingDesignation()?.view.detectedHeaderRow).toBe(false);
	});

	/**
	 * #1213 narrow pass, finding 2: the route seeds the screen with a stored decline, and posts it.
	 * Separates « the page hands `currencyDeclined` to the screen » from « it drops it », which the
	 * screen's own spec cannot see.
	 */
	it('posts a stored currency decline as none', async () => {
		expect.assertions(1);
		setPendingDesignation({
			...takePendingDesignation()!,
			view: HEADERLESS_WITH_CODES,
			currencyDeclined: true
		});
		await render(Page, { props: { data: {} } } as never);
		await page
			.getByRole('button', { name: m.import_columns_submit_many({ count: 3 }) })
			.first()
			.click();
		await vi.waitFor(() => expect(posted[0]?.get('currencyIndex')).toBe('none'));
	});
});
