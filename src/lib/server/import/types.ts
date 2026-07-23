import type { Transaction, TransactionNature } from '$lib/domain/transaction';
import type { CategorizationRuleInput } from '$lib/server/categorization/rules';

export interface CsvImportOptions {
	sourceName?: string;
	maxBytes?: number;
	maxRows?: number;
	profile?: CsvImportProfile;
	categorizationRules?: CategorizationRuleInput[];
}

export type CsvImportProfile = 'generic' | 'banque-populaire' | 'revolut' | 'maison' | 'auto';

export type ResolvedCsvImportProfile = Exclude<CsvImportProfile, 'auto'>;

export type ImportedTransactionType = 'income' | 'expense';

export interface ImportedTransactionMetadata {
	reference: string;
	notes: string;
	type: ImportedTransactionType;
	/** Original bank operation type (e.g. "Card payment", "Incoming transfer") — traceability only, never a category. */
	bankOperationType?: string;
	banquePopulaireCategory?: string;
	subcategory?: string;
	revolutType?: string;
	revolutProduct?: string;
	revolutCurrency?: string;
	revolutState?: string;
	revolutFeeCents?: number;
	revolutBalanceCents?: number;
	/** Explicit manual nature coming from the "maison" format — absent for other profiles. */
	natureManual?: TransactionNature;
	deduplicationKey: string;
	csvFields?: Record<string, string>;
}

export interface ImportedTransaction extends Transaction {
	metadata: ImportedTransactionMetadata;
}

export interface CsvImportSummary {
	profile: ResolvedCsvImportProfile;
	totalRows: number;
	validRows: number;
	invalidRows: number;
	duplicateRows: number;
	totalDebitCents: number;
	totalCreditCents: number;
	period: {
		from: string | null;
		to: string | null;
	};
}

export interface CsvInvalidRow {
	line: number;
	reason: string;
	field?: string;
}

export interface CsvImportResult {
	transactions: ImportedTransaction[];
	errors: string[];
	warnings: string[];
	invalidRows: CsvInvalidRow[];
	summary: CsvImportSummary;
}

export interface ParsedCsvRow {
	cells: string[];
	line: number;
}

export interface CsvProfileParser {
	profile: ResolvedCsvImportProfile;
	matches(headers: string[]): boolean;
	parse(input: CsvProfileParseInput): CsvImportResult;
}

export interface CsvProfileParseInput {
	rows: ParsedCsvRow[];
	errors: string[];
	warnings: string[];
	sourceName?: string;
	categorizationRules: CategorizationRuleInput[];
}
