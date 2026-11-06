import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import type { RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * # THE SIGN QUESTION (#1207 C2c-S1, ADR #1206): no amount in the column carries a minus sign, so the
 * member says whether every row is money out or money in. No default: nothing is pre-selected, and
 * `amountSign` leaves the screen only as an answer given about the amount column it was asked about.
 *
 * Strings are literal French on purpose (the cookie is pinned to `fr`): reading them from the catalogue
 * would assert the catalogue against itself.
 */
const HEADERS = ['Date', 'Libelle', 'Montant', 'Debit'];

const PREVIEW = [
	['03/04/2026', 'CARREFOUR', '12,90', '-1,00'],
	['04/04/2026', 'SNCF', '45,00', '-2,00'],
	['05/04/2026', 'EDF', '83,10', '-3,00'],
	['06/04/2026', 'FNAC', '9,99', '-4,00']
];

const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: [
		['03/04/2026', '04/04/2026', '05/04/2026'],
		['CARREFOUR', 'SNCF', 'EDF'],
		['12,90', '45,00', '83,10'],
		['-1,00', '-2,00', '-3,00']
	],
	firstRow: PREVIEW[0],
	previewRows: PREVIEW,
	rowCount: 4,
	detectedHeaderRow: true,
	dateStates: ['proven-day', 'no-dates', 'no-dates', 'no-dates'] as const,
	amountSignStates: ['none', 'none', 'unsigned', 'signed'] as const
};

const DESIGNATED: RoleAssignment = { date: 0, label: 1, amount: 2, category: null, currency: null };

const ACCOUNTS = [
	{ id: 'account-1', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 }
];

async function mount(props: Record<string, unknown> = {}) {
	return await render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: DESIGNATED,
		accounts: ACCOUNTS,
		initialAccountId: 'account-1',
		announceDelayMs: 0,
		...props
	});
}

const HEADING = 'Argent sorti ou entré ?';

function heading() {
	return page.getByRole('heading', { name: HEADING });
}

function amountRow(container: HTMLElement) {
	return [...container.querySelectorAll('[data-testid="designation-card"] button')].find((b) =>
		(b.getAttribute('aria-label') ?? '').startsWith('Montant')
	) as HTMLElement;
}

/** The whole sentence, compared by equality: a substring or a regex over raw markup proves less. */
async function sentenceOf(testId: string) {
	await expect.element(page.getByTestId(testId)).toBeVisible();
	return page.getByTestId(testId).element().textContent?.trim();
}

async function submitted(onSubmit: ReturnType<typeof vi.fn>) {
	await page.getByTestId('designation-primary').click();
	expect(onSubmit).toHaveBeenCalledTimes(1);
	return onSubmit.mock.calls[0][0];
}

beforeEach(async () => {
	await page.viewport(390, 844);
});

describe('the sign step', () => {
	/**
	 * Separates « the step arrives with nothing chosen and the question focused » from « an option is
	 * pre-selected or focused », which would make a default of the first button an Enter press away.
	 */
	it('opens on an unsigned amount column with nothing chosen and the heading focused', async () => {
		const { container } = await mount();
		await amountRow(container).click();

		await expect.element(heading()).toBeVisible();
		expect(document.activeElement?.tagName).toBe('H2');
		expect(document.activeElement?.textContent?.trim()).toBe(HEADING);
		await expect
			.element(page.getByText("Aucun montant de « Montant » n'a de signe moins.", { exact: true }))
			.toBeVisible();
		const options = [
			page.getByRole('button', { name: /^Argent sorti/ }).element(),
			page.getByRole('button', { name: /^Argent entré/ }).element()
		];
		for (const option of options) {
			expect(option.getAttribute('aria-pressed')).not.toBe('true');
			expect(option.getAttribute('aria-checked')).not.toBe('true');
		}
		const rows = [...container.ownerDocument.querySelectorAll('[data-testid="amount-sign-row"]')];
		expect(rows.map((r) => r.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
			'CARREFOUR · 03/04/2026 12,90',
			'SNCF · 04/04/2026 45,00',
			'EDF · 05/04/2026 83,10'
		]);
		expect(
			page
				.getByRole('button', { name: /^Argent sorti/ })
				.element()
				.textContent?.trim()
		).toBe('Argent sorti -12,90');
	});

	/**
	 * Separates « Both explains and decides nothing » from « Both answers or disables the pair », then
	 * « the answer leaves the screen » from « it changed the screen only ».
	 */
	it('says why Both cannot be imported, posts nothing, then posts the answer chosen', async () => {
		const onSubmit = vi.fn();
		const { container } = await mount({ onSubmit });
		await amountRow(container).click();

		await page.getByRole('button', { name: 'Les deux, selon la ligne' }).click();
		expect(await sentenceOf('amount-sign-both')).toBe(
			"Ce fichier n'indique pas quelles lignes sont lesquelles. Exportez-le de nouveau avec un signe moins sur les paiements, ou avec une colonne débit et une colonne crédit."
		);
		expect(onSubmit).not.toHaveBeenCalled();
		for (const name of [/^Argent sorti/, /^Argent entré/]) {
			const option = page.getByRole('button', { name }).element();
			expect(option.hasAttribute('disabled')).toBe(false);
			expect(option.getAttribute('aria-disabled')).not.toBe('true');
		}

		await page.getByRole('button', { name: /^Argent sorti/ }).click();
		expect(heading().elements().length).toBe(0);
		expect(await sentenceOf('amount-sign-line')).toBe('12,90 → -12,90 · argent sorti');
		expect(await submitted(onSubmit)).toMatchObject({ amountSign: 'out' });
	});

	/** Separates « the answer belongs to its column » from « the answer follows the role ». */
	it('drops the answer when Amount moves to another column', async () => {
		const onSubmit = vi.fn();
		const { container } = await mount({ onSubmit });
		await amountRow(container).click();
		await page.getByRole('button', { name: /^Argent entré/ }).click();

		await amountRow(container).click();
		await page.getByRole('option', { name: /Debit/ }).click();

		expect((await submitted(onSubmit)).amountSign).toBeNull();
	});

	/** Separates « a signed column is never asked » from « every amount column is asked ». */
	it('never opens on a signed column', async () => {
		const onSubmit = vi.fn();
		const { container } = await mount({
			onSubmit,
			initialAssignment: { ...DESIGNATED, amount: 3 }
		});
		expect(container.querySelector('[data-testid="amount-sign-line"]')).toBeNull();
		await amountRow(container).click();

		await expect.element(page.getByTestId('column-listbox')).toBeVisible();
		expect(heading().elements().length).toBe(0);
	});

	/**
	 * Separates « the column's state follows the answer about line 1 » from « it stays the state read
	 * with line 1 as headers ». Line 1 holds the column's only minus sign.
	 */
	it('follows « line 1 is data » through the other facts', async () => {
		const file = {
			...FILE,
			otherHeaderRowFacts: {
				samples: FILE.samples,
				firstRow: ['01/04/2026', 'LOYER', '-700,00', '-1,00'],
				previewRows: [['01/04/2026', 'LOYER', '-700,00', '-1,00'], ...PREVIEW],
				coverage: undefined,
				dateStates: FILE.dateStates,
				dateReadings: undefined,
				proposals: undefined,
				amountSignStates: ['none', 'none', 'signed', 'signed'] as const
			}
		};
		const { container } = await mount({ file });
		expect(await sentenceOf('amount-sign-line')).toBe('Sens à choisir');

		const dateRow = [...container.querySelectorAll('[data-testid="designation-card"] button')].find(
			(b) => (b.getAttribute('aria-label') ?? '').startsWith('Date')
		) as HTMLElement;
		await dateRow.click();
		await page.getByRole('switch').first().click();
		await page.getByRole('button', { name: 'Fermer' }).first().click();

		expect(container.querySelector('[data-testid="amount-sign-line"]')).toBeNull();
		await amountRow(container).click();
		expect(heading().elements().length).toBe(0);
	});

	/** Separates « the server's refusal reopens the question » from « only the column state can ». */
	it('opens on the refusal for the amount column, even where the column read as signed', async () => {
		const { container } = await mount({
			initialAssignment: { ...DESIGNATED, amount: 3 },
			askAmountSign: 3
		});
		await expect.element(heading()).toBeVisible();
		expect(document.activeElement?.textContent?.trim()).toBe(HEADING);

		// Closed unanswered, the row still says the question is open: the refusal is a fact about
		// THIS column, not only a reason to open the sheet once.
		await page.getByRole('button', { name: 'Fermer' }).first().click();
		expect(await sentenceOf('amount-sign-line')).toBe('Sens à choisir');
		expect(amountRow(container)).toBeTruthy();
	});
});
