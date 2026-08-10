import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('mode dashboard', () => {
	it('ne charge pas de données statiques dans la route normale', () => {
		expect.assertions(2);

		const page = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');
		const server = readFileSync(resolve(root, 'src/routes/+page.server.ts'), 'utf8');

		expect(page).not.toContain('demoTransactions');
		expect(server).not.toContain('demoTransactions');
	});

	it('masque les sections avancées sur un dashboard vide', () => {
		expect.assertions(2);

		const page = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');

		expect(page).toContain('{#if !showDashboardBody}');
		expect(page).toContain('{m.dashboard_empty_footer()}');
	});

	it('affiche le widget objectifs même sans transaction/budget (goals déclaratifs)', () => {
		expect.assertions(1);

		const page = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');

		// hasDashboardData gates the whole "state with data" branch (recent transactions, budget
		// tracking AND the savings goals widget) vs the generic "import your first statement"
		// empty state. A user who only set up savings goals/net-worth accounts, with zero
		// transactions or budgets, must still reach the savings goals widget.
		expect(page).toContain(
			'data.transactions.length > 0 || data.budgets.length > 0 || data.savingsGoals.length > 0'
		);
	});

	it('affiche le suivi des budgets dans la colonne latérale', () => {
		expect.assertions(1);

		const page = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');

		expect(page).toContain('{m.reports_budget_tracking_title()}');
	});

	it('garde les filtres transactions simples', () => {
		expect.assertions(3);

		const transactions = readFileSync(
			resolve(root, 'src/routes/transactions/+page.svelte'),
			'utf8'
		);

		// Pill tabs replace the old <select> — check presence of the 3 filter values
		expect(transactions).toContain("{ t: 'all', label: m.transactions_filter_all() }");
		expect(transactions).toContain("{ t: 'income', label: m.reports_kpi_income() }");
		expect(transactions).toContain("{ t: 'expense', label: m.reports_kpi_expense() }");
	});

	it('ne référence plus la page de démonstration', () => {
		expect.assertions(2);

		const page = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');
		const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

		expect(page).not.toContain('/demo');
		expect(readme).not.toContain('/demo');
	});

	it('garde le dashboard limité aux transactions récentes sans badges inutiles', () => {
		expect.assertions(5);

		const page = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');
		const server = readFileSync(resolve(root, 'src/routes/+page.server.ts'), 'utf8');

		expect(page).not.toContain('>Saisie manuelle</span>');
		expect(page).not.toContain('>Import CSV</span>');
		expect(page).not.toContain('>Connecteur mocké</span>');
		expect(page).toContain('{m.dashboard_view_all()}');
		// Still the plain 10 most recent — `.map` below only annotates each with its split
		// indicator (see recentSplitIndicators), it does not widen or reorder the slice.
		expect(server).toContain('recentTransactions: transactions.slice(0, 10).map(');
	});

	it('affiche une navigation simple sur les pages principales', () => {
		expect.assertions(13);

		const layout = readFileSync(resolve(root, 'src/routes/+layout.svelte'), 'utf8');
		const dashboard = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');
		const transactions = readFileSync(
			resolve(root, 'src/routes/transactions/+page.svelte'),
			'utf8'
		);
		const importPage = readFileSync(resolve(root, 'src/routes/import/+page.svelte'), 'utf8');
		const imports = readFileSync(resolve(root, 'src/routes/imports/+page.svelte'), 'utf8');
		const header = readFileSync(resolve(root, 'src/lib/components/AppHeader.svelte'), 'utf8');

		expect(header).toContain('BudgetPilot');
		expect(header).toContain('<AppNav {active} />');
		expect(layout).toContain(
			"<AppHeader {active} userEmail={data.user.email} isAdmin={data.user.role === 'ADMIN'} />"
		);
		expect(layout).toContain("page.url.pathname.startsWith('/transactions')");
		expect(layout).toContain("page.url.pathname.startsWith('/reports')");
		expect(layout).toContain("page.url.pathname.startsWith('/import')");
		expect(dashboard).not.toContain('<AppHeader');
		expect(dashboard).toContain('{m.nav_dashboard()}');
		expect(transactions).toContain('{m.nav_transactions()}');
		expect(importPage).toContain('{m.import_heading()}');
		expect(importPage).toContain('{m.import_supported_formats()}');
		expect(importPage).toContain(
			'accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"'
		);
		expect(imports).toContain('{m.imports_heading()}');
	});

	it('garde les libellés UI attendus sans exposer metadataJson brut', () => {
		expect.assertions(6);

		const dashboard = readFileSync(resolve(root, 'src/routes/+page.svelte'), 'utf8');
		const reports = readFileSync(resolve(root, 'src/routes/reports/+page.svelte'), 'utf8');
		const transactions = readFileSync(
			resolve(root, 'src/routes/transactions/+page.svelte'),
			'utf8'
		);

		expect(dashboard).toContain('{m.nav_dashboard()}');
		expect(reports).toContain('{m.reports_heading()}');
		expect(transactions).toContain('{m.transactions_bank_details_heading()}');
		expect(transactions).toContain('{m.transactions_traceability_heading()}');
		expect(transactions).not.toContain('metadataJson');
		expect(`${dashboard}${reports}${transactions}`).not.toMatch(/budgetImpact|Exclue du budget/);
	});
});
