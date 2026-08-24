import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';
import { E2E_BASE_URL } from './config';

/**
 * THE KEYBOARD WALK OF THE ACCOUNT ROW AND ITS PANEL.
 *
 * ## Why a browser and not a component test
 *
 * The six assertions live in component specs, where they belong: each is a claim about one
 * component's accessible surface, and a component spec can read that surface exactly. None of them
 * can say what a KEY does. Focus order across a panel that is rendered in a portal, arrow keys that
 * must not enter the footer action, Escape that must return focus to the trigger — those are
 * properties of a real browser with a real focus ring, and `document.activeElement` in a mounted
 * fragment is not the same object.
 *
 * ## The shape of every assertion here
 *
 * Each one names where focus IS, not merely that a key did not throw. `document.activeElement` is
 * read through `page.evaluate` and compared against an element this file located by role, so a walk
 * that silently lands on `<body>` fails rather than passing for the absence of an error.
 */

/** Bumped per seed so two tests in one worker never ask for the same account name. */
let seedCounter = 0;

function unrecognisedCsv(attempt: number): string {
	const suffix = attempt === 0 ? '' : ` k${attempt}`;
	return [
		`JourK${suffix};Intitule K${suffix};Somme K${suffix}`,
		'24/06/2026;E2E KEYBOARD CARREFOUR;-24,90'
	].join('\n');
}

/**
 * Two statement accounts, created through the real endpoint.
 *
 * NOT optional setup: with none, `AccountPicker` renders the create action alone and NO
 * `role="listbox"` at all, which is correct behaviour and makes every assertion below unanswerable.
 * The first version of this file walked that state and reported « element not found » on the
 * listbox, which reads as a broken panel and is a fact about the fixture.
 *
 * Named per worker so parallel workers do not collide on the folded-name rule.
 */
async function seedAccounts(page: import('@playwright/test').Page): Promise<string[]> {
	// UNIQUE PER CALL, not merely per worker. Archiving frees the account from the picker and NOT
	// from `@@unique([userId, name, source])`, so the second test re-seeding the same two names is
	// refused with `name-taken`, seeds nothing, and walks a panel with no options — which is how
	// this file went from three passes to one after the cleanup was added.
	const worker = process.env.TEST_WORKER_INDEX ?? '0';
	const stamp = `${worker}-${seedCounter++}-${Date.now()}`;
	const ids: string[] = [];
	for (const name of [`Clavier A ${stamp}`, `Clavier B ${stamp}`]) {
		const response = await page.request.post('/import/accounts', {
			headers: { Origin: E2E_BASE_URL },
			multipart: { name }
		});
		if (response.ok()) {
			const body = (await response.json()) as { account?: { id: string } };
			if (body.account?.id) ids.push(body.account.id);
		}
	}
	return ids;
}

/**
 * ARCHIVED AFTERWARDS, and this is not tidiness: the e2e database is ONE user shared by every spec
 * in the suite, so accounts created here stay in the picker for everything that runs later.
 *
 * MEASURED: leaving them turned a green suite into six failures across four unrelated files. The
 * picker helper takes the FIRST option, the straight-through-import spec depends on a single
 * account, and the correction specs count what the panel offers. None of them failed for a reason
 * that had anything to do with a keyboard; they failed because this file changed the world.
 *
 * Archiving rather than deleting, because archiving is what the application offers: an archived
 * account leaves `accountsForPicker` and keeps its history, which is exactly the state that
 * restores the fixture other specs were written against.
 */
async function archiveAccounts(
	page: import('@playwright/test').Page,
	ids: readonly string[]
): Promise<void> {
	for (const id of ids) {
		await page.request.post('/settings?/archiveAccount', {
			headers: { Origin: E2E_BASE_URL },
			multipart: { id }
		});
	}
}

/** Reaches the designation screen with a file the application has not learned. */
async function openDesignation(
	page: import('@playwright/test').Page,
	attempt: number
): Promise<string[]> {
	const created = await seedAccounts(page);
	await page.goto('/import');
	// `:visible`, not `.first()`: both chromes render this form and CSS hides one, so `.first()` is
	// the desktop copy and every interaction with it times out at 390 in a way that reads like a
	// missing element rather than like the wrong one.
	const form = page.locator('form[method="POST"]:visible').first();
	await form.locator('input[name="csvFile"]').setInputFiles({
		name: 'e2e-keyboard.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(unrecognisedCsv(attempt), 'utf-8')
	});
	await form.getByRole('button', { name: m.import_submit() }).click();
	await form.getByRole('button', { name: m.import_columns_offer() }).click();
	await expect(page).toHaveURL(/\/import\/columns/);
	return created;
}

/** The element focus is actually on, named the way a person would name it. */
async function focused(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		if (!el || el === document.body) return { tag: 'BODY', name: '', role: '' };
		return {
			tag: el.tagName,
			name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 60) ?? '',
			role: el.getAttribute('role') ?? ''
		};
	});
}

test.describe('the account row answers a keyboard, at 1280', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('Enter opens the panel with focus inside it, and Escape returns focus to the row', async ({
		page
	}, testInfo) => {
		const created = await openDesignation(page, testInfo.retry);
		try {
			const row = page.getByRole('button', {
				name: new RegExp(`^${m.import_account_row_label()}`)
			});
			await row.first().focus();
			// Calibration: focus really is on the row before any key is pressed. Without this, every
			// assertion below is equally explained by focus never having been where it was put.
			expect((await focused(page)).name).toContain(m.import_account_row_label());

			await page.keyboard.press('Enter');
			const listbox = page.getByRole('listbox', { name: m.import_account_row_label() });
			await expect(listbox).toBeVisible();
			// Focus enters the panel on the LISTBOX, which is what makes `aria-activedescendant` legal:
			// the attribute has to sit on the focused element, and neither a button nor an option may
			// carry it.
			expect((await focused(page)).role).toBe('listbox');

			await page.keyboard.press('Escape');
			await expect(listbox).toBeHidden();
			// Back on the trigger, not on the body. A panel that closes and drops focus leaves a keyboard
			// user at the top of the document, which is the failure this is here to prevent.
			expect((await focused(page)).name).toContain(m.import_account_row_label());
		} finally {
			await archiveAccounts(page, created);
		}
	});

	test('Tab from the list reaches the footer action, and one more Tab leaves the panel', async ({
		page
	}, testInfo) => {
		const created = await openDesignation(page, testInfo.retry);
		try {
			const row = page.getByRole('button', {
				name: new RegExp(`^${m.import_account_row_label()}`)
			});
			await row.first().focus();
			await page.keyboard.press('Enter');
			await expect(page.getByRole('listbox', { name: m.import_account_row_label() })).toBeVisible();

			await page.keyboard.press('Tab');
			// The footer action is the LAST tab stop of the panel and sits outside `role="listbox"`,
			// because a listbox's children must be options and a button among them is announced as one.
			expect((await focused(page)).name).toContain(m.import_account_new());

			await page.keyboard.press('Tab');
			// Out of the panel rather than cycling back into it: a trap is what a user cannot leave, and
			// this panel is a disclosure rather than a modal.
			expect((await focused(page)).name).not.toContain(m.import_account_new());
		} finally {
			await archiveAccounts(page, created);
		}
	});

	test('arrows move through the options and never step into the footer action', async ({
		page
	}, testInfo) => {
		const created = await openDesignation(page, testInfo.retry);
		try {
			const row = page.getByRole('button', {
				name: new RegExp(`^${m.import_account_row_label()}`)
			});
			await row.first().focus();
			await page.keyboard.press('Enter');
			const listbox = page.getByRole('listbox', { name: m.import_account_row_label() });
			await expect(listbox).toBeVisible();

			const optionCount = await page.getByRole('option').count();
			// Pressed more times than there are options, deliberately: the question is what happens at
			// the END of the list, and a walk that stops short never asks it.
			for (let index = 0; index < optionCount + 3; index += 1) {
				await page.keyboard.press('ArrowDown');
			}
			// Focus never leaves the listbox, whatever `aria-activedescendant` points at: arrows move the
			// ACTIVE option, not the focus, and stepping into the footer would put a button inside a
			// list's arrow cycle.
			expect((await focused(page)).role).toBe('listbox');
			const active = await listbox.getAttribute('aria-activedescendant');
			if (active !== null) {
				expect(await page.locator(`#${active}`).getAttribute('role')).toBe('option');
			}
		} finally {
			await archiveAccounts(page, created);
		}
	});
});
