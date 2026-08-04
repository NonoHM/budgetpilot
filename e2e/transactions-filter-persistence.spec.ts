// Regression for the fourth-enumeration-site defect: the two `<form method="GET">` filter forms on
// /transactions carried hidden inputs for only `type` and `importBatch`. Pressing Enter inside the
// search field (a native GET submit, no `use:enhance` on either form) serialized just that form's
// own named controls and silently dropped every other active filter — measured in a browser on
// 2026-08-04: `?q=a&category=Alimentation&from=2026-01-01&to=2026-12-31` became
// `?qMode=contains&q=ab` after typing and pressing Enter, on both surfaces. `hrefs.ts`'s
// `filterHiddenInputs` is the fix; this asserts all FOUR dropped params survive, not only the three
// that were measured live (`tag` is exercised here for the first time).
//
// `ids` is deliberately NOT in that list and is asserted ABSENT below, not merely unchecked: a
// search is a filter change, and `applyFilterDimension` already drops `ids` on every other filter
// change (`buildTransactionsHref(..., { keepIds: false })`) so a user who arrived via an id-scoped
// link sees they left that view once they narrow the list further. Pinned independently by
// `ids-filter-links.svelte.spec.ts`'s "carries no ids hidden input in the search forms" case — this
// file must not contradict it. See the follow-up justification on the assertion itself.
//
// Both surfaces (`form[method="GET"]`, desktop then mobile in source order) are mounted
// simultaneously and only one is hidden by CSS at a given viewport — every locator below is scoped
// to `.nth(0)`/`.nth(1)` rather than trusting `getByRole` alone, same rule e2e/tags.spec.ts states.
import { request, type APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_API_HEADERS, E2E_BASE_URL } from './config';
import { loginE2eUser } from './seed';
import { BULK_UNTAGGED_LABELS, FILTER_TAG_NAME, seedTagFixture } from './tags-seed';
import * as m from '../src/lib/paraglide/messages';

const CATEGORY = 'Alimentation';
const FROM = '2026-01-01';
const TO = '2026-12-31';

let tagId: string;
let ids: string;

test.beforeAll(async () => {
	await seedTagFixture();

	const context = await request.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: E2E_API_HEADERS
	});
	try {
		await loginE2eUser(context);
		tagId = await resolveTagId(context, FILTER_TAG_NAME);
		const first = await resolveTransactionId(context, BULK_UNTAGGED_LABELS[0]);
		const second = await resolveTransactionId(context, BULK_UNTAGGED_LABELS[1]);
		ids = `${first},${second}`;
	} finally {
		await context.dispose();
	}
});

/** Same extraction e2e/tags-seed.ts's own (unexported) resolver uses: the row's "select this
 *  transaction" link carries `selected=<id>`, HTML-entity-encoded (`&amp;`) by SvelteKit's SSR. */
async function resolveTransactionId(context: APIRequestContext, label: string): Promise<string> {
	const html = await (await context.get(`/transactions?q=${encodeURIComponent(label)}`)).text();
	const match = html.match(/[?&](?:amp;)?selected=([A-Za-z0-9_-]+)/);
	if (!match) throw new Error(`could not resolve a transaction id for label "${label}"`);
	return match[1];
}

/** The tag's own id, read off /settings: the delete button's aria-label names the tag and sits
 *  ahead of the recolour form's `<input name="id">` inside the same `<li>` (see settings/+page.svelte
 *  around the "Étiquettes" section), so a bounded slice starting at the aria-label finds the right
 *  id even with several tags on the page. */
async function resolveTagId(context: APIRequestContext, tagName: string): Promise<string> {
	const html = await (await context.get('/settings')).text();
	const marker = m.tags_delete_aria({ name: tagName });
	const idx = html.indexOf(marker);
	if (idx === -1) throw new Error(`tag "${tagName}" not found on /settings`);
	const match = html.slice(idx).match(/name="id" value="([A-Za-z0-9_-]+)"/);
	if (!match) throw new Error(`could not resolve an id for tag "${tagName}"`);
	return match[1];
}

async function assertFourSurviveAndIdsStaysDropped(
	page: import('@playwright/test').Page
): Promise<void> {
	await page.waitForURL(/[?&]q=ab/);

	const after = new URL(page.url());
	expect(after.searchParams.get('category')).toBe(CATEGORY);
	expect(after.searchParams.get('from')).toBe(FROM);
	expect(after.searchParams.get('to')).toBe(TO);
	expect(after.searchParams.get('tag')).toBe(tagId);
	// Deliberately absent, not merely unasserted: `ids` scopes "the transactions linked to this
	// bill", and a search visibly narrows the list to something else, so the user must see they
	// left that view — the same rule `applyFilterDimension`'s `keepIds: false` already applies to
	// every other filter change. If this ever starts failing because `ids` reappears, that is a
	// product decision to make deliberately (see ids-filter-links.svelte.spec.ts), not a gap to
	// close by re-adding `ids` to filterHiddenInputs.
	expect(after.searchParams.get('ids')).toBeNull();

	// EXACTLY ONE `q` and one `qMode`, which is the whole reason filterHiddenInputs deletes them:
	// both are already real named controls inside these forms, so emitting them as hidden inputs
	// too would submit two values for one key. That failure is invisible to every assertion above —
	// the URL would be `…&q=a&qMode=contains&q=ab`, the `waitForURL(/[?&]q=ab/)` would still match,
	// all five checks would still pass, and the server's `searchParams.get('q')` would read the
	// STALE 'a', silently discarding what the user just typed.
	expect(after.searchParams.getAll('q')).toHaveLength(1);
	expect(after.searchParams.getAll('qMode')).toHaveLength(1);
	// Every other dimension too: a duplicated hidden input is the same defect one filter over.
	for (const name of ['category', 'from', 'to', 'tag', 'type', 'importBatch']) {
		expect(after.searchParams.getAll(name).length, name).toBeLessThanOrEqual(1);
	}
}

test.describe('/transactions — pressing Enter in the search field keeps every active filter', () => {
	test('desktop', async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(
			`/transactions?q=a&category=${encodeURIComponent(CATEGORY)}&from=${FROM}&to=${TO}&tag=${tagId}&ids=${ids}`
		);

		const form = page.locator('form[method="GET"]').nth(0);
		const searchbox = form.getByRole('searchbox', { name: m.transactions_search_label() });
		await searchbox.fill('ab');
		await searchbox.press('Enter');

		await assertFourSurviveAndIdsStaysDropped(page);
	});

	test('mobile (390)', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(
			`/transactions?q=a&category=${encodeURIComponent(CATEGORY)}&from=${FROM}&to=${TO}&tag=${tagId}&ids=${ids}`
		);

		const form = page.locator('form[method="GET"]').nth(1);
		const searchbox = form.getByRole('searchbox', { name: m.transactions_search_label() });
		await searchbox.fill('ab');
		await searchbox.press('Enter');

		await assertFourSurviveAndIdsStaysDropped(page);
	});
});
