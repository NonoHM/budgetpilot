import { expect, test } from './fixtures';
import {
	BULK_FROM,
	BULK_PRETAGGED_LABEL,
	BULK_TAG_NAME,
	BULK_TO,
	BULK_UNTAGGED_LABELS,
	FILTER_TAG_NAME,
	FILTER_TAGGED_LABELS,
	FILTER_UNTAGGED_LABELS,
	GC_LABEL,
	REFLOW_EXISTING_TAG,
	REFLOW_LABEL,
	ROUNDTRIP_LABEL,
	seedTagFixture,
	withOtherUserPage
} from './tags-seed';
import { contrastRatio } from './color-contrast';
import { TAG_COLORS } from '../src/lib/domain/colors';
import * as m from '../src/lib/paraglide/messages';
import type { Locator, Page } from '@playwright/test';

// End-to-end verification of the "transverse tags" feature (PR 8 of the tags chantier), rendered
// by a real browser against a real database. Every prior PR shipped its own unit/component
// coverage; none of that loads a stylesheet, drives bits-ui's real Combobox/keyboard handling, or
// proves that a second account never sees this account's tags. Each test below exists because one
// of those three is exactly what decides whether the claim holds — same rule
// e2e/upcoming-bills.spec.ts states at its own header.
//
// Ordering matters and is declaration order (workers: 1, playwright.config.ts): the recolour test
// at the bottom deliberately reassigns two fixture tags' colours, which would corrupt any earlier
// assertion that cared what colour they started with (none do).
//
// The desktop viewport (Playwright's default, 1280x720) is used throughout. /transactions mounts
// BOTH the desktop table/aside AND the mobile ListCard/BottomSheet markup at once (`lg:hidden` /
// `hidden lg:...` toggle visibility, not presence — same shape the CLAUDE.md backlog already notes
// for /reports and /upcoming-bills), and the tag filter Combobox and TagPicker each exist once per
// breakpoint with an IDENTICAL accessible name. Every locator below is therefore scoped to a
// desktop-only container rather than trusting `getByLabel`/`getByRole` alone, or it targets the
// one element that genuinely exists once (the `<table>`, the `<aside>`).

test.beforeAll(async () => {
	await seedTagFixture();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The one `<table>` on the page (desktop only; the mobile list uses ListCard divs instead). */
function transactionRow(page: Page, label: string): Locator {
	return page.locator('table tbody tr').filter({ hasText: label });
}

/** The desktop detail panel. The mobile BottomSheet mounts the identical
 *  TransactionTagsEditor/TagPicker pair whenever a transaction is selected, regardless of
 *  viewport (only CSS hides it), so every query inside a selected transaction's UI must go
 *  through this scope or it is ambiguous. */
function desktopPanel(page: Page): Locator {
	return page.locator('aside');
}

/** The "Étiquettes" group: a `<fieldset>` named by its own `<legend>{m.tags_heading()}</legend>`
 *  (design: "Section fieldset avec légende « Étiquettes »"), which exposes an implicit ARIA
 *  role="group" named from the legend — not a `<section>`/heading pair. */
function tagsSectionOf(scope: Locator): Locator {
	return scope.getByRole('group', { name: m.tags_heading() });
}

/** The desktop secondary-filters bar (`div.hidden.lg:block`, +page.svelte:778). The mobile sheet
 *  duplicates every control inside it under the SAME aria-label/text, so every filter/bulk-tag
 *  interaction below goes through this scope. */
function desktopFilterBar(page: Page): Locator {
	return page.locator('div.hidden.lg\\:block');
}

/** The Settings "Étiquettes" section: the whole card below the h2 with that heading. */
function settingsTagsSection(page: Page): Locator {
	return page
		.getByRole('heading', { name: m.tags_settings_heading(), level: 2 })
		.locator('xpath=..');
}

function settingsTagRow(page: Page, tagName: string): Locator {
	return settingsTagsSection(page)
		.locator('li')
		.filter({ hasText: tagName })
		.filter({ has: page.getByRole('radiogroup') });
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Types a not-yet-existing name into a scoped TagPicker and picks the resulting "create" row —
 *  the same interaction a user performs to tag a transaction for the first time, or to add a tag
 *  that already exists elsewhere on the account (TagPicker resolves either through the same
 *  create-or-select row; see ui/TagPicker.svelte's own comment).
 *
 * Ends where a user ends, with nothing clicked to tidy up afterwards. That last part is what this
 * helper used to hide: it clicked the section <legend> to dismiss the panel first, with a comment
 * explaining that otherwise "clicking Save next would land the mouse-up on whatever the dropdown's
 * closing reflow shifted underneath it". The defect was real, was understood, and was worked around
 * here instead of being fixed, so the suite stayed green while the first click on Save silently did
 * nothing for every real user. TagPicker now closes on click rather than pointer-down, so no
 * dismissal step is needed and a regression fails here instead of being absorbed. Do not add one
 * back. Note this path always CREATES the tag, which closes the panel as a side effect; the guard
 * test above covers the case where the panel is still open when Save is clicked. */
async function pickOrCreateTag(page: Page, section: Locator, tagName: string): Promise<void> {
	const input = section.getByRole('combobox', { name: m.tags_heading() });
	await input.click();
	await input.pressSequentially(tagName, { delay: 20 });
	const option = page.getByRole('option', { name: new RegExp(escapeRegExp(tagName)) });
	await expect(option).toBeVisible();
	await option.click();
}

/** Opens a transaction's detail panel by filtering the list down to its (unique) label first, so
 *  the target row is guaranteed to be on page 1 regardless of how many other fixtures exist. */
async function openTransactionByLabel(page: Page, label: string): Promise<void> {
	await page.goto(`/transactions?q=${encodeURIComponent(label)}`);
	await transactionRow(page, label).getByRole('link', { name: label, exact: true }).click();
}

// ─── 1. Full assignment round trip ─────────────────────────────────────────

test.describe('assignment round trip', () => {
	test('tagging a transaction from the detail panel puts a chip on its row, and the chip survives a reload', async ({
		page
	}) => {
		const tagName = 'Voyage Roundtrip E2E';

		await openTransactionByLabel(page, ROUNDTRIP_LABEL);
		const section = tagsSectionOf(desktopPanel(page));
		await pickOrCreateTag(page, section, tagName);
		await section.getByRole('button', { name: m.common_save() }).click();

		// The Save form has no `use:enhance` (structurally identical to the category/nature
		// sections beside it, both plain POSTs), so the click is a real navigation. Re-navigate
		// explicitly rather than trust wherever it landed, so the assertion below is independent
		// of that navigation's exact destination.
		await page.goto(`/transactions?q=${encodeURIComponent(ROUNDTRIP_LABEL)}`);
		await expect(transactionRow(page, ROUNDTRIP_LABEL).getByText(tagName)).toBeVisible();

		await page.reload();
		await expect(transactionRow(page, ROUNDTRIP_LABEL).getByText(tagName)).toBeVisible();
	});

	test('the open picker panel moves nothing below it, and one click on Save is enough', async ({
		page
	}) => {
		await openTransactionByLabel(page, REFLOW_LABEL);
		const section = tagsSectionOf(desktopPanel(page));
		const save = section.getByRole('button', { name: m.common_save() });
		const input = section.getByRole('combobox', { name: m.tags_heading() });

		// Both halves in ONE test: the geometry is the cause, the single-click save is the
		// consequence, and separated they can go green one at a time while the user-visible bug is
		// back. An in-flow panel pushed Save down; closing it — which happens on focusout, i.e. on
		// the mouse-down of the very click being made on Save — pulled it back up (measured: 114px,
		// against a button 32px tall), the mouse-up landed on whatever had slid underneath, and the
		// first click on Save did nothing at all.
		// Document coordinates, not boundingBox(): clicking the field scrolls it into view, and a
		// viewport-relative measurement would report that scroll as a layout shift (it read 1122 then
		// 390 on the first attempt, with the panel entirely innocent).
		// Both scroll offsets, not just the window's. The panel is now a `position: sticky` box with
		// its own `overflow-y: auto` (so six sections stay reachable past the fold), and clicking the
		// field scrolls it into view INSIDE that box — which moves `rect.top` while `window.scrollY`
		// stays at 0. Compensating for only one of the two reported a 341px layout shift against a
		// panel that had not moved at all.
		const documentY = (target: Locator) =>
			target.evaluate((el) => {
				const sticky = el.closest('[data-testid="detail-sticky"]');
				return el.getBoundingClientRect().top + window.scrollY + (sticky?.scrollTop ?? 0);
			});

		const before = await documentY(save);
		await input.click();
		await expect(page.locator('[role="listbox"]')).toHaveCount(1);
		// Exact, not a tolerance: a detached panel takes no layout space, so the only correct shift
		// is zero.
		expect(await documentY(save)).toBe(before);

		// An EXISTING tag rather than a created one, so this also covers the select path (the create
		// path is what every other test here exercises through pickOrCreateTag).
		await input.pressSequentially(REFLOW_EXISTING_TAG, { delay: 20 });
		await page.getByRole('option', { name: REFLOW_EXISTING_TAG, exact: true }).click();
		// Asserted explicitly: without it, a failure at the end cannot be told apart from the
		// selection never having happened, and an undirty Save legitimately swallows its own click.
		await expect(
			section.getByRole('button', { name: m.tags_remove_aria({ name: REFLOW_EXISTING_TAG }) })
		).toBeVisible();

		// ONE click. The persisted chip is what proves it landed — a `.click()` that hits nothing
		// throws no error.
		await save.click();

		await page.goto(`/transactions?q=${encodeURIComponent(REFLOW_LABEL)}`);
		await expect(transactionRow(page, REFLOW_LABEL).getByText(REFLOW_EXISTING_TAG)).toBeVisible();
	});

	test('picker option rows are 36px from sm up and 48px on mobile, as the design sizes them', async ({
		page
	}) => {
		// Measured as rendered, at both breakpoints, because the figures are only reachable that way:
		// the rows carry no explicit height in the markup a reader could check, and left to padding
		// plus line-height they came out 32px at BOTH widths — below the 44px minimum the design sets
		// for every mobile target. A unit test cannot see this at all, since it loads no stylesheet.
		const optionHeight = async (): Promise<number> => {
			const first = page.getByRole('option').first();
			await expect(first).toBeVisible();
			return first.evaluate((el) => el.getBoundingClientRect().height);
		};

		await page.setViewportSize({ width: 1280, height: 800 });
		await openTransactionByLabel(page, ROUNDTRIP_LABEL);
		await tagsSectionOf(desktopPanel(page))
			.getByRole('combobox', { name: m.tags_heading() })
			.click();
		expect(await optionHeight()).toBe(36);

		// The selection lives in the URL, which is the only way to reach this row at 390px: the
		// <table> openTransactionByLabel clicks through is desktop-only markup and is not rendered
		// there at all. Reloading the same URL narrow opens the mobile sheet on the same transaction.
		const selectedUrl = page.url();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(selectedUrl);

		// The mobile sheet (BottomSheet's role="dialog") mounts its own picker; scoping to the desktop
		// <aside> would keep measuring the copy `lg:` has hidden, and report 36 forever.
		await tagsSectionOf(page.getByRole('dialog'))
			.getByRole('combobox', { name: m.tags_heading() })
			.click();
		expect(await optionHeight()).toBe(48);
	});
});

// ─── 2. Filter narrows the list, absent with no tags ───────────────────────

test.describe('tag filter', () => {
	test('selecting a tag in the filter bar narrows the list to exactly the tagged rows', async ({
		page
	}) => {
		await page.goto('/transactions');

		// The tag dimension is a FilterDropdown now, not a Combobox inside the GET form: its trigger
		// is named after the DIMENSION at rest ("Étiquette"), and picking an option navigates on the
		// spot, so there is no "Filtrer" to submit afterwards.
		const bar = desktopFilterBar(page);
		await bar.getByRole('button', { name: m.tags_filter_dimension(), exact: true }).click();
		await page.getByRole('option', { name: new RegExp(escapeRegExp(FILTER_TAG_NAME)) }).click();

		for (const label of FILTER_TAGGED_LABELS) {
			await expect(transactionRow(page, label)).toHaveCount(1);
		}
		for (const label of FILTER_UNTAGGED_LABELS) {
			await expect(transactionRow(page, label)).toHaveCount(0);
		}
		// Not just "the tagged rows are present": the SET is exactly them, nothing wider.
		await expect(page.locator('table tbody tr')).toHaveCount(FILTER_TAGGED_LABELS.length);
	});

	test('the filter control is entirely absent for a user who owns no tags', async ({ browser }) => {
		await withOtherUserPage(browser, async (otherPage) => {
			await otherPage.goto('/transactions');

			// By the DIMENSION name, which is what the trigger is called at rest. Asserting the old
			// Combobox's aria-label would now be a query for an element that exists nowhere on the
			// page for any user, and would pass whether or not the control was correctly withheld.
			await expect(
				otherPage.getByRole('button', { name: m.tags_filter_dimension(), exact: true })
			).toHaveCount(0);
			// The CATEGORY dimension, in the same bar, IS there. Without this half the test passes on
			// any page that failed to render a filter bar at all — including a 500 — and would call
			// that "correctly withheld".
			await expect(
				desktopFilterBar(otherPage).getByRole('button', {
					name: m.transactions_filter_dimension_category(),
					exact: true
				})
			).toHaveCount(1);
		});
	});
});

// ─── 3. Auto-GC ─────────────────────────────────────────────────────────────

test.describe('automatic tag cleanup', () => {
	test('untagging the last transaction deletes the tag silently, with no confirmation, and retyping the name recreates it cleanly', async ({
		page
	}) => {
		const tagName = 'GC Test E2E';

		// 1) Tag the dedicated fixture row and confirm the tag now exists everywhere it should.
		await openTransactionByLabel(page, GC_LABEL);
		await pickOrCreateTag(page, tagsSectionOf(desktopPanel(page)), tagName);
		await tagsSectionOf(desktopPanel(page)).getByRole('button', { name: m.common_save() }).click();

		await page.goto(`/transactions?q=${encodeURIComponent(GC_LABEL)}`);
		await expect(transactionRow(page, GC_LABEL).getByText(tagName)).toBeVisible();
		await page.goto('/settings');
		await expect(settingsTagRow(page, tagName)).toHaveCount(1);

		// 2) Remove the only tag from the only transaction that carries it.
		await openTransactionByLabel(page, GC_LABEL);
		const section = tagsSectionOf(desktopPanel(page));
		await section.getByRole('button', { name: m.tags_remove_aria({ name: tagName }) }).click();
		// No confirmation of any kind before the removal takes effect — unlike the explicit
		// "Delete tag" flow in Settings, which does open a ConfirmDialog.
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await section.getByRole('button', { name: m.common_save() }).click();

		// 3) The tag is gone from every surface: the row, the picker's own option list, and
		// Settings. No message anywhere announces it.
		await page.goto(`/transactions?q=${encodeURIComponent(GC_LABEL)}`);
		await expect(transactionRow(page, GC_LABEL).getByText(tagName)).toHaveCount(0);
		await page.goto('/settings');
		await expect(settingsTagRow(page, tagName)).toHaveCount(0);
		await expect(page.getByText(m.tags_success_deleted())).toHaveCount(0);

		// 4) Retyping the exact same name is a clean create, not a collision with a remnant.
		await openTransactionByLabel(page, GC_LABEL);
		const secondSection = tagsSectionOf(desktopPanel(page));
		await pickOrCreateTag(page, secondSection, tagName);
		await secondSection.getByRole('button', { name: m.common_save() }).click();

		await page.goto(`/transactions?q=${encodeURIComponent(GC_LABEL)}`);
		await expect(transactionRow(page, GC_LABEL).getByText(tagName)).toBeVisible();
		await page.goto('/settings');
		await expect(settingsTagRow(page, tagName)).toHaveCount(1);
	});
});

// ─── 4. Bulk apply and undo ─────────────────────────────────────────────────

test.describe('bulk apply and undo', () => {
	test('applying a tag to a filtered set tags exactly the matched rows, the banner reports the applied count, it never auto-dismisses, and undo removes exactly what it added', async ({
		page
	}) => {
		await page.goto('/transactions');
		const bar = desktopFilterBar(page);
		await page.locator('#tx-from').fill(BULK_FROM);
		await page.locator('#tx-to').fill(BULK_TO);
		await bar.getByRole('button', { name: m.transactions_submit_filter() }).click();

		// Precondition: exactly the 3 fixture rows are in view, one already carrying the tag.
		for (const label of [BULK_PRETAGGED_LABEL, ...BULK_UNTAGGED_LABELS]) {
			await expect(transactionRow(page, label)).toHaveCount(1);
		}
		await expect(transactionRow(page, BULK_PRETAGGED_LABEL).getByText(BULK_TAG_NAME)).toBeVisible();
		for (const label of BULK_UNTAGGED_LABELS) {
			await expect(transactionRow(page, label).getByText(BULK_TAG_NAME)).toHaveCount(0);
		}

		// The trigger writes its own scope, so its accessible name carries the filtered count — the
		// 3 fixture rows asserted just above. Matching the exact string rather than a stem is the
		// point: it proves the count on the button is the count of the set, against real server data
		// rather than a fixture's `pagination.totalTransactions`.
		// The trigger descended into the SUMMARY ROW, against the wall of the number defining its
		// scope; it is no longer inside the filter card. Scoped to the desktop grid, since the mobile
		// summary row renders the identical control at the same time.
		await page
			.locator('div.hidden.lg\\:grid')
			.getByRole('button', { name: m.tags_bulk_cta_many({ count: 3 }) })
			.click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		// The title text renders twice inside the dialog (Modal's own sr-only/aria-labelledby h2
		// PLUS ConfirmDialog's own visible mobile-header duplicate, ConfirmDialog.svelte:42) —
		// same shape as the desktop/mobile duplication noted elsewhere in this suite, so `.first()`
		// is intentional here, not a weakened assertion: both copies carry the identical string.
		await expect(dialog.getByText(m.tags_bulk_confirm_title({ count: 3 })).first()).toBeVisible();
		await dialog.getByLabel(m.tags_bulk_name_label()).fill(BULK_TAG_NAME);
		await dialog.getByRole('button', { name: m.tags_bulk_confirm_cta() }).click();

		// Applied count is 2, not 3: the pre-tagged row was already linked, so the action must
		// report only what it NEWLY did.
		const appliedBanner = page
			.getByRole('status')
			.filter({ hasText: m.tags_bulk_banner_applied({ count: 2, tag: BULK_TAG_NAME }) });
		await expect(appliedBanner).toBeVisible();

		for (const label of [BULK_PRETAGGED_LABEL, ...BULK_UNTAGGED_LABELS]) {
			await expect(transactionRow(page, label).getByText(BULK_TAG_NAME)).toBeVisible();
		}

		// The banner does NOT auto-dismiss: every other success banner on this page defaults to
		// 6s (AlertBanner.svelte's own `autoDismissMs = 6000`), and this one overrides it to
		// Infinity specifically because the undo it carries must stay reachable.
		await page.waitForTimeout(6500);
		await expect(appliedBanner).toBeVisible();

		await appliedBanner.getByRole('button', { name: m.tags_bulk_banner_undo() }).click();
		await expect(
			page.getByRole('status').filter({ hasText: m.tags_bulk_banner_undone() })
		).toBeVisible();

		// Exactly the two rows this action newly linked lost the tag; the row tagged some other
		// day (before this action ran) survives the undo untouched.
		await expect(transactionRow(page, BULK_PRETAGGED_LABEL).getByText(BULK_TAG_NAME)).toBeVisible();
		for (const label of BULK_UNTAGGED_LABELS) {
			await expect(transactionRow(page, label).getByText(BULK_TAG_NAME)).toHaveCount(0);
		}
	});
});

// ─── 5. Rendered contrast: lagoon and azure, the two locked tokens ─────────

test.describe('rendered contrast — locked tokens', () => {
	/** Resolves any computed colour property of a REAL element to sRGB bytes by painting it.
	 *  Tailwind v4 emits oklch(), which getComputedStyle hands back unchanged in Chromium, so
	 *  comparing that string to a hex literal would prove nothing about what the browser paints.
	 *  Same technique as paintedColors/paintTailwind in e2e/upcoming-bills.spec.ts. */
	async function paintedColor(
		locator: Locator,
		property: 'color' | 'backgroundColor'
	): Promise<[number, number, number]> {
		return locator.evaluate((element, prop) => {
			const canvas = document.createElement('canvas');
			canvas.width = 1;
			canvas.height = 1;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('no 2d context');
			context.fillStyle = getComputedStyle(element)[prop as 'color' | 'backgroundColor'];
			context.fillRect(0, 0, 1, 1);
			const data = context.getImageData(0, 0, 1, 1).data;
			return [data[0], data[1], data[2]] as [number, number, number];
		}, property);
	}

	function hexToRgb(hex: string): [number, number, number] {
		return [
			parseInt(hex.slice(1, 3), 16),
			parseInt(hex.slice(3, 5), 16),
			parseInt(hex.slice(5, 7), 16)
		];
	}

	test('the dot Tailwind class for lagoon and azure genuinely resolves to the locked hex, as painted in the real Settings chip', async ({
		page
	}) => {
		// Recolours two already-seeded fixture tags. Safe only because this is the LAST test in
		// the file (declaration order, workers: 1): every earlier assertion about these two tags
		// has already run and none of them cared what colour was assigned.
		await page.goto('/settings');
		await settingsTagRow(page, FILTER_TAG_NAME).getByRole('radio', { name: 'Lagoon' }).click();
		await expect(
			settingsTagRow(page, FILTER_TAG_NAME).getByRole('radio', { name: 'Lagoon' })
		).toHaveAttribute('aria-checked', 'true');
		await settingsTagRow(page, BULK_TAG_NAME).getByRole('radio', { name: 'Azure' }).click();
		await expect(
			settingsTagRow(page, BULK_TAG_NAME).getByRole('radio', { name: 'Azure' })
		).toHaveAttribute('aria-checked', 'true');

		for (const [tagName, expectedHex] of [
			[FILTER_TAG_NAME, TAG_COLORS.lagoon],
			[BULK_TAG_NAME, TAG_COLORS.azure]
		] as const) {
			const dot = settingsTagRow(page, tagName).locator('span[aria-hidden="true"].rounded-full');
			await expect(dot).toBeVisible();
			expect(await paintedColor(dot, 'backgroundColor')).toEqual(hexToRgb(expectedHex));
		}
	});

	/**
	 * The measured figures from domain/tags.spec.ts (lagoon 4.71:1, azure 4.81:1) describe the dot
	 * colour written as TEXT on the tag's own tinted surface. That unit test computes the ratio from
	 * two hex constants, so it cannot tell a correct palette from a Tailwind class that never
	 * reached the compiled build, nor from a component that binds the wrong one.
	 *
	 * This measures the pairing where it actually renders: the active tag filter on /transactions,
	 * one of the exactly two surfaces the design permits a tint on. Both halves come off the SAME
	 * element pair the user sees, read back through a canvas because Tailwind v4 emits oklch() and
	 * getComputedStyle hands that string back unchanged.
	 */
	test('lagoon (4.71:1) and azure (4.81:1) clear the design-measured ratio as the active filter chip actually paints them', async ({
		page
	}) => {
		const cases = [
			{ tagName: FILTER_TAG_NAME, swatch: 'Lagoon', measured: 4.71 },
			{ tagName: BULK_TAG_NAME, swatch: 'Azure', measured: 4.81 }
		] as const;

		for (const { tagName, swatch, measured } of cases) {
			// Pin the tag to the locked token first: the fixture's colour is assigned by a hash of its
			// name, so nothing guarantees it lands on the two tokens whose margin is thinnest.
			await page.goto('/settings');
			await settingsTagRow(page, tagName).getByRole('radio', { name: swatch }).click();
			await expect(
				settingsTagRow(page, tagName).getByRole('radio', { name: swatch })
			).toHaveAttribute('aria-checked', 'true');

			// The active filter renders the tinted chip: name in the token's hue, on its tint.
			const tagId = await settingsTagRow(page, tagName)
				.locator('input[name="id"]')
				.getAttribute('value');
			await page.goto(`/transactions?tag=${tagId}`);

			const chip = desktopFilterBar(page).getByText(tagName, { exact: true });
			await expect(chip).toBeVisible();

			// The TINTED WRAPPER, not the immediate parent. The trigger is now a <button> inside a
			// tinted <div>, and the button itself paints nothing — measuring `xpath=..` read
			// 1.19:1 against a transparent background while the rendering was fine. This is the same
			// wrong-element trap #103 recorded (4.91 measured where 4.71 was expected): find the
			// nearest ancestor that actually has a background, the way the eye does.
			const nameRgb = await paintedColor(chip, 'color');
			const surface = chip.locator(
				'xpath=ancestor::*[contains(@class,"rounded-xl") and contains(@class,"border")][1]'
			);
			const surfaceRgb = await paintedColor(surface, 'backgroundColor');
			const ratio = contrastRatio(nameRgb, surfaceRgb);

			expect(ratio).toBeGreaterThanOrEqual(4.5);
			// The MEASURED figure, not the 4.5 threshold. Lightening a locked tint RAISES the ratio, so
			// a threshold alone passes the exact change the lock forbids; only the measured value
			// catches drift in both directions.
			expect(ratio).toBeCloseTo(measured, 1);
		}
	});
});

// ─── 6. Escape layering, and the panel on demand ────────────────────────────

test.describe('the detail panel on demand', () => {
	/**
	 * Amendment 5. Two overlays are stacked when a TagPicker is open inside the detail panel, and
	 * Escape has to unwind them one at a time. This is unprovable anywhere but here: the layering is
	 * produced by real DOM event propagation (TagPicker calls stopPropagation while its list is
	 * open, the panel's own handler sits on the <aside>), and a component test that dispatches a
	 * synthetic key on one element observes neither half.
	 */
	test('the first Escape closes only the tag list, the second closes the panel', async ({
		page
	}) => {
		await openTransactionByLabel(page, GC_LABEL);

		const panel = desktopPanel(page);
		await expect(panel).toBeVisible();

		const input = tagsSectionOf(panel).getByRole('combobox', { name: m.tags_heading() });
		await input.click();
		await expect(page.getByRole('listbox')).toBeVisible();

		await page.keyboard.press('Escape');
		// The list is gone AND the panel is still here. Asserting only the first half would pass
		// against a single Escape that closed both at once, which is the defect being guarded.
		await expect(page.getByRole('listbox')).toHaveCount(0);
		await expect(panel).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);
		// Closing is a navigation, so it survives a reload: a local `open = false` would not.
		expect(new URL(page.url()).searchParams.has('selected')).toBe(false);
	});

	/**
	 * Nothing occupies the place of nothing, and the table takes the width back. Measured, because
	 * the whole claim of the reflow is a pair of figures: a component test can assert the class, a
	 * browser is what says whether `table-layout: auto` honoured it.
	 */
	test('the table widens when no row is selected and narrows for the panel, with the row staying put', async ({
		page
	}) => {
		await page.goto(`/transactions?q=${encodeURIComponent(GC_LABEL)}`);

		const tagsCells = page.locator('[data-testid="tags-cell"]');
		// On the unscoped locator, so this really says "one row matched". `.first()` always has a
		// count of 1, whatever the page contains, which would make the assertion unfailable.
		await expect(tagsCells).toHaveCount(1);
		const tagsCell = tagsCells.first();
		expect(Math.round((await tagsCell.boundingBox())!.width)).toBe(240);
		expect(await desktopPanel(page).count()).toBe(0);

		const row = transactionRow(page, GC_LABEL);
		const yBefore = Math.round((await row.boundingBox())!.y);

		await row.getByRole('link', { name: GC_LABEL, exact: true }).click();
		await expect(desktopPanel(page)).toBeVisible();
		expect(Math.round((await tagsCell.boundingBox())!.width)).toBe(190);
		// The narrowing is strictly HORIZONTAL: the row the user aimed at stays on its own line, at
		// its exact ordinate. This is the half no unit fixture can see, and the half a user notices.
		expect(Math.round((await row.boundingBox())!.y)).toBe(yBefore);
	});

	/**
	 * Amendment 3. The panel holds six sections and exceeds the viewport with them open;
	 * `position: sticky` alone pins its top edge and leaves everything past the fold unreachable.
	 */
	test('a panel taller than the viewport scrolls within itself instead of being clipped', async ({
		page
	}) => {
		await openTransactionByLabel(page, GC_LABEL);
		const sticky = page.locator('[data-testid="detail-sticky"]');
		await expect(sticky).toBeVisible();

		const { clientHeight, scrollHeight } = await sticky.evaluate((el) => ({
			clientHeight: el.clientHeight,
			scrollHeight: el.scrollHeight
		}));
		// Bounded by the viewport, not by its content: the point of the max-height.
		expect(clientHeight).toBeLessThanOrEqual(page.viewportSize()!.height);

		if (scrollHeight > clientHeight) {
			// And when it does overflow, the bottom is reachable. `scrollTop` moving at all is the
			// proof; a clipped panel with `overflow: visible` cannot scroll and stays at 0.
			await sticky.evaluate((el) => el.scrollTo(0, el.scrollHeight));
			expect(await sticky.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
		}
	});

	/** Closing puts focus back where the user was, not on <body> at the top of the page. */
	test('closing the panel returns focus to the row it was opened from', async ({ page }) => {
		await openTransactionByLabel(page, GC_LABEL);
		await desktopPanel(page)
			.getByRole('link', { name: m.transactions_detail_close_aria() })
			.click();

		await expect(desktopPanel(page)).toHaveCount(0);
		const focusedText = await page.evaluate(() => document.activeElement?.textContent?.trim());
		expect(focusedText).toBe(GC_LABEL);
	});
});
