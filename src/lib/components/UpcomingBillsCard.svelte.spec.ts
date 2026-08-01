import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UpcomingBillsCard from './UpcomingBillsCard.svelte';
import { formatCents } from '$lib/domain/budget';
import type { UpcomingBillRowView, UpcomingBillsWidgetView } from '$lib/server/upcoming-bills/service';

const TODAY_ISO = '2026-08-01';

function buildRow(overrides: Partial<UpcomingBillRowView> = {}): UpcomingBillRowView {
	return {
		rowKey: 'expense:edf:2026-08-05:0',
		label: 'EDF',
		initials: 'ED',
		category: 'Logement',
		direction: 'expense',
		tier: 'confirmed',
		occurrenceCount: 6,
		cadence: 'monthly',
		anchorDayOfMonth: 5,
		dateIso: '2026-08-05',
		status: 'upcoming',
		daysLate: null,
		estimatePassed: false,
		settledKind: null,
		amountCents: -4500,
		averageAmountCents: 4500,
		minAmountCents: 4400,
		maxAmountCents: 4600,
		variability: 'fixed',
		countsInRemainingTotal: true,
		appliedActionId: null,
		actionPayload: {
			direction: 'expense',
			normalizedLabel: 'edf',
			label: 'EDF',
			dueDate: '2026-08-05',
			anchorTransactionIds: '[]'
		},
		...overrides
	};
}

function buildWidget(overrides: Partial<UpcomingBillsWidgetView> = {}): UpcomingBillsWidgetView {
	return {
		rows: [buildRow()],
		overdueCount: 0,
		remainingExpenseCents: 4500,
		hasStreams: true,
		todayIso: TODAY_ISO,
		...overrides
	};
}

// Mirrors the component's own formatting, so an assertion pins the exact string it renders rather
// than a hand-copied one that could silently drift from a real run (narrow no-break space around
// the thousands separator, non-break space before the currency symbol, U+2212 minus).
function signedFixed(cents: number): string {
	return `${cents >= 0 ? '+' : '−'}${formatCents(Math.abs(cents))}`;
}

function wholeEuros(magnitudeCents: number): string {
	return new Intl.NumberFormat('fr', {
		style: 'currency',
		currency: 'EUR',
		maximumFractionDigits: 0
	}).format(magnitudeCents / 100);
}

describe('UpcomingBillsCard.svelte', () => {
	it('always renders the footer label, visibly, on a populated view', async () => {
		const { container } = render(UpcomingBillsCard, { widget: buildWidget() });

		const footerLabel = page.getByText('Reste à sortir · 30 prochains jours');
		await expect.element(footerLabel).toBeVisible();

		// `toBeVisible()` alone doesn't pin the locked decision that the footer never gets a
		// breakpoint-hiding variant — assert directly that no such class sits on its subtree.
		const footer = container.querySelector('.border-t.border-zinc-100');
		expect(footer).not.toBeNull();
		expect(footer?.className).not.toMatch(/(^|\s)(max-)?(sm|md|lg|xl):hidden(\s|$)/);
		expect(footer?.querySelector('[class*=":hidden"]')).toBeNull();
	});

	it('renders the overdue badge only when overdueCount > 0', async () => {
		const { unmount } = render(UpcomingBillsCard, { widget: buildWidget({ overdueCount: 2 }) });

		await expect.element(page.getByText('2 en retard')).toBeInTheDocument();
		unmount();

		render(UpcomingBillsCard, { widget: buildWidget({ overdueCount: 0 }) });

		expect(page.getByText(/en retard/).elements().length).toBe(0);
	});

	it('carries the amber contrast classes on an overdue row and none on a non-overdue row', async () => {
		const { container } = render(UpcomingBillsCard, {
			widget: buildWidget({
				overdueCount: 1,
				rows: [
					buildRow({
						rowKey: 'overdue-row',
						status: 'overdue',
						daysLate: 3,
						dateIso: '2026-07-29'
					}),
					buildRow({ rowKey: 'upcoming-row', status: 'upcoming', dateIso: '2026-08-05' })
				]
			})
		});

		const amberRows = container.querySelectorAll('[class*="bg-amber-50"][class*="border-amber-200"]');
		expect(amberRows.length).toBe(1);
		expect(container.querySelector('.text-amber-700')).not.toBeNull();
	});

	it('writes the overdue lateness as text', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({
				overdueCount: 1,
				rows: [buildRow({ rowKey: 'overdue-row', status: 'overdue', daysLate: 3, dateIso: '2026-07-29' })]
			})
		});

		await expect.element(page.getByText('3 j de retard')).toBeInTheDocument();
	});

	it('renders the EmptyState, keeps the card title and hides the footer when no stream was ever detected', async () => {
		const { container } = render(UpcomingBillsCard, {
			widget: buildWidget({ rows: [], overdueCount: 0, hasStreams: false, remainingExpenseCents: 0 })
		});

		await expect.element(page.getByText('Échéances à venir')).toBeInTheDocument();
		await expect.element(page.getByText('Aucun flux détecté')).toBeInTheDocument();
		// No total exists in this state, so nothing should conflict with the neighbouring forecast
		// card's — the footer (and its second link to the same page) must not render (design A3).
		expect(page.getByText('Reste à sortir · 30 prochains jours').elements().length).toBe(0);
		expect(container.querySelectorAll('a[href="/upcoming-bills"]').length).toBe(1);
	});

	it('renders a different empty state, still without a footer, when streams exist but none survive into the window', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({ rows: [], overdueCount: 0, hasStreams: true, remainingExpenseCents: 0 })
		});

		await expect.element(page.getByText('Échéances à venir')).toBeInTheDocument();
		await expect
			.element(page.getByText('Rien de prévu dans les 30 prochains jours.'))
			.toBeInTheDocument();
		// Must NOT reuse the "nothing detected" copy — streams WERE detected, just none are due.
		expect(page.getByText('Aucun flux détecté').elements().length).toBe(0);
		expect(page.getByText('Reste à sortir · 30 prochains jours').elements().length).toBe(0);
	});

	it('hides rows past index 2 below lg and keeps the first 3 visible on both breakpoints', async () => {
		const rows = Array.from({ length: 5 }, (_, index) =>
			buildRow({
				rowKey: `row-${index}`,
				label: `Flux ${index}`,
				dateIso: `2026-08-0${index + 1}`
			})
		);
		const { container } = render(UpcomingBillsCard, { widget: buildWidget({ rows }) });

		const rowEls = container.querySelectorAll('.divide-y > div');
		expect(rowEls.length).toBe(5);
		rowEls.forEach((row, index) => {
			if (index >= 3) {
				expect(row.className).toMatch(/(^|\s)max-lg:hidden(\s|$)/);
			} else {
				expect(row.className).not.toMatch(/(^|\s)max-lg:hidden(\s|$)/);
			}
		});
	});

	it('never re-totals: the displayed total is the server-supplied remainingExpenseCents, even when it contradicts the row amounts', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [buildRow({ amountCents: -100, minAmountCents: 100, maxAmountCents: 100 })],
				// Deliberately does not match the single row's amount: proves the component reads this
				// field rather than summing `rows` itself.
				remainingExpenseCents: 999_900
			})
		});

		await expect.element(page.getByText(signedFixed(-999_900))).toBeInTheDocument();
	});

	it('renders "0,00 €" rather than "-0,00 €" when nothing is due', async () => {
		render(UpcomingBillsCard, { widget: buildWidget({ remainingExpenseCents: 0 }) });

		await expect.element(page.getByText(formatCents(0))).toBeInTheDocument();
		expect(page.getByText('-0,00 €').elements().length).toBe(0);
		expect(page.getByText('−0,00 €').elements().length).toBe(0);
	});

	it('signs a fixed-amount expense row with a minus and an income row with a plus', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [
					buildRow({ rowKey: 'expense', direction: 'expense', amountCents: -4890 }),
					buildRow({ rowKey: 'income', direction: 'income', amountCents: 320_000 })
				]
			})
		});

		await expect.element(page.getByText(signedFixed(-4890))).toBeInTheDocument();
		await expect.element(page.getByText(signedFixed(320_000))).toBeInTheDocument();
	});

	it('renders a variable row as a signed, euro-rounded range plus the "variable" tag', async () => {
		// Unsigned magnitudes in cents, as `forecast.ts` documents them.
		render(UpcomingBillsCard, {
			widget: buildWidget({
				rows: [
					buildRow({
						rowKey: 'variable-row',
						direction: 'expense',
						amountCents: -8000,
						variability: 'variable',
						minAmountCents: 7412,
						maxAmountCents: 9587
					})
				]
			})
		});

		// Signed AND rounded to whole euros — not "74,12 € à 95,87 €", which would carry no sign and a
		// false precision (F1).
		await expect
			.element(page.getByText(`−${wholeEuros(7412)} à −${wholeEuros(9587)}`))
			.toBeInTheDocument();
		await expect.element(page.getByText('variable')).toBeInTheDocument();
	});
});
