import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UpcomingBillsCard from './UpcomingBillsCard.svelte';
import type { UpcomingBillRowView, UpcomingBillsWidgetView } from '$lib/server/upcoming-bills/service';

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
		...overrides
	};
}

describe('UpcomingBillsCard.svelte', () => {
	it('always renders the footer label, on a populated view', async () => {
		render(UpcomingBillsCard, { widget: buildWidget() });

		await expect
			.element(page.getByText('Reste à sortir · 30 prochains jours'))
			.toBeInTheDocument();
	});

	it('always renders the footer label, even with no overdue rows', async () => {
		render(UpcomingBillsCard, { widget: buildWidget({ overdueCount: 0 }) });

		await expect
			.element(page.getByText('Reste à sortir · 30 prochains jours'))
			.toBeInTheDocument();
	});

	it('renders the overdue badge only when overdueCount > 0', async () => {
		const { unmount } = render(UpcomingBillsCard, { widget: buildWidget({ overdueCount: 2 }) });

		await expect.element(page.getByText('2 en retard')).toBeInTheDocument();
		unmount();

		render(UpcomingBillsCard, { widget: buildWidget({ overdueCount: 0 }) });

		expect(page.getByText(/en retard/).elements().length).toBe(0);
	});

	it('carries the amber contrast classes on an overdue row', async () => {
		const { container } = render(UpcomingBillsCard, {
			widget: buildWidget({
				overdueCount: 1,
				rows: [
					buildRow({
						rowKey: 'overdue-row',
						status: 'overdue',
						daysLate: 3,
						dateIso: '2026-07-29'
					})
				]
			})
		});

		const row = container.querySelector('[class*="bg-amber-50"][class*="border-amber-200"]');
		expect(row).not.toBeNull();
		expect(container.querySelector('.text-amber-700')).not.toBeNull();
	});

	it('renders the EmptyState and keeps the card title when there are no streams', async () => {
		render(UpcomingBillsCard, {
			widget: buildWidget({ rows: [], overdueCount: 0, hasStreams: false, remainingExpenseCents: 0 })
		});

		await expect.element(page.getByText('Échéances à venir')).toBeInTheDocument();
		await expect.element(page.getByText('Aucun flux détecté')).toBeInTheDocument();
		await expect
			.element(page.getByText('Reste à sortir · 30 prochains jours'))
			.toBeInTheDocument();
	});

	it('renders at most 5 rows', async () => {
		const rows = Array.from({ length: 5 }, (_, index) =>
			buildRow({
				rowKey: `row-${index}`,
				label: `Flux ${index}`,
				dateIso: `2026-08-0${index + 1}`
			})
		);
		const { container } = render(UpcomingBillsCard, { widget: buildWidget({ rows }) });

		expect(container.querySelectorAll('.divide-y > div').length).toBe(5);
	});
});
