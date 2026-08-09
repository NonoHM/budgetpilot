import { requireUser } from '$lib/server/auth';
import { prisma } from '$lib/server/db';
import { buildCategoryNatureMap, EFFECTIVE_CATEGORY_SELECT } from '$lib/server/transactions/nature';
import { buildTransactionsCsv } from '$lib/server/transactions/exportCsv';
import { resolveTransactionScope } from '$lib/server/transactions/scope';
import { collectAllTransactions } from '$lib/server/transactions/batch';
import { error } from '@sveltejs/kit';
import * as m from '$lib/paraglide/messages';
import type { RequestHandler } from './$types';

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

	// Spreads EFFECTIVE_CATEGORY_SELECT rather than naming `manualCategory`/`category` itself: the
	// export is a per-category read like the other three, and this is the fragment that stops a
	// fourth site deciding for itself which columns "where did the money go" needs.
	const exportSelect = {
		id: true,
		date: true,
		label: true,
		amountCents: true,
		type: true,
		source: true,
		natureManual: true,
		...EFFECTIVE_CATEGORY_SELECT
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

	// A filtered export must read like the screen it came from (PR5): passing the active
	// `?category=` through is what makes `buildTransactionsCsv` emit only the matching allocations,
	// never a répartition's other parts the filter never showed.
	const csv = buildTransactionsCsv(
		transactions,
		buildCategoryNatureMap(mappings),
		scope.filters.category || undefined
	);
	const dateStamp = new Date().toISOString().slice(0, 10);

	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="budgetpilot-transactions-${dateStamp}.csv"`
		}
	});
};
