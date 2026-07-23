import { expect, test } from './fixtures';
import * as m from '../src/lib/paraglide/messages';

// /imports/bank-connections got a per-bucket net worth link UI this batch (Modal +
// Select/Combobox reusing the ?/linkAccount action, "Connecté" badge on linked buckets —
// see CLAUDE.md's bank-sync/net-worth-link entry). Whether BANK_SYNC_ENABLED is true in this
// environment depends on inherited shell env (the webServer's env is merged onto process.env,
// not exclusive to .env.test — BANK_SYNC_ENABLED isn't pinned in .env.test), so this spec
// asserts on whichever of the two states actually renders rather than assuming one.
//
// Exercising the link modal itself end-to-end would require a real bank connection, which
// this suite deliberately can't produce even when the flag is on: the route only ever exposes
// the real Enable Banking provider (never the mock connector), so there is no e2e-safe way to
// reach a bank's consent screen, and seeding a BankConnection/Account row directly would
// violate this suite's "only through real form actions, never a direct Prisma insert" rule.
// That flow's server logic (linkBankAccountToNetWorth, D4, recordSyncedBalance's
// write-on-change) is covered at the unit level instead (service.spec.ts). This spec covers
// what IS reachable e2e: the page renders without crashing in either state, and the
// "connect a bank" progressive disclosure opens when enabled.
test.describe('bank connections page', () => {
	test('renders without crashing, in whichever bank-sync state this environment has', async ({
		page
	}) => {
		await page.goto('/imports/bank-connections');

		await expect(
			page.getByRole('heading', { name: m.bank_connections_heading(), level: 1 })
		).toBeVisible();

		const disabledNotice = page.getByText(m.bank_connections_disabled_notice());
		const connectionsSection = page.getByRole('heading', {
			name: m.bank_connections_list_title(),
			level: 2
		});

		await expect(disabledNotice.or(connectionsSection)).toBeVisible();
	});

	test('is reachable from the imports page', async ({ page }) => {
		await page.goto('/imports');
		await page.getByRole('link', { name: m.bank_connections_heading() }).click();
		await expect(page).toHaveURL(/\/imports\/bank-connections/);
	});

	test('"connect a bank" disclosure opens when bank sync is enabled here', async ({ page }) => {
		await page.goto('/imports/bank-connections');

		const connectCta = page.getByRole('button', { name: m.bank_connections_connect_cta() });
		if (!(await connectCta.isVisible().catch(() => false))) {
			test.skip(true, 'BANK_SYNC_ENABLED is off in this environment — nothing to open here.');
		}

		await connectCta.click();
		await expect(
			page.getByRole('heading', { name: m.bank_connections_connect_title() })
		).toBeVisible();
		await expect(page.getByLabel(m.bank_connections_country_label())).toBeVisible();
	});
});
