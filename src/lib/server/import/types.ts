import type { Transaction, TransactionNature } from '$lib/domain/transaction';
import type { CategorizationRuleInput } from '$lib/server/categorization/rules';
import type { CsvRefusal } from './refusals';
import type { UntrustedColumnMapping } from './mapping/model';
import type { DateOrder } from './dateOrder';
import type { AccountColumnAnswer } from './discriminant';

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
	/**
	 * Which component an ambiguous `06/01/2026` writes first.
	 *
	 * Absent means nobody has decided, and the parser reads day-first, which is what it has
	 * always done. Exactly the shape of `hasHeaderRow` above and for the same reason: a cell
	 * reading `06/01/2026` is two valid dates and carries nothing that separates them, so the
	 * answer is a property of the FILE that the parser cannot take from any single value. See
	 * `dateOrder.ts` and #433.
	 *
	 * ## AN OVERRIDE, NOT CONFIGURATION, AND #613 IS WHAT MADE THAT TRUE
	 *
	 * This used to be the only thing that decided the order, which is a derivable value being
	 * configured, and its own docstring recorded that as a violation rather than a design. The
	 * order is now DERIVED at the single door by `detectDateOrder`, off the whole column the
	 * profile declares, because a component above 12 cannot be a month and so names its own
	 * position.
	 *
	 * What this option does now is settle the ONE case the file cannot: a column whose every cell
	 * reads both ways. It does not outrank a column that proves its own order, and it does not
	 * rescue one that proves both, because neither of those is a question anybody can answer. The
	 * precedence is written once, in `decideDateOrder`, which is also where the reason it deviates
	 * from the ladder #613 wrote down is recorded.
	 *
	 * Two production callers set it now: `/import/columns`, from an answer the designation
	 * screen (#639) collected, and `/import`'s own action, from the auto-path reading offer this
	 * option's absence can trigger — see `dateOrderPromptedClientSide` below for how the two
	 * `mapped` callers among them are told apart.
	 */
	dateOrder?: DateOrder;
	/**
	 * Whether a CLIENT-SIDE screen already had the chance to ask this column's reading before this
	 * parse ran, so the door must not ask again.
	 *
	 * ## The gap this closes, found by #433's contradiction pass
	 *
	 * The door used to infer "already asked" from `profile === 'mapped'`, on the reasoning that a
	 * mapped parse always comes from `/import/columns`, backed by the designation screen. That
	 * reasoning missed a THIRD caller: `/import`'s own action also parses with `profile: 'mapped'`
	 * whenever it silently reapplies a `ColumnMapping` remembered from a PREVIOUS designation
	 * (`useMapping`, keyed by header fingerprint) — and that reuse shows no screen at all.
	 * `ColumnMapping` carries no `dateOrder` field, so nothing was ever asked or remembered for
	 * this file, and the day-first default would otherwise apply silently forever on precisely the
	 * path most repeat imports take.
	 *
	 * So `mapped` alone no longer means "already asked". Only `/import/columns` sets this flag,
	 * because it alone is wired to the screen that can ask (#639) and is trusted to have deferred
	 * its own close until the question was answered or waived (plate 7b). Every other caller —
	 * every registered profile AND the silent `mapped` reuse — leaves it unset, and an ambiguous
	 * column with no override there reaches the same `ambiguous-date-order` refusal `csv.ts` gives
	 * a registered profile.
	 */
	dateOrderPromptedClientSide?: boolean;
	/**
	 * The user's answer to a previous `ambiguous-account-column` refusal, when there has been one.
	 *
	 * Absent means nobody has decided. Unlike `dateOrderPromptedClientSide`, there is no caller
	 * this needs to be suppressed for: both doors — `/import`'s auto path and `/import/columns`'s
	 * designation path — call this same parser with no prior mechanism that already asked whether
	 * a file covers more than one account, so #485's fix applies to both with one flag and no
	 * exclusion. `'is-account'` promotes the column to PROVEN (the same refusal a verified IBAN
	 * pair gets); `'not-account'` drops it and lets the parse proceed as if the column were noise.
	 * See `discriminant.ts`'s `kind` (contradictory vs ambiguous) and #485.
	 */
	accountColumnAnswer?: AccountColumnAnswer;
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
	/**
	 * The currency THIS ROW's file declared for it, as an ISO 4217 code, or absent when it declared
	 * none (no currency column, or a blank cell). #600.
	 *
	 * Carried out of the parse because the parse is the only place it is known, and the row is
	 * denominated later by the account it lands in (`persistImportedTransactions`). Before this the
	 * value was read, checked against EUR and forgotten, so a file declaring EUR filed into a USD
	 * account stored USD. `declaredCurrencyRefusal` is the one comparison with the destination.
	 *
	 * Absent rather than null, and that is the file-evidence rule rather than tidiness: a file that
	 * declares nothing exhibits nothing, so the destination's currency applies by design and there is
	 * nothing to compare. Not in `metadata`, for the reason `splitParts` gives: metadata is
	 * traceability, and this decides what the money is denominated in.
	 */
	declaredCurrency?: string;
}

export interface CsvImportSummary {
	profile: ResolvedCsvImportProfile;
	/**
	 * The order this parse APPLIED to ambiguous date cells, carried out of the door that decided it.
	 *
	 * Optional because a parse that refused the file before reading a row never took the decision,
	 * and a summary that named one there would be reporting a reading nothing was read under. Every
	 * parse that produced a transaction carries it.
	 *
	 * It exists so `ImportBatch.dateOrder` can be written. That column has been on all three engines
	 * since 2026-08-22 with nothing writing it, because the decision was taken at the door and never
	 * left it, so no caller had the value. This is the value.
	 */
	dateOrder?: DateOrder;
	/**
	 * The column and reading to disclose on the import summary, plate 7l — present only where the
	 * reading was CHOSEN rather than proven or defaulted.
	 *
	 * "Chosen" is exactly the one branch `decideDateOrder` reaches through an override: the column
	 * left the question genuinely open (`ambiguous`) and an answer settled it. A proven column is
	 * arithmetic and disclosing it every month is noise (7l); a defaulted column was never chosen
	 * by anyone, and stating a "reading" nobody answered is the silent default #433 names, wearing
	 * a summary line instead of a refusal.
	 *
	 * Absent, never `null`, for the same reason `dateOrder` is optional: most parses have nothing
	 * to disclose, and an object some parses omit is a smaller lie than a field always present and
	 * usually null.
	 */
	dateOrderDisclosure?: { header: string; order: DateOrder };
	/**
	 * The currencies this FILE declares, read off every row whether or not the row became a
	 * transaction (`currencyDeclaration.ts`), as ISO codes. Empty or absent when it declares none,
	 * which takes the destination account's currency by design (#600's ruling).
	 *
	 * THE AUTHORITY the routes compare with the destination (`declaredCurrencyRefusal`). The
	 * per-row `ImportedTransaction.declaredCurrency` feeds only the persist backstop, and is the
	 * weaker of the two for the reason F2 measured: a declaring row refused for its date leaves no
	 * transaction to carry its claim.
	 *
	 * Optional because only the profiles that can read a currency set it (`generic`, `mapped`,
	 * `revolut`); the others cannot be handed a file carrying one (`declaredCurrency.spec.ts`).
	 */
	declaredCurrencies?: string[];
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
	/**
	 * Which columns of THIS file hold dates, as INDICES into the header row.
	 *
	 * ## Required, and that is the whole mechanism
	 *
	 * The order a file writes its dates in is decided at the single door by reading the whole
	 * column, and the door does not know which column that is: a profile resolves it, through an
	 * alias table, a stored mapping or a fixed header. Declaring it here is what lets the decision
	 * run ONCE, over the right cells, without the door acquiring seven special cases. A registry
	 * entry that omits this member does not compile, so a new profile cannot ship without one.
	 *
	 * What that does NOT catch is a declaration that lies: `() => []` typechecks and silently
	 * switches the derivation off for that profile. `dateOrderSeam.spec.ts` narrows that gap and
	 * does not close it. Omission is unrepresentable; a lie is likely to be noticed.
	 *
	 * ## INDICES rather than names, which is the load-bearing choice
	 *
	 * Four different header folds exist in this directory: `normalizeHeaderCells` for
	 * `banque-populaire` and `revolut`, `foldComparableHeader` for `generic`, `foldExactHeader`
	 * for `maison` and `mapped`, and `revolut` additionally rewrites `Completed Date` to
	 * `Date de fin` before anything downstream reads it. A declaration in NAMES would force the
	 * door to know which fold applies to which profile, which is the copied-predicate shape one
	 * layer up. An index is fold-free: the door reads `cells[index]` and never has an opinion
	 * about spelling.
	 *
	 * ## A LIST rather than a name
	 *
	 * `banque-populaire` reads three date columns and `revolut` two, through
	 * `normalizeFirstValidDate`, which picks the first valid one PER ROW. So a parse can take its
	 * date from one column on one row and another on the next, and any column that could become
	 * the date is a column whose order matters. An index that this file does not carry is simply
	 * absent from the list; the file then meets its ordinary refusal.
	 */
	dateColumns(headers: string[]): number[];
	parse(input: CsvProfileParseInput): CsvImportResult;
}

export interface CsvProfileParseInput {
	rows: ParsedCsvRow[];
	warnings: string[];
	sourceName?: string;
	categorizationRules: CategorizationRuleInput[];
	/** The file's date order, when it has been decided. Absent reads day-first. Every profile
	 *  receives it because every profile funnels into `normalizeDate`, and one that quietly
	 *  dropped it would be the only path where the user's answer does not apply. */
	dateOrder?: DateOrder;
}
