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
		// Selected for ONE reason and it is not a column of the file: the account name written into
		// every line may only be written when every line came from the SAME account, and that is a
		// property of the rows rather than of the request. See `accountNameFor` below.
		accountId: true,
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
		scope.filters.category || undefined,
		{ accountName: await accountNameFor(user.id, transactions) }
	);
	const dateStamp = new Date().toISOString().slice(0, 10);

	return new Response(csv, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="budgetpilot-transactions-${dateStamp}.csv"`
		}
	});
};

/**
 * The name of the account these rows came from, or null when they came from more than one.
 *
 * ## The scope has to be established before it can be named, and that is the whole function
 *
 * `buildTransactionsCsv`'s own contract says a file whose rows come from several accounts names
 * NONE, and `readMaisonV3Account` refuses a `compte` column that is not constant for the same
 * reason: on re-import a wrong name does not fail, it FILES THE ROWS somewhere they never were.
 * So the answer is derived from the rows actually collected rather than from the filters, because
 * a filter that happens to select one account and a filter that names one are the same request.
 *
 * Zero accounts (an empty export) is null too: there is nothing to name.
 *
 * ## `userId` is in the same where clause, and it is not redundant
 *
 * The rows are already scoped, so this second lookup could take the id on trust. It does not: an id
 * read off a row and handed back to the database is exactly the shape that leaks a name across
 * users the moment the row scoping is loosened anywhere upstream, and the cost of the clause is a
 * word. `AGENTS.md`: any object reference is a claim, including one the application produced.
 */
async function accountNameFor(
	userId: string,
	rows: readonly { accountId: string }[]
): Promise<string | null> {
	const distinct = new Set(rows.map((row) => row.accountId));
	if (distinct.size !== 1) return null;
	const [accountId] = [...distinct];
	/**
	 * FOUND BY A FAKE THAT REFUSES TO GUESS, not by review, and it is a Prisma trap rather than a
	 * defensive nicety: `where: { id: undefined, userId }` is not an impossible query, it is the
	 * query WITHOUT the id clause, so it returns whichever account of this user comes first and
	 * writes that name onto rows it has nothing to do with. `accountId` is a required column, so the
	 * value cannot be absent in production; the cost of saying so is one line and the cost of being
	 * wrong is a file that misfiles its own rows on re-import.
	 */
	if (typeof accountId !== 'string' || accountId.length === 0) return null;
	const account = await prisma.account.findFirst({
		where: { id: accountId, userId },
		select: { name: true }
	});
	return account?.name ?? null;
}
