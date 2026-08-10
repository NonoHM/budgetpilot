// Generates the README's marketing screenshots from a realistic-looking FAKE demo dataset.
// NOT part of the app, NOT part of the test suites (excluded from every test glob), never
// touches dev.db / prisma/dev.db. Everything it creates (SQLite DB, storageState) lives under
// a scratch directory passed via SCRATCH_DIR and is deleted by the caller afterward — this
// script itself only ever writes screenshots into docs/screenshots/.
//
// Usage: SCRATCH_DIR=/path/to/scratch node scripts/demo-screenshots.mjs
//
// Mirrors e2e/global-setup.ts + e2e/seed.ts's pattern (throwaway DB, real HTTP form actions,
// never a direct Prisma insert) but seeds a richer, multi-month dataset meant to look good in
// screenshots rather than a minimal spec-coverage fixture.
//
// TWO THINGS HERE ARE LOAD-BEARING AND WERE BOTH LEARNED FROM THE SAME BAD IMAGE.
//
// The dataset is RELATIVE TO TODAY, never a fixed calendar. The first version of this script
// pinned every date to May-July 2026, so its output was correct on the day it ran and decayed
// silently from then on: `dashboard-desktop.png` shipped in the README for months showing a
// navigation bar with no "Upcoming bills" and a cash-flow card reading « +€0.00 projected by
// month end », because by capture time nothing recurring was still due before month end. Run
// today, that same script would have produced an EMPTY dashboard, the current month having no
// transactions at all. A screenshot generator with absolute dates has an expiry date nobody
// writes down.
//
// And it ASSERTS WHAT THE IMAGE IS SUPPOSED TO SHOW before writing the file, because that is
// the half nobody had. A generator that cannot fail always succeeds at producing something,
// and « something » is exactly how a forecast of zero became the product's headline image. The
// checks live in `assertDepicts*` below; each one names the state it is protecting.
import { chromium, request } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const SCRATCH_DIR = process.env.SCRATCH_DIR;
if (!SCRATCH_DIR) throw new Error('SCRATCH_DIR env var is required');

const PORT = 4175;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = path.join(SCRATCH_DIR, 'demo.db');
const STORAGE_STATE_PATH = path.join(SCRATCH_DIR, 'storageState.json');
const SCREENSHOT_DIR = path.resolve('docs/screenshots');

const DEMO_ADMIN_EMAIL = 'demo-bootstrap-admin@example.invalid';
const DEMO_ADMIN_PASSWORD = 'DemoBootstrapAdmin123!';
const DEMO_USER_EMAIL = 'demo@example.invalid';
const DEMO_USER_PASSWORD = 'DemoBudgetPilot123!';

const ENV = {
	...process.env,
	DATABASE_URL: `file:${DB_PATH}`,
	NODE_ENV: 'production',
	ORIGIN: BASE_URL,
	REGISTRATION_MODE: 'admin_only',
	PASSWORD_HASH_COST: '12',
	BOOTSTRAP_TOKEN: 'demo-fake-bootstrap-token-do-not-reuse',
	RATE_LIMIT_HASH_SECRET: 'f'.repeat(64),
	TOTP_ENCRYPTION_KEY: 'a'.repeat(64),
	PUBLIC_INSTANCE: 'false',
	LLM_ENABLED: 'false',
	BANK_SYNC_ENABLED: 'false',
	SESSION_TTL_DAYS: '1'
};

async function main() {
	// Full recreation on every run (never reused across runs) — same discipline as
	// e2e/global-setup.ts: a leftover DB from a previous (possibly failed) run would already
	// have the demo user registered, breaking the bootstrap-admin flow below.
	rmSync(SCRATCH_DIR, { recursive: true, force: true });
	mkdirSync(SCRATCH_DIR, { recursive: true });
	mkdirSync(SCREENSHOT_DIR, { recursive: true });

	console.log('[demo] applying migrations to throwaway DB...');
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: ENV, stdio: 'inherit' });

	console.log('[demo] building app...');
	execFileSync('npm', ['run', 'build'], { env: ENV, stdio: 'inherit' });

	console.log('[demo] starting preview server...');
	// `detached: true` makes this process the leader of its own process group — npm itself
	// spawns vite as a further child, so a plain server.kill() would only ever reach the npm
	// wrapper and orphan the real vite preview process. Killing the whole group (negative pid)
	// takes both down.
	const server = spawn('npm', ['run', 'preview', '--', '--port', String(PORT), '--strictPort'], {
		env: ENV,
		stdio: 'inherit',
		detached: true
	});
	server.on('exit', (code) => {
		if (code !== null && code !== 0) console.error(`[demo] preview server exited with ${code}`);
	});

	try {
		await waitForServer(`${BASE_URL}/login`);
		await seedDemoData();
		await captureScreenshots();
	} finally {
		try {
			process.kill(-server.pid, 'SIGTERM');
		} catch {
			// already gone
		}
	}
}

async function waitForServer(url, timeoutMs = 60_000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`demo server never became reachable at ${url}`);
}

// ---- Seeding (real HTTP form actions only, same discipline as e2e/seed.ts) ----

async function submitForm(ctx, formPath, fields) {
	const res = await ctx.post(formPath, { form: fields, maxRedirects: 0 });
	const body = await res.json();
	if (body.type !== 'success' && body.type !== 'redirect') {
		throw new Error(`demo seed: POST ${formPath} failed (${body.type}, status ${body.status})`);
	}
	return body;
}

async function seedDemoData() {
	console.log('[demo] seeding demo dataset...');
	const bootstrapCtx = await request.newContext({
		baseURL: BASE_URL,
		extraHTTPHeaders: { Origin: BASE_URL }
	});
	try {
		// First user on a fresh DB becomes ADMIN; used only to create the real demo user, then
		// discarded (never persisted to storageState), same pattern as e2e/seed.ts.
		await submitForm(bootstrapCtx, '/register', {
			email: DEMO_ADMIN_EMAIL,
			password: DEMO_ADMIN_PASSWORD,
			bootstrapToken: ENV.BOOTSTRAP_TOKEN
		});
		await submitForm(bootstrapCtx, '/register', {
			email: DEMO_USER_EMAIL,
			password: DEMO_USER_PASSWORD,
			bootstrapToken: ENV.BOOTSTRAP_TOKEN
		});
	} finally {
		await bootstrapCtx.dispose();
	}

	const ctx = await request.newContext({
		baseURL: BASE_URL,
		extraHTTPHeaders: { Origin: BASE_URL }
	});
	try {
		await submitForm(ctx, '/login', { email: DEMO_USER_EMAIL, password: DEMO_USER_PASSWORD });

		for (const tx of TRANSACTIONS) {
			await submitForm(ctx, '/?/createTransaction', tx);
		}

		for (const budget of BUDGETS) {
			await submitForm(ctx, '/budgets?/create', budget);
		}

		// Net worth: only the FIRST (oldest) history point is created here via HTTP. The
		// remaining points are added later through the real edit modal in a browser (see
		// extendNetWorthHistory below) — the create/update actions never echo the new row's id
		// back to a plain form POST, and scraping it out of HTML would be fragile, so driving
		// the actual UI is both simpler and more representative.
		for (const account of NET_WORTH_ACCOUNTS) {
			const [first] = account.history;
			await submitForm(ctx, '/net-worth?/create', {
				name: account.name,
				type: account.type,
				balance: first.balance,
				asOfDate: first.asOfDate
			});
		}

		await submitForm(ctx, '/net-worth?/createSavingsGoal', SAVINGS_GOAL);

		await ctx.storageState({ path: STORAGE_STATE_PATH });
	} finally {
		await ctx.dispose();
	}
}

// Builds each account's remaining balance history points by driving the real "edit account"
// modal in a browser (desktop viewport, so the non-`lg:hidden` edit button is the one in the
// accessibility tree) — every edit with a changed balance/asOfDate writes a new NetWorthSnapshot
// server-side (server/net-worth/service.ts), giving the chart real history to render.
async function extendNetWorthHistory(page) {
	for (const account of NET_WORTH_ACCOUNTS) {
		for (const point of account.history.slice(1)) {
			await page.getByRole('button', { name: `Edit ${account.name}`, exact: true }).click();
			// Name-attribute locators (not getByLabel): the date field's accessible name
			// includes its hint text, which was observed to make Playwright's label-substring
			// matching ambiguous between the two fields.
			await page.locator('input[name="balance"]').fill(point.balance);
			await page.locator('input[name="asOfDate"]').fill(point.asOfDate);
			await page.getByRole('button', { name: 'Update' }).click();
			await page.waitForTimeout(400);
		}
	}
}

// ---- Screenshot capture ----

/**
 * These images are the English-facing ones, and « the locale is set » is not the same statement
 * as « the page rendered in it ». The cookie is written by client JS on first visit in the real
 * app, the header is only a fallback, and a capture in the wrong language looks entirely normal
 * to anyone not reading the words. So the language is read back off the document itself.
 */
async function assertEnglish(page, where) {
	const lang = await page.locator('html').getAttribute('lang');
	if (lang !== 'en') throw new Error(`[demo] ${where} rendered with lang="${lang}", expected "en"`);
	if (await page.getByRole('link', { name: 'Dashboard', exact: true }).count()) return;
	if (await page.getByRole('heading', { name: /Dashboard|Budgets|Net worth/ }).count()) return;
	throw new Error(`[demo] ${where} has lang="en" but no English navigation or heading`);
}

/**
 * The forecast card's whole claim is that the app projects a balance. A zero delta means it had
 * nothing left to project, which reads on the image as a product that forecasts nothing — and
 * that is the exact defect this assertion exists to stop shipping again. The two empty states
 * are checked by name as well, since either would produce a card with no number at all.
 */
async function assertDepictsWorkingForecast(page) {
	for (const absent of ['Not enough recurring flows', 'Dormant recurring flows']) {
		if (await page.getByText(absent).count()) {
			throw new Error(`[demo] dashboard shows "${absent}" — the seeded streams were not detected`);
		}
	}
	const kpi = await page.getByText('projected by month end').locator('xpath=..').innerText();
	const delta = kpi.replace(/projected by month end/, '').trim();
	if (/^[+-]?€?0[.,]00$/.test(delta)) {
		throw new Error(
			`[demo] the forecast delta is ${delta}. Every recurring stream is already past for this ` +
				`month, so there is nothing left to project — this is the "+€0.00" image. Re-run on a ` +
				`day that is not the last of the month.`
		);
	}
	console.log(`[demo] forecast delta: ${delta}`);
}

/**
 * The assertions above read the DOM, which says nothing about what lands inside the PNG. This
 * one closes that gap for the card the image exists to show, by comparing its box against the
 * captured area rather than trusting that a full-page capture reached it.
 */
async function assertForecastCardIsInFrame(page) {
	const box = await page.getByText('projected by month end').boundingBox();
	const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
	if (!box || box.y + box.height > pageHeight) {
		throw new Error('[demo] the cash-flow card is not inside the captured area');
	}
	console.log(`[demo] forecast card at y=${Math.round(box.y)} of ${pageHeight}px captured`);
}

/**
 * « Income €0.00 » above a month of expenses reads as an app that only records spending. Same
 * family as the zero forecast: a true figure, correctly computed, depicting the product badly.
 */
async function assertDepictsIncome(page) {
	const income = await page.getByText('Income', { exact: true }).locator('xpath=..').innerText();
	if (/€0[.,]00/.test(income)) {
		throw new Error(
			`[demo] the dashboard's income KPI is zero (${income.replace(/\n/g, ' ')}). This month's ` +
				`salary has not been seeded as already received.`
		);
	}
}

/** A budgets image has to show both sides of the feature, or it teaches only half of it. */
async function assertDepictsBudgetsBothWays(page) {
	const over = await page.getByText(/Over by/).count();
	const remaining = await page.getByText(/remaining/).count();
	if (!over || !remaining) {
		throw new Error(
			`[demo] budgets page shows ${over} over-budget and ${remaining} under-budget rows; ` +
				`the image is meant to show at least one of each`
		);
	}
}

/** The net worth image is about the history chart, which needs more than one point to exist. */
async function assertDepictsNetWorthHistory(page) {
	const points = await page.locator('svg circle, svg path[d]').count();
	if (points < 2) {
		throw new Error(`[demo] net worth page has no history chart to show (${points} svg nodes)`);
	}
}

// One convention for every screenshot in this repo: `<state>-<viewport>.png`, desktop being
// 1920x1080 and mobile 393x852. See docs/screenshots/README.md.
const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };

/**
 * The repeat merchant is only useful as a landmark if it is where the reader's eye lands, so
 * its position is asserted rather than hoped for: today's visit must be the first row of
 * "Recent transactions". Insertion order does not decide this — see `elapsedDays`, which stops
 * the day before today precisely so there is no tie to break.
 */
async function assertPaulIsFirst(page) {
	// `divide-y divide-zinc-100` is the row list, and three cards on this page use it, so the
	// card is resolved through its own title rather than through the class alone.
	const card = page
		.locator('div')
		.filter({ has: page.getByText('Recent transactions', { exact: true }) })
		.filter({ has: page.locator('.divide-y') })
		.last();
	const first = await card.locator('.divide-y > div').first().innerText();
	if (!/PAUL/.test(first)) {
		throw new Error(
			`[demo] the first recent transaction is not PAUL: ${first.replace(/\n/g, ' | ')}`
		);
	}
	console.log(`[demo] first row: ${first.replace(/\n/g, ' · ')}`);
}

/**
 * These two pages are short, so a viewport capture is mostly white below the last card — and
 * the README renders them side by side at 49% width, where that emptiness is the largest thing
 * in the image. Clip to where the content actually ends instead of to the viewport.
 */
async function captureContent(page, fileName) {
	const bottom = await page.evaluate(() => {
		const root = document.querySelector('main') ?? document.body;
		let lowest = 0;
		for (const el of root.querySelectorAll('*')) {
			const box = el.getBoundingClientRect();
			if (box.width > 0 && box.height > 0) lowest = Math.max(lowest, box.bottom);
		}
		return Math.ceil(lowest + window.scrollY);
	});
	const height = Math.min(DESKTOP_VIEWPORT.height, bottom + 32);
	await page.screenshot({
		path: path.join(SCREENSHOT_DIR, fileName),
		clip: { x: 0, y: 0, width: DESKTOP_VIEWPORT.width, height }
	});
	console.log(`[demo] ${fileName}: ${DESKTOP_VIEWPORT.width}x${height}`);
}

async function captureScreenshots() {
	console.log('[demo] capturing screenshots...');
	const browser = await chromium.launch();
	try {
		const desktop = await browser.newContext({
			storageState: STORAGE_STATE_PATH,
			viewport: DESKTOP_VIEWPORT,
			deviceScaleFactor: 1
		});
		// Both channels, deliberately. The cookie is what the app reads; `Accept-Language` is what
		// it would negotiate from if the cookie were ever missing, and leaving them to disagree is
		// how a capture ends up in a locale nobody chose.
		await desktop.setExtraHTTPHeaders({ 'Accept-Language': 'en' });
		await desktop.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: BASE_URL }]);
		const desktopPage = await desktop.newPage();

		// SEEDING FINISHES BEFORE ANY CAPTURE BEGINS. This used to run further down, just before
		// the net worth shot, and the cost was invisible in that image and visible in the other:
		// the forecast anchors on the balance of the accounts, so the dashboard was captured
		// against each account's FIRST history point and reported « Estimated balance €2,206.01 »
		// while net-worth-desktop.png, taken minutes later from the same database, showed the
		// checking account at €4,450.00. Neither figure was wrong; they were taken of two
		// different moments and published side by side.
		await gotoAndSettle(desktopPage, '/net-worth');
		await extendNetWorthHistory(desktopPage);

		await gotoAndSettle(desktopPage, '/');
		await assertEnglish(desktopPage, 'dashboard');
		await assertPaulIsFirst(desktopPage);
		await assertDepictsIncome(desktopPage);
		await assertDepictsWorkingForecast(desktopPage);
		// Full page, not the viewport. At 1920 the right column runs past 1080, so a viewport
		// capture cuts the recent-transactions list mid-row and leaves the cash-flow card out of
		// the frame entirely — which would put the image back in the position this whole change
		// exists to fix: an assertion passing on a card the reader cannot see.
		await assertForecastCardIsInFrame(desktopPage);
		await desktopPage.screenshot({
			path: path.join(SCREENSHOT_DIR, 'dashboard-desktop.png'),
			fullPage: true
		});

		await gotoAndSettle(desktopPage, '/budgets');
		await assertEnglish(desktopPage, 'budgets');
		await assertDepictsBudgetsBothWays(desktopPage);
		await captureContent(desktopPage, 'budgets-desktop.png');

		await gotoAndSettle(desktopPage, '/net-worth');
		await assertEnglish(desktopPage, 'net worth');
		await assertDepictsNetWorthHistory(desktopPage);
		await captureContent(desktopPage, 'net-worth-desktop.png');

		await desktop.close();
	} finally {
		await browser.close();
	}
}

async function gotoAndSettle(page, urlPath) {
	await page.goto(`${BASE_URL}${urlPath}`);
	await page.waitForLoadState('networkidle');
}

// ---- Fake demo dataset (all fictional merchants/amounts), anchored on TODAY ----

// UTC throughout, deliberately. Every date the app stores and every date a capture reports
// comes from `toISOString().slice(0, 10)`, so anchoring on local time would put the seed and
// the app's own "current month" on different sides of midnight for part of each day.
const NOW = new Date();
const TODAY_Y = NOW.getUTCFullYear();
const TODAY_M = NOW.getUTCMonth();
const TODAY_D = NOW.getUTCDate();

const lastDayOf = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** ISO date for `day` of the month `monthsBack` months before this one, clamped to that month. */
function iso(monthsBack, day) {
	const d = new Date(Date.UTC(TODAY_Y, TODAY_M - monthsBack, 1));
	const y = d.getUTCFullYear();
	const m = d.getUTCMonth();
	return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(day, lastDayOf(y, m))).padStart(2, '0')}`;
}

/**
 * The three recurring streams are placed on days that are STILL AHEAD of today, which is the
 * whole reason the forecast card has a number to show: its horizon is the end of the current
 * month, so a stream whose monthly date has already passed contributes nothing to the delta.
 * That is what « +€0.00 projected by month end » was — not a broken forecast, a correct one
 * asked at the wrong moment.
 *
 * On the last day of a month there is no room left and `assertDepictsWorkingForecast` fails
 * loudly rather than writing a repeat of that image. Run it any other day.
 */
const dayAhead = (offset) => Math.min(TODAY_D + offset, lastDayOf(TODAY_Y, TODAY_M));
const RENT_DAY = dayAhead(2);
const SUBSCRIPTION_DAY = dayAhead(5);

/**
 * The salary is the exception, and for the mirror-image reason: it is paid on the 1st, so this
 * month's has already landed and the dashboard's INCOME figure has something in it. Putting it
 * ahead with the other two produced « Income €0.00 » on the headline image, which is the same
 * defect as the zero forecast wearing different clothes. Both are asserted below.
 */
const SALARY_DAY = 1;

/**
 * Spreads `count` days evenly across the part of the current month that has already happened,
 * stopping the day BEFORE today so that today belongs to `PAUL_VISITS` alone and the top of
 * the dashboard's list is not decided by an insertion-order tiebreak. Early in a month there is
 * little room and days repeat, which is realistic enough; what must not happen is a transaction
 * dated in the future, so the range never passes today.
 */
function elapsedDays(count) {
	const lastDay = Math.max(1, TODAY_D - 1);
	if (lastDay === 1) return Array.from({ length: count }, () => 1);
	return Array.from({ length: count }, (_, i) =>
		Math.max(1, Math.round(1 + (i * (lastDay - 1)) / (count - 1)))
	);
}

const CURRENT_MONTH_DAYS = elapsedDays(10);
const onDay = (index) => iso(0, CURRENT_MONTH_DAYS[index]);

const daysAgo = (n) => new Date(Date.UTC(TODAY_Y, TODAY_M, TODAY_D - n)).toISOString().slice(0, 10);

/**
 * A repeat merchant, so that every capture that shows a list shows the same one and the images
 * read as one instance of the app rather than several. `assertPaulIsFirst` pins today's visit
 * as the most recent, so it cannot quietly slide down the list.
 *
 * The 21-day spacing is NOT an accident. The detector's cadence windows are weekly 7±2,
 * biweekly 14±3 and monthly 30±5, and 21 falls in the gap between the last two, so these
 * visits are frequent without ever being classified as a recurring stream — which would add a
 * fourth row to the upcoming-bills card and crowd out the three flows the forecast image is
 * about. The amounts vary for the same reason.
 */
const PAUL_VISITS = [
	{ date: daysAgo(0), amount: '-32.80' },
	{ date: daysAgo(21), amount: '-27.40' },
	{ date: daysAgo(42), amount: '-18.90' },
	{ date: daysAgo(63), amount: '-31.20' }
].map((visit) => ({ ...visit, label: 'PAUL', category: 'Alimentation' }));

const RECURRING = [
	// Three confirmed monthly streams: the dashboard's forecast needs at least three at high or
	// medium confidence, and each needs enough occurrences to be classified as monthly at all.
	...[3, 2, 1, 0].map((back) => ({
		date: iso(back, SALARY_DAY),
		label: 'Demo Corp Salary',
		amount: '2850.00',
		category: 'Revenus'
	})),
	...[3, 2, 1].map((back) => ({
		date: iso(back, RENT_DAY),
		label: 'Apartment Rent',
		amount: '-980.00',
		category: 'Logement'
	})),
	...[3, 2, 1].map((back) => ({
		date: iso(back, SUBSCRIPTION_DAY),
		label: 'StreamFlix Subscription',
		amount: '-13.99',
		category: 'Abonnements'
	}))
];

const TRANSACTIONS = [
	...RECURRING,

	// Two months back
	{ date: iso(2, 4), label: 'CORNER MARKET', amount: '-58.20', category: 'Alimentation' },
	{ date: iso(2, 19), label: 'CORNER MARKET', amount: '-61.10', category: 'Alimentation' },
	{ date: iso(2, 11), label: 'CITY TRANSIT PASS', amount: '-29.90', category: 'Transport' },
	{ date: iso(2, 14), label: 'THE CORNER BISTRO', amount: '-40.00', category: 'Restauration' },
	{ date: iso(2, 21), label: 'BOOKS & TECH STORE', amount: '-29.99', category: 'Shopping' },
	{ date: iso(2, 25), label: 'PINEWOOD CAMPGROUND', amount: '-120.00', category: 'Voyage' },

	// Last month
	{ date: iso(1, 6), label: 'CORNER MARKET', amount: '-70.40', category: 'Alimentation' },
	{ date: iso(1, 20), label: 'CORNER MARKET', amount: '-55.00', category: 'Alimentation' },
	{ date: iso(1, 9), label: 'CITY TRANSIT PASS', amount: '-31.50', category: 'Transport' },
	{ date: iso(1, 16), label: 'UBER', amount: '-18.00', category: 'Transport' },
	{ date: iso(1, 12), label: 'THE CORNER BISTRO', amount: '-48.00', category: 'Restauration' },
	{ date: iso(1, 23), label: 'DOWNTOWN CINEMA', amount: '-12.50', category: 'Loisirs' },
	{ date: iso(1, 27), label: 'CENTRAL PHARMACY', amount: '-22.00', category: 'Santé' },
	{ date: iso(1, 29), label: 'SPORTS OUTFITTERS', amount: '-60.00', category: 'Shopping' },

	// This month, so far. Fixed amounts whatever the spread, because the two budgets below are
	// calibrated against these totals: Alimentation 149.22 of 300 (including today's PAUL),
	// Restauration 115.50 of 80.
	{ date: onDay(0), label: 'CORNER MARKET', amount: '-64.32', category: 'Alimentation' },
	{ date: onDay(1), label: 'THE CORNER BISTRO', amount: '-45.00', category: 'Restauration' },
	{ date: onDay(2), label: 'CENTRAL PHARMACY', amount: '-18.90', category: 'Santé' },
	{ date: onDay(3), label: 'SPORTS OUTFITTERS', amount: '-55.00', category: 'Shopping' },
	{ date: onDay(4), label: 'CITY TRANSIT PASS', amount: '-34.90', category: 'Transport' },
	{ date: onDay(5), label: 'THE CORNER BISTRO', amount: '-38.50', category: 'Restauration' },
	{ date: onDay(6), label: 'DOWNTOWN CINEMA', amount: '-12.50', category: 'Loisirs' },
	{ date: onDay(7), label: 'CORNER MARKET', amount: '-52.10', category: 'Alimentation' },
	{ date: onDay(8), label: 'SUSHI HOUSE', amount: '-32.00', category: 'Restauration' },
	{ date: onDay(9), label: 'UBER', amount: '-15.20', category: 'Transport' },

	...PAUL_VISITS
];

const BUDGETS = [
	// Under: 149.22 € spent this month against a 300 € limit.
	{ category: 'Alimentation', amount: '300' },
	// Over: 115.50 € spent this month against an 80 € limit. One of each is the point — a
	// budgets screenshot where nothing is over teaches nothing about what over looks like.
	{ category: 'Restauration', amount: '80' }
];

const NET_WORTH_ACCOUNTS = [
	{
		name: 'Demo Checking Account',
		type: 'checking',
		history: [
			{ asOfDate: iso(3, 1), balance: '3200', type: 'checking' },
			{ asOfDate: iso(2, 1), balance: '3600', type: 'checking' },
			{ asOfDate: iso(1, 1), balance: '4100', type: 'checking' },
			{ asOfDate: iso(0, TODAY_D), balance: '4450', type: 'checking' }
		]
	},
	{
		name: 'Demo Savings Account',
		type: 'savings',
		history: [
			{ asOfDate: iso(3, 1), balance: '5000', type: 'savings' },
			{ asOfDate: iso(2, 1), balance: '5300', type: 'savings' },
			{ asOfDate: iso(1, 1), balance: '5600', type: 'savings' },
			{ asOfDate: iso(0, TODAY_D), balance: '5800', type: 'savings' }
		]
	}
];

const SAVINGS_GOAL = {
	name: 'Demo Vacation Fund',
	targetAmount: '10000',
	trackingMode: 'manual',
	currentAmount: '5800'
};

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
