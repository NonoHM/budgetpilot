// One-off, throwaway script to generate README screenshots from a realistic-looking FAKE
// demo dataset. NOT part of the app, NOT part of the test suites (excluded from every
// test glob), never touches dev.db / prisma/dev.db. Everything it creates (SQLite DB,
// storageState) lives under a scratch directory passed via SCRATCH_DIR and is deleted by the
// caller afterward — this script itself only ever writes screenshots into docs/screenshots/.
//
// Usage: SCRATCH_DIR=/path/to/scratch node scripts/demo-screenshots.mjs
//
// Mirrors e2e/global-setup.ts + e2e/seed.ts's pattern (throwaway DB, real HTTP form actions,
// never a direct Prisma insert) but seeds a richer, multi-month dataset meant to look good in
// screenshots rather than a minimal spec-coverage fixture.
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

async function captureScreenshots() {
	console.log('[demo] capturing screenshots...');
	const browser = await chromium.launch();
	try {
		const desktop = await browser.newContext({
			storageState: STORAGE_STATE_PATH,
			viewport: { width: 1440, height: 960 },
			deviceScaleFactor: 1
		});
		await desktop.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: BASE_URL }]);
		const desktopPage = await desktop.newPage();

		await gotoAndSettle(desktopPage, '/');
		await desktopPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'dashboard-desktop.png') });

		await gotoAndSettle(desktopPage, '/transactions');
		await desktopPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'transactions.png') });

		await gotoAndSettle(desktopPage, '/budgets');
		await desktopPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'budgets.png') });

		await gotoAndSettle(desktopPage, '/net-worth');
		await extendNetWorthHistory(desktopPage);
		await gotoAndSettle(desktopPage, '/net-worth');
		await desktopPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'net-worth.png') });

		const goalCard = desktopPage.getByRole('button', { name: new RegExp(SAVINGS_GOAL.name) });
		if (await goalCard.count()) {
			await goalCard.first().click();
			await desktopPage.waitForTimeout(300);
			await desktopPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'savings-goal-detail.png') });
		} else {
			console.warn('[demo] savings goal card not found, skipping detail screenshot');
		}

		await desktop.close();

		const mobile = await browser.newContext({
			storageState: STORAGE_STATE_PATH,
			viewport: { width: 390, height: 844 },
			deviceScaleFactor: 1
		});
		await mobile.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: BASE_URL }]);
		const mobilePage = await mobile.newPage();
		await gotoAndSettle(mobilePage, '/');
		await mobilePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'dashboard-mobile.png') });
		await mobile.close();
	} finally {
		await browser.close();
	}
}

async function gotoAndSettle(page, urlPath) {
	await page.goto(`${BASE_URL}${urlPath}`);
	await page.waitForLoadState('networkidle');
}

// ---- Fake demo dataset (all fictional merchants/amounts) ----

const TRANSACTIONS = [
	// Recurring flows (3 monthly occurrences each) so the cash-flow forecast has something to
	// detect and project.
	{ date: '2026-05-01', label: 'Demo Corp Salary', amount: '2850.00', category: 'Revenus' },
	{ date: '2026-06-01', label: 'Demo Corp Salary', amount: '2850.00', category: 'Revenus' },
	{ date: '2026-07-01', label: 'Demo Corp Salary', amount: '2850.00', category: 'Revenus' },
	{ date: '2026-05-05', label: 'Apartment Rent', amount: '-980.00', category: 'Logement' },
	{ date: '2026-06-05', label: 'Apartment Rent', amount: '-980.00', category: 'Logement' },
	{ date: '2026-07-05', label: 'Apartment Rent', amount: '-980.00', category: 'Logement' },
	{
		date: '2026-05-08',
		label: 'StreamFlix Subscription',
		amount: '-13.99',
		category: 'Abonnements'
	},
	{
		date: '2026-06-08',
		label: 'StreamFlix Subscription',
		amount: '-13.99',
		category: 'Abonnements'
	},
	{
		date: '2026-07-08',
		label: 'StreamFlix Subscription',
		amount: '-13.99',
		category: 'Abonnements'
	},

	// May
	{ date: '2026-05-04', label: 'CORNER MARKET', amount: '-58.20', category: 'Alimentation' },
	{ date: '2026-05-19', label: 'CORNER MARKET', amount: '-61.10', category: 'Alimentation' },
	{ date: '2026-05-11', label: 'CITY TRANSIT PASS', amount: '-29.90', category: 'Transport' },
	{
		date: '2026-05-14',
		label: 'THE CORNER BISTRO',
		amount: '-40.00',
		category: 'Restauration'
	},
	{ date: '2026-05-21', label: 'BOOKS & TECH STORE', amount: '-29.99', category: 'Shopping' },
	{ date: '2026-05-25', label: 'PINEWOOD CAMPGROUND', amount: '-120.00', category: 'Voyage' },

	// June
	{ date: '2026-06-06', label: 'CORNER MARKET', amount: '-70.40', category: 'Alimentation' },
	{ date: '2026-06-20', label: 'CORNER MARKET', amount: '-55.00', category: 'Alimentation' },
	{ date: '2026-06-09', label: 'CITY TRANSIT PASS', amount: '-31.50', category: 'Transport' },
	{ date: '2026-06-16', label: 'UBER', amount: '-18.00', category: 'Transport' },
	{
		date: '2026-06-12',
		label: 'THE CORNER BISTRO',
		amount: '-48.00',
		category: 'Restauration'
	},
	{ date: '2026-06-23', label: 'DOWNTOWN CINEMA', amount: '-12.50', category: 'Loisirs' },
	{ date: '2026-06-27', label: 'CENTRAL PHARMACY', amount: '-22.00', category: 'Santé' },
	{ date: '2026-06-29', label: 'SPORTS OUTFITTERS', amount: '-60.00', category: 'Shopping' },

	// July (current month — drives budgets and the dashboard's monthly insights)
	{ date: '2026-07-03', label: 'CORNER MARKET', amount: '-64.32', category: 'Alimentation' },
	{ date: '2026-07-10', label: 'CORNER BAKERY', amount: '-8.50', category: 'Alimentation' },
	{ date: '2026-07-18', label: 'CORNER MARKET', amount: '-52.10', category: 'Alimentation' },
	{
		date: '2026-07-06',
		label: 'THE CORNER BISTRO',
		amount: '-45.00',
		category: 'Restauration'
	},
	{
		date: '2026-07-14',
		label: 'THE CORNER BISTRO',
		amount: '-38.50',
		category: 'Restauration'
	},
	{ date: '2026-07-20', label: 'SUSHI HOUSE', amount: '-32.00', category: 'Restauration' },
	{ date: '2026-07-12', label: 'CITY TRANSIT PASS', amount: '-34.90', category: 'Transport' },
	{ date: '2026-07-22', label: 'UBER', amount: '-15.20', category: 'Transport' },
	{ date: '2026-07-15', label: 'DOWNTOWN CINEMA', amount: '-12.50', category: 'Loisirs' },
	{ date: '2026-07-09', label: 'CENTRAL PHARMACY', amount: '-18.90', category: 'Santé' },
	{ date: '2026-07-24', label: 'SPORTS OUTFITTERS', amount: '-55.00', category: 'Shopping' }
];

const BUDGETS = [
	// Under: ~125€ spent in July vs 300€ limit.
	{ category: 'Alimentation', amount: '300' },
	// Over: ~115.5€ spent in July vs 80€ limit.
	{ category: 'Restauration', amount: '80' }
];

const NET_WORTH_ACCOUNTS = [
	{
		name: 'Demo Checking Account',
		type: 'checking',
		history: [
			{ asOfDate: '2026-05-01', balance: '3200', type: 'checking' },
			{ asOfDate: '2026-06-01', balance: '3600', type: 'checking' },
			{ asOfDate: '2026-07-01', balance: '4100', type: 'checking' },
			{ asOfDate: '2026-07-27', balance: '4450', type: 'checking' }
		]
	},
	{
		name: 'Demo Savings Account',
		type: 'savings',
		history: [
			{ asOfDate: '2026-05-01', balance: '5000', type: 'savings' },
			{ asOfDate: '2026-06-01', balance: '5300', type: 'savings' },
			{ asOfDate: '2026-07-01', balance: '5600', type: 'savings' },
			{ asOfDate: '2026-07-27', balance: '5800', type: 'savings' }
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
