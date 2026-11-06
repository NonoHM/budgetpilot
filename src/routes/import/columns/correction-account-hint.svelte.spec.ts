import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../layout.css';
import {
	clearPendingDesignation,
	setPendingDesignation
} from '$lib/import/pendingDesignation.svelte';
import type { DesignationFile, RoleAssignment } from '$lib/domain/columnDesignation';

vi.mock('$app/navigation', async (importOriginal) => ({
	...(await importOriginal<typeof import('$app/navigation')>()),
	goto: vi.fn(async () => {})
}));

import Page from './+page.svelte';

/**
 * #1305, found on the walk: a correction reopens a REMEMBERED correspondance, so its format is not new,
 * and the account row said « Premier relevé de ce format. » under an account the file did not name.
 * Literal French on purpose (the cookie is pinned to `fr`): the catalogue is not asserted against itself.
 */
const FIRST = 'Premier relevé de ce format.';

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

const ASSIGNMENT = { date: 0, label: 1, amount: 2, category: null } as unknown as RoleAssignment;

function seed(remembered: boolean) {
	setPendingDesignation({
		file: new File(['Jour;Intitule;Somme\n'], 'releve.csv', { type: 'text/csv' }),
		view: VIEW,
		initialAssignment: ASSIGNMENT,
		remembered: remembered
			? { mappingId: 'mapping-1', assignment: ASSIGNMENT, layers: {}, amountSign: null }
			: null,
		dateOrder: null,
		currencyDeclined: false,
		openOn: null,
		account: {
			options: [
				{ id: 'account-1', name: 'BP · Compte courant', discriminant: null, transactionCount: 3 },
				{ id: 'account-2', name: 'BP · Livret', discriminant: null, transactionCount: 1 }
			],
			resolution: { rank: 3 as const, kind: 'unknown' as const },
			memory: null,
			prefillName: '',
			chosenId: null
		},
		correction: null
	});
}

/** Rendered copies a member can see: the screen draws the chrome of one width. */
const shown = (text: string) =>
	page
		.getByText(text, { exact: true })
		.elements()
		.filter((element) => element.checkVisibility()).length;

beforeEach(async () => {
	clearPendingDesignation();
	await page.viewport(390, 844);
});

describe('the account row on a correction', () => {
	/**
	 * Separates « a remembered format says nothing about being first » from « it says it is the first
	 * statement of this format », false on the correction route that reopens it.
	 */
	it('does not call a remembered format the first statement of its kind', async () => {
		seed(true);
		await render(Page, { form: null } as never);
		// The row is drawn and asking: the absence below is about its sentence, not a missing row.
		await expect.poll(() => shown('Choisir le compte')).toBe(1);
		expect(shown(FIRST)).toBe(0);
	});

	/** The control: a format never seen still says so. */
	it('still says it for a format never seen', async () => {
		seed(false);
		await render(Page, { form: null } as never);
		await expect.poll(() => shown(FIRST)).toBe(1);
	});
});
