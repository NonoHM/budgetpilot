import {
	countedInIncomeAndExpense,
	sumIncomeAndExpense,
	type CategoryAllocation
} from './allocation';
import { UNCLASSIFIED_CATEGORY } from './categories';

/** One node of a side. `category` is null for « Other », which lists the categories it holds. */
export interface SankeyNode {
	category: string | null;
	cents: number;
	members: string[];
}

/** A period's cash flow for the /reports Sankey (#190): what came in, by category, and what went
 *  out, by category, around one total. The difference is a node of its own, on the right when
 *  money was left over and on the left when spending went beyond income; a flow is never negative. */
export interface CashFlowSankey {
	income: SankeyNode[];
	expenses: SankeyNode[];
	/** The larger of income and expenses: both sides add up to it. */
	totalCents: number;
	leftOverCents: number;
	beyondIncomeCents: number;
}

/** Largest first, then by category with a plain comparison: no ambient locale decides an order. */
function bySize(left: [string, number], right: [string, number]): number {
	if (right[1] !== left[1]) return right[1] - left[1];
	return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

function side(allocations: CategoryAllocation[], maxNodes: number): SankeyNode[] {
	const totals = new Map<string, number>();
	for (const allocation of allocations) {
		// A blank pinned name (a restore can write one) reads as uncategorized, never as a node with
		// no label.
		const key = allocation.category.trim() === '' ? UNCLASSIFIED_CATEGORY : allocation.category;
		totals.set(key, (totals.get(key) ?? 0) + Math.abs(allocation.amountCents));
	}
	const ranked = [...totals.entries()].filter(([, cents]) => cents > 0).sort(bySize);
	if (ranked.length <= maxNodes) {
		return ranked.map(([category, cents]) => ({ category, cents, members: [] }));
	}
	const kept = ranked.slice(0, maxNodes - 1);
	const folded = ranked.slice(maxNodes - 1);
	return [
		...kept.map(([category, cents]) => ({ category, cents, members: [] })),
		{
			category: null,
			cents: folded.reduce((total, [, cents]) => total + cents, 0),
			members: folded.map(([category]) => category)
		}
	];
}

export function buildCashFlowSankey(
	allocations: ReadonlyArray<CategoryAllocation>,
	maxPerSide = 5
): CashFlowSankey {
	const counted = countedInIncomeAndExpense(allocations);
	// The two totals come from the period report's own definition, so the figures cannot disagree.
	const { incomeCents, expenseCents } = sumIncomeAndExpense(allocations);
	return {
		income: side(
			counted.filter((allocation) => allocation.kind === 'income'),
			maxPerSide
		),
		expenses: side(
			counted.filter((allocation) => allocation.kind === 'expense'),
			maxPerSide
		),
		totalCents: Math.max(incomeCents, expenseCents),
		leftOverCents: Math.max(0, incomeCents - expenseCents),
		beyondIncomeCents: Math.max(0, expenseCents - incomeCents)
	};
}
