import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import { EMPTY_ASSIGNMENT, type RoleAssignment } from '$lib/domain/columnDesignation';
import * as m from '$lib/paraglide/messages';

/**
 * #1278 on the screen: a row filled by detection or memory carries no line about where its value
 * came from, because the column name and its sample are what the member checks. The one line left
 * is « Your choice » on a remembered column the member picked themselves, and it leaves the row
 * the moment the member picks another column.
 */
const HEADERS = ['Date operation', 'Date valeur', 'Libelle', 'Montant', 'Categorie'];
const DETECTED: RoleAssignment = { ...EMPTY_ASSIGNMENT, date: 0, amount: 3 };
const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: [
		['24/06/2026', '03/06/2026', '05/06/2026'],
		['24/06/2026', '03/06/2026', '05/06/2026'],
		['CB A', 'CB B', 'CB C'],
		['-14,17', '-3,20', '-9,99'],
		['', '', '']
	],
	rowCount: 12,
	detectedHeaderRow: true,
	dateStates: ['proven-day', 'proven-day', 'no-dates', 'no-dates', 'empty'],
	proposals: {
		designated: DETECTED,
		candidates: { date: [0, 1], label: [], amount: [3], category: [], currency: [] }
	}
};

async function mount(props: Record<string, unknown> = {}) {
	return render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: DETECTED,
		accounts: [
			{ id: 'account-1', name: 'Compte courant', discriminant: '4417', transactionCount: 3 }
		],
		initialAccountId: 'account-1',
		announceDelayMs: 0,
		...props
	});
}

beforeEach(async () => {
	await page.viewport(390, 844);
});

describe('what a prefilled row says about its origin (#1278)', () => {
	// Separates « the header match is stated » (#1277) from « the column name is the evidence ».
	it('says nothing under a column detection matched by its header, nor under a proven date', async () => {
		const { container } = await mount();
		await expect
			.element(page.getByRole('button', { name: /^Montant,/ }))
			.toHaveAccessibleDescription('');
		await expect
			.element(page.getByRole('button', { name: /^Date,/ }))
			.toHaveAccessibleDescription('');
		// The two rows above are found, so this zero is about rendered rows, not an empty screen.
		expect(container.querySelectorAll('[data-provenance]').length).toBe(0);
	});

	const REMEMBERED: RoleAssignment = {
		date: 0,
		label: 2,
		amount: 3,
		category: null,
		currency: null
	};
	const mountRemembered = () =>
		mount({
			file: { ...FILE, proposals: { ...FILE.proposals, designated: EMPTY_ASSIGNMENT } },
			initialAssignment: REMEMBERED,
			remembered: {
				assignment: REMEMBERED,
				layers: { date: 'rule', label: 'member', amount: null, category: null }
			}
		});

	// Separates the member's own remembered column from one kept from the file or of unknown origin.
	it('marks only the remembered column the member chose themselves', async () => {
		const { container } = await mountRemembered();
		await expect
			.element(page.getByRole('button', { name: /^Libellé,/ }))
			.toHaveAccessibleDescription(m.import_columns_member_choice());
		await expect
			.element(page.getByRole('button', { name: /^Montant,/ }))
			.toHaveAccessibleDescription('');
		await expect
			.element(page.getByRole('button', { name: /^Date,/ }))
			.toHaveAccessibleDescription('');
		const lines = [...container.querySelectorAll('[data-provenance]')].map((n) => n.textContent);
		expect(lines).toEqual([m.import_columns_member_choice()]);
	});

	// Separates « still the member's earlier choice » from « replaced by a new one just now ».
	it('drops the mark once the member picks another column', async () => {
		await mountRemembered();
		await page.getByRole('button', { name: /^Libellé,/ }).click();
		await page.getByRole('option', { name: /^Categorie\./ }).click();
		await expect
			.element(page.getByRole('button', { name: /^Libellé,/ }))
			.toHaveAccessibleDescription('');
	});
});
