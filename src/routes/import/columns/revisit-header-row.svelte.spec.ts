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

const ROWS_FAILED = () =>
	new Response(
		JSON.stringify({
			type: 'success',
			status: 200,
			data: { importResult: { invalidRows: 1, totalRows: 3, importedRows: 2 }, capReached: false }
		}),
		{ status: 200 }
	);

beforeEach(async () => {
	clearPendingCollision();
	vi.clearAllMocks();
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ROWS_FAILED())
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
		await page
			.getByRole('button', { name: /^Date,/ })
			.first()
			.click();
		await page.getByRole('switch').first().click();
		await page.getByRole('button', { name: m.import_columns_picker_close() }).first().click();
		await page
			.getByRole('button', { name: m.import_columns_submit_many({ count: 3 }) })
			.first()
			.click();
		await vi.waitFor(() => expect(navigation.goto).toHaveBeenCalled());
		expect(takePendingDesignation()?.view.detectedHeaderRow).toBe(false);
	});
});
