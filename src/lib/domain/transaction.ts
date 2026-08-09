export type TransactionSource =
	'manual' | 'csv' | 'banque_populaire' | 'mock_connector' | 'enablebanking';

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

export interface TransactionValidationResult {
	ok: boolean;
	errors: string[];
}

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
 */
export function applyKindSign(amountCents: number, kind: TransactionKind): number {
	return kind === 'expense' ? -Math.abs(amountCents) : Math.abs(amountCents);
}

export function isValidIsoDate(value: string): boolean {
	if (!ISO_DATE_PATTERN.test(value)) return false;

	const date = new Date(`${value}T00:00:00.000Z`);
	return date.toISOString().slice(0, 10) === value;
}

export function validateTransaction(transaction: Transaction): TransactionValidationResult {
	const errors: string[] = [];

	if (!transaction.id.trim()) errors.push('id requis');
	if (!isValidIsoDate(transaction.date)) errors.push('date ISO invalide');
	if (!Number.isInteger(transaction.amountCents)) errors.push('montant en centimes requis');
	if (transaction.amountCents === 0) errors.push('montant nul interdit');
	if (Math.abs(transaction.amountCents) > 100_000_000) errors.push('montant trop élevé');
	if (transaction.type && transaction.type !== 'income' && transaction.type !== 'expense')
		errors.push('type invalide');
	if (!transaction.label.trim()) errors.push('libellé requis');
	if (transaction.label.length > MAX_LABEL_LENGTH) errors.push('libellé trop long');
	if (!transaction.category.trim()) errors.push('catégorie requise');
	if (transaction.category.length > MAX_CATEGORY_LENGTH) errors.push('catégorie trop longue');
	if (transaction.nature && !isTransactionNature(transaction.nature))
		errors.push('nature invalide');

	return { ok: errors.length === 0, errors };
}

export function isTransactionNature(value: string): value is TransactionNature {
	return (TRANSACTION_NATURES as readonly string[]).includes(value);
}
