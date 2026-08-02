import type { Prisma } from '$lib/server/database/types';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { UNCLASSIFIED_CATEGORY } from '$lib/domain/categories';
import { parseCustomDateRange } from '$lib/server/date-range';
import { resolveTransactionType } from '$lib/server/transactions/totals';
import {
	buildCategoryNatureMap,
	getEffectiveTransactionNature
} from '$lib/server/transactions/nature';
import {
	buildTransactionWhere,
	normalizeId,
	normalizeIdList,
	normalizeSearch,
	parseTransactionFilter,
	resolveUncategorizedCategoryId
} from '$lib/server/transactions/where';
import {
	collectTransactionsMatchingQuery,
	isValidRegexQuery,
	parseQueryMode
} from '$lib/server/transactions/search';
import { forEachTransactionBatch } from '$lib/server/transactions/batch';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const CSV_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';
const FORMULA_INJECTION_PATTERN = /^[=+\-@\t\r]/;
const NEEDS_QUOTING_PATTERN = /[;"\n\r]/;

export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals.user);

	const query = normalizeSearch(url.searchParams.get('q'));
	const qMode = parseQueryMode(url.searchParams.get('qMode'));
	const type = parseTransactionFilter(url.searchParams.get('type'));
	const category = normalizeSearch(url.searchParams.get('category'));
	const fromParam = url.searchParams.get('from');
	const toParam = url.searchParams.get('to');
	const dateRange = fromParam || toParam ? parseCustomDateRange(fromParam, toParam) : null;
	const importBatchId = normalizeId(url.searchParams.get('importBatch'));
	// The export MUST honour `ids` for the same reason it already honours `q` and the classify tab:
	// this is "download what I'm looking at", with no page to compare the result against. Exporting
	// from the id-filtered view without it silently ships the user's ENTIRE history in a file they
	// are likely to mail on — the pre-`ids` behaviour, when this link used `?q=`, was filtered.
	const ids = normalizeIdList(url.searchParams.get('ids'));
	// Same reason as `ids` above, and the reason applies to every filter this route accepts: an
	// export the user cannot inspect before it lands must match the view it was launched from.
	const tagId = normalizeId(url.searchParams.get('tag'));

	if (query && qMode === 'regex' && !isValidRegexQuery(query)) {
		error(400, 'Expression régulière invalide.');
	}

	// Resolved only when needed: type === 'classify' is the only branch of buildTransactionWhere
	// that consumes it (see where.ts) — matches the "à classer" filter exactly as shown on
	// /transactions instead of the previous export behavior, which silently ignored that tab's
	// filter and exported everything.
	const uncategorizedCategoryId =
		type === 'classify' ? await resolveUncategorizedCategoryId(user.id) : undefined;

	const where = buildTransactionWhere({
		userId: user.id,
		type,
		category,
		from: dateRange?.from,
		to: dateRange?.to,
		importBatchId,
		uncategorizedCategoryId,
		ids,
		tagId
	});

	const exportSelect = {
		date: true,
		label: true,
		amountCents: true,
		type: true,
		source: true,
		manualCategory: true,
		natureManual: true,
		category: { select: { name: true } }
	} as const;

	const [mappings, transactions] = await Promise.all([
		prisma.categoryNatureMapping.findMany({
			where: { userId: user.id },
			select: { categoryName: true, nature: true }
		}),
		query
			? collectTransactionsMatchingQuery(where, exportSelect, query, qMode)
			: collectAllTransactions(where, exportSelect)
	]);

	const mappingMap = buildCategoryNatureMap(mappings);

	const rows = transactions.map((transaction) => {
		const effectiveCategory =
			transaction.manualCategory ?? transaction.category.name ?? UNCLASSIFIED_CATEGORY;
		const transactionType = resolveTransactionType(transaction);
		const nature = getEffectiveTransactionNature(
			{
				amountCents: transaction.amountCents,
				type: transactionType,
				category: effectiveCategory,
				natureManual: transaction.natureManual
			},
			mappingMap
		);
		const signedAmountCents =
			transactionType === 'expense'
				? -Math.abs(transaction.amountCents)
				: Math.abs(transaction.amountCents);

		return [
			transaction.date.toISOString().slice(0, 10),
			transaction.label,
			effectiveCategory,
			formatAmount(signedAmountCents),
			transactionType,
			nature.nature,
			transaction.source
		]
			.map(escapeCsvField)
			.join(';');
	});

	const csv = [CSV_HEADER, ...rows].join('\r\n');
	const dateStamp = new Date().toISOString().slice(0, 10);

	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="budgetpilot-transactions-${dateStamp}.csv"`
		}
	});
};

// Batched full dump (see forEachTransactionBatch): same date-desc order as the previous single
// findMany, but never materializes the whole matching set from one Prisma query — bounded
// per-batch memory even on a large per-user history (see CLAUDE.md technical debt).
async function collectAllTransactions<Select extends Prisma.TransactionSelect>(
	where: Prisma.TransactionWhereInput,
	select: Select
): Promise<Array<Prisma.TransactionGetPayload<{ select: Select }>>> {
	const rows: Array<Prisma.TransactionGetPayload<{ select: Select }>> = [];
	await forEachTransactionBatch(where, select, (batch) => {
		rows.push(...batch);
	});
	return rows;
}

function formatAmount(amountCents: number): string {
	return (amountCents / 100).toFixed(2);
}

function escapeCsvField(value: string): string {
	const withGuard = FORMULA_INJECTION_PATTERN.test(value) ? `'${value}` : value;
	if (NEEDS_QUOTING_PATTERN.test(withGuard)) {
		return `"${withGuard.replace(/"/g, '""')}"`;
	}
	return withGuard;
}
