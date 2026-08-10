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
	]
};

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
		storageState,
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

		if (shot.before) await shot.before(page);

		const file = path.join(SHOTS, shot.file);
		if (shot.clipAround) {
			const box = await resolveCard(page, shot.clipAround);
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
async function resolveCard(page, heading) {
	const box = await page.evaluate((text) => {
		const start = [...document.querySelectorAll('main *')].find(
			(el) => el.children.length === 0 && el.textContent.trim() === text
		);
		if (!start) return null;
		let node = start;
		while (node && node.getBoundingClientRect().height < 60) node = node.parentElement;
		const r = node.getBoundingClientRect();
		return { x: r.x, y: r.y + window.scrollY, width: r.width, height: r.height };
	}, heading);
	if (!box) throw new Error(`[docs] no element found with text "${heading}"`);
	return box;
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
