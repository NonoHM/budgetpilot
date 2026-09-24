import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import type { RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * #395, half 2: the designation screen during its own import, plate 1q B « Envoi ».
 *
 * « Annuler et le retour passent en aria-disabled, même raison. Les rangées aussi : focusables, non
 * activables. » Measured before this file: only the primary went `aria-busy`. Cancel and the back
 * arrow carried nothing and still left the screen mid-import, the four role rows still opened their
 * picker, and the account row dimmed and ignored the pointer while Enter still opened its panel.
 *
 * Every control is asserted TWICE and the two are split on purpose: `aria-disabled` is what the
 * control SAYS, and the swallowed activation is what it DOES. A control announcing itself disabled
 * while still acting, or refusing while announcing nothing, each passes a test written about the
 * other half.
 *
 * The transition is the route's: the screen mounts idle, the press sends, and `submitting` arrives
 * as a prop change. A screen mounted already busy is not a state the journey produces.
 *
 * Clicks go through `element.click()` rather than a locator: Playwright treats `aria-disabled` as
 * not enabled and would wait for ever on the very state under test.
 */

const HEADERS = ['Date operation', 'Date valeur', 'Libelle', 'Montant', 'Categorie'];
const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`, `v${index}c`]),
	rowCount: 132,
	detectedHeaderRow: true
};
const COMPLETE: RoleAssignment = { date: 0, label: 2, amount: 3, category: 4 };

async function mountSending(wide: boolean, onCancel = vi.fn()) {
	await page.viewport(wide ? 1280 : 390, wide ? 800 : 844);
	const screen = await render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: COMPLETE,
		accounts: [
			{ id: 'account-1', name: 'BP · Compte courant', discriminant: '4417', transactionCount: 128 }
		],
		initialAccountId: 'account-1',
		announceDelayMs: 0,
		wide,
		onCancel,
		onSubmit: () => {}
	});
	await screen.rerender({ submitting: true });
	await expect
		.element(page.getByTestId('designation-primary'))
		.toHaveAttribute('aria-busy', 'true');
	return { screen, onCancel };
}

const cancelButton = () =>
	[...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === m.import_columns_cancel()
	) as HTMLButtonElement;
const backButton = () =>
	document.querySelector(`button[aria-label="${m.import_columns_back()}"]`) as HTMLButtonElement;
const roleRows = () =>
	[
		...document.querySelectorAll('[data-testid="designation-card"] button[aria-haspopup="listbox"]')
	] as HTMLButtonElement[];
const accountRow = () =>
	document.querySelector(
		'[data-testid="designation-account"] button[aria-haspopup="listbox"]'
	) as HTMLButtonElement;

describe.each([false, true])(
	'the designation screen while its import is out (wide: %s)',
	(wide) => {
		// SEPARATES: « Cancel says it is off » FROM « it looks live ». Break: drop its aria-disabled.
		it('marks Cancel aria-disabled', async () => {
			await mountSending(wide);

			expect(cancelButton().getAttribute('aria-disabled')).toBe('true');
		});

		// SEPARATES: « Cancel refuses to leave mid-import » FROM « it navigates away while the write is
		// in flight », the plate's defect. Break: drop the swallow in its handler.
		it('does not leave when Cancel is pressed', async () => {
			const { onCancel } = await mountSending(wide);

			cancelButton().click();

			expect(onCancel).not.toHaveBeenCalled();
		});

		// FOUR rows, counted, so an empty query cannot pass. SEPARATES: « every row says it is off »
		// FROM « some do ». Break: drop `busy` from RoleRow's aria-disabled.
		it('marks every role row aria-disabled, and keeps each focusable', async () => {
			await mountSending(wide);
			const rows = roleRows();

			expect(rows).toHaveLength(4);
			expect(rows.map((row) => row.getAttribute('aria-disabled'))).toEqual([
				'true',
				'true',
				'true',
				'true'
			]);
			expect(rows.some((row) => row.hasAttribute('disabled'))).toBe(false);
		});

		// SEPARATES: « a row refuses to open its picker » FROM « the user reopens a picker and changes a
		// designation the request has already carried away ». Read AFTER a later state that DID render
		// would be stronger; here the negative is read after a macrotask, because the picker opens in the
		// same flush as the click. Break: drop the swallow in RoleRow.
		it('opens no picker from a role row', async () => {
			await mountSending(wide);

			for (const row of roleRows()) row.click();
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(roleRows().map((row) => row.getAttribute('aria-expanded'))).toEqual([
				'false',
				'false',
				'false',
				'false'
			]);
		});

		// SEPARATES: « the account row says it is off » FROM « it only dims », which is what it did.
		it('marks the account row aria-disabled', async () => {
			await mountSending(wide);

			expect(accountRow().getAttribute('aria-disabled')).toBe('true');
		});

		// FROM THE KEYBOARD, because the pointer was already refused by `pointer-events-none` and Enter
		// was not: that was the live half of the defect. SEPARATES: « Enter on the account row opens
		// nothing » FROM « it opens the panel mid-import ».
		it('opens no account panel from the keyboard', async () => {
			await mountSending(wide);

			accountRow().focus();
			await userEvent.keyboard('{Enter}');
			await new Promise((resolve) => setTimeout(resolve, 50));

			expect(accountRow().getAttribute('aria-expanded')).toBe('false');
		});

		// THE RESTORATION, which is the plate's « retour à l'état 2 exactement ». SEPARATES: « the
		// screen comes back live when the import is no longer out » FROM « the controls stay off »,
		// which a guard keyed on the wrong flag would ship. One assertion per control kind, read
		// together because they share one transition.
		it('restores Cancel and every row when the import is no longer out', async () => {
			const { screen, onCancel } = await mountSending(wide);

			await screen.rerender({ submitting: false });
			await expect
				.element(page.getByTestId('designation-primary'))
				.not.toHaveAttribute('aria-busy', 'true');

			expect(cancelButton().hasAttribute('aria-disabled')).toBe(false);
			expect(roleRows().map((row) => row.hasAttribute('aria-disabled'))).toEqual([
				false,
				false,
				false,
				false
			]);
			expect(accountRow().hasAttribute('aria-disabled')).toBe(false);
			cancelButton().click();
			expect(onCancel).toHaveBeenCalledTimes(1);
		});
	}
);

describe('the back arrow, which only the 390 chrome draws', () => {
	beforeEach(async () => {
		await page.viewport(390, 844);
	});

	// SEPARATES: « the back arrow says it is off » FROM « it looks live ».
	it('is aria-disabled while the import is out', async () => {
		await mountSending(false);

		expect(backButton().getAttribute('aria-disabled')).toBe('true');
	});

	// SEPARATES: « back refuses to leave mid-import » FROM « it navigates away ».
	it('does not leave while the import is out', async () => {
		const { onCancel } = await mountSending(false);

		backButton().click();

		expect(onCancel).not.toHaveBeenCalled();
	});

	it('is restored when the import is no longer out', async () => {
		const { screen, onCancel } = await mountSending(false);

		await screen.rerender({ submitting: false });
		await expect.poll(() => backButton().hasAttribute('aria-disabled')).toBe(false);

		backButton().click();
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
