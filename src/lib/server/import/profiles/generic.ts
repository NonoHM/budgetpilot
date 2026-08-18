import type { CsvImportResult, CsvProfileParseInput } from '../types';
import type { CsvRefusal } from '../refusals';
import {
	addRefusal,
	buildSummary,
	duplicatedHeaderSpellings,
	getDuplicateHeaders
} from '../utils/csv';
import { REQUIRED_ROLES, resolveRequiredColumns } from './columnAliases';
import { parseResolvedRows } from './resolvedRows';
import { detectSignIndicatorColumn } from '../signIndicator';
import { refusalCellValue } from '../utils/safety';
import { foldComparableHeader } from '../utils/encoding';

/** The one column that is optional and still matched by its exact name: it has no role in
 *  building a transaction, so an absent or unrecognised category simply falls back to the
 *  sentinel rather than refusing anything. Aliasing it belongs with the mapping path. */
const CATEGORY_COLUMN = 'category';

/**
 * The names a file may use to declare what currency its amounts are in.
 *
 * ## Why this exists, and why it REFUSES rather than converts
 *
 * This application holds euros. Every amount is stored as a bare `amountCents` with no currency
 * beside it, and `formatCents` puts a euro symbol on all 121 of its call sites. So a file whose
 * amounts are pounds has nowhere honest to go: importing it writes the right number under the
 * wrong unit, and the user reads « -12,30 € » for a charge that was £12.30.
 *
 * `revolut.ts` has refused a non EUR row since long before this, and it is the MODEL here rather
 * than the outlier. This gives `generic` the same honesty, with the same refusal code, so the two
 * paths say the same thing for the same reason.
 *
 * ## The asymmetry is deliberate: a declared currency is checked, an absent one is assumed
 *
 * A file that DECLARES a currency is making a claim, and ignoring a claim the file makes is the
 * defect. A file that declares nothing makes no claim, so there is nothing to contradict. Refusing
 * on the absence of a signal would refuse almost every real statement, including this
 * application's own export format, which carries no currency column at all.
 *
 * **What that costs, stated rather than left to be discovered: a user whose bank emits no currency
 * column and is not in euros is still silently wrong, and this cannot fix them.** There is nothing
 * to detect. Closing that needs somewhere to store a currency, or asking the user, and both belong
 * to the aggregation issue rather than here.
 *
 * ## Only this profile can see it
 *
 * `maison`, `maison-v2` and `banque-populaire` match on exact ordered equality against a fixed
 * header list, so a file carrying an extra currency column has the wrong column count and never
 * reaches them: it falls through to here. A currency guard in those three would be unreachable,
 * which is a guard in costume rather than a guard. Their EUR assumption is documented instead.
 */
const CURRENCY_COLUMNS = ['currency', 'devise'];
const ACCEPTED_CURRENCY = 'EUR';

export function matchesGenericHeader(): boolean {
	return true;
}

export function parseGenericRows({
	rows,
	warnings,
	categorizationRules
}: CsvProfileParseInput): CsvImportResult {
	// Accents folded as well as case. ONE array feeds the duplicate check, the alias resolution
	// and `toRecord`, so folding here is what keeps the three agreeing: a file whose label column
	// reads `Libellé` resolves through the `libelle` alias, and a file carrying BOTH spellings is
	// caught by the duplicate check below rather than silently letting the later column win.
	const headers = rows[0].cells.map((header) => foldComparableHeader(header));
	const headerRefusals: CsvRefusal[] = [];

	// A duplicated header is STILL a refusal, and the reason is sharper than "it is ambiguous":
	// `toRecord` assigns `record[header] = row[index]`, so a later duplicate OVERWRITES an
	// earlier one and the last column silently wins. That is unreachable today only because
	// this refusal exists. Removing it does not make the file ambiguous, it makes it wrong.
	const duplicateHeaders = getDuplicateHeaders(headers);
	for (const header of duplicateHeaders)
		addRefusal(
			headerRefusals,
			{ kind: 'header' },
			{
				code: 'duplicate-column',
				column: duplicatedHeaderSpellings(rows[0].cells, headers, header)
					.map(refusalCellValue)
					.join(', ')
			}
		);

	// An UNRECOGNISED column is no longer a refusal. It is dropped, and the file is parsed from
	// the columns we did recognise. Nothing about the ignored column is lost that this profile
	// could have used: it is a deferral to the column mapping path (#301), where the user gets
	// to say what those columns mean, not a decision that their contents do not matter.
	const resolution = resolveRequiredColumns(headers);
	if (!resolution.ok) {
		addRefusal(
			headerRefusals,
			{ kind: 'header' },
			{
				code: 'ambiguous-column-mapping',
				role: resolution.role,
				columns: resolution.headers.map(refusalCellValue).join(', ')
			}
		);
	}

	const columns = resolution.ok
		? resolution.columns
		: { date: undefined, label: undefined, amount: undefined };
	if (resolution.ok) {
		for (const role of REQUIRED_ROLES) {
			if (!columns[role])
				addRefusal(headerRefusals, { kind: 'header' }, { code: 'missing-required-column', role });
		}
	}

	// AFTER the required roles have resolved, because the detector needs to know which column is
	// the amount, and BEFORE any row is read, because this is a fact about the whole file rather
	// than about one line. A file whose amount column never resolved has a louder problem already
	// reported above.
	if (columns.amount) {
		const indicatorColumn = detectSignIndicatorColumn(headers, rows, columns.amount);
		if (indicatorColumn)
			addRefusal(
				headerRefusals,
				{ kind: 'header' },
				{ code: 'amount-sign-in-separate-column', column: refusalCellValue(indicatorColumn) }
			);
	}

	if (headerRefusals.length > 0) {
		return {
			transactions: [],
			warnings,
			invalidRows: headerRefusals,
			summary: buildSummary({
				profile: 'generic',
				totalRows: rows.length - 1,
				validRows: 0,
				// Zero, and the complaints go beside it. Every refusal collected above is scoped to the
				// header, and the header is not one of the rows `totalRows` counts. Three missing roles
				// is three things wrong with ONE line, so no count of rows can carry it honestly.
				invalidRows: 0,
				fileLevelRefusals: headerRefusals.length,
				duplicateRows: 0,
				totalDebitCents: 0,
				totalCreditCents: 0,
				dates: []
			})
		};
	}

	// Which header, if any, declares the currency. Absent is the common case and is fine.
	const currencyColumn = CURRENCY_COLUMNS.find((name) => headers.includes(name));

	return parseResolvedRows({
		rows,
		headers,
		// `resolution.ok` is guaranteed here: the header refusals above returned early otherwise,
		// and every required role was checked for presence. The assertions are what carries that
		// through to a type the shared loop can use without another null check per row.
		columns: {
			date: columns.date as string,
			label: columns.label as string,
			amount: columns.amount as string,
			category: CATEGORY_COLUMN
		},
		currencyColumn,
		acceptedCurrency: ACCEPTED_CURRENCY,
		profile: 'generic',
		warnings,
		categorizationRules
	});
}
