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
	it('drops the provenance line once the user has CHOSEN a different account', async () => {
		// SEPARATES: « the hint describes the answer on the row now » FROM « it describes the answer
		// the server proposed ». The two put the same NAME on the row, so only the description tells
		// them apart, which is why nothing here saw it and why two shipped screenshots carried it.
		//
		// Same defect as the created case below and one step earlier: the sentence is a PROVENANCE,
		// and the moment the user overrides the resolution it describes something that no longer
		// holds. Found by a code review reading the images against that test's own reasoning: it
		// argued the general rule and implemented the special case.
		expect.assertions(2);
		mount({
			accounts: [
				{ id: 'account-a', name: 'Compte courant', discriminant: null, transactionCount: 4 },
				{ id: 'account-b', name: 'Livret A', discriminant: null, transactionCount: 2 }
			],
			initialAccountId: 'account-a',
			accountHint: m.import_account_hint_unknown()
		});
		// The hint is on screen while the row still shows what the resolution proposed, which is the
		// state it is true of. Without this the assertion below also passes on a screen that never
		// rendered a hint at all.
		expect(document.body.textContent).toContain(m.import_account_hint_unknown());
		await openPanel();
		await page.getByRole('option', { name: /Livret A/ }).click();
		expect(document.body.textContent).not.toContain(m.import_account_hint_unknown());
	});

	it('drops the provenance line once the user has created the account themselves', async () => {
		// SEPARATES: « the hint describes where the CURRENT answer came from » FROM « the hint is the
		// sentence the server computed when the page loaded ».
		//
		// FOUND BY A SCREENSHOT of the built journey, not by any assertion here. With no accounts the
		// server sends « No accounts yet. Create the one this statement belongs to. » The user then
		// creates one, the row correctly shows its name, and that sentence stays underneath it: the
		// screen names an account and says in the next line that there are none. Every sentence the
		// hint can carry is a PROVENANCE, and an account the user has just made has no provenance the
		// server could have described.
		//
		// The two states produce the same NAME on the row, which is why nothing already here caught
		// it: only the description separates them.
		expect.assertions(2);
		mount({
			accountHint: m.import_account_hint_no_accounts(),
			onCreateAccount: vi.fn().mockResolvedValue({ ok: true, account: CREATED })
		});
		await openPanel();
		await footerAction().click();
		await nameField().fill(CREATED.name);
		await primary().click();
		const row = page.getByRole('button', { name: new RegExp(m.import_account_row_label()) });
		// The row names the account, so this is the state after a successful creation rather than
		// before one: without this the assertion below also passes on a sheet that never submitted.
		await expect
			.element(row)
			.toHaveAccessibleName(m.import_account_row_aria({ account: CREATED.name }));
		expect(document.body.textContent).not.toContain(m.import_account_hint_no_accounts());
	});

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

	it('hands the sheet no name list, so a name already on screen still reaches the server', async () => {
		// SEPARATES: « the screen asks the server about a duplicate » FROM « it answers from what is
		// on screen ». This assertion is the INVERSE of the one it replaces, and the inversion is the
		// finding rather than a change of mind.
		//
		// The screen used to pass `shownAccounts.map((a) => a.name)` and the sheet refused against it.
		// That was equivalent to the server's check only while those strings were the ones the server
		// compares. Making the picker substitute `displayAccountName` ended the equivalence by
		// construction: the row on screen reads « Import CSV » and the column holds « Compte import
		// CSV », so the two sides disagreed in both directions on that account.
		//
		// Each side now validates only what it can know with certainty. This one knows what is on
		// screen and therefore says nothing about uniqueness; the server knows what is stored and its
		// refusal is what the user reads.
		expect.assertions(2);
		const onCreateAccount = vi.fn(async () => ({ ok: true as const, account: CREATED }));
		mount({ onCreateAccount });
		await openPanel();
		await footerAction().click();
		await nameField().fill(CREATED.name);
		await primary().click();
		// Same name again, and the request goes out a second time rather than being answered here.
		await openPanel();
		await footerAction().click();
		await nameField().fill(CREATED.name.toLowerCase());
		await primary().click();
		expect(onCreateAccount).toHaveBeenCalledTimes(2);
		// The companion, because « it asked twice » would also be true of a screen that shows the
		// refusal anyway: no local sentence about duplicates is on the page.
		expect(document.body.textContent).not.toContain(m.import_account_create_error_name_taken());
	});
});
