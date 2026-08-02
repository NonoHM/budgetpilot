// Fixture transactions for e2e/tags.spec.ts, created through the app's real HTTP actions
// (`/?/createTransaction`, `/transactions?/saveTags`) — never a direct Prisma insert, same rule
// as e2e/seed.ts and e2e/bills-seed.ts. Two different mechanisms are used on purpose:
//
//  - the ROUND TRIP and AUTO-GC transactions are left UNTAGGED here, because the assignment and
//    removal themselves are exactly what the spec exercises through the real TagPicker UI;
//  - the FILTER and BULK fixtures are pre-tagged here via the `saveTags` action, called directly
//    over HTTP, because the tag they carry is a precondition for those tests rather than the
//    thing under test.
//
// Dates are fixed, not derived from "today" the way bills-seed's are: nothing here depends on the
// recurrence detector's staleness window, so there is no reason to couple this fixture to the
// clock. 2026-01-10..2026-01-17 is chosen to sit outside every other seeded date range in this
// suite (e2e/seed.ts's June 2026 rows, bills-seed's window around the run date) so the bulk
// fixture's date-range filter can assert an EXACT count without another spec's data leaking in.
import { request, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { E2E_BASE_URL } from './config';
import {
	E2E_BOOTSTRAP_ADMIN_EMAIL,
	E2E_BOOTSTRAP_ADMIN_PASSWORD,
	SEEDED_BUDGET_CATEGORY,
	assertOk,
	createTransaction,
	loginE2eUser,
	submitForm
} from './seed';
import * as m from '../src/lib/paraglide/messages';

export const ROUNDTRIP_LABEL = 'TAG SEED ROUNDTRIP';
export const GC_LABEL = 'TAG SEED AUTO GC';

export const FILTER_TAG_NAME = 'Voyage E2E';
export const FILTER_TAGGED_LABELS = [
	'TAG SEED FILTER ALPHA',
	'TAG SEED FILTER BRAVO',
	'TAG SEED FILTER CHARLIE'
] as const;
export const FILTER_UNTAGGED_LABELS = ['TAG SEED FILTER DELTA', 'TAG SEED FILTER ECHO'] as const;

export const BULK_TAG_NAME = 'Bulk E2E';
export const BULK_FROM = '2026-01-10';
export const BULK_TO = '2026-01-12';
/** Already carries BULK_TAG_NAME before the spec's bulk-apply test runs, so that test can prove a
 *  row tagged some other day survives the undo — the requirement a bulk apply on an untouched set
 *  cannot exercise. */
export const BULK_PRETAGGED_LABEL = 'TAG SEED BULK ALPHA';
export const BULK_UNTAGGED_LABELS = ['TAG SEED BULK BRAVO', 'TAG SEED BULK CHARLIE'] as const;

/** Every label this file creates, in creation order — used by the idempotency probe. */
const ALL_LABELS = [
	ROUNDTRIP_LABEL,
	GC_LABEL,
	...FILTER_TAGGED_LABELS,
	...FILTER_UNTAGGED_LABELS,
	BULK_PRETAGGED_LABEL,
	...BULK_UNTAGGED_LABELS
];

async function saveTagsViaApi(
	context: APIRequestContext,
	transactionId: string,
	names: string[]
): Promise<void> {
	assertOk(
		'saveTags',
		await submitForm(context, '/transactions?/saveTags', {
			transactionId,
			tags: names.join('\n')
		})
	);
}

/**
 * Resolves a seeded transaction's id by searching for its (unique) label.
 *
 * `?q=` narrows the list to exactly one row, so the id is read straight off that row's own
 * "select this transaction" link rather than off a direct Prisma read — the whole point of
 * exercising the app's real routes for this fixture. `selected=` is `buildSelectedHref`'s param
 * name (routes/transactions/hrefs.ts).
 */
async function resolveTransactionIdByLabel(
	context: APIRequestContext,
	label: string
): Promise<string> {
	const response = await context.get(`/transactions?q=${encodeURIComponent(label)}`);
	const html = await response.text();
	// `&` inside an href attribute is served HTML-entity-encoded (`&amp;`) by SvelteKit's SSR
	// renderer, not literal — matching only `&` found nothing on a rendered page and made this
	// throw on every call.
	const match = html.match(/[?&](?:amp;)?selected=([A-Za-z0-9_-]+)/);
	if (!match) {
		throw new Error(`tags-seed: could not resolve a transaction id for label "${label}"`);
	}
	return match[1];
}

/**
 * Idempotent by probe, not by flag, same reasoning as bills-seed's seedBillStreams: Playwright
 * restarts the worker on a retry, re-running `beforeAll`. Re-creating every row a second time
 * would double the filter/bulk counts this suite asserts exactly.
 */
export async function seedTagFixture(): Promise<void> {
	const context = await request.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: { Origin: E2E_BASE_URL }
	});

	try {
		await loginE2eUser(context);

		// NOT `probe.text().includes(BULK_PRETAGGED_LABEL)`: the transactions page always echoes
		// `?q=` back into the search input's own `value` attribute, whether or not any row
		// matches it, so that check was true on the very first (empty-database) run and the seed
		// never created anything. The "no results" copy is only absent when a matching row
		// genuinely exists.
		const probe = await context.get(`/transactions?q=${encodeURIComponent(BULK_PRETAGGED_LABEL)}`);
		if (!(await probe.text()).includes(m.transactions_no_transactions_criteria())) return;

		for (const label of ALL_LABELS) {
			await createTransaction(context, {
				date: dateFor(label),
				label,
				amount: '-9.90',
				category: SEEDED_BUDGET_CATEGORY
			});
		}

		for (const label of FILTER_TAGGED_LABELS) {
			const id = await resolveTransactionIdByLabel(context, label);
			await saveTagsViaApi(context, id, [FILTER_TAG_NAME]);
		}

		const bulkPretaggedId = await resolveTransactionIdByLabel(context, BULK_PRETAGGED_LABEL);
		await saveTagsViaApi(context, bulkPretaggedId, [BULK_TAG_NAME]);
	} finally {
		await context.dispose();
	}
}

function dateFor(label: string): string {
	if (label === BULK_PRETAGGED_LABEL) return BULK_FROM;
	if (label === BULK_UNTAGGED_LABELS[0]) return '2026-01-11';
	if (label === BULK_UNTAGGED_LABELS[1]) return BULK_TO;
	// Round trip, GC and filter rows: any date outside the bulk window and outside e2e/seed.ts's
	// June 2026 rows is fine, since nothing filters this suite's other tests by date.
	return '2026-02-01';
}

/**
 * A second, genuinely different account's session (the disposable bootstrap admin from
 * e2e/seed.ts), as a real browser page rather than an APIRequestContext. Used for the one claim
 * only a rendered page can prove: that the tag filter control is entirely ABSENT from the DOM for
 * a user who owns no tags — this account never visits /transactions anywhere else in the suite,
 * so it never accumulates one.
 */
export async function withOtherUserPage<T>(
	browser: Browser,
	run: (page: Page) => Promise<T>
): Promise<T> {
	const apiContext = await request.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: { Origin: E2E_BASE_URL }
	});
	try {
		assertOk(
			'other-user login',
			await submitForm(apiContext, '/login', {
				email: E2E_BOOTSTRAP_ADMIN_EMAIL,
				password: E2E_BOOTSTRAP_ADMIN_PASSWORD
			})
		);
		const storageState = await apiContext.storageState();

		const browserContext = await browser.newContext({ storageState });
		await browserContext.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'fr', url: E2E_BASE_URL }]);
		try {
			const page = await browserContext.newPage();
			return await run(page);
		} finally {
			await browserContext.close();
		}
	} finally {
		await apiContext.dispose();
	}
}
