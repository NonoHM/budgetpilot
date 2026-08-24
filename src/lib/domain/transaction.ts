export type TransactionSource =
	'manual' | 'csv' | 'revolut' | 'banque_populaire' | 'mock_connector' | 'enablebanking';

export type TransactionKind = 'income' | 'expense';
export type TransactionNature =
	'income' | 'spending' | 'transfer' | 'investment' | 'refund' | 'fee' | 'uncategorized';

export const TRANSACTION_NATURES = [
	'income',
	'spending',
	'transfer',
	'investment',
	'refund',
	'fee',
	'uncategorized'
] as const;

export interface Transaction {
	id: string;
	date: string;
	label: string;
	amountCents: number;
	type?: TransactionKind;
	category: string;
	source: TransactionSource;
	nature?: TransactionNature;
	natureSource?: 'manual' | 'category' | 'default';
}

export interface TransactionClassificationSuggestion {
	transactionId: string;
	suggestedCategory: string | null;
	suggestedNature: TransactionNature | null;
	confidence: number;
	reason: string;
}

/**
 * A violation as a code, never as a sentence: `validateTransaction` used to return eleven
 * French sentences that five CSV parsers forwarded verbatim, so the parsers were relaying
 * language rather than writing it. Language for these codes lives only in the message
 * catalogue (`import_refusal_tx_<code>`) and, temporarily, in the dashboard's legacy shim
 * (`src/lib/server/budget/dashboard.ts`), which reproduces today's HTTP 400 wording exactly
 * until #299 decides whether the route maps the code or the page renders it.
 */
export type TransactionValidationCode =
	| 'id-required'
	| 'invalid-iso-date'
	| 'amount-cents-required'
	| 'zero-amount'
	| 'amount-too-large'
	| 'invalid-type'
	| 'label-required'
	| 'label-too-long'
	| 'category-required'
	| 'category-too-long'
	| 'invalid-nature';

export const TRANSACTION_VALIDATION_CODES = [
	'id-required',
	'invalid-iso-date',
	'amount-cents-required',
	'zero-amount',
	'amount-too-large',
	'invalid-type',
	'label-required',
	'label-too-long',
	'category-required',
	'category-too-long',
	'invalid-nature'
] as const satisfies readonly TransactionValidationCode[];

export type TransactionValidationResult =
	{ ok: true } | { ok: false; violations: TransactionValidationCode[] };

const MAX_LABEL_LENGTH = 120;
const MAX_CATEGORY_LENGTH = 60;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function getTransactionKind(
	transaction: Pick<Transaction, 'amountCents' | 'type'>
): TransactionKind {
	if (transaction.type === 'income' || transaction.type === 'expense') return transaction.type;
	return transaction.amountCents >= 0 ? 'income' : 'expense';
}

/**
 * A stored magnitude, given the sign its DIRECTION implies. The single definition of "what sign
 * does this money figure carry on screen".
 *
 * THE STORED SIGN IS NOT THE DIRECTION, and that is the whole reason this exists.
 * `server/import/persist.ts` writes `Math.abs(amountCents)` and puts the direction in `type`, so a
 * CSV-imported expense sits in the database as a POSITIVE number. Every aggregate in the app
 * already knows this — the totals, the per-nature buckets and the CSV export all take
 * `Math.abs(...)` and resolve the direction through `getTransactionKind` — but the transactions
 * list rendered `formatCents(tx.amountCents)` raw and took only its COLOUR from `type`.
 *
 * Measured before the fix, in one list: two CSV-imported July rows read « 90,00 € » and
 * « 60,00 € » beside seeded August rows reading « -16,00 € » and « -80,00 € ». All four are
 * expenses. So an imported expense showed as a positive amount, distinguished from an income only
 * by being rose rather than emerald — a false figure, and colour as the sole encoding of a
 * difference, which the design plate forbids.
 *
 * DERIVED AT READ, NOT NORMALISED AT WRITE, and the reasoning belongs here because the opposite
 * choice looks tidier. Normalising the column would need a data migration on three separate
 * provider histories, rewriting every row a user has ever imported, and it would still leave the
 * derivation in place for the rows written before it ran. More decisively, it would not remove the
 * second source of truth it is meant to remove: `type` is nullable, `getTransactionKind` already
 * falls back to the sign only when it is absent, and every money read in the app already treats
 * `type` as the authority. Deriving here makes the LIST agree with the aggregates it sits next to;
 * writing a sign into the column would make the column agree with itself and change nothing else.
 *
 * ZERO IS RETURNED UNSIGNED, and the branch is load-bearing rather than defensive. `-Math.abs(0)`
 * is NEGATIVE ZERO, and `Intl.NumberFormat` renders it « -0,00 € » — so without this line the
 * fixture's own `REGULARISATION NULLE` row, an expense of 0 cents, reads as a negative amount of
 * nothing. No numeric assertion can see it: `-0 === 0` is true, so `toBe(0)` and `toEqual(0)` both
 * pass on the defect. A test on this branch has to use `Object.is` or assert the FORMATTED string.
 * The CSV export is unaffected either way — `(-0).toFixed(2)` is `"0.00"` — which is exactly why
 * the divergence could exist between the two surfaces this function was written to reconcile.
 */
export function applyKindSign(amountCents: number, kind: TransactionKind): number {
	const magnitude = Math.abs(amountCents);
	if (magnitude === 0) return 0;
	return kind === 'expense' ? -magnitude : magnitude;
}

/**
 * A predicate, so it RETURNS rather than throws, and the `Number.isNaN` line is what makes that
 * true rather than a description of intent.
 *
 * `ISO_DATE_PATTERN` admits any two digits for month and day, so `2026-13-45` reaches
 * `new Date(...)`, which answers an Invalid Date, whose `toISOString()` raises `RangeError:
 * Invalid time value` instead of returning a sentinel. Measured over every `2026-MM-DD` with MM
 * and DD from 00 to 99, all 10000 of which pass the pattern: without this line **9628 throw** and
 * 372 return a boolean. The 372 are the real calendar days plus the handful JavaScript rolls over
 * rather than rejecting, which is why `2026-02-30` answers `false` cleanly and hides the whole
 * thing from the obvious test case.
 *
 * The line is not defensive. `date-predicate.spec.ts` exercises all 10000 and goes red without it.
 *
 * AND IT DEMOTES THE PATTERN, which is worth stating because the pattern still reads like the
 * guarantee. Widening it to `/^.*$/` in a break-check left every test in that spec GREEN, so the
 * two versions were compared over a 10019-string corpus: the answers differ on **zero**. Anything
 * the pattern would have refused now either produces an Invalid Date, caught one line below, or a
 * valid one whose ISO prefix cannot equal the input. The pattern is kept as an early return that
 * avoids allocating a `Date` per CSV row, not as the thing making this function total, and no test
 * here proves it load-bearing because none can.
 */
export function isValidIsoDate(value: string): boolean {
	if (!ISO_DATE_PATTERN.test(value)) return false;

	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return false;
	return date.toISOString().slice(0, 10) === value;
}

export function validateTransaction(transaction: Transaction): TransactionValidationResult {
	const violations: TransactionValidationCode[] = [];

	if (!transaction.id.trim()) violations.push('id-required');
	if (!isValidIsoDate(transaction.date)) violations.push('invalid-iso-date');
	if (!Number.isInteger(transaction.amountCents)) violations.push('amount-cents-required');
	if (transaction.amountCents === 0) violations.push('zero-amount');
	if (Math.abs(transaction.amountCents) > 100_000_000) violations.push('amount-too-large');
	if (transaction.type && transaction.type !== 'income' && transaction.type !== 'expense')
		violations.push('invalid-type');
	if (!transaction.label.trim()) violations.push('label-required');
	if (transaction.label.length > MAX_LABEL_LENGTH) violations.push('label-too-long');
	if (!transaction.category.trim()) violations.push('category-required');
	if (transaction.category.length > MAX_CATEGORY_LENGTH) violations.push('category-too-long');
	if (transaction.nature && !isTransactionNature(transaction.nature))
		violations.push('invalid-nature');

	if (violations.length === 0) return { ok: true };
	return { ok: false, violations };
}

export function isTransactionNature(value: string): value is TransactionNature {
	return (TRANSACTION_NATURES as readonly string[]).includes(value);
}
