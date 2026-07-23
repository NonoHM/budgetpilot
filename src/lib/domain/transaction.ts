export type TransactionSource =
	| 'manual'
	| 'csv'
	| 'banque_populaire'
	| 'mock_connector'
	| 'enablebanking';

export type TransactionKind = 'income' | 'expense';
export type TransactionNature =
	| 'income'
	| 'spending'
	| 'transfer'
	| 'investment'
	| 'refund'
	| 'fee'
	| 'uncategorized';

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
