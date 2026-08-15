import type { CsvImportResult, CsvProfileParseInput, ParsedCsvRow } from '../types';
import type { CsvRefusal } from '../refusals';
import { addRefusal, buildSummary, getDuplicateHeaders } from '../utils/csv';
import { refusalCellValue } from '../utils/safety';
import { detectSignIndicatorColumn } from '../signIndicator';
import { applyColumnMapping } from '../mapping/apply';
import {
	MAPPING_ROLES,
	validateColumnMapping,
	type UntrustedColumnMapping,
	type MappingRole
} from '../mapping/model';
import { parseResolvedRows } from './resolvedRows';

/** The currency columns and the accepted value, shared with `generic` for the same reason. */
const CURRENCY_COLUMNS = ['currency', 'devise'];
const ACCEPTED_CURRENCY = 'EUR';

export interface MappedParseInput extends CsvProfileParseInput {
	columnMapping: UntrustedColumnMapping | undefined;
}

/**
 * Parse a file through a mapping the user designated and this instance remembered.
 *
 * ## Deliberately NOT in `csvProfileParsers`
 *
 * Every other profile is chosen by looking at the header row. This one is chosen because a row
 * exists in the database for this user and this header shape, which is a fact the parser has no
 * access to and must not acquire: `parseCsvTransactions` reaching Prisma is what made it
 * unbundlable and put the profile parsers out of a fuzzer's reach entirely.
 *
 * Keeping it out of the registry also makes "a mapping is never auto-detected" STRUCTURAL rather
 * than a consequence of list order. Registered after `generic`, whose match returns true for
 * everything, it would be unreachable by `auto` today and reachable the day somebody reorders the
 * list, with no test able to tell the difference.
 *
 * ## Every guard here is defence in depth, and that is not a reason to drop one
 *
 * The route resolves the mapping, checks the verdict and only calls this on `recognised`. So in
 * the ordinary world the two refusals below are unreachable. They exist because a mapping is a
 * stored record that outlives the code that wrote it: a backup restored from a version before the
 * validator, a future caller that skips the verdict, a row edited in the database. Refusing loudly
 * is the difference between a bug and a silent wrong import, and a wrong mapping does not import
 * one bad row, it decides which column is money for every row of every future file of this shape.
 */
export function parseMappedRows({
	rows,
	warnings,
	categorizationRules,
	columnMapping
}: MappedParseInput): CsvImportResult {
	const headerRefusals: CsvRefusal[] = [];
	const headers = rows[0].cells.map((header) => header.trim().toLowerCase());

	// A duplicated header is STILL a refusal, for the reason `generic` records: `toRecord` assigns
	// `record[header] = row[index]`, so a later duplicate OVERWRITES an earlier one and the last
	// column silently wins. It matters MORE here, because a mapping resolves by name.
	for (const header of getDuplicateHeaders(headers))
		addRefusal(
			headerRefusals,
			{ kind: 'header' },
			{ code: 'duplicate-column', column: refusalCellValue(header) }
		);

	const verdict = resolveMappedColumns(columnMapping, rows[0].cells, headerRefusals);

	// AFTER the columns resolved, because the detector needs to know which one is the amount, and
	// BEFORE any row is read, because it is a fact about the whole file. A user who designates the
	// magnitude column of a file whose direction lives in a sibling column would otherwise import
	// every row as income, which is the defect #320 measured on the unmapped path. Designating a
	// column is not evidence that the file can be read.
	if (verdict) {
		const indicatorColumn = detectSignIndicatorColumn(headers, rows, verdict.columns.amount);
		if (indicatorColumn)
			addRefusal(
				headerRefusals,
				{ kind: 'header' },
				{ code: 'amount-sign-in-separate-column', column: refusalCellValue(indicatorColumn) }
			);
	}

	if (headerRefusals.length > 0 || !verdict) return refusedResult(rows, warnings, headerRefusals);

	return parseResolvedRows({
		rows,
		headers,
		columns: verdict.columns,
		currencyColumn: CURRENCY_COLUMNS.find((name) => headers.includes(name)),
		acceptedCurrency: ACCEPTED_CURRENCY,
		profile: 'mapped',
		warnings,
		categorizationRules
	});
}

/**
 * The mapping's four columns as FOLDED names, or null with the refusal already recorded.
 *
 * Folded here rather than in `applyColumnMapping`, which returns the file's own spelling on
 * purpose: the recap screen shows the user the header as their bank writes it, and the row record
 * is keyed by the folded one. Two consumers, two forms, one fold.
 */
function resolveMappedColumns(
	mapping: UntrustedColumnMapping | undefined,
	rawHeaders: string[],
	refusals: CsvRefusal[]
): { columns: { date: string; label: string; amount: string; category: string | null } } | null {
	if (!mapping) {
		addRefusal(refusals, { kind: 'header' }, { code: 'mapping-invalid', reason: 'mapping-absent' });
		return null;
	}

	const validity = validateColumnMapping(mapping);
	if (!validity.ok) {
		addRefusal(
			refusals,
			{ kind: 'header' },
			{ code: 'mapping-invalid', reason: validity.reason.code }
		);
		return null;
	}

	const applied = applyColumnMapping(mapping, rawHeaders);
	if (applied.kind !== 'recognised') {
		// The lost roles, named in row order, because a user told "your mapping no longer fits" has
		// nowhere to go and a user told "the label column is gone" knows exactly what to redesignate.
		// On `lost`, every role the mapping carries is gone, so the message names all of them
		// rather than saying "the mapping". Computed from the MAPPING rather than hardcoded: a
		// mapping with no category must not claim a category column disappeared.
		const mappedRoles = MAPPING_ROLES.filter((role) => mappedRoleIsSet(mapping, role));
		const lost = applied.kind === 'partial' ? applied.lostRoles : mappedRoles;
		addRefusal(
			refusals,
			{ kind: 'header' },
			{ code: 'mapping-columns-missing', roles: lost.join(', ') }
		);
		return null;
	}

	const { date, label, amount, category } = applied.columns;
	// `recognised` guarantees the three required roles resolved, which is what makes these
	// assertions safe rather than optimistic: `applyColumnMapping` returns `partial` or `lost`
	// whenever any mapped role is missing.
	return {
		columns: {
			date: (date as string).trim().toLowerCase(),
			label: (label as string).trim().toLowerCase(),
			amount: (amount as string).trim().toLowerCase(),
			category: category === null ? null : category.trim().toLowerCase()
		}
	};
}

/** Whether the mapping actually carries this role, in whichever space it uses. */
function mappedRoleIsSet(mapping: UntrustedColumnMapping, role: MappingRole): boolean {
	const names: Record<MappingRole, string | null> = {
		date: mapping.dateColumn,
		label: mapping.labelColumn,
		amount: mapping.amountColumn,
		category: mapping.categoryColumn
	};
	const indices: Record<MappingRole, number | null> = {
		date: mapping.dateIndex,
		label: mapping.labelIndex,
		amount: mapping.amountIndex,
		category: mapping.categoryIndex
	};
	return mapping.matchBy === 'name' ? names[role] !== null : indices[role] !== null;
}

function refusedResult(
	rows: ParsedCsvRow[],
	warnings: string[],
	refusals: CsvRefusal[]
): CsvImportResult {
	return {
		transactions: [],
		warnings,
		invalidRows: refusals,
		summary: buildSummary({
			profile: 'mapped',
			totalRows: rows.length - 1,
			validRows: 0,
			invalidRows: refusals.length,
			duplicateRows: 0,
			totalDebitCents: 0,
			totalCreditCents: 0,
			dates: []
		})
	};
}
