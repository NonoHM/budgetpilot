import type { Transaction, TransactionNature } from '$lib/domain/transaction';
import type { CategorizationRuleInput } from '$lib/server/categorization/rules';
import type { CsvRefusal } from './refusals';
import type { ColumnMappingInput } from './mapping/model';

export interface CsvImportOptions {
	sourceName?: string;
	maxBytes?: number;
	maxRows?: number;
	/** Overrides the configured column bound. For tests: the real one is read from the
	 *  environment through `resolveCsvMaxColumns`. */
	maxColumns?: number;
	profile?: CsvImportProfile;
	categorizationRules?: CategorizationRuleInput[];
	/**
	 * The mapping to parse through, when `profile` is `mapped`.
	 *
	 * Passed IN rather than resolved inside the parser. `parseCsvTransactions` reaching Prisma is
	 * what made it unbundlable and put every profile parser out of a fuzzer's reach, so the
	 * database stays at the route and the parser stays pure.
	 */
	columnMapping?: ColumnMappingInput;
}

/**
 * `mapped` is a resolved profile with no entry in `csvProfileParsers`, deliberately: it is chosen
 * because a row exists in the database rather than by looking at the header row. See
 * `profiles/mapped.ts`.
 */
export type CsvImportProfile =
	| 'generic'
	| 'banque-populaire'
	| 'revolut'
	| 'maison'
	| 'mapped'
	| 'auto';

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

/**
 * One part of a répartition carried through an import, as (category NAME, signed amount).
 *
 * A name rather than a `categoryId` because a category id is meaningless in a file: an import is
 * routinely a move to another instance, where the ids do not exist. `persistImportedTransactions`
 * resolves each name through `resolveCategoryByName`, the same get-or-create the parent's own
 * category goes through.
 */
export interface ImportedSplitPart {
	category: string;
	amountCents: number;
}

export interface ImportedTransaction extends Transaction {
	metadata: ImportedTransactionMetadata;
	/**
	 * Present only when the source file describes a répartition (the « maison » v2 profile today).
	 *
	 * Deliberately NOT inside `metadata`: metadata is traceability the app never computes with,
	 * whereas parts decide where the money went. It is written through `replaceSplits`, never with
	 * a `createMany` against the table — an import builds rows before any service is in view, which
	 * is exactly why it is one of the three write paths that habitually bypass an invariant.
	 */
	splitParts?: ImportedSplitPart[];
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

export interface CsvImportResult {
	transactions: ImportedTransaction[];
	warnings: string[];
	invalidRows: CsvRefusal[];
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
	warnings: string[];
	sourceName?: string;
	categorizationRules: CategorizationRuleInput[];
}
