import { readFileSync } from 'node:fs';
import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_API_HEADERS, E2E_BASE_URL } from './config';
import {
	E2E_BOOTSTRAP_ADMIN_EMAIL,
	E2E_BOOTSTRAP_ADMIN_PASSWORD,
	E2E_USER_EMAIL,
	E2E_USER_PASSWORD,
	submitForm,
	assertOk,
	type ActionResult
} from './seed';

/**
 * Two-account authorization battery: check 2 of the Phase 5 automation inventory, and the port
 * of the #184 pentest's `scripts/security/idor.sh` into something that runs.
 *
 * WHY IT IS WORTH THE SECONDS IT COSTS. Per-user `userId` scoping is the central authorization
 * rule of this application and the strongest-verified requirement in the published assessment
 * (`v5.0.0-8.2.2`, `8.3.1`, `8.4.1`), and until this file existed it was guarded by a shell
 * script that no pipeline runs. A control that cannot fail loudly is not a control.
 *
 * TWO AXES, because the assessment verifies two different things and they fail differently:
 *
 *  - VERTICAL (`v5.0.0-8.2.1`), function-level: a non-admin reaching an admin-only surface.
 *  - HORIZONTAL (`v5.0.0-8.2.2`, `8.3.1`, `8.4.1`), data-level: one account reaching another
 *    account's rows by id. 'Tenant' is the right word: one instance hosts several households and
 *    `userId` is the whole boundary.
 *
 * THE CALIBRATION LEG IS NOT OPTIONAL, and it is the half `idor.sh` never had. Name the two
 * states this file must separate: "the server refused because the row belongs to someone else"
 * and "the request never did anything" (wrong action name, missing field, a route that 404s, a
 * context that was never logged in). BOTH produce a refusal and an unchanged victim. A battery
 * that only fires the attacker cannot tell them apart, and its green is then indistinguishable
 * from a battery pointed at nothing at all.
 *
 * So every id-bearing action is fired TWICE with the same payload shape: once by the attacker
 * against the victim's id (must refuse, victim unchanged), and once by the OWNER against their
 * own row (must succeed). The owner leg is what proves the payload is well-formed, the id is
 * real and reachable, and the action exists. Only then does the attacker's refusal mean scoping.
 *
 * THE ONE THAT PROVES IT, and the reason the fixture below looks the way it does.
 * `savingsGoal-dismiss` refuses its OWNER with the SAME 404 it gives the attacker, because
 * `dismissReachedBanner` filters on `reachedAt: { not: null }` and the goal was seeded unreached.
 * Two states, one reading: "refused because it is not yours" and "refused because it is not
 * reached" are indistinguishable through the attacker leg, so that probe would have been counted
 * as proof of isolation while measuring nothing but an unreached goal. It was the owner leg that
 * said so, on the first run.
 *
 * That is why `seedVictimRows` creates the goal already reached AND loads /net-worth once:
 * `reachedAt` is written lazily, on read. Anyone changing that fixture back to an unreached goal
 * silently converts this probe into a green that means nothing, and nothing else in the file
 * would notice.
 *
 * AND WHY THE EXPECTED OUTCOME IS DECLARED PER ACTION rather than asserted uniformly. The first
 * version of this file asserted that EVERY probe must be refused, and went red on `undoBulkTag`,
 * which is correct code: it is one `deleteMany` filtered on `transaction: { userId }`, it matches
 * zero rows, and deleting zero rows is not an error. The assertion was wrong, not the
 * application. It generalises past this file: a battery that expects one outcome from every
 * probe will eventually be wrong about a correct behaviour, and the wrongness arrives looking
 * exactly like a finding. Declare what each probe should do, and a row that MOVES is the signal.
 */

// The attacker is the disposable bootstrap ADMIN, deliberately: an admin is the hardest case for
// horizontal isolation, because a role that legitimately crosses the tenant boundary on /admin
// must still not reach another user's rows through the ordinary routes. It is also what
// idor.sh used, so this stays a port rather than a redesign.
const VICTIM = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const ATTACKER = { email: E2E_BOOTSTRAP_ADMIN_EMAIL, password: E2E_BOOTSTRAP_ADMIN_PASSWORD };

// Distinct from every SEEDED_* constant in seed.ts: these rows are created and destroyed inside
// this file, so no other spec's assertions can be moved by them. The owner calibration leg is
// also the cleanup, which is why the destructive actions run last.
const PROBE = {
	transactionLabel: 'IDOR PROBE TARGET',
	category: 'IdorProbeCategory',
	tag: 'idor-probe-tag',
	netWorth: 'IdorProbeAccount',
	goal: 'IdorProbeGoal',
	rule: 'IdorProbeRule'
};

interface VictimIds {
	transactionId: string;
	tagId: string;
	categoryId: string;
	budgetId: string;
	netWorthId: string;
	goalId: string;
	ruleId: string;
	sessionId: string;
}

let victim: APIRequestContext;
let attacker: APIRequestContext;
let ids: VictimIds;

/**
 * A context that is genuinely the account it claims to be.
 *
 * THE HAZARD IS REAL AND THIS LINE IS NOT WHAT DEFUSES IT, which is worth stating precisely
 * because the first version of this comment claimed the opposite and the break-check disproved
 * it. `apiRequest.newContext()` INHERITS `storageState` from playwright.config.ts, so a context
 * built without it silently carries the shared e2e session, and an "attacker" holding the
 * victim's cookie would succeed at everything against rows it legitimately owns while the suite
 * reported a working isolation boundary.
 *
 * Measured: deleting the explicit empty `storageState` below leaves all seven tests GREEN,
 * because the login on the next line issues a new session cookie that overwrites the inherited
 * one. So the empty state is belt and braces (it matters only to a future variant that reuses a
 * context without logging in), and the LOGIN is what establishes identity here.
 *
 * What actually guards the hazard is the identity assertion, the first test in this file.
 * Measured the other way: deleting the login turns that test red and nothing else runs. That is
 * the check to keep, and it is why identity is asserted rather than assumed even though both
 * mechanisms above look sufficient by inspection.
 */
async function contextFor(account: {
	email: string;
	password: string;
}): Promise<APIRequestContext> {
	const context = await apiRequest.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: E2E_API_HEADERS,
		storageState: { cookies: [], origins: [] }
	});
	assertOk(`login ${account.email}`, await submitForm(context, '/login', account));
	return context;
}

/** The victim's complete owned state, from the app's own backup export. */
async function fingerprint(context: APIRequestContext): Promise<string> {
	const response = await context.get('/settings/export');
	if (!response.ok()) throw new Error(`fingerprint: export returned ${response.status()}`);
	const backup = (await response.json()) as Record<string, unknown>;
	// The only field that moves on its own. Everything else is owned data, which is the point.
	delete backup.exportedAt;
	return JSON.stringify(backup);
}

async function whoAmI(context: APIRequestContext): Promise<string> {
	const response = await context.get('/settings/export');
	const backup = (await response.json()) as { userEmail: string };
	return backup.userEmail;
}

test.beforeAll(async () => {
	victim = await contextFor(VICTIM);
	attacker = await contextFor(ATTACKER);
	ids = await seedVictimRows();
});

test.afterAll(async () => {
	await victim?.dispose();
	await attacker?.dispose();
});

/**
 * Creates one victim-owned row per targeted resource and harvests its id.
 *
 * Ids come from the backup export rather than from scraping HTML or reading the database: it is
 * the app's own serialisation of everything the user owns, it carries the primary keys, and one
 * request replaces eight page reads. `idor.sh` read them out of SQLite with a shell helper,
 * which is exactly the part that could not move into CI.
 */
async function seedVictimRows(): Promise<VictimIds> {
	/**
	 * Create only what is absent.
	 *
	 * Not defensive style: Playwright RESTARTS THE WORKER after a failed test, which re-runs
	 * `beforeAll`. Measured here, on the first red run of this file: the second pass tried to
	 * create a category that already existed, got `failure/400`, and the seed threw. Three tests
	 * then reported a seeding error instead of the one real finding, which is a harness turning
	 * one failure into four and burying the informative one.
	 *
	 * It also matters after a partial run: the owner calibration leg deletes these rows, so a
	 * restart between the two legs finds some present and some gone.
	 */
	const existing = (await (await victim.get('/settings/export')).json()) as BackupShape;
	const absent = {
		category: !existing.categories.some((c) => c.name === PROBE.category),
		transaction: !existing.transactions.some((t) => t.label === PROBE.transactionLabel),
		budget: !existing.monthlyBudgets.some((b) => b.categoryName === PROBE.category),
		netWorth: !existing.netWorthAccounts.some((a) => a.name === PROBE.netWorth),
		goal: !existing.savingsGoals.some((g) => g.name === PROBE.goal),
		rule: !existing.categoryRules.some((r) => r.name === PROBE.rule)
	};

	if (absent.category) {
		assertOk(
			'probe category',
			await submitForm(victim, '/categories?/createCategory', { name: PROBE.category })
		);
	}
	if (absent.transaction) {
		assertOk(
			'probe transaction',
			await submitForm(victim, '/?/createTransaction', {
				date: '2026-06-20',
				label: PROBE.transactionLabel,
				amount: '-64.00',
				category: PROBE.category
			})
		);
	}
	if (absent.budget) {
		assertOk(
			'probe budget',
			await submitForm(victim, '/budgets?/create', { category: PROBE.category, amount: '120' })
		);
	}
	if (absent.netWorth) {
		assertOk(
			'probe net worth account',
			await submitForm(victim, '/net-worth?/create', {
				name: PROBE.netWorth,
				type: 'savings',
				balance: '900'
			})
		);
	}
	if (absent.goal) {
		assertOk(
			'probe savings goal',
			await submitForm(victim, '/net-worth?/createSavingsGoal', {
				name: PROBE.goal,
				targetAmount: '2000',
				trackingMode: 'manual',
				// REACHED on purpose (current >= target). dismissReachedBanner filters on
				// `reachedAt: { not: null }`, so against an unreached goal it answers 404 to its
				// OWNER too. That is the calibration leg earning its place: without it, this
				// probe's 404 would have been counted as proof of scoping when it was proof of
				// nothing. The two states "refused because it is not yours" and "refused because
				// it is not reached" are the same reading through the attacker leg alone.
				currentAmount: '2000'
			})
		);
	}
	if (absent.rule) {
		assertOk(
			'probe rule',
			await submitForm(victim, '/rules?/create', {
				name: PROBE.rule,
				matchText: PROBE.transactionLabel,
				targetCategory: PROBE.category
			})
		);
	}

	// One read of /net-worth, and it is not incidental. `reachedAt` is written LAZILY, the first
	// time a read detects the target is met (savings-goals/service.ts, "write on change", the same
	// pattern as NetWorthSnapshot), so a goal created at 2000/2000 still carries `reachedAt: null`
	// until somebody looks at the page. dismissReachedBanner filters on `reachedAt: { not: null }`,
	// so without this line the probe answers 404 to its owner and its attacker leg proves nothing.
	// The user path that sets it is exactly this: open the page and see the banner.
	await victim.get('/net-worth');

	const backup = (await (await victim.get('/settings/export')).json()) as BackupShape;
	const transaction = backup.transactions.find((t) => t.label === PROBE.transactionLabel);
	const category = backup.categories.find((c) => c.name === PROBE.category);
	if (!transaction || !category)
		throw new Error('seedVictimRows: probe rows are not in the export');

	// The tag is created through the transaction, which is the only path that creates one.
	// Idempotent by nature: saveTags replaces the transaction's whole tag set with what is sent.
	assertOk(
		'probe tag',
		await submitForm(victim, '/transactions?/saveTags', {
			transactionId: transaction.id,
			tags: PROBE.tag
		})
	);

	const withTag = (await (await victim.get('/settings/export')).json()) as BackupShape;
	const tag = withTag.tags.find((t) => t.name === PROBE.tag);
	// By NAME, not by id: MonthlyBudget references its category as text (`categoryName`), one of
	// the five columns CLAUDE.md records as naming a category by displayed text rather than by
	// key. Reading it as `categoryId` returned undefined and the seed refused, which is the guard
	// working rather than a defect.
	const budget = withTag.monthlyBudgets.find((b) => b.categoryName === PROBE.category);
	const netWorth = withTag.netWorthAccounts.find((a) => a.name === PROBE.netWorth);
	const goal = withTag.savingsGoals.find((g) => g.name === PROBE.goal);
	const rule = withTag.categoryRules.find((r) => r.name === PROBE.rule);
	const missing = Object.entries({ tag, budget, netWorth, goal, rule })
		.filter(([, row]) => !row)
		.map(([name]) => name);
	if (missing.length > 0) {
		throw new Error(`seedVictimRows: probe rows missing from the export: ${missing.join(', ')}`);
	}

	return {
		transactionId: transaction.id,
		tagId: tag!.id,
		categoryId: category.id,
		budgetId: budget!.id,
		netWorthId: netWorth!.id,
		goalId: goal!.id,
		ruleId: rule!.id,
		sessionId: await secondVictimSessionId()
	};
}

/**
 * A real second session for the victim, so `revokeSession` has a genuine target.
 *
 * The settings page renders a revoke form only for sessions that are NOT the current one, which
 * is why a second login is needed rather than scraping the session already in hand.
 */
async function secondVictimSessionId(): Promise<string> {
	const second = await contextFor(VICTIM);
	await second.dispose();

	const html = await (await victim.get('/settings')).text();
	const id = /name="sessionId" value="([^"]+)"/.exec(html)?.[1];
	if (!id) throw new Error('secondVictimSessionId: no revocable session rendered on /settings');
	return id;
}

interface BackupShape {
	transactions: { id: string; label: string }[];
	categories: { id: string; name: string }[];
	tags: { id: string; name: string }[];
	monthlyBudgets: { id: string; categoryName: string }[];
	netWorthAccounts: { id: string; name: string }[];
	savingsGoals: { id: string; name: string }[];
	categoryRules: { id: string; name: string }[];
}

/**
 * One id-bearing action, the payload both legs fire, and the outcome the ATTACKER leg must
 * produce.
 *
 * The outcome is declared per action rather than assumed uniform, because "was it refused" turns
 * out to be the wrong question for one of them and asserting a single shape hid that. A
 * correctly scoped bulk operation answers `success` while touching nothing: `undoBulkTag` runs
 * one `deleteMany` filtered on `transaction: { userId }`, so the attacker's call matches zero
 * rows, and deleting zero rows is not an error. The first version of this file asserted "every
 * action refuses" and went red on code that is right.
 *
 * Declaring the expected outcome is what makes the assertion say the REASON. A row moving from
 * `refused-404` to `success` is a boundary failing. A row moving from `scoped-noop` to
 * `refused-404` is not a security regression but it is a behaviour change, and it should be read
 * rather than absorbed.
 */
type AttackerOutcome =
	/** The row is looked up scoped to the caller, is not found, and the action fails. */
	| 'refused-404'
	/** The write is filtered by userId in SQL, matches nothing, and reports success. */
	| 'scoped-noop';

interface Probe {
	label: string;
	path: string;
	outcome: AttackerOutcome;
	fields: (ids: VictimIds) => Record<string, string>;
}

// Ported from scripts/security/idor.sh, same actions and same field names. Ordered so the owner
// calibration leg can run top to bottom: every mutation of a row precedes its deletion.
const PROBES: Probe[] = [
	// ORDER IS LOAD-BEARING, and only for the owner leg: several of these actions destroy the
	// precondition of a later one when they succeed. Measured, not anticipated. The first version
	// ran `saveTags` first, which REPLACES a transaction's whole tag set and prunes the orphan, so
	// the probe tag was gone before renameTag/recolorTag/deleteTag reached it and three owner legs
	// reported 404 against an application that was working. The attacker leg is order-independent
	// (nothing it fires succeeds), so this sequence exists entirely for the calibration.
	{
		label: 'renameTag',
		outcome: 'refused-404',
		path: '/settings?/renameTag',
		fields: (i) => ({ id: i.tagId, newName: 'hacked' })
	},
	{
		label: 'recolorTag',
		outcome: 'refused-404',
		path: '/settings?/recolorTag',
		fields: (i) => ({ id: i.tagId, colorToken: 'azure' })
	},
	{
		label: 'deleteTag',
		outcome: 'refused-404',
		path: '/settings?/deleteTag',
		fields: (i) => ({ id: i.tagId })
	},
	{
		label: 'undoBulkTag',
		outcome: 'scoped-noop',
		path: '/transactions?/undoBulkTag',
		fields: (i) => ({ tagId: i.tagId, transactionIds: i.transactionId })
	},
	{
		label: 'saveTags',
		outcome: 'refused-404',
		path: '/transactions?/saveTags',
		fields: (i) => ({ transactionId: i.transactionId, tags: 'HACKED' })
	},
	{
		label: 'saveManualCategory',
		outcome: 'refused-404',
		path: '/transactions?/saveManualCategory',
		fields: (i) => ({ transactionId: i.transactionId, manualCategory: 'Logement' })
	},
	{
		label: 'saveManualNature',
		outcome: 'refused-404',
		path: '/transactions?/saveManualNature',
		fields: (i) => ({ transactionId: i.transactionId, manualNature: 'income' })
	},
	{
		label: 'acceptSuggestion',
		outcome: 'refused-404',
		path: '/transactions?/acceptSuggestion',
		fields: (i) => ({ transactionId: i.transactionId, category: 'Logement' })
	},
	{
		label: 'saveSplits-clear',
		outcome: 'refused-404',
		path: '/transactions?/saveSplits',
		fields: (i) => ({ transactionId: i.transactionId, splitIntent: 'clear' })
	},
	{
		label: 'budgets-update',
		outcome: 'refused-404',
		path: '/budgets?/update',
		fields: (i) => ({ id: i.budgetId, category: PROBE.category, amount: '9' })
	},
	{
		label: 'networth-update',
		outcome: 'refused-404',
		path: '/net-worth?/update',
		fields: (i) => ({ id: i.netWorthId, type: 'investment', name: 'HACKED', balance: '1' })
	},
	{
		label: 'savingsGoal-update',
		outcome: 'refused-404',
		path: '/net-worth?/updateSavingsGoal',
		fields: (i) => ({
			id: i.goalId,
			name: 'HACKED',
			targetAmount: '1',
			trackingMode: 'manual',
			// Kept at or above the target so the goal stays REACHED: the next probe needs it.
			currentAmount: '1'
		})
	},
	{
		label: 'savingsGoal-dismiss',
		outcome: 'refused-404',
		path: '/net-worth?/dismissSavingsGoalReachedBanner',
		fields: (i) => ({ id: i.goalId })
	},
	{
		label: 'rules-toggle',
		outcome: 'refused-404',
		path: '/rules?/toggle',
		fields: (i) => ({ id: i.ruleId, enabled: 'false' })
	},
	{
		label: 'rules-update',
		outcome: 'refused-404',
		path: '/rules?/update',
		fields: (i) => ({
			id: i.ruleId,
			name: 'HACKED',
			matchText: 'X',
			targetCategory: PROBE.category
		})
	},
	// Renames the probe category, so everything above that names it by text has already run.
	{
		label: 'cat-rename',
		outcome: 'refused-404',
		path: '/categories?/renameCategory',
		fields: (i) => ({ id: i.categoryId, newName: 'HACKED' })
	},
	{
		label: 'revokeSession',
		outcome: 'refused-404',
		path: '/settings?/revokeSession',
		fields: (i) => ({ sessionId: i.sessionId })
	},
	// Destructive, last, so the owner leg reaches every mutation above first. This half is also
	// this file's cleanup: it removes every row seeded for the probe.
	{
		label: 'budgets-delete',
		outcome: 'refused-404',
		path: '/budgets?/delete',
		fields: (i) => ({ id: i.budgetId })
	},
	{
		label: 'networth-delete',
		outcome: 'refused-404',
		path: '/net-worth?/delete',
		fields: (i) => ({ id: i.netWorthId })
	},
	{
		label: 'savingsGoal-delete',
		outcome: 'refused-404',
		path: '/net-worth?/deleteSavingsGoal',
		fields: (i) => ({ id: i.goalId })
	},
	{
		label: 'rules-delete',
		outcome: 'refused-404',
		path: '/rules?/delete',
		fields: (i) => ({ id: i.ruleId })
	},
	{
		label: 'deleteTransaction',
		outcome: 'refused-404',
		path: '/transactions?/deleteTransaction',
		fields: (i) => ({ transactionId: i.transactionId })
	},
	{
		label: 'cat-delete',
		outcome: 'refused-404',
		path: '/categories?/deleteCategory',
		fields: (i) => ({ id: i.categoryId })
	}
];

/**
 * The attacker-visible outcome of one action, as a comparable token.
 *
 * A `redirect` is called out separately and never silently folded into a refusal: it is what an
 * UNAUTHENTICATED request gets (a 303 to /login), so treating it as "refused" would let a
 * battery whose attacker context never logged in report a perfectly held boundary.
 */
function classify(result: ActionResult): string {
	if (result.type === 'redirect') return `redirect/${result.location ?? '?'}`;
	if (result.type === 'success')
		return result.status === 200 ? 'scoped-noop' : `success/${result.status}`;
	return result.status === 404 ? 'refused-404' : `${result.type}/${result.status}`;
}

test.describe('two-account authorization battery', () => {
	// Before a single refusal is believed, prove the two contexts are two different accounts.
	// If newContext had inherited the shared storageState, both would answer with the victim's
	// address and every "attack" below would be the victim acting on their own rows.
	test('calibration: the attacker and the victim are genuinely different accounts', async () => {
		const victimIdentity = await whoAmI(victim);
		const attackerIdentity = await whoAmI(attacker);

		expect(victimIdentity).toBe(E2E_USER_EMAIL);
		expect(attackerIdentity).toBe(E2E_BOOTSTRAP_ADMIN_EMAIL);
		expect(attackerIdentity).not.toBe(victimIdentity);
	});

	test('v5.0.0-8.2.2/8.3.1/8.4.1: every id-bearing action refuses the other account, and the victim is unchanged', async () => {
		const before = await fingerprint(victim);

		const observed: Record<string, string> = {};
		for (const probe of PROBES) {
			const result = await submitForm(attacker, probe.path, probe.fields(ids));
			observed[probe.label] = classify(result);
		}

		// Compared as one map rather than action by action, so the failure message names every row
		// that moved and in which direction, instead of stopping at the first.
		const declared = Object.fromEntries(PROBES.map((probe) => [probe.label, probe.outcome]));
		expect(observed).toEqual(declared);

		// The property itself. Everything above is the sharper signal; this is the one that would
		// catch an action nobody thought to declare, or a write that lands somewhere the outcome
		// code cannot see.
		const after = await fingerprint(victim);
		expect(after).toBe(before);
	});

	// The victim's session must still work: the whole point of the revokeSession probe is that
	// an attacker cannot log another account out, and a fingerprint of owned rows cannot see it.
	test('v5.0.0-8.4.1: the attacker could not revoke the victim session', async () => {
		const response = await victim.get('/settings/export');

		expect(response.status()).toBe(200);
	});

	test('calibration: the OWNER can perform every one of those actions on their own rows', async () => {
		const failures: string[] = [];
		for (const probe of PROBES) {
			const result = await submitForm(victim, probe.path, probe.fields(ids));
			if (result.type !== 'success' && result.type !== 'redirect') {
				failures.push(`${probe.label} -> ${result.type} ${result.status}`);
			}
		}

		// A failure here does NOT mean scoping is broken. It means the probe above proved nothing:
		// the payload, the id or the action name is wrong, and the attacker's refusal could have
		// been the same wrongness rather than the boundary holding.
		expect(
			failures,
			`owner legs that failed, so their attacker legs prove nothing: ${failures.join(', ')}`
		).toEqual([]);
	});
});

test.describe('function-level access (v5.0.0-8.2.1)', () => {
	// Every surface guarded by requireAdmin. The load is a GET; the four actions are POSTs.
	interface AdminSurface {
		label: string;
		method: 'GET' | 'POST';
		path: string;
		fields: Record<string, string>;
	}

	const ADMIN_SURFACES: AdminSurface[] = [
		{ label: 'load', method: 'GET', path: '/admin', fields: {} },
		{
			label: 'deleteUser',
			method: 'POST',
			path: '/admin?/deleteUser',
			fields: { userId: 'does-not-exist' }
		},
		{
			label: 'resetPassword',
			method: 'POST',
			path: '/admin?/resetPassword',
			fields: { userId: 'does-not-exist', newPassword: 'Irrelevant123!' }
		},
		{
			label: 'createInvitation',
			method: 'POST',
			path: '/admin?/createInvitation',
			fields: { email: 'nobody@budgetpilot.test' }
		},
		{
			label: 'revokeInvitation',
			method: 'POST',
			path: '/admin?/revokeInvitation',
			fields: { id: 'does-not-exist' }
		}
	];

	test('a non-admin is refused by every admin surface', async () => {
		const notRefused: string[] = [];
		for (const surface of ADMIN_SURFACES) {
			const response =
				surface.method === 'GET'
					? await victim.get(surface.path, { maxRedirects: 0 })
					: await victim.post(surface.path, { form: surface.fields, maxRedirects: 0 });
			if (response.status() !== 403) {
				notRefused.push(`${surface.label} -> ${response.status()}`);
			}
		}

		expect(notRefused, `admin surfaces that did not answer 403: ${notRefused.join(', ')}`).toEqual(
			[]
		);
	});

	// The calibration the assessment's own evidence names: without it, a 403 cannot be told apart
	// from a route that is broken, renamed or gone.
	test('calibration: an admin reaches every one of those surfaces', async () => {
		const refusedForAdmin: string[] = [];
		for (const surface of ADMIN_SURFACES) {
			const response =
				surface.method === 'GET'
					? await attacker.get(surface.path, { maxRedirects: 0 })
					: await attacker.post(surface.path, { form: surface.fields, maxRedirects: 0 });
			if (response.status() === 403) refusedForAdmin.push(surface.label);
		}

		expect(
			refusedForAdmin,
			`surfaces that 403'd an ADMIN, so their non-admin 403 proves nothing: ${refusedForAdmin.join(', ')}`
		).toEqual([]);
	});

	// A guard protects only what it inspects, and this list is the inspection. An admin action
	// added later with no entry above would be untested while the suite stayed green, which is
	// precisely the shape that let the tags-chantier defect survive two PRs.
	test('the list above is every requireAdmin surface in the application', () => {
		const source = readFileSync('src/routes/admin/+page.server.ts', 'utf8');
		const callSites = source.match(/requireAdmin\(/g) ?? [];

		// Calibration: a scan that matched nothing would report the same empty difference as a
		// perfectly enumerated list.
		expect(callSites.length).toBeGreaterThan(0);
		expect(callSites).toHaveLength(ADMIN_SURFACES.length);

		const elsewhere = [
			'/transactions',
			'/budgets',
			'/net-worth',
			'/rules',
			'/categories',
			'/settings'
		]
			.map((route) => `src/routes${route}/+page.server.ts`)
			.filter((path) => readFileSync(path, 'utf8').includes('requireAdmin'));
		expect(elsewhere).toEqual([]);
	});
});
