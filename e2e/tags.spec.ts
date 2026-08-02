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
import { TAG_COLORS, tagColorBgClass, tagTintBgClass } from '../src/lib/domain/colors';
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
	/** Resolves an element's OWN computed background to sRGB bytes by painting it — Tailwind v4
	 *  emits oklch(), which getComputedStyle hands back unchanged in Chromium, so comparing that
	 *  string to a hex literal would prove nothing about what the browser actually paints. Mirrors
	 *  paintedColors/paintTailwind in e2e/upcoming-bills.spec.ts, kept local (not extracted) since
	 *  only its RGB-tuple contrastRatio counterpart is shared per task 8.3. */
	async function paintedBackground(locator: Locator): Promise<[number, number, number]> {
		return locator.evaluate((element) => {
			const canvas = document.createElement('canvas');
			canvas.width = 1;
			canvas.height = 1;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('no 2d context');
			context.fillStyle = getComputedStyle(element).backgroundColor;
			context.fillRect(0, 0, 1, 1);
			const data = context.getImageData(0, 0, 1, 1).data;
			return [data[0], data[1], data[2]];
		});
	}

	/** Same technique, applied to a throwaway probe carrying an arbitrary Tailwind class rather
	 *  than a real component — this is what makes it possible to measure the DOT class and the
	 *  TINT class as a pair, see the comment on the second test below for why a real TagChips
	 *  cannot supply that pair today. */
	async function paintedClass(page: Page, className: string): Promise<[number, number, number]> {
		return page.evaluate((cls) => {
			const probe = document.createElement('div');
			probe.className = cls;
			probe.style.position = 'fixed';
			probe.style.left = '-9999px';
			document.body.appendChild(probe);
			const canvas = document.createElement('canvas');
			canvas.width = 1;
			canvas.height = 1;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('no 2d context');
			context.fillStyle = getComputedStyle(probe).backgroundColor;
			context.fillRect(0, 0, 1, 1);
			const data = context.getImageData(0, 0, 1, 1).data;
			probe.remove();
			return [data[0], data[1], data[2]];
		}, className);
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
			expect(await paintedBackground(dot)).toEqual(hexToRgb(expectedHex));
		}
	});

	/**
	 * The measured figures from domain/tags.spec.ts (lagoon 4.71:1, azure 4.81:1) describe the dot
	 * colour written as TEXT on the tag's own tinted background — the design's "name text on its
	 * own tint" pairing (domain/colors.ts's comment on TAG_COLORS, and
	 * docs/superpowers/specs/2026-08-02-transverse-tags-design.md section 6.3). That unit test
	 * computes the ratio straight from the two hex constants, so it cannot tell a correct
	 * TAG_COLORS/TAG_TINT_COLORS pairing from a Tailwind class that never made it into the
	 * compiled build.
	 *
	 * ui/TagChips.svelte does not currently render that pairing anywhere: its enclosed chip
	 * background is the fixed `bg-zinc-50`, never `tagTintBgClass(token)` — `tagTintBgClass` has
	 * no caller in `src/` today. This test therefore cannot point a real rendered chip at both
	 * halves of the pair (see the finding recorded in the PR body); what it CAN prove, and does,
	 * is that `tagColorBgClass`/`tagTintBgClass` still resolve through this build's REAL compiled
	 * CSS to the same hexes the unit test assumes — painting both classes independently and
	 * computing the ratio from what the browser actually renders, the same guarantee
	 * `paintTailwind` gives upcoming-bills.spec.ts against Tailwind v4's oklch conversion.
	 */
	test('lagoon (4.71:1) and azure (4.81:1) still clear the design-measured ratio when their dot and tint classes are painted by the real Tailwind build', async ({
		page
	}) => {
		await page.goto('/settings');

		const cases = [
			{ token: 'lagoon', measured: 4.71 },
			{ token: 'azure', measured: 4.81 }
		] as const;

		for (const { token, measured } of cases) {
			const dotRgb = await paintedClass(page, tagColorBgClass(token));
			const tintRgb = await paintedClass(page, tagTintBgClass(token));
			const ratio = contrastRatio(dotRgb, tintRgb);

			expect(ratio).toBeGreaterThanOrEqual(4.5);
			expect(ratio).toBeCloseTo(measured, 1);
		}
	});
});
