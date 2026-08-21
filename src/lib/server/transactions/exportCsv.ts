import { applyKindSign, type TransactionNature } from '$lib/domain/transaction';
import { mapTransactionAllocations, getEffectiveCategory } from './nature';
import type { TransactionRowForMapping } from './nature';
import { resolveTransactionType } from './totals';
import { computeNameKey } from '$lib/server/naming/nameKey';
import { money, toDecimalString } from '$lib/domain/money';

/**
 * The CSV a user downloads from /transactions, built from ALLOCATIONS rather than from parent rows.
 *
 * **This header is a contract, not an output** (see CLAUDE.md). A file produced by one version must
 * stay importable by every later one, which is why `import/profiles/maison.ts` is left untouched and
 * `maison-v2.ts` recognises this shape as a SECOND profile rather than replacing the first. Any
 * column added here in future inherits the same rule: version the profile, never edit the shape a
 * user's installed file already has.
 *
 * Why it lives in `server/transactions/` rather than inside the route: `round-trip.spec.ts` hands
 * this function's output straight to the real parser. A round-trip test whose "expected CSV" is
 * retyped by the test only proves the test agrees with itself — the oracle mistake CLAUDE.md
 * records — so both halves of the trip have to be importable.
 *
 * The three columns past `source_bancaire`, and why each is needed rather than nice:
 *
 *  - `montant_total` — the PARENT's amount, repeated on every line of a group. It is the grouping
 *    key's third component and the sum the parser checks the parts against.
 *  - `part` — `i/n`. `n` is how the parser knows a group is complete rather than truncated, and `i`
 *    restores `TransactionSplit.position`, which decides WHICH part carries the rounding cent and is
 *    therefore user-visible, not an implementation detail.
 *  - `categorie_parent` — the parent's own category. Nothing else in the file carries it: a
 *    correctly-split transaction has a zero remainder, so `allocationsOf` emits only the parts and
 *    the parent's category appears in no line. It is §2.2's restoration value — what the transaction
 *    returns to when the répartition is removed — so a round trip without it silently replaces a
 *    user-authored value with whichever part happened to be first.
 *
 * **A `categoryFilter` narrows WHICH LINES are written, never what `part` means.** PR5: exporting
 * under `?category=Loisirs` must read 32,99 € like the screen it came from, which means emitting
 * only the allocations that matched — not the whole répartition of every transaction the filter's
 * identity match pulled in. `i` and `n` still describe the TRUE, full group (`i` restores
 * `position`, `n` is the real allocation count), so a partially-matched split's file reads e.g.
 * `2/3` and the maison v2 parser refuses it by name ("répartition incomplète") instead of
 * re-importing a smaller, wrong répartition. A filtered export is a view of the screen, not a
 * backup — see docs/using/split-transactions.md.
 */
export const TRANSACTION_CSV_HEADER =
	'date;libelle;categorie;montant;type;nature;source_bancaire;montant_total;part;categorie_parent';

const FORMULA_INJECTION_PATTERN = /^[=+\-@\t\r]/;
const NEEDS_QUOTING_PATTERN = /[;"\n\r]/;

export function buildTransactionsCsv(
	transactions: readonly TransactionRowForMapping[],
	mappingMap: Map<string, TransactionNature>,
	/** The active `?category=` filter, if any — see the doc comment above. `undefined`/empty means
	 *  no filter, and every allocation is emitted exactly as before this parameter existed. */
	categoryFilter?: string
): string {
	const categoryKey = categoryFilter ? computeNameKey(categoryFilter) : null;
	const rows = transactions.flatMap((transaction) => {
		const allocations = mapTransactionAllocations(transaction, mappingMap);
		const transactionType = resolveTransactionType(transaction);
		// Stored amounts carry no reliable sign (`type` wins over it, and imports store magnitudes),
		// so the file's sign is derived from the resolved type exactly as it was before allocations
		// existed. Applied to the parts too, which is what keeps Σ parts = total in the file itself.
		//
		// Through `applyKindSign` rather than a local expression: this rule used to be written out
		// here and nowhere else, so the transactions list — which needs the identical answer — was
		// free to disagree with the file this export produces, and did.
		const signed = (amountCents: number) => applyKindSign(amountCents, transactionType);
		const parentCategory = getEffectiveCategory(transaction);
		const totalCents = signed(transaction.amountCents);

		// `index` and `allocations.length` are taken from the FULL, unfiltered group even when only
		// a subset is emitted below: the `part` column's `i/n` always describes the true group, so a
		// filter that drops a line makes the group read as incomplete rather than as a smaller,
		// complete one.
		const numbered = allocations.map((allocation, index) => ({ allocation, index }));
		const emitted = categoryKey
			? numbered.filter(({ allocation }) => computeNameKey(allocation.category) === categoryKey)
			: numbered;

		return emitted.map(({ allocation, index }) =>
			[
				allocation.date,
				transaction.label,
				allocation.category,
				formatAmount(signed(allocation.amountCents)),
				transactionType,
				allocation.nature,
				transaction.source,
				formatAmount(totalCents),
				`${index + 1}/${allocations.length}`,
				parentCategory
			]
				.map(escapeCsvField)
				.join(';')
		);
	});

	return [TRANSACTION_CSV_HEADER, ...rows].join('\r\n');
}

function formatAmount(amountCents: number): string {
	return toDecimalString(money(amountCents));
}

function escapeCsvField(value: string): string {
	const withGuard = FORMULA_INJECTION_PATTERN.test(value) ? `'${value}` : value;
	if (NEEDS_QUOTING_PATTERN.test(withGuard)) {
		return `"${withGuard.replace(/"/g, '""')}"`;
	}
	return withGuard;
}
