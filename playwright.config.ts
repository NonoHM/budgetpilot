import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_ENV, E2E_PORT } from './e2e/config';

export default defineConfig({
	testDir: 'e2e',
	// Chromium only, deliberately: matches the vitest "client" browser project
	// (@vitest/browser-playwright, see vite.config.ts) and CI only installs Chromium
	// (`playwright install --with-deps chromium`). Without this, Playwright falls back to its
	// default 3-project set (chromium/firefox/webkit) and CI fails trying to launch Firefox/WebKit
	// with no system deps installed for them.
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	// Test files under e2e/ are named *.spec.ts (helper modules like config.ts/seed.ts are
	// excluded automatically since they don't match this glob).
	testMatch: '**/*.spec.ts',
	globalSetup: './e2e/global-setup.ts',
	// Forced serial: every spec shares one server + one SQLite DB file seeded with a single
	// dataset (SEEDED_BUDGET_CATEGORY, SEEDED_SAVINGS_GOAL_NAME, the seeded net-worth account,
	// etc. — see e2e/seed.ts). Playwright's default worker count runs spec *files* concurrently
	// even with fullyParallel off, which caused genuine cross-file races on those shared rows
	// (e.g. one file's extra net-worth account showing up mid-assertion in another file's test).
	// This suite was designed for sequential reuse, not per-file isolation.
	workers: 1,
	// 2 retries: the recurring full-suite-only flake (never reproduces in single-file/isolated
	// runs) is a SvelteKit hydration race, not a real bug — every failing case follows the same
	// shape (page.goto() immediately followed by a click/keypress on a button that opens a
	// client-side-only overlay: AccountMenu, "More" menu, a modal trigger) and the captured DOM
	// snapshot on failure shows the trigger present with its pre-interaction state unchanged
	// (e.g. aria-expanded stays "false" right after Enter is pressed) — the event fired before
	// Bits UI's handler attached, not a missing feature. Playwright can fire the interaction
	// before the client JS bundle finishes hydrating, which becomes more likely to lose the race
	// as the single long-lived `npm run preview` server serves more requests over a full run.
	// Confirmed via `npx playwright test --retries=3 -g "..."` on the single worst-offending
	// test: it failed once, then passed — a genuine regression fails deterministically even on
	// retry, a lost hydration race does not. Raising timeouts was tried first and did not help
	// (the element is genuinely there and interactive, just not wired up yet), so retrying is the
	// correct mitigation, not a longer wait.
	retries: 2,
	use: {
		baseURL: E2E_BASE_URL,
		// Every spec inherits this authenticated session for free — written by global-setup.ts
		// via e2e/seed.ts. No spec needs to perform its own login.
		storageState: 'e2e/.auth/user.json'
		// Locale is no longer pinned here via Chromium's `locale` option (which only steered the
		// app indirectly, through Accept-Language and Paraglide's 'preferredLanguage' fallback
		// strategy). The suite now sets the app's own PARAGLIDE_LOCALE cookie directly — see
		// e2e/fixtures.ts — so "this suite renders in French" is an explicit, declared fact in
		// test code rather than an inferred side effect of the browser's default locale.
	},
	webServer: {
		command: `npm run build && npm run preview -- --port ${E2E_PORT} --strictPort`,
		// Distinct from 4173 (default `npm run preview`) and 3000/5173 (dev) so this suite can run
		// alongside a local `npm run dev` without a port collision.
		port: E2E_PORT,
		// `port` (not `url`): Playwright's readiness probe is then a bare TCP connect, never a real
		// HTTP request — see global-setup.ts's comment on ordering for why that matters (it must
		// never touch the DB file before global-setup has deleted/re-migrated it).
		reuseExistingServer: false,
		timeout: 120_000,
		env: E2E_ENV
	}
});
