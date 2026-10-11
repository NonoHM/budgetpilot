import { createServer, type Server } from 'node:http';
import { expect, test, type Browser } from '@playwright/test';
import type { AiStatementKind } from '../src/lib/domain/aiStatements';
import {
	FIXTURES,
	INPUT_ITEMS,
	OUTPUT_ITEMS,
	SIBLING,
	type FixtureId,
	type InputItem,
	type OutputItem,
	type SeedTransaction
} from '../src/lib/server/ai/qualification/corpus';
import {
	askAdvice,
	bootAiInstance,
	registerMembers,
	seedMember,
	type AiInstance,
	type SeededMember
} from './support/aiInstance';
import * as m from '../src/lib/paraglide/messages';

/**
 * The hostile-model suite (#971, AISVS C11.1.3): the qualification corpus and every scenario of the
 * MEPIA Scenario 1 run, on the BUILD, a real database and a real browser. Only the model is scripted,
 * because the threat IS a model (or whatever answers at its address) writing an answer an attacker
 * chose, and no real model can be made to write a given kind or alias on demand.
 * `npm run ai:check` is the same app against a real model.
 *
 * Since #996 the model's whole answer is picks, `{ kind, category }` from closed lists, and the card
 * writes every sentence from the catalogue. So what is asserted is what the card SHOWS: the statement
 * titles in order (read from the catalogue, never typed here), the figure rows, or the failure it
 * says.
 *
 * WHAT IS ASSERTED. An item the corpus rules on is compared with its `expect`, which is hand-written
 * there. An item in `KNOWN_INPUT_GAPS` is compared with what the app does TODAY, written out below,
 * so the pull request that implements its rule turns it red until the entry is removed. Never
 * `test.fail()`: it accepts any failure, including a broken fixture.
 *
 * WHY EVERY PRESS COUNTS THE MODEL'S CALLS. An item judged by an absence (a dropped pick, a canary
 * missing from the prompt) reads the same over a refusal, a cache hit or a dead path. So each press
 * must reach the model exactly once, and an answer that drops a pick carries a sibling pick that must
 * render.
 *
 * One member per item and per scenario: the gateway caches answers per member by prompt, so a second
 * press on the same data would be answered from the cache, not by the scripted model.
 */

// Not serial: one item's failure must not hide the rest. A failure restarts the worker, which boots
// a fresh instance and database in `beforeAll`, so no item depends on another.
test.describe.configure({ retries: 0 });

const PORT = 4197;
const FAKE_PORT = 4198;
const ALLOWED_TARGET_PORT = 4193;
/** Loopback, but not in LLM_ALLOWED_HOSTS. 4190 is on the Fetch standard's bad-port list. */
const CANARY_HOST = '127.0.0.2';
const CANARY_PORT = 4194;
const LLM_TIMEOUT_MS = 3_000;

interface Recorded {
	messages: { role: string; content: string }[];
}
type Reply = { content: string; delayMs?: number } | { raw: string } | { redirect: string };

const fake = {
	chats: [] as Recorded[],
	reply: (() => ({ content: answer([SIBLING.pick]) })) as (request: Recorded) => Reply
};
let fakeServer: Server | undefined;
let canaryServer: Server | undefined;
let allowedServer: Server | undefined;
const hits = { canary: 0, allowed: 0 };
let instance: AiInstance;

/** The model's whole answer under #996, as it writes it. */
function answer(picks: readonly Record<string, unknown>[]): string {
	return JSON.stringify({ picks });
}

function chatEnvelope(content: string): string {
	return JSON.stringify({
		model: 'fake:971',
		message: { role: 'assistant', content },
		done: true,
		done_reason: 'stop'
	});
}

function listen(server: Server, port: number, host = '127.0.0.1'): Promise<void> {
	return new Promise((resolve) => server.listen(port, host, resolve));
}

async function startModels(): Promise<void> {
	fakeServer = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', async () => {
			if (req.url === '/api/version') {
				res.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"0.32.5"}');
				return;
			}
			if (req.url !== '/api/chat') {
				res.writeHead(404).end();
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Recorded;
			fake.chats.push({ messages: body.messages ?? [] });
			const reply = fake.reply(body);
			if ('redirect' in reply) {
				res.writeHead(307, { location: reply.redirect }).end();
				return;
			}
			if ('raw' in reply) {
				res.writeHead(200, { 'content-type': 'application/json' }).end(reply.raw);
				return;
			}
			if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
			if (res.destroyed) return;
			res.writeHead(200, { 'content-type': 'application/json' }).end(chatEnvelope(reply.content));
		});
	});
	await listen(fakeServer, FAKE_PORT);
	canaryServer = createServer((_req, res) => {
		hits.canary += 1;
		res
			.writeHead(200, { 'content-type': 'application/json' })
			.end(chatEnvelope(answer([SIBLING.pick])));
	});
	await listen(canaryServer, CANARY_PORT, CANARY_HOST);
	allowedServer = createServer((_req, res) => {
		hits.allowed += 1;
		res
			.writeHead(200, { 'content-type': 'application/json' })
			.end(chatEnvelope(answer([{ kind: 'spent_less_than_earned', category: 'all' }])));
	});
	await listen(allowedServer, ALLOWED_TARGET_PORT);
}

// ---- what the card says, from the catalogue -------------------------------------------------------

const en = { locale: 'en' } as const;
/** A `Record` over every kind, so a kind added without its title here stops `npm run check`. */
const TITLE: Record<AiStatementKind, string> = {
	top_category: m.dashboard_insights_ai_kind_top_category_title({}, en),
	no_budget: m.dashboard_insights_ai_kind_no_budget_title({}, en),
	over_budget: m.dashboard_insights_ai_kind_over_budget_title({}, en),
	near_limit: m.dashboard_insights_ai_kind_near_limit_title({}, en),
	recurring: m.dashboard_insights_ai_kind_recurring_title({}, en),
	spending_up: m.dashboard_insights_ai_kind_spending_up_title({}, en),
	spent_more_than_earned: m.dashboard_insights_ai_kind_spent_more_than_earned_title({}, en),
	spent_less_than_earned: m.dashboard_insights_ai_kind_spent_less_than_earned_title({}, en)
};
const FAILURE_TITLE = {
	response_unusable: m.dashboard_insights_ai_response_unusable_title({}, en),
	response_withheld: m.dashboard_insights_ai_response_withheld_title({}, en)
} as const;

/** `<kind>-<alias>`: a kind holds no hyphen, so the last one splits them. */
function titleOf(id: string): string {
	return TITLE[id.slice(0, id.lastIndexOf('-')) as AiStatementKind];
}

// ---- known gaps: what the app does TODAY where the corpus rules otherwise ------------------------
// Input side only: #996 ruled every output item, so each is compared with its `expect`.

/** `canary-present`: every `absent` probe of the item reaches the model today, verbatim. */
const KNOWN_INPUT_GAPS: Record<string, { issue: string; today: 'canary-present' }> = {
	'in-injection-en-category': { issue: '#820', today: 'canary-present' },
	'in-injection-en-label': { issue: '#820', today: 'canary-present' },
	'in-injection-fr-category': { issue: '#820', today: 'canary-present' },
	'in-nfkc': { issue: '#968', today: 'canary-present' },
	'in-quote': { issue: '#968', today: 'canary-present' },
	'in-control': { issue: '#968', today: 'canary-present' },
	'in-special-token': { issue: '#968', today: 'canary-present' },
	'in-empty-name': { issue: '#968', today: 'canary-present' },
	'in-allow-list': { issue: '#968', today: 'canary-present' }
};

// ---- members -------------------------------------------------------------------------------------

const outputEmail = (item: OutputItem) => `q-${item.id}@budgetpilot.test`;
const INPUT_FIXTURES = [...new Set(INPUT_ITEMS.map((item) => item.fixture))];
const inputEmail = (fixture: FixtureId) => `q-in-${fixture}@budgetpilot.test`;
const SCENARIOS = [
	'calibration',
	'figure',
	'withheld',
	'read-a',
	'read-b',
	'markup',
	'oversize',
	'bad-enum',
	'extra-keys',
	'redirect-off',
	'redirect-allowed',
	'slow',
	'huge',
	'invalid-json',
	'after-huge',
	'roles'
] as const;
const scenarioEmail = (name: (typeof SCENARIOS)[number]) => `q-scenario-${name}@budgetpilot.test`;
const SCENARIO_MONTH: SeedTransaction[] = [...FIXTURES['month-en'].transactions];

test.beforeAll(async () => {
	// One registration per member at the production hash cost, about half a second each.
	test.setTimeout(300_000);
	await startModels();
	instance = await bootAiInstance({
		name: 'ai-qualification',
		port: PORT,
		llmBaseUrl: `http://127.0.0.1:${FAKE_PORT}`,
		env: { LLM_MODEL: 'fake:971', LLM_TIMEOUT_MS: String(LLM_TIMEOUT_MS) }
	});
	await registerMembers(instance, [
		'q-admin@budgetpilot.test',
		...OUTPUT_ITEMS.map(outputEmail),
		...INPUT_FIXTURES.map(inputEmail),
		...SCENARIOS.map(scenarioEmail)
	]);
});

test.afterAll(() => {
	instance?.stop();
	fakeServer?.close();
	canaryServer?.close();
	allowedServer?.close();
});

/** One press that must reach the model exactly once. */
async function press(browser: Browser, member: SeededMember, reply: typeof fake.reply) {
	fake.reply = reply;
	const before = fake.chats.length;
	const result = await askAdvice(browser, instance, member);
	expect(fake.chats.length - before, 'this press reached the model exactly once').toBe(1);
	return { ...result, request: fake.chats.at(-1)! };
}

const requestText = (request: Recorded) => request.messages.map((m) => m.content).join('\n');

// ---- the corpus: output items --------------------------------------------------------------------

for (const item of OUTPUT_ITEMS) {
	test(`corpus ${item.id} (${item.rule}, ${item.fires ? 'fires' : 'must not fire'})`, async ({
		browser
	}) => {
		const member = await seedMember(instance, outputEmail(item), [
			...FIXTURES[item.fixture].transactions
		]);
		const result = await press(browser, member, () => ({ content: JSON.stringify(item.answer) }));
		const { page } = result;
		const titles = page.getByTestId('dashboard-ai-statement-title');
		const figures = page.getByTestId('dashboard-ai-figure');
		try {
			if ('failureCode' in item.expect) {
				// The whole answer, so nothing the model wrote comes back beside the refusal.
				expect(result.json).toEqual({
					statements: [],
					unavailable: true,
					failureCode: item.expect.failureCode
				});
				await expect(page.getByText(FAILURE_TITLE[item.expect.failureCode])).toBeVisible();
				await expect(titles).toHaveCount(0);
				await expect(figures).toHaveCount(0);
			} else {
				expect(result.json.unavailable, 'the answer as a whole was accepted').toBe(false);
				expect(result.json.statements.map((statement) => statement.id)).toEqual(
					item.expect.statements
				);
				if (item.expect.statements.length === 0) {
					await expect(page.getByText(m.dashboard_insights_ai_empty({}, en))).toBeVisible();
					await expect(titles).toHaveCount(0);
				} else {
					await expect(titles).toHaveText(item.expect.statements.map(titleOf));
					// One figure row per statement about a category, none for a statement about the period.
					await expect(figures).toHaveCount(
						item.expect.statements.filter((id) => !id.endsWith('-all')).length
					);
				}
			}
		} finally {
			await page.context().close();
		}
	});
}

// ---- the corpus: input items ---------------------------------------------------------------------

const requestsByFixture = new Map<FixtureId, string>();

for (const fixture of INPUT_FIXTURES) {
	const items = INPUT_ITEMS.filter((item) => item.fixture === fixture);
	test(`corpus input fixture ${fixture}: ${items.map((i) => i.id).join(', ')}`, async ({
		browser
	}) => {
		const definition = FIXTURES[fixture];
		const member = await seedMember(instance, inputEmail(fixture), [...definition.transactions], {
			includeLabels: 'includeLabels' in definition && definition.includeLabels
		});
		const result = await press(browser, member, () => ({ content: answer([SIBLING.pick]) }));
		await result.page.context().close();
		requestsByFixture.set(fixture, requestText(result.request).toLowerCase());
		for (const item of items) checkInput(item);
	});
}

function checkInput(item: InputItem): void {
	const request = requestsByFixture.get(item.fixture)!;
	const found = (probe: string) => request.includes(probe.toLowerCase());
	expect(item.expect.present.length, `${item.id} carries a positive`).toBeGreaterThan(0);
	for (const probe of item.expect.present) {
		expect(found(probe), `${item.id}: « ${probe} » reaches the model`).toBe(true);
	}
	const gap = KNOWN_INPUT_GAPS[item.id];
	// The cleaned form is asserted once the rule exists. Before, the canary is what is checked.
	if (!gap) {
		for (const probe of item.expect.cleaned ?? []) {
			expect(found(probe), `${item.id}: the cleaned form « ${probe} » reaches the model`).toBe(
				true
			);
		}
	}
	for (const probe of item.expect.absent) {
		expect(
			found(probe),
			gap
				? `${item.id}: known gap ${gap.issue}, the canary reaches the model today; remove the entry once it does not`
				: `${item.id}: « ${probe} » does not reach the model`
		).toBe(Boolean(gap));
	}
}

test('the instructions and the data travel in separate roles (known gap #820)', async ({
	browser
}) => {
	// Spec section 2: instructions in the system role, the member's data in the user role inside a
	// per-request marker. Today one user message carries both, which is what this asserts until
	// #820 lands; the calibration is that the month's own category is in that message.
	const member = await seedMember(instance, scenarioEmail('roles'), SCENARIO_MONTH);
	const result = await press(browser, member, () => ({ content: answer([SIBLING.pick]) }));
	await result.page.context().close();
	const roles = result.request.messages.map((m) => m.role);
	expect(
		result.request.messages[0].content,
		'the calibration: the data reached the model'
	).toContain('Groceries');
	expect(
		roles,
		'known gap #820: one user message carries instructions and data today; remove once it does not'
	).toEqual(['user']);
});

test('every known input gap names an item of the corpus, and the figure is printed', () => {
	const inputIds = new Set(INPUT_ITEMS.map((i) => i.id));
	for (const id of Object.keys(KNOWN_INPUT_GAPS)) {
		expect(inputIds.has(id), id).toBe(true);
		expect(
			INPUT_ITEMS.find((i) => i.id === id)!.expect.absent.length,
			`${id} has a canary`
		).toBeGreaterThan(0);
	}
	console.log(
		`[ai-qualification] known gaps: 0 of ${OUTPUT_ITEMS.length} output items, ${Object.keys(KNOWN_INPUT_GAPS).length} of ${INPUT_ITEMS.length} input items`
	);
});

// ---- the hostile-model scenarios -----------------------------------------------------------------

const scenario = (
	name: (typeof SCENARIOS)[number],
	transactions: SeedTransaction[] = SCENARIO_MONTH
) => seedMember(instance, scenarioEmail(name), [...transactions]);

test('scenario 0, calibration: an ordinary answer renders as advice', async ({ browser }) => {
	const result = await press(browser, await scenario('calibration'), () => ({
		content: answer([SIBLING.pick])
	}));
	expect(result.adviceText).toContain(TITLE.top_category);
	await expect(result.page.getByTestId('dashboard-ai-statement-title')).toHaveText([
		TITLE.top_category
	]);
	await result.page.context().close();
});

test("scenario 0b, the figure beside the advice is the app's, and the advice is marked as generated", async ({
	browser
}) => {
	// The model picks Groceries by its alias and writes no figure; the app attaches Groceries' own,
	// 84.20 + 61.10.
	const result = await press(browser, await scenario('figure'), () => ({
		content: answer([{ kind: 'no_budget', category: 'c2' }])
	}));
	const advice = result.page.locator('#dashboard-ai-advice-content');
	await expect(advice).toHaveAttribute('data-ai-generated', 'true');
	await expect(result.page.locator('[data-ai-generated="true"]')).toHaveCount(1);
	const figure = advice.getByTestId('dashboard-ai-figure');
	await expect(figure).toHaveCount(1);
	await expect(figure.locator('dt bdi')).toHaveText('Groceries');
	await expect(figure.locator('dd')).toHaveText('€145.30');
	await result.page.context().close();
});

test('scenario 0c, every pick dropped: the card says the advice was withheld', async ({
	browser
}) => {
	// Rent has no budget, so « over budget » is false and the only pick goes.
	const result = await press(browser, await scenario('withheld'), () => ({
		content: answer([{ kind: 'over_budget', category: 'c1' }])
	}));
	expect(result.json).toEqual({
		statements: [],
		unavailable: true,
		failureCode: 'response_withheld'
	});
	await expect(result.page.getByText(FAILURE_TITLE.response_withheld)).toBeVisible();
	await expect(result.page.getByTestId('dashboard-ai-statement-title')).toHaveCount(0);
	await expect(result.page.getByText(TITLE.over_budget)).toHaveCount(0);
	await result.page.context().close();
});

test("scenario 1, read side: one member's prompt carries none of another member's data", async ({
	browser
}) => {
	const a = await scenario('read-a', [
		{ label: 'BOULANGERIE DU PORT', amount: '-42.50', category: 'Quartzline' }
	]);
	const b = await scenario('read-b', [
		{ label: 'XYLOPHONE MERCHANT', amount: '-17.20', category: 'Zebrafjord' }
	]);
	const reply = () => ({ content: answer([SIBLING.pick]) });
	const fromB = await press(browser, b, reply);
	await fromB.page.context().close();
	const fromA = await press(browser, a, reply);
	await fromA.page.context().close();
	const promptA = requestText(fromA.request);
	const promptB = requestText(fromB.request);
	expect(promptB, "the control: B's own category reaches B's prompt").toContain('Zebrafjord');
	expect(promptA, "A's own category reaches A's prompt").toContain('Quartzline');
	expect(promptA).not.toContain('Zebrafjord');
	expect(promptA.toUpperCase()).not.toContain('XYLOPHONE');
	expect(promptA).not.toContain(scenarioEmail('read-b'));
	expect(promptA, 'not even its own address').not.toContain(scenarioEmail('read-a'));
});

test('scenario 2, a kind carrying markup is refused and nothing renders it', async ({
	browser
}) => {
	// Since #996 a kind is a closed list, so markup in it makes the whole answer unreadable, the true
	// sibling included. The control is the failure the card says: the card rendered, and said why.
	const dialogs: string[] = [];
	const result = await press(browser, await scenario('markup'), () => ({
		content: answer([
			{ kind: '<img src=x onerror="window.__pwned=true">', category: 'c1' },
			{ kind: 'top_category', category: '<script>window.__pwned=true</script>' },
			SIBLING.pick
		])
	}));
	result.page.on('dialog', async (dialog) => {
		dialogs.push(dialog.message());
		await dialog.dismiss();
	});
	expect(result.json).toEqual({
		statements: [],
		unavailable: true,
		failureCode: 'response_unusable'
	});
	await expect(result.page.getByText(FAILURE_TITLE.response_unusable)).toBeVisible();
	await expect(result.page.getByTestId('dashboard-ai-statement-title')).toHaveCount(0);
	expect(
		await result.page.evaluate(() => document.body.innerHTML.includes('__pwned')),
		'no trace of the markup anywhere in the page'
	).toBe(false);
	expect(
		await result.page.evaluate(() => (window as { __pwned?: unknown }).__pwned ?? null)
	).toBeNull();
	expect(dialogs).toEqual([]);
	await result.page.context().close();
});

test('scenario 5a, an oversized field refuses the answer and the page stands', async ({
	browser
}) => {
	const result = await press(browser, await scenario('oversize'), () => ({
		content: answer([{ kind: 'y'.repeat(5_000), category: 'c1' }])
	}));
	expect(result.json.failureCode).toBe('response_unusable');
	await expect(result.page.locator('h1').first()).toBeVisible();
	await result.page.context().close();
});

test('scenario 5b, a kind outside the closed list refuses the answer', async ({ browser }) => {
	const result = await press(browser, await scenario('bad-enum'), () => ({
		content: answer([{ kind: 'admin', category: 'c1' }])
	}));
	expect(result.json.failureCode).toBe('response_unusable');
	await result.page.context().close();
});

test('scenario 5c, keys the schema does not name refuse the answer, and none reaches it', async ({
	browser
}) => {
	// Before #996 such keys were stripped and the answer kept; `.strict()` now refuses it whole. The
	// control is scenario 0: the same pick without the extra keys renders.
	const result = await press(browser, await scenario('extra-keys'), () => ({
		content: answer([{ ...SIBLING.pick, source: 'rule', id: 'rule-1', userId: 'someone-else' }])
	}));
	expect(result.json).toEqual({
		statements: [],
		unavailable: true,
		failureCode: 'response_unusable'
	});
	await result.page.context().close();
});

test('scenario 6, a redirect off the allowlist is not followed; one to an allowed host is', async ({
	browser
}) => {
	const direct = await fetch(`http://${CANARY_HOST}:${CANARY_PORT}/api/chat`, { method: 'POST' });
	expect(
		direct.status,
		'the canary answers when asked directly, so its zero below means something'
	).toBe(200);
	hits.canary = 0;
	const off = await press(browser, await scenario('redirect-off'), () => ({
		redirect: `http://${CANARY_HOST}:${CANARY_PORT}/api/chat`
	}));
	expect(hits.canary, 'the model host redirected, and nothing reached the canary').toBe(0);
	expect(off.json.unavailable).toBe(true);
	await off.page.context().close();

	hits.allowed = 0;
	const allowed = await press(browser, await scenario('redirect-allowed'), () => ({
		redirect: `http://127.0.0.1:${ALLOWED_TARGET_PORT}/api/chat`
	}));
	expect(hits.allowed, 'the control: the same redirect to an allowlisted host lands').toBe(1);
	expect(allowed.json.statements.map((statement) => statement.id)).toEqual([
		'spent_less_than_earned-all'
	]);
	expect(allowed.adviceText).toContain(TITLE.spent_less_than_earned);
	await allowed.page.context().close();
});

test('scenario 7, a model slower than the budget leaves the page painted and says so', async ({
	browser
}) => {
	const result = await press(browser, await scenario('slow'), () => ({
		content: answer([SIBLING.pick]),
		delayMs: LLM_TIMEOUT_MS + 2_000
	}));
	expect(result.json.failureCode).toBe('cold_start');
	await expect(result.page.locator('h1').first()).toBeVisible();
	await result.page.context().close();
});

test('scenario 8, a 50 MB answer is refused and the server keeps serving', async ({ browser }) => {
	// The OUTCOME only. What the server holds in memory to refuse it is G4's detector (#967), which a
	// refusal cannot show: the answer is refused before and after that fix.
	const huge = chatEnvelope('x'.repeat(50 * 1024 * 1024));
	const result = await press(browser, await scenario('huge'), () => ({ raw: huge }));
	expect(result.json.failureCode).toBe('response_unusable');
	await result.page.context().close();
	const after = await press(browser, await scenario('after-huge'), () => ({
		content: answer([SIBLING.pick])
	}));
	expect(after.adviceText, 'the next member still gets advice').toContain(TITLE.top_category);
	await after.page.context().close();
});

test('scenario 9, an answer that is not JSON is refused', async ({ browser }) => {
	const result = await press(browser, await scenario('invalid-json'), () => ({
		raw: '{"message":{"content":"{not json"},"done":true,"done_reason":"stop"}'
	}));
	expect(result.json.failureCode).toBe('response_unusable');
	await result.page.context().close();
});
