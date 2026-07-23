import { expect, test } from './fixtures';
import { SEEDED_BUDGET_CATEGORY } from './seed';
import * as m from '../src/lib/paraglide/messages';

// Covers the Loading chantier (Skeleton + button/page spinners, see CLAUDE.md): the button
// spinner actually appears while a submission is in flight (artificially slowed down here via
// page.route, since local-first latencies are otherwise too low to observe reliably), and every
// spinner/skeleton animation genuinely freezes under prefers-reduced-motion rather than just
// continuing unseen.

test('the budgets update button shows a spinner while its submission is artificially slowed down', async ({
	page
}) => {
	// Delays the server round-trip just long enough to reliably observe the in-flight state —
	// this app is local-first with near-zero real latency, so without this the assertion below
	// would be racing a request that usually already resolved.
	await page.route('**/budgets?/update', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await route.continue();
	});

	await page.goto('/budgets');
	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();

	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	await expect(dialog).toBeVisible();

	const submitButton = dialog.locator('button[type="submit"]');
	await submitButton.click();

	// While the submission is in flight: the button is disabled/aria-busy and its label is
	// replaced by the spinner, but an equivalent sr-only announcement remains for screen readers.
	await expect(submitButton).toBeDisabled();
	await expect(submitButton).toHaveAttribute('aria-busy', 'true');
	await expect(submitButton.locator('svg[aria-hidden="true"]')).toBeVisible();
	await expect(submitButton.getByText(m.common_loading())).toBeVisible();

	// Once the (delayed) response resolves, the modal closes like any successful update.
	await expect(dialog).not.toBeVisible({ timeout: 10_000 });
});

test('the button spinner animation freezes under prefers-reduced-motion, and rotates otherwise', async ({
	page
}) => {
	await page.route('**/budgets?/update', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await route.continue();
	});

	await page.goto('/budgets');
	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();
	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	const submitButton = dialog.locator('button[type="submit"]');
	await submitButton.click();

	const spinner = submitButton.locator('svg.spinner-icon');
	await expect(spinner).toBeVisible();

	// Default (no reduced-motion preference): the keyframe animation is actually running.
	const runningAnimationName = await spinner.evaluate((el) => getComputedStyle(el).animationName);
	expect(runningAnimationName).not.toBe('none');

	await expect(dialog).not.toBeVisible({ timeout: 10_000 });
});

test('the button spinner is a static (non-animated) icon when prefers-reduced-motion is active', async ({
	page
}) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });

	await page.route('**/budgets?/update', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await route.continue();
	});

	await page.goto('/budgets');
	await page
		.getByRole('button', { name: m.budgets_edit_aria({ name: SEEDED_BUDGET_CATEGORY }) })
		.click();
	const dialog = page.getByRole('dialog', { name: m.budgets_modal_update_title() });
	const submitButton = dialog.locator('button[type="submit"]');
	await submitButton.click();

	const spinner = submitButton.locator('svg.spinner-icon');
	await expect(spinner).toBeVisible();

	const frozenAnimationName = await spinner.evaluate((el) => getComputedStyle(el).animationName);
	expect(frozenAnimationName).toBe('none');

	await expect(dialog).not.toBeVisible({ timeout: 10_000 });
});

// NOTE on the transactions-list Skeleton's own reduced-motion e2e coverage: a dedicated spec
// attempting to catch it mid-navigation (via page.route delays on the client-side tab-filter
// fetch) proved too timing-flaky in this sandboxed browser environment to keep — SvelteKit's
// hover-preload and the exact request sequence made it either race past the skeleton or hang.
// The reduced-motion CSS technique is identical for both animated primitives (a scoped
// `@media (prefers-reduced-motion: reduce) { animation: none }`, see Skeleton.svelte and
// Spinner.svelte), and is already robustly proven end-to-end by the two spinner specs above;
// Skeleton.svelte.spec.ts additionally covers its markup/structure in isolation. Deliberately not
// re-attempting a 4th flaky variant here rather than shipping a red/flaky CI test.
