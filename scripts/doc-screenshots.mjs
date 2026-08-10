// Captures the screenshots embedded in docs/using/ and docs/reference/, against an instance
// you are already running. Unlike scripts/demo-screenshots.mjs, which owns its whole lifecycle
// to produce the three README images, this one attaches to a server someone else started, so a
// session can explore a page by hand and then capture exactly the state it just verified.
//
// Usage:
//   BASE_URL=http://localhost:4175 \
//   DOC_EMAIL=demo@example.invalid DOC_PASSWORD=DemoBudgetPilot123! \
//   node scripts/doc-screenshots.mjs [group ...]
//
// THE BROWSER LOCALE IS SET, NOT ONLY THE APP LOCALE, and they are two different things. The
// app's language comes from the PARAGLIDE_LOCALE cookie; the presentation of a native control
// comes from the browser. A capture taken with a French browser of an English page renders
// `<input type="date">` as 31/07/2026 while every word around it is English — measured, not
// assumed: the page reported lang="en" with navigator.language = "fr-FR". So `locale` is
// pinned here and `Accept-Language` with it, or the images disagree with the prose beside them.
import { chromium, request } from 'playwright';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:4175';
const EMAIL = process.env.DOC_EMAIL ?? 'demo@example.invalid';
const PASSWORD = process.env.DOC_PASSWORD ?? 'DemoBudgetPilot123!';
const TOTP_SECRET = process.env.DOC_TOTP_SECRET ?? null;
const SHOTS = path.resolve('docs/screenshots');

const DESKTOP = { width: 1920, height: 1080 };
const MOBILE = { width: 393, height: 852 };

/**
 * One entry per image. `clip` names an element by a predicate over the page rather than by a
 * CSS selector, because the pages this documents are styled with utility classes that carry no
 * stable hook — resolving through the visible heading is what survives a restyle.
 */
const GROUPS = {
	dashboard: [
		{
			file: 'dashboard/overview-desktop.png',
			url: '/',
			fullPage: true
		},
		{
			file: 'dashboard/overview-mobile.png',
			url: '/',
			viewport: MOBILE
		},
		{
			file: 'dashboard/insights-desktop.png',
			url: '/',
			before: async (page) => {
				await page.getByRole('button', { name: /^Insights/ }).click();
				await page.waitForTimeout(250);
			},
			clipAround: 'Insights'
		},
		{
			file: 'dashboard/nature-analysis-desktop.png',
			url: '/',
			before: async (page) => {
				await page.getByRole('button', { name: /^Real analysis/ }).click();
				await page.waitForTimeout(250);
			},
			clipAround: 'Real analysis'
		},
		{
			file: 'dashboard/custom-period-desktop.png',
			url: '/?period=custom&from=2026-06-01&to=2026-07-31',
			clipAround: 'Dashboard'
		}
	],
	// Expects the three-budget arrangement described in docs/screenshots/budgets/README.md:
	// one category comfortably under, one past 80% of its limit, one over. Anything else
	// captures a page that cannot teach what the three states look like.
	budgets: [
		{ file: 'budgets/overview-desktop.png', url: '/budgets', contentClip: true },
		{ file: 'budgets/overview-mobile.png', url: '/budgets', viewport: MOBILE },
		{
			file: 'budgets/new-budget-desktop.png',
			url: '/budgets',
			before: async (page) => {
				await page.getByRole('button', { name: '+ New budget' }).click();
				await page.waitForTimeout(300);
			},
			element: '[role="dialog"]'
		},
		{
			file: 'budgets/edit-budget-desktop.png',
			url: '/budgets',
			before: async (page) => {
				// Two copies of every row action are in the DOM at once, one per breakpoint, so
				// the label alone is ambiguous — `.last()` is the one a 1920-wide viewport shows.
				await page.getByLabel('Edit Transport').last().click();
				await page.waitForTimeout(300);
			},
			element: '[role="dialog"]'
		},
		{
			file: 'budgets/delete-confirm-desktop.png',
			url: '/budgets',
			before: async (page) => {
				await page.getByLabel('Delete Dining out').last().click();
				await page.waitForTimeout(300);
			},
			element: '[role="dialog"], [role="alertdialog"]'
		}
	],
	reports: [
		{ file: 'reports/overview-desktop.png', url: '/reports', fullPage: true },
		{ file: 'reports/overview-mobile.png', url: '/reports', viewport: MOBILE },
		{ file: 'reports/takeaways-desktop.png', url: '/reports', clipAround: 'Key takeaways' },
		{
			file: 'reports/category-breakdown-desktop.png',
			url: '/reports',
			clipAround: 'Spending by category'
		},
		{
			file: 'reports/detected-flows-desktop.png',
			url: '/reports',
			clipAround: 'Detected flows',
			clipMinHeight: 200
		},
		{
			file: 'reports/largest-expenses-desktop.png',
			url: '/reports',
			clipAround: 'Largest expenses',
			clipMinHeight: 200
		}
	],
	// Expects one user-made rule alongside the shipped catalogue — see
	// docs/screenshots/rules/README.md. Without it the list is 156 identical PREDEFINED rows
	// and the image cannot show what a rule of your own looks like.
	rules: [
		{ file: 'rules/overview-desktop.png', url: '/rules', contentClip: true },
		{ file: 'rules/overview-mobile.png', url: '/rules', viewport: MOBILE },
		{
			file: 'rules/preview-desktop.png',
			url: '/rules?preview=1',
			clipAround: 'Current',
			clipMinHeight: 240
		},
		{
			file: 'rules/own-rules-only-desktop.png',
			url: '/rules',
			before: async (page) => {
				await page.getByRole('switch', { name: /predefined/i }).click();
				await page.waitForTimeout(400);
			},
			contentClip: true
		}
	],
	'net-worth': [
		{ file: 'net-worth/overview-desktop.png', url: '/net-worth', contentClip: true },
		{ file: 'net-worth/overview-mobile.png', url: '/net-worth', viewport: MOBILE },
		{
			file: 'net-worth/breakdown-desktop.png',
			url: '/net-worth',
			before: async (page) => {
				await page.getByLabel('Breakdown view').first().click();
				await page.waitForTimeout(400);
			},
			clipAround: 'Asset breakdown',
			clipMinHeight: 200
		},
		{
			file: 'net-worth/new-account-desktop.png',
			url: '/net-worth',
			before: async (page) => {
				await page.getByRole('button', { name: '+ New account' }).first().click();
				await page.waitForTimeout(300);
			},
			element: '[role="dialog"]'
		},
		{
			file: 'net-worth/new-goal-desktop.png',
			url: '/net-worth',
			before: async (page) => {
				await page.getByRole('button', { name: '+ New goal' }).first().click();
				await page.waitForTimeout(300);
			},
			element: '[role="dialog"]'
		}
	],
	categories: [
		{ file: 'categories/overview-desktop.png', url: '/categories', contentClip: true },
		{ file: 'categories/overview-mobile.png', url: '/categories', viewport: MOBILE },
		{
			file: 'categories/new-category-desktop.png',
			url: '/categories',
			before: async (page) => {
				await page.getByRole('button', { name: '+ New category' }).first().click();
				await page.waitForTimeout(300);
			},
			element: '[role="dialog"]'
		},
		{
			file: 'categories/delete-with-transactions-desktop.png',
			url: '/categories',
			before: async (page) => {
				// Groceries, which holds transactions — the dialog says how many and where they go.
				// A category with none says something shorter and teaches less.
				await page
					.getByRole('row', { name: /Groceries/ })
					.first()
					.getByRole('button', { name: 'Delete' })
					.click();
				await page.waitForTimeout(300);
			},
			element: '[role="dialog"], [role="alertdialog"]'
		}
	],
	'upcoming-bills': [
		{ file: 'upcoming-bills/overview-desktop.png', url: '/upcoming-bills', contentClip: true },
		{ file: 'upcoming-bills/overview-mobile.png', url: '/upcoming-bills', viewport: MOBILE },
		{
			file: 'upcoming-bills/row-actions-desktop.png',
			url: '/upcoming-bills',
			before: async (page) => {
				await page
					.getByLabel(/^Actions for Rent/)
					.first()
					.click();
				await page.waitForTimeout(400);
			},
			element: '[role="menu"]'
		}
	],
	// Expects at least one import in the history — see docs/screenshots/imports/README.md.
	imports: [
		{ file: 'imports/history-desktop.png', url: '/imports', contentClip: true },
		{ file: 'imports/history-mobile.png', url: '/imports', viewport: MOBILE },
		{
			file: 'imports/cancel-import-desktop.png',
			url: '/imports',
			before: async (page) => {
				await page.getByRole('row').nth(2).getByRole('button', { name: 'Delete' }).click();
				await page.waitForTimeout(400);
			},
			element: '[role="dialog"], [role="alertdialog"]'
		}
	],
	// Expects the two goals described in docs/screenshots/savings-goals/README.md: one tracked
	// by hand and one linked to an account with a deadline. One of each, because the two modes
	// show different things and a single goal can only show one of them.
	'savings-goals': [
		{
			file: 'savings-goals/cards-desktop.png',
			url: '/net-worth',
			clipAround: 'Savings goals',
			clipMinHeight: 180
		},
		{
			file: 'savings-goals/new-goal-linked-desktop.png',
			url: '/net-worth',
			before: async (page) => {
				await page.getByRole('button', { name: '+ New goal' }).first().click();
				await page.waitForTimeout(300);
				await page.getByRole('button', { name: 'Linked to an account' }).click();
				await page.waitForTimeout(200);
				await page.getByRole('button', { name: '+ Add a deadline' }).click();
				await page.waitForTimeout(200);
			},
			element: '[role="dialog"]'
		},
		{
			file: 'savings-goals/detail-linked-desktop.png',
			url: '/net-worth',
			before: async (page) => {
				await page
					.getByRole('button', { name: /Emergency fund/ })
					.first()
					.click();
				await page.waitForTimeout(600);
			},
			element: '[role="dialog"]'
		},
		{
			file: 'savings-goals/detail-manual-desktop.png',
			url: '/net-worth',
			before: async (page) => {
				await page
					.getByRole('button', { name: /Japan trip/ })
					.first()
					.click();
				await page.waitForTimeout(600);
			},
			element: '[role="dialog"]'
		}
	],
	// The two EMPTY states are not in this group: neither is reachable from the documented
	// fixture, which has three healthy flows by design. They are captured from a throwaway
	// instance seeded with stale flows — see docs/screenshots/forecast/README.md.
	forecast: [
		{
			file: 'forecast/card-desktop.png',
			url: '/',
			clipAround: 'Cash-flow forecast',
			clipMinHeight: 200
		},
		{
			file: 'forecast/reports-projection-desktop.png',
			url: '/reports',
			clipAround: 'Projected balance (3 months)',
			clipMinHeight: 300
		}
	],
	// Run these against an account that does NOT yet have two-factor enabled: the group walks
	// the enrolment for real, so the codes photographed are ones the app actually issued.
	'two-factor': [
		{
			file: 'two-factor/settings-card-desktop.png',
			url: '/settings',
			clipAround: 'Two-factor authentication',
			clipMinHeight: 120
		},
		{
			file: 'two-factor/setup-desktop.png',
			url: '/settings',
			before: openTotpSetup,
			// The dialog is portalled out of `main`, so the heading walk cannot reach it.
			element: '[role="dialog"]'
		},
		{
			file: 'two-factor/recovery-codes-desktop.png',
			url: '/settings',
			before: async (page) => {
				await openTotpSetup(page);
				await completeTotpSetup(page);
			},
			element: '[role="dialog"]'
		}
	],
	// Split out because it is the only shot in the family that needs an account which ALREADY has
	// two-factor enabled, which is the one state the enrolment walk above destroys.
	'two-factor-verify': [
		{
			// The second sign-in step, which only exists while a challenge is open — so this one
			// runs signed OUT and performs the password step itself.
			file: 'two-factor/verify-desktop.png',
			url: '/login',
			anonymous: true,
			// A narrower viewport than the 1920 default: the sign-in card is centred and fixed
			// width, so a full-width capture is mostly empty page.
			viewport: { width: 960, height: 760 },
			before: async (page, { email, password }) => {
				await page.getByRole('textbox', { name: 'Email' }).fill(email);
				await page.getByLabel('Password', { exact: true }).fill(password);
				await page.getByRole('button', { name: 'Sign in' }).click();
				await page.waitForURL(/verify-totp/);
			},
			contentClip: true
		}
	],
	// The enabled state, which the `two-factor` group cannot also capture: it walks the enrolment,
	// so by the time it finishes the account can never show the disabled card again.
	'two-factor-on': [
		{
			file: 'two-factor/settings-card-on-desktop.png',
			url: '/settings',
			// The section HEADING, not the card: once enabled the card's own title is no longer a
			// leaf node, so the walk that finds it in the disabled state finds nothing here.
			clipAround: 'Authenticator app (TOTP)',
			clipMinHeight: 120
		}
	],
	backup: [
		{
			file: 'backup/section-desktop.png',
			url: '/settings',
			clipAround: 'Export my data',
			clipMinHeight: 120
		},
		{
			file: 'backup/restore-open-desktop.png',
			url: '/settings',
			before: async (page) => {
				// The restore form is behind a disclosure, deliberately — the whole point of the
				// image is the warning it reveals, so the shot has to open it.
				// Two disclosures on the page carry the label "Show options", and picking by index got
				// the other one — so this walks up from the "Restore a backup" title to the nearest
				// ancestor that owns a disclosure, which cannot address the wrong section.
				await page.evaluate(() => {
					const title = [...document.querySelectorAll('*')].find(
						(el) => el.children.length === 0 && el.textContent.trim() === 'Restore a backup'
					);
					let node = title;
					while (node && !node.querySelector?.('button[aria-expanded]')) node = node.parentElement;
					node.querySelector('button[aria-expanded]').click();
				});
				await page.waitForTimeout(400);
			},
			clipAround: 'Export my data',
			clipMinHeight: 120
		}
	],
	account: [
		{
			file: 'account/overview-desktop.png',
			url: '/settings',
			contentClip: true
		},
		{
			file: 'account/language-desktop.png',
			url: '/settings',
			clipAround: 'Language',
			clipMinHeight: 120
		},
		{
			file: 'account/sessions-desktop.png',
			url: '/settings',
			clipAround: 'Sessions',
			clipMinHeight: 200
		}
	],
	admin: [
		{
			file: 'admin/users-desktop.png',
			url: '/admin',
			contentClip: true
		},
		{
			file: 'admin/invitations-desktop.png',
			url: '/admin',
			clipAround: 'Invitations',
			clipMinHeight: 300
		}
	]
};

/** Opens the enrolment dialog from the two-factor switch. */
async function openTotpSetup(page) {
	await page.getByRole('switch', { name: 'Enable two-factor authentication' }).click();
	await page.waitForTimeout(400);
}

/**
 * Finishes the enrolment the way a user does, by reading the key the dialog offers for manual
 * entry and generating a code from it. `otpauth` is the library the app itself verifies with, so
 * this is not a re-implementation of the algorithm — it is the same one, driven from outside.
 */
async function completeTotpSetup(page) {
	const { TOTP, Secret } = await import('otpauth');
	const secret = await page.locator('input[name="secretBase32"]').inputValue();
	const code = new TOTP({ issuer: 'BudgetPilot', secret: Secret.fromBase32(secret) }).generate();
	await page.getByLabel('Current password').fill(PASSWORD);
	await page.locator('input[name="code"]').fill(code);
	await page.getByRole('button', { name: 'Enable', exact: true }).click();
	await page.waitForTimeout(600);
}

async function main() {
	const groups = process.argv.slice(2);
	const selected = groups.length ? groups : Object.keys(GROUPS);

	const ctx = await request.newContext({
		baseURL: BASE_URL,
		extraHTTPHeaders: { Origin: BASE_URL }
	});
	const res = await ctx.post('/login', {
		form: { email: EMAIL, password: PASSWORD },
		maxRedirects: 0
	});
	const body = await res.json();
	if (body.type !== 'redirect' && body.type !== 'success') {
		throw new Error(`[docs] login failed: ${JSON.stringify(body).slice(0, 200)}`);
	}
	// An account with two-factor enabled stops at the second step, and the session cookie is only
	// issued once that step passes — so without this the capture would run signed OUT and
	// photograph /login. DOC_TOTP_SECRET is what lets a group document the ENABLED state.
	if (String(body.location ?? '').includes('verify-totp')) {
		if (!TOTP_SECRET) {
			throw new Error('[docs] this account has two-factor enabled: set DOC_TOTP_SECRET');
		}
		const { TOTP, Secret } = await import('otpauth');
		const code = new TOTP({
			issuer: 'BudgetPilot',
			secret: Secret.fromBase32(TOTP_SECRET)
		}).generate();
		const second = await ctx.post('/login/verify-totp', { form: { code }, maxRedirects: 0 });
		const secondBody = await second.json();
		if (secondBody.type !== 'redirect') {
			throw new Error(`[docs] second factor failed: ${JSON.stringify(secondBody).slice(0, 200)}`);
		}
	}
	const storageState = await ctx.storageState();
	await ctx.dispose();

	const browser = await chromium.launch();
	try {
		for (const group of selected) {
			const shots = GROUPS[group];
			if (!shots) throw new Error(`[docs] unknown group "${group}"`);
			for (const shot of shots) {
				await capture(browser, storageState, shot);
			}
		}
	} finally {
		await browser.close();
	}
}

async function capture(browser, storageState, shot) {
	const context = await browser.newContext({
		// A signed-in state is the default, but the second sign-in step only exists for a visitor
		// who has not finished signing in — so a shot can ask for a clean context instead.
		storageState: shot.anonymous ? undefined : storageState,
		viewport: shot.viewport ?? DESKTOP,
		deviceScaleFactor: 1,
		locale: 'en-GB',
		extraHTTPHeaders: { 'Accept-Language': 'en' }
	});
	await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: BASE_URL }]);
	const page = await context.newPage();
	try {
		await page.goto(`${BASE_URL}${shot.url}`);
		await page.waitForLoadState('networkidle');

		const lang = await page.locator('html').getAttribute('lang');
		if (lang !== 'en') throw new Error(`[docs] ${shot.file} rendered with lang="${lang}"`);

		if (shot.before) await shot.before(page, { email: EMAIL, password: PASSWORD });

		const file = path.join(SHOTS, shot.file);
		if (shot.element) {
			await page.locator(shot.element).first().screenshot({ path: file });
			console.log(`[docs] ${shot.file}  element`);
		} else if (shot.contentClip) {
			// `main` carries a min-height that fills the viewport, so clipping to it would keep
			// every empty pixel below the last card. Measure where the content actually stops.
			const height = await page.evaluate(() => {
				const root = document.querySelector('main') ?? document.body;
				let lowest = 0;
				for (const el of root.querySelectorAll('*')) {
					const box = el.getBoundingClientRect();
					if (box.width > 0 && box.height > 0) lowest = Math.max(lowest, box.bottom);
				}
				return Math.ceil(lowest + window.scrollY + 24);
			});
			// The shot's own viewport, not the desktop default: a narrower capture would otherwise
			// ask Playwright to clip a region wider than the page it rendered.
			const view = shot.viewport ?? DESKTOP;
			const clip = { x: 0, y: 0, width: view.width, height: Math.min(view.height, height) };
			await page.screenshot({ path: file, clip });
			console.log(`[docs] ${shot.file}  ${clip.width}x${clip.height}`);
		} else if (shot.clipAround) {
			const box = await resolveCard(page, shot.clipAround, shot.clipMinHeight ?? 60);
			// `fullPage` with `clip`, because the box is in PAGE coordinates and a card below the
			// fold is outside a viewport screenshot — Playwright then refuses with "clipped area
			// is either empty or outside the resulting image" rather than scrolling to it.
			await page.screenshot({ path: file, clip: box, fullPage: true });
			console.log(`[docs] ${shot.file}  ${Math.round(box.width)}x${Math.round(box.height)}`);
		} else {
			await page.screenshot({ path: file, fullPage: shot.fullPage === true });
			console.log(`[docs] ${shot.file}  ${shot.fullPage ? 'full page' : 'viewport'}`);
		}
	} finally {
		await context.close();
	}
}

/** Smallest ancestor of the named heading that carries more than the heading itself. */
async function resolveCard(page, heading, minHeight) {
	const box = await page.evaluate(
		({ text, minHeight }) => {
			const start = [...document.querySelectorAll('main *')].find(
				(el) => el.children.length === 0 && el.textContent.trim() === text
			);
			if (!start) return null;
			// Walking up until the box is "big enough" is a heuristic, and it stops one level too
			// early wherever a heading sits in its own tall-ish wrapper — a « Detected flows »
			// title plus its explanatory line already clears 60px, so the table underneath was
			// cropped out of its own screenshot. `clipMinHeight` is how a caller says how much of
			// the card it actually means.
			let node = start;
			while (node && node.getBoundingClientRect().height < minHeight) node = node.parentElement;
			const r = node.getBoundingClientRect();
			return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
		},
		{ text: heading, minHeight }
	);
	if (!box) throw new Error(`[docs] no element found with text "${heading}"`);
	return box;
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
