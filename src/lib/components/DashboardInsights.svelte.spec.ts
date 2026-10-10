import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import * as m from '$lib/paraglide/messages';
import DashboardInsights from './DashboardInsights.svelte';
import type { DashboardInsights as DashboardInsightsData } from '$lib/server/dashboard/insights';
import type { LocalLlmFailureCode } from '$lib/domain/failureCodes';

const alertInsights: DashboardInsightsData = {
	alerts: [
		{
			category: 'Alimentation',
			status: 'near_limit',
			spentCents: 24000,
			limitCents: 25000,
			remainingCents: 1000,
			remainingDays: 5,
			dailyPaceCents: 200,
			topExpenses: []
		}
	],
	alertOverflowCount: 0,
	unusualSpending: null,
	uncategorizedCount: 0
};

const emptyInsights: DashboardInsightsData = {
	alerts: [],
	alertOverflowCount: 0,
	unusualSpending: null,
	uncategorizedCount: 0
};

describe('DashboardInsights.svelte', () => {
	it('keeps the insights content collapsed by default when there is content to show', async () => {
		await render(DashboardInsights, {
			insights: alertInsights,
			aiAllowed: false,
			aiAdviceKey: null,
			periodQuery: 'period=last-month',
			onStale: () => {}
		});

		const toggle = page.getByRole('button', { name: m.dashboard_insights_heading() });
		await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');

		const content = document.getElementById('dashboard-insights-content');
		expect(content?.className).toContain('hidden');
	});

	it('reveals the insights content when the toggle is clicked', async () => {
		await render(DashboardInsights, {
			insights: alertInsights,
			aiAllowed: false,
			aiAdviceKey: null,
			periodQuery: 'period=last-month',
			onStale: () => {}
		});

		const toggle = page.getByRole('button', { name: m.dashboard_insights_heading() });
		await toggle.click();

		await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
		const content = document.getElementById('dashboard-insights-content');
		expect(content?.className).not.toContain('hidden');
		await expect.element(page.getByText('Alimentation')).toBeInTheDocument();
	});

	it('renders nothing for the insights section when there is no content', async () => {
		await render(DashboardInsights, {
			insights: emptyInsights,
			aiAllowed: false,
			aiAdviceKey: null,
			periodQuery: 'period=last-month',
			onStale: () => {}
		});

		expect(document.getElementById('dashboard-insights-content')).toBeNull();
	});
});

/**
 * The card ASKS for advice (#535): the dashboard load starts no generation, and the card posts to
 * `/insights/advice` when the member opens it, and again when the period changes while it is open.
 * `fetch` is stubbed, so its calls are the measure.
 */
type Answer = {
	insights: {
		id: string;
		source: 'local-llm';
		title: string;
		message: string;
		severity: 'info';
		category: 'spending';
	}[];
	unavailable: boolean;
	failureCode?: LocalLlmFailureCode;
	retryInMinutes?: number;
	cancelled?: true;
};
const advice = (title: string): Answer => ({
	insights: [
		{
			id: '1',
			source: 'local-llm',
			title,
			message: 'Détail',
			severity: 'info',
			category: 'spending'
		}
	],
	unavailable: false
});

/** A fetch whose answers the test releases one at a time, recording each request. */
function stubFetch() {
	const calls: {
		body: unknown;
		signal: AbortSignal;
		answer: (value: Answer | Response) => void;
	}[] = [];
	const fetchMock = vi.fn(
		(url: string, init: RequestInit) =>
			new Promise<Response>((resolve, reject) => {
				init.signal?.addEventListener('abort', () =>
					reject(new DOMException('aborted', 'AbortError'))
				);
				calls.push({
					body: JSON.parse(String(init.body)),
					signal: init.signal!,
					answer: (value) =>
						resolve(value instanceof Response ? value : new Response(JSON.stringify(value)))
				});
				expect(url).toBe('/insights/advice');
			})
	);
	vi.stubGlobal('fetch', fetchMock);
	return { calls, fetchMock };
}

const aiToggle = () =>
	page.getByRole('button', { name: m.dashboard_insights_ai_badge(), exact: false });

async function renderCard(
	props: { aiAdviceKey?: string | null; aiAllowed?: boolean; onStale?: () => void } = {}
) {
	return render(DashboardInsights, {
		insights: emptyInsights,
		aiAllowed: props.aiAllowed ?? true,
		aiAdviceKey: props.aiAdviceKey === undefined ? 'key-june' : props.aiAdviceKey,
		periodQuery: 'period=2026-06',
		onStale: props.onStale ?? (() => {})
	});
}

/** Opens the card and answers its one request with `answer`. */
async function openWith(answer: Answer) {
	const { calls } = stubFetch();
	await renderCard();
	await aiToggle().click();
	await vi.waitFor(() => expect(calls).toHaveLength(1));
	calls[0].answer(answer);
	return calls;
}

describe('DashboardInsights.svelte AI card asks for advice (#535)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// The card closed asks nothing, versus a generation per dashboard visit (and per hover prefetch
	// before #535). It offers the action instead.
	it('sends nothing while closed and offers to get advice', async () => {
		const { fetchMock } = stubFetch();
		await renderCard();
		await expect
			.element(page.getByText(m.dashboard_insights_ai_idle(), { exact: true }))
			.toBeInTheDocument();
		await new Promise((settle) => setTimeout(settle, 600));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('renders no AI section and sends nothing when the feature is off', async () => {
		const { fetchMock } = stubFetch();
		await renderCard({ aiAllowed: false });
		expect(page.getByText(m.dashboard_insights_ai_badge()).elements()).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// Opening is the explicit action: one POST of the period on screen, pending, then the advice.
	it('opening asks once for the period on screen, shows it pending, then the advice', async () => {
		const { calls } = stubFetch();
		await renderCard();
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0].body).toEqual({ period: 'period=2026-06', aiAdviceKey: 'key-june' });
		await expect.element(page.getByText(m.dashboard_insights_ai_pending())).toBeInTheDocument();
		calls[0].answer(advice('Réduisez vos abonnements'));
		await expect.element(page.getByText('Réduisez vos abonnements')).toBeInTheDocument();
		expect(page.getByText(m.dashboard_insights_ai_pending()).elements()).toHaveLength(0);
	});

	// Owner's ruling (2026-10-10): with the card open, a month rested on must not spend an hourly
	// analysis. A period change aborts the request in flight and returns the card to idle, closed;
	// nothing is asked until the member presses, versus one generation started and charged per month
	// passed through. The late answer for the old period is never shown (rev 1 F4).
	it('a period change while open aborts the old request, returns to idle, and asks nothing until pressed', async () => {
		const { calls } = stubFetch();
		const card = await renderCard();
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		await card.rerender({ aiAdviceKey: 'key-may', periodQuery: 'period=2026-05' });
		expect(calls[0].signal.aborted).toBe(true);
		await expect
			.element(page.getByText(m.dashboard_insights_ai_idle(), { exact: true }))
			.toBeInTheDocument();
		await expect.element(aiToggle()).toHaveAttribute('aria-expanded', 'false');
		calls[0].answer(advice('Conseil de juin'));
		await new Promise((settle) => setTimeout(settle, 600));
		expect(calls).toHaveLength(1);
		expect(page.getByText('Conseil de juin').elements()).toHaveLength(0);

		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(2));
		expect(calls[1].body).toEqual({ period: 'period=2026-05', aiAdviceKey: 'key-may' });
		calls[1].answer(advice('Conseil de mai'));
		await expect.element(page.getByText('Conseil de mai')).toBeInTheDocument();
	});

	// Periods passed through with the card open ask nothing at all, versus one charge per month.
	it('periods passed through with the card open ask nothing', async () => {
		const { calls } = stubFetch();
		const card = await renderCard();
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		calls[0].answer(advice('Conseil de juin'));
		await expect.element(page.getByText('Conseil de juin')).toBeInTheDocument();
		for (const month of ['05', '04', '03']) {
			await card.rerender({
				aiAdviceKey: `advice-2026-${month}`,
				periodQuery: `period=2026-${month}`
			});
			await new Promise((settle) => setTimeout(settle, 600));
		}
		expect(calls).toHaveLength(1);
	});

	// Rev 1 F4 on a CLOSED card: its header shows the first advice's title, so a period change must
	// clear it, versus June's advice title sitting collapsed above May's figures.
	it('a period change while closed clears the previous advice from the header', async () => {
		const { calls } = stubFetch();
		const card = await renderCard();
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		calls[0].answer(advice('Conseil de juin'));
		await expect.element(page.getByText('Conseil de juin')).toBeInTheDocument();
		await aiToggle().click();
		await card.rerender({ aiAdviceKey: 'key-may', periodQuery: 'period=2026-05' });
		await expect
			.element(page.getByText(m.dashboard_insights_ai_idle(), { exact: true }))
			.toBeInTheDocument();
		expect(page.getByText('Conseil de juin').elements()).toHaveLength(0);
	});

	// Closed, a period change asks nothing; reopening asks for the period now on screen.
	it('a period change while closed asks nothing, and reopening asks for the new period', async () => {
		const { calls } = stubFetch();
		const card = await renderCard();
		await card.rerender({ aiAdviceKey: 'key-may', periodQuery: 'period=2026-05' });
		await new Promise((settle) => setTimeout(settle, 600));
		expect(calls).toHaveLength(0);
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0].body).toEqual({ period: 'period=2026-05', aiAdviceKey: 'key-may' });
	});

	// Leaving the dashboard ends the request, versus a generation nobody will read.
	it('unmounting aborts the request in flight', async () => {
		const { calls } = stubFetch();
		const card = await renderCard();
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		await card.unmount();
		expect(calls[0].signal.aborted).toBe(true);
	});

	it('answers the busy refusal with its own sentence, and no configuration link', async () => {
		await openWith({ insights: [], unavailable: true, failureCode: 'busy' });
		await expect.element(page.getByText(m.dashboard_insights_ai_busy_title())).toBeInTheDocument();
		await expect
			.element(page.getByText(m.dashboard_insights_ai_busy_reason()))
			.toHaveTextContent(m.dashboard_insights_ai_busy_reason());
		expect(page.getByText(m.dashboard_insights_ai_check_configuration()).elements()).toHaveLength(
			0
		);
	});

	// What the server knows and the reader cannot see: the minute the limit lifts. Compared as the
	// whole sentence, so a doubled or missing figure cannot pass.
	it('answers the hourly limit with the minutes until it lifts', async () => {
		await openWith({
			insights: [],
			unavailable: true,
			failureCode: 'quota_reached',
			retryInMinutes: 12
		});
		const sentence = m.dashboard_insights_ai_quota_reached_reason({ minutes: 12 });
		expect(sentence).toContain('12');
		await expect.element(page.getByText(sentence)).toHaveTextContent(sentence);
	});

	// An answer the page cannot read (a redirect to the sign-in page, a 500) renders no failure
	// sentence the server never chose, versus « not running » over a session that simply expired.
	it('an unreadable answer leaves the card idle rather than inventing a failure', async () => {
		await openWith(new Response('<html>sign in</html>', { status: 200 }) as never);
		await expect
			.element(page.getByText(m.dashboard_insights_ai_idle(), { exact: true }))
			.toBeInTheDocument();
		expect(page.getByText(m.dashboard_insights_ai_unreachable_title()).elements()).toHaveLength(0);
	});

	// Final pass F1: the server refuses a key that no longer matches (a new day, data changed in
	// another tab). The card asks the page to reload its data, versus advice about another period.
	it('a stale key asks the page to reload its data and leaves the card idle', async () => {
		const { calls } = stubFetch();
		const onStale = vi.fn();
		await renderCard({ onStale });
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		calls[0].answer(new Response(JSON.stringify({ stale: true }), { status: 409 }));
		await vi.waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
		await expect
			.element(page.getByText(m.dashboard_insights_ai_idle(), { exact: true }))
			.toBeInTheDocument();
	});

	// Final pass F3: a cancelled answer (a newer tab, an opt-out) returns the card to idle and the
	// next open asks again, versus an action that is pressed and asks nothing.
	it('a cancelled answer returns to idle, and one press asks again', async () => {
		const calls = await openWith({ insights: [], unavailable: false, cancelled: true });
		await expect
			.element(page.getByText(m.dashboard_insights_ai_idle(), { exact: true }))
			.toBeInTheDocument();
		// Idle is closed too (narrow pass F3), so the next press opens and asks, versus a first press
		// that only closes a card showing nothing.
		await expect.element(aiToggle()).toHaveAttribute('aria-expanded', 'false');
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(2));
	});

	// Final pass F3: a model that answered with no insight says so, versus the idle action again.
	it('an answer with no insight says there is nothing to point out', async () => {
		await openWith({ insights: [], unavailable: false });
		const sentence = m.dashboard_insights_ai_empty();
		await expect.element(page.getByText(sentence, { exact: true })).toHaveTextContent(sentence);
	});

	// Final pass F3: no key means the advice cannot be prepared, so there is no action to offer.
	it('renders no AI card when the advice cannot be prepared', async () => {
		const { fetchMock } = stubFetch();
		await renderCard({ aiAdviceKey: null });
		expect(page.getByText(m.dashboard_insights_ai_badge()).elements()).toHaveLength(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// A refusal can be retried by the member: closing and reopening asks again, versus a card stuck
	// on « busy » until a reload.
	it('reopening after a refusal asks again', async () => {
		const calls = await openWith({ insights: [], unavailable: true, failureCode: 'busy' });
		await expect.element(page.getByText(m.dashboard_insights_ai_busy_title())).toBeInTheDocument();
		await aiToggle().click();
		await aiToggle().click();
		await vi.waitFor(() => expect(calls).toHaveLength(2));
	});

	it('never renders both AI cards at once, even if the answer is contradictory', async () => {
		await openWith({ ...advice('Réduisez vos abonnements'), unavailable: true });
		await expect.element(page.getByText('Réduisez vos abonnements')).toBeInTheDocument();
		expect(page.getByText(m.dashboard_insights_ai_unreachable_title()).elements()).toHaveLength(0);
	});
});

/**
 * The AI card names WHICH state it is in (#524, #535).
 *
 * `satisfies Record<LocalLlmFailureCode, ...>` rather than a plain array, and that is the point of
 * the shape: adding a code to the union without adding a row here stops `npm run check`, so this
 * table cannot silently fall behind the component's own map.
 */
const AI_FAILURE_STATES = {
	cold_start: {
		title: () => m.dashboard_insights_ai_cold_start_title(),
		reason: () => m.dashboard_insights_ai_cold_start_message(),
		showsConfigurationLink: false
	},
	unreachable: {
		title: () => m.dashboard_insights_ai_unreachable_title(),
		reason: () => m.dashboard_insights_ai_unreachable_reason(),
		showsConfigurationLink: true
	},
	not_configured: {
		title: () => m.dashboard_insights_ai_not_configured_title(),
		reason: () => m.dashboard_insights_ai_not_configured_reason(),
		showsConfigurationLink: true
	},
	model_unavailable: {
		title: () => m.dashboard_insights_ai_model_unavailable_title(),
		reason: () => m.dashboard_insights_ai_model_unavailable_reason(),
		showsConfigurationLink: true
	},
	response_unusable: {
		title: () => m.dashboard_insights_ai_response_unusable_title(),
		reason: () => m.dashboard_insights_ai_response_unusable_reason(),
		showsConfigurationLink: true
	},
	response_truncated: {
		title: () => m.dashboard_insights_ai_response_truncated_title(),
		reason: () => m.dashboard_insights_ai_response_truncated_reason(),
		showsConfigurationLink: true
	},
	busy: {
		title: () => m.dashboard_insights_ai_busy_title(),
		reason: () => m.dashboard_insights_ai_busy_reason(),
		showsConfigurationLink: false
	},
	quota_reached: {
		title: () => m.dashboard_insights_ai_quota_reached_title(),
		reason: () => m.dashboard_insights_ai_quota_reached_reason({ minutes: 1 }),
		showsConfigurationLink: false
	}
} satisfies Record<
	LocalLlmFailureCode,
	{ title: () => string; reason: () => string; showsConfigurationLink: boolean }
>;

const AI_FAILURE_CODES = Object.keys(AI_FAILURE_STATES) as LocalLlmFailureCode[];

describe('DashboardInsights.svelte AI failure states', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('covers all eight codes, so a shrunken table cannot report a clean run', () => {
		// The absolute figure beside the coverage claim. `it.each` over an empty or shortened list
		// passes by running nothing.
		expect(AI_FAILURE_CODES).toEqual([
			'cold_start',
			'unreachable',
			'not_configured',
			'model_unavailable',
			'response_unusable',
			'response_truncated',
			'busy',
			'quota_reached'
		]);
	});

	it.each(AI_FAILURE_CODES)(
		'renders the %s title and reason, with the configuration link only where there is something to configure',
		async (code) => {
			await openWith({ insights: [], unavailable: true, failureCode: code, retryInMinutes: 1 });
			await expect.element(page.getByText(AI_FAILURE_STATES[code].title())).toBeInTheDocument();
			await expect.element(page.getByText(AI_FAILURE_STATES[code].reason())).toBeInTheDocument();
			expect(page.getByText(m.dashboard_insights_ai_check_configuration()).elements()).toHaveLength(
				AI_FAILURE_STATES[code].showsConfigurationLink ? 1 : 0
			);
		}
	);

	it('gives the eight states eight DIFFERENT titles and reasons, which is the property #524 violated', () => {
		const titles = AI_FAILURE_CODES.map((code) => AI_FAILURE_STATES[code].title());
		expect(new Set(titles).size).toBe(8);
		const reasons = AI_FAILURE_CODES.map((code) => AI_FAILURE_STATES[code].reason());
		expect(new Set(reasons).size).toBe(8);
	});
});
