import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
	request as apiRequest,
	type Browser,
	type BrowserContext,
	type Page
} from '@playwright/test';
import * as m from '../src/lib/paraglide/messages';
import { E2E_LOCALE } from './config';
import { expect, test } from './fixtures';

/**
 * #535 measured on the shipped artifact, against a fake Ollama in this process that counts every
 * `/api/chat` it receives and every one whose connection closed before it answered.
 *
 * THE DETECTOR is that chat counter. Every zero below has its control in the same run: opening the
 * card makes exactly one chat call, and the cross-site post's twin from the app's own origin makes
 * one. A counter that read 0 everywhere would be a fake nobody calls, not a fix.
 *
 * WHY ITS OWN SERVER: it needs `LLM_ENABLED=true`, several members and a slow model, none of which
 * the shared suite may have.
 */

test.describe.configure({ mode: 'serial', retries: 0 });

const PORT = 4185;
const FAKE_PORT = 4186;
const SAME_SITE_PORT = 4187;
const BASE_URL = `http://localhost:${PORT}`;
const DB_DIR = path.resolve('e2e/.data/ai-admission');
const DATABASE_URL = `file:./e2e/.data/ai-admission/ai.sqlite`;
const PASSWORD = 'AiAdmissionPassw0rd-6d1e!';
const QUEUE_DEPTH = 2;
const HOURLY = 3;
const ADVICE_TITLE = 'Conseil factice 535';

const SERVER_ENV = {
	DATABASE_URL,
	PORT: String(PORT),
	ORIGIN: BASE_URL,
	PUBLIC_INSTANCE: 'false',
	REGISTRATION_MODE: 'admin_only',
	PASSWORD_HASH_COST: '12',
	BOOTSTRAP_TOKEN: 'ai-admission-bootstrap-token-0c4a',
	RATE_LIMIT_HASH_SECRET: 'cafe'.repeat(16),
	TOTP_ENCRYPTION_KEY: 'feed'.repeat(16),
	BANK_SYNC_ENABLED: 'false',
	LLM_ENABLED: 'true',
	LLM_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
	LLM_MODEL: 'fake:535',
	BP_LLM_QUEUE_DEPTH: String(QUEUE_DEPTH),
	BP_LLM_USER_HOURLY: String(HOURLY)
};

/** The fake model: what it was asked, how long it takes, and who hung up on it. */
const fake = { chats: 0, closedEarly: 0, delayMs: 0 };
let fakeServer: Server | undefined;
let server: ChildProcessByStdio<null, Readable, Readable> | undefined;
let captured = '';

const ANSWER = JSON.stringify({
	summary: 'Résumé factice',
	insights: [
		{ title: ADVICE_TITLE, message: 'Détail factice', severity: 'info', category: 'spending' }
	]
});

function startFake(): Promise<void> {
	fakeServer = createServer((req, res) => {
		if (req.url === '/api/version') {
			res.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"0.32.5"}');
			return;
		}
		if (req.url === '/api/chat') {
			fake.chats += 1;
			let answered = false;
			res.on('close', () => {
				if (!answered) fake.closedEarly += 1;
			});
			req.resume();
			setTimeout(() => {
				if (res.destroyed) return;
				answered = true;
				res.writeHead(200, { 'content-type': 'application/json' }).end(
					JSON.stringify({
						model: 'fake:535',
						message: { role: 'assistant', content: ANSWER },
						done: true,
						done_reason: 'stop'
					})
				);
			}, fake.delayMs);
			return;
		}
		res.writeHead(404).end();
	});
	return new Promise((resolve) => fakeServer!.listen(FAKE_PORT, '127.0.0.1', resolve));
}

async function waitFor(condition: () => boolean, what: string, ms = 15_000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > ms) throw new Error(`ai-admission: timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/**
 * The register route allows five attempts per address and, in `admin_only` mode, exempts a
 * signed-in admin (its own comment, `register/+page.server.ts`). So the first member registers with the bootstrap token and,
 * signed in, registers the others: the route a household's first member uses, not a test helper.
 */
async function registerAll(emails: string[]): Promise<void> {
	const client = await apiRequest.newContext({
		baseURL: BASE_URL,
		storageState: { cookies: [], origins: [] },
		extraHTTPHeaders: { Origin: BASE_URL, Accept: 'application/json' }
	});
	for (const [index, email] of emails.entries()) {
		const registered = await client.post('/register', {
			form: {
				email,
				password: PASSWORD,
				...(index === 0 ? { bootstrapToken: SERVER_ENV.BOOTSTRAP_TOKEN } : {})
			},
			maxRedirects: 0
		});
		const type = ((await registered.json()) as { type?: string }).type;
		// The first is signed in by its own registration; the admin stays on the page for the others.
		expect(type, `${email} registered`).toBe(index === 0 ? 'redirect' : 'success');
		if (index === 0) {
			await client.post('/logout', { maxRedirects: 0 }).catch(() => undefined);
			const signedIn = await client.post('/login', {
				form: { email, password: PASSWORD },
				maxRedirects: 0
			});
			expect(((await signedIn.json()) as { type?: string }).type, 'the admin signed in').toBe(
				'redirect'
			);
		}
	}
	await client.dispose();
}

async function member(browser: Browser, email: string): Promise<Page> {
	const context: BrowserContext = await browser.newContext({
		baseURL: BASE_URL,
		storageState: { cookies: [], origins: [] },
		locale: 'fr-FR'
	});
	await context.addCookies([{ name: 'PARAGLIDE_LOCALE', value: E2E_LOCALE, url: BASE_URL }]);
	const page = await context.newPage();
	await page.goto('/login');
	await page.locator('input[name="email"]').fill(email);
	await page.locator('input[name="password"]').fill(PASSWORD);
	await page.locator('form button[type="submit"]').first().click();
	await page.waitForURL((url) => !url.pathname.startsWith('/login'));
	return page;
}

/**
 * The suite's fixture makes every `goto` wait for network idle, the accepted remedy for clicks lost
 * before hydration (`e2e/fixtures.ts`); these pages are built here, so they wait the same way. And a
 * press is repeated only while the card has not reported itself open, so a press lost to hydration
 * is retried and a press that landed is never doubled (it would spend an analysis).
 */
async function settle(page: Page, url: string): Promise<void> {
	await page.goto(url);
	await page.waitForLoadState('networkidle');
}

async function pressCard(page: Page): Promise<void> {
	await expect(async () => {
		if ((await aiCard(page).getAttribute('aria-expanded')) !== 'true') await aiCard(page).click();
		await expect(aiCard(page)).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
	}).toPass({ timeout: 15_000 });
}

const aiCard = (page: Page) =>
	page.getByRole('button', { name: m.dashboard_insights_ai_badge(), exact: false });

const EMAILS = Array.from(
	{ length: 1 + QUEUE_DEPTH + 2 },
	(_, i) => `ai-member-${i}@budgetpilot.test`
);
/** Kept out of the busy test, so the hourly limit it measures starts from zero. */
const QUOTA_EMAIL = 'ai-quota-member@budgetpilot.test';

test.beforeAll(async () => {
	if (!existsSync('build/index.js')) {
		throw new Error('ai-admission: build/index.js is absent, so there is no artifact to boot');
	}
	await startFake();
	rmSync(DB_DIR, { recursive: true, force: true });
	mkdirSync(DB_DIR, { recursive: true });
	execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
		env: { ...process.env, DATABASE_URL },
		stdio: 'ignore'
	});
	server = spawn('node', ['build/index.js'], {
		env: { ...process.env, ...SERVER_ENV },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	server.stdout.on('data', (chunk: Buffer) => (captured += chunk.toString()));
	server.stderr.on('data', (chunk: Buffer) => (captured += chunk.toString()));
	const started = Date.now();
	let up = false;
	while (!up && Date.now() - started < 30_000) {
		up = await fetch(`${BASE_URL}/login`).then(
			(response) => response.ok,
			() => false
		);
		if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
	}
	if (!up) throw new Error(`ai-admission: server never became reachable\n${captured}`);
	await registerAll([...EMAILS, QUOTA_EMAIL]);
});

test.afterAll(() => {
	server?.kill('SIGTERM');
	fakeServer?.close();
	rmSync(DB_DIR, { recursive: true, force: true });
});

test('a dashboard load and ten hover prefetches start no generation; opening the card starts one', async ({
	browser
}) => {
	fake.delayMs = 0;
	const page = await member(browser, EMAILS[0]);
	const before = fake.chats;
	await settle(page, '/transactions');
	// The calibration for the hover zero: each hover must actually have run the dashboard load.
	let prefetches = 0;
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === '/__data.json') prefetches += 1;
	});
	const dashboardLink = page.locator('a[href="/"]').first();
	for (let i = 0; i < 10; i++) {
		await page.mouse.move(0, 0);
		await dashboardLink.hover();
		await page.waitForTimeout(150);
	}
	await settle(page, '/');
	await expect(aiCard(page)).toBeVisible();
	await page.waitForTimeout(1_000);
	console.log(
		`[ai-admission] chats after a load and 10 hovers: ${fake.chats - before}, dashboard data requests ${prefetches}`
	);
	expect(prefetches, 'the hovers ran the dashboard load').toBeGreaterThan(0);
	expect(fake.chats - before, 'no generation from a load or a prefetch').toBe(0);

	await pressCard(page);
	await expect(page.getByText(ADVICE_TITLE).first()).toBeVisible();
	console.log(`[ai-admission] chats after opening the card: ${fake.chats - before}`);
	expect(fake.chats - before, 'the calibration: opening the card generates once').toBe(1);
	await page.context().close();
});

test(`${EMAILS.length} members at once with a slow model: ${1 + QUEUE_DEPTH} served, the rest told it is busy`, async ({
	browser
}) => {
	fake.delayMs = 2_500;
	const pages = await Promise.all(EMAILS.map((email) => member(browser, email)));
	for (const page of pages) await settle(page, '/?period=last-90-days');
	const before = fake.chats;
	await Promise.all(pages.map((page) => pressCard(page)));
	const outcomes = await Promise.all(
		pages.map(async (page) => {
			const advice = page.getByText(ADVICE_TITLE).first();
			const busy = page.getByText(m.dashboard_insights_ai_busy_title());
			await expect(advice.or(busy)).toBeVisible({ timeout: 20_000 });
			return (await busy.isVisible()) ? 'busy' : 'served';
		})
	);
	const served = outcomes.filter((outcome) => outcome === 'served').length;
	console.log(`[ai-admission] outcomes: ${JSON.stringify(outcomes)}, chats ${fake.chats - before}`);
	expect(served, 'one in flight plus the waiting room').toBe(1 + QUEUE_DEPTH);
	expect(outcomes.length - served, 'the rest refused at once').toBe(
		EMAILS.length - 1 - QUEUE_DEPTH
	);
	expect(fake.chats - before, 'only the admitted ones reached the model').toBe(1 + QUEUE_DEPTH);
	for (const page of pages) {
		await expect(page.getByText(m.dashboard_insights_ai_cold_start_title())).toHaveCount(0);
		await expect(page.getByText(m.dashboard_insights_ai_unreachable_title())).toHaveCount(0);
		await page.context().close();
	}
});

test('closing the tab mid-generation closes the connection to the model', async ({ browser }) => {
	fake.delayMs = 8_000;
	const page = await member(browser, EMAILS[1]);
	await settle(page, '/?period=last-30-days');
	const chatsBefore = fake.chats;
	const closedBefore = fake.closedEarly;
	await pressCard(page);
	await waitFor(() => fake.chats > chatsBefore, 'the generation to start');
	await page.context().close();
	await waitFor(
		() => fake.closedEarly > closedBefore,
		'the model connection to close',
		6_000
	).catch(() => undefined);
	console.log(
		`[ai-admission] tab closed mid-generation: model connections closed early ${fake.closedEarly - closedBefore}`
	);
	expect(fake.closedEarly - closedBefore, 'the abort reached the model').toBe(1);
});

test('a same-site page posting with the member cookie starts nothing; the same post from the app starts one', async ({
	browser
}) => {
	fake.delayMs = 0;
	const page = await member(browser, EMAILS[2]);
	// The card's own request body, captured and stopped before it reaches the server, so the
	// attacker and the control post exactly what the app would, valid key included.
	let captured = '';
	// One function, kept: `unroute` matches the predicate by identity, so a second arrow would
	// leave this route in place and abort the control post below.
	const isAdvice = (url: URL) => url.pathname === '/insights/advice';
	await page.route(isAdvice, async (route) => {
		captured = route.request().postData() ?? '';
		await route.abort();
	});
	await settle(page, '/?period=all-time');
	// Pressed until its post is captured: the route aborts it, so the card returns to closed and
	// « pressed until open » would loop.
	await expect(async () => {
		if (!captured) await aiCard(page).click();
		expect(captured.length).toBeGreaterThan(0);
	}).toPass({ timeout: 15_000 });
	await page.unroute(isAdvice);
	expect(JSON.parse(captured).aiAdviceKey, 'a real key was captured').toMatch(/^[0-9a-f]{64}$/);

	const before = fake.chats;
	// The shape a same-site page's POST takes on the wire, sent from the browser context so it carries
	// the member's cookie: a foreign Origin, Fetch Metadata saying same-site, and NO form content
	// type, which is the one shape SvelteKit's own CSRF check lets through (final pass F4). Sent as a
	// request rather than from a page because in-browser attempts here ended as net::ERR_ABORTED
	// (no-cors fetch) or an unexplained 400 (sendBeacon) whatever the route did, so their zero
	// said nothing about the route.
	const attack = await page.context().request.post(`${BASE_URL}/insights/advice`, {
		headers: { origin: `http://localhost:${SAME_SITE_PORT}`, 'sec-fetch-site': 'same-site' },
		data: Buffer.from(captured),
		maxRedirects: 0
	});
	const attackStatus = attack.status();
	await page.waitForTimeout(500);
	console.log(
		`[ai-admission] chats after the same-site post: ${fake.chats - before}, attack status ${attackStatus}`
	);
	expect(attackStatus, 'refused by the route, not by a sign-in redirect').toBe(403);
	expect(fake.chats - before, 'the same-site post reached no model').toBe(0);

	const control = await page.evaluate(async (body) => {
		const response = await fetch('/insights/advice', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});
		return response.status;
	}, captured);
	expect(control, 'the control post from the app itself').toBe(200);
	expect(fake.chats - before, 'the control reached the model once').toBe(1);
	await page.context().close();
});

test('the hourly limit says when it lifts, and a period seen again costs nothing', async ({
	browser
}) => {
	fake.delayMs = 0;
	const page = await member(browser, QUOTA_EMAIL);
	const periods = ['last-month', 'last-30-days', 'last-90-days'];
	const before = fake.chats;
	for (const period of periods) {
		await settle(page, `/?period=${period}`);
		await pressCard(page);
		await expect(page.getByText(ADVICE_TITLE).first()).toBeVisible();
	}
	expect(fake.chats - before, `${HOURLY} periods, ${HOURLY} generations`).toBe(HOURLY);

	await settle(page, '/?period=last-month');
	await pressCard(page);
	await expect(page.getByText(ADVICE_TITLE).first()).toBeVisible();
	expect(fake.chats - before, 'a period already seen comes from the cache').toBe(HOURLY);

	await settle(page, '/?period=all-time');
	await pressCard(page);
	const sentence = m.dashboard_insights_ai_quota_reached_reason({ minutes: 60 });
	await expect(page.getByText(m.dashboard_insights_ai_quota_reached_title())).toBeVisible();
	await expect(page.getByText(sentence)).toHaveText(sentence);
	expect(fake.chats - before, 'the refusal reached no model').toBe(HOURLY);
	await page.context().close();
});
