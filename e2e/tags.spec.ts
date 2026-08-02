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
 * Closes the picker's own dropdown afterward by clicking OUTSIDE its container (the section
 * heading), never Escape: nothing in `createOrSelect`/`toggleOption` sets `open = false`, so the
 * listbox stays mounted and keeps occupying layout space, and clicking Save next would land the
 * mouse-up on whatever the dropdown's closing reflow shifted underneath it. Escape is not a safe
 * substitute either — BottomSheet's window-level keydown handler is mounted unconditionally (only
 * CSS-hidden at desktop) and treats Escape as "close the detail panel", clearing the whole
 * selection instead of just the dropdown. */
async function pickOrCreateTag(page: Page, section: Locator, tagName: string): Promise<void> {
	const input = section.getByRole('combobox', { name: m.tags_heading() });
	await input.click();
	await input.pressSequentially(tagName, { delay: 20 });
	const option = page.getByRole('option', { name: new RegExp(escapeRegExp(tagName)) });
	await expect(option).toBeVisible();
	await option.click();

	// The group's own <legend>, which is the inert text this section is named by. It used to be an
	// <h3>; the editor became a fieldset/legend pair to match the design, and this second reference
	// to the old structure survived the first pass over the file. A legend has no ARIA role of its
	// own (it names the group), so it is located by element rather than by role.
	await section.locator('legend').click();
	await expect(page.locator('[role="listbox"]')).toHaveCount(0);
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
});

// ─── 2. Filter narrows the list, absent with no tags ───────────────────────

test.describe('tag filter', () => {
	test('selecting a tag in the filter bar narrows the list to exactly the tagged rows', async ({
		page
	}) => {
		await page.goto('/transactions');

		const bar = desktopFilterBar(page);
		const filterInput = bar.getByLabel(m.tags_filter_aria());
		await filterInput.click();
		await filterInput.pressSequentially(FILTER_TAG_NAME, { delay: 20 });
		await page.getByRole('option', { name: FILTER_TAG_NAME, exact: true }).click();
		await bar.getByRole('button', { name: m.transactions_submit_filter() }).click();

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

			await expect(desktopFilterBar(otherPage).getByLabel(m.tags_filter_aria())).toHaveCount(0);
			await expect(otherPage.getByText(m.tags_filter_placeholder())).toHaveCount(0);
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

		await bar.getByRole('button', { name: m.tags_bulk_cta() }).click();
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

			const nameRgb = await paintedColor(chip, 'color');
			const surfaceRgb = await paintedColor(chip.locator('xpath=..'), 'backgroundColor');
			const ratio = contrastRatio(nameRgb, surfaceRgb);

			expect(ratio).toBeGreaterThanOrEqual(4.5);
			// The MEASURED figure, not the 4.5 threshold. Lightening a locked tint RAISES the ratio, so
			// a threshold alone passes the exact change the lock forbids; only the measured value
			// catches drift in both directions.
			expect(ratio).toBeCloseTo(measured, 1);
		}
	});
});
