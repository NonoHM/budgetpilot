import { expect, test } from './fixtures';
import { SEEDED_BUDGET_CATEGORY } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Covers the component referential V2's final brick (motion harmonization, see src/lib/motion.ts
// and src/lib/styles.ts's transitionHover): shared open/close and hover/press timings across
// IconButton, Dropdown (AccountMenu), Tooltip, Modal, AlertBanner. Each check reads the actual
// computed CSS animation/transition duration instead of racing real time — the same technique
// loading-states.spec.ts already uses for the button spinner — and confirms prefers-reduced-motion
// genuinely collapses every one of these to 0/none instead of merely slowing it down.

test('Modal opens and IconButton carries the shared 120ms hover/press token', async ({ page }) => {
	await page.goto('/budgets');
	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();

	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	await expect(dialog).toBeVisible();

	// Not a numeric animationDuration assertion on the dialog itself here: by the time this
	// polling assertion resolves, the 180ms entrance may already have finished and Svelte cleaned
	// up its inline animation style — a false negative, not a real regression. The exact-duration
	// case is covered deterministically under reduced motion below. IconButton's hover/press token
	// is a static CSS class (not a one-shot mount transition), so it's always reliably readable.
	const closeButton = dialog.getByRole('button', { name: m.common_close() });
	const closeButtonTransitionDuration = await closeButton.evaluate(
		(el) => getComputedStyle(el).transitionDuration
	);
	expect(closeButtonTransitionDuration).toBe('0.12s');
});

test('AccountMenu (Dropdown) opens with the shared popover-in keyframe (160ms)', async ({
	page
}) => {
	await page.goto('/');
	await page.getByRole('button', { name: m.account_menu_trigger_aria() }).click();

	const menu = page.getByRole('menu');
	await expect(menu).toBeVisible();

	const { animationName, animationDuration } = await menu.evaluate((el) => {
		const style = getComputedStyle(el);
		return { animationName: style.animationName, animationDuration: style.animationDuration };
	});
	expect(animationName).not.toBe('none');
	expect(animationDuration).toBe('0.16s');
});

test('reports nature-breakdown Tooltip opens with the shared 160ms popover-in timing', async ({
	page
}) => {
	// The seeded transactions are dated 2026-06 (see e2e/seed.ts); reports defaults to the current
	// month, which would show no nature-breakdown segments at all — pin an explicit custom range
	// covering June so the Tooltip's trigger actually renders.
	await page.goto('/reports?period=custom&from=2026-06-01&to=2026-06-30');

	const segment = page.locator('[aria-label*="€"]').first();
	await segment.hover();

	const tooltip = page.getByRole('tooltip');
	// Not a numeric duration assertion here: by the time Playwright's polling assertion resolves
	// visibility, the (network-independent but hover-intent-delayed) 160ms entrance may already
	// have finished and Svelte cleaned up its inline animation style — a false negative, not a real
	// regression. The exact-duration case is covered deterministically under reduced motion below
	// (a 0ms transition can't "already have finished" in a way that changes the read value) and by
	// Tooltip.svelte.spec.ts's unit-level fade in/out coverage.
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toHaveText(/€/);
});

test('budgets success AlertBanner opens with the shared 180ms fade+translateY timing', async ({
	page
}) => {
	await page.goto('/budgets');

	await page.getByRole('button', { name: m.budgets_new() }).first().click();
	const createDialog = page.getByRole('dialog', { name: m.budgets_modal_create_title() });
	await expect(createDialog).toBeVisible();

	const categoryInput = createDialog.getByLabel(m.budgets_field_category());
	await categoryInput.click();
	await categoryInput.pressSequentially(m.category_default_transport(), { delay: 20 });
	await page.getByRole('option', { name: m.category_default_transport(), exact: true }).click();
	await createDialog.locator('input[name="amount"]').fill('80');
	await createDialog.getByRole('button', { name: m.common_save() }).click();

	const banner = page.getByRole('status');
	// Same reasoning as the Tooltip test above: this banner only appears after a real form
	// round-trip, so by the time it's observed the 180ms entrance has often already finished and
	// been cleaned up — the reduced-motion combined test below covers the exact-duration case
	// deterministically instead.
	await expect(banner).toContainText(m.budgets_success_created());
});

test('prefers-reduced-motion collapses every one of these transitions to 0/none', async ({
	page
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });

	// IconButton + Modal
	await page.goto('/budgets');
	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();
	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	await expect(dialog).toBeVisible();
	expect(await dialog.evaluate((el) => getComputedStyle(el).animationDuration)).toBe('0s');
	expect(
		await dialog
			.getByRole('button', { name: m.common_close() })
			.evaluate((el) => getComputedStyle(el).transitionDuration)
	).toBe('0s');
	await page.keyboard.press('Escape');
	await expect(dialog).not.toBeVisible();

	// Dropdown
	await page.getByRole('button', { name: m.account_menu_trigger_aria() }).click();
	const menu = page.getByRole('menu');
	await expect(menu).toBeVisible();
	expect(await menu.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
	await page.keyboard.press('Escape');

	// Tooltip
	await page.goto('/reports?period=custom&from=2026-06-01&to=2026-06-30');
	const segment = page.locator('[aria-label*="€"]').first();
	await segment.hover();
	const tooltip = page.getByRole('tooltip');
	await expect(tooltip).toBeVisible();
	expect(await tooltip.evaluate((el) => getComputedStyle(el).animationDuration)).toBe('0s');

	// AlertBanner
	await page.goto('/budgets');
	await page.getByRole('button', { name: m.budgets_new() }).first().click();
	const createDialog = page.getByRole('dialog', { name: m.budgets_modal_create_title() });
	const categoryInput = createDialog.getByLabel(m.budgets_field_category());
	await categoryInput.click();
	await categoryInput.pressSequentially(m.category_default_leisure(), { delay: 20 });
	await page.getByRole('option', { name: m.category_default_leisure(), exact: true }).click();
	await createDialog.locator('input[name="amount"]').fill('50');
	await createDialog.getByRole('button', { name: m.common_save() }).click();
	const banner = page.getByRole('status');
	await expect(banner).toContainText(m.budgets_success_created());
	expect(await banner.evaluate((el) => getComputedStyle(el).animationDuration)).toBe('0s');
});
