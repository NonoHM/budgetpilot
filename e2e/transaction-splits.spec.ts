// The split editor on the real pages: the whole gesture, and the geometry no component test can
// reach.
//
// Two things are proven here and nowhere else. First, that the round trip works against a real
// server — the entry row, the parts, the write path, the success message — which every spec beside
// `SplitEditor.svelte.spec.ts` mocks away. Second, the PANEL'S GEOMETRY AGAINST THE FOLD, which
// CLAUDE.md records as something no assertion in this repo currently checks and which has been got
// wrong twice on the Période panel: a size expressed in viewport units caps how tall a panel is and
// says nothing about where it begins, so the primary action can sit below the fold with the panel
// itself measuring as "fitting".
//
// The spec RESTORES the state it changes: it splits `CARREFOUR MARKET` and removes the split again
// before finishing. The suite shares one database in declaration order, so a répartie transaction
// left behind would change the classify pile and the Répartition filter's availability for every
// spec that runs after it.
import { expect, test } from './fixtures';
// Message FUNCTIONS, never retyped copy: `e2e/fixtures.ts` pins the node-side locale from
// `E2E_LOCALE`, so these render the same French the browser does. A copied sentence drifts by one
// apostrophe and fails as a timeout on a locator, which reads as a missing element rather than as
// wrong text — this spec lost a run to exactly that.
import * as m from '../src/lib/paraglide/messages';

const SPLIT_LABEL = 'CARREFOUR MARKET';
/** The seeded amount of that transaction, in the form the field shows it. */
const PART_ONE = '30,00';
const PART_TWO = '12,90';
/** 1k's keyboard-open column: « viewport visuel 544 » against a layout viewport of 844. */
const KEYBOARD_OPEN_VIEWPORT = 544;

async function openDetail(page: import('@playwright/test').Page) {
	await page.goto('/transactions');
	await page
		.getByRole('link', { name: new RegExp(SPLIT_LABEL) })
		.first()
		.click();
}

/**
 * Region geometry for the surface that is actually visible, read off the live DOM.
 *
 * The SUBJECT is established before the value is trusted: the save button is found by its own
 * accessible name inside the split form, and the scrolling container is found by walking UP from it
 * to the first ancestor that actually scrolls — never by class list, which is exactly what a
 * geometry claim must not rest on.
 */
async function measure(page: import('@playwright/test').Page) {
	return page.evaluate(() => {
		// Matched on the ACTION NAME, not on the whole URL: the action carries the current filters
		// and `selected` so the POST does not close the panel it belongs to, so its href is not a
		// fixed string.
		const forms = Array.from(document.querySelectorAll('form[action*="/saveSplits"]'));
		const form = forms.find((f) => f.getBoundingClientRect().height > 0);
		if (!form) return null;

		const save = Array.from(form.querySelectorAll('button')).find(
			(b) => (b.textContent || '').trim() === 'Enregistrer'
		);
		if (!save) return null;

		let scroller: HTMLElement | null = form.parentElement;
		while (scroller && scroller !== document.body) {
			const style = getComputedStyle(scroller);
			if (
				(style.overflowY === 'auto' || style.overflowY === 'scroll') &&
				scroller.scrollHeight > scroller.clientHeight
			) {
				break;
			}
			scroller = scroller.parentElement;
		}

		// The SHEET's own four regions, read off the elements that carry them rather than derived
		// from one another. The panel is the dialog; the handle is the separator it renders first;
		// the header band is the block between them and the scrolling body. Deriving the header from
		// `bodyTop - panelTop - handle` would produce a number that always balances, which is the
		// property of an arithmetic identity rather than of a measurement.
		const panel = form.closest('[role="dialog"]') as HTMLElement | null;
		const handle = panel?.querySelector('[role="separator"]') as HTMLElement | null;
		const headerBand = handle?.nextElementSibling as HTMLElement | null;

		const saveBox = save.getBoundingClientRect();
		const scrollerBox = scroller?.getBoundingClientRect() ?? null;
		return {
			viewport: { width: window.innerWidth, height: window.innerHeight },
			visualViewport: window.visualViewport
				? { height: window.visualViewport.height, offsetTop: window.visualViewport.offsetTop }
				: null,
			panel: panel
				? {
						top: panel.getBoundingClientRect().top,
						bottom: panel.getBoundingClientRect().bottom,
						height: panel.getBoundingClientRect().height
					}
				: null,
			handle: handle ? handle.getBoundingClientRect().height : null,
			headerBand: headerBand ? headerBand.getBoundingClientRect().height : null,
			save: { top: saveBox.top, bottom: saveBox.bottom, height: saveBox.height },
			scroller: scrollerBox
				? {
						top: scrollerBox.top,
						bottom: scrollerBox.bottom,
						height: scrollerBox.height,
						scrollHeight: scroller!.scrollHeight
					}
				: null,
			// The sticky group's own computed position, so "it is sticky" is a measurement rather
			// than a class name.
			savePosition: getComputedStyle(save.closest('.sticky') ?? save).position
		};
	});
}

/** Puts the transaction back to unsplit if a previous attempt left it répartie. */
async function removeAnyExistingSplit(page: import('@playwright/test').Page) {
	const remove = page.getByRole('button', { name: m.splits_remove_action() }).first();
	if (!(await remove.isVisible().catch(() => false))) return;
	await remove.click();
	await page
		.locator('form[action*="/saveSplits"]')
		.first()
		.getByRole('button', { name: m.common_save() })
		.click();
	await expect(page.getByRole('button', { name: m.splits_entry_action() }).first()).toBeVisible();
}

test.describe('the split editor on /transactions', () => {
	test('splits a transaction, measures the panel against the fold at both breakpoints, and removes it again', async ({
		page
	}) => {
		test.slow();

		// ---- desktop: the whole gesture ------------------------------------------------------
		await page.setViewportSize({ width: 1280, height: 800 });
		await openDetail(page);

		// IDEMPOTENT BY CONSTRUCTION, and it is not defensiveness. This suite retries twice on one
		// shared database, so a run that fails after the save leaves `CARREFOUR MARKET` répartie —
		// and the retry then fails on the missing entry row instead of on whatever broke, which
		// hides the real failure behind a second, misleading one. Measured: the first run of this
		// spec did exactly that.
		await removeAnyExistingSplit(page);

		const entry = page.getByRole('button', { name: m.splits_entry_action() });
		await expect(entry.first()).toBeVisible();
		// 1b: « rangée de 44 px, pas un lien de 20 px : c'est une action, elle a la hauteur des
		// actions. » Measured on the real page rather than in a component harness, because the row
		// inherits the panel's own width and padding here.
		const entryBox = await entry.first().boundingBox();
		expect(entryBox!.height).toBeGreaterThanOrEqual(44);

		await entry.first().click();

		const editor = page.locator('form[action*="/saveSplits"]').first();
		await expect(editor).toBeVisible();

		// 1j-A: the remainder opens at the WHOLE amount — « c'est la leçon en un coup d'œil : ce
		// nombre doit tomber à zéro ».
		await expect(editor.getByText('42,90 €').first()).toBeVisible();

		// The parent selector is locked in place, and it says why.
		const parentSelector = page.getByLabel(m.transactions_manual_category_heading()).first();
		await expect(parentSelector).toHaveAttribute('aria-disabled', 'true');
		const lockId = await parentSelector.getAttribute('aria-describedby');
		await expect(page.locator(`#${lockId}`)).toHaveText(m.splits_parent_locked());

		await editor.getByLabel(m.splits_part_amount_aria({ position: 1 })).fill(PART_ONE);
		await editor.getByLabel(m.splits_part_amount_aria({ position: 2 })).fill(PART_TWO);

		// Part 2 has no category yet: 1j-A leaves it empty on purpose.
		//
		// Opened through the row's own TRIGGER rather than by clicking the field: bits-ui's combobox
		// opens from the chevron, not from the input, and the page carries several of those triggers
		// at once — so the wrapper's `data-split-category` is what disambiguates. Found the same way
		// in the component spec, where clicking the input opened nothing.
		await editor
			.locator(
				`[data-split-category="2"] button[aria-label="${m.common_combobox_open_list_aria()}"]`
			)
			.click();
		await page.getByRole('option', { name: 'Transport' }).first().click();

		const save = editor.getByRole('button', { name: m.common_save() });
		await expect(save).not.toHaveAttribute('aria-disabled', 'true');

		// ---- the measurement, with something real to measure -----------------------------------
		const desktop = await measure(page);
		expect(desktop, 'the split editor was not found at 1280x800').not.toBeNull();
		console.log('SPLIT GEOMETRY 1280x800', JSON.stringify(desktop, null, 1));

		// The claim that matters, and the one the Période panel failed twice: the primary action is
		// ON SCREEN, not merely inside a panel that fits. Measured from the anchor against the fold.
		expect(
			desktop!.save.bottom,
			`« Enregistrer » sits below the fold at 1280x800: ${JSON.stringify(desktop!.save)}`
		).toBeLessThanOrEqual(desktop!.viewport.height);
		expect(desktop!.save.top).toBeGreaterThanOrEqual(0);

		await save.click();
		await expect(
			page.locator('aside').getByText(m.splits_success_saved({ count: 2 }))
		).toBeVisible();

		// ---- mobile: the same répartition, now as an existing one (1j-B) -----------------------
		await page.setViewportSize({ width: 390, height: 844 });
		await openDetail(page);
		const sheet = page.getByRole('dialog', { name: new RegExp(SPLIT_LABEL) });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByText(m.splits_section_heading_count({ count: 2 }))).toBeVisible();

		// Scroll the sheet's body to the bottom of the editor: the whole point of the sticky group
		// is that the remainder and the neutralised button stay in the same glance whatever the
		// number of parts, so the measurement has to be taken with the body actually scrolled.
		await sheet.getByLabel(m.splits_part_amount_aria({ position: 1 })).scrollIntoViewIfNeeded();

		const mobile = await measure(page);
		expect(mobile, 'the split editor was not found at 390x844').not.toBeNull();
		console.log('SPLIT GEOMETRY 390x844', JSON.stringify(mobile, null, 1));

		expect(
			mobile!.save.bottom,
			`« Enregistrer » sits below the fold at 390x844: ${JSON.stringify(mobile!.save)}`
		).toBeLessThanOrEqual(mobile!.viewport.height);
		expect(mobile!.save.top).toBeGreaterThanOrEqual(0);

		// THE RELATIONAL CHECK, which is the one a single figure cannot make: the sheet's regions
		// account for the whole panel with nothing unexplained between them. Measured 2026-08-07 at
		// 390x844 — panel 717.39 = handle 28 + header band 88.5 + body 600.89, to the pixel.
		//
		// The design's predicted body of 591 is neither confirmed nor refuted by this, and saying so
		// is the point: 591 was derived for a sheet of 809 with an 85 px header, and this sheet is
		// 717.39 with an 88.5 px header. It is 717.39 because the group is sticky INSIDE the body
		// rather than in `BottomSheet`'s footer (the divergence recorded in the editor), and 88.5
		// because this sheet's header lifts the date row and « Supprimer » alongside the label — a
		// decision that predates this work. A prediction for a different configuration is not a
		// figure this measurement can agree or disagree with.
		expect(
			mobile!.handle! + mobile!.headerBand! + mobile!.scroller!.height,
			`the sheet's regions do not account for its height: ${JSON.stringify(mobile)}`
		).toBeCloseTo(mobile!.panel!.height, 1);
		// « Le bandeau de reste ne bouge jamais. C'est la règle du pied de feuille étendue d'un
		// cran : ce qui commande l'action primaire voyage avec elle. »
		expect(mobile!.savePosition).toBe('sticky');

		// ---- the keyboard-open column (1k) ------------------------------------------------------
		//
		// EMULATED, and the limits of that are stated rather than glossed. Headless Chromium never
		// raises a keyboard, so the shrink is produced the way `BottomSheet.svelte.spec.ts` produces
		// it: override the REAL `visualViewport`'s height and dispatch its own resize event, so the
		// listener the sheet attached at mount reads the new value. That models the EVENT faithfully
		// and says nothing about iOS Safari (which also scrolls the page) or about Android Chrome
		// under `interactive-widget: resizes-content` — `BottomSheet`'s own comment records that a
		// real-device pass is outstanding work, and this does not discharge it.
		await sheet.getByLabel(m.splits_part_amount_aria({ position: 1 })).focus();
		await page.evaluate((height) => {
			Object.defineProperty(window.visualViewport!, 'height', {
				configurable: true,
				get: () => height
			});
			window.visualViewport!.dispatchEvent(new Event('resize'));
		}, KEYBOARD_OPEN_VIEWPORT);

		// Scrolled into view AFTER the shrink, deliberately. A real keyboard does two things: it
		// resizes the visual viewport AND the browser scrolls the focused element back into it. This
		// harness reproduces the first faithfully — it dispatches the real `visualViewport` resize the
		// sheet is listening to — and cannot reproduce the second, because there is no keyboard. So
		// the scroll is performed explicitly rather than left out and silently attributed to the app:
		// measuring the sticky group's position from a scroll offset that only exists because the
		// emulation is incomplete would be measuring the harness.
		await sheet
			.locator('form[action*="/saveSplits"]')
			.getByRole('button', { name: m.common_save() })
			.scrollIntoViewIfNeeded();

		const keyboard = await measure(page);
		expect(keyboard, 'the split editor was not found with the keyboard open').not.toBeNull();
		console.log('SPLIT GEOMETRY 390x544 (keyboard)', JSON.stringify(keyboard, null, 1));

		// « La feuille se recale sur le viewport visuel, elle n'est pas poussée hors écran. » The
		// sheet fills the reduced viewport exactly, and the primary action is inside it.
		expect(keyboard!.visualViewport!.height).toBe(KEYBOARD_OPEN_VIEWPORT);
		// « La feuille se recale sur le viewport visuel. » Exactly, not merely within it: measured
		// top 0, height 544 against a layout viewport still reporting 844.
		expect(keyboard!.panel!.top).toBe(0);
		expect(keyboard!.panel!.height).toBe(KEYBOARD_OPEN_VIEWPORT);
		expect(
			keyboard!.save.bottom,
			`« Enregistrer » is under the keyboard: ${JSON.stringify(keyboard!.save)}`
		).toBeLessThanOrEqual(KEYBOARD_OPEN_VIEWPORT);
		expect(keyboard!.save.top).toBeGreaterThanOrEqual(0);
		// Same relational check, on the shrunken column: 28 + 88.5 + 427.5 = 544, to the pixel.
		expect(
			keyboard!.handle! + keyboard!.headerBand! + keyboard!.scroller!.height,
			`the shrunken sheet's regions do not account for its height: ${JSON.stringify(keyboard)}`
		).toBeCloseTo(keyboard!.panel!.height, 1);

		// Put it back before the removal, so the last leg runs against the ordinary sheet.
		await page.evaluate(() => {
			Object.defineProperty(window.visualViewport!, 'height', {
				configurable: true,
				get: () => window.innerHeight
			});
			window.visualViewport!.dispatchEvent(new Event('resize'));
		});

		// ---- removal, which also restores the database for every spec after this one -----------
		// Scoped to the split form: this sheet holds FOUR « Enregistrer » buttons, one per editor,
		// which is the same fact that makes a sheet-level sticky footer the wrong home for this one.
		const sheetEditor = sheet.locator('form[action*="/saveSplits"]');
		await sheetEditor.getByRole('button', { name: m.splits_remove_action() }).click();
		await expect(sheet.getByText(m.splits_removal_pending({ count: 2 }))).toBeVisible();
		await sheetEditor.getByRole('button', { name: m.common_save() }).click();

		// Scoped to the SHEET, not `page....first()`. Both surfaces render this banner into the DOM
		// at once and the desktop one comes first, so `.first()` at 390 resolves to a `display:none`
		// element — the assertion then fails on visibility while the text is right there on screen.
		await expect(
			sheet.getByText(m.splits_success_removed({ category: 'Alimentation' }))
		).toBeVisible();
		// And the parent selector is live again, on the spot.
		await expect(sheet.getByLabel(m.transactions_manual_category_heading())).not.toHaveAttribute(
			'aria-disabled',
			'true'
		);
	});
});
