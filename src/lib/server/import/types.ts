import type { Transaction, TransactionNature } from '$lib/domain/transaction';
import type { CategorizationRuleInput } from '$lib/server/categorization/rules';
import type { CsvRefusal } from './refusals';
import type { UntrustedColumnMapping } from './mapping/model';

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
	columnMapping?: UntrustedColumnMapping;
	/**
	 * Whether row 0 is a HEADER row. Defaults to true, which is every file this parser saw
	 * before the designation screen existed.
	 *
	 * `false` says the file has no title row and row 0 is a transaction. It is not a claim the
	 * parser can make for itself — a header row of plausible-looking values is indistinguishable
	 * from a data row — so it comes from the user, through « la première ligne contient des
	 * données ». Ignoring it consumed one transaction per import, silently, on a file that is
	 * perfectly well formed. See `headerlessFile.spec.ts`.
	 */
	hasHeaderRow?: boolean;
}

/**
 * `mapped` is a resolved profile with no entry in `csvProfileParsers`, deliberately: it is chosen
 * because a row exists in the database rather than by looking at the header row. See
 * `profiles/mapped.ts`.
 */
export type CsvImportProfile =
	'generic' | 'banque-populaire' | 'revolut' | 'maison' | 'mapped' | 'auto';

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
	/**
	 * The DATA rows this parse read, which is every row a refusal can be about.
	 *
	 * A file the parser refused before reading a row still reports the rows it has: a statement over
	 * the row cap used to report zero, which reads as a claim about the file rather than about the
	 * refusal, and nothing on the screen contradicted it.
	 */
	totalRows: number;
	validRows: number;
	/**
	 * ROWS refused, one per row, never more.
	 *
	 * Every row loop refuses a row and returns, so a row cannot appear here twice. What used to
	 * inflate this was the other kind of refusal: a complaint about the header or about the file,
	 * counted once per missing role against a total that counts data rows. Those live in
	 * `fileLevelRefusals` now, and `totalRows === validRows + invalidRows` holds at every writer.
	 */
	invalidRows: number;
	/**
	 * Complaints about the FILE or its header, which are not rows and do not partition anything.
	 *
	 * Three missing required roles is three things wrong with one line, and that line is not a data
	 * row. Kept as its own figure rather than folded into `invalidRows` at one and rather than
	 * dropped: the summary states it in words above the counters, so the number is what the screen
	 * decides whether to draw, not what it has to invent.
	 */
	fileLevelRefusals: number;
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
