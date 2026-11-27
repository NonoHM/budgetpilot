import { describe, expect, it } from 'vitest';
import { sumIncomeAndExpense, type CategoryAllocation } from './allocation';
import { buildCashFlowSankey } from './cashFlowSankey';
import { UNCLASSIFIED_CATEGORY } from './categories';

// #190. Invented rows; every figure is checked against sumIncomeAndExpense (the period report's
// definition) and against an absolute value written here.
function row(
	category: string,
	amountCents: number,
	overrides: Partial<CategoryAllocation> = {}
): CategoryAllocation {
	return {
		transactionId: `${category}-${amountCents}`,
		date: '2026-06-10',
		category,
		amountCents,
		nature: amountCents > 0 ? 'income' : 'spending',
		kind: amountCents > 0 ? 'income' : 'expense',
		transferPaired: false,
		...overrides
	};
}

const sum = (nodes: { cents: number }[]) => nodes.reduce((total, node) => total + node.cents, 0);

describe('buildCashFlowSankey', () => {
	const allocations = [
		row('Salaire', 250_000),
		row('Remboursements', 3_000, { nature: 'refund' }),
		row('Loyer', -90_000),
		row('Courses', -40_000),
		row('Courses', -5_000, { transactionId: 'split-part' }),
		row('Transport', -12_000),
		row('Loisirs', -8_000),
		row('Santé', -4_000),
		row('Cadeaux', -2_000),
		// A confirmed transfer leg is in neither side (#212).
		row('Épargne', -50_000, { transferPaired: true, nature: 'transfer' })
	];
	const flow = buildCashFlowSankey(allocations);

	it('balances: both sides add up to the larger of income and expenses', () => {
		const { incomeCents, expenseCents } = sumIncomeAndExpense(allocations);
		expect([incomeCents, expenseCents]).toEqual([253_000, 161_000]);
		expect(flow.totalCents).toBe(253_000);
		expect(sum(flow.income) + flow.beyondIncomeCents).toBe(flow.totalCents);
		expect(sum(flow.expenses) + flow.leftOverCents).toBe(flow.totalCents);
		expect([flow.leftOverCents, flow.beyondIncomeCents]).toEqual([92_000, 0]);
	});

	it('keeps the four largest expense categories and folds the rest into Other, with their names', () => {
		expect(flow.expenses.map((node) => [node.category, node.cents])).toEqual([
			['Loyer', 90_000],
			['Courses', 45_000],
			['Transport', 12_000],
			['Loisirs', 8_000],
			[null, 6_000]
		]);
		expect(flow.expenses.at(-1)!.members).toEqual(['Santé', 'Cadeaux']);
	});

	it('keeps every income category when there are five or fewer', () => {
		expect(flow.income.map((node) => [node.category, node.cents])).toEqual([
			['Salaire', 250_000],
			['Remboursements', 3_000]
		]);
	});

	// Separates « the gap is a node on the left » from a negative flow or a dropped difference.
	it('puts spending beyond income on the left, never a negative left-over', () => {
		const deficit = buildCashFlowSankey([row('Salaire', 100_000), row('Loyer', -130_000)]);
		expect(deficit).toMatchObject({
			totalCents: 130_000,
			leftOverCents: 0,
			beyondIncomeCents: 30_000
		});
		expect(sum(deficit.income) + deficit.beyondIncomeCents).toBe(sum(deficit.expenses));
	});

	it('orders equal amounts by category so the result depends on the rows only', () => {
		const a = buildCashFlowSankey([row('B', -1_000), row('A', -1_000), row('Salaire', 5_000)]);
		const b = buildCashFlowSankey([row('A', -1_000), row('Salaire', 5_000), row('B', -1_000)]);
		expect(a.expenses.map((node) => node.category)).toEqual(['A', 'B']);
		expect(b).toEqual(a);
	});

	// Contradiction pass on the note, 2026-11-27: a zero amount is no node, and a blank pinned
	// name joins the uncategorized node instead of drawing a node with no label.
	it('draws no node for a zero amount and files a blank name under uncategorized', () => {
		const flow = buildCashFlowSankey([
			row('Salaire', 10_000),
			row('Vide', 0, { kind: 'expense' }),
			row('  ', -1_000),
			row(UNCLASSIFIED_CATEGORY, -2_000)
		]);
		expect(flow.expenses.map((node) => [node.category, node.cents])).toEqual([
			[UNCLASSIFIED_CATEGORY, 3_000]
		]);
	});

	it('is empty when nothing is counted', () => {
		const empty = buildCashFlowSankey([row('Épargne', -50_000, { transferPaired: true })]);
		expect(empty).toEqual({
			income: [],
			expenses: [],
			totalCents: 0,
			leftOverCents: 0,
			beyondIncomeCents: 0
		});
	});
});
