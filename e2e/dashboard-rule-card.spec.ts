import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import {
	bootOwnInstance,
	expectAction,
	OWNER_PASSWORD,
	registerOwner,
	type OwnInstance
} from './support/ownInstance';

/**
 * THE RULE CARD, PINNED AS A JOURNEY (#1010). The dashboard's « Insights » card has a rule part
 * (budget alerts, unusual spending, the count left to classify) that never used a model, and the AI
 * tips that sat under it were removed around it. Its unit and component specs
 * (`dashboard/insights.spec.ts`, `DashboardInsights.svelte.spec.ts`) each hold one level; this is
 * the only check that a member's own rows, written through the app's forms, come out as these three
 * sentences on the screen. Written green on `main` before the removal and unchanged after it.
 *
 * ITS OWN INSTANCE, because the card reads the real clock's month: rows dated this month in the
 * shared e2e database would move every later spec's figures.
 *
 * Every figure is a literal, chosen so each finding has exactly one producer:
 * - Groceries Probe spends 150.00 against a 100.00 budget: the one alert, over budget.
 * - Leisure Probe spends 20.00 in each of the two previous months and 60.00 this month: +200%,
 *   the one unusual line. Groceries has no history, so it cannot be unusual.
 * - One 5.00 row in a category whose nature is « to classify »: the one row to classify, below the
 *   unusual line's 20.00 floor.
 */

// Not serial: each test separates its own two states, so one red must not hide the others'.
test.describe.configure({ retries: 0 });

const NAME = 'rule-card';
const PORT = 4188;
const OWNER = 'rule-card-owner@budgetpilot.test';

let instance: OwnInstance | undefined;
let client: APIRequestContext | undefined;

/** `YYYY-MM-15` of the month `offset` months from the server's current UTC month. */
function midMonth(offset: number): string {
	const now = new Date();
	const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15));
	return date.toISOString().slice(0, 10);
}

test.beforeAll(async () => {
	instance = await bootOwnInstance({ name: NAME, port: PORT });
	client = await registerOwner(instance, OWNER);
	const today = new Date().toISOString().slice(0, 10);
	const rows = [
		{ date: today, label: 'GROCERIES PROBE ONE', amount: '-150.00', category: 'Groceries Probe' },
		{ date: today, label: 'LEISURE PROBE NOW', amount: '-60.00', category: 'Leisure Probe' },
		{ date: midMonth(-1), label: 'LEISURE PROBE M1', amount: '-20.00', category: 'Leisure Probe' },
		{ date: midMonth(-2), label: 'LEISURE PROBE M2', amount: '-20.00', category: 'Leisure Probe' },
		{ date: today, label: 'UNSORTED PROBE', amount: '-5.00', category: 'Unsorted Probe' }
	];
	for (const row of rows) {
		const written = await client.post('/?/createTransaction', { form: row });
		await expectAction(written, 'success', `wrote « ${row.label} » on ${row.date}`);
	}
	const budget = await client.post('/budgets?/create', {
		form: { category: 'Groceries Probe', amount: '100' }
	});
	await expectAction(budget, 'success', 'the Groceries Probe budget');
	// A row is « to classify » when its category's nature is uncategorized: set the way a member does.
	const nature = await client.post('/categories?/updateNature', {
		form: { categoryName: 'Unsorted Probe', nature: 'uncategorized', mappingId: '' }
	});
	await expectAction(nature, 'success', 'Unsorted Probe marked as to classify');
	console.log(`rule-card: seeded ${rows.length} rows; current month ${today.slice(0, 7)}`);
});

test.afterAll(async () => {
	await client?.dispose();
	await instance?.stop();
});

test('the rule card shows its three findings for one synthetic month', async ({ browser }) => {
	const context = await browser.newContext({ baseURL: instance!.baseUrl, locale: 'en-US' });
	await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: instance!.baseUrl }]);
	const page = await context.newPage();
	await page.goto('/login');
	await page.locator('input[name="email"]').fill(OWNER);
	await page.locator('input[name="password"]').fill(OWNER_PASSWORD);
	await page.locator('form button[type="submit"]').first().click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));
	await page.goto('/');
	await page.waitForLoadState('networkidle');

	const header = page.getByRole('button', { name: /^Insights/ });
	await expect(header).toHaveText('Insights 1 to review');
	const content = page.locator('#dashboard-insights-content');
	await expect(async () => {
		if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
		await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
	}).toPass({ timeout: 15_000 });
	await expect(content).toBeVisible();

	// The alert: its name and its delta compared whole; the spent-of-limit line also carries the
	// days left, which move with the calendar.
	const alert = content.locator('div.rounded-3xl');
	await expect(alert).toHaveCount(1);
	await expect(alert.locator('span').first()).toHaveText('Groceries Probe');
	await expect(alert.locator('span').nth(1)).toHaveText('Over by €50.00');
	await expect(alert.locator('p').first()).toContainText('€150.00 / €100.00');

	// The unusual line and the line to classify, each compared as the sentence a person reads.
	await expect(content.getByText('Leisure Probe up +200% vs usual')).toHaveText(
		'Leisure Probe up +200% vs usual (€60.00 vs €20.00 on average)'
	);
	await expect(
		content.getByText('1 transaction to classify', { exact: true }).locator('..')
	).toHaveText('1 transaction to classify · classify them to make your budgets reliable');
	await context.close();
});

test('the advice route is gone: a well-formed request answers 404', async () => {
	// A well-formed request from the card's own origin: on a build that still has the route, this
	// answers 409 (stale key) or a generation, never 404.
	const advice = await client!.post('/insights/advice', {
		data: { period: 'period=custom&from=2026-01-01&to=2026-01-31', aiAdviceKey: 'f'.repeat(64) },
		headers: { 'Sec-Fetch-Site': 'same-origin' }
	});
	expect(advice.status(), 'POST /insights/advice').toBe(404);
});

test('the two AI settings actions are gone: each answers « no such action »', async () => {
	for (const action of ['updateAiInsightsEnabled', 'updateAiIncludeLabels']) {
		const response = await client!.post(`/settings?/${action}`, { form: { enabled: 'true' } });
		const body = (await response.json().catch(() => ({}))) as {
			type?: string;
			error?: { message?: string };
		};
		// The REASON, not only a refusal. SvelteKit answers a missing action with a 404 error whose
		// message `handleError` reduces to « Not Found »; a live action answers `success` or `failure`
		// (an invalid value, a closed session), never `error`, so the three together say « absent ».
		expect(response.status(), action).toBe(404);
		expect(body.type, action).toBe('error');
		expect(body.error?.message, action).toBe('Not Found');
	}
});

test('settings renders no AI control, and does render its other forms', async ({ browser }) => {
	const context = await browser.newContext({
		baseURL: instance!.baseUrl,
		locale: 'en-US',
		storageState: await client!.storageState()
	});
	const page = await context.newPage();
	const response = await page.goto('/settings');
	const html = await page.content();
	console.log(`rule-card: /settings answered ${response?.status()}, ${html.length} bytes`);
	// Calibration: the page rendered its forms, so a zero below is about the AI forms alone.
	const forms = await page.locator('form[action^="?/"]').count();
	expect(forms, 'forms with an action on /settings').toBeGreaterThan(5);
	await expect(page.locator('form[action*="updateAi"]')).toHaveCount(0);
	await context.close();
});
