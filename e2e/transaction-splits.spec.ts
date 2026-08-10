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
/** Part 2 is the HEAVIER one, deliberately: it is the part that carries a category the parent does
 *  not have, so the list row's dominant category becomes « Transport » rather than the inherited
 *  one. That is what makes the indicator assertion below a statement about 1l's rule (« la cellule
 *  Catégorie d'une transaction répartie montre la part dominante ») instead of a coincidence — with
 *  the weights the other way round the cell would print the parent's category and still be right. */
const PART_ONE = '12,90';
const PART_TWO = '30,00';
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
			// THE OVERLAP, read as a relation rather than as a position. The band and the action row
			// are one foot; the question this answers is whether that foot is DRAWN OVER the rows it
			// is explaining, which no single element's box can say — CLAUDE.md's wrong-box entry, and
			// the reason the defect it replaces survived a spec that measured `save` alone.
			partRowsUnderFoot: (() => {
				const foot = save.parentElement?.parentElement ?? null;
				if (!foot) return null;
				const footTop = foot.getBoundingClientRect().top;
				return Array.from(form.querySelectorAll('[data-split-category]'))
					.map((wrapper) => wrapper.closest('div.grid') ?? wrapper)
					.filter((row) => row.getBoundingClientRect().bottom > footTop)
					.map((row) => ({
						position: (row.querySelector('[data-split-category]') as HTMLElement | null)?.dataset
							.splitCategory,
						rowBottom: +row.getBoundingClientRect().bottom.toFixed(2),
						footTop: +footTop.toFixed(2)
					}));
			})(),
			scroller: scrollerBox
				? {
						top: scrollerBox.top,
						bottom: scrollerBox.bottom,
						height: scrollerBox.height,
						scrollHeight: scroller!.scrollHeight
					}
				: null,
			// The foot's own computed position, logged rather than asserted since 2026-08-10: it is
			// `static` now, and the property that replaced it is `partRowsUnderFoot` above. Kept in
			// the payload because a future session reading these logs will want to know which of the
			// two eras a capture came from.
			footPosition: getComputedStyle(save.parentElement?.parentElement ?? save).position
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
		await page.goto('/transactions');
		// Captured BEFORE anything is split, so the assertion further down compares against what the
		// column really said rather than against a name retyped from the seed.
		const originalCategory = (
			await page
				.getByRole('row', { name: new RegExp(SPLIT_LABEL) })
				.first()
				.getByRole('cell')
				.nth(1)
				.innerText()
		)
			.split('\n')[0]
			.trim();
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

		// THE FOOT COVERS NOTHING. 1d asks for the band « hors de la zone défilante », and until
		// 2026-08-10 it was `position: sticky; bottom: 0` instead — which is a different property and
		// cannot be turned into that one by choosing a better offset. A bottom-sticky element is
		// painted at the scrollport's bottom edge while its containing block still extends below, so
		// it is drawn OVER whatever occupies that strip. Measured on this page before the fix: the
		// band's top edge at 1025 against part rows spanning 969→1150, hiding part 2 while the
		// heading above it announced two parts, and 688 against 714→903 at 390.
		//
		// The foot is now the third track of a grid whose middle track is the only thing that
		// scrolls, so this is zero by construction rather than at the scroll offsets that were
		// checked. It is asserted anyway, because "by construction" is what the sticky version was
		// believed to be too.
		expect(
			desktop!.partRowsUnderFoot,
			`the remainder band is drawn over part rows at 1280x800: ${JSON.stringify(desktop!.partRowsUnderFoot)}`
		).toEqual([]);

		// AND THE COST, ASSERTED RATHER THAN LEFT SILENT. The sticky foot dragged « Enregistrer »
		// into the viewport wherever the panel happened to sit; a foot that cannot overlap cannot do
		// that, so the button is reached by scrolling the panel — exactly as the three sibling forms
		// in this same panel already are. What survives, and what this pins, is the property 1d gives
		// the reason FOR: the band and the button it blocks are read in one glance. Ruled 2026-08-10
		// with both measurements in hand; the alternative was keeping a band that hides the rows it
		// asks the user to correct.
		//
		// An ABSENCE would age badly here (CLAUDE.md), so the condition travels with it: this is only
		// acceptable while the band sits immediately above the button. If they are ever separated,
		// the trade is off and the sticky question reopens.
		await save.scrollIntoViewIfNeeded();
		const reached = await measure(page);
		expect(
			reached!.save.bottom,
			`« Enregistrer » is unreachable at 1280x800 even after scrolling: ${JSON.stringify(reached!.save)}`
		).toBeLessThanOrEqual(reached!.viewport.height);
		expect(reached!.save.top).toBeGreaterThanOrEqual(0);
		expect(reached!.partRowsUnderFoot).toEqual([]);

		await save.click();
		await expect(
			page.locator('aside').getByText(m.splits_success_saved({ count: 2 }))
		).toBeVisible();

		// ---- the row indicator, in the real artifact (design 1l–1o) ---------------------------
		//
		// Every leg of the indicator is proven on its own elsewhere — the rule in
		// domain/allocation.spec.ts, the two badge forms in ui/SplitBadge.svelte.spec.ts, the DTO in
		// page.server.spec.ts, the markup in split-indicator-on-list.svelte.spec.ts — and not one of
		// them reads a real répartition out of a real database through the real load. Per-leg green
		// is the failure mode this repo has recorded more than once, so the combination gets its own
		// check in the artifact.
		await page.goto('/transactions');
		const listRow = page.getByRole('row', { name: new RegExp(SPLIT_LABEL) }).first();
		const categoryCell = listRow.getByRole('cell').nth(1);

		// The dominant part's category, which the parent does not carry.
		await expect(categoryCell).toContainText('Transport');
		// And the parent's own — a restoration value, never a display truth — is gone from the cell.
		expect(
			originalCategory,
			'the seeded row already sat on Transport, so this proves nothing'
		).not.toBe('Transport');
		await expect(categoryCell).not.toContainText(originalCategory);
		// « +1 »: ONE other category besides the dominant, not "two parts". The accessible name
		// carries the parts because the visual bubble is aria-hidden.
		await expect(
			categoryCell.getByRole('button', {
				name: new RegExp(m.splits_row_badge_others_short({ count: 2 }))
			})
		).toBeVisible();

		// ---- mobile: the same répartition, now as an existing one (1j-B) -----------------------
		await page.setViewportSize({ width: 390, height: 844 });
		await openDetail(page);
		const sheet = page.getByRole('dialog', { name: new RegExp(SPLIT_LABEL) });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByText(m.splits_section_heading_count({ count: 2 }))).toBeVisible();

		// Scroll the sheet's body to the FOOT of the editor: the whole point of the group is that the
		// remainder and the neutralised button stay in the same glance whatever the number of parts,
		// so the measurement has to be taken with the body actually scrolled.
		//
		// Aimed at Save rather than at part 1 since 2026-08-10. While the foot was `position: sticky`
		// it rode into view on its own from any offset, which is exactly the behaviour that drew it
		// over the part rows; now it is the third track of the editor's grid and is reached like any
		// other content. Scrolling to part 1 and then measuring Save would be measuring whether the
		// editor happens to be shorter than the sheet's body, which is a property of this fixture's
		// two parts and not of the layout.
		await sheet
			.locator('form[action*="/saveSplits"]')
			.getByRole('button', { name: m.common_save() })
			.scrollIntoViewIfNeeded();

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
		// 717.39 with an 88.5 px header. It is 717.39 because the group lives INSIDE the body rather
		// than in `BottomSheet`'s footer (the divergence recorded in the editor), and 88.5 because
		// this sheet's header lifts the date row and « Supprimer » alongside the label — a decision
		// that predates this work. A prediction for a different configuration is not a figure this
		// measurement can agree or disagree with.
		expect(
			mobile!.handle! + mobile!.headerBand! + mobile!.scroller!.height,
			`the sheet's regions do not account for its height: ${JSON.stringify(mobile)}`
		).toBeCloseTo(mobile!.panel!.height, 1);
		// « Le bandeau de reste ne bouge jamais. C'est la règle du pied de feuille étendue d'un
		// cran : ce qui commande l'action primaire voyage avec elle. » What pins that is no longer
		// `position: sticky` — see the 1280 block above for why, and for the cost. What is asserted
		// here is the half of the sentence the sticky version was breaking: the foot is not drawn
		// over the parts it explains, at the one width where it hid BOTH of them.
		expect(
			mobile!.partRowsUnderFoot,
			`the remainder band is drawn over part rows at 390x844: ${JSON.stringify(mobile!.partRowsUnderFoot)}`
		).toEqual([]);

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
		expect(
			keyboard!.partRowsUnderFoot,
			`the remainder band is drawn over part rows with the keyboard open: ${JSON.stringify(keyboard!.partRowsUnderFoot)}`
		).toEqual([]);
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

	/**
	 * PR5, in the real artifact: a category filter narrowing onto the NON-dominant part, on both
	 * breakpoints and through the CSV export. Every leg is proven in isolation elsewhere —
	 * `pickMatchedAllocation` in totals.spec.ts, the row's data shape in page.server.spec.ts, the
	 * CSV truncation refusal in round-trip.spec.ts — and none of them reads a real filtered page
	 * through the real load, with the real summary band and the real export route beside it. Same
	 * reasoning as the test above: the combination gets its own check.
	 *
	 * Restores the database exactly like the test above, and for the same reason.
	 */
	test('a category filter shows the MATCHED part, not the dominant one, on both breakpoints and in the export', async ({
		page
	}) => {
		test.slow();

		await page.setViewportSize({ width: 1280, height: 800 });
		await openDetail(page);
		// The click in `openDetail` is a client-side navigation (a plain `<a>`, intercepted by
		// SvelteKit's router): the URL updates once that navigation resolves, not the instant the
		// click event dispatches, so reading it immediately races.
		await page.waitForURL(/[?&]selected=/);
		await removeAnyExistingSplit(page);

		// The suite shares one database across ~35 files, so by the time this test runs other specs
		// may have created their own Alimentation-categorised rows. `?ids=` scopes every check below
		// to THIS transaction alone (intersected with the category filter, never replacing it — see
		// scope.ts), so the test proves the feature rather than a fixture-population accident.
		const txId = new URL(page.url()).searchParams.get('selected');
		expect(txId, 'openDetail did not select a transaction').toBeTruthy();
		const scopedTo = (query: string) => `/transactions?ids=${txId}&${query}`;

		await page.getByRole('button', { name: m.splits_entry_action() }).first().click();
		const editor = page.locator('form[action*="/saveSplits"]').first();
		await expect(editor).toBeVisible();

		// Part 1 keeps the inherited category (Alimentation, the parent's own — 12,90 €, the
		// SMALLER, non-dominant part). Part 2 is filed under Transport (30,00 €, the dominant one).
		await editor.getByLabel(m.splits_part_amount_aria({ position: 1 })).fill(PART_ONE);
		await editor.getByLabel(m.splits_part_amount_aria({ position: 2 })).fill(PART_TWO);
		await editor
			.locator(
				`[data-split-category="2"] button[aria-label="${m.common_combobox_open_list_aria()}"]`
			)
			.click();
		await page.getByRole('option', { name: 'Transport' }).first().click();
		await editor.getByRole('button', { name: m.common_save() }).click();
		await expect(
			page.locator('aside').getByText(m.splits_success_saved({ count: 2 }))
		).toBeVisible();

		const row = () => page.getByRole('row', { name: new RegExp(SPLIT_LABEL) }).first();
		const categoryCell = () => row().getByRole('cell').nth(1);
		const amountCell = () => row().getByRole('cell').nth(3);

		// ---- 1280, plain column set: row height must not move between the two states -----------
		await page.goto(scopedTo(''));
		const heightUnfiltered = (await row().boundingBox())!.height;

		await page.goto(scopedTo('category=Alimentation'));
		// The MATCHED category, not the dominant Transport — decision B.
		await expect(categoryCell()).toContainText('Alimentation');
		await expect(categoryCell()).not.toContainText('Transport');
		// The MATCHED amount as the primary figure, with the parent total on a second line —
		// decision A. Both read off the same cell rather than the whole page, so a stray "12,90"
		// or "42,90" elsewhere cannot make this pass by accident.
		await expect(amountCell()).toContainText('12,90');
		await expect(amountCell()).not.toContainText('30,00');
		await expect(amountCell()).toContainText(m.transactions_row_matched_of({ amount: '-42,90 €' }));
		// The band: 12,90 €, not the row's own 42,90 € and not the dominant part's 30,00 € — exact
		// because `ids=` scopes the whole page to this one transaction, so nothing else contributes.
		const summaryBand = page.getByTestId('summary-band');
		await expect(summaryBand).toContainText(`${m.transactions_totals_expense_label()} -12,90 €`);
		await expect(summaryBand).not.toContainText('42,90');
		await expect(summaryBand).not.toContainText('30,00');

		const heightFilteredPlain = (await row().boundingBox())!.height;
		expect(
			heightFilteredPlain,
			`row height moved when the secondary "sur" line appeared: ${heightUnfiltered} -> ${heightFilteredPlain}`
		).toBeCloseTo(heightUnfiltered, 0);

		// ---- 1280, panel-open column set (1fr/140/190/110) --------------------------------------
		await page.goto(scopedTo(''));
		await row().getByRole('link').first().click();
		const heightUnfilteredPanelOpen = (await row().boundingBox())!.height;

		await page.goto(scopedTo('category=Alimentation'));
		await row().getByRole('link').first().click();
		const heightFilteredPanelOpen = (await row().boundingBox())!.height;
		expect(
			heightFilteredPanelOpen,
			`row height moved in the panel-open column set: ${heightUnfilteredPanelOpen} -> ${heightFilteredPanelOpen}`
		).toBeCloseTo(heightUnfilteredPanelOpen, 0);

		// ---- the CSV export reads exactly what the row does --------------------------------------
		const csv = await (
			await page.request.get(`/transactions/export?ids=${txId}&category=Alimentation`)
		).text();
		const line = csv.split('\r\n').find((entry) => entry.includes(SPLIT_LABEL));
		expect(line, 'no CSV line for the filtered row').toBeTruthy();
		const cells = (line as string).split(';');
		expect(cells[2]).toBe('Alimentation');
		// `1/2`: the TRUE position and the TRUE count, never `1/1` — a filtered export states a
		// répartition is incomplete rather than claiming a smaller, complete one.
		expect(cells[8]).toBe('1/2');

		// ---- 390: the mobile card tells the same story -------------------------------------------
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(scopedTo(''));
		const mobileRow = () => page.locator('[id^="tx-row-"]').filter({ hasText: SPLIT_LABEL });
		const heightMobileUnfiltered = (await mobileRow().boundingBox())!.height;

		await page.goto(scopedTo('category=Alimentation'));
		await expect(mobileRow()).toContainText('Alimentation');
		await expect(mobileRow()).not.toContainText('Transport');
		await expect(mobileRow()).toContainText('12,90');
		await expect(mobileRow()).toContainText(m.transactions_row_matched_of({ amount: '-42,90 €' }));
		const heightMobileFiltered = (await mobileRow().boundingBox())!.height;
		expect(
			heightMobileFiltered,
			`mobile row height moved: ${heightMobileUnfiltered} -> ${heightMobileFiltered}`
		).toBeCloseTo(heightMobileUnfiltered, 0);

		// ---- restore the database for every spec after this one -----------------------------------
		await openDetail(page);
		await removeAnyExistingSplit(page);
	});
});
