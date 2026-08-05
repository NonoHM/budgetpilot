import type { Prisma } from '$lib/server/database/types';
import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { resolveTransactionType } from '$lib/server/transactions/totals';
import {
	buildCategoryNatureMap,
	getEffectiveCategory,
	getEffectiveTransactionNature
} from '$lib/server/transactions/nature';
import { resolveTransactionScope } from '$lib/server/transactions/scope';
import { forEachTransactionBatch } from '$lib/server/transactions/batch';
import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import type { RequestHandler } from './$types';

const CSV_HEADER = 'date;libelle;categorie;montant;type;nature;source_bancaire';
const FORMULA_INJECTION_PATTERN = /^[=+\-@\t\r]/;
const NEEDS_QUOTING_PATTERN = /[;"\n\r]/;

export const GET: RequestHandler = async ({ locals, url }) => {
	const user = requireUser(locals.user);

	// Same reason `load` and `bulkTag` route through the shared resolver: this is "download what
	// I'm looking at", with no page to compare the result against, and `q` is matched in JS after
	// the SQL predicate — see scope.ts's own docstring for why the union shape is not flattened.
	const scope = await resolveTransactionScope(user.id, url);
	// The export can only render ONE message, so range wins when both are invalid — same
	// precedence `bulkTag` uses, and the one the pre-refactor code produced (the date range threw
	// during parsing, before the regex check ever ran).
	if (scope.kind === 'invalid') {
		error(
			400,
			scope.reasons.range ? m.date_range_error_invalid_custom() : 'Expression régulière invalide.'
		);
	}

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
		scope.kind === 'scan'
			? scope.collect(exportSelect)
			: collectAllTransactions(scope.where, exportSelect)
	]);

	const mappingMap = buildCategoryNatureMap(mappings);

	const rows = transactions.map((transaction) => {
		const effectiveCategory = getEffectiveCategory(transaction);
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
