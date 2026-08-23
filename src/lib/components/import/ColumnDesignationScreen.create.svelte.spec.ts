import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '../../../routes/layout.css';
import * as m from '$lib/paraglide/messages';
import ColumnDesignationScreen from './ColumnDesignationScreen.svelte';
import type { RoleAssignment } from '$lib/domain/columnDesignation';

/**
 * THE SEAM between the row, the panel and the create sheet, which is the thing no other file sees.
 *
 * `AccountPicker.svelte.spec.ts` proves the panel offers the footer action. `CreateAccountSheet`'s
 * own spec proves the sheet refuses, submits and reports. Neither of them says the two are
 * CONNECTED, and a footer action wired to nothing renders identically to one wired correctly. That
 * is exactly the state Task 6 shipped and it is why a user with no account could not finish an
 * import at all.
 *
 * Every assertion names the TWO STATES it separates. The viewport is 390x844 because the column
 * picker on this screen is a `BottomSheet` and the screen mounts one chrome per width; the figures
 * here are not width-dependent, but the screen is.
 */

const HEADERS = ['Date operation', 'Libelle', 'Montant'];

const FILE = {
	name: 'releve.csv',
	headers: HEADERS,
	samples: HEADERS.map((_, index) => [`v${index}a`, `v${index}b`]),
	rowCount: 12,
	detectedHeaderRow: true
};

const COMPLETE: RoleAssignment = { date: 0, label: 1, amount: 2, category: null };

const CREATED = {
	id: 'account-new',
	name: 'Livret A',
	discriminant: null,
	transactionCount: 0
};

function mount(props: Record<string, unknown> = {}) {
	return render(ColumnDesignationScreen, {
		file: FILE,
		initialAssignment: COMPLETE,
		// EMPTY on purpose: this is the cell the whole task exists for. A user with only manual
		// transactions has exactly one Account row and `isStatementAccount` excludes it, so the
		// panel's only content is the footer action.
		accounts: [],
		initialAccountId: null,
		announceDelayMs: 0,
		...props
	});
}

const openPanel = async () => {
	await page.getByRole('button', { name: new RegExp(m.import_account_row_label()) }).click();
};
const footerAction = () => page.getByRole('button', { name: m.import_account_new() });
const nameField = () => page.getByRole('textbox', { name: m.import_account_create_field() });
const primary = () => page.getByRole('button', { name: m.import_account_create_submit() });
const sheetCancel = () => page.getByRole('dialog').getByRole('button', { name: m.common_cancel() });

beforeEach(async () => {
	await page.viewport(390, 844);
});

describe('creating an account without leaving the file in your hand', () => {
	it('opens the sheet from the panel action and closes the panel behind it', async () => {
		// SEPARATES: « the footer action opens the create sheet » FROM « it closes the panel and
		// nothing happens », which is what shipped with the row and the panel alone. Both leave the
		// panel closed, and only the sheet tells them apart.
		mount({ onCreateAccount: vi.fn() });
		await openPanel();
		await footerAction().click();
		await expect.element(nameField()).toBeInTheDocument();
		// The panel is gone rather than stacked under the sheet: two open surfaces for one choice
		// give a screen reader two lists to walk out of.
		expect(document.querySelectorAll('[role="listbox"]')).toHaveLength(0);
	});

	it('adds the created account to the panel and selects it on the row', async () => {
		// SEPARATES: « the account created is the account chosen » FROM « it was created and the user
		// has to go and pick it ». The second is a screen that reports success and leaves the primary
		// still refusing, which reads as a creation that did not work.
		const onCreateAccount = vi.fn(async () => ({ ok: true as const, account: CREATED }));
		mount({ onCreateAccount });
		await openPanel();
		await footerAction().click();
		await nameField().fill('Livret A');
		await primary().click();
		expect(onCreateAccount).toHaveBeenCalledWith('Livret A');
		// The ROW says it, which is where the user is looking, and it says it through its own
		// accessible name rather than through an added live region. 6g settles that.
		await expect
			.element(
				page.getByRole('button', { name: m.import_account_row_aria({ account: 'Livret A' }) })
			)
			.toBeInTheDocument();
	});

	it('lets the import proceed once the account it created exists', async () => {
		// SEPARATES: « the whole journey completes » FROM « each half works ». This is the assertion
		// the shipping blocker was about: with no account and no sheet, the primary refuses for ever
		// and there is no path from this screen to an import. The account id submitted is the CREATED
		// one, which is the only proof the two halves are the same account.
		const onSubmit = vi.fn();
		mount({
			onCreateAccount: vi.fn(async () => ({ ok: true as const, account: CREATED })),
			onSubmit
		});
		await openPanel();
		await footerAction().click();
		await nameField().fill('Livret A');
		await primary().click();
		await page.getByRole('button', { name: /Importer/ }).click();
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0][0]).toMatchObject({ accountId: 'account-new' });
	});

	it('keeps the sheet open and shows the server sentence when the create fails', async () => {
		// SEPARATES: « the failure is reported on the sheet the user is standing on » FROM « the sheet
		// closes and the failure is reported somewhere else, or nowhere ». The user is mid-import;
		// a sheet that vanishes on a failure reads as the loss of the designation work.
		mount({
			onCreateAccount: vi.fn(async () => ({
				ok: false as const,
				error: m.import_account_create_error_generic()
			}))
		});
		await openPanel();
		await footerAction().click();
		await nameField().fill('Livret A');
		await primary().click();
		await expect.element(page.getByRole('alert')).toBeInTheDocument();
		expect(document.body.textContent).toContain(m.import_account_create_error_generic());
		await expect.element(nameField()).toBeInTheDocument();
	});

	it('reopens the panel on cancel, on the action it was opened from', async () => {
		// SEPARATES: « cancelling returns the user where they were » FROM « cancelling drops them on
		// a closed row they must open again ». The second is a dead end our own navigation
		// manufactured rather than one the task has. The focus is the assertion, not the reopening:
		// a panel that reopens with the focus elsewhere is the same dead end for a keyboard user.
		mount({ onCreateAccount: vi.fn() });
		await openPanel();
		await footerAction().click();
		// Scoped to the account block, and NOT by position: the screen's own footer carries an
		// « Annuler » of its own (leaving the designation), so a global lookup resolves to two. Two
		// controls with one name in two regions is not a defect; picking between them by index would
		// be, because the index is a fact about the render order.
		await sheetCancel().click();
		await expect.element(footerAction()).toBeInTheDocument();
		expect(document.activeElement).toBe(footerAction().element());
	});

	it('offers the sheet the names it must refuse, including one just created', async () => {
		// SEPARATES: « the local refusal knows every account on the screen » FROM « it knows only the
		// ones the server sent ». An account created a moment ago is exactly the one a user is most
		// likely to type again, and it is the one a list built from the server payload cannot hold.
		mount({ onCreateAccount: vi.fn(async () => ({ ok: true as const, account: CREATED })) });
		await openPanel();
		await footerAction().click();
		await nameField().fill('Livret A');
		await primary().click();
		// Second creation, same name. Refused here rather than at the server.
		await openPanel();
		await footerAction().click();
		await nameField().fill('livret a');
		await primary().click();
		expect(document.body.textContent).toContain(m.import_account_create_error_name_taken());
	});
});
