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

const BACK = /Retour aux colonnes/;

/** Back to the designation screen, unanswered. */
async function back() {
	await page.getByRole('button', { name: BACK }).click();
	expect(heading().elements().length).toBe(0);
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

		await expect.element(heading()).toBeVisible();
		expect(document.activeElement?.tagName).toBe('H1');
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
		await mount({ onSubmit });

		await page.getByRole('button', { name: 'Certaines sorties, certaines entrées' }).click();
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
		await back();
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
		// THIS column, not only a reason to open the step once.
		await back();
		expect(await sentenceOf('amount-sign-line')).toBe('Sens à choisir');
		expect(amountRow(container)).toBeTruthy();
	});
});

describe('the sign step is asked before the import, not after its refusal', () => {
	/**
	 * Separates « the screen asks on arrival » from « the member must find the row first », which let
	 * the footer read 3 sur 3 over an Import the server then refused.
	 */
	it('opens on arrival, focused on the question, once', async () => {
		const onSubmit = vi.fn();
		await mount({ onSubmit });

		await expect.element(heading()).toBeVisible();
		expect(document.activeElement?.textContent?.trim()).toBe(HEADING);
		for (const name of [/^Argent sorti/, /^Argent entré/]) {
			expect(page.getByRole('button', { name }).element().getAttribute('aria-pressed')).not.toBe(
				'true'
			);
		}
	});

	/** Separates « no arrival question on a recap » from « every mount asks ». */
	it('does not open on arrival in the recap', async () => {
		await mount({ readOnly: true });
		expect(heading().elements().length).toBe(0);
	});

	/**
	 * Separates « the primary asks the open question » from « the primary posts an unanswered file
	 * the server will refuse ».
	 */
	it('asks again instead of submitting when the step was closed unanswered', async () => {
		const onSubmit = vi.fn();
		await mount({ onSubmit });
		await expect.element(heading()).toBeVisible();
		await back();

		await page.getByTestId('designation-primary').click();

		expect(onSubmit).not.toHaveBeenCalled();
		await expect.element(heading()).toBeVisible();
	});

	/**
	 * Separates « the step is a page whose first heading is the question, read from the top » from
	 * « the question is a panel under a row, below whatever the page was scrolled to ».
	 */
	it('makes the question the first heading of the page, with the window at the top', async () => {
		await page.viewport(1280, 800);
		// A page already scrolled, as the screen under it can be. `above` stands for what sits above
		// the step in the app (500 px, so the heading is already IN VIEW at 400 and focusing it moves
		// nothing); `tall` makes the window scroll. The 400 read back proves the starting point.
		const above = document.createElement('div');
		above.style.height = '500px';
		document.body.prepend(above);
		const tall = document.createElement('div');
		tall.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:4000px';
		document.body.append(tall);
		try {
			window.scrollTo(0, 400);
			expect(window.scrollY).toBe(400);
			await mount({ wide: true });
			await expect.element(heading()).toBeVisible();
			const first = document.querySelector('h1, h2, h3');
			expect(first?.tagName).toBe('H1');
			expect(first?.textContent?.trim()).toBe(HEADING);
			expect(window.scrollY).toBe(0);
		} finally {
			above.remove();
			tall.remove();
		}
	});
});

/**
 * THE STEP REPLACES THE SCREEN (owner, 2026-11-06; NN/g: no bottom sheet for a step of a flow).
 * Separates « a page of its own, with Back to the columns » from « a sheet or panel over the screen ».
 */
describe('the sign question is a full-screen step', () => {
	it('replaces the designation screen and opens no sheet or panel', async () => {
		await mount();
		await expect.element(heading()).toBeVisible();
		expect(document.querySelector('[data-testid="designation-card"]')).toBeNull();
		expect(document.querySelector('[data-testid="column-picker-panel"]')).toBeNull();
		expect(document.querySelectorAll('[role="dialog"]').length).toBe(0);
		// No Import while the question is open (#1288: a press that did nothing visible at 1280).
		expect(document.querySelector('[data-testid="designation-primary"]')).toBeNull();
		expect(
			page.getByRole('button', { name: BACK }).element().textContent?.replace(/\s+/g, ' ').trim()
		).toBe('‹ Retour aux colonnes');
	});

	/** Separates « Back leaves the question open » from « Back answers it with a default ». */
	it('goes back without answering and posts nothing', async () => {
		const onSubmit = vi.fn();
		await mount({ onSubmit });
		await back();

		expect(await sentenceOf('amount-sign-line')).toBe('Sens à choisir');
		expect(onSubmit).not.toHaveBeenCalled();
	});

	for (const [width, height, wide] of [
		[390, 844, false],
		[1280, 800, true]
	] as const) {
		/**
		 * Separates « both answers are on the first screen, unobstructed » from « they sit below the
		 * fold or under something », which is what the 1280 walk found on the anchored panel.
		 */
		it(`shows both answers inside the first viewport, unobstructed, at ${width}`, async () => {
			await page.viewport(width, height);
			await mount({ wide });
			await expect.element(heading()).toBeVisible();
			for (const name of [/^Argent sorti/, /^Argent entré/]) {
				const button = page.getByRole('button', { name }).element() as HTMLElement;
				const box = button.getBoundingClientRect();
				expect(box.top).toBeGreaterThanOrEqual(0);
				expect(box.bottom).toBeLessThanOrEqual(height);
				expect(box.height).toBeGreaterThanOrEqual(88);
				const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
				expect(button.contains(hit)).toBe(true);
			}
		});
	}
});

/**
 * ONE QUESTION, THEN THE NEXT (owner, 2026-11-06: progressive disclosure, step by step). Once the
 * sign is answered on a screen whose account is not chosen yet, the account question opens next,
 * instead of leaving the member on a screen whose footer says « 3 sur 3 » above an Import that will
 * be refused for the missing account (Playwright MCP walk at 390).
 *
 * Separates « the account panel opens after the answer » from « the screen closes the sign step and
 * waits », and the second case from « it opens even when an account is already chosen ».
 */
describe('after the sign answer, the next open question', () => {
	it('opens the account question when no account is chosen yet', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		await mount({ initialAccountId: null });
		await expect.element(heading()).toBeVisible();
		await page.getByRole('button', { name: /^Argent sorti/ }).click();
		await expect
			.element(page.getByRole('button', { name: /^Compte/ }))
			.toHaveAttribute('aria-expanded', 'true');
	});

	it('leaves the account closed when one is already chosen', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		await mount();
		await expect.element(heading()).toBeVisible();
		await page.getByRole('button', { name: /^Argent sorti/ }).click();
		await expect
			.element(page.getByRole('button', { name: /^Compte/ }))
			.toHaveAttribute('aria-expanded', 'false');
	});
});

/**
 * FOCUS COMES BACK TO THE ROW (WCAG 2.2, 2.4.3). The step replaces the screen, so closing it
 * remounts the screen; the sheet it replaced returned focus to the row that opened it. Separates
 * « focus on the Amount row after Back » from « focus on the page body », where a keyboard user
 * starts again from the top of the page.
 */
describe('focus after the step closes', () => {
	it('returns to the Amount row after Back', async () => {
		expect.assertions(2);
		await page.viewport(390, 844);
		await mount();
		await expect.element(heading()).toBeVisible();
		await page.getByRole('button', { name: 'Retour aux colonnes' }).click();
		await expect
			.poll(() => (document.activeElement?.getAttribute('aria-label') ?? '').startsWith('Montant'))
			.toBe(true);
	});
});

/**
 * #1294 (C2c-S2): THE ANSWER KEPT WITH THE CORRESPONDANCE. A remembered mapping arrives with the
 * answer the member gave for its format, shown as given and changeable, never asked again.
 */
describe('a remembered answer', () => {
	const REMEMBERED = {
		mappingId: 'mapping-1',
		assignment: DESIGNATED,
		layers: { date: 'member', label: 'member', amount: 'member' },
		amountSign: { sign: 'out', accountId: 'account-1' }
	};

	/**
	 * Separates « the remembered answer is shown answered and posted as it was » from « the question
	 * opens again on arrival », which is what a member who answered last month met on `main`.
	 */
	it('arrives answered, does not ask again, and posts the remembered answer', async () => {
		const onSubmit = vi.fn();
		await mount({ remembered: REMEMBERED, onSubmit });

		expect(await sentenceOf('amount-sign-line')).toBe('12,90 → -12,90 · argent sorti');
		expect(heading().elements().length).toBe(0);
		expect(await submitted(onSubmit)).toMatchObject({ amountSign: 'out' });
	});

	/**
	 * Separates « the member can change a remembered answer » from « it is fixed once kept », which
	 * would leave a wrong answer applied to every later statement with no way back.
	 */
	it('asks again when the member re-chooses the Amount column, and posts the new answer', async () => {
		const onSubmit = vi.fn();
		const { container } = await mount({ remembered: REMEMBERED, onSubmit });

		await amountRow(container).click();
		await page.getByRole('option', { name: /Montant/ }).click();
		await expect.element(heading()).toBeVisible();
		await page.getByRole('button', { name: /^Argent entré/ }).click();

		expect(await submitted(onSubmit)).toMatchObject({ amountSign: 'in' });
	});

	/**
	 * Separates « an answer belongs to the column it was given about » from « it follows the role »:
	 * a remembered mapping whose Amount column is not the one on screen asks.
	 */
	/**
	 * Separates « a kept answer holds for the account it was given for » from « it follows the
	 * correspondance into any account » (owner ruling 1 on #1294): kept for another account, it asks.
	 */
	it('asks when the answer was kept for another account', async () => {
		await mount({
			remembered: { ...REMEMBERED, amountSign: { sign: 'out', accountId: 'account-2' } }
		});
		await expect.element(heading()).toBeVisible();
	});

	/**
	 * Separates « the kept answer is dropped when the member moves to another account » from « it
	 * stays answered », where it would be posted for an account it was never given for.
	 */
	it('drops the kept answer when the member chooses another account', async () => {
		const onSubmit = vi.fn();
		await mount({
			remembered: REMEMBERED,
			accounts: [
				...ACCOUNTS,
				{ id: 'account-2', name: 'BP · Livret', discriminant: '0185', transactionCount: 3 }
			],
			onSubmit
		});
		expect(await sentenceOf('amount-sign-line')).toBe('12,90 → -12,90 · argent sorti');
		await page.getByTestId('designation-account').getByRole('button').first().click();
		await page.getByRole('option', { name: /Livret/ }).click();
		expect(await sentenceOf('amount-sign-line')).toBe('Sens à choisir');
	});

	/**
	 * NOTE PASS N5. Separates « a kept answer is posted only where this screen shows the question »
	 * from « posted from a screen whose column reads as signed », where the member never saw it.
	 */
	it('posts no kept answer where the screen does not ask the sign', async () => {
		const onSubmit = vi.fn();
		await mount({
			file: { ...FILE, amountSignStates: ['none', 'none', 'signed', 'signed'] as const },
			remembered: REMEMBERED,
			onSubmit
		});
		expect((await submitted(onSubmit)).amountSign).toBeNull();
	});

	it('asks when the remembered Amount column is not the one designated', async () => {
		await mount({
			remembered: { ...REMEMBERED, assignment: { ...DESIGNATED, amount: 3 } }
		});
		await expect.element(heading()).toBeVisible();
	});
});
