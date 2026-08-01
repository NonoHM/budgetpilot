import { expect, test } from './fixtures';
import { E2E_BASE_URL } from './config';
import {
	BILLS_MONTH_KEY,
	CURRENT_MONTH_KEY,
	OVERDUE_GYM,
	OVERDUE_WATER,
	RETIRED_ABSENT_MONTH_KEY,
	RETIRED_REALIZED_MONTH_KEY,
	RETIRED_STREAM,
	SETTLED_STREAMS,
	TRANSFER_STREAM,
	UNCERTAIN_STREAM,
	seedBillStreams,
	withOtherUserContext
} from './bills-seed';
import { formatMonthLabel } from '../src/lib/domain/dateFormat';
import * as m from '../src/lib/paraglide/messages';
import type { Locator, Page } from '@playwright/test';

// End-to-end verification of the "upcoming bills" feature: the dashboard widget and
// /upcoming-bills, rendered by a real browser against a real database. Everything the previous
// eight tasks shipped was proven by unit tests, typecheck and lint only — none of which loads a
// stylesheet, runs SvelteKit's client router, or issues a request as a second user. Each test below
// exists because one of those three is exactly what decides whether the claim holds.
//
// Period under test: `BILLS_MONTH_KEY`, the month the seed's anchor date falls in — the current
// month on most days, the previous one during its first days. It used to be "always the previous
// month", and task B1's staleness guard made that impossible: a projected row only exists for a few
// days after its estimated date, so every unsettled row this suite asserts sits within a week of
// today. The arithmetic is in e2e/bills-seed.ts's header; the anchor is derived, never hardcoded.
//
// Ordering matters and is declaration order (workers: 1, playwright.config.ts). The read-only
// assertions run before anything mutates, and every mutating test undoes its own actions so a
// Playwright retry re-runs against the state it expected.

const BILLS_MONTH_URL = `/upcoming-bills?month=${BILLS_MONTH_KEY}`;
const IGNORED_BANNER = m.bills_banner_ignored({
	month: formatMonthLabel(BILLS_MONTH_KEY, 'fr')
});

/** The one exception to "everything lives in the anchor's month", used by the remaining-total test
 *  below: a period that is OVER carries no "reste à sortir" figure on either header surface, so the
 *  claim that test makes has no rendering surface there. Identical to `BILLS_MONTH_URL` on every day
 *  but the first few of a month, and the test holds either way — `OVERDUE_GYM` is monthly, so the
 *  current month carries one of its unsettled occurrences whichever month the anchor landed in. */
const CURRENT_MONTH_URL = `/upcoming-bills?month=${CURRENT_MONTH_KEY}`;
const IGNORED_BANNER_CURRENT = m.bills_banner_ignored({
	month: formatMonthLabel(CURRENT_MONTH_KEY, 'fr')
});

test.beforeAll(async () => {
	await seedBillStreams();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function billRow(page: Page, display: string): Locator {
	return page.locator('#bills-list [role="listitem"]').filter({ hasText: display });
}

/** Mirrors `+page.svelte`'s `shiftMonth`, to compute the expected label after an arrow click. */
function shiftMonthKey(month: string, delta: number): string {
	const shifted = new Date(
		Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + delta, 1)
	);
	return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function rowMenuTrigger(row: Locator, display: string): Locator {
	return row.getByRole('button', { name: m.bills_row_menu_aria({ label: display }) });
}

/** The `aria-labelledby` of the status group a row currently sits in. */
async function groupOf(row: Locator): Promise<string | null> {
	return row.evaluate(
		(element) => element.closest('[role="list"]')?.getAttribute('aria-labelledby') ?? null
	);
}

async function activeElementInfo(page: Page) {
	return page.evaluate(() => {
		const element = document.activeElement as HTMLElement | null;
		const row = element?.closest('[role="listitem"]') as HTMLElement | null;
		return {
			tag: element?.tagName ?? null,
			id: element?.id ?? null,
			text: element?.textContent?.trim().slice(0, 80) ?? null,
			ariaLabel: element?.getAttribute('aria-label') ?? null,
			rowText: row?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ?? null
		};
	});
}

/**
 * Waits for focus to SETTLE on an element whose id matches, then returns what it settled on.
 *
 * Polled rather than read once: `focusAfterAction` deliberately spans two `tick()`s (it has to let
 * the period effect flush before it re-expands the settled group), so the instant the result banner
 * appears focus is legitimately still in transit. What the design guarantees is where focus ENDS
 * UP — and a target that is never rendered never arrives, which is exactly how the broken version
 * fails: the poll exhausts its timeout with `document.activeElement` on <body>.
 */
async function focusSettledOn(page: Page, idPattern: RegExp) {
	await expect
		.poll(async () => (await activeElementInfo(page)).id ?? '', { timeout: 5000 })
		.toMatch(idPattern);
	return activeElementInfo(page);
}

/**
 * Resolves the computed colours of an element to sRGB bytes by PAINTING them. Tailwind v4 emits
 * `oklch()`, which `getComputedStyle` hands back unchanged in Chromium — comparing that string to a
 * hex literal would prove nothing about what the user sees. A 1×1 canvas is the browser's own
 * conversion, so the numbers below are the pixels that actually ship.
 */
async function paintedColors(locator: Locator) {
	return locator.evaluate((element) => {
		const style = getComputedStyle(element);
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('no 2d context');

		const toRgb = (value: string): [number, number, number] => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = '#000000';
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			const data = context.getImageData(0, 0, 1, 1).data;
			return [data[0], data[1], data[2]];
		};

		return {
			color: toRgb(style.color),
			background: toRgb(style.backgroundColor),
			border: toRgb(style.borderTopColor),
			raw: {
				color: style.color,
				background: style.backgroundColor,
				border: style.borderTopColor
			}
		};
	});
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
	const channel = (value: number) => {
		const c = value / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
	const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

/** Cents parsed out of a rendered French currency string ("Reste \u00e0 sortir 1\u202f234,56\u202f\u20ac"). The
 *  group separator Intl emits for fr is U+202F, not a plain space. */
function parseCents(text: string): number {
	const match = text.match(/(\d[\d\s\u202f\u00a0.]*),(\d{2})/);
	if (!match) throw new Error(`no amount in "${text}"`);
	const units = Number(match[1].replace(/[\s\u202f\u00a0.]/g, ''));
	return units * 100 + Number(match[2]);
}

/** The period's "reste \u00e0 sortir" total, read off the mobile header line \u2014 the one place it appears
 *  as a lone figure. `textContent` does not require visibility, so this works on both breakpoints.
 *
 *  Only meaningful on a CURRENT or FUTURE period: on a month that is over both header surfaces drop
 *  the figure, because "reste \u00e0 sortir" is not a claim a finished period can make. Calling this on
 *  a month that is over throws out of `parseCents` rather than reading a stale number. */
async function remainingExpenseCents(page: Page): Promise<number> {
	const text = await page.locator('header p.lg\\:hidden').first().textContent();
	return parseCents(text ?? '');
}

/** The undo id the result banner is currently offering. Captured before a second action replaces
 *  it, so a test that performs two mutations can still clean both up. */
async function bannerActionId(page: Page): Promise<string> {
	return page.locator('#bill-undo-banner input[name="actionId"]').inputValue();
}

/**
 * Cleanup path for a test's own mutation. The result TYPE is asserted, not the HTTP status: a
 * SvelteKit `fail()` comes back as HTTP 200 with `{ type: 'failure', status: 404 }`, so checking
 * `response.ok()` here silently accepted a cleanup that deleted nothing — which is exactly what
 * happened while this suite was being written, and it leaked an ignored row into two later tests.
 */
async function undoViaApi(page: Page, actionId: string): Promise<void> {
	const response = await page.request.post('/upcoming-bills?/undoAction', {
		form: { actionId },
		headers: { Origin: E2E_BASE_URL }
	});
	expect((await response.json()) as { type: string }).toMatchObject({ type: 'success' });
}

/** Opens the row's "…" menu and selects an item. */
async function selectRowMenuItem(page: Page, display: string, item: string): Promise<void> {
	const trigger = rowMenuTrigger(billRow(page, display), display);
	await trigger.click();
	await page.getByRole('menuitem', { name: item }).click();
}

/** The settled group renders 3 rows on a fresh load; a row that landed past that cut is simply not
 *  in the DOM until this link is used. */
async function expandSettledGroup(page: Page): Promise<void> {
	const link = page.getByRole('button', { name: /^Afficher l/ });
	if ((await link.count()) > 0) await link.first().click();
}

/**
 * The colours a Tailwind utility actually paints in THIS build. Tailwind v4 ships its palette as
 * `oklch()`, and Chromium hands that back from `getComputedStyle` verbatim — so a hex literal in a
 * test would only ever prove that the author knew the v3 palette. Painting the utility on a throwaway
 * probe gives the same conversion the row itself gets, which makes "the row is bg-amber-50" a
 * statement about pixels rather than about class names.
 */
async function paintTailwind(page: Page, classes: string) {
	return page.evaluate((className) => {
		const probe = document.createElement('div');
		probe.className = className;
		probe.style.position = 'fixed';
		probe.style.left = '-9999px';
		probe.style.borderWidth = '1px';
		probe.style.borderStyle = 'solid';
		document.body.appendChild(probe);

		const style = getComputedStyle(probe);
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('no 2d context');
		const toRgb = (value: string): [number, number, number] => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = '#000000';
			context.fillStyle = value;
			context.fillRect(0, 0, 1, 1);
			const data = context.getImageData(0, 0, 1, 1).data;
			return [data[0], data[1], data[2]];
		};

		const result = {
			color: toRgb(style.color),
			background: toRgb(style.backgroundColor),
			border: toRgb(style.borderTopColor)
		};
		probe.remove();
		return result;
	}, classes);
}

// ─── Dashboard widget ───────────────────────────────────────────────────────

test.describe('Dashboard widget — footer horizon label (desktop 1280x800)', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('"Reste à sortir · 30 prochains jours" is fully visible, not merely present', async ({
		page
	}) => {
		await page.goto('/');

		const footer = page.getByText(m.dashboard_upcoming_footer_label(), { exact: true });
		await footer.scrollIntoViewIfNeeded();
		// A real visibility assertion on purpose: the unit test that pinned this decision passed with
		// the element at display:none, because no stylesheet is loaded in that environment.
		await expect(footer).toBeVisible();
		await expect(footer).toBeInViewport({ ratio: 1 });
		// ...and not silently truncated to an ellipsis, which `toBeVisible` would still accept.
		const overflow = await footer.evaluate((element) => element.scrollWidth - element.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
	});
});

test.describe('Dashboard widget — mobile 390x844', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the footer horizon label never folds away on mobile either', async ({ page }) => {
		await page.goto('/');

		const footer = page.getByText(m.dashboard_upcoming_footer_label(), { exact: true });
		await footer.scrollIntoViewIfNeeded();
		await expect(footer).toBeVisible();
		await expect(footer).toBeInViewport({ ratio: 1 });
		const overflow = await footer.evaluate((element) => element.scrollWidth - element.clientWidth);
		expect(overflow).toBeLessThanOrEqual(1);
	});

	test('rows past index 2 are hidden on mobile while still in the DOM (design A4: 3 rows)', async ({
		page
	}) => {
		await page.goto('/');

		// Innermost div carrying BOTH the widget heading and its footer label: the card itself.
		const card = page
			.locator('div')
			.filter({ has: page.getByRole('heading', { name: m.dashboard_upcoming_title() }) })
			.filter({ has: page.getByText(m.dashboard_upcoming_footer_label(), { exact: true }) })
			.last();
		const rows = card.locator('> div.divide-y > div');
		const total = await rows.count();
		expect(total).toBeGreaterThan(3);

		for (let index = 0; index < total; index++) {
			await expect(rows.nth(index)).toBeVisible({ visible: index < 3 });
		}
	});
});

// ─── /upcoming-bills, desktop ───────────────────────────────────────────────

test.describe('/upcoming-bills — desktop 1280x800', () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test('locked tier gate: an "Incertain" row whose estimated date is long past still reads "À venir", never "En retard"', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const row = billRow(page, UNCERTAIN_STREAM.display);
		await expect(row).toHaveCount(1);

		// Precondition, and independent of the gate itself: the row IS the uncertain tier. Its
		// projected date sits ~10 days in the past by construction (see UNCERTAIN_STREAM), which is
		// what makes the assertions below say something.
		await expect(row.getByText(m.bills_tier_uncertain(), { exact: true }).first()).toBeVisible();

		// The locked decision. Asserted BEFORE the "date estimée dépassée" line below on purpose:
		// removing the gate also removes that line (a lateness sub-line takes its place), so a test
		// that checked it first would go red one assertion too early and never exercise these.
		await expect(row.getByText(m.bills_status_upcoming(), { exact: true }).first()).toBeVisible();
		// Neither the badge, nor the sub-line under the date, nor the mobile badge.
		await expect(row.getByText(/En retard/)).toHaveCount(0);
		expect(await groupOf(row)).toBe('bills-group-upcoming');

		// ...and the date really is past, so "À venir" above is the gate holding rather than a row
		// that simply is not due yet.
		await expect(row.getByText(m.bills_date_estimate_passed(), { exact: true })).toBeVisible();
	});

	/**
	 * Item C, option D, end to end. The badge's chain is `CategoryNatureMapping` -> the effective
	 * nature `readDashboardDataForRange` computes -> `ForecastInputTransaction.nature` ->
	 * `RecurringFlow.nature` -> the row view -> `getNatureTag`. A unit test REPLACES the first two
	 * links with a fixture, so only a real run proves the resolution happens at all — the same
	 * reason `privileges.spec.ts` cannot see a wrong SQL predicate.
	 *
	 * Both halves of the decision are asserted together on purpose: the badge appears AND the row
	 * keeps counting. Splitting them would let a future "let's just exclude transfers" change keep
	 * one test green.
	 */
	test('a transfer stream carries the Transfert badge and still counts in "reste à sortir"', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const row = billRow(page, TRANSFER_STREAM.display);
		await expect(row).toHaveCount(1);

		await expect(row.getByText(m.nature_transfer(), { exact: true }).first()).toBeVisible();
		// Counted: "hors total" is the ONLY copy marking a row out of the period figure, and it is
		// absent here. The row is a confirmed overdue expense, so nothing else could exclude it.
		await expect(row.getByText(m.bills_amount_excluded())).toHaveCount(0);
		// And an ordinary expense stream in a category with no transfer/investment mapping carries
		// no badge at all — otherwise the assertion above would pass on a badge printed everywhere.
		await expect(
			billRow(page, OVERDUE_GYM.display).getByText(m.nature_transfer(), { exact: true })
		).toHaveCount(0);
	});

	test('the "!" important modifier on the uncertain tier badge actually wins over Badge\'s own colour', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const badge = billRow(page, UNCERTAIN_STREAM.display)
			.getByText(m.bills_tier_uncertain(), { exact: true })
			.first();
		const colors = await paintedColors(badge);

		// The `!text-zinc-400 !border-zinc-400` the page adds — not the palette entry a v3-era hex
		// literal would name, which is why the reference is painted rather than written down.
		const zinc400 = await paintTailwind(page, 'text-zinc-400 border-zinc-400');
		expect(colors.color).toEqual(zinc400.color);
		expect(colors.border).toEqual(zinc400.border);

		// ...and it genuinely OVERRODE something: an un-overridden neutral Badge on the same page is
		// a different colour. Without this the assertion above would also pass if Badge happened to
		// be zinc-400 already, i.e. if the `!` did nothing.
		const plainBadge = billRow(page, UNCERTAIN_STREAM.display)
			.getByText(m.bills_status_upcoming(), { exact: true })
			.first();
		expect((await paintedColors(plainBadge)).color).not.toEqual(colors.color);
	});

	test('a stream silent past the staleness threshold disappears from the list: no row, no badge, no message', async ({
		page
	}) => {
		// The design's SECOND exit for a stream (design spec section D: "le rythme ne se confirme pas
		// et le flux disparaît silencieusement de la liste, sans alerte ni message"). Task B1 made it
		// real via `isStreamStale`, and nothing covered it end to end — the tier-gate test above only
		// pins the other side of the same guard. Asserted on the month `RETIRED_STREAM`'s next
		// occurrence WOULD have fallen in, one cadence after its last real one.
		const response = await page.goto(`/upcoming-bills?month=${RETIRED_ABSENT_MONTH_KEY}`);
		expect(response?.status()).toBe(200);

		// The month is a populated one — every live stream has a real occurrence here — so "no row"
		// below is a statement about this stream and not about an empty page. The settled group is
		// collapsed on load, hence the expand.
		await expandSettledGroup(page);
		await expect(billRow(page, OVERDUE_GYM.display)).toHaveCount(1);

		// Silently: not a row, not a badge, not a sentence anywhere on the page.
		await expect(billRow(page, RETIRED_STREAM.display)).toHaveCount(0);
		await expect(page.getByText(RETIRED_STREAM.display)).toHaveCount(0);

		// ...and the absence is the staleness guard rather than "never detected": the stream's own
		// last REAL occurrence is a fact and still renders, in the month it happened in.
		await page.goto(`/upcoming-bills?month=${RETIRED_REALIZED_MONTH_KEY}`);
		await expandSettledGroup(page);
		const realized = billRow(page, RETIRED_STREAM.display);
		await expect(realized).toHaveCount(1);
		await expect(realized.getByText(m.bills_status_paid(), { exact: true }).first()).toBeVisible();
	});

	test('list semantics: every status group is a role="list" named by its own visible heading', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const lists = page.locator('#bills-list [role="list"]');
		const listCount = await lists.count();
		expect(listCount).toBeGreaterThan(1);

		for (let index = 0; index < listCount; index++) {
			const list = lists.nth(index);
			const labelledBy = await list.getAttribute('aria-labelledby');
			expect(labelledBy).toBeTruthy();

			const heading = page.locator(`#${labelledBy}`);
			// aria-labelledby is an ID LIST: an id containing whitespace would resolve to nothing and
			// this is where that would show up.
			await expect(heading).toHaveCount(1);
			await expect(heading).toBeVisible();
			await expect(heading).toHaveText(/·\s*\d+$/);

			const items = list.locator('[role="listitem"]');
			const itemCount = await items.count();
			expect(itemCount).toBeGreaterThan(0);
			for (let item = 0; item < itemCount; item++) {
				await expect(items.nth(item)).toBeVisible();
			}
		}

		// The settled group is the collapsible one: it renders 3 rows and says how many more exist.
		const settled = page.locator(
			'#bills-list [role="list"][aria-labelledby="bills-group-settled"]'
		);
		await expect(settled.locator('[role="listitem"]')).toHaveCount(3);
		const settledHeading = await page.locator('#bills-group-settled').textContent();
		expect(parseInt((settledHeading ?? '').replace(/\D+/g, ''), 10)).toBeGreaterThan(3);
	});

	test('the "…" row menu trigger meets the 44x44 tap target (minimum 24x24)', async ({ page }) => {
		await page.goto(BILLS_MONTH_URL);

		const trigger = rowMenuTrigger(billRow(page, OVERDUE_GYM.display), OVERDUE_GYM.display);
		const box = await trigger.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	});

	test('"Période suivante" changes the aria-live month label without moving focus off the control', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const label = page.locator('span[aria-live="polite"]');
		await expect(label).toHaveText(formatMonthLabel(BILLS_MONTH_KEY, 'fr'));

		const next = page.getByRole('link', { name: m.bills_period_next_aria() });
		await next.click();

		await expect(label).toHaveText(formatMonthLabel(shiftMonthKey(BILLS_MONTH_KEY, 1), 'fr'));

		const active = await activeElementInfo(page);
		expect(active.tag).toBe('A');
		expect(active.ariaLabel).toBe(m.bills_period_next_aria());
	});

	test('"Période précédente" changes the aria-live month label without moving focus off the control', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const label = page.locator('span[aria-live="polite"]');
		await expect(label).toHaveText(formatMonthLabel(BILLS_MONTH_KEY, 'fr'));

		const prev = page.getByRole('link', { name: m.bills_period_prev_aria() });
		await prev.click();

		await expect(label).toHaveText(formatMonthLabel(shiftMonthKey(BILLS_MONTH_KEY, -1), 'fr'));

		const active = await activeElementInfo(page);
		expect(active.tag).toBe('A');
		expect(active.ariaLabel).toBe(m.bills_period_prev_aria());
	});

	test('the desktop row is a 5-column grid and the mobile row is not rendered', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const row = billRow(page, OVERDUE_GYM.display);
		const desktop = row.locator(':scope > div').first();
		const mobile = row.locator(':scope > button');

		const columns = await desktop.evaluate(
			(element) => getComputedStyle(element).gridTemplateColumns
		);
		expect(columns.trim().split(/\s+/)).toHaveLength(5);
		await expect(mobile).toBeHidden();
	});

	test('the locked amber pairs render as specified (row 4.85:1, tier badge 6.1:1)', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const row = billRow(page, OVERDUE_WATER.display);
		expect(await groupOf(row)).toBe('bills-group-overdue');

		// Pair 1 — the row: text-amber-700 on bg-amber-50, i.e. #b45309 on #fffbeb in the design's
		// (v3) notation. Both sides are compared against the utility's OWN painted value: Tailwind v4
		// ships the palette in oklch, so amber-200 paints (254, 230, 133) rather than the #fde68a the
		// design writes. The ratio below is computed from the pixels either way, which is the number
		// the AA threshold is actually about.
		const amber50 = await paintTailwind(page, 'bg-amber-50 border-amber-200');
		const amber700 = await paintTailwind(page, 'text-amber-700');
		const rowColors = await paintedColors(row);
		expect(rowColors.background).toEqual(amber50.background);
		expect(rowColors.border).toEqual(amber50.border);

		const lateText = row.getByText(/de retard/).first();
		const lateColors = await paintedColors(lateText);
		expect(lateColors.color).toEqual(amber700.color);
		const rowRatio = contrastRatio(lateColors.color, rowColors.background);
		expect(rowRatio).toBeGreaterThanOrEqual(4.5);
		expect(rowRatio).toBeCloseTo(4.85, 1);

		// Pair 2 — the confidence badge sitting ON that overdue row: text-amber-800 on bg-amber-100
		// (#92400e on #fef3c7), a deliberately darker pair than the row's.
		const amber100 = await paintTailwind(page, 'bg-amber-100 text-amber-800');
		const badge = row.getByText(m.bills_tier_confirmed(), { exact: true }).first();
		const badgeColors = await paintedColors(badge);
		expect(badgeColors.color).toEqual(amber100.color);
		expect(badgeColors.background).toEqual(amber100.background);
		// Measured 6.36:1, not the 6.1:1 the design plate states. The plate's figure was computed on
		// Tailwind v3's #92400e / #fef3c7; v4's oklch palette paints (151, 60, 0) on (254, 243, 198),
		// which is slightly darker text and therefore a slightly HIGHER ratio. The accessibility
		// claim holds with room to spare, so the assertion is "at least what the design promised"
		// rather than an equality that would go red on a difference nobody can see.
		const badgeRatio = contrastRatio(badgeColors.color, badgeColors.background);
		expect(badgeRatio).toBeGreaterThanOrEqual(4.5);
		expect(badgeRatio).toBeGreaterThanOrEqual(6.1);
	});

	test('the loading skeleton stops pulsing under prefers-reduced-motion', async ({ page }) => {
		await page.route('**/__data.json*', async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			await route.continue();
		});

		try {
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.goto(BILLS_MONTH_URL);
			await page.getByRole('link', { name: m.bills_period_next_aria() }).click();

			const pulse = page.locator('[role="status"] .skeleton-pulse').first();
			await expect(pulse).toBeVisible();
			expect(await pulse.evaluate((element) => getComputedStyle(element).animationName)).toBe(
				'none'
			);

			// Same element, motion allowed: the check above is only a check if it can come out
			// differently.
			await page.emulateMedia({ reducedMotion: 'no-preference' });
			await page.goto(BILLS_MONTH_URL);
			await page.getByRole('link', { name: m.bills_period_next_aria() }).click();

			const pulsing = page.locator('[role="status"] .skeleton-pulse').first();
			await expect(pulsing).toBeVisible();
			expect(await pulsing.evaluate((element) => getComputedStyle(element).animationName)).not.toBe(
				'none'
			);
		} finally {
			await page.unroute('**/__data.json*');
			await page.emulateMedia({ reducedMotion: null });
		}
	});

	test('dismissing the ignore confirmation with Escape returns focus to the "…" trigger', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		await selectRowMenuItem(page, OVERDUE_GYM.display, m.bills_action_ignore());
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();

		const active = await activeElementInfo(page);
		expect(active.tag).not.toBe('BODY');
		expect(active.ariaLabel).toBe(m.bills_row_menu_aria({ label: OVERDUE_GYM.display }));
	});

	test('confirming an ignore moves focus to that row\'s "Rétablir" link, past the settled group\'s 3-row cut', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		// Precondition of the regression this covers: the settled group already holds more than the
		// three rows it renders collapsed, so the newly ignored row lands past the cut.
		const settledBefore = await page
			.locator('#bills-list [role="list"][aria-labelledby="bills-group-settled"] [role="listitem"]')
			.count();
		expect(settledBefore).toBe(3);
		expect(SETTLED_STREAMS.length).toBeGreaterThan(3);

		await selectRowMenuItem(page, OVERDUE_GYM.display, m.bills_action_ignore());
		await page
			.getByRole('dialog')
			.getByRole('button', { name: /Ignorer pour/ })
			.click();

		// Waiting on the RESULT BANNER, not on the focus target: the target's own absence is the
		// failure mode under test, so waiting for it would turn a focus bug into a timeout and hide
		// where focus actually went.
		await expect(page.getByRole('status').filter({ hasText: IGNORED_BANNER })).toBeVisible();
		const actionId = await bannerActionId(page);

		try {
			const active = await focusSettledOn(page, /^bill-restore-/);
			expect(active.tag).not.toBe('BODY');
			expect(active.text).toBe(m.bills_restore());
			expect(active.rowText).toContain(OVERDUE_GYM.display);
			await expect(billRow(page, OVERDUE_GYM.display).getByText(m.bills_restore())).toBeVisible();
		} finally {
			await undoViaApi(page, actionId);
		}
	});

	test('the undo banner is a role="status" carrying an "Annuler" that restores the row', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		await selectRowMenuItem(page, OVERDUE_GYM.display, m.bills_action_ignore());
		await page
			.getByRole('dialog')
			.getByRole('button', { name: /Ignorer pour/ })
			.click();

		const banner = page.getByRole('status').filter({ hasText: IGNORED_BANNER });
		await expect(banner).toBeVisible();
		const actionId = await bannerActionId(page);
		let undone = false;

		try {
			const undo = banner.getByRole('button', { name: m.bills_banner_undo() });
			await expect(undo).toBeVisible();
			await undo.click();
			undone = true;

			const row = billRow(page, OVERDUE_GYM.display);
			await expect(row.getByText(m.bills_restore())).toHaveCount(0);
			expect(await groupOf(row)).toBe('bills-group-overdue');
		} finally {
			// Only if the in-page undo above never ran (or never completed): the row would otherwise
			// still be ignored when the next test starts. A second undo of an already-undone action
			// 404s, so this must not run unconditionally the way the other tests' cleanup does.
			if (!undone) await undoViaApi(page, actionId);
		}
	});

	// The one test on the CURRENT month, and deliberately so: its subject is the "reste à sortir"
	// figure, which a period that is over does not print on either header surface. `OVERDUE_GYM`'s
	// last real occurrence is two months back, so the monthly projection puts an unsettled — hence
	// counted — occurrence in this month as well as in the previous one.
	test('ignoring an expense lowers "reste à sortir" by its amount, and undoing restores it', async ({
		page
	}) => {
		await page.goto(CURRENT_MONTH_URL);

		const before = await remainingExpenseCents(page);

		await selectRowMenuItem(page, OVERDUE_GYM.display, m.bills_action_ignore());
		await page
			.getByRole('dialog')
			.getByRole('button', { name: /Ignorer pour/ })
			.click();
		await expect(billRow(page, OVERDUE_GYM.display).getByText(m.bills_restore())).toBeVisible();
		const banner = page.getByRole('status').filter({ hasText: IGNORED_BANNER_CURRENT });
		const actionId = await bannerActionId(page);
		let undone = false;

		try {
			const after = await remainingExpenseCents(page);
			expect(before - after).toBe(Math.abs(OVERDUE_GYM.amountCents));

			await banner.getByRole('button', { name: m.bills_banner_undo() }).click();
			undone = true;
			await expect(billRow(page, OVERDUE_GYM.display).getByText(m.bills_restore())).toHaveCount(0);

			expect(await remainingExpenseCents(page)).toBe(before);
		} finally {
			// Same reasoning as the undo-banner test above: only clean up if the in-page undo never ran.
			if (!undone) await undoViaApi(page, actionId);
		}
	});

	test('marking an overdue occurrence paid clears the amber treatment and moves it to the settled group', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const row = billRow(page, OVERDUE_WATER.display);
		expect(await groupOf(row)).toBe('bills-group-overdue');
		expect((await paintedColors(row)).background).toEqual([255, 251, 235]);

		await row.getByRole('button', { name: m.bills_action_mark_paid_short() }).click();

		const settledRow = billRow(page, OVERDUE_WATER.display);
		await expect(
			settledRow.getByText(m.bills_status_paid(), { exact: true }).first()
		).toBeVisible();
		// Captured before the assertions: a leftover "paid" would silently change the shape of the
		// month every later test reads.
		const actionId = await bannerActionId(page);

		try {
			expect(await groupOf(settledRow)).toBe('bills-group-settled');
			// White again — the amber tint is the only tinted row treatment in the app.
			expect((await paintedColors(settledRow)).background).toEqual([255, 255, 255]);
			await expect(settledRow.getByText(/de retard/)).toHaveCount(0);
		} finally {
			await undoViaApi(page, actionId);
		}
	});

	test('two consecutive settling actions each land focus on their target, never on <body>', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		// 1) Mark paid — focus goes to the row itself, which has just moved into the collapsed
		//    settled group.
		await billRow(page, OVERDUE_WATER.display)
			.getByRole('button', { name: m.bills_action_mark_paid_short() })
			.click();
		// Same reason as above: wait for the banner, then look at where focus is.
		await expect(page.getByRole('status').filter({ hasText: m.bills_banner_paid() })).toBeVisible();

		const paidActionId = await bannerActionId(page);
		let ignoreActionId: string | null = null;

		try {
			const afterPaid = await focusSettledOn(page, /^bill-row-/);
			expect(afterPaid.tag).not.toBe('BODY');
			expect(afterPaid.rowText).toContain(OVERDUE_WATER.display);

			// 2) Ignore, WITHOUT reloading. `bills` (`+page.svelte:74`) gets a new identity from this
			//    `update()` too, so the `$effect` at `+page.svelte:107-110` resets `settledExpanded` to
			//    false again and this action goes through the SAME reveal path as the first — it is not
			//    exercising a branch the single-action test above cannot reach. What this test adds is a
			//    regression net over two consecutive mutations: it catches an ordering bug between
			//    `update()` and the period effect that only shows up on the second action.
			await selectRowMenuItem(page, OVERDUE_GYM.display, m.bills_action_ignore());
			await page
				.getByRole('dialog')
				.getByRole('button', { name: /Ignorer pour/ })
				.click();
			// Filtered on the IGNORE banner's own sentence, never on "Annuler": the mark-paid banner
			// above carries that word too and is still fading out at this instant, so the generic
			// filter matched it and read back the previous action's id.
			await expect(page.getByRole('status').filter({ hasText: IGNORED_BANNER })).toBeVisible();
			ignoreActionId = await bannerActionId(page);

			const afterIgnore = await focusSettledOn(page, /^bill-restore-/);
			expect(afterIgnore.tag).not.toBe('BODY');
			expect(afterIgnore.text).toBe(m.bills_restore());
			expect(afterIgnore.rowText).toContain(OVERDUE_GYM.display);
		} finally {
			if (ignoreActionId) await undoViaApi(page, ignoreActionId);
			await undoViaApi(page, paidActionId);
		}
	});

	test("another user cannot undo this user's action: 404, and the row is untouched", async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		await selectRowMenuItem(page, OVERDUE_GYM.display, m.bills_action_ignore());
		await page
			.getByRole('dialog')
			.getByRole('button', { name: /Ignorer pour/ })
			.click();
		await expect(billRow(page, OVERDUE_GYM.display).getByText(m.bills_restore())).toBeVisible();
		const actionId = await bannerActionId(page);
		expect(actionId).not.toBe('');

		try {
			const result = await withOtherUserContext(async (context) => {
				const response = await context.post('/upcoming-bills?/undoAction', {
					form: { actionId },
					maxRedirects: 0
				});
				return (await response.json()) as { type: string; status: number };
			});

			expect(result.type).toBe('failure');
			expect(result.status).toBe(404);

			// The `userId` conjunct of the deleteMany is what this proves: a query that lost it would
			// have deleted the row above and this reload would show an un-ignored occurrence. The
			// group has to be expanded first — a fresh load renders only its first three rows.
			await page.goto(BILLS_MONTH_URL);
			await expandSettledGroup(page);
			const row = billRow(page, OVERDUE_GYM.display);
			await expect(row.getByText(m.bills_restore())).toBeVisible();
			expect(await groupOf(row)).toBe('bills-group-settled');
		} finally {
			// Even on failure: a leftover ignore would move this row out of the group every later
			// test expects to find it in.
			await undoViaApi(page, actionId);
		}
	});
});

// ─── /upcoming-bills, mobile ────────────────────────────────────────────────

test.describe('/upcoming-bills — mobile 390x844', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('the row stacks: the desktop grid is not rendered and the whole row is one control', async ({
		page
	}) => {
		await page.goto(BILLS_MONTH_URL);

		const row = billRow(page, OVERDUE_GYM.display);
		await expect(row.locator(':scope > div').first()).toBeHidden();

		const mobile = row.locator(':scope > button');
		await expect(mobile).toBeVisible();

		await mobile.click();
		const sheet = page.getByRole('dialog', { name: OVERDUE_GYM.display });
		await expect(sheet).toBeVisible();
		for (const item of [
			m.bills_action_mark_paid(),
			m.bills_action_ignore(),
			m.bills_action_view_transactions(),
			m.bills_action_exclude()
		]) {
			const control = sheet.getByText(item, { exact: true });
			await expect(control).toBeVisible();
			expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
	});
});
