// Creates the e2e test account + a minimal, representative dataset — through the app's real
// HTTP routes/actions only (never a direct Prisma insert), so seeded data always satisfies the
// same business invariants as a real user's data (default categories, validation, etc.). Mirrors
// scripts/seed-dev.mjs's submitForm pattern, adapted to Playwright's APIRequestContext so the
// resulting cookie jar can be dumped straight into a storageState file. scripts/seed-dev.mjs
// itself is untouched — it remains dedicated to seeding the real dev.db by hand.
//
// Response contract note: Playwright's APIRequestContext sends `Accept: */*` by default, which
// SvelteKit's action content negotiation (`is_action_json_request`) treats as a match for
// `application/json` (first in its negotiation list) — so every form action response here comes
// back as SvelteKit's JSON ActionResult (`{ type: 'success'|'failure'|'redirect'|'error', ... }`)
// with HTTP 200 in all non-'error' cases (the real semantic status lives in the JSON body's
// `status` field, not the HTTP status code) — never a plain HTML re-render. Checking `type` is
// therefore the only reliable way to detect success here.
import { request, type APIRequestContext } from '@playwright/test';
import { E2E_BASE_URL, E2E_ENV } from './config';

export const E2E_USER_EMAIL = 'e2e@budgetpilot.test';
export const E2E_USER_PASSWORD = 'E2eBudgetPilot123!';
// The disposable first account (see createE2eUserAsSecondAccount). Exported ONLY so a spec can
// obtain a second, genuinely different `user.id` to prove a cross-user isolation claim against
// real SQL — never to give a spec admin powers it does not need.
export const E2E_BOOTSTRAP_ADMIN_EMAIL = 'e2e-bootstrap-admin@budgetpilot.test';
export const E2E_BOOTSTRAP_ADMIN_PASSWORD = 'E2eBootstrapAdmin123!';

// Known seeded data — reused by e2e specs (including the upcoming Modal/Dropdown chantier) to
// target elements by their label instead of re-discovering state. Keep in sync with the
// creations below if this file changes.
export const SEEDED_TRANSACTION_LABELS = ['CARREFOUR MARKET', 'SNCF CONNECT PARIS'] as const;
// Both are seeded default categories (ensureDefaultCategoriesSeeded), not custom categories —
// stable across runs/locales (base locale is fr).
export const SEEDED_BUDGET_CATEGORY = 'Alimentation';
export const SEEDED_NET_WORTH_ACCOUNT_NAME = 'Livret e2e';
export const SEEDED_SAVINGS_GOAL_NAME = 'Fonds urgence e2e';

export async function seedE2eData(options: { storageStatePath: string }): Promise<void> {
	// The first user on a fresh DB always becomes ADMIN (register/+page.server.ts) — the
	// throwaway e2e DB is empty on every run, which would otherwise silently make the shared
	// e2e@budgetpilot.test account an admin (security-reviewer finding: the shared storageState
	// session must be a plain USER unless a future spec explicitly documents needing admin).
	// registration_mode=admin_only also means a second account can ONLY be created by an
	// already-authenticated admin (POST /register while logged in as ADMIN), never by a second
	// anonymous self-registration — so a disposable bootstrap admin registers itself first, then
	// uses its own admin session to create the real e2e account (landing on the USER branch),
	// then that bootstrap session is discarded without ever being persisted to storageState.
	await createE2eUserAsSecondAccount();

	const context = await request.newContext({
		baseURL: E2E_BASE_URL,
		// SvelteKit's built-in CSRF check compares the Origin header against the request's own
		// origin — undici's fetch (used by APIRequestContext) doesn't add it automatically for
		// same-origin requests the way a browser would, so it must be set explicitly (same reason
		// scripts/seed-dev.mjs sets it).
		extraHTTPHeaders: { Origin: E2E_BASE_URL }
	});

	try {
		await loginE2eUser(context);
		await createTransaction(context, {
			date: '2026-06-05',
			label: SEEDED_TRANSACTION_LABELS[0],
			amount: '-42.90',
			category: SEEDED_BUDGET_CATEGORY
		});
		await createTransaction(context, {
			date: '2026-06-12',
			label: SEEDED_TRANSACTION_LABELS[1],
			amount: '-18.50',
			category: 'Transport'
		});
		await createBudget(context, { category: SEEDED_BUDGET_CATEGORY, amount: '250' });
		await createNetWorthAccount(context, {
			name: SEEDED_NET_WORTH_ACCOUNT_NAME,
			type: 'savings',
			balance: '5000'
		});
		await createSavingsGoal(context, {
			name: SEEDED_SAVINGS_GOAL_NAME,
			targetAmount: '10000',
			trackingMode: 'manual',
			currentAmount: '5000'
		});

		await context.storageState({ path: options.storageStatePath });
	} finally {
		await context.dispose();
	}
}

export interface ActionResult {
	type: 'success' | 'failure' | 'redirect' | 'error';
	status: number;
	location?: string;
}

export async function submitForm(
	context: APIRequestContext,
	path: string,
	fields: Record<string, string>
): Promise<ActionResult> {
	const res = await context.post(path, { form: fields, maxRedirects: 0 });
	return (await res.json()) as ActionResult;
}

export function assertOk(action: string, result: ActionResult): void {
	if (result.type !== 'success' && result.type !== 'redirect') {
		throw new Error(`e2e seed: ${action} failed (${result.type}, status ${result.status})`);
	}
}

async function createE2eUserAsSecondAccount(): Promise<void> {
	const bootstrapContext = await request.newContext({
		baseURL: E2E_BASE_URL,
		extraHTTPHeaders: { Origin: E2E_BASE_URL }
	});
	try {
		// First user on the fresh DB → becomes ADMIN. This session is never persisted to
		// storageState and never reused by any spec.
		assertOk(
			'bootstrap admin placeholder',
			await submitForm(bootstrapContext, '/register', {
				email: E2E_BOOTSTRAP_ADMIN_EMAIL,
				password: E2E_BOOTSTRAP_ADMIN_PASSWORD,
				bootstrapToken: E2E_ENV.BOOTSTRAP_TOKEN ?? ''
			})
		);
		// Registering while authenticated as ADMIN is the app's real path for "admin creates a
		// second account" — currentCount is 1 at this point, so createUser's role branch lands on
		// USER (register/+page.server.ts's createUser: `role: currentCount === 0 ? 'ADMIN' : 'USER'`).
		assertOk(
			'e2e user create (as admin)',
			await submitForm(bootstrapContext, '/register', {
				email: E2E_USER_EMAIL,
				password: E2E_USER_PASSWORD,
				bootstrapToken: E2E_ENV.BOOTSTRAP_TOKEN ?? ''
			})
		);
	} finally {
		await bootstrapContext.dispose();
	}
}

export async function loginE2eUser(context: APIRequestContext): Promise<void> {
	const loginResult = await submitForm(context, '/login', {
		email: E2E_USER_EMAIL,
		password: E2E_USER_PASSWORD
	});
	assertOk('login', loginResult);
}

export async function createTransaction(
	context: APIRequestContext,
	fields: { date: string; label: string; amount: string; category: string }
): Promise<void> {
	assertOk('createTransaction', await submitForm(context, '/?/createTransaction', fields));
}

async function createBudget(
	context: APIRequestContext,
	fields: { category: string; amount: string }
): Promise<void> {
	assertOk(
		'budgets create',
		await submitForm(context, '/budgets?/create', {
			category: fields.category,
			amount: fields.amount
		})
	);
}

async function createNetWorthAccount(
	context: APIRequestContext,
	fields: { name: string; type: string; balance: string }
): Promise<void> {
	assertOk('net-worth account create', await submitForm(context, '/net-worth?/create', fields));
}

async function createSavingsGoal(
	context: APIRequestContext,
	fields: { name: string; targetAmount: string; trackingMode: string; currentAmount: string }
): Promise<void> {
	assertOk(
		'savings goal create',
		await submitForm(context, '/net-worth?/createSavingsGoal', fields)
	);
}
