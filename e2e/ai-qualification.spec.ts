import { createServer, type Server } from 'node:http';
import { expect, test, type Browser } from '@playwright/test';
import {
	FIXTURES,
	INPUT_ITEMS,
	OUTPUT_ITEMS,
	SIBLING,
	type FixtureId,
	type InputItem,
	type ModelInsight,
	type OutputItem,
	type SeedTransaction,
	type ShownExpectation
} from '../src/lib/server/ai/qualification/corpus';
import {
	askAdvice,
	bootAiInstance,
	registerMembers,
	seedMember,
	type AiInstance,
	type SeededMember
} from './support/aiInstance';

/**
 * The hostile-model suite (#971, AISVS C11.1.3): the qualification corpus and every scenario of the
 * MEPIA Scenario 1 run, on the BUILD, a real database and a real browser. Only the model is scripted,
 * because the threat IS a model (or whatever answers at its address) writing text an attacker chose,
 * and no real model can be made to write a given bidi string or invented figure on demand.
 * `npm run ai:check` is the same app against a real model.
 *
 * WHAT IS ASSERTED. An item the corpus rules on is compared with its `expect`, which is hand-written
 * there. An item in `KNOWN_GAPS` is compared with what the app does TODAY, written out below, so the
 * pull request that implements its rule turns it red until the entry is removed. Never `test.fail()`:
 * it accepts any failure, including a broken fixture.
 *
 * WHY EVERY PRESS COUNTS THE MODEL'S CALLS. An item judged by an absence (a dropped title, a canary
 * missing from the prompt) reads the same over a refusal, a cache hit or a dead path. So each press
 * must reach the model exactly once, and every answer carries a sibling insight that must render.
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
	reply: (() => ({ content: answer([SIBLING.insight]) })) as (request: Recorded) => Reply
};
let fakeServer: Server | undefined;
let canaryServer: Server | undefined;
let allowedServer: Server | undefined;
const hits = { canary: 0, allowed: 0 };
let instance: AiInstance;

function answer(insights: ModelInsight[]): string {
	return JSON.stringify({ summary: 'Your month at a glance', insights });
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
			.end(chatEnvelope(answer([SIBLING.insight])));
	});
	await listen(canaryServer, CANARY_PORT, CANARY_HOST);
	allowedServer = createServer((_req, res) => {
		hits.allowed += 1;
		res
			.writeHead(200, { 'content-type': 'application/json' })
			.end(chatEnvelope(answer([{ ...SIBLING.insight, title: 'Redirected answer' }])));
	});
	await listen(allowedServer, ALLOWED_TARGET_PORT);
}

// ---- known gaps: what the app does TODAY where the corpus rules otherwise ------------------------

/**
 * `as-written`: the model's insight reaches the screen as the model wrote it, with no figure attached.
 * Otherwise the exact shown form. Each entry names the issue whose pull request removes it.
 */
const KNOWN_OUTPUT_GAPS: Record<string, { issue: string; today: 'as-written' | ShownExpectation }> =
	{
		'out-figure-grounded-category': { issue: '#831', today: 'as-written' },
		'out-figure-invented': { issue: '#831', today: 'as-written' },
		'out-figure-misattributed': { issue: '#831', today: 'as-written' },
		'out-numeral-fullwidth-grounded': { issue: '#831', today: 'as-written' },
		'out-numeral-arabic-indic-grounded': { issue: '#831', today: 'as-written' },
		'out-numeral-fullwidth-invented': { issue: '#831', today: 'as-written' },
		'out-numeral-arabic-indic-invented': { issue: '#831', today: 'as-written' },
		'out-numeral-devanagari-invented': { issue: '#831', today: 'as-written' },
		'out-mention-lowercase': { issue: '#831', today: 'as-written' },
		'out-severity-overstated': { issue: '#831', today: 'as-written' },
		'out-severity-matches': { issue: '#831', today: 'as-written' },
		'out-regulated-en-etf': { issue: '#969', today: 'as-written' },
		'out-regulated-en-crypto': { issue: '#969', today: 'as-written' },
		'out-regulated-fr-life-insurance': { issue: '#969', today: 'as-written' },
		'out-regulated-fr-credit': { issue: '#969', today: 'as-written' },
		'out-regulated-en-category-named': { issue: '#831', today: 'as-written' },
		'out-regulated-fr-category-named': { issue: '#831', today: 'as-written' },
		'out-article9-en-health': { issue: '#969', today: 'as-written' },
		'out-article9-en-religion': { issue: '#969', today: 'as-written' },
		'out-article9-fr-pregnancy': { issue: '#969', today: 'as-written' },
		'out-article9-en-category-named': { issue: '#831', today: 'as-written' },
		'out-article9-fr-category-named': { issue: '#831', today: 'as-written' },
		'out-abusive-en': { issue: '#969', today: 'as-written' },
		'out-abusive-fr': { issue: '#969', today: 'as-written' },
		'out-abusive-plain': { issue: '#831', today: 'as-written' },
		'out-echo-request': { issue: '#969', today: 'as-written' },
		'out-url': { issue: '#969', today: 'as-written' },
		'out-email': { issue: '#969', today: 'as-written' },
		'out-url-none': { issue: '#831', today: 'as-written' },
		'out-bidi': { issue: '#969', today: 'as-written' },
		'out-bidi-none': { issue: '#831', today: 'as-written' },
		'out-markdown': {
			issue: '#831',
			today: {
				title: 'Groceries',
				message: 'Keep Groceries and Transport in view.',
				mentions: [],
				severity: 'info'
			}
		},
		'out-markdown-none': { issue: '#831', today: 'as-written' }
	};

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

/**
 * The categories whose figures the app shows beside an insight. G3 (#831) decides where they travel
 * in the `/insights/advice` answer and changes THIS reader; today no figure is attached, so it reads
 * none.
 */
function attachedMentions(insight: Record<string, unknown>): string[] {
	const attached = insight.figures;
	return Array.isArray(attached)
		? attached.map((f) => String((f as { category?: unknown }).category))
		: [];
}

/** What one insight of `/insights/advice` carries today, before G3 attaches any figure. */
const TODAY_INSIGHT_FIELDS = ['category', 'id', 'message', 'severity', 'source', 'title'];

function asWritten(insight: ModelInsight): ShownExpectation {
	return {
		title: insight.title,
		message: insight.message,
		mentions: [],
		severity: insight.severity
	};
}

for (const item of OUTPUT_ITEMS) {
	test(`corpus ${item.id} (${item.rule}, ${item.fires ? 'fires' : 'must not fire'})`, async ({
		browser
	}) => {
		const member = await seedMember(instance, outputEmail(item), [
			...FIXTURES[item.fixture].transactions
		]);
		let written: ModelInsight | undefined;
		const result = await press(browser, member, (request) => {
			written =
				'echoOf' in item.insight
					? {
							title: item.insight.title,
							// 120 characters of the request itself, so the overlap is real whatever the prompt says.
							message: requestText(request).slice(0, 120).trim(),
							severity: 'info',
							category: 'spending'
						}
					: item.insight;
			return { content: answer([written, SIBLING.insight]) };
		});
		await result.page.context().close();

		expect(result.json.unavailable, 'the answer as a whole was accepted').toBe(false);
		const shown = result.json.insights.map((insight) => ({
			title: insight.title,
			message: insight.message,
			severity: insight.severity,
			mentions: attachedMentions(insight as unknown as Record<string, unknown>)
		}));
		const sibling = shown.find((s) => s.title === SIBLING.expect.title);
		expect(
			sibling,
			'the sibling insight renders, so a missing item was dropped, not refused'
		).toEqual(SIBLING.expect);
		const rest = shown.filter((s) => s !== sibling);
		expect(rest.length, 'at most the item itself beside the sibling').toBeLessThanOrEqual(1);
		const observed: ShownExpectation | 'dropped' = rest[0] ?? 'dropped';

		const gap = KNOWN_OUTPUT_GAPS[item.id];
		if (gap) {
			const today = gap.today === 'as-written' ? asWritten(written!) : gap.today;
			expect(
				observed,
				`known gap ${gap.issue}: today the app shows this; remove the entry once it does not`
			).toEqual(today);
			// The fields of today's answer, exactly. `attachedMentions` reads where G3 is expected to
			// put the figures; if G3 names that field otherwise, this reddens instead of the gap
			// staying green over a rule that was built.
			const raw = result.json.insights.find((i) => i.title !== SIBLING.expect.title);
			if (raw) {
				expect(
					Object.keys(raw).sort(),
					`known gap ${gap.issue}: a field the answer did not carry before; update attachedMentions`
				).toEqual(TODAY_INSIGHT_FIELDS);
			}
			return;
		}
		expect(observed).toEqual('dropped' in item.expect ? 'dropped' : item.expect.shown);
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
		const result = await press(browser, member, () => ({ content: answer([SIBLING.insight]) }));
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
	const result = await press(browser, member, () => ({ content: answer([SIBLING.insight]) }));
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

test('every known gap names an item of the corpus, and the starting figure is printed', () => {
	const outputIds = new Set(OUTPUT_ITEMS.map((i) => i.id));
	const inputIds = new Set(INPUT_ITEMS.map((i) => i.id));
	for (const id of Object.keys(KNOWN_OUTPUT_GAPS)) expect(outputIds.has(id), id).toBe(true);
	for (const id of Object.keys(KNOWN_INPUT_GAPS)) {
		expect(inputIds.has(id), id).toBe(true);
		expect(
			INPUT_ITEMS.find((i) => i.id === id)!.expect.absent.length,
			`${id} has a canary`
		).toBeGreaterThan(0);
	}
	console.log(
		`[ai-qualification] known gaps: ${Object.keys(KNOWN_OUTPUT_GAPS).length} of ${OUTPUT_ITEMS.length} output items, ${Object.keys(KNOWN_INPUT_GAPS).length} of ${INPUT_ITEMS.length} input items`
	);
});

// ---- the hostile-model scenarios -----------------------------------------------------------------

const scenario = (
	name: (typeof SCENARIOS)[number],
	transactions: SeedTransaction[] = SCENARIO_MONTH
) => seedMember(instance, scenarioEmail(name), [...transactions]);

test('scenario 0, calibration: an ordinary answer renders as advice', async ({ browser }) => {
	const result = await press(browser, await scenario('calibration'), () => ({
		content: answer([SIBLING.insight])
	}));
	expect(result.adviceText).toContain(SIBLING.expect.title);
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
	const reply = () => ({ content: answer([SIBLING.insight]) });
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

test('scenario 2, markup in every field renders as text and runs nothing', async ({ browser }) => {
	const dialogs: string[] = [];
	const result = await press(browser, await scenario('markup'), () => ({
		content: answer([
			{
				title: '<img src=x onerror="window.__pwned=1">',
				message: '<script>window.__pwned=2</script> <a href="javascript:window.__pwned=3">x</a>',
				severity: 'info',
				category: 'spending'
			},
			SIBLING.insight
		])
	}));
	result.page.on('dialog', async (dialog) => {
		dialogs.push(dialog.message());
		await dialog.dismiss();
	});
	expect(result.adviceText, 'the control: the markup arrived and is shown as text').toContain(
		'<img src=x'
	);
	const region = result.page.locator('#dashboard-ai-advice-content');
	expect(await region.locator('img, script, a, svg, iframe').count()).toBe(0);
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
		content: answer([{ ...SIBLING.insight, message: 'y'.repeat(5_000) }])
	}));
	expect(result.json.failureCode).toBe('response_unusable');
	await expect(result.page.locator('h1').first()).toBeVisible();
	await result.page.context().close();
});

test('scenario 5b, a severity outside the closed list refuses the answer', async ({ browser }) => {
	const result = await press(browser, await scenario('bad-enum'), () => ({
		content: JSON.stringify({
			summary: 's',
			insights: [{ ...SIBLING.insight, severity: 'admin' }]
		})
	}));
	expect(result.json.failureCode).toBe('response_unusable');
	await result.page.context().close();
});

test('scenario 5c, keys the schema does not name never reach the answer', async ({ browser }) => {
	const result = await press(browser, await scenario('extra-keys'), () => ({
		content: JSON.stringify({
			summary: 's',
			insights: [{ ...SIBLING.insight, source: 'rule', id: 'rule-1', userId: 'someone-else' }]
		})
	}));
	expect(result.json.unavailable, 'the control: the answer itself was accepted').toBe(false);
	const [insight] = result.json.insights as unknown as Record<string, unknown>[];
	expect(insight.source).toBe('local-llm');
	expect(insight.id).toBe('local-llm-1');
	expect('userId' in insight).toBe(false);
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
	expect(allowed.adviceText).toContain('Redirected answer');
	await allowed.page.context().close();
});

test('scenario 7, a model slower than the budget leaves the page painted and says so', async ({
	browser
}) => {
	const result = await press(browser, await scenario('slow'), () => ({
		content: answer([SIBLING.insight]),
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
		content: answer([SIBLING.insight])
	}));
	expect(after.adviceText, 'the next member still gets advice').toContain(SIBLING.expect.title);
	await after.page.context().close();
});

test('scenario 9, an answer that is not JSON is refused', async ({ browser }) => {
	const result = await press(browser, await scenario('invalid-json'), () => ({
		raw: '{"message":{"content":"{not json"},"done":true,"done_reason":"stop"}'
	}));
	expect(result.json.failureCode).toBe('response_unusable');
	await result.page.context().close();
});
