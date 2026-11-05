import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import * as m from '$lib/paraglide/messages';
import {
	EMPTY_ASSIGNMENT,
	type DesignationFile,
	type RoleAssignment
} from '$lib/domain/columnDesignation';

/**
 * #1213: THE CURRENCY ROLE ON THE HEADERLESS SCREEN, as the screen hands it to its page.
 *
 * The door's half (ask, refuse, import) is `routes/import/headerlessCurrency.db-smoke.ts`. This is
 * the screen's: the row exists only while line 1 is data, detection's one column of codes is
 * prefilled so the member confirms it in one action, and « Aucune colonne devise » leaves the screen
 * as a decline rather than as « nobody answered », which the door would ask about again.
 */

const ROW = ['2026-06-01', 'CB A', '-10.00', 'USD'];

/** As `/import` sends it: line 1 guessed as headers, the headerless facts as the other answer. */
const FILE: DesignationFile = {
	name: 'releve.csv',
	headers: ROW,
	samples: [['2026-06-02'], ['CB B'], ['-20.00'], ['USD']],
	firstRow: ['2026-06-02', 'CB B', '-20.00', 'USD'],
	// Two data rows under the headers guess: the switch locks a file of one (`lockedReason`).
	rowCount: 2,
	detectedHeaderRow: true,
	otherHeaderRowFacts: {
		samples: [['2026-06-01'], ['CB A'], ['-10.00'], ['USD']],
		firstRow: ROW,
		previewRows: undefined,
		coverage: undefined,
		dateStates: undefined,
		dateReadings: undefined,
		proposals: {
			designated: { ...EMPTY_ASSIGNMENT, currency: 3 },
			candidates: { date: [], label: [], amount: [], category: [], currency: [3] }
		}
	}
};

const ASSIGNMENT: RoleAssignment = { ...EMPTY_ASSIGNMENT, date: 0, label: 1, amount: 2 };

async function open() {
	const submissions: Array<Record<string, unknown>> = [];
	await render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: ASSIGNMENT,
		accounts: [{ id: 'account-1', name: 'Compte courant', discriminant: '', transactionCount: 0 }],
		initialAccountId: 'account-1',
		onSubmit: (result: Record<string, unknown>) => submissions.push(result)
	} as never);
	return submissions;
}

const currencyRow = () =>
	page.getByRole('button', { name: new RegExp(`^${m.import_columns_role_currency()},`) });

async function toggleHeaderRow() {
	await page
		.getByRole('button', { name: /^Date,/ })
		.first()
		.click();
	await page.getByRole('switch').first().click();
	await page.getByRole('button', { name: m.import_columns_picker_close() }).first().click();
}

async function submit() {
	await page
		.getByRole('button', { name: m.import_columns_submit_many({ count: 3 }) })
		.first()
		.click();
}

describe('#1213: the Currency role', () => {
	/** Separates « offered only while line 1 is data » from « always offered ». */
	it('is not offered while line 1 is read as headers', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);
		await open();
		// Presence of a sibling row first, so the absence below is not a screen that drew nothing.
		await expect.element(page.getByRole('button', { name: /^Date,/ }).first()).toBeVisible();
		expect(currencyRow().elements()).toHaveLength(0);
	});

	/**
	 * Separates « detection's column is prefilled and leaves as the designation » from « the row is
	 * drawn empty », which would make every press ask at the door.
	 */
	it('prefills the detected column once line 1 is data, and submits it', async () => {
		expect.assertions(2);
		await page.viewport(1280, 900);
		const submissions = await open();
		await toggleHeaderRow();
		await submit();
		expect(submissions).toHaveLength(1);
		expect(submissions[0]).toMatchObject({
			hasHeaderRow: false,
			assignment: { currency: 3 },
			currencyDeclined: false
		});
	});

	/** Separates « declined » from « nobody answered »: the door asks about the second. */
	it('« Aucune colonne devise » submits a decline', async () => {
		expect.assertions(1);
		await page.viewport(1280, 900);
		const submissions = await open();
		await toggleHeaderRow();
		await currencyRow().first().click();
		await page.getByRole('button', { name: m.import_columns_picker_no_currency() }).click();
		await submit();
		expect(submissions[0]).toMatchObject({
			assignment: { currency: null },
			currencyDeclined: true
		});
	});
});
